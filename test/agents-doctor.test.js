import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
