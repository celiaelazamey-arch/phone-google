import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONSOLIDATION_VERSION,
  STATUS,
  checkReport,
  consolidate,
  describeConsolidation
} from '../src/agent/consolidation.js';

const claim = (subject, value, sourceId, extra = {}) => ({ subject, predicate: 'value', value, sourceId, trust: 'T1', ...extra });

test('duplicate assertions of one value collapse, and every source survives', () => {
  const report = consolidate([
    claim('العملة', 'SAR', 'doc-a'),
    claim('العملة', 'sar', 'doc-b'),
    claim('العملة', ' SAR ', 'doc-c')
  ]);
  assert.equal(report.groups, 1);
  assert.equal(report.endorsed, 1);
  assert.equal(report.collapsed, 2);
  const [group] = report.groupsList;
  assert.equal(group.status, STATUS.endorsed);
  assert.deepEqual(group.sources, ['doc-a', 'doc-b', 'doc-c'], 'no source may be dropped when duplicates merge');
  assert.equal(group.values[0].sourceCount, 3);
  assert.deepEqual(group.values[0].raw.sort(), ['SAR', 'sar'], 'each spelling is kept verbatim; surrounding spaces are not spelling');
});

test('disagreeing values stay side by side, contested and unresolved', () => {
  const report = consolidate([
    claim('موعد الإطلاق', '15 نوفمبر', 'drive'),
    claim('موعد الإطلاق', '20 نوفمبر', 'docs'),
    claim('موعد الإطلاق', '15 نوفمبر', 'mail')
  ]);
  assert.equal(report.contested, 1);
  assert.equal(report.resolution, 'unresolved');
  const [group] = report.groupsList;
  assert.equal(group.status, STATUS.contested);
  assert.equal(group.resolution, 'unresolved');
  assert.equal(group.values.length, 2);
  assert.equal(group.values[0].normalized, '15 نوفمبر', 'the better-attested value is listed first…');
  assert.equal(group.values[0].sourceCount, 2);
  assert.ok(!('winner' in group) && !('preferred' in group), '…and is still not chosen');
  assert.deepEqual(group.sources, ['docs', 'drive', 'mail'], 'both sides are named');
});

test('nothing is lost: every admitted claim is reachable in the output', () => {
  const claims = [
    claim('أ', '1', 's1'),
    claim('أ', '1', 's2'),
    claim('أ', '2', 's3'),
    claim('ب', 'x', 's4'),
    claim('ج', '7', 's5'),
    { subject: '', value: 'orphan' },
    { subject: 'ناقص', value: '' }
  ];
  const report = consolidate(claims);
  assert.equal(report.claims, 7);
  assert.equal(report.rejected, 2);
  assert.equal(report.retained, 5, 'five admitted claims, five still reachable');
  assert.deepEqual(checkReport(report), { ok: true, problems: [] });
});

test('the view is deterministic and its digest can be quoted', () => {
  const claims = [claim('العملة', 'SAR', 'a'), claim('المدينة', 'القاهرة', 'b'), claim('العملة', 'SAR', 'c')];
  const one = consolidate(claims);
  const two = consolidate([...claims].reverse());
  assert.equal(one.digest, two.digest, 'input order must not change the report');
  assert.match(one.digest, /^[a-f0-9]{12}$/);
  assert.equal(one.version, CONSOLIDATION_VERSION);
  assert.equal(one.mutatesData, false);
  assert.equal(one.deletesData, false);
  const changed = consolidate([...claims, claim('العملة', 'USD', 'd')]);
  assert.notEqual(changed.digest, one.digest);
});

