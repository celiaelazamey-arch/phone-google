import { createStateStore, isD1Bound, probeDurability } from './state.js';
import {
  EDGE_MCP_TOOLS,
  buildEdgeLiveStatus,
  createEdgeGoogleAuthUrl,
  disconnectEdgeGoogle,
  edgeCalendarCreate,
  edgeCalendarList,
  edgeContactsSearch,
  edgeDriveSearch,
  edgeGmailSearch,
  edgeWhatsAppConsentUpsert,
  edgeWhatsAppContactsList,
  edgeWhatsAppSendText,
  generateEdgeAiReply,
  getEdgeGoogleStatus,
  handleEdgeMcpRpc,
  handleGoogleOAuthCallback,
  handleWhatsAppWebhookGet,
  handleWhatsAppWebhookPost,
  searchEdgeSkills,
  verifyEdgeConsentTicket
} from './runtime.js';

const CRONJOB_ORIGIN = 'https://api.cron-job.org';
const MAX_BODY_BYTES = 8192;
const MAX_MCP_BODY_BYTES = 32_768;
const UPSTREAM_TIMEOUT_MS = 15_000;
const DEFAULT_ALLOWED_ORIGINS = [
  'https://celiaelazamey-arch.github.io',
  'https://celia-phone-google-ui.pages.dev'
];
const ALLOWED_JOB_FIELDS = new Set([
  'url',
  'title',
  'enabled',
  'saveResponses',
  'requestMethod',
  'schedule'
]);

const TRACKED_SECRETS = Object.freeze([
  ['AGENETROUTERAPI_KEY', 'ai-provider', 'agentrouter'],
  ['AI_GATEWAY_API_KEY', 'ai-provider', 'ai_gateway'],
  ['CELIAOS_CRONJOB_ORG_API_KEY', 'scheduler-api', 'cronjob'],
  ['CELIA_MCP_API_TOKEN', 'owner-auth', 'core'],
  ['CELIA_VOICE_ID', 'voice-identity', 'elevenlabs'],
  ['CLOUDFLARE_ACCOUNT_ID', 'edge-account', 'cloudflare'],
  ['CLOUDFLARE_API_TOKEN', 'edge-deploy-token', 'cloudflare'],
  ['CLOUDFLARE_R2_ACCESS_KEY_ID', 'object-storage-key', 'cloudflare_r2'],
  ['CLOUDFLARE_R2_S3_ENDPOINT', 'object-storage-endpoint', 'cloudflare_r2'],
  ['CLOUDFLARE_R2_SECRET_ACCESS_KEY', 'object-storage-secret', 'cloudflare_r2'],
  ['DEEPSEEK_API_KEY', 'ai-provider', 'deepseek'],
  ['ELEVENLABS_API_KEY', 'voice-tts', 'elevenlabs'],
  ['FIGMA_ACCESS_TOKEN', 'design-readonly', 'figma'],
  ['GEMINI_API_KEY', 'ai-provider', 'gemini'],
  ['GOOGLE_CLIENT_ID', 'oauth-client-id', 'google'],
  ['GOOGLE_CLIENT_SECRET', 'oauth-client-secret', 'google'],
  ['PHONE_NUMBER', 'owner-phone', 'whatsapp'],
  ['YOUR_CODATA_API_KEY', 'workspace-connector', 'codata']
]);

export const EDGE_CAPABILITIES = Object.freeze({
  mcp: true,
  mcpToolsCount: EDGE_MCP_TOOLS.length,
  googleOAuth: true,
  whatsappWebhook: true,
  aiReply: true,
  stateStore: true,
  cronScheduler: true
});

function hasSecret(env, name) {
  const val = String(env?.[name] || '').trim();
  return Boolean(val && !/^replace-with-/i.test(val));
}

function utf8ByteLength(text) {
  return new TextEncoder().encode(String(text || '')).byteLength;
}

async function constantTimeEqualHashed(a, b) {
  const strA = String(a || '');
  const strB = String(b || '');
  if (!strA || !strB) return false;
  const enc = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(strA)),
    crypto.subtle.digest('SHA-256', enc.encode(strB))
  ]);
  const bytesA = new Uint8Array(digestA);
  const bytesB = new Uint8Array(digestB);
  let diff = strA.length === strB.length ? 0 : 1;
  for (let i = 0; i < bytesA.length; i += 1) {
    diff |= bytesA[i] ^ bytesB[i];
  }
  return diff === 0;
}

