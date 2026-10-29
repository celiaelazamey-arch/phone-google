import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { EVIDENCE_KIND } from './evidence.js';

/**
 * M-C/C1 — egress proxy: the only door out of a run.
 *
 * The security model, in order, and each rule is enforced in code rather than
 * described in a document:
 *
 * 1. **No grant, no packet.** The task inside the sandbox never receives network
 *    credentials; it receives one opaque run grant. A request without a live grant
 *    is refused with 407 *before* any target is parsed — a caller cannot even learn
 *    whether a host exists.
 * 2. **Allowlist decided before DNS.** The host is matched against the run's own
 *    allowlist as a string. A refused host never reaches `net.connect`/`http.request`,
 *    so a blocked name cannot be resolved, contacted or timed out against.
 * 3. **Every decision is evidenced.** Allowed and blocked requests both produce one
 *    audit record (method, host, port, path without query, status, bytes, duration).
 *    Headers are never recorded, so `Proxy-Authorization` and cookies cannot leak
 *    into the evidence chain.
 * 4. **Bounded.** Request/response byte ceilings, a per-grant tunnel ceiling and an
 *    overall timeout; blowing a ceiling aborts the upstream stream instead of
 *    buffering it.
 *
 * What this module deliberately does NOT do yet: it does not open
 * `network.allowlist` inside `sandbox-policy.js`. That flip is C1-b and happens only
 * after the sandbox actually routes through this proxy. Until then the sandbox keeps
 * the literal `deny` policy it has today.
 */

export const EGRESS_PROXY_VERSION = 'agent-egress-v1';
export const EGRESS_DECISION = Object.freeze({ allow: 'allow', block: 'block' });

const HOP_BY_HOP = new Set([
  'connection',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const DEFAULT_LIMITS = Object.freeze({
  maxRequestBytes: 1_048_576,
  maxResponseBytes: 8_388_608,
  timeoutMs: 15_000,
  maxTunnelsPerGrant: 8
});
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 3_600_000;
const TOKEN_RE = /^Bearer\s+([a-f0-9]{64})$/i;

function coded(code, status) {
  const error = new Error(code);
  error.code = code;
  if (status) error.status = status;
  return error;
}

function boundedInteger(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw coded(`${name}_outside_bounds`);
  return value;
}

/** Lower-case, trailing-dot-free, ASCII/punycode only; brackets from IPv6 are stripped. */
export function normalizeEgressHost(value) {
  if (typeof value !== 'string') throw coded('egress_host_invalid');
  let host = value.trim().toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host || /\s/.test(host)) throw coded('egress_host_invalid');
  // Non-ASCII is refused rather than transliterated: an IDN that compares equal to a
  // different name visually must never be matched silently against an allowlist.
  if (!/^[a-z0-9._:-]+$/.test(host)) throw coded('egress_host_invalid');
  return host;
}

function parseEntry(raw) {
  if (typeof raw !== 'string') throw coded('egress_allowlist_entry_invalid');
  const text = raw.trim().toLowerCase();
  if (!text) throw coded('egress_allowlist_entry_invalid');
  // A bare `*` (or any glob that would match everything) is not an allowlist.
  if (text === '*' || text === '*:*' || text === '**' || /(^|[^a-z0-9])\.\*(?:$|[.:])/.test(text)) {
    throw coded('egress_allowlist_wildcard_too_broad');
  }
  if (/:\/\//.test(text) || text.includes('/') || text.includes('@') || text.includes('?')) {
    throw coded('egress_allowlist_entry_invalid');
  }
  const wildcard = text.startsWith('*.');
  const body = wildcard ? text.slice(2) : text;
  const [hostPart, portPart] = splitHostPort(body);
  const host = normalizeEgressHost(hostPart);
  if (wildcard && host.includes(':')) throw coded('egress_allowlist_entry_invalid');
  let ports = null;
  if (portPart !== undefined) {
    const port = Number(portPart);
    boundedInteger(port, 'egress_allowlist_port', 1, 65_535);
    ports = [port];
  }
  return { host, wildcard, ports };
}

/** `host:443` for names/IPv4, and IPv6 stays bracket-free only when no port is given. */
function splitHostPort(text) {
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    if (close === -1) throw coded('egress_allowlist_entry_invalid');
    const host = text.slice(1, close);
    const rest = text.slice(close + 1);
    if (!rest) return [host, undefined];
    if (!rest.startsWith(':')) throw coded('egress_allowlist_entry_invalid');
    return [host, rest.slice(1)];
  }
  const parts = text.split(':');
  if (parts.length === 1) return [text, undefined];
  if (parts.length === 2) return [parts[0], parts[1]];
  // Bare IPv6 without brackets: treated as a host, never as host:port.
  return [text, undefined];
}

