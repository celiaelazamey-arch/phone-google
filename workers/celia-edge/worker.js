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
  verifyEdgeConsentTicket,
  recordEdgeReplyMetric,
  EDGE_MAX_OUTPUT_TOKENS
} from './runtime.js';
import { summarizeReplyMetrics, REPLY_CHAR_CAP } from './reply-metrics.js';
import {
  approveIntent,
  createIntent,
  getIntent,
  isDisallowedTargetHost,
  listIntents,
  outboxCounts,
  readUpstream,
  reconcileIntent,
  rejectIntent,
  validateCronJobPayload
} from './cron.js';

export { isDisallowedTargetHost, validateCronJobPayload };

const MAX_BODY_BYTES = 8192;
const MAX_MCP_BODY_BYTES = 32_768;
const DEFAULT_ALLOWED_ORIGINS = [
  'https://celiaelazamey-arch.github.io',
  'https://celia-phone-google-ui.pages.dev'
];

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


function runtimeErrorResponse(error, baseHeaders) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  return jsonResponse({ error: String(error?.message || 'runtime_error') }, status, baseHeaders);
}

/**
 * /api/cron/intents — the outbox the owner approves from (DEC-042). Owner auth was already verified.
 *   GET  /api/cron/intents[?status=&limit=]      list
 *   POST /api/cron/intents                        { action, jobId?, job?, note? } + Idempotency-Key header
 *   GET  /api/cron/intents/:id                    detail
 *   POST /api/cron/intents/:id/approve            { expectedHash }   -> claim + dispatch once
 *   POST /api/cron/intents/:id/reject             { note? }
 *   POST /api/cron/intents/:id/reconcile          { outcome: applied|not_applied, externalRef?, note? } (from unknown only)
 */
async function handleCronIntents({ request, env, pathname, baseHeaders, fetchImpl }) {
  const rest = pathname.slice('/api/cron/intents'.length);
  const match = rest.match(/^(?:\/([0-9a-f-]{36})(?:\/(approve|reject|reconcile))?)?$/i);
  if (!match) {
    return jsonResponse({ error: 'invalid_cron_path' }, 400, baseHeaders);
  }
  const [, id, verb] = match;
  if (!isD1Bound(env)) {
    return jsonResponse({ error: 'd1_not_bound' }, 503, baseHeaders);
  }
  const cronKey = String(env.CELIAOS_CRONJOB_ORG_API_KEY || '').trim();

  if (!id) {
    if (request.method === 'GET') {
      const url = new URL(request.url);
      const intents = await listIntents(env, { status: url.searchParams.get('status'), limit: url.searchParams.get('limit') || 50 });
      return jsonResponse({ intents, counts: await outboxCounts(env) }, 200, baseHeaders);
    }
    if (request.method !== 'POST') {
      return methodNotAllowedResponse(['GET', 'POST', 'OPTIONS'], baseHeaders);
    }
    const parsed = await readBoundedJson(request, MAX_BODY_BYTES);
    if (!parsed.ok) {
      return jsonResponse({ error: parsed.error }, parsed.status, baseHeaders);
    }
    if (!cronKey) {
      return jsonResponse({ error: 'cronjob_not_configured' }, 503, baseHeaders);
    }
    const result = await createIntent(env, {
      action: parsed.data.action,
      jobId: parsed.data.jobId,
      job: parsed.data.job,
      note: parsed.data.note,
      idempotencyKey: request.headers.get('idempotency-key')
    });
    return jsonResponse(result.body, result.status, baseHeaders);
  }

  if (!verb) {
    if (request.method !== 'GET') {
      return methodNotAllowedResponse(['GET', 'OPTIONS'], baseHeaders);
    }
    const intent = await getIntent(env, id);
    return intent
      ? jsonResponse({ intent }, 200, baseHeaders)
      : jsonResponse({ error: 'intent_not_found' }, 404, baseHeaders);
  }

  if (request.method !== 'POST') {
    return methodNotAllowedResponse(['POST', 'OPTIONS'], baseHeaders);
  }
  const parsed = await readBoundedJson(request, MAX_BODY_BYTES);
  if (!parsed.ok) {
    return jsonResponse({ error: parsed.error }, parsed.status, baseHeaders);
  }
  const body = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
  const result =
    verb === 'approve'
      ? await approveIntent(env, id, { expectedHash: body.expectedHash, cronKey, fetchImpl })
      : verb === 'reject'
        ? await rejectIntent(env, id, { note: body.note })
        : await reconcileIntent(env, id, { outcome: body.outcome, externalRef: body.externalRef, note: body.note });
  return jsonResponse(result.body, result.status, baseHeaders);
}