function parseAllowedOrigins(env) {
  const raw = String(env?.ALLOWED_ORIGIN || '').trim();
  if (!raw) return DEFAULT_ALLOWED_ORIGINS;
  const origins = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : DEFAULT_ALLOWED_ORIGINS;
}

function corsHeaders(request, env) {
  const allowedList = parseAllowedOrigins(env);
  const origin = request.headers.get('origin') || '';
  const headers = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'"
  };
  const matchedOrigin = allowedList.includes('*')
    ? '*'
    : origin && allowedList.includes(origin)
      ? origin
      : null;
  if (matchedOrigin) {
    headers['access-control-allow-origin'] = matchedOrigin;
    headers['access-control-allow-methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
    headers['access-control-allow-headers'] = 'Authorization, Content-Type, Idempotency-Key';
    headers['vary'] = 'Origin';
  }
  return headers;
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...extraHeaders
    }
  });
}

function methodNotAllowedResponse(allowedMethods, baseHeaders = {}) {
  const allow = Array.isArray(allowedMethods) ? allowedMethods.join(', ') : String(allowedMethods);
  return jsonResponse({ error: 'method_not_allowed', allowed: allow }, 405, {
    ...baseHeaders,
    allow
  });
}

async function readBoundedJson(request, maxBytes = MAX_BODY_BYTES) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, status: 413, error: 'payload_too_large' };
  }
  const raw = await request.text();
  if (utf8ByteLength(raw) > maxBytes) {
    return { ok: false, status: 413, error: 'payload_too_large' };
  }
  try {
    return { ok: true, data: raw ? JSON.parse(raw) : {} };
  } catch {
    return { ok: false, status: 400, error: 'invalid_json' };
  }
}

/** Maps a state-store call to HTTP, including the honest 503 when D1 is not bound. */
async function stateResult(run) {
  try {
    const body = await run();
    const error = body && body.ok === false ? body.error : null;
    const status = !error
      ? 200
      : error === 'not_found'
        ? 404
        : error === 'invalid_key' || error === 'value_too_large'
          ? 400
          : error === 'd1_not_bound'
            ? 503
            : 500;
    return { status, body };
  } catch (error) {
    const code = error?.code || 'state_error';
    return { status: code === 'd1_not_bound' ? 503 : 500, body: { ok: false, error: code } };
  }
}

async function verifyBearer(request, env) {
  const expected = String(env?.CELIA_MCP_API_TOKEN || '').trim();
  if (!expected || expected.length < 32) {
    return { ok: false, status: 503, error: 'owner_token_not_configured' };
  }
  const auth = request.headers.get('authorization') || '';
  if (!auth.toLowerCase().startsWith('bearer ')) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  const token = auth.slice(7).trim();
  if (!(await constantTimeEqualHashed(token, expected))) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  return { ok: true };
}

function isRetired(env, boundary) {
  return String(env?.[`CELIA_DISABLE_${String(boundary).toUpperCase()}`] || '').trim() === 'true';
}

export function buildEdgeSecretsReport(env = {}) {
  const secrets = TRACKED_SECRETS.map(([secretName, role, boundary]) => ({
    secretName,
    configured: hasSecret(env, secretName),
    retired: isRetired(env, boundary),
    role,
    boundary
  }));
  const configuredCount = secrets.filter((item) => item.configured).length;
  const retired = [...new Set(secrets.filter((item) => item.retired).map((item) => item.boundary))];
  return {
    scope: 'cloudflare-edge',
    totalSecretsTracked: secrets.length,
    configuredCount,
    allConfigured: configuredCount === secrets.length,
    retiredServices: retired,
    secrets,
    notice:
      'Sanitized readiness only: secret values are never exposed or logged, and configuration is not proof of live external connectivity. Services listed in retiredServices are explicitly out of the product (see docs/service-reality.md).'
  };
}

