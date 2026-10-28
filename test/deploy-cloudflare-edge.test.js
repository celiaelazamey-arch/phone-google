// The edge deployer is the component that actually puts the Worker live. Its branches are tested here with an
// injected fetch/environment so no network call and no credential ever leaves the process.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../scripts/deploy-cloudflare-edge.mjs';

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body)
});

test('edge deploy: without credentials it prepares the bindings and stops at dry-run', async () => {
  const lines = [];
  await main({ argv: [], env: {}, log: (line) => lines.push(line) });
  const report = JSON.parse(lines[0]);
  assert.equal(report.status, 'dry-run');
  assert.equal(report.reason, 'missing_cloudflare_credentials');
  assert.equal(report.scriptName, 'celia-phone-google');
  assert.ok(report.totalSecretsTracked >= 18);
  assert.equal(report.secretBindingsPrepared, 0);
});

test('edge deploy: an explicit --dry-run with credentials still publishes nothing', async () => {
  const lines = [];
  await main({
    argv: ['--dry-run'],
    env: { CLOUDFLARE_ACCOUNT_ID: 'acc-1', CLOUDFLARE_API_TOKEN: 'token-1', CELIA_VOICE_ID: 'voice-1' },
    fetchImpl: async () => {
      throw new Error('network must not be touched in dry-run');
    },
    log: (line) => lines.push(line)
  });
  const report = JSON.parse(lines[0]);
  assert.equal(report.status, 'dry-run');
  assert.equal(report.reason, 'explicit_dry_run');
  // CELIA_VOICE_ID plus the two Cloudflare keys are all secrets the Worker receives.
  assert.equal(report.secretBindingsPrepared, 3);
});

test('edge deploy: a rejected upload reports the provider code, never the token', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'celia-edge-'));
  const summaryPath = path.join(directory, 'summary.md');
  const lines = [];
  const calls = [];
  await main({
    argv: [],
    env: {
      CLOUDFLARE_ACCOUNT_ID: 'acc-1',
      CLOUDFLARE_API_TOKEN: 'super-secret-token',
      GITHUB_STEP_SUMMARY: summaryPath
    },
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET' });
      if (url.includes('/workers/scripts/') && init.method === 'PUT') {
        return jsonResponse(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] });
      }
      return jsonResponse(200, { result: [] });
    },
    log: (line) => lines.push(line)
  });
  const report = JSON.parse(lines.at(-1));
  assert.equal(report.status, 'api-rejected');
  assert.equal(report.httpStatus, 403);
  assert.equal(report.errorCode, 10000);
  assert.equal(report.errorMessage, 'Authentication error');
  assert.ok(calls.length >= 2, 'the account-discovery retry must be attempted');
  const printed = lines.join('\n');
  assert.ok(!printed.includes('super-secret-token'), 'the API token must never be printed');
  const summary = await readFile(summaryPath, 'utf8');
  assert.match(summary, /api-rejected/);
});

test('edge deploy: a wrong account id is discovered and the upload retried once', async () => {
  const lines = [];
  let put = 0;
  await main({
    argv: [],
    env: { CLOUDFLARE_ACCOUNT_ID: 'stale-account', CLOUDFLARE_API_TOKEN: 'token-1' },
    fetchImpl: async (url, init = {}) => {
      if (url.includes('/accounts?') || url.endsWith('/accounts')) {
        return jsonResponse(200, { result: [{ id: 'right-account' }] });
      }
      if (init.method === 'PUT') {
        put += 1;
        return put === 1
          ? jsonResponse(403, { success: false, errors: [{ code: 7003, message: 'Could not route' }] })
          : jsonResponse(200, { success: true, result: {} });
      }
      if (url.endsWith('/subdomain')) return jsonResponse(200, { result: { subdomain: 'celia' } });
      if (url.endsWith('/readyz')) return jsonResponse(200, { ready: true });
      return jsonResponse(200, { result: {} });
    },
    log: (line) => lines.push(line)
  });
  const report = JSON.parse(lines.at(-1));
  assert.equal(report.status, 'deployed');
  assert.equal(report.workerUrl, 'https://celia-phone-google.celia.workers.dev');
  assert.equal(report.liveReady, true);
  assert.equal(put, 2);
});

test('edge deploy: a worker with no subdomain is deployed but claims no live URL', async () => {
  const lines = [];
  await main({
    argv: [],
    env: { CLOUDFLARE_ACCOUNT_ID: 'acc-1', CLOUDFLARE_API_TOKEN: 'token-1' },
    fetchImpl: async (url, init = {}) => {
      if (init.method === 'PUT') return jsonResponse(200, { success: true });
      if (url.endsWith('/subdomain')) return jsonResponse(200, { result: {} });
      return jsonResponse(200, { result: {} });
    },
    log: (line) => lines.push(line)
  });
  const report = JSON.parse(lines.at(-1));
  assert.equal(report.status, 'deployed');
  assert.equal(report.workerUrl, null);
  assert.equal(report.liveReady, false);
});