/**
 * Per-run allowlist. Empty list = deny everything (the default), never "allow all".
 * `example.com` allows any port on that exact host; `example.com:443` narrows it;
 * `*.example.com` allows subdomains only — never the bare apex.
 */
export function createEgressAllowlist({ hosts = [] } = {}) {
  if (!Array.isArray(hosts)) throw coded('egress_allowlist_invalid');
  const exact = new Map();
  const wildcards = [];
  for (const raw of hosts) {
    const entry = parseEntry(raw);
    if (entry.wildcard) {
      wildcards.push({ suffix: entry.host, ports: entry.ports });
      continue;
    }
    const ports = exact.get(entry.host) || new Set();
    if (entry.ports === null) ports.add('*');
    else ports.add(entry.ports[0]);
    exact.set(entry.host, ports);
  }
  const matchPorts = (ports, port) => ports.has('*') || ports.has(port);

  const allows = ({ host, port }) => {
    let normalized;
    try {
      normalized = normalizeEgressHost(host);
    } catch {
      return false;
    }
    const numericPort = Number(port);
    if (!Number.isInteger(numericPort)) return false;
    const ports = exact.get(normalized);
    if (ports && matchPorts(ports, numericPort)) return true;
    for (const entry of wildcards) {
      // `*.example.com` matches `a.example.com` and `a.b.example.com`, not the apex
      // and not `evilexample.com`.
      if (normalized.length <= entry.suffix.length + 1) continue;
      if (!normalized.endsWith(`.${entry.suffix}`)) continue;
      if (entry.ports === null || entry.ports.includes(numericPort)) return true;
    }
    return false;
  };

  return Object.freeze({
    entries: [...exact.keys(), ...wildcards.map((entry) => `*.${entry.suffix}`)],
    size: exact.size + wildcards.length,
    allows
  });
}

function filterHeaders(headers = {}) {
  const output = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    if (typeof value === 'undefined') continue;
    output[key] = value;
  }
  return output;
}

function safeName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 300);
}

function assertRunId(runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(runId)) throw coded('egress_run_id_invalid');
  return runId;
}

/**
 * The proxy itself. `onEvent` receives exactly one record per decision; a sink
 * failure is counted (`auditFailures`) but never changes an enforcement decision —
 * the packet was already allowed or refused before anyone could write it down.
 */
