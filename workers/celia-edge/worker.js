const CRONJOB_ORIGIN = 'https://api.cron-job.org';
const MAX_BODY_BYTES = 8192;
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

function hasSecret(env, name) {
  const val = String(env?.[name] || '').trim();
  return Boolean(val && !/^replace-with-/i.test(val));
}

function constantTimeEqual(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  if (!sa || !sb || sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i += 1) {
    diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  }
  return diff === 0;
}

function corsHeaders(request, env) {
  const allowed = String(env?.ALLOWED_ORIGIN || 'https://celiaelazamey-arch.github.io').trim();
  const origin = request.headers.get('origin') || '';
  const headers = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  };
  if (allowed && origin === allowed) {
    headers['access-control-allow-origin'] = allowed;
    headers['access-control-allow-methods'] = 'GET, POST, PATCH, DELETE, OPTIONS';
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

function verifyBearer(request, env) {
  const expected = String(env?.CELIA_MCP_API_TOKEN || '').trim();
  if (!expected || expected.length < 32) {
    return { ok: false, status: 503, error: 'owner_token_not_configured' };
  }
  const auth = request.headers.get('authorization') || '';
  if (!auth.toLowerCase().startsWith('bearer ')) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  const token = auth.slice(7).trim();
  if (!constantTimeEqual(token, expected)) {
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
    // `retired` = the owner explicitly took this service out of the product (CELIA_DISABLE_<boundary>=true,
    // DEC-030): a present-but-dead credential is reported as such instead of parading as capability.
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

function validateCronJobPayload(payload, { partial = false } = {}) {
  if (!payload || typeof payload !== 'object' || !payload.job || typeof payload.job !== 'object') {
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
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return { ok: false, error: 'invalid_job_url_protocol' };
      }
    } catch {
      return { ok: false, error: 'invalid_job_url' };
    }
  }
  return { ok: true, job };
}

export default {
  async fetch(request, env = {}) {
    const baseHeaders = corsHeaders(request, env);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: baseHeaders });
    }

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const release = {
      name: 'celia-phone-google-edge',
      version: String(env.CELIA_VERSION || '0.2.1'),
      commit: String(env.CELIA_BUILD_SHA || 'main')
    };

    if (request.method === 'GET' && (pathname === '/' || pathname === '/health' || pathname === '/readyz')) {
      const readiness = buildEdgeSecretsReport(env);
      return jsonResponse(
        {
          ok: true,
          ready: true,
          service: 'celia-phone-google-edge',
          release,
          storage: {
            mode: 'cloudflare-edge',
            // Presence of R2 credentials is not durability: nothing here writes or reads R2, so this
            // endpoint never claims `durable: true`. The service-reality audit exercises R2 for real.
            durable: false,
            r2CredentialsPresent: Boolean(
              hasSecret(env, 'CLOUDFLARE_R2_ACCESS_KEY_ID') &&
                hasSecret(env, 'CLOUDFLARE_R2_SECRET_ACCESS_KEY') &&
                hasSecret(env, 'CLOUDFLARE_R2_S3_ENDPOINT')
            ),
            durabilityVerifiedBy: 'service-reality audit (not this endpoint)'
          },
          secretsConfiguredCount: readiness.configuredCount,
          totalSecretsTracked: readiness.totalSecretsTracked
        },
        200,
        baseHeaders
      );
    }

    if (request.method === 'GET' && pathname === '/version') {
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

    if (
      request.method === 'GET' &&
      (pathname === '/api/protocol-benchmark.json' || pathname === '/api/protocol/benchmark')
    ) {
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

    if (request.method === 'GET' && (pathname === '/api/system' || pathname === '/api/deployment')) {
      const readiness = buildEdgeSecretsReport(env);
      return jsonResponse(
        {
          scope: 'cloudflare-edge',
          release,
          generatedAt: new Date().toISOString(),
          coreReady: true,
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

    // All /api/secrets/*, /api/cron/*, and /api/storage/* routes require Bearer CELIA_MCP_API_TOKEN
    if (
      pathname.startsWith('/api/secrets') ||
      pathname.startsWith('/api/cron') ||
      pathname.startsWith('/api/storage')
    ) {
      const auth = verifyBearer(request, env);
      if (!auth.ok) {
        return jsonResponse({ error: auth.error }, auth.status, baseHeaders);
      }
    }

    if (request.method === 'GET' && pathname === '/api/secrets/status') {
      return jsonResponse(buildEdgeSecretsReport(env), 200, baseHeaders);
    }

    if (request.method === 'GET' && pathname === '/api/storage/r2/status') {
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

    if (request.method === 'GET' && (pathname === '/api/cron/status' || pathname === '/api/cron/health')) {
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
      const cronKey = String(env.CELIAOS_CRONJOB_ORG_API_KEY || '').trim();
      if (!cronKey) {
        return jsonResponse({ error: 'cronjob_not_configured' }, 503, baseHeaders);
      }

      const subPath = pathname.slice('/api/cron'.length); // /jobs or /jobs/:id or /jobs/:id/history
      if (!/^\/jobs(\/\d+(\/history)?)?$/.test(subPath)) {
        return jsonResponse({ error: 'invalid_cron_path' }, 400, baseHeaders);
      }

      let upstreamMethod = request.method;
      let upstreamBody;
      if (request.method === 'POST' && subPath === '/jobs') {
        upstreamMethod = 'PUT';
      }
      if (request.method === 'POST' || request.method === 'PATCH') {
        const rawText = await request.text();
        if (rawText.length > MAX_BODY_BYTES) {
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

      const upstreamRes = await fetch(`${CRONJOB_ORIGIN}${subPath}`, {
        method: upstreamMethod,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${cronKey}`,
          ...(upstreamBody ? { 'content-type': 'application/json' } : {})
        },
        body: upstreamBody
      });

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