test('a forged report is refused: no silent resolution, no lost source, no edit left unseen', () => {
  const report = consolidate([claim('العملة', 'SAR', 'a'), claim('العملة', 'USD', 'b')]);

  const resolved = JSON.parse(JSON.stringify(report));
  resolved.groupsList[0].resolution = 'latest_wins';
  const resolvedCheck = checkReport(resolved);
  assert.equal(resolvedCheck.ok, false);
  assert.ok(resolvedCheck.problems.some((problem) => problem.includes('must stay unresolved')));

  const dropped = JSON.parse(JSON.stringify(report));
  dropped.groupsList[0].values[1].sources = [];
  const droppedCheck = checkReport(dropped);
  assert.equal(droppedCheck.ok, false);
  assert.ok(droppedCheck.problems.some((problem) => problem.includes('claims lost')), droppedCheck.problems.join('; '));

  const mutated = JSON.parse(JSON.stringify(report));
  mutated.deletesData = true;
  assert.equal(checkReport(mutated).ok, false);

  const edited = JSON.parse(JSON.stringify(report));
  edited.groupsList[0].values[0].normalized = 'EGP';
  assert.ok(checkReport(edited).problems.includes('digest does not match the report'), 'an edited value must break the digest');
});

test('numbers are compared as numbers, units included', () => {
  const same = consolidate([claim('المسافة', '٤٢ كم', 'a'), claim('المسافة', '42كم', 'b'), claim('المسافة', '42.0 كم', 'c')]);
  assert.equal(same.groups, 1);
  assert.equal(same.endorsed, 1);

  const units = consolidate([claim('المسافة', '42 km', 'a'), claim('المسافة', '42 kg', 'b')]);
  assert.equal(units.contested, 1, 'a different unit is a different claim');
});

test('a predicate separates questions instead of merging them', () => {
  const report = consolidate([
    { subject: 'النموذج', predicate: 'الإصدار', value: '2', sourceId: 'a' },
    { subject: 'النموذج', predicate: 'الترخيص', value: 'MIT', sourceId: 'b' }
  ]);
  assert.equal(report.groups, 2);
  assert.equal(report.collapsed, 0);
});

test('an empty or malformed input yields an empty, valid report', () => {
  const report = consolidate([]);
  assert.equal(report.groups, 0);
  assert.equal(report.digest.length, 12);
  assert.deepEqual(checkReport(report), { ok: true, problems: [] });
  assert.equal(report.resolution, 'consolidated');
});

test('the sentence leads with the contest and states that nothing was deleted', () => {
  const lines = describeConsolidation(
    consolidate([claim('العملة', 'SAR', 'a'), claim('العملة', 'SAR', 'b'), claim('العملة', 'USD', 'c')])
  );
  assert.match(lines[0], /متنازَع عليه/);
  assert.match(lines[0], /SAR \(a، b\)/);
  assert.match(lines[0], /USD \(c\)/);
  assert.match(lines.join('\n'), /1 تكرارًا دُمج/);
  assert.match(lines.join('\n'), /لا حذف ولا إعادة كتابة/);
});

test('the CLI consolidates a snapshot, and exit code follows the contest', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const path = await import('node:path');
  const target = path.join(process.cwd(), 'scripts', 'memory-consolidate.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'memory-consolidate-'));
  const agree = path.join(dir, 'agree.json');
  const disagree = path.join(dir, 'disagree.json');
  writeFileSync(agree, JSON.stringify([claim('العملة', 'SAR', 'a'), claim('العملة', 'SAR', 'b')]), 'utf8');
  writeFileSync(disagree, JSON.stringify([claim('العملة', 'SAR', 'a'), claim('العملة', 'USD', 'b')]), 'utf8');

  const clean = execFileSync(process.execPath, [target, agree], { encoding: 'utf8' });
  assert.match(clean, /لا حذف ولا إعادة كتابة/);

  let failure = null;
  try {
    execFileSync(process.execPath, [target, disagree], { encoding: 'utf8' });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, 'a contest must not exit 0');
  assert.equal(failure.status, 1);
  assert.match(String(failure.stdout), /متنازَع عليه/);
  rmSync(dir, { recursive: true, force: true });
});
