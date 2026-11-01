import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATES = ['works', 'partial', 'not_configured', 'blocked', 'broken'];
const REQUIRED = [
  'runtime-loop',
  'tool-registry',
  'kb-search',
  'web-fetch',
  'google-read',
  'approval-gate',
  'sandbox',
  'delegation',
  'memory-consolidation',
  'attention',
  'issue-triage',
  'planner-llm',
  'model-router',
  'mcp-surface'
];

test('AD-01: agents:doctor runs every agent check and reports only named states', () => {
  const child = spawnSync(process.execPath, ['scripts/agents-doctor.mjs', '--json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 240_000
  });
  const text = String(child.stdout || '');
  const start = text.indexOf('{');
  assert.ok(start >= 0, `no JSON on stdout: ${child.stderr?.slice(0, 400)}`);
  const report = JSON.parse(text.slice(start));

  assert.equal(report.version, 'agents-doctor-v1');
  assert.equal(report.checks.length, REQUIRED.length, 'the doctor reports exactly the declared checks');
  const ids = report.checks.map((entry) => entry.id);
  for (const id of REQUIRED) assert.ok(ids.includes(id), `missing check ${id}`);

  for (const entry of report.checks) {
    assert.ok(STATES.includes(entry.status), `${entry.id}: unknown state ${entry.status}`);
    assert.ok(entry.ar && entry.ar.length > 0, `${entry.id}: no Arabic label`);
    assert.ok(typeof entry.detail === 'string' && entry.detail.length > 0, `${entry.id}: no detail`);
  }

  const broken = report.checks.filter((entry) => entry.status === 'broken');
  assert.equal(report.summary.broken, broken.length, 'the summary counts what the checks found');
  assert.equal(child.status, broken.length === 0 ? 0 : 1, 'exit code follows the broken count');
});

test('AD-02: the doctor prints a human table with one line per check', () => {
  const child = spawnSync(process.execPath, ['scripts/agents-doctor.mjs'], { cwd: root, encoding: 'utf8', timeout: 240_000 });
  const lines = String(child.stdout || '').split('\n');
  assert.match(child.stdout, /فحص وكلاء المستودع/);
  assert.match(child.stdout, /الإجمالي:/);
  const rows = lines.filter((line) => /^(🟢|🟡|⚪|⛔|🔴)/.test(line.trim()));
  assert.equal(rows.length, REQUIRED.length, 'one row per check, no silent gaps');
});

const runDoctor = (extraArgs = [], env = {}) => {
  const child = spawnSync(process.execPath, ['scripts/agents-doctor.mjs', ...extraArgs], {
    cwd: root,
    encoding: 'utf8',
    timeout: 240_000,
    env: { ...process.env, ...env }
  });
  return child;
};

const parseJson = (child) => {
  const text = String(child.stdout || '');
  const start = text.indexOf('{');
  assert.ok(start >= 0, `no JSON on stdout: ${child.stderr?.slice(0, 400)}`);
  return JSON.parse(text.slice(start));
};

const tempEnvFile = (values) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agents-doctor-env-'));
  const file = path.join(directory, '.env');
  writeFileSync(file, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n'));
  return { directory, file };
};

test('AD-03: --setup derives the connect runbook from the code and prints no secret', () => {
  const json = runDoctor(['--setup', '--json']);
  assert.equal(json.status, 0);
  const setup = parseJson(json);
  assert.equal(setup.version, 'agents-doctor-setup-v1');
  assert.deepEqual(setup.derivedFrom, ['src/google-preflight.js', 'src/config.js']);
  assert.match(setup.google.redirectUri, /\/auth\/google\/callback$/);
  assert.ok(setup.google.envNames.includes('GOOGLE_CLIENT_ID'));
  assert.equal(setup.google.consentPath, '/auth/google');
  assert.match(setup.google.verifyCommand, /google:doctor/);
  assert.match(setup.recheckCommand, /agents:doctor/);
  assert.equal(setup.ai.defaultModel.length > 0, true);

  const text = runDoctor(['--setup']);
  assert.match(text.stdout, /خطة التوصيل/);
  assert.match(text.stdout, /Authorized redirect URI/);
});

test('AD-04: --env-file changes the verdicts and never echoes a value', () => {
  const secret = 'placeholder-client-secret-value-0001';
  const gemini = 'gemini-test-key-that-is-long-enough-0001';
  const { directory, file } = tempEnvFile({
    GOOGLE_CLIENT_ID: 'placeholder-client-id-0001.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: secret,
    TOKEN_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    APP_API_TOKEN: '0123456789abcdef0123456789abcdef',
    APP_OWNER_EMAIL: 'owner@example.com',
    APP_BASE_URL: 'https://celia.example.com',
    GEMINI_API_KEY: gemini
  });
  try {
    const child = runDoctor(['--env-file', file, '--json']);
    const report = parseJson(child);
    const google = report.checks.find((entry) => entry.id === 'google-read');
    const planner = report.checks.find((entry) => entry.id === 'planner-llm');
    assert.equal(google.evidence.oauthConfigured, true, 'the real preflight sees the credentials');
    assert.deepEqual(google.evidence.blockingChecks, []);
    assert.equal(planner.status, 'works', 'a present key builds the provider');
    assert.equal(report.checks.some((entry) => entry.status === 'broken'), false);
    const combined = `${child.stdout}${child.stderr}`;
    assert.equal(combined.includes(secret), false, 'the client secret never reaches stdout/stderr');
    assert.equal(combined.includes(gemini), false, 'the provider key never reaches stdout/stderr');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('AD-05: --write-baseline/--baseline compares runs and --fail-on-regression exits 1', () => {
  // Pin the AI provider names empty so the expected state does not depend on the host's .env.
  const pinned = { GEMINI_API_KEY: '', AI_GATEWAY_API_KEY: '', DEEPSEEK_API_KEY: '', AGENETROUTERAPI_KEY: '', AGENTROUTER_API_KEY: '' };
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agents-doctor-baseline-'));
  const baseline = path.join(directory, 'baseline.json');
  try {
    const first = runDoctor(['--json', '--write-baseline', baseline], pinned);
    assert.equal(first.status, 0);
    const written = JSON.parse(readFileSync(baseline, 'utf8'));
    assert.equal(written.version, 'agents-doctor-v1');
    assert.equal(written.checks.length, REQUIRED.length);

    const same = parseJson(runDoctor(['--json', '--baseline', baseline], pinned));
    assert.equal(same.comparison.regressed.length, 0);
    assert.equal(same.comparison.unchanged, REQUIRED.length);

    // A baseline claiming a check that is not configured here was working is a regression.
    const doctored = {
      version: 'agents-doctor-v1',
      generatedAt: '2026-01-01T00:00:00.000Z',
      checks: written.checks.map((entry) => ({ id: entry.id, status: entry.id === 'planner-llm' ? 'works' : entry.status }))
    };
    writeFileSync(baseline, JSON.stringify(doctored));
    const regressed = parseJson(runDoctor(['--json', '--baseline', baseline], pinned));
    const planner = regressed.comparison.regressed.find((entry) => entry.id === 'planner-llm');
    assert.ok(planner, 'the drop from works to not_configured is reported by name');
    assert.equal(planner.was, 'works');
    assert.equal(planner.now, 'not_configured');

    const strict = runDoctor(['--baseline', baseline, '--fail-on-regression'], pinned);
    assert.equal(strict.status, 1, 'the strict flag turns a regression into a failure');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
