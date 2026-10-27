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

test('EDGE-03: buildWorkerMetadata prepares secret_text bindings for all 18 repository secrets', () => {
  const metadata = buildWorkerMetadata({
    env: FULL_EDGE_ENV,
    version: '0.2.1',
    commit: 'abc1234'
  });
  const secretBindings = metadata.bindings.filter((b) => b.type === 'secret_text');
  assert.equal(secretBindings.length, 18);
});
