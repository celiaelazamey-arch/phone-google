import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  CONFLICT_VERSION,
  claimKey,
  claimsFromItems,
  conflictDigest,
  describeConflicts,
  extractClaims,
  findConflicts,
  normalizeText,
  normalizeValue
} from '../src/knowledge/conflict.js';

const claim = (subject, value, sourceId, extra = {}) => ({
  subject,
  predicate: 'value',
  value,
  sourceId,
  trust: 'T1',
  ...extra
});

test('two sources disagreeing on one fact produce a named, unresolved conflict', () => {
  const report = findConflicts([
    claim('موعد الإطلاق', '15 نوفمبر', 'drive/roadmap.md'),
    claim('موعد الإطلاق', '20 نوفمبر', 'docs/plan.md')
  ]);
  assert.equal(report.count, 1);
  assert.equal(report.conflicts[0].resolution, 'unresolved');
  assert.deepEqual(report.conflicts[0].sources, ['drive/roadmap.md', 'docs/plan.md']);
  assert.equal(report.conflicts[0].values.length, 2);
  assert.equal(report.checked, 2);
  assert.equal(report.arbitrated, false);
});

test('no winner is ever chosen — not by trust, not by recency, not by majority', () => {
  const report = findConflicts([
    claim('حد الاستخدام', '100', 'a', { trust: 'T0', observedAt: '2026-01-01T00:00:00Z' }),
    claim('حد الاستخدام', '200', 'b', { trust: 'T3', observedAt: '2026-11-01T00:00:00Z' }),
    claim('حد الاستخدام', '200', 'c', { trust: 'T3', observedAt: '2026-11-01T00:00:00Z' })
  ]);
  assert.equal(report.count, 1);
  const [conflict] = report.conflicts;
  assert.equal(conflict.values.length, 2, 'two distinct values, not three claims');
  assert.equal(conflict.resolution, 'unresolved');
  assert.equal(conflict.newestSource.sourceId, 'b', 'recency is reported…');
  assert.ok(!('winner' in conflict) && !('preferred' in conflict) && !('resolvedValue' in conflict), '…and never applied');
  const majority = conflict.values.find((value) => value.value === '200');
  assert.equal(majority.sourceId !== undefined, true);
  assert.ok(!JSON.stringify(report).includes('"chosen"'));
});

test('spelling, digits and diacritics do not manufacture a conflict', () => {
  const report = findConflicts([
    claim('المسافة', '٤٢ كم', 'a'),
    claim('المسافة', '42 كم', 'b'),
    claim('المُسافة', '42كم', 'c'),
    claim('الْمسَافَة', '42.0 كم', 'd')
  ]);
  assert.equal(report.count, 0, JSON.stringify(report.conflicts));

  assert.equal(normalizeValue('٤٢').number, 42);
  assert.equal(normalizeValue('1,5').number, 1.5);
  assert.equal(normalizeText('  المُسافة  '), 'المسافة');
});

test('a different unit is a real conflict, and unknown units are not converted', () => {
  const units = findConflicts([claim('المسافة', '42 km', 'a'), claim('المسافة', '42 kg', 'b')]);
  assert.equal(units.count, 1);

  const unknown = findConflicts([claim('الوزن', '5 صاع', 'a'), claim('الوزن', '5 كيلة', 'b')]);
  assert.equal(unknown.count, 1, 'unknown units must stay literal rather than be guessed into agreement');
});

test('agreement and unrelated keys stay silent', () => {
  assert.equal(findConflicts([claim('العملة', 'SAR', 'a'), claim('العملة', 'sar', 'b')]).count, 0);
  assert.equal(findConflicts([claim('العملة', 'SAR', 'a'), claim('المدينة', 'SAR', 'b')]).count, 0);
  assert.equal(findConflicts([claim('العملة', 'SAR', 'a')]).count, 0);
  assert.equal(findConflicts([]).count, 0);
});

test('a predicate is part of the key: same subject, different question, no conflict', () => {
  const claims = [
    { subject: 'النموذج', predicate: 'الإصدار', value: '2', sourceId: 'a' },
    { subject: 'النموذج', predicate: 'الترخيص', value: 'MIT', sourceId: 'b' }
  ];
  assert.equal(findConflicts(claims).count, 0);
  assert.notEqual(claimKey({ subject: 'النموذج', predicate: 'الإصدار' }), claimKey({ subject: 'النموذج', predicate: 'الترخيص' }));
});