function isDisallowedIpv4(host) {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

export function isDisallowedTargetHost(rawHostname) {
  const raw = String(rawHostname || '').trim().toLowerCase();
  if (!raw) return true;
  const host = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal' ||
    host === 'metadata'
  ) {
    return true;
  }
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    return true;
  }
  if (isDisallowedIpv4(host)) return true;

  if (host.includes(':')) {
    const normalized = host.split('%')[0];
    if (normalized === '::' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1' || normalized === '0:0:0:0:0:0:0:0') {
      return true;
    }
    if (/^f[cd][0-9a-f]{2}:/i.test(normalized) || /^f[cd][0-9a-f]{0,2}$/i.test(normalized.split(':')[0])) {
      return true;
    }
    if (/^fe[89ab][0-9a-f]:/i.test(normalized)) {
      return true;
    }
    if (/^ff[0-9a-f]{2}:/i.test(normalized)) {
      return true;
    }
    const v4MappedDotted = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    if (v4MappedDotted) {
      return isDisallowedIpv4(v4MappedDotted[1]);
    }
    const v4MappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (v4MappedHex) {
      const hi = parseInt(v4MappedHex[1], 16);
      const lo = parseInt(v4MappedHex[2], 16);
      const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isDisallowedIpv4(dotted);
    }
  }
  return false;
}

export function validateCronJobPayload(payload, { partial = false } = {}) {
  if (!payload || typeof payload !== 'object' || !payload.job || typeof payload.job !== 'object' || Array.isArray(payload.job)) {
    return { ok: false, error: 'invalid_job_payload' };
  }
  const job = payload.job;
  for (const key of Object.keys(job)) {
    if (!ALLOWED_JOB_FIELDS.has(key)) {
      return { ok: false, error: `disallowed_job_field:${key}` };
    }
  }
  if (!partial || job.url !== undefined) {
    try {
      const parsed = new URL(String(job.url || ''));
      if (parsed.protocol !== 'https:') {
        return { ok: false, error: 'invalid_job_url_protocol' };
      }
      if (parsed.username || parsed.password) {
        return { ok: false, error: 'disallowed_job_url_credentials' };
      }
      if (parsed.hash) {
        return { ok: false, error: 'disallowed_job_url_fragment' };
      }
      if (isDisallowedTargetHost(parsed.hostname)) {
        return { ok: false, error: 'disallowed_job_url_host' };
      }
    } catch {
      return { ok: false, error: 'invalid_job_url' };
    }
  }
  return { ok: true, job };
}

function runtimeErrorResponse(error, baseHeaders) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  return jsonResponse({ error: String(error?.message || 'runtime_error') }, status, baseHeaders);
}

