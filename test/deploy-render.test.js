import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildKeepaliveJob, classifyDeployStatus, planDeployment, sanitize } from '../scripts/deploy-render.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('planDeployment reports not-configured with the exact missing names when nothing is set', () => {
  const plan = planDeployment({});
  assert.equal(plan.ok, false);
  assert.equal(plan.mode, 'not-configured');
  assert.deepEqual(plan.missing, ['CELIA_LIVE_URL (repository variable)', 'RENDER_API_KEY + RENDER_SERVICE_ID (or RENDER_DEPLOY_HOOK_URL)']);
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
  const env = { ...process.env, CELIA_LIVE_URL: '', RENDER_API_KEY: 'rnd_do_not_print_me', RENDER_SERVICE_ID: '', RENDER_DEPLOY_HOOK_URL: '', CELIA_MCP_API_TOKEN: '', CELIAOS_CRONJOB_ORG_API_KEY: '', GITHUB_STEP_SUMMARY: '' };
  const result = spawnSync(process.execPath, ['scripts/deploy-render.mjs', '--plan'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('::notice title=Render Live Status::'));
  const json = JSON.parse(result.stdout.split('\n').filter((line) => !line.startsWith('::')).join('\n'));
  assert.equal(json.status, 'not-configured');
  assert.ok(json.missing.includes('CELIA_LIVE_URL (repository variable)'));
  assert.ok(!result.stdout.includes('rnd_do_not_print_me'));
});

test('workflow deploy-render.yml only reads the documented inputs and is gated on CI success', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/deploy-render.yml'), 'utf8');
  assert.ok(workflow.includes("workflows: ['Celia quality & resilience']"));
  assert.ok(workflow.includes("github.event.workflow_run.conclusion == 'success'"));
  assert.ok(workflow.includes('contents: read'));
  for (const name of ['vars.CELIA_LIVE_URL', 'secrets.RENDER_API_KEY', 'secrets.RENDER_SERVICE_ID', 'secrets.RENDER_DEPLOY_HOOK_URL', 'secrets.CELIA_MCP_API_TOKEN', 'secrets.CELIAOS_CRONJOB_ORG_API_KEY']) {
    assert.ok(workflow.includes(`\${{ ${name} }}`), `${name} must be wired`);
  }
  assert.ok(!/MYSQL_PASSWORD|MYSQL_SSL_CA_BASE64|TOKEN_ENCRYPTION_KEY/.test(workflow), 'database/encryption inputs stay in Render, never in GitHub');
});