test('claims are extracted only from the narrow, declared syntax', () => {
  const text = [
    '# تعليق لا يُقرأ',
    'موعد الإطلاق: 15 نوفمبر',
    'Budget = 42',
    'سطر بلا فاصل لا يُعدّ ادعاءً',
    'المدينة | العاصمة = القاهرة'
  ].join('\n');
  const claims = extractClaims(text, { sourceId: 'doc', trust: 'T1' });
  assert.equal(claims.length, 3);
  assert.deepEqual(claims[0], {
    subject: 'موعد الإطلاق',
    predicate: 'value',
    value: '15 نوفمبر',
    sourceId: 'doc',
    trust: 'T1',
    observedAt: null,
    statement: 'موعد الإطلاق: 15 نوفمبر',
    line: 2
  });
  assert.equal(claims[2].subject, 'المدينة');
  assert.equal(claims[2].predicate, 'العاصمة');
});

test('knowledge items keep their own source, trust and licence', () => {
  const items = [
    { id: 'i1', source_id: 's1', trust: 'T1', license: 'CC-BY', body: 'المدة: 3 أسابيع', updated_at: '2026-10-01' },
    { id: 'i2', source_id: 's2', trust: 'T2', license: 'MIT', body: 'المدة: 5 أسابيع', updated_at: '2026-10-02' }
  ];
  const claims = claimsFromItems(items);
  assert.equal(claims.length, 2);
  const report = findConflicts(claims);
  assert.equal(report.count, 1);
  assert.equal(report.conflicts[0].values[0].trust, 'T1');
  assert.deepEqual(report.conflicts[0].sources.sort(), ['s1', 's2']);
  assert.equal(claims[0].itemId, 'i1');
});

test('an empty or malformed claim is rejected, not turned into a conflict', () => {
  const report = findConflicts([{ subject: '', value: 'x' }, { subject: 'صحيح', value: '' }, claim('صحيح', '1', 'a')]);
  assert.equal(report.count, 0);
  assert.equal(report.rejected, 2);
});

test('the digest is deterministic and changes with the finding — evidence can cite it', () => {
  const one = findConflicts([claim('أ', '1', 's1'), claim('أ', '2', 's2')]);
  const two = findConflicts([claim('أ', '1', 's1'), claim('أ', '3', 's2')]);
  assert.equal(conflictDigest(one), conflictDigest(findConflicts([claim('أ', '1', 's1'), claim('أ', '2', 's2')])));
  assert.notEqual(conflictDigest(one), conflictDigest(two));
  assert.match(conflictDigest(one), /^[a-f0-9]{12}$/);
  assert.equal(one.version, CONFLICT_VERSION);
});

test('the human sentence names both sides and says it is unresolved', () => {
  const report = findConflicts([claim('حد الاستخدام', '100', 'a', { trust: 'T1' }), claim('حد الاستخدام', '200', 'b', { trust: 'T2' })]);
  const [line, total] = describeConflicts(report);
  assert.match(line, /تعارض غير محسوم/);
  assert.match(line, /100 \(a · T1\)/);
  assert.match(line, /200 \(b · T2\)/);
  assert.match(total, /غير محسوم/);
  assert.deepEqual(describeConflicts(findConflicts([])), ['لا تعارض مقيس بين 0 ادعاءً.', 'no measured conflict across 0 claims']);
});

test('the CLI names both sides, exits 1 on a conflict and 0 when sources agree', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const target = path.join(process.cwd(), 'scripts', 'kb-conflicts.mjs');

  const dir = mkdtempSync(path.join(tmpdir(), 'kb-conflicts-'));
  const left = path.join(dir, 'a.md');
  const right = path.join(dir, 'b.md');
  const agree = path.join(dir, 'c.md');
  writeFileSync(left, 'موعد الإطلاق: 15 نوفمبر\n', 'utf8');
  writeFileSync(right, 'موعد الإطلاق: 20 نوفمبر\n', 'utf8');
  writeFileSync(agree, 'موعد الإطلاق: 15 نوفمبر\n', 'utf8');

  let failure = null;
  try {
    execFileSync(process.execPath, [target, left, right], { encoding: 'utf8' });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, 'a conflict must not exit 0');
  assert.equal(failure.status, 1);
  assert.match(String(failure.stdout), /a\.md/);
  assert.match(String(failure.stdout), /b\.md/);
  assert.match(String(failure.stdout), /غير محسوم/);

  const same = execFileSync(process.execPath, [target, left, agree], { encoding: 'utf8' });
  assert.match(same, /لا تعارض/);
  rmSync(dir, { recursive: true, force: true });
});