test('edge deploy: a failing /readyz probe keeps liveReady false instead of throwing', async () => {
  const lines = [];
  await main({
    argv: [],
    env: { CLOUDFLARE_ACCOUNT_ID: 'acc-1', CLOUDFLARE_API_TOKEN: 'token-1' },
    fetchImpl: async (url, init = {}) => {
      if (init.method === 'PUT') return jsonResponse(200, { success: true });
      if (url.endsWith('/subdomain')) return jsonResponse(200, { result: { subdomain: 'celia' } });
      if (url.endsWith('/readyz')) throw new Error('connection refused');
      return jsonResponse(200, { result: {} });
    },
    log: (line) => lines.push(line)
  });
  const report = JSON.parse(lines.at(-1));
  assert.equal(report.status, 'deployed');
  assert.equal(report.liveReady, false);
});

test('edge deploy: full D1 migration applies all 4 statements and records live /readyz storage durability', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'celia-edge-ok-'));
  const summaryPath = path.join(directory, 'summary.md');
  const lines = [];
  const queriedStatements = [];

  await main({
    argv: [],
    env: {
      CLOUDFLARE_ACCOUNT_ID: 'acc-1',
      CLOUDFLARE_API_TOKEN: 'token-1',
      GITHUB_STEP_SUMMARY: summaryPath
    },
    fetchImpl: async (url, init = {}) => {
      if (url.includes('/d1/database?')) {
        return jsonResponse(200, { success: true, result: [{ uuid: 'db-live-1', name: 'celia-edge-state' }] });
      }
      if (url.includes('/d1/database/db-live-1/query')) {
        const body = JSON.parse(init.body);
        queriedStatements.push(body.sql);
        return jsonResponse(200, { success: true, result: [{ success: true }] });
      }
      if (init.method === 'PUT') return jsonResponse(200, { success: true });
      if (url.endsWith('/subdomain')) return jsonResponse(200, { result: { subdomain: 'celia' } });
      if (url.endsWith('/readyz')) {
        return jsonResponse(200, {
          ok: true,
          ready: true,
          storage: { mode: 'd1', durable: true, durabilityVerifiedBy: 'this endpoint: write + read-back of a fresh token' }
        });
      }
      return jsonResponse(200, { result: {} });
    },
    log: (line) => lines.push(line)
  });

  const report = JSON.parse(lines.at(-1));
  assert.equal(report.status, 'deployed');
  assert.equal(report.d1.ok, true);
  assert.equal(report.d1.id, 'db-live-1');
  assert.equal(report.d1.migrations.statements, 4);
  assert.equal(queriedStatements.length, 4);
  assert.equal(queriedStatements.some((stmt) => stmt.includes('every statement is')), false);
  assert.equal(report.liveReady, true);
  assert.equal(report.storage?.durable, true);
  assert.equal(report.storage?.mode, 'd1');

  const summary = await readFile(summaryPath, 'utf8');
  assert.match(summary, /durable=true/);
  assert.match(summary, /db-live-1/);
});

test('edge deploy: when D1 exists but migration fails, warning honestly notes the binding was still applied', async () => {
  const lines = [];
  await main({
    argv: [],
    env: { CLOUDFLARE_ACCOUNT_ID: 'acc-1', CLOUDFLARE_API_TOKEN: 'token-1' },
    fetchImpl: async (url, init = {}) => {
      if (url.includes('/d1/database?')) {
        return jsonResponse(200, { success: true, result: [{ uuid: 'db-existing', name: 'celia-edge-state' }] });
      }
      if (url.includes('/d1/database/db-existing/query')) {
        return jsonResponse(400, { success: false, errors: [{ message: 'simulated_ddl_rejection' }] });
      }
      if (init.method === 'PUT') return jsonResponse(200, { success: true });
      if (url.endsWith('/subdomain')) return jsonResponse(200, { result: { subdomain: 'celia' } });
      if (url.endsWith('/readyz')) {
        return jsonResponse(200, { ready: true, storage: { mode: 'cloudflare-edge', durable: false, reason: 'd1_probe_failed:no such table: edge_heartbeat' } });
      }
      return jsonResponse(200, { result: {} });
    },
    retryDelayMs: 5,
    log: (line) => lines.push(line)
  });

  const report = JSON.parse(lines.at(-1));
  assert.equal(report.d1.ok, false);
  assert.equal(report.d1.bindingApplied, true);
  assert.equal(report.storage?.durable, false);
  const warningLine = lines.find((line) => line.startsWith('::warning title=Celia D1::')) || '';
  assert.match(warningLine, /binding applied/);
  assert.doesNotMatch(warningLine, /deploying without the binding/);
});
