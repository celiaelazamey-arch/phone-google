import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/measure-completion.mjs');

function run(...args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
}

test('MEAS-01 emits twelve repository-derived indicators deterministically and keeps external gates separate', () => {
  const first = run();
  const second = run();
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.equal(first.stderr, '');
  assert.equal(first.stdout, second.stdout, 'no clock, random value, or network result may enter the report');

  const rows = first.stdout.split('\n').filter((line) => /^\|\s*\d+\s*\|/.test(line));
  assert.equal(rows.length, 12);
  assert.match(first.stdout, /اتساق الخطة: PASS/);
  assert.match(first.stdout, /معايير B1 وB2 وCMAT.*لا تُستنتج من وجود الشيفرة/);
  assert.match(first.stdout, /لا يُستعلم GitHub.*بيانات الإنتاج/);
  assert.match(first.stdout, /تضارب F4 غير محسوم: المجموع المعلن 1\.5\/6، ومجموع صفوف L1–L6 هو 2\/6/);
});

test('MEAS-02 JSON names the twelve indicators and reports, but does not decide, the F4 conflict', () => {
  const result = run('--json');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.scope, 'repository-derived-only');
  assert.equal(report.metricCount, 12);
  assert.deepEqual(report.metrics.map((metric) => metric.id), [
    'plan_integrity', 'open_tasks', 'waves', 'grants', 'agent_tools', 'mcp_tools',
    'version', 'dependencies', 'coverage_floor', 'syntax_files', 'continuity', 'runtime_defaults'
  ]);
  assert.equal(report.planIntegrity.ok, true);
  assert.deepEqual(report.diagnostics.f4, { status: 'conflict', declared: 1.5, tableSum: 2, layers: 6 });
  assert.equal(report.notMeasured.length, 2);
});
