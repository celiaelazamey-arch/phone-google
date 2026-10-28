import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildProbes,
  classifyGoogleTokenResponse,
  classifyS3Response,
  parseArgs,
  parseTestSummary,
  renderMarkdown,
  runProbes,
  sanitize,
  scoreServices,
  signAwsV4
} from '../scripts/service-reality.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('SigV4 matches the official AWS test vector (get-vanilla)', () => {
  const signed = signAwsV4({
    method: 'GET',
    url: 'https://example.amazonaws.com/',
    headers: { 'x-amz-date': '20150830T123600Z' },
    region: 'us-east-1',
    service: 'service',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
  });
  assert.equal(signed.signature, '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  assert.equal(signed.headers.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
});

test('S3 and Google token responses are classified by what they prove, not by HTTP status alone', () => {
  assert.equal(classifyS3Response(200, '<ListAllMyBucketsResult><Buckets><Bucket><Name>a</Name></Bucket><Bucket><Name>b</Name></Bucket></Buckets></ListAllMyBucketsResult>').detail, 'ListBuckets ok (2 buckets)');
  assert.equal(classifyS3Response(403, '<Error><Code>AccessDenied</Code></Error>').verdict, 'verified');
  assert.equal(classifyS3Response(403, '<Error><Code>SignatureDoesNotMatch</Code></Error>').verdict, 'failed');
  assert.equal(classifyS3Response(403, '<Error><Code>InvalidAccessKeyId</Code></Error>').verdict, 'failed');
  assert.equal(classifyS3Response(500, '').verdict, 'failed');
  assert.equal(classifyGoogleTokenResponse(400, { error: 'invalid_grant' }).verdict, 'verified');
  assert.equal(classifyGoogleTokenResponse(401, { error: 'invalid_client' }).verdict, 'failed');
  assert.equal(classifyGoogleTokenResponse(400, { error: 'unauthorized_client' }).verdict, 'failed');
  assert.equal(classifyGoogleTokenResponse(200, {}).verdict, 'failed');
});

test('test-runner output parsing extracts counts and the coverage table', () => {
  const parsed = parseTestSummary('# tests 311\n# pass 310\n# fail 1\n# skipped 0\n# start of coverage report\n# file | line % | branch % | funcs % | uncovered lines\n# src/google.js | 59.32 | 51.56 | 60.61 | 1-3\n# all files | 85.87 | 73.30 | 84.16 |\n');
  assert.deepEqual([parsed.tests, parsed.pass, parsed.fail, parsed.skipped], [311, 310, 1, 0]);
  assert.deepEqual(parsed.coverage, { lines: 85.87, branches: 73.3, functions: 84.16 });
  assert.deepEqual(parsed.files['src/google.js'], { lines: 59.32, branches: 51.56, functions: 60.61 });
  assert.equal(parseTestSummary('').tests, null);
});

test('scoring counts only configured services in the working rate', () => {
  const score = scoreServices([{ verdict: 'verified' }, { verdict: 'verified' }, { verdict: 'failed' }, { verdict: 'unverifiable' }, { verdict: 'not-configured' }, { verdict: 'not-deployed' }]);
  assert.equal(score.configured, 3);
  assert.equal(score.workingRate, 0.6667);
  assert.equal(scoreServices([{ verdict: 'not-configured' }]).workingRate, null);
});

test('sanitize removes every configured secret value and args parse strictly', () => {
  const env = { GEMINI_API_KEY: 'AIzaSySECRET', CELIA_MCP_API_TOKEN: 't'.repeat(40), PHONE_NUMBER: '+201012345678' };
  const out = sanitize('k=AIzaSySECRET t=tttttttttttttttttttttttttttttttttttttttt p=+201012345678', env);
  assert.equal(out, 'k=<redacted> t=<redacted> p=<redacted>');
  assert.deepEqual(parseArgs(['--skip-live', '--min-rate', '0.9']).minRate, 0.9);
  assert.throws(() => parseArgs(['--bogus']), /Unknown argument/);
});

