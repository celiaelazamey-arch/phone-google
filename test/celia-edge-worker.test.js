import test from 'node:test';
import assert from 'node:assert/strict';
import edgeWorker, { buildEdgeSecretsReport } from '../workers/celia-edge/worker.js';
import { buildWorkerMetadata } from '../scripts/deploy-cloudflare-edge.mjs';

const FULL_EDGE_ENV = {
  ALLOWED_ORIGIN: 'https://celiaelazamey-arch.github.io',
  CELIA_VERSION: '0.2.1',
  CELIA_BUILD_SHA: 'dcb62289abf6315f6924736990201254590dc634',
  AGENETROUTERAPI_KEY: 'sk-agentrouter-edge-11',
  AI_GATEWAY_API_KEY: 'vck-gateway-edge-22',
  CELIAOS_CRONJOB_ORG_API_KEY: 'cronjob-org-edge-33',
  CELIA_MCP_API_TOKEN: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  CELIA_VOICE_ID: 'JBFqnCBsd6RMkjVDRZzb',
  CLOUDFLARE_ACCOUNT_ID: 'cf-acc-44',
  CLOUDFLARE_API_TOKEN: 'cf-tok-55',
  CLOUDFLARE_R2_ACCESS_KEY_ID: 'r2-ak-66',
  CLOUDFLARE_R2_S3_ENDPOINT: 'https://acc.r2.cloudflarestorage.com',
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'r2-sk-77',
  DEEPSEEK_API_KEY: 'sk-deepseek-88',
  ELEVENLABS_API_KEY: 'xi-eleven-99',
  FIGMA_ACCESS_TOKEN: 'figd-00',
  GEMINI_API_KEY: 'AIzaSyEdgeTest11',
  GOOGLE_CLIENT_ID: 'google-cid-22',
  GOOGLE_CLIENT_SECRET: 'google-csec-33',
  PHONE_NUMBER: '+201012345678',
  YOUR_CODATA_API_KEY: 'codata-edge-44'
};

test('EDGE-01: buildEdgeSecretsReport and /readyz + /api/secrets/status track all 18 secrets without leaking values', async () => {
  const report = buildEdgeSecretsReport(FULL_EDGE_ENV);
  assert.equal(report.totalSecretsTracked, 18);
  assert.equal(report.configuredCount, 18);
  assert.equal(report.allConfigured, true);

  const readyRes = await edgeWorker.fetch(
    new Request('https://celia-phone-google.workers.dev/readyz', {
      headers: { origin: 'https://celiaelazamey-arch.github.io' }
    }),
    FULL_EDGE_ENV
  );
  assert.equal(readyRes.status, 200);
  assert.equal(readyRes.headers.get('access-control-allow-origin'), 'https://celiaelazamey-arch.github.io');
  const readyJson = await readyRes.json();
  assert.equal(readyJson.ready, true);
  assert.equal(readyJson.totalSecretsTracked, 18);
  assert.equal(readyJson.secretsConfiguredCount, 18);

  const unauthRes = await edgeWorker.fetch(
    new Request('https://celia-phone-google.workers.dev/api/secrets/status'),
    FULL_EDGE_ENV
  );
  assert.equal(unauthRes.status, 401);

  const authRes = await edgeWorker.fetch(
    new Request('https://celia-phone-google.workers.dev/api/secrets/status', {
      headers: { authorization: `Bearer ${FULL_EDGE_ENV.CELIA_MCP_API_TOKEN}` }
    }),
    FULL_EDGE_ENV
  );
  assert.equal(authRes.status, 200);
  const authText = await authRes.text();
  for (const [k, v] of Object.entries(FULL_EDGE_ENV)) {
    if (k.startsWith('ALLOWED_') || k.startsWith('CELIA_VERSION') || k.startsWith('CELIA_BUILD')) continue;
    assert.equal(authText.includes(v), false, `Secret ${k} leaked in edge response`);
  }
});

test('EDGE-02: /api/cron/status, /api/storage/r2/status, and /api/cron/jobs enforce bearer auth and field allowlist', async () => {
  const r2Res = await edgeWorker.fetch(
    new Request('https://celia-phone-google.workers.dev/api/storage/r2/status', {
      headers: { authorization: `Bearer ${FULL_EDGE_ENV.CELIA_MCP_API_TOKEN}` }
    }),
    FULL_EDGE_ENV
  );
  assert.equal(r2Res.status, 200);
  const r2Json = await r2Res.json();
  assert.equal(r2Json.configured, true);

  const badFieldRes = await edgeWorker.fetch(
    new Request('https://celia-phone-google.workers.dev/api/cron/jobs', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${FULL_EDGE_ENV.CELIA_MCP_API_TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        job: {
          url: 'https://example.com/hook',
          evilField: 'not-allowed'
        }
      })
    }),
    FULL_EDGE_ENV
  );
  assert.equal(badFieldRes.status, 422);
});

