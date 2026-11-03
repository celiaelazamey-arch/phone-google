/**
 * SI-5/D3 — بنية تقرير التشخيص الذاتي ثابتة البنية.
 *
 * تدقيق `SI-0` (صفّ D3): «agents:doctor ينتج تشخيصًا حقيقيًا لا تصنيفًا = Symptom + Evidence +
 * Recommended Action + حدّ صريح. الناقص: لا Hypotheses ولا Discriminating Tests ولا تمييز
 * ROOT_CAUSE_HYPOTHESIS من _CONFIRMED». هذه الوحدة تُكمل البنية الثابتة على المنتج الحقيقي:
 * تقرير مجمّد بحقول إلزامية ترفض الفراغ، وحالة جذر محسوبة لا معلنة — تظل
 * `ROOT_CAUSE_HYPOTHESIS` حتى تُسجَّل كل اختبارات التمييز فعليًا وتفصل بين فرضية مدعومة
 * وأقران مرفوضين. لا تُخترع نتائج: الاختبار غير المُجرى يبقى `untested` والحالة فرضية.
 *
 * لا عمليات ولا شبكة ولا مخزن: بنية بيانات وحساب حالة — قابلة للاستعمال من الطبيب ومن أي
 * منتج تشخيص لاحق بلا مصدر حقيقة ثانٍ.
 */

export const DIAGNOSIS_VERSION = 'self-diagnosis-v1';
export const ROOT_CAUSE_HYPOTHESIS = 'ROOT_CAUSE_HYPOTHESIS';
export const ROOT_CAUSE_CONFIRMED = 'ROOT_CAUSE_CONFIRMED';

export const TEST_OUTCOMES = Object.freeze({
  untested: 'untested',
  confirmed: 'confirmed',
  rejected: 'rejected'
});

const BASIS = Object.freeze({
  untestedDiscriminators: 'untested_discriminators',
  noSupportedHypothesis: 'no_supported_hypothesis',
  contradictoryOutcomes: 'contradictory_outcomes',
  multipleSupported: 'multiple_supported',
  singleSupportedRivalsRejected: 'single_supported_and_rivals_rejected',
  noRejectedRivals: 'no_rejected_rivals'
});

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`diagnosis_${field}_required`);
  }
  return value.trim();
}

function requireList(value, field, min) {
  if (!Array.isArray(value) || value.length < min) {
    throw new Error(`diagnosis_${field}_required`);
  }
  return value;
}

/** حالة الجذر تُحسب من اختبارات التمييز المسجَّلة لا تُعلن من المنتج. */
export function computeRootCauseStatus(hypotheses, discriminatingTests) {
  if (discriminatingTests.some((test) => test.outcome === TEST_OUTCOMES.untested)) {
    return { status: ROOT_CAUSE_HYPOTHESIS, statusBasis: BASIS.untestedDiscriminators };
  }
  const testsOf = (id) => discriminatingTests.filter((test) => test.hypothesis === id);
  const supported = hypotheses.filter(({ id }) => {
    const own = testsOf(id);
    return own.length > 0 && own.every((test) => test.outcome === TEST_OUTCOMES.confirmed);
  });
  const contradictory = hypotheses.some(({ id }) => {
    const own = testsOf(id);
    return own.some((test) => test.outcome === TEST_OUTCOMES.confirmed)
      && own.some((test) => test.outcome === TEST_OUTCOMES.rejected);
  });
  if (contradictory) return { status: ROOT_CAUSE_HYPOTHESIS, statusBasis: BASIS.contradictoryOutcomes };
  if (supported.length > 1) return { status: ROOT_CAUSE_HYPOTHESIS, statusBasis: BASIS.multipleSupported };
  const front = supported[0];
  if (!front) return { status: ROOT_CAUSE_HYPOTHESIS, statusBasis: BASIS.noSupportedHypothesis };
  // اختبار التمييز بلا منافس ليس تمييزًا: تأكيد الفرضية الوحيدة تعزيزٌ لا إثبات —
  // فلا CONFIRMED إلا بقران مرفوض فعلًا.
  const rivals = hypotheses.filter(({ id }) => id !== front.id);
  const rivalsRejected = rivals.length > 0
    && rivals.every(({ id }) => testsOf(id).some((test) => test.outcome === TEST_OUTCOMES.rejected));
  if (rivalsRejected) return { status: ROOT_CAUSE_CONFIRMED, statusBasis: BASIS.singleSupportedRivalsRejected };
  return { status: ROOT_CAUSE_HYPOTHESIS, statusBasis: BASIS.noRejectedRivals };
}

