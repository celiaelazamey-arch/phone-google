import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildKeepaliveJob, classifyDeployStatus, pickService, planDeployment, resolveLiveUrl, resolveService, sanitize } from '../scripts/deploy-render.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('planDeployment reports not-configured with the exact missing names when nothing is set', () => {
  const plan = planDeployment({});
  assert.equal(plan.ok, false);
  assert.equal(plan.mode, 'not-configured');
  assert.deepEqual(plan.missing, ['CELIA_LIVE_URL (Actions variable or secret)', 'RENDER_API_KEY (or RENDER_DEPLOY_HOOK_URL)']);
  assert.equal(plan.keepalive, false);
  assert.equal(plan.ownerChecks, false);
});

test('planDeployment prefers the Render API over the hook and keeps the expected commit', () => {
  const plan = planDeployment({
    CELIA_LIVE_URL: 'https://celia-phone-google.onrender.com/',
    RENDER_API_KEY: 'rnd_key',
    RENDER_SERVICE_ID: 'srv-123',
    RENDER_DEPLOY_HOOK_URL: 'https://api.render.com/deploy/srv-123?key=abc',
    GITHUB_SHA: 'abcdef0123456789',
    CELIA_MCP_API_TOKEN: 't'.repeat(64),
    CELIAOS_CRONJOB_ORG_API_KEY: 'cron'
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, 'render-api');
  assert.equal(plan.liveUrl, 'https://celia-phone-google.onrender.com');
  assert.equal(plan.expectCommit, 'abcdef0123456789');
  assert.equal(plan.ownerChecks, true);
  assert.equal(plan.keepalive, true);
});

test('planDeployment falls back to the deploy hook and rejects non-https URLs', () => {
  const hook = planDeployment({ CELIA_LIVE_URL: 'https://x.onrender.com', RENDER_DEPLOY_HOOK_URL: 'https://api.render.com/deploy/srv?key=k' });
  assert.equal(hook.mode, 'deploy-hook');
  const insecure = planDeployment({ CELIA_LIVE_URL: 'http://x.onrender.com', RENDER_DEPLOY_HOOK_URL: 'https://api.render.com/deploy/srv?key=k' });
  assert.equal(insecure.ok, false);
  assert.ok(insecure.missing.includes('CELIA_LIVE_URL must be an https URL'));
});

test('buildKeepaliveJob targets /readyz every 10 minutes with a stable per-host title', () => {
  const job = buildKeepaliveJob('https://celia-phone-google.onrender.com/');
  assert.equal(job.url, 'https://celia-phone-google.onrender.com/readyz');
  assert.equal(job.title, 'celia-keepalive:celia-phone-google.onrender.com');
  assert.equal(job.requestMethod, 0);
  assert.equal(job.enabled, true);
  assert.equal(job.saveResponses, false);
  assert.deepEqual(job.schedule.minutes, [0, 10, 20, 30, 40, 50]);
  assert.deepEqual(job.schedule.hours, [-1]);
  assert.equal(job.schedule.timezone, 'UTC');
});

test('classifyDeployStatus maps Render statuses to success/failure/pending', () => {
  assert.equal(classifyDeployStatus('live'), 'success');
  for (const status of ['build_failed', 'update_failed', 'pre_deploy_failed', 'canceled', 'deactivated']) {
    assert.equal(classifyDeployStatus(status), 'failure');
  }
  for (const status of ['created', 'queued', 'build_in_progress', 'update_in_progress', undefined]) {
    assert.equal(classifyDeployStatus(status), 'pending');
  }
});

test('sanitize removes every configured secret from printed text', () => {
  const env = { RENDER_API_KEY: 'rnd_supersecret_value', CELIA_MCP_API_TOKEN: 'a'.repeat(64), RENDER_DEPLOY_HOOK_URL: 'https://api.render.com/deploy/srv-1?key=hookkey', CELIAOS_CRONJOB_ORG_API_KEY: 'short' };
  const text = `key=rnd_supersecret_value token=${'a'.repeat(64)} hook=https://api.render.com/deploy/srv-1?key=hookkey cron=short`;
  const out = sanitize(text, env);
  assert.ok(!out.includes('rnd_supersecret_value'));
  assert.ok(!out.includes('a'.repeat(64)));
  assert.ok(!out.includes('hookkey'));
  assert.ok(out.includes('<RENDER_API_KEY>'));
  assert.ok(out.includes('<CELIA_MCP_API_TOKEN>'));
  assert.ok(out.includes('<RENDER_DEPLOY_HOOK_URL>'));
});

test('CLI --plan exits 0 without network and never prints secrets', () => {
  const env = { ...process.env, CELIA_LIVE_URL: '', CELIA_LIVE_URL_VAR: '', CELIA_LIVE_URL_SECRET: '', RENDER_API_KEY: 'rnd_do_not_print_me', RENDER_SERVICE_ID: '', RENDER_DEPLOY_HOOK_URL: '', CELIA_MCP_API_TOKEN: '', CELIAOS_CRONJOB_ORG_API_KEY: '', GITHUB_STEP_SUMMARY: '' };
  const result = spawnSync(process.execPath, ['scripts/deploy-render.mjs', '--plan'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('::notice title=Render Live Status::'));
  const json = JSON.parse(result.stdout.split('\n').filter((line) => !line.startsWith('::')).join('\n'));
  // An API key alone is a complete configuration: --plan must not call it missing, and must stay offline.
  assert.equal(json.status, 'planned');
  assert.equal(json.needsDiscovery, true);
  assert.deepEqual(json.missing, []);
  assert.ok(!result.stdout.includes('rnd_do_not_print_me'));
});

test('the live URL is accepted from an Actions variable or a secret — the first run looked at only one tab', () => {
  assert.equal(resolveLiveUrl({ CELIA_LIVE_URL: 'https://a.onrender.com/' }), 'https://a.onrender.com');
  assert.equal(resolveLiveUrl({ CELIA_LIVE_URL_VAR: 'https://b.onrender.com' }), 'https://b.onrender.com');
  assert.equal(resolveLiveUrl({ CELIA_LIVE_URL_SECRET: 'https://c.onrender.com' }), 'https://c.onrender.com');
  assert.equal(resolveLiveUrl({}), '');
  // The variable wins when both tabs hold a value, so an operator can override without deleting a secret.
  assert.equal(resolveLiveUrl({ CELIA_LIVE_URL_VAR: 'https://b.onrender.com', CELIA_LIVE_URL_SECRET: 'https://c.onrender.com' }), 'https://b.onrender.com');
});

test('an API key alone is enough: no service id and no URL have to be typed by hand', () => {
  const plan = planDeployment({ RENDER_API_KEY: 'rnd_key' });
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, 'render-api');
  assert.equal(plan.liveUrl, null);
  assert.equal(plan.needsDiscovery, true);
  const ready = planDeployment({ RENDER_API_KEY: 'rnd_key', CELIA_LIVE_URL_SECRET: 'https://celia-phone-google.onrender.com' });
  assert.equal(ready.needsDiscovery, true, 'the service id is still missing');
  assert.equal(ready.ok, true);
});

test('a malformed URL does not block discovery — the API supplies the truth instead of a guess', () => {
  // The owner stored a value that is not a URL at all (no scheme). With a key present it must be ignored,
  // not treated as a fatal misconfiguration: the service lookup can still find the real URL.
  const withKey = planDeployment({ RENDER_API_KEY: 'rnd_key', CELIA_LIVE_URL_SECRET: 'celia-phone-google.onrender.com' });
  assert.equal(withKey.ok, true);
  assert.equal(withKey.liveUrl, null);
  assert.equal(withKey.needsDiscovery, true);
  assert.match(withKey.warnings.join(' '), /not an https URL/);
  // Without a key there is nothing to fall back on, so it stays a hard error.
  const noKey = planDeployment({ CELIA_LIVE_URL_SECRET: 'celia-phone-google.onrender.com' });
  assert.equal(noKey.ok, false);
  assert.ok(noKey.missing.includes('CELIA_LIVE_URL must be an https URL'));
});

test('pickService resolves by name and refuses to guess between several services', () => {
  const payload = { services: [
    { service: { id: 'srv-1', name: 'celia-phone-google', serviceDetails: { url: 'https://celia-phone-google.onrender.com' } } },
    { service: { id: 'srv-2', name: 'something-else', serviceDetails: { url: 'https://other.onrender.com' } } }
  ] };
  assert.deepEqual(pickService(payload), { id: 'srv-1', name: 'celia-phone-google', url: 'https://celia-phone-google.onrender.com' });
  assert.deepEqual(pickService([{ id: 'srv-9', name: 'only', serviceDetails: { url: 'https://only.onrender.com' } }]), { id: 'srv-9', name: 'only', url: 'https://only.onrender.com' });
  assert.equal(pickService({ services: [] }), null);
  assert.equal(pickService({ services: payload.services.map((row) => row.service) }).id, 'srv-1', 'bare service objects work too');
  // Two unrelated services: refuse rather than deploy the wrong one.
  assert.equal(pickService({ services: [{ service: { id: 'a', name: 'x' } }, { service: { id: 'b', name: 'y' } }] }), null);
});

test('resolveService fills id and URL from the Render API with one authenticated call', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.authorization });
    return new Response(JSON.stringify({ services: [{ service: { id: 'srv-77', name: 'celia-phone-google', serviceDetails: { url: 'https://celia-phone-google.onrender.com/' } } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const plan = planDeployment({ RENDER_API_KEY: 'rnd_key' });
    const resolved = await resolveService({ RENDER_API_KEY: 'rnd_key' }, plan);
    assert.equal(resolved.serviceId, 'srv-77');
    assert.equal(resolved.liveUrl, 'https://celia-phone-google.onrender.com');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/services\?limit=100$/);
    assert.equal(calls[0].auth, 'Bearer rnd_key');
    // An already complete plan must not spend a call.
    const complete = { ...plan, serviceId: 'srv-1', liveUrl: 'https://x.onrender.com', needsDiscovery: false };
    assert.deepEqual(await resolveService({ RENDER_API_KEY: 'rnd_key' }, complete), complete);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('discovery names the services the key can see when the blueprint is missing', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ services: [
    { service: { id: 'srv-a', name: 'my-other-app', serviceDetails: { url: 'https://a.onrender.com' } } },
    { service: { id: 'srv-b', name: 'second-app' } }
  ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    await assert.rejects(
      () => resolveService({ RENDER_API_KEY: 'rnd_key' }, planDeployment({ RENDER_API_KEY: 'rnd_key' })),
      /render_service_not_found:celia-phone-google\(visible: my-other-app, second-app\)/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resolveService fails loudly instead of guessing', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ services: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    await assert.rejects(() => resolveService({ RENDER_API_KEY: 'rnd_key' }, planDeployment({ RENDER_API_KEY: 'rnd_key' })), /no services visible to this key/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('workflow deploy-render.yml only reads the documented inputs and is gated on CI success', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/deploy-render.yml'), 'utf8');
  assert.ok(workflow.includes("workflows: ['Celia quality & resilience']"));
  assert.ok(workflow.includes("github.event.workflow_run.conclusion == 'success'"));
  assert.ok(workflow.includes('contents: read'));
  for (const name of ['vars.CELIA_LIVE_URL', 'secrets.CELIA_LIVE_URL', 'secrets.RENDER_API_KEY', 'secrets.RENDER_SERVICE_ID', 'secrets.RENDER_DEPLOY_HOOK_URL', 'secrets.CELIA_MCP_API_TOKEN', 'secrets.CELIAOS_CRONJOB_ORG_API_KEY']) {
    assert.ok(workflow.includes(`\${{ ${name} }}`), `${name} must be wired`);
  }
  assert.ok(!/MYSQL_PASSWORD|MYSQL_SSL_CA_BASE64|TOKEN_ENCRYPTION_KEY/.test(workflow), 'database/encryption inputs stay in Render, never in GitHub');
});
