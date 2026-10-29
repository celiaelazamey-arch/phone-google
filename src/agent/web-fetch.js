import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

/**
 * M-C/C2a — the HTTP side of a run's web access.
 *
 * This module never opens a socket of its own: every hop goes through the C1 egress
 * proxy with a per-fetch grant, so the allowlist, the byte ceilings and the audit
 * trail stay in exactly one place. What lives here is the part the proxy must not
 * know about: URL policy, redirect handling, bounded decoding and readable-text
 * extraction.
 *
 * Deliberate refusals, each with its own code so nothing degrades silently:
 * - non-http(s), embedded credentials, oversized URLs        → refused before any grant
 * - a host outside the run allowlist                          → `web_url_not_allowed`
 * - more than `maxRedirects` hops                              → `web_redirect_limit`
 * - non-text media types                                       → `web_fetch_unsupported_content_type`
 * - a body above `maxResponseBytes`                            → `web_response_too_large`
 */

export const WEB_FETCH_VERSION = 'agent-web-fetch-v1';

const MAX_URL_CHARS = 2_048;
const TEXTUAL_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json'
]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const DEFAULT_LIMITS = Object.freeze({
  maxResponseBytes: 2_097_152,
  maxRedirects: 3,
  timeoutMs: 20_000,
  maxChars: 20_000
});

function coded(code, status) {
  const error = new Error(code);
  error.code = code;
  if (status) error.status = status;
  return error;
}

export function validateWebUrl(raw) {
  if (typeof raw !== 'string') throw coded('web_url_invalid');
  const text = raw.trim();
  if (!text || text.length > MAX_URL_CHARS) throw coded('web_url_invalid');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw coded('web_url_invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw coded('web_url_scheme_unsupported');
  // `http://user:pass@host` would smuggle a credential into a URL that ends up in
  // evidence; there is no legitimate need for it here.
  if (url.username || url.password) throw coded('web_url_credentials_forbidden');
  url.hash = '';
  return url;
}

function defaultPort(url) {
  return url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
}

function hostOf(url) {
  return String(url.hostname || '').replace(/^\[|\]$/g, '');
}

const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»'
});

export function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,9});/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/**
 * Deterministic HTML → readable text. No DOM, no external parser, no clock: the
 * same bytes always produce the same text and therefore the same digest.
 */
export function extractReadableText(html, { maxChars = DEFAULT_LIMITS.maxChars } = {}) {
  const source = String(html ?? '');
  const titleMatch = /<title[^>]*>([\s\S]{0,500}?)<\/title>/i.exec(source);
  const title = titleMatch ? decodeEntities(titleMatch[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : '';

  let body = source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|object|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    // An unclosed script/style must not leak its contents either.
    .replace(/<(script|style|noscript|template|svg|iframe|object|canvas)\b[^>]*>[\s\S]*$/gi, ' ');

  body = body.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre)>/gi, '\n');
  body = body.replace(/<[^>]*>/g, ' ');
  body = decodeEntities(body);
  body = body
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const truncated = body.length > maxChars;
  return {
    title: title.slice(0, 300),
    text: truncated ? body.slice(0, maxChars) : body,
    chars: Math.min(body.length, maxChars),
    truncated
  };
}

function requestHeaders({ token, url }) {
  return {
    host: defaultPort(url) === 80 ? hostOf(url) : `${hostOf(url)}:${defaultPort(url)}`,
    accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1',
    'accept-encoding': 'identity',
    'user-agent': 'celia-agent/1.0 (+governed egress)',
    'proxy-authorization': `Bearer ${token}`
  };
}

/** Open a CONNECT tunnel through the proxy; TLS is layered on top by the caller. */
function openTunnel({ proxyHost, proxyPort, host, port, token, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { host: `${host}:${port}`, 'proxy-authorization': `Bearer ${token}` }
    });
    const fail = (error) => {
      req.destroy();
      reject(error);
    };
    if (signal) signal.addEventListener('abort', () => fail(coded('web_fetch_aborted')), { once: true });
    req.setTimeout(timeoutMs, () => fail(coded('web_fetch_timeout')));
    req.on('error', () => fail(coded('web_tunnel_failed')));
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(coded('web_url_not_allowed', res.statusCode));
        return;
      }
      resolve(socket);
    });
    req.end();
  });
}

function decodeBody(buffer, encoding) {
  const value = String(encoding || '').toLowerCase();
  try {
    if (value === 'gzip' || value === 'x-gzip') return zlib.gunzipSync(buffer);
    if (value === 'deflate') return zlib.inflateSync(buffer);
    if (value === 'br') return zlib.brotliDecompressSync(buffer);
  } catch {
    throw coded('web_response_decode_failed');
  }
  return buffer;
}

function collect(res, { maxBytes, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      res.destroy();
      reject(error);
    };
    if (signal) signal.addEventListener('abort', () => fail(coded('web_fetch_aborted')), { once: true });
    res.setTimeout(timeoutMs, () => fail(coded('web_fetch_timeout')));
    res.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        fail(coded('web_response_too_large', 502));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    res.on('error', () => fail(coded('web_response_failed', 502)));
  });
}