export function createEgressProxy({ clock = Date.now, limits = {}, agent = 'celia-egress/1', onEvent = null } = {}) {
  if (onEvent !== null && typeof onEvent !== 'function') throw coded('egress_sink_invalid');
  const config = {
    ...DEFAULT_LIMITS,
    ...limits
  };
  boundedInteger(config.maxRequestBytes, 'egress_max_request_bytes', 1_024, 67_108_864);
  boundedInteger(config.maxResponseBytes, 'egress_max_response_bytes', 1_024, 268_435_456);
  boundedInteger(config.timeoutMs, 'egress_timeout_ms', 100, 120_000);
  boundedInteger(config.maxTunnelsPerGrant, 'egress_max_tunnels', 1, 64);

  const grants = new Map();
  const events = [];
  const stats = { requests: 0, allowed: 0, blocked: 0, bytesIn: 0, bytesOut: 0, auditFailures: 0 };
  let server = null;
  let closed = false;

  const digest = (token) => crypto.createHash('sha256').update(token).digest('hex');

  async function emit(event) {
    const record = Object.freeze({
      version: EGRESS_PROXY_VERSION,
      at: new Date(clock()).toISOString(),
      ...event,
      method: safeName(event.method || ''),
      host: event.host ? safeName(event.host) : null,
      path: event.path ? safeName(event.path) : null,
      reason: event.reason ? safeName(event.reason) : null
    });
    events.push(record);
    if (record.decision === EGRESS_DECISION.allow) {
      stats.allowed += 1;
      stats.bytesIn += record.bytesIn || 0;
      stats.bytesOut += record.bytesOut || 0;
    } else {
      stats.blocked += 1;
    }
    if (onEvent) {
      try {
        await onEvent(record);
      } catch {
        // Durable audit is the caller's responsibility; the decision is already made.
        stats.auditFailures += 1;
      }
    }
  }

  function resolveGrant(req) {
    const header = String(req.headers['proxy-authorization'] || '').trim();
    const match = TOKEN_RE.exec(header);
    if (!match) return { error: 'egress_grant_required', status: 407 };
    const key = digest(match[1].toLowerCase());
    const grant = grants.get(key);
    if (!grant) return { error: 'egress_grant_invalid', status: 407 };
    if (grant.expiresAt <= clock()) {
      grants.delete(key);
      return { error: 'egress_grant_expired', status: 407 };
    }
    return { grant };
  }

  function reply(res, status, code) {
    const body = JSON.stringify({ error: code, code });
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'proxy-agent': agent,
      connection: 'close'
    });
    res.end(body);
  }

  async function deny(res, status, code, context = {}) {
    stats.requests += 1;
    await emit({ decision: EGRESS_DECISION.block, reason: code, status, ...context });
    reply(res, status, code);
  }

  function targetOf(req) {
    let url;
    try {
      url = new URL(req.url);
    } catch {
      return { error: 'egress_target_invalid' };
    }
    if (url.protocol !== 'http:') return { error: 'egress_target_scheme_unsupported' };
    let host;
    try {
      host = normalizeEgressHost(url.hostname);
    } catch {
      return { error: 'egress_target_invalid' };
    }
    const port = url.port ? Number(url.port) : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return { error: 'egress_target_invalid' };
    // Query strings are not recorded: they routinely carry tokens.
    return { host, port, path: url.pathname, search: url.search };
  }

  async function handleHttp(req, res) {
    const auth = resolveGrant(req);
    if (!auth.grant) {
      await deny(res, auth.status, auth.error, { method: req.method });
      return;
    }
    const grant = auth.grant;
    const method = String(req.method || '').toUpperCase();
    if (!METHODS.has(method)) {
      await deny(res, 405, 'egress_method_not_allowed', { runId: grant.runId, method });
      return;
    }
    const target = targetOf(req);
    if (target.error) {
      await deny(res, 403, target.error, { runId: grant.runId, method });
      return;
    }
    stats.requests += 1;
    if (!grant.allowlist.allows({ host: target.host, port: target.port })) {
      await emit({
        decision: EGRESS_DECISION.block,
        reason: 'egress_host_not_allowed',
        status: 403,
        runId: grant.runId,
        method,
        host: target.host,
        port: target.port,
        path: target.path
      });
      reply(res, 403, 'egress_host_not_allowed');
      return;
    }

    const startedAt = clock();
    const base = {
      runId: grant.runId,
      method,
      host: target.host,
      port: target.port,
      path: target.path
    };
    const headers = filterHeaders(req.headers);
    headers.host = target.port === 80 ? target.host : `${target.host}:${target.port}`;
    headers.via = `${agent}`;

    let settled = false;
    let bytesOut = 0;
    let bytesIn = 0;

    const upstream = http.request({
      host: target.host,
      port: target.port,
      method,
      path: `${target.path}${target.search}`,
      headers,
      timeout: config.timeoutMs
    });

    const finish = async (decision, reason, status, extra = {}) => {
      if (settled) return;
      settled = true;
      await emit({
        decision,
        reason,
        status,
        ...base,
        durationMs: clock() - startedAt,
        bytesOut,
        bytesIn,
        ...extra
      });
    };

    upstream.on('response', (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, filterHeaders(upstreamRes.headers));
      upstreamRes.on('data', (chunk) => {
        if (settled) return;
        bytesIn += chunk.length;
        if (bytesIn > config.maxResponseBytes) {
          upstreamRes.destroy();
          res.destroy();
          void finish(EGRESS_DECISION.block, 'egress_response_too_large', 502, { truncated: true });
          return;
        }
        res.write(chunk);
      });
      upstreamRes.on('end', () => {
        if (settled) return;
        res.end();
        void finish(EGRESS_DECISION.allow, 'egress_forwarded', upstreamRes.statusCode || 200);
      });
      upstreamRes.on('error', () => {
        res.destroy();
        void finish(EGRESS_DECISION.block, 'egress_upstream_failed', 502);
      });
    });

    req.on('data', (chunk) => {
      if (settled) return;
      bytesOut += chunk.length;
      if (bytesOut > config.maxRequestBytes) {
        upstream.destroy();
        void finish(EGRESS_DECISION.block, 'egress_request_too_large', 413, { truncated: true });
        reply(res, 413, 'egress_request_too_large');
        return;
      }
      upstream.write(chunk);
    });
    req.on('end', () => {
      if (!settled) upstream.end();
    });
    req.on('error', () => {
      upstream.destroy();
      void finish(EGRESS_DECISION.block, 'egress_client_failed', 499);
    });

    upstream.setTimeout(config.timeoutMs, () => {
      upstream.destroy();
      if (!settled) {
        void finish(EGRESS_DECISION.block, 'egress_upstream_timeout', 504);
        reply(res, 504, 'egress_upstream_timeout');
      }
    });
    upstream.on('error', () => {
      if (!settled) {
        void finish(EGRESS_DECISION.block, 'egress_upstream_unreachable', 502);
        reply(res, 502, 'egress_upstream_unreachable');
      }
    });
  }

  function handleConnect(req, socket, head) {
    const auth = resolveGrant(req);
    if (!auth.grant) {
      socket.end(`HTTP/1.1 ${auth.status} Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n`);
      void emit({ decision: EGRESS_DECISION.block, reason: auth.error, status: auth.status, method: 'CONNECT' });
      return;
    }
    const grant = auth.grant;
    const [rawHost, rawPort] = splitHostPort(String(req.url || ''));
    let host;
    try {
      host = normalizeEgressHost(rawHost);
    } catch {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      void emit({ decision: EGRESS_DECISION.block, reason: 'egress_target_invalid', status: 403, runId: grant.runId, method: 'CONNECT' });
      return;
    }
    const port = rawPort === undefined ? 443 : Number(rawPort);
    stats.requests += 1;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      void emit({ decision: EGRESS_DECISION.block, reason: 'egress_target_invalid', status: 403, runId: grant.runId, method: 'CONNECT', host });
      return;
    }
    if (!grant.allowlist.allows({ host, port })) {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      void emit({
        decision: EGRESS_DECISION.block,
        reason: 'egress_host_not_allowed',
        status: 403,
        runId: grant.runId,
        method: 'CONNECT',
        host,
        port
      });
      return;
    }
    if (grant.tunnels >= config.maxTunnelsPerGrant) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\n\r\n');
      void emit({ decision: EGRESS_DECISION.block, reason: 'egress_tunnel_limit', status: 429, runId: grant.runId, method: 'CONNECT', host, port });
      return;
    }

    grant.tunnels += 1;
    const startedAt = clock();
    let bytesOut = 0;
    let bytesIn = 0;
    let settled = false;

    const upstream = net.connect({ host, port });
    const settle = (decision, reason, status, extra = {}) => {
      if (settled) return;
      settled = true;
      grant.tunnels = Math.max(0, grant.tunnels - 1);
      void emit({
        decision,
        reason,
        status,
        runId: grant.runId,
        method: 'CONNECT',
        host,
        port,
        durationMs: clock() - startedAt,
        bytesOut,
        bytesIn,
        ...extra
      });
    };

    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.on('data', (chunk) => {
        bytesIn += chunk.length;
        if (bytesIn > config.maxResponseBytes) {
          upstream.destroy();
          socket.destroy();
          settle(EGRESS_DECISION.block, 'egress_response_too_large', 502, { truncated: true });
          return;
        }
        socket.write(chunk);
      });
      socket.on('data', (chunk) => {
        bytesOut += chunk.length;
        if (bytesOut > config.maxRequestBytes) {
          upstream.destroy();
          socket.destroy();
          settle(EGRESS_DECISION.block, 'egress_request_too_large', 413, { truncated: true });
          return;
        }
        upstream.write(chunk);
      });
      socket.on('end', () => upstream.end());
      upstream.on('end', () => socket.end());
      socket.on('close', () => {
        upstream.destroy();
        settle(EGRESS_DECISION.allow, 'egress_tunnel_closed', 200);
      });
      upstream.on('close', () => settle(EGRESS_DECISION.allow, 'egress_tunnel_closed', 200));
    });
    upstream.once('timeout', () => {
      upstream.destroy();
      socket.destroy();
      settle(EGRESS_DECISION.block, 'egress_upstream_timeout', 504);
    });
    upstream.setTimeout(config.timeoutMs);
    upstream.once('error', () => {
      socket.destroy();
      settle(EGRESS_DECISION.block, 'egress_upstream_unreachable', 502);
    });
    socket.once('error', () => {
      upstream.destroy();
      settle(EGRESS_DECISION.block, 'egress_client_failed', 499);
    });
  }

  return {
    version: EGRESS_PROXY_VERSION,
    limits: Object.freeze({ ...config }),

    /** One opaque grant per run; the sandbox never sees an allowlist or a token store. */
    issueGrant({ runId, allowlist, ttlMs = 300_000 } = {}) {
      assertRunId(runId);
      const list = allowlist && typeof allowlist.allows === 'function'
        ? allowlist
        : createEgressAllowlist({ hosts: allowlist || [] });
      boundedInteger(ttlMs, 'egress_grant_ttl', MIN_TTL_MS, MAX_TTL_MS);
      const token = crypto.randomBytes(32).toString('hex');
      const grant = { runId, allowlist: list, expiresAt: clock() + ttlMs, tunnels: 0 };
      grants.set(digest(token), grant);
      return Object.freeze({ token, runId, expiresAt: grant.expiresAt, hosts: list.entries });
    },

    revokeGrant(token) {
      if (typeof token !== 'string') return false;
      return grants.delete(digest(token.toLowerCase()));
    },

    revokeRun(runId) {
      let removed = 0;
      for (const [key, grant] of grants) {
        if (grant.runId === runId) {
          grants.delete(key);
          removed += 1;
        }
      }
      return removed;
    },

    activeGrants() {
      return [...grants.values()].map((grant) => ({ runId: grant.runId, expiresAt: grant.expiresAt, hosts: grant.allowlist.entries }));
    },

    async listen({ host = '127.0.0.1', port = 0 } = {}) {
      if (closed) throw coded('egress_proxy_closed');
      if (server) throw coded('egress_proxy_already_listening');
      server = http.createServer((req, res) => {
        handleHttp(req, res).catch(() => {
          try {
            res.destroy();
          } catch {
            /* socket already gone */
          }
        });
      });
      server.on('connect', (req, socket, head) => {
        try {
          handleConnect(req, socket, head);
        } catch {
          socket.destroy();
        }
      });
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server?.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server?.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      const address = server.address();
      return { url: `http://${host}:${address.port}`, host, port: address.port };
    },

    async close() {
      closed = true;
      grants.clear();
      if (!server) return;
      const active = server;
      server = null;
      await new Promise((resolve) => active.close(() => resolve()));
    },

    events() {
      return [...events];
    },

    stats() {
      return { ...stats, activeGrants: grants.size, version: EGRESS_PROXY_VERSION };
    }
  };
}

/**
 * Durable audit adapter: one evidence row per decision. Blocked requests are `BLOCK`,
 * forwarded ones are `PASS`; neither claims more than the proxy observed.
 */
export function createEvidenceEgressSink({ store } = {}) {
  if (!store || typeof store.appendEvidence !== 'function') throw coded('egress_sink_store_required');
  return async (event) => {
    await store.appendEvidence({
      runId: event.runId,
      kind: EVIDENCE_KIND.egressRequest,
      input: {
        method: event.method,
        host: event.host,
        port: event.port ?? null,
        path: event.path ?? null
      },
      output: {
        decision: event.decision,
        reason: event.reason,
        status: event.status,
        bytesIn: event.bytesIn ?? 0,
        bytesOut: event.bytesOut ?? 0,
        durationMs: event.durationMs ?? null,
        truncated: Boolean(event.truncated)
      },
      verdict: event.decision === EGRESS_DECISION.allow ? 'PASS' : 'BLOCK'
    });
  };
}