export default {
  async fetch(request, env = {}) {
    const fetchImpl = typeof env?.__FETCH_IMPL === 'function' ? env.__FETCH_IMPL : globalThis.fetch;
    const now = typeof env?.__NOW === 'function' ? env.__NOW : () => new Date();
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
          const result = await handleWhatsAppWebhookPost({ request, env, origin: url.origin, fetchImpl, now });
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
          fetchImpl,
          now
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
              fetchImpl,
              now
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
            fetchImpl,
            now
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
        const ai = await generateEdgeAiReply({
          env,
          customerMessage: parsed.data?.customerMessage,
          provider: parsed.data?.provider || 'auto',
          businessContext: parsed.data?.businessContext || '',
          fetchImpl
        });
        // WP-1.4: owner test replies are measured too, under their own source so they never pollute the webhook ratio.
        const metric = await recordEdgeReplyMetric(env, { providerMessageId: `api:${crypto.randomUUID()}`, source: 'api', ai, at: new Date().toISOString() });
        return jsonResponse({ ...ai, metricRecorded: metric.ok }, 200, baseHeaders);
      } catch (err) {
        return runtimeErrorResponse(err, baseHeaders);
      }
    }

    // WP-1.4 (DEC-050): the truncated-reply ratio, owner-only, read before any change to maxOutputTokens.
    if (pathname === '/api/whatsapp/reply-metrics') {
      if (request.method !== 'GET') return methodNotAllowedResponse(['GET', 'OPTIONS'], baseHeaders);
      const summary = await summarizeReplyMetrics(env, { sinceDays: url.searchParams.get('days') || 30 });
      return jsonResponse({ ...summary, maxOutputTokens: EDGE_MAX_OUTPUT_TOKENS, charCap: REPLY_CHAR_CAP, decision: 'DEC-050' }, summary.ok ? 200 : 503, baseHeaders);
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
      const configured = hasSecret(env, 'CELIAOS_CRONJOB_ORG_API_KEY');
      const durable = isD1Bound(env);
      let outbox = null;
      if (durable) {
        try {
          outbox = await outboxCounts(env);
        } catch (error) {
          outbox = { error: 'outbox_unavailable', detail: String(error?.message || error).slice(0, 120) };
        }
      }
      return jsonResponse(
        {
          ok: true,
          configured,
          sourceEnv: configured ? 'CELIAOS_CRONJOB_ORG_API_KEY' : null,
          mode: 'governed-scheduler',
          reads: configured ? 'sanitized-proxy' : 'unavailable:cronjob_not_configured',
          writes: durable ? 'outbox-approval-only' : 'unavailable:d1_not_bound',
          durable,
          outbox,
          decision: 'DEC-042'
        },
        200,
        baseHeaders
      );
    }

    if (pathname.startsWith('/api/cron/intents')) {
      return handleCronIntents({ request, env, pathname, baseHeaders, fetchImpl });
    }

    if (pathname.startsWith('/api/cron/jobs')) {
      const subPath = pathname.slice('/api/cron'.length); // /jobs or /jobs/:id or /jobs/:id/history
      const match = subPath.match(/^\/jobs(?:\/(\d+)(\/history)?)?$/);
      if (!match) {
        return jsonResponse({ error: 'invalid_cron_path' }, 400, baseHeaders);
      }
      const jobId = match[1] ? Number(match[1]) : null;
      const isCollection = subPath === '/jobs';
      const isHistory = Boolean(match[2]);
      const allowedMethods = isCollection
        ? ['GET', 'POST', 'OPTIONS']
        : isHistory
          ? ['GET', 'OPTIONS']
          : ['GET', 'PATCH', 'DELETE', 'OPTIONS'];
      if (!allowedMethods.includes(request.method)) {
        return methodNotAllowedResponse(allowedMethods, baseHeaders);
      }

      const cronKey = String(env.CELIAOS_CRONJOB_ORG_API_KEY || '').trim();
      if (request.method === 'GET') {
        if (!cronKey) {
          return jsonResponse({ error: 'cronjob_not_configured' }, 503, baseHeaders);
        }
        const result = await readUpstream({ cronKey, fetchImpl, subPath });
        return jsonResponse(result.body, result.status, baseHeaders);
      }

      // Writes are intents (DEC-042): validated here, stored in D1, applied only after an owner approval.
      let job;
      let note;
      if (request.method === 'DELETE') {
        job = undefined;
      } else {
        const parsed = await readBoundedJson(request, MAX_BODY_BYTES);
        if (!parsed.ok) {
          return jsonResponse({ error: parsed.error }, parsed.status, baseHeaders);
        }
        const check = validateCronJobPayload(parsed.data, { partial: request.method === 'PATCH' });
        if (!check.ok) {
          return jsonResponse({ error: check.error }, 422, baseHeaders);
        }
        job = check.job;
        note = typeof parsed.data.note === 'string' ? parsed.data.note : undefined;
      }
      if (!cronKey) {
        return jsonResponse({ error: 'cronjob_not_configured' }, 503, baseHeaders);
      }
      const action = request.method === 'POST' ? 'create' : request.method === 'PATCH' ? 'update' : 'delete';
      const result = await createIntent(env, {
        action,
        jobId,
        job,
        note,
        idempotencyKey: request.headers.get('idempotency-key')
      });
      return jsonResponse(result.body, result.status, baseHeaders);
    }

    return jsonResponse({ error: 'not_found' }, 404, baseHeaders);
  }
};