/**
 * يبني التقرير ثابت البنية: كل حقل إلزامي ترفض الوحدة غيابه، والحالة تُشتقّ دائمًا —
 * حتى لو حاول المنتج الإعلان عن تأكيد بلا أدلة مسجّلة.
 */
export function createDiagnosisReport({
  symptom,
  evidence,
  hypotheses,
  discriminatingTests,
  recommendedAction,
  limit
} = {}) {
  const cleanSymptom = requireText(symptom, 'symptom');
  const cleanEvidence = requireList(evidence, 'evidence', 1)
    .map((entry) => requireText(entry, 'evidence_entry'));
  const cleanHypotheses = requireList(hypotheses, 'hypotheses', 1).map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error('diagnosis_hypotheses_required');
    return Object.freeze({
      id: requireText(entry.id ?? `H${index + 1}`, 'hypothesis_id'),
      statement: requireText(entry.statement, 'hypothesis_statement')
    });
  });
  const ids = new Set(cleanHypotheses.map(({ id }) => id));
  if (ids.size !== cleanHypotheses.length) throw new Error('diagnosis_hypothesis_ids_unique');

  const cleanTests = requireList(discriminatingTests, 'discriminating_tests', 1).map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error('diagnosis_discriminating_tests_required');
    const outcome = entry.outcome ?? TEST_OUTCOMES.untested;
    if (!Object.values(TEST_OUTCOMES).includes(outcome)) {
      throw new Error('diagnosis_test_outcome_unknown');
    }
    const hypothesis = requireText(entry.hypothesis, 'test_hypothesis');
    if (!ids.has(hypothesis)) throw new Error('diagnosis_test_hypothesis_unknown');
    return Object.freeze({
      id: requireText(entry.id ?? `T${index + 1}`, 'test_id'),
      hypothesis,
      distinguishes: requireText(entry.distinguishes, 'test_distinguishes'),
      outcome
    });
  });

  const cleanAction = requireText(recommendedAction, 'recommended_action');
  const cleanLimit = requireText(limit, 'limit');
  const { status, statusBasis } = computeRootCauseStatus(cleanHypotheses, cleanTests);

  return Object.freeze({
    version: DIAGNOSIS_VERSION,
    symptom: cleanSymptom,
    evidence: Object.freeze(cleanEvidence),
    hypotheses: Object.freeze(cleanHypotheses),
    discriminatingTests: Object.freeze(cleanTests),
    recommendedAction: cleanAction,
    limit: cleanLimit,
    status,
    statusBasis
  });
}

/**
 * يسجّل نتيجة اختبار تمييز ويعيد تقريرًا جديدًا بالحالة المعاد حسابها — بلا طفر على الأصل.
 * النتيجة `untested` تُبقي الحالة فرضية؛ لا يُقبل تسجيل قيمة مجهولة.
 */
export function recordDiscrimination(report, testId, outcome) {
  if (!report || report.version !== DIAGNOSIS_VERSION) throw new Error('diagnosis_report_invalid');
  if (!Object.values(TEST_OUTCOMES).includes(outcome)) throw new Error('diagnosis_test_outcome_unknown');
  if (!report.discriminatingTests.some((test) => test.id === testId)) {
    throw new Error('diagnosis_test_unknown');
  }
  return createDiagnosisReport({
    symptom: report.symptom,
    evidence: [...report.evidence],
    hypotheses: report.hypotheses.map(({ id, statement }) => ({ id, statement })),
    discriminatingTests: report.discriminatingTests.map((test) => (
      test.id === testId ? { ...test, outcome } : { ...test }
    )),
    recommendedAction: report.recommendedAction,
    limit: report.limit
  });
}