test('probes classify a fake Cloudflare/R2/Google/edge world without touching the network', async () => {
  const env = { CLOUDFLARE_API_TOKEN: 'cf-token-value', CLOUDFLARE_ACCOUNT_ID: 'acc1', GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'GOCSPX-secret-value', CELIA_MCP_API_TOKEN: 'o'.repeat(48), PHONE_NUMBER: '+201012345678' };
  const config = {
    gemini: {}, aiGateway: {}, deepseek: {}, agentrouter: {}, elevenlabs: {}, figma: {}, codata: {}, cronjob: {},
    cloudflare: { apiToken: env.CLOUDFLARE_API_TOKEN, accountId: 'acc1', baseUrl: 'https://api.cloudflare.com/client/v4' },
    cloudflareR2: { accessKeyId: 'AKID', secretAccessKey: 'SECRET', s3Endpoint: 'https://acc1.r2.cloudflarestorage.com' }
  };
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    seen.push([target, init.headers?.authorization ? 'auth' : 'anon']);
    const reply = (status, body, type = 'application/json') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });
    if (target.endsWith('/user/tokens/verify')) return reply(200, { success: true, result: { status: 'active' } });
    if (target.includes('/workers/scripts/')) return reply(200, { success: true });
    if (target.startsWith('https://acc1.r2.cloudflarestorage.com/')) {
      assert.match(init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/);
      return reply(403, '<Error><Code>AccessDenied</Code></Error>', 'application/xml');
    }
    if (target === 'https://oauth2.googleapis.com/token') {
      assert.equal(init.method, 'POST');
      assert.ok(String(init.body).includes('refresh_token=celia-reality-probe-not-a-token'));
      return reply(400, { error: 'invalid_grant' });
    }
    if (target.endsWith('/api/secrets/status')) return init.headers?.authorization ? reply(200, { configuredCount: 18, totalSecretsTracked: 18 }) : reply(401, { error: 'unauthorized' });
    if (target.endsWith('/readyz')) return reply(200, { ok: true, release: { version: '0.2.1', commit: 'abcdef1234567' } });
    if (target.endsWith('/version.json')) return reply(200, { version: '0.2.1', commit: 'abcdef1234567' });
    if (target.startsWith('https://ghcr.io/token')) return reply(200, { token: 'anon' });
    if (target.includes('/manifests/')) return reply(200, { schemaVersion: 2 });
    if (target.includes('/releases/tags/')) return reply(200, { assets: [{}, {}, {}, {}, {}] });
    throw new Error(`unexpected ${target}`);
  };
  const modules = {
    generateCeliaReply: async () => { throw new Error('must not be called without keys'); },
    probeCeliaVoice: async () => ({}), fetchFigmaProfile: async () => ({}), getCodataStatus: async () => ({}), getCronjobStatus: async () => ({}),
    planDeployment: () => ({ ok: false, missing: ['CELIA_LIVE_URL (repository variable)'] })
  };
  const publication = { edgeUrl: 'https://edge.example.workers.dev', staticSiteUrl: 'https://owner.github.io/repo/', containerImage: 'ghcr.io/owner/repo:v0.2.1', repository: 'owner/repo', workerScript: 'celia-phone-google' };
  const probes = buildProbes({ config, env, fetchImpl, timeoutMs: 5000, publication, version: '0.2.1', modules });
  const results = await runProbes(probes, { env, timeoutMs: 5000 });
  const byId = Object.fromEntries(results.map((entry) => [entry.id, entry]));
  assert.equal(byId.cloudflare_api.verdict, 'verified');
  assert.match(byId.cloudflare_api.detail, /worker script visible/);
  assert.equal(byId.cloudflare_r2.verdict, 'verified');
  assert.equal(byId.google_oauth_client.verdict, 'verified');
  assert.equal(byId.owner_token_edge.verdict, 'verified');
  assert.equal(byId.worker_edge_public.verdict, 'verified');
  assert.equal(byId.pages_static.verdict, 'verified');
  assert.equal(byId.ghcr_image.verdict, 'verified');
  assert.equal(byId.github_release.verdict, 'verified');
  assert.equal(byId.phone_number.verdict, 'verified');
  assert.equal(byId.render_backend.verdict, 'not-deployed');
  assert.equal(byId.gemini.verdict, 'not-configured');
  assert.equal(byId.whatsapp_cloud_api.verdict, 'not-configured');
  assert.equal(byId.google_workspace.verdict, 'unverifiable');
  const score = scoreServices(results);
  assert.equal(score.failed, 0);
  assert.equal(score.workingRate, 1);
  const markdown = renderMarkdown({ offline: { pass: 1, tests: 1, fail: 0, coverage: { lines: 90, branches: 80, functions: 85 } }, mysql: { ran: false, reason: 'none' }, live: results, score, minRate: 0.95, verdict: 'pass', verdictReason: 'ok' });
  assert.match(markdown, /working rate of configured services \*\*100%\*\*/);
  for (const value of ['cf-token-value', 'GOCSPX-secret-value', 'o'.repeat(48)]) assert.ok(!JSON.stringify(results).includes(value) && !markdown.includes(value), `${value} leaked`);
});

