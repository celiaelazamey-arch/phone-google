import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/google-doctor.mjs', import.meta.url));
const emptyWorkDir = mkdtempSync(path.join(tmpdir(), 'celia-google-doctor-'));
test.after(() => rmSync(emptyWorkDir, { recursive: true, force: true }));

const syntheticSecret = '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1234567890';
const completeEnv = {
  PORT: '3000',
  APP_BASE_URL: 'https://assistant.example.com',
  APP_API_TOKEN: 'doctor-cli-api-token-with-at-least-32-characters',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString('base64'),
  APP_OWNER_EMAIL: 'owner@example.com',
  APP_OWNER_PHONE_E164: '+201234567890',
  GOOGLE_CLIENT_ID: '123456789012-abcdefghijklmnop.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: syntheticSecret,
  GOOGLE_REDIRECT_URI: 'https://assistant.example.com/auth/google/callback',
  CELIA_DISABLE_GOOGLE: 'false'
};

function runDoctor(args = [], overrides = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: emptyWorkDir,
    env: { ...completeEnv, ...overrides },
    encoding: 'utf8'
  });
}

function assertNoSecrets(output) {
  assert.equal(output.includes(syntheticSecret), false);
  assert.equal(output.includes(completeEnv.APP_API_TOKEN), false);
  assert.equal(output.includes(completeEnv.TOKEN_ENCRYPTION_KEY), false);
}

test('GOOG-002: doctor --json emits only parseable JSON on success', () => {
  const result = runDoctor(['--json']);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.summary.fail, 0);
  assert.equal(result.stdout.includes('Google connection preflight'), false);
  assertNoSecrets(result.stdout);
});

test('GOOG-002: doctor --json stays parseable and exits 1 on a blocking check', () => {
  const result = runDoctor(['--json'], { APP_OWNER_EMAIL: '' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((item) => item.id === 'owner_email').status, 'fail');
  assertNoSecrets(result.stdout);
});

test('GOOG-002: the default doctor output remains a sanitized human report', () => {
  const result = runDoctor();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Google connection preflight/);
  assert.match(result.stdout, /Preflight is clean enough/);
  assert.match(result.stdout, /npm run --silent google:doctor -- --json/);
  assertNoSecrets(result.stdout);
});
