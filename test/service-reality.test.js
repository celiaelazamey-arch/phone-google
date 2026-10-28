import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildProbes,
  classifyGoogleTokenResponse,
  classifyS3Response,
  editDistance,
  parseArgs,
  parseTestSummary,
  probeWhatsAppCloudApi,
  renderMarkdown,
  runProbes,
  sanitize,
  scoreServices,
  signAwsV4
} from '../scripts/service-reality.mjs';
import { applyRetirementsToEnv, loadServiceRetirements, normalizeRetirements, retirementFlags } from '../src/service-retirements.js';
import { buildWorkerMetadata } from '../scripts/deploy-cloudflare-edge.mjs';
import { buildEdgeSecretsReport } from '../workers/celia-edge/worker.js';

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

test('WhatsApp read-only probe authenticates the phone-number ID and never sends a message', async () => {
  const env = {
    WHATSAPP_ACCESS_TOKEN: 'meta-access-token-test',
    WHATSAPP_PHONE_NUMBER_ID: '123456789012345',
    WHATSAPP_APP_SECRET: 'meta-app-secret-test',
    WHATSAPP_VERIFY_TOKEN: 'meta-verify-token-test',
    WHATSAPP_API_VERSION: 'v26.0'
  };
  const calls = [];
  const result = await probeWhatsAppCloudApi({
    env,
    timeoutMs: 1000,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || 'GET', authorization: init.headers?.authorization });
      return new Response(JSON.stringify({ id: env.WHATSAPP_PHONE_NUMBER_ID, display_phone_number: '+15551234567', verified_name: 'Celia Test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  assert.equal(result.verdict, 'verified');
  assert.match(result.detail, /read-only phone-number lookup passed/);
  assert.match(result.detail, /no message sent/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].url, /^https:\/\/graph\.facebook\.com\/v26\.0\/123456789012345\?/);
  assert.equal(calls[0].authorization, 'Bearer meta-access-token-test');
  assert.equal(JSON.stringify(result).includes('meta-access-token-test'), false);
});

test('WhatsApp read-only probe refuses malformed configuration and never calls Meta', async () => {
  let calls = 0;
  const missing = await probeWhatsAppCloudApi({ env: {}, fetchImpl: async () => { calls += 1; throw new Error('unexpected_network_call'); } });
  assert.equal(missing.verdict, 'not-configured');
  const invalidId = await probeWhatsAppCloudApi({
    env: { WHATSAPP_ACCESS_TOKEN: 'meta-access-token-test', WHATSAPP_PHONE_NUMBER_ID: '+201012345678' },
    fetchImpl: async () => { calls += 1; throw new Error('unexpected_network_call'); }
  });
  assert.equal(invalidId.verdict, 'failed');
  assert.match(invalidId.detail, /numeric Meta phone-number ID/);
  assert.equal(calls, 0);
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
    if (target.endsWith('/readyz')) return reply(200, { ok: true, release: { version: '0.2.1', commit: 'abcdef1234567' }, storage: { mode: 'd1', durable: true } });
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
  assert.match(byId.worker_edge_public.detail, /storage d1 \(durable=true\)/);
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
    if (target === 'https://api.elevenlabs.io/v1/voices') return reply(200, { voices: [{ voice_id: 'other1', name: 'Aria' }, { voice_id: 'other2', name: 'Roger' }] });
    if (target === 'https://api.elevenlabs.io/v1/text-to-speech/other1') {
      assert.equal(init.method, 'POST');
      assert.equal(JSON.parse(init.body).text, 'اختبار');
      return new Response(new Uint8Array(1200), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }
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
  assert.match(byId.elevenlabs.detail, /GET \/voices\/\{CELIA_VOICE_ID\} → 400 \(voice_not_found\); configured id: 8 chars.*?; API key valid \(\/user 200\)/);
  assert.match(byId.elevenlabs.detail, /configured id: 8 chars — ElevenLabs voice ids are 20 alphanumeric characters/);
  assert.match(byId.elevenlabs.detail, /configured id is not close to any visible id \(nearest: (Aria|Roger), \d+ edits\) — check that the \*repository secret\* CELIA_VOICE_ID/);
  assert.equal(editDistance('AnsOWV53Mdx5fcIanRBB', 'AnsOWV53Mdx5fcIanRBB'), 0);
  assert.equal(editDistance('AnsOWV53Mdx5fcIanRBB', 'AnsOWV53Mdx5fcIanRBb'), 1);
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.match(byId.elevenlabs.detail, /2 voices visible, configured voice id NOT among them — a library or cloned voice must first be added to "My Voices"[^(]*\(visible: Aria=other1, Roger=other2\)/);
  assert.match(byId.elevenlabs.detail, /key CAN synthesize with visible voice Aria \(1200 bytes\) → only CELIA_VOICE_ID needs fixing/);
  assert.equal(byId.cloudflare_r2.verdict, 'failed');
  assert.match(byId.cloudflare_r2.detail, /unreachable \(ENOTFOUND\)/);
  assert.match(byId.cloudflare_r2.detail, /canonical endpoint derived from CLOUDFLARE_ACCOUNT_ID answers \(failed: /);
  for (const value of ['sk-deepseek-value', 'xi-key-value', 'r2-secret-value-77']) assert.ok(!JSON.stringify(results).includes(value), `${value} leaked`);
});

test('an owner-retired service is reported as disabled and excluded from the working rate', async () => {
  const env = { AI_GATEWAY_API_KEY: 'gw-key-value', CELIA_DISABLE_AI_GATEWAY: 'true' };
  const config = { gemini: {}, deepseek: {}, agentrouter: {}, elevenlabs: {}, figma: {}, codata: {}, cronjob: {}, cloudflare: {}, cloudflareR2: {}, aiGateway: { apiKey: env.AI_GATEWAY_API_KEY, baseUrl: 'https://ai-gateway.vercel.sh/v1', model: 'google/gemini-2.5-flash' }, features: { ai_gateway: false } };
  const modules = { generateCeliaReply: async () => { throw new Error('must not be called for a retired service'); }, probeCeliaVoice: async () => ({}), fetchFigmaProfile: async () => ({}), getCodataStatus: async () => ({}), getCronjobStatus: async () => ({}), planDeployment: () => ({ ok: false, missing: ['x'] }) };
  const probes = buildProbes({ config, env, fetchImpl: async () => { throw new Error('offline'); }, timeoutMs: 1000, publication: {}, version: '0.2.1', modules }).filter((probe) => ['ai_gateway', 'deepseek'].includes(probe.id));
  const results = await runProbes(probes, { env, timeoutMs: 1000, features: config.features });
  const byId = Object.fromEntries(results.map((entry) => [entry.id, entry]));
  assert.equal(byId.ai_gateway.verdict, 'disabled');
  assert.match(byId.ai_gateway.detail, /CELIA_DISABLE_AI_GATEWAY=true/);
  assert.equal(byId.deepseek.verdict, 'not-configured');
  const score = scoreServices(results);
  assert.equal(score.disabled, 1);
  assert.equal(score.configured, 0);
  assert.equal(score.workingRate, null);
});

test('retirement manifest: validated, reversible, and told identically by the audit, the Worker bindings/report and render.yaml', () => {
  const retirements = loadServiceRetirements();
  assert.deepEqual(Object.keys(retirements).sort(), ['agentrouter', 'ai_gateway', 'cloudflare_r2', 'deepseek']);
  for (const entry of Object.values(retirements)) {
    assert.match(entry.evidence, /run 40646881277/);
    assert.equal(entry.decision, 'DEC-030');
    assert.ok(entry.reversal.length > 20, 'every retirement states how to undo it');
  }
  assert.throws(() => normalizeRetirements({ nope: { reason: 'x', decidedOn: '2026-10-28' } }), /unknown feature "nope"/);
  assert.throws(() => normalizeRetirements({ figma: { reason: '', decidedOn: '2026-10-28' } }), /reason is required/);
  assert.throws(() => normalizeRetirements({ figma: { reason: 'dead', decidedOn: 'yesterday' } }), /YYYY-MM-DD/);
  // environment wins only when it says something
  const env = applyRetirementsToEnv({ CELIA_DISABLE_DEEPSEEK: 'false', CELIA_DISABLE_AI_GATEWAY: '' }, retirements);
  assert.equal(env.CELIA_DISABLE_DEEPSEEK, 'false');
  assert.equal(env.CELIA_DISABLE_AI_GATEWAY, 'true');
  assert.equal(env.CELIA_DISABLE_CLOUDFLARE_R2, 'true');
  // Worker deploy carries the flags as plain_text bindings; secret_text bindings are untouched
  const metadata = buildWorkerMetadata({ env: { AI_GATEWAY_API_KEY: 'k' }, version: '0.2.1', commit: 'abc', retirements });
  const flags = metadata.bindings.filter((b) => b.type === 'plain_text' && b.name.startsWith('CELIA_DISABLE_')).map((b) => b.name).sort();
  assert.deepEqual(flags, Object.keys(retirementFlags(retirements)).sort());
  assert.equal(metadata.bindings.filter((b) => b.type === 'secret_text').length, 1);
  // Worker report marks the retired boundaries without pretending the secrets vanished
  const report = buildEdgeSecretsReport({ AI_GATEWAY_API_KEY: 'k', CLOUDFLARE_R2_ACCESS_KEY_ID: 'a', CLOUDFLARE_R2_SECRET_ACCESS_KEY: 's', CLOUDFLARE_R2_S3_ENDPOINT: 'https://x.r2.cloudflarestorage.com', ...retirementFlags(retirements) });
  assert.deepEqual(report.retiredServices.sort(), ['agentrouter', 'ai_gateway', 'cloudflare_r2', 'deepseek']);
  assert.equal(report.configuredCount, 4);
  assert.equal(report.secrets.find((s) => s.secretName === 'AI_GATEWAY_API_KEY').retired, true);
  assert.equal(report.secrets.find((s) => s.secretName === 'GEMINI_API_KEY').retired, false);
  // render.yaml blueprint defaults must match the manifest exactly (no silent drift either way)
  const blueprint = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');
  const blueprintFlags = [...blueprint.matchAll(/- key: (CELIA_DISABLE_[A-Z0-9_]+)\n\s+value: 'true'/g)].map((m) => m[1]).filter((flag) => flag !== 'CELIA_DISABLE_OLLAMA').sort();
  assert.deepEqual(blueprintFlags, Object.keys(retirementFlags(retirements)).sort());
});

test('service-reality workflow wires existing secrets plus optional WhatsApp credentials, and never a Render/MySQL production credential', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/service-reality.yml'), 'utf8');
  for (const name of ['AGENETROUTERAPI_KEY', 'AI_GATEWAY_API_KEY', 'CELIAOS_CRONJOB_ORG_API_KEY', 'CELIA_MCP_API_TOKEN', 'CELIA_VOICE_ID', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_R2_ACCESS_KEY_ID', 'CLOUDFLARE_R2_S3_ENDPOINT', 'CLOUDFLARE_R2_SECRET_ACCESS_KEY', 'DEEPSEEK_API_KEY', 'ELEVENLABS_API_KEY', 'FIGMA_ACCESS_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'PHONE_NUMBER', 'YOUR_CODATA_API_KEY', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN']) {
    assert.ok(workflow.includes(`\${{ secrets.${name} }}`), `${name} must be wired`);
  }
  assert.ok(workflow.includes('WHATSAPP_API_VERSION: ${{ vars.WHATSAPP_API_VERSION }}'));
  const renderBlueprint = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');
  for (const name of ['APP_OWNER_PHONE_E164', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_API_VERSION']) {
    assert.ok(renderBlueprint.includes(`- key: ${name}`), `${name} must be declared for the runtime`);
  }
  assert.ok(renderBlueprint.includes("- key: WHATSAPP_AUTO_REPLY_ENABLED\n        value: 'false'"), 'auto replies stay disabled until separately approved');
  assert.ok(workflow.includes('image: mysql:8.4'));
  assert.ok(workflow.includes("contains(github.event.head_commit.message, '[reality]')"));
  assert.ok(workflow.includes('contents: read'));
  // Preservation cadence (DEC-031): weekly schedule, one tracking issue on main only, never on feature pushes.
  assert.match(workflow, /schedule:\n\s+- cron: '0 6 \* \* 1'/);
  assert.ok(workflow.includes('issues: write'));
  assert.match(workflow, /github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch' \|\| contains\(github\.event\.head_commit\.message, '\[reality\]'\)/);
  assert.match(workflow, /if: always\(\) && github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'\)[^\n]*\n\s+env:\n\s+GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.ok(workflow.includes('run: node scripts/reality-notify.mjs'));
  const quality = fs.readFileSync(path.join(root, '.github/workflows/celia-mcp.yml'), 'utf8');
  assert.ok(quality.includes('npm run test:coverage'), 'CI enforces the coverage floor');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['test:coverage'], /--test-coverage-lines=89 --test-coverage-branches=71 --test-coverage-functions=82/);
  assert.ok(!/MYSQL_PASSWORD:|MYSQL_SSL_CA_BASE64|TOKEN_ENCRYPTION_KEY/.test(workflow));
  for (const flag of ['AI_GATEWAY', 'DEEPSEEK', 'AGENTROUTER', 'ELEVENLABS', 'FIGMA', 'CODATA', 'CLOUDFLARE_R2']) {
    assert.ok(workflow.includes(`CELIA_DISABLE_${flag}: \${{ vars.CELIA_DISABLE_${flag} }}`), `${flag} retirement switch missing`);
  }
});