test('failure diagnostics name the broken secret (402 balance, wrong voice id, unreachable R2 host) without leaking values', async () => {
  const env = { DEEPSEEK_API_KEY: 'sk-deepseek-value', ELEVENLABS_API_KEY: 'xi-key-value', CELIA_VOICE_ID: 'voiceXYZ', CLOUDFLARE_ACCOUNT_ID: 'acc1', CLOUDFLARE_R2_ACCESS_KEY_ID: 'AKID', CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'r2-secret-value-77' };
  const config = {
    gemini: {}, aiGateway: {}, agentrouter: {}, figma: {}, codata: {}, cronjob: {}, cloudflare: { accountId: 'acc1' },
    deepseek: { apiKey: env.DEEPSEEK_API_KEY, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    elevenlabs: { apiKey: env.ELEVENLABS_API_KEY, voiceId: 'voiceXYZ', baseUrl: 'https://api.elevenlabs.io/v1' },
    cloudflareR2: { accessKeyId: 'AKID', secretAccessKey: 'r2-secret-value-77', s3Endpoint: 'https://typo-host.example.net' }
  };
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (target === 'https://api.deepseek.com/v1/models') return reply(200, { data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] });
    if (target === 'https://api.elevenlabs.io/v1/voices/voiceXYZ') return reply(400, { detail: { status: 'voice_not_found' } });
    if (target === 'https://api.elevenlabs.io/v1/user') return reply(200, { subscription: { tier: 'free' } });
    if (target === 'https://api.elevenlabs.io/v1/voices') return reply(200, { voices: [{ voice_id: 'other1' }, { voice_id: 'other2' }] });
    if (target.startsWith('https://typo-host.example.net/')) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    if (target.startsWith('https://acc1.r2.cloudflarestorage.com/')) return new Response('<Error><Code>InvalidAccessKeyId</Code></Error>', { status: 403, headers: { 'content-type': 'application/xml' } });
    throw new Error(`unexpected ${target}`);
  };
  const upstream = (service, status) => Object.assign(new Error(`${service} API rejected the request (${status})`), { upstreamStatus: status, code: 'UPSTREAM_ERROR' });
  const modules = {
    generateCeliaReply: async ({ provider }) => { throw upstream(provider, 402); },
    probeCeliaVoice: async () => { throw upstream('elevenlabs', 400); },
    fetchFigmaProfile: async () => ({}), getCodataStatus: async () => ({}), getCronjobStatus: async () => ({}), planDeployment: () => ({ ok: false, missing: ['x'] })
  };
  const probes = buildProbes({ config, env, fetchImpl, timeoutMs: 5000, publication: {}, version: '0.2.1', modules }).filter((probe) => ['deepseek', 'elevenlabs', 'cloudflare_r2'].includes(probe.id));
  const results = await runProbes(probes, { env, timeoutMs: 5000 });
  const byId = Object.fromEntries(results.map((entry) => [entry.id, entry]));
  assert.equal(byId.deepseek.verdict, 'failed');
  assert.match(byId.deepseek.detail, /payment required \/ no balance \(402\)/);
  assert.match(byId.deepseek.detail, /\/models 200 \(2 models, e\.g\. deepseek-chat, deepseek-reasoner; configured model listed\)/);
  assert.equal(byId.elevenlabs.verdict, 'failed');
  assert.match(byId.elevenlabs.detail, /GET \/voices\/\{CELIA_VOICE_ID\} → 400 \(voice_not_found\); API key valid \(\/user 200\)/);
  assert.match(byId.elevenlabs.detail, /2 voices visible, configured voice id NOT among them/);
  assert.equal(byId.cloudflare_r2.verdict, 'failed');
  assert.match(byId.cloudflare_r2.detail, /unreachable \(ENOTFOUND\)/);
  assert.match(byId.cloudflare_r2.detail, /canonical endpoint derived from CLOUDFLARE_ACCOUNT_ID answers \(failed: /);
  for (const value of ['sk-deepseek-value', 'xi-key-value', 'r2-secret-value-77']) assert.ok(!JSON.stringify(results).includes(value), `${value} leaked`);
});

test('service-reality workflow wires all 18 secrets, a real MySQL service, and never a Render/MySQL production credential', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/service-reality.yml'), 'utf8');
  for (const name of ['AGENETROUTERAPI_KEY', 'AI_GATEWAY_API_KEY', 'CELIAOS_CRONJOB_ORG_API_KEY', 'CELIA_MCP_API_TOKEN', 'CELIA_VOICE_ID', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_R2_ACCESS_KEY_ID', 'CLOUDFLARE_R2_S3_ENDPOINT', 'CLOUDFLARE_R2_SECRET_ACCESS_KEY', 'DEEPSEEK_API_KEY', 'ELEVENLABS_API_KEY', 'FIGMA_ACCESS_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'PHONE_NUMBER', 'YOUR_CODATA_API_KEY']) {
    assert.ok(workflow.includes(`\${{ secrets.${name} }}`), `${name} must be wired`);
  }
  assert.ok(workflow.includes('image: mysql:8.4'));
  assert.ok(workflow.includes("contains(github.event.head_commit.message, '[reality]')"));
  assert.ok(workflow.includes('contents: read'));
  assert.ok(!/MYSQL_PASSWORD:|MYSQL_SSL_CA_BASE64|TOKEN_ENCRYPTION_KEY/.test(workflow));
});
