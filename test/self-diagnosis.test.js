/**
 * SIE-001 / SI-5/D3 — بنية تقرير التشخيص الذاتي ثابتة البنية.
 *
 * العقيدة (تدقيق `SI-0` · `DEC-122`): المنتج الحقيقي (`agents:doctor`) يبني تقريره بالبنية
 * الثابتة، والحالة تُحسب لا تُعلن — `ROOT_CAUSE_CONFIRMED` مستحيل بلا اختبارات تمييز مسجّلة
 * تفصل فرضية مدعومة عن أقران مرفوضين. لا تُخترع نتائج: غير المُجرى `untested` والفرضية فرضية.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DIAGNOSIS_VERSION,
  ROOT_CAUSE_CONFIRMED,
  ROOT_CAUSE_HYPOTHESIS,
  TEST_OUTCOMES,
  computeRootCauseStatus,
  createDiagnosisReport,
  recordDiscrimination
} from '../src/agent/self-diagnosis.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function report(overrides = {}) {
  return createDiagnosisReport({
    symptom: 'الجلب الحقيقي فشل: web_tls_failed',
    evidence: ['web.fetch أعد web_tls_failed', 'المنع خارج قائمة السماح يعمل'],
    hypotheses: [
      { id: 'H1', statement: 'شبكة البيئة تعترض TLS' },
      { id: 'H2', statement: 'شهادة الهدف غير صالحة' }
    ],
    discriminatingTests: [
      { id: 'T1', hypothesis: 'H1', distinguishes: 'curl ينجح وNode يفشل ⇒ H1', outcome: 'untested' }
    ],
    recommendedAction: 'أعد الفحص مع NODE_EXTRA_CA_CERTS',
    limit: 'قرار ثقة صريح لا يُفعّل تلقائيًا',
    ...overrides
  });
}

test('D3: the fixed structure carries every audited section, frozen, with version and status', () => {
  const r = report();
  assert.equal(r.version, DIAGNOSIS_VERSION);
  for (const field of ['symptom', 'evidence', 'hypotheses', 'discriminatingTests', 'recommendedAction', 'limit', 'status', 'statusBasis']) {
    assert.ok(field in r, `${field} is part of the fixed structure`);
  }
  assert.equal(r.status, ROOT_CAUSE_HYPOTHESIS, 'an untested discriminator keeps the cause a hypothesis');
  assert.equal(r.statusBasis, 'untested_discriminators');
  assert.equal(Object.isFrozen(r), true);
  assert.throws(() => { 'use strict'; r.symptom = 'عبث'; }, TypeError, 'the report is immutable');
});

test('D3: required fields fail closed — no symptom-less, evidence-less or limit-less diagnosis', () => {
  assert.throws(() => report({ symptom: '  ' }), /symptom_required/);
  assert.throws(() => report({ evidence: [] }), /evidence_required/);
  assert.throws(() => report({ hypotheses: [] }), /hypotheses_required/);
  assert.throws(() => report({ discriminatingTests: [] }), /discriminating_tests_required/);
  assert.throws(() => report({ recommendedAction: '' }), /recommended_action_required/);
  assert.throws(() => report({ limit: null }), /limit_required/);
  assert.throws(
    () => report({ discriminatingTests: [{ id: 'T9', hypothesis: 'H9', distinguishes: 'x' }] }),
    /test_hypothesis_unknown/,
    'a test pointing outside the hypothesis set is refused'
  );
  assert.throws(
    () => report({ discriminatingTests: [{ id: 'T1', hypothesis: 'H1', distinguishes: 'x', outcome: 'مجاملة' }] }),
    /test_outcome_unknown/
  );
});

test('D3: ROOT_CAUSE_CONFIRMED requires recorded discriminating tests that separate one supported hypothesis from rejected rivals', () => {
  const two = (outcomes) => report({
    discriminatingTests: [
      { id: 'T1', hypothesis: 'H1', distinguishes: 'a', outcome: outcomes[0] },
      { id: 'T2', hypothesis: 'H2', distinguishes: 'b', outcome: outcomes[1] }
    ]
  });
  const confirmed = two(['confirmed', 'rejected']);
  assert.equal(confirmed.status, ROOT_CAUSE_CONFIRMED);
  assert.equal(confirmed.statusBasis, 'single_supported_and_rivals_rejected');

  assert.equal(two(['rejected', 'confirmed']).status, ROOT_CAUSE_CONFIRMED, 'either rival may win');
  assert.equal(two(['confirmed', 'untested']).status, ROOT_CAUSE_HYPOTHESIS);
  assert.equal(two(['rejected', 'rejected']).statusBasis, 'no_supported_hypothesis');
  assert.equal(two(['confirmed', 'confirmed']).statusBasis, 'multiple_supported');
  assert.equal(computeRootCauseStatus(
    [{ id: 'H1' }, { id: 'H2' }],
    [
      { hypothesis: 'H1', outcome: 'confirmed' },
      { hypothesis: 'H1', outcome: 'rejected' },
      { hypothesis: 'H2', outcome: 'rejected' }
    ]
  ).statusBasis, 'contradictory_outcomes');
  assert.equal(computeRootCauseStatus(
    [{ id: 'H1' }],
    [{ hypothesis: 'H1', outcome: 'confirmed' }]
  ).status, ROOT_CAUSE_HYPOTHESIS, 'no recorded rivals to reject ⇒ stays a hypothesis');
});

test('D3: recordDiscrimination returns a new report and never mutates the original', () => {
  const original = report();
  const next = recordDiscrimination(original, 'T1', TEST_OUTCOMES.confirmed);
  assert.notEqual(next, original);
  assert.equal(original.discriminatingTests[0].outcome, 'untested', 'the original keeps its recorded state');
  assert.equal(next.discriminatingTests[0].outcome, 'confirmed');
  assert.equal(next.statusBasis, 'no_rejected_rivals', 'confirming H1 without rejecting H2 is not enough');
  const settled = recordDiscrimination(
    report({
      discriminatingTests: [
        { id: 'T1', hypothesis: 'H1', distinguishes: 'a', outcome: 'confirmed' },
        { id: 'T2', hypothesis: 'H2', distinguishes: 'b', outcome: 'untested' }
      ]
    }),
    'T2',
    TEST_OUTCOMES.rejected
  );
  assert.equal(settled.status, ROOT_CAUSE_CONFIRMED, 'the recorded discrimination settles the cause');
  assert.throws(() => recordDiscrimination(original, 'TX', 'confirmed'), /test_unknown/);
  assert.throws(() => recordDiscrimination(original, 'T1', 'maybe'), /outcome_unknown/);
});

test('D3: agents:doctor emits the structured diagnosis for the real TLS case, honestly untested', () => {
  const child = spawnSync(process.execPath, ['scripts/agents-doctor.mjs', '--json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 240_000
  });
  const text = String(child.stdout || '');
  const start = text.indexOf('{');
  assert.ok(start >= 0, `no JSON on stdout: ${child.stderr?.slice(0, 400)}`);
  const reportJson = JSON.parse(text.slice(start));
  const web = reportJson.checks.find((entry) => entry.id === 'web-fetch');
  assert.ok(web, 'the web check is reported');

  if (web.status === 'blocked' && web.evidence?.fetchError === 'web_tls_failed') {
    const diagnosis = web.evidence.diagnosis;
    assert.ok(diagnosis, 'the audited real diagnosis now carries the fixed structure');
    assert.equal(diagnosis.version, DIAGNOSIS_VERSION);
    assert.match(diagnosis.symptom, /web_tls_failed/);
    assert.deepEqual(diagnosis.hypotheses.map(({ id }) => id), ['H1', 'H2']);
    assert.equal(diagnosis.discriminatingTests[0].outcome, 'untested', 'the doctor never invents the curl outcome');
    assert.equal(diagnosis.status, ROOT_CAUSE_HYPOTHESIS);
    assert.match(diagnosis.recommendedAction, /NODE_EXTRA_CA_CERTS/);
    assert.match(diagnosis.limit, /لا يُفعّل تلقائيًا/);
  } else {
    assert.equal(web.evidence?.diagnosis, undefined, 'no diagnosis is fabricated when the fetch simply works');
  }
});