/** One hop, always through the proxy: absolute-form for http, CONNECT+TLS for https. */
async function requestOnce({ url, token, proxy, limits, tlsOptions, signal }) {
  const host = hostOf(url);
  const port = defaultPort(url);
  const path = `${url.pathname || '/'}${url.search || ''}`;
  const timeoutMs = limits.timeoutMs;

  let socket = null;
  try {
    if (url.protocol === 'https:') {
      const tunnel = await openTunnel({
        proxyHost: proxy.host,
        proxyPort: proxy.port,
        host,
        port,
        token,
        timeoutMs,
        signal
      });
      socket = await new Promise((resolve, reject) => {
        const secure = tls.connect({ socket: tunnel, servername: host, ...tlsOptions }, () => resolve(secure));
        secure.once('error', () => {
          tunnel.destroy();
          reject(coded('web_tls_failed'));
        });
      });
    }

    const requestOptions = socket
      ? {
          // The socket is already TLS-wrapped: a plain http client on top avoids a
          // second handshake and keeps one response parser for both schemes.
          createConnection: () => socket,
          host,
          port,
          path,
          method: 'GET',
          headers: requestHeaders({ token, url }),
          signal
        }
      : {
          host: proxy.host,
          port: proxy.port,
          path: url.href,
          method: 'GET',
          headers: requestHeaders({ token, url }),
          signal
        };

    const response = await new Promise((resolve, reject) => {
      const req = http.request(requestOptions, (res) => resolve(res));
      req.setTimeout(timeoutMs, () => req.destroy(coded('web_fetch_timeout')));
      req.on('error', (error) => reject(error?.code ? error : coded('web_fetch_failed', 502)));
      req.end();
    });

    const headers = response.headers || {};
    const body = REDIRECT_STATUS.has(response.statusCode) ? Buffer.alloc(0) : await collect(response, { maxBytes: limits.maxResponseBytes, timeoutMs, signal });
    return { status: response.statusCode, headers, body };
  } finally {
    if (socket) socket.destroy();
  }
}

export function createWebFetcher({
  proxyUrl,
  allowlist,
  clock = Date.now,
  limits = {},
  tlsOptions = null
} = {}) {
  if (!allowlist || typeof allowlist.allows !== 'function') throw coded('web_allowlist_required');
  let proxy;
  try {
    proxy = new URL(proxyUrl);
  } catch {
    throw coded('web_proxy_url_invalid');
  }
  if (proxy.protocol !== 'http:') throw coded('web_proxy_url_invalid');
  const config = { ...DEFAULT_LIMITS, ...limits };
  for (const [key, min, max] of [
    ['maxResponseBytes', 1_024, 8_388_608],
    ['maxRedirects', 0, 5],
    ['timeoutMs', 500, 60_000],
    ['maxChars', 1_000, 200_000]
  ]) {
    if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max) {
      throw coded(`web_limit_invalid:${key}`);
    }
  }
  const proxyHost = proxy.hostname;
  const proxyPort = Number(proxy.port || 80);

  return {
    version: WEB_FETCH_VERSION,
    limits: Object.freeze({ ...config }),

    /**
     * Fetch one URL with a single grant. Redirects are followed hop by hop, and every
     * hop is re-checked against the allowlist before it is attempted — a 302 can
     * never become a bypass.
     */
    async fetch({ url, token, signal } = {}) {
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw coded('web_grant_required');
      let target = validateWebUrl(url);
      const hops = [];
      let result = null;

      for (let hop = 0; hop <= config.maxRedirects; hop += 1) {
        const host = hostOf(target);
        if (!allowlist.allows({ host, port: defaultPort(target) })) throw coded('web_url_not_allowed', 403);
        const response = await requestOnce({
          url: target,
          token,
          proxy: { host: proxyHost, port: proxyPort },
          limits: config,
          tlsOptions: tlsOptions || undefined,
          signal
        });
        hops.push({ url: target.href, status: response.status });
        // 407 لا يصدره خادم أصل: معناه أن الوسيط لم يقبل المنحة (مسحوبة/منتهية).
        if (response.status === 407) throw coded('web_grant_required', 407);

        const location = response.headers?.location;
        if (REDIRECT_STATUS.has(response.status) && location) {
          let next;
          try {
            next = validateWebUrl(new URL(String(location), target).href);
          } catch {
            throw coded('web_redirect_invalid');
          }
          if (hop === config.maxRedirects) throw coded('web_redirect_limit');
          target = next;
          continue;
        }

        result = { target, response };
        break;
      }

      if (!result) throw coded('web_redirect_limit');
      const { response } = result;
      const contentTypeRaw = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const contentType = contentTypeRaw || 'application/octet-stream';
      if (!TEXTUAL_TYPES.has(contentType)) throw coded('web_fetch_unsupported_content_type');
      const body = decodeBody(result.response.body, response.headers['content-encoding']);
      const raw = body.toString('utf8');
      const mediaIsHtml = contentType === 'text/html' || contentType === 'application/xhtml+xml';
      const extracted = mediaIsHtml || contentType === 'text/plain' || contentType === 'text/markdown' || contentType === 'text/csv'
        ? extractReadableText(mediaIsHtml ? raw : raw.replace(/<[^>]*>/g, ' '), { maxChars: config.maxChars })
        : { title: '', text: raw.slice(0, config.maxChars), chars: Math.min(raw.length, config.maxChars), truncated: raw.length > config.maxChars };
      const text = extracted.text;
      return {
        version: WEB_FETCH_VERSION,
        url: String(url).trim(),
        finalUrl: result.target.href,
        status: response.status,
        contentType,
        title: extracted.title,
        text,
        chars: text.length,
        bytes: body.length,
        truncated: Boolean(extracted.truncated),
        hops,
        sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
        fetchedAt: new Date(clock()).toISOString()
      };
    }
  };
}

export const WEB_FETCH_LIMITS = DEFAULT_LIMITS;