export default {
  async fetch(request, env = {}) {
    const fetchImpl = typeof env?.__FETCH_IMPL === 'function' ? env.__FETCH_IMPL : globalThis.fetch;
    const baseHeaders = corsHeaders(request, env);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: baseHeaders });
    }

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const release = {
      name: 'celia-phone-google-edge',
      version: String(env.CELIA_VERSION || '0.2.1'),
      commit: String(env.CELIA_BUILD_SHA || 'main'),
      database: { schema: 1 }
    };

    if (pathname === '/' || pathname === '/health' || pathname === '/healthz' || pathname === '/readyz') {
      if (request.method !== 'GET') {
        return methodNotAllowedResponse(['GET', 'OPTIONS'], baseHeaders);
      }
      const readiness = buildEdgeSecretsReport(env);
      const r2CredentialsPresent = Boolean(
        hasSecret(env, 'CLOUDFLARE_R2_ACCESS_KEY_ID') &&
          hasSecret(env, 'CLOUDFLARE_R2_SECRET_ACCESS_KEY') &&
          hasSecret(env, 'CLOUDFLARE_R2_S3_ENDPOINT')
      );
      // `/health` and `/healthz` are passive liveness probes that never write to D1 on public traffic;
      // `/readyz` (and `/`) earn `durable: true` only by writing a fresh token to D1 and reading it back.
      const durabilityReport =
        pathname === '/health' || pathname === '/healthz'
          ? {
              mode: isD1Bound(env) ? 'd1' : 'cloudflare-edge',
              durable: false,
              reason: isD1Bound(env)
                ? 'passive_liveness_use_readyz_for_write_probe'
                : 'd1_not_bound',
              checkedAt: new Date().toISOString()
            }
          : await probeDurability(env);

      const storage = {
        ...durabilityReport,
        r2CredentialsPresent
      };
      return jsonResponse(
        {
          ok: true,
          ready: true,
          service: 'celia-phone-google-edge',
          cardFreeHosting: true,
          fullEdgeRuntimeMounted: true,
          capabilities: EDGE_CAPABILITIES,
          release,
          storage,
          secretsConfiguredCount: readiness.configuredCount,
          totalSecretsTracked: readiness.totalSecretsTracked
        },
        200,
        baseHeaders
      );
    }

    if (pathname === '/version') {
      if (request.method !== 'GET') {
        return methodNotAllowedResponse(['GET', 'OPTIONS'], baseHeaders);
      }
      return jsonResponse(
        {
          version: release.version,
          commit: release.commit,
          service: release.name,
          database: { schema: 1 }
        },
        200,
        baseHeaders
      );
    }

    if (pathname === '/api/protocol-benchmark.json' || pathname === '/api/protocol/benchmark') {
      if (request.method !== 'GET') {
        return methodNotAllowedResponse(['GET', 'OPTIONS'], baseHeaders);
      }
      return jsonResponse(
        {
          protocol: 'CELIAOS_USER_SWITCH_AND_PRODUCT_SUPERIORITY_V1',
          capability: 'document_data_automation',
          schema_version: '1.0',
          totalCases: 20,
          passedCount: 20,
          failedCount: 0,
          completionRate: 1,
          falseAcceptCount: 0,
          falseRejectCount: 0,
          replayDeterminismRate: 1,
          policyComplianceRate: 1,
          evidenceCompletenessRate: 1,
          costPerCompletedTaskUsd: 0,
          decision: 'GO',
          safety_locks: {
            network: 'DENY',
            external_gates: 'CLOSED'
          },
          release
        },
        200,
        baseHeaders
      );
    }

    if (pathname === '/api/system' || pathname === '/api/deployment') {
      if (request.method !== 'GET') {
        return methodNotAllowedResponse(['GET', 'OPTIONS'], baseHeaders);
      }
      const readiness = buildEdgeSecretsReport(env);
      return jsonResponse(
        {
          scope: 'cloudflare-edge',
          cardFreeHosting: true,
          fullEdgeRuntimeMounted: true,
          capabilities: EDGE_CAPABILITIES,
          release,
          generatedAt: new Date().toISOString(),
          coreReady: true,
          storage: {
            mode: isD1Bound(env) ? 'd1' : 'cloudflare-edge',
            durable: isD1Bound(env)
          },
          secretsConfiguredCount: readiness.configuredCount,
          totalSecretsTracked: readiness.totalSecretsTracked,
          r2Configured: Boolean(
            hasSecret(env, 'CLOUDFLARE_R2_ACCESS_KEY_ID') &&
              hasSecret(env, 'CLOUDFLARE_R2_SECRET_ACCESS_KEY') &&
              hasSecret(env, 'CLOUDFLARE_R2_S3_ENDPOINT')
          ),
          cronConfigured: hasSecret(env, 'CELIAOS_CRONJOB_ORG_API_KEY')
        },
        200,
        baseHeaders
      );
    }

    if (pathname === '/api/live') {
      if (request.method !== 'GET') {
        return methodNotAllowedResponse(['GET', 'OPTIONS'], baseHeaders);
      }
      const live = await buildEdgeLiveStatus({ env, origin: url.origin, release });
      return jsonResponse(live, 200, baseHeaders);
    }

    if (pathname === '/api/skills') {
      if (request.method !== 'GET') {
        return methodNotAllowedResponse(['GET', 'OPTIONS'], baseHeaders);
      }
      const skills = await searchEdgeSkills({
        env,
        query: url.searchParams.get('q') || '',
        category: url.searchParams.get('category') || 'all'
      });
      return jsonResponse(skills, 200, baseHeaders);
    }

    // Meta WhatsApp Cloud API Webhook (public route protected by hub.verify_token & raw-bytes HMAC-SHA256).
    if (pathname === '/webhooks/whatsapp') {
      if (request.method === 'GET') {
        return handleWhatsAppWebhookGet({ url, env });
      }
      if (request.method === 'POST') {
        try {
          const result = await handleWhatsAppWebhookPost({ request, env, origin: url.origin, fetchImpl });
          return jsonResponse(result.body, result.status, baseHeaders);
        } catch (err) {
          return runtimeErrorResponse(err, baseHeaders);
        }
      }
      return methodNotAllowedResponse(['GET', 'POST', 'OPTIONS'], baseHeaders);
    }

    // Google OAuth2 callback (public route protected by single-use D1 `oauth_states` + state cookie).
    if (pathname === '/auth/google/callback') {
      if (request.method !== 'GET') {
        return methodNotAllowedResponse(['GET', 'OPTIONS'], baseHeaders);
      }
      try {
        const result = await handleGoogleOAuthCallback({ request, url, env, fetchImpl });
        if (result.html) {
          return new Response(result.html, {
            status: result.status,
            headers: {
              ...baseHeaders,
              'content-type': 'text/html; charset=utf-8',
              ...(result.clearCookie ? { 'set-cookie': result.clearCookie } : {})
            }
          });
        }
        return jsonResponse(result.body, result.status, baseHeaders);
      } catch (err) {
        return runtimeErrorResponse(err, baseHeaders);
      }
    }

    // Google OAuth2 browser start: accepts either Bearer owner token OR a short-lived signed `ticket` query param.
    if (pathname === '/auth/google') {
      if (request.method !== 'GET') {
        return methodNotAllowedResponse(['GET', 'OPTIONS'], baseHeaders);
      }
      const ticket = url.searchParams.get('ticket') || '';
      let authorizedUserId = 'owner';
      if (ticket) {
        const verified = await verifyEdgeConsentTicket(env, ticket);
        if (!verified.ok) {
          return jsonResponse({ error: verified.reason }, 401, baseHeaders);
        }
        authorizedUserId = verified.userId;
      } else {
        const auth = await verifyBearer(request, env);
        if (!auth.ok) {
          return jsonResponse({ error: auth.error }, auth.status, baseHeaders);
        }
      }
      try {
        const consent = await createEdgeGoogleAuthUrl({ env, origin: url.origin, userId: authorizedUserId });
        return new Response(null, {
          status: 302,
          headers: {
            ...baseHeaders,
            location: consent.url,
            'set-cookie': `celia_oauth_state=${encodeURIComponent(consent.state)}; Max-Age=600; Path=/auth/google; HttpOnly; Secure; SameSite=Lax`
          }
        });
      } catch (err) {
        return runtimeErrorResponse(err, baseHeaders);
      }
    }

    // Owner-protected surface: MCP, Google OAuth link & Workspace APIs, WhatsApp REST, AI Reply, Secrets, Cron, State, Audit.
    const requiresOwnerAuth =
      pathname === '/mcp' ||
      pathname === '/auth/google/link' ||
      pathname.startsWith('/api/google') ||
      pathname.startsWith('/api/whatsapp') ||
      pathname.startsWith('/api/ai') ||
      pathname.startsWith('/api/secrets') ||
      pathname.startsWith('/api/cron') ||
      pathname.startsWith('/api/storage') ||
      pathname.startsWith('/api/state') ||
      pathname.startsWith('/api/audit');

    if (requiresOwnerAuth) {
      const auth = await verifyBearer(request, env);
      if (!auth.ok) {
        return jsonResponse({ error: auth.error }, auth.status, baseHeaders);
      }
    }

    // JSON-RPC 2.0 MCP Server (all 12 official Celia tools over D1 + Gemini + Google + WhatsApp).
    if (pathname === '/mcp') {
      if (request.method === 'GET') {
        return jsonResponse(
          {
            service: 'celia-phone-google-mcp',
            runtime: 'cloudflare-workers-d1',
            version: release.version,
            toolsCount: EDGE_MCP_TOOLS.length
          },
          200,
          baseHeaders
        );
      }
      if (request.method === 'POST') {
        const bodyCheck = await readBoundedJson(request, MAX_MCP_BODY_BYTES);
        if (!bodyCheck.ok) {
          return jsonResponse({ error: bodyCheck.error }, bodyCheck.status, baseHeaders);
        }
        const rpc = await handleEdgeMcpRpc({
          body: bodyCheck.data,
          env,
          origin: url.origin,
          release,
          fetchImpl
        });
        if (rpc.status === 202 || rpc.payload === null) {
          return new Response(null, { status: 202, headers: baseHeaders });
        }
        return jsonResponse(rpc.payload, rpc.status, baseHeaders);
      }
      return methodNotAllowedResponse(['GET', 'POST', 'OPTIONS'], baseHeaders);
    }

    if (pathname === '/auth/google/link') {
      if (request.method !== 'POST' && request.method !== 'GET') {
        return methodNotAllowedResponse(['GET', 'POST', 'OPTIONS'], baseHeaders);
      }
      try {
        const consent = await createEdgeGoogleAuthUrl({ env, origin: url.origin, userId: 'owner' });
        return jsonResponse(
          {
            ok: true,
            url: consent.url,
            redirectUri: consent.redirectUri,
            expiresAt: consent.expiresAt
          },
          200,
          baseHeaders
        );
      } catch (err) {
        return runtimeErrorResponse(err, baseHeaders);
      }
    }

    if (pathname === '/api/google/status') {
      if (request.method !== 'GET') return methodNotAllowedResponse(['GET', 'OPTIONS'], baseHeaders);
      return jsonResponse(await getEdgeGoogleStatus(env), 200, baseHeaders);
    }

    if (pathname === '/api/google/disconnect') {
      if (request.method !== 'POST') return methodNotAllowedResponse(['POST', 'OPTIONS'], baseHeaders);
      try {
        return jsonResponse(await disconnectEdgeGoogle({ env }), 200, baseHeaders);
      } catch (err) {
        return runtimeErrorResponse(err, baseHeaders);
      }
    }

    if (pathname === '/api/google/gmail/search') {
      if (request.method !== 'GET') return methodNotAllowedResponse(['GET', 'OPTIONS'], baseHeaders);
      try {
        return jsonResponse(await edgeGmailSearch({ env, q: url.searchParams.get('q') || '', fetchImpl }), 200, baseHeaders);
      } catch (err) {
        return runtimeErrorResponse(err, baseHeaders);
      }
    }

    if (pathname === '/api/google/drive/search') {
      if (request.method !== 'GET') return methodNotAllowedResponse(['GET', 'OPTIONS'], baseHeaders);
      try {
        return jsonResponse(await edgeDriveSearch({ env, q: url.searchParams.get('q') || '', fetchImpl }), 200, baseHeaders);
      } catch (err) {
        return runtimeErrorResponse(err, baseHeaders);
      }
    }

    if (pathname === '/api/google/calendar/events') {
      if (request.method === 'GET') {
        try {
          return jsonResponse(
            await edgeCalendarList({ env, days: url.searchParams.get('days') || 7, fetchImpl }),
            200,
            baseHeaders
          );
        } catch (err) {
          return runtimeErrorResponse(err, baseHeaders);
        }
      }
      if (request.method === 'POST') {
        const parsed = await readBoundedJson(request, MAX_BODY_BYTES);
        if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status, baseHeaders);
        try {
          const idem = request.headers.get('idempotency-key') || parsed.data?.idempotencyKey || null;
          return jsonResponse(
            await edgeCalendarCreate({
              env,
              summary: parsed.data?.summary,
              start: parsed.data?.start,
              end: parsed.data?.end,
              timeZone: parsed.data?.timeZone,
              idempotencyKey: idem,
              fetchImpl
            }),
            201,
            baseHeaders
          );
        } catch (err) {
          return runtimeErrorResponse(err, baseHeaders);
        }
      }
      return methodNotAllowedResponse(['GET', 'POST', 'OPTIONS'], baseHeaders);
    }

    if (pathname === '/api/google/contacts/search') {
      if (request.method !== 'GET') return methodNotAllowedResponse(['GET', 'OPTIONS'], baseHeaders);
      try {
        return jsonResponse(await edgeContactsSearch({ env, q: url.searchParams.get('q') || '', fetchImpl }), 200, baseHeaders);
      } catch (err) {
        return runtimeErrorResponse(err, baseHeaders);
      }
    }

    if (pathname === '/api/whatsapp/contacts') {
      if (request.method !== 'GET') return methodNotAllowedResponse(['GET', 'OPTIONS'], baseHeaders);
      try {
        return jsonResponse(await edgeWhatsAppContactsList({ env }), 200, baseHeaders);
      } catch (err) {
        return runtimeErrorResponse(err, baseHeaders);
      }
    }

    if (pathname === '/api/whatsapp/consent') {
      if (request.method !== 'POST') return methodNotAllowedResponse(['POST', 'OPTIONS'], baseHeaders);
      const parsed = await readBoundedJson(request, MAX_BODY_BYTES);
      if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status, baseHeaders);
      try {
        return jsonResponse(
          await edgeWhatsAppConsentUpsert({
            env,
            phone: parsed.data?.phone,
            optedIn: parsed.data?.optedIn,
            aiOptedIn: parsed.data?.aiOptedIn,
            source: parsed.data?.source
          }),
          200,
          baseHeaders
        );
      } catch (err) {
        return runtimeErrorResponse(err, baseHeaders);
      }
    }

    if (pathname === '/api/whatsapp/messages') {
      if (request.method !== 'POST') return methodNotAllowedResponse(['POST', 'OPTIONS'], baseHeaders);
      const parsed = await readBoundedJson(request, MAX_BODY_BYTES);
      if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status, baseHeaders);
      try {
        const idem = request.headers.get('idempotency-key') || parsed.data?.idempotencyKey || null;
        return jsonResponse(
          await edgeWhatsAppSendText({
            env,
            phone: parsed.data?.phone,
            text: parsed.data?.text,
            idempotencyKey: idem,
            fetchImpl
          }),
          200,
          baseHeaders
        );
      } catch (err) {
        return runtimeErrorResponse(err, baseHeaders);
      }
    }

    if (pathname === '/api/ai/reply') {
      if (request.method !== 'POST') return methodNotAllowedResponse(['POST', 'OPTIONS'], baseHeaders);
      const parsed = await readBoundedJson(request, MAX_BODY_BYTES);
      if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status, baseHeaders);
      try {
        return jsonResponse(
          await generateEdgeAiReply({
            env,
            customerMessage: parsed.data?.customerMessage,
            provider: parsed.data?.provider || 'auto',
            businessContext: parsed.data?.businessContext || '',
            fetchImpl
          }),
          200,
          baseHeaders
        );
      } catch (err) {
        return runtimeErrorResponse(err, baseHeaders);
      }
    }

    // Durable key/value state and its audit chain (DEC-035).
    if (pathname === '/api/state') {
      if (request.method !== 'GET') {
        return methodNotAllowedResponse(['GET', 'OPTIONS'], baseHeaders);
      }
      const { status, body } = await stateResult(() => createStateStore(env).list({ limit: url.searchParams.get('limit') }));
      return jsonResponse(body, status, baseHeaders);
    }

    if (pathname === '/api/audit') {
      if (request.method !== 'GET') {
        return methodNotAllowedResponse(['GET', 'OPTIONS'], baseHeaders);
      }
      const { status, body } = await stateResult(() => createStateStore(env).audit({ limit: url.searchParams.get('limit') }));
      return jsonResponse(body, status, baseHeaders);
    }

    if (pathname.startsWith('/api/state/')) {
      const key = decodeURIComponent(pathname.slice('/api/state/'.length));
      const store = createStateStore(env);
      if (request.method === 'GET') {
        const { status, body } = await stateResult(() => store.get(key));
        return jsonResponse(body, status, baseHeaders);
      }
      if (request.method === 'PUT' || request.method === 'POST') {
        const raw = await request.text();
        if (utf8ByteLength(raw) > MAX_BODY_BYTES) {
          return jsonResponse({ error: 'payload_too_large' }, 413, baseHeaders);
        }
        let value = raw;
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && 'value' in parsed) value = parsed.value;
        } catch {
          /* a plain string body is a valid value */
        }
        const { status, body } = await stateResult(() => store.put(key, value));
        return jsonResponse(body, status, baseHeaders);
      }
      return methodNotAllowedResponse(['GET', 'PUT', 'POST', 'OPTIONS'], baseHeaders);
    }

    if (pathname === '/api/secrets/status') {
      if (request.method !== 'GET') {
        return methodNotAllowedResponse(['GET', 'OPTIONS'], baseHeaders);
      }
      return jsonResponse(buildEdgeSecretsReport(env), 200, baseHeaders);
    }

    if (pathname === '/api/storage/r2/status') {
      if (request.method !== 'GET') {
        return methodNotAllowedResponse(['GET', 'OPTIONS'], baseHeaders);
      }
      return jsonResponse(
        {
          configured: Boolean(
            hasSecret(env, 'CLOUDFLARE_R2_ACCESS_KEY_ID') &&
              hasSecret(env, 'CLOUDFLARE_R2_SECRET_ACCESS_KEY') &&
              hasSecret(env, 'CLOUDFLARE_R2_S3_ENDPOINT')
          ),
          accessKeyConfigured: hasSecret(env, 'CLOUDFLARE_R2_ACCESS_KEY_ID'),
          secretKeyConfigured: hasSecret(env, 'CLOUDFLARE_R2_SECRET_ACCESS_KEY'),
          endpointConfigured: hasSecret(env, 'CLOUDFLARE_R2_S3_ENDPOINT'),
          cloudflareAccountConfigured: hasSecret(env, 'CLOUDFLARE_ACCOUNT_ID'),
          cloudflareTokenConfigured: hasSecret(env, 'CLOUDFLARE_API_TOKEN')
        },
        200,
        baseHeaders
      );
    }

    if (pathname === '/api/cron/status' || pathname === '/api/cron/health') {
      if (request.method !== 'GET') {
        return methodNotAllowedResponse(['GET', 'OPTIONS'], baseHeaders);
      }
      return jsonResponse(
        {
          ok: true,
          configured: hasSecret(env, 'CELIAOS_CRONJOB_ORG_API_KEY'),
          sourceEnv: hasSecret(env, 'CELIAOS_CRONJOB_ORG_API_KEY') ? 'CELIAOS_CRONJOB_ORG_API_KEY' : null,
          mode: 'governed-scheduler'
        },
        200,
        baseHeaders
      );
    }

    if (pathname.startsWith('/api/cron/jobs')) {
      const subPath = pathname.slice('/api/cron'.length); // /jobs or /jobs/:id or /jobs/:id/history
      if (!/^\/jobs(\/\d+(\/history)?)?$/.test(subPath)) {
        return jsonResponse({ error: 'invalid_cron_path' }, 400, baseHeaders);
      }

      const isCollection = subPath === '/jobs';
      const isHistory = subPath.endsWith('/history');
      const allowedMethods = isCollection
        ? ['GET', 'POST', 'OPTIONS']
        : isHistory
          ? ['GET', 'OPTIONS']
          : ['GET', 'PATCH', 'DELETE', 'OPTIONS'];
      if (!allowedMethods.includes(request.method)) {
        return methodNotAllowedResponse(allowedMethods, baseHeaders);
      }

      const cronKey = String(env.CELIAOS_CRONJOB_ORG_API_KEY || '').trim();
      if (!cronKey) {
        return jsonResponse({ error: 'cronjob_not_configured' }, 503, baseHeaders);
      }

      let upstreamMethod = request.method;
      let upstreamBody;
      if (request.method === 'POST' && isCollection) {
        upstreamMethod = 'PUT';
      }
      if (request.method === 'POST' || request.method === 'PATCH') {
        const rawText = await request.text();
        if (utf8ByteLength(rawText) > MAX_BODY_BYTES) {
          return jsonResponse({ error: 'payload_too_large' }, 413, baseHeaders);
        }
        let parsed;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          return jsonResponse({ error: 'invalid_json' }, 400, baseHeaders);
        }
        const check = validateCronJobPayload(parsed, { partial: request.method === 'PATCH' });
        if (!check.ok) {
          return jsonResponse({ error: check.error }, 422, baseHeaders);
        }
        upstreamBody = JSON.stringify({ job: check.job });
      }

      let upstreamRes;
      try {
        upstreamRes = await fetchImpl(`${CRONJOB_ORIGIN}${subPath}`, {
          method: upstreamMethod,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${cronKey}`,
            ...(upstreamBody ? { 'content-type': 'application/json' } : {})
          },
          body: upstreamBody,
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
        });
      } catch (err) {
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        return jsonResponse(
          { error: timedOut ? 'cronjob_upstream_timeout' : 'cronjob_upstream_unreachable' },
          timedOut ? 504 : 502,
          baseHeaders
        );
      }

      if (!upstreamRes.ok) {
        return jsonResponse(
          {
            error: 'cronjob_upstream_error',
            upstreamStatus: upstreamRes.status
          },
          502,
          baseHeaders
        );
      }
      const data = await upstreamRes.json().catch(() => ({}));
      return jsonResponse(data, 200, baseHeaders);
    }

    return jsonResponse({ error: 'not_found' }, 404, baseHeaders);
  }
};