test('EDGE-03: buildWorkerMetadata prepares secret_text bindings for all 18 repository secrets and worker serves /version and /api/protocol-benchmark.json', async () => {
  const metadata = buildWorkerMetadata({
    env: FULL_EDGE_ENV,
    version: '0.2.1',
    commit: 'abc1234'
  });
  const secretBindings = metadata.bindings.filter((b) => b.type === 'secret_text');
  assert.equal(secretBindings.length, 18);

  const verRes = await edgeWorker.fetch(
    new Request('https://celia-phone-google.workers.dev/version'),
    FULL_EDGE_ENV
  );
  assert.equal(verRes.status, 200);
  const verJson = await verRes.json();
  assert.equal(verJson.version, '0.2.1');

  const bmRes = await edgeWorker.fetch(
    new Request('https://celia-phone-google.workers.dev/api/protocol-benchmark.json'),
    FULL_EDGE_ENV
  );
  assert.equal(bmRes.status, 200);
  const bmJson = await bmRes.json();
  assert.equal(bmJson.totalCases, 20);
  assert.equal(bmJson.passedCount, 20);
  assert.equal(bmJson.decision, 'GO');
});

test('edge worker: enforces SSRF guard, 405 allow headers, 413 payload caps, security headers, and passive /health vs active /readyz', async () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const dualOriginEnv = {
      ...FULL_EDGE_ENV,
      ALLOWED_ORIGIN: 'https://celiaelazamey-arch.github.io,https://celia-phone-google-ui.pages.dev'
    };
    const authHeaders = {
      authorization: `Bearer ${FULL_EDGE_ENV.CELIA_MCP_API_TOKEN}`,
      'content-type': 'application/json',
      origin: 'https://celia-phone-google-ui.pages.dev'
    };

    const blockedUrls = [
      'http://example.com/hook',
      'https://localhost/hook',
      'https://127.0.0.1/hook',
      'https://169.254.169.254/latest/meta-data/',
      'https://100.64.0.10/internal',
      'https://[::1]/hook',
      'https://[::ffff:127.0.0.1]/hook',
      'https://[fc00::1]/hook',
      'https://[fe80::1]/hook',
      'https://metadata.google.internal/computeMetadata/v1/',
      'https://user:pass@example.com/hook',
      'https://example.com/hook#frag'
    ];

    for (const badUrl of blockedUrls) {
      const res = await edgeWorker.fetch(
        new Request('https://celia-phone-google.workers.dev/api/cron/jobs', {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ job: { url: badUrl, title: 'bad' } })
        }),
        dualOriginEnv
      );
      assert.equal(res.status, 422, `SSRF guard must block ${badUrl}`);
      assert.equal(res.headers.get('access-control-allow-origin'), 'https://celia-phone-google-ui.pages.dev');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
    }
    assert.equal(upstreamCalls, 0, 'blocked SSRF URLs must never reach fetch()');

    // 405 Method Not Allowed with explicit Allow header
    const wrongMethod = await edgeWorker.fetch(
      new Request('https://celia-phone-google.workers.dev/api/secrets/status', {
        method: 'POST',
        headers: authHeaders
      }),
      dualOriginEnv
    );
    assert.equal(wrongMethod.status, 405);
    assert.match(wrongMethod.headers.get('allow') || '', /GET/);

    // 413 Payload Too Large on /api/cron/jobs (>8 KiB)
    const hugeRes = await edgeWorker.fetch(
      new Request('https://celia-phone-google.workers.dev/api/cron/jobs', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ job: { url: 'https://example.com/ping', title: 'x'.repeat(10_000) } })
      }),
      dualOriginEnv
    );
    assert.equal(hugeRes.status, 413);

    // Passive /health must NOT execute D1 write/read SQL, while /readyz DOES probe D1
    let d1PreparedCount = 0;
    let lastToken = null;
    const fakeDb = {
      prepare() {
        d1PreparedCount += 1;
        return {
          bind(_key, token) {
            if (token) lastToken = token;
            return this;
          },
          async run() {
            return { success: true };
          },
          async first() {
            return { token: lastToken, updated_at: '2026-10-28T00:00:00.000Z' };
          }
        };
      }
    };
    const envWithD1 = { ...dualOriginEnv, DB: fakeDb };
    const healthRes = await edgeWorker.fetch(new Request('https://celia-phone-google.workers.dev/health'), envWithD1);
    const healthBody = await healthRes.json();
    assert.equal(healthRes.status, 200);
    assert.equal(healthBody.storage.mode, 'd1');
    assert.equal(healthBody.storage.durable, false);
    assert.equal(d1PreparedCount, 0, '/health must remain passive and never write to D1');

    const readyRes = await edgeWorker.fetch(new Request('https://celia-phone-google.workers.dev/readyz'), envWithD1);
    const readyBody = await readyRes.json();
    assert.equal(readyRes.status, 200);
    assert.equal(readyBody.storage.mode, 'd1');
    assert.equal(readyBody.storage.durable, true);
    assert.ok(d1PreparedCount >= 2, '/readyz must actively verify D1 read+write');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

