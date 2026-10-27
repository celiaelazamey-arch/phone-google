import test from 'node:test';
import assert from 'node:assert/strict';

import { createTempStore } from './support/agent-fixtures.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createDemoPlanner } from '../src/agent/planner.js';
import { createDefaultTools, createToolRegistry, defaultToolDefinitions } from '../src/agent/tools.js';
import { createConnectorRegistry } from '../src/agent/connectors.js';
import {
  createPurchaseLedgerStore,
  createPurchaseLedgerConnector,
  readLocalDocument,
  extractStructuredDocument,
  explainExtractedFields,
  validateExtractedData,
  explainValidationOutcome,
  evaluateComprehensionGate,
  buildComprehensionExplanation,
  buildAutomationReport,
  validateAutomationSchema,
  VALIDATION_STATUS,
  ACTION_STATUS,
  COMPREHENSION_GATE_STATUS,
  NEXT_PERMITTED_ACTION
} from '../src/agent/index.js';
import { createVerifier } from '../src/agent/verifier.js';

async function setupComprehensionRuntime(t) {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());

  const ledgerStore = createPurchaseLedgerStore();
  const ledgerConnector = createPurchaseLedgerConnector({ ledgerStore });
  const connectors = createConnectorRegistry([ledgerConnector]);
  const tools = createDefaultTools({
    statusProvider: () => ({ version: '0.2.1', storage: 'sqlite' }),
    ledgerStore
  });
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools,
    planner: createDemoPlanner(),
    connectors,
    limits: { maxSteps: 14, maxCostMicros: 100_000 },
    workerId: 'comprehension-worker',
    logger: { error() {} }
  });
  t.after(() => runtime.shutdown().catch(() => {}));

  const thread = await fixture.store.createThread({
    ownerId: 'owner',
    title: 'Phase 3 Comprehension Gate'
  });

  return { fixture, runtime, tools, ledgerStore, thread };
}

test('CL-01: plain-language goal explanation preserves meaning and backward compatibility with schema 1.0', async () => {
  const doc = await readLocalDocument({ path: 'invoice-valid-1042.csv' });
  const extracted = await extractStructuredDocument({ document: doc });
  const validation = validateExtractedData({ extracted });

  const readOnlyExp = buildComprehensionExplanation({
    goal: 'استخرج بيانات الفاتورة invoice-valid-1042.csv',
    docPath: 'invoice-valid-1042.csv',
    commitRequested: false,
    extracted,
    validation
  });
  assert.match(readOnlyExp.goal_plain, /قراءة الفاتورة/);
  assert.match(readOnlyExp.goal_plain, /دون أي كتابة خارجية/);

  const commitExp = buildComprehensionExplanation({
    goal: 'استخرج بيانات الفاتورة invoice-valid-1042.csv وأضفها إلى سجل المشتريات',
    docPath: 'invoice-valid-1042.csv',
    commitRequested: true,
    extracted,
    validation
  });
  assert.match(commitExp.goal_plain, /عرضها على المالك للموافقة قبل إضافتها إلى سجل المشتريات/);

  // Backward compatibility check: a Phase 2 report without `explanation` still passes schema 1.0,
  // and a Phase 3 report with `explanation` also passes schema 1.0.
  const phase3Report = buildAutomationReport({
    taskId: 'cl-01',
    docPath: 'invoice-valid-1042.csv',
    commitRequested: true,
    extracted,
    validation
  });
  assert.equal(validateAutomationSchema(phase3Report).ok, true);

  const phase2LegacyReport = { ...phase3Report };
  delete phase2LegacyReport.explanation;
  assert.equal(validateAutomationSchema(phase2LegacyReport).ok, true);
});

test('CL-02: plan_steps explain the reason for each core step in simple language', async () => {
  const doc = await readLocalDocument({ path: 'invoice-valid-1042.csv' });
  const extracted = await extractStructuredDocument({ document: doc });
  const validation = validateExtractedData({ extracted });

  const explanation = buildComprehensionExplanation({
    docPath: 'invoice-valid-1042.csv',
    commitRequested: true,
    extracted,
    validation
  });

  const toolsInPlan = explanation.plan_steps.map((s) => s.tool);
  assert.deepEqual(toolsInPlan, [
    'document.read',
    'document.extract',
    'data.validate',
    'data.report',
    'document.commit_purchase_ledger'
  ]);
  for (const step of explanation.plan_steps) {
    assert.ok(step.why_plain.length >= 20, `Step ${step.tool} carries a plain-language rationale`);
  }
});

test('CL-03: distinguishes verified source facts from derived/default assumptions and missing unknowns', async () => {
  // invoice-missing-supplier.csv has no supplier_name, and if tax is omitted in a custom doc it becomes an assumption
  const rawMissing = await readLocalDocument({
    content: 'invoice_number,issue_date,currency,item_description,quantity,unit_price,line_amount,total\nINV-301,2026-10-27,EGP,خدمة سحابية,2,500,1000,1000\n',
    format: 'csv',
    sourceId: 'synthetic-cl03'
  });
  const extracted = await extractStructuredDocument({ document: rawMissing });
  const fieldExp = explainExtractedFields(extracted);

  const verifiedFieldNames = fieldExp.verified_facts.map((f) => f.field);
  assert.ok(verifiedFieldNames.includes('invoice_number'));
  assert.ok(verifiedFieldNames.includes('total'));
  // Derived subtotal and default zero tax are explicitly separated into `assumptions`, NOT `verified_facts`!
  assert.equal(verifiedFieldNames.includes('subtotal'), false);
  assert.equal(verifiedFieldNames.includes('tax'), false);

  const assumptionIds = fieldExp.assumptions.map((a) => a.id);
  assert.ok(assumptionIds.includes('derived_subtotal_from_lines'));
  assert.ok(assumptionIds.includes('default_zero_tax'));

  const unknownFields = fieldExp.unknown_fields.map((u) => u.field);
  assert.ok(unknownFields.includes('supplier_name'));
  assert.ok(unknownFields.includes('supplier_tax_id'));
});

test('CL-04: links every important factual claim to existing source provenance and recorded evidence references', async (t) => {
  const { runtime, thread } = await setupComprehensionRuntime(t);

  const submitted = await runtime.submit({
    threadId: thread.id,
    message: 'استخرج بيانات الفاتورة invoice-valid-1042.csv',
    clientMessageId: 'cl-04-provenance-link'
  });
  const finished = await runtime.runToCompletion(submitted.run.id);
  assert.equal(finished.status, 'succeeded');

  const detail = await runtime.detail(submitted.run.id);
  const reportRun = detail.toolRuns.find((tr) => tr.toolName === 'data.report');
  const explanation = reportRun.outcome.explanation;

  assert.ok(explanation.verified_facts.length >= 6);
  assert.equal(explanation.source_sha256, reportRun.outcome.source.file_sha256);
  assert.ok(Array.isArray(explanation.evidence_refs) && explanation.evidence_refs.length >= 3);
  for (const fact of explanation.verified_facts) {
    assert.match(fact.source_ref, /^row:2,col:/);
  }
});

test('CL-05: explains invoice total mismatch in simple language without passing or committing the invoice', async (t) => {
  const { runtime, ledgerStore, thread } = await setupComprehensionRuntime(t);

  const submitted = await runtime.submit({
    threadId: thread.id,
    message: 'استخرج بيانات الفاتورة invoice-bad-total.csv وأضفها إلى سجل المشتريات',
    clientMessageId: 'cl-05-bad-total'
  });
  const finished = await runtime.runToCompletion(submitted.run.id);
  assert.equal(finished.status, 'succeeded');
  assert.equal(ledgerStore.list().length, 0, 'Invalid invoice is never committed');

  const detail = await runtime.detail(submitted.run.id);
  const reportRun = detail.toolRuns.find((tr) => tr.toolName === 'data.report');
  const report = reportRun.outcome;

  assert.equal(report.validation.status, VALIDATION_STATUS.invalid);
  assert.equal(report.action.status, ACTION_STATUS.notCommitted);
  assert.equal(
    report.explanation.simple_summary,
    'الفاتورة تحتاج إلى تصحيح. مجموع 1000 و140 يساوي 1140، وليس 1999. لذلك لا يمكن اعتماد الفاتورة حتى يُحلّ الاختلاف.'
  );
  assert.equal(report.explanation.next_permitted_action, NEXT_PERMITTED_ACTION.fixSourceDocument);
  assert.equal(report.explanation.comprehension_gate.status, COMPREHENSION_GATE_STATUS.pass);
  assert.equal(detail.outbox.length, 0);

  // Also verify the exact 1000 + 140 != 1500 specification example:
  const example1500 = explainValidationOutcome({
    extracted: {
      fields: { subtotal: 1000, tax: 140, total: 1500, line_items: [] }
    },
    validation: {
      status: VALIDATION_STATUS.invalid,
      errors: ['total_mismatch']
    }
  });
  assert.equal(
    example1500.simple_summary,
    'الفاتورة تحتاج إلى تصحيح. مجموع 1000 و140 يساوي 1140، وليس 1500. لذلك لا يمكن اعتماد الفاتورة حتى يُحلّ الاختلاف.'
  );
});

test('CL-06: explains why an incomplete invoice requires human review without inventing missing supplier data', async () => {
  const doc = await readLocalDocument({ path: 'invoice-missing-supplier.csv' });
  const extracted = await extractStructuredDocument({ document: doc });
  const validation = validateExtractedData({ extracted });
  const report = buildAutomationReport({
    taskId: 'cl-06',
    docPath: 'invoice-missing-supplier.csv',
    commitRequested: true,
    extracted,
    validation
  });

  assert.equal(report.validation.status, VALIDATION_STATUS.reviewRequired);
  assert.equal(report.action.status, ACTION_STATUS.notCommitted);
  assert.match(report.explanation.simple_summary, /الفاتورة تحتاج إلى مراجعة بشرية قبل أي اعتماد/);
  assert.match(report.explanation.simple_summary, /الرقم الضريبي للمورد غير مذكور/);
  assert.equal(report.explanation.next_permitted_action, NEXT_PERMITTED_ACTION.requestHumanReview);
  assert.ok(report.explanation.unknowns.some((u) => u.includes('الرقم الضريبي للمورد')));
});

test('CL-07: explains that untrusted prompt injection inside a document is treated strictly as data, not commands', async (t) => {
  const { runtime, ledgerStore, thread } = await setupComprehensionRuntime(t);

  const submitted = await runtime.submit({
    threadId: thread.id,
    message: 'اقرأ المستند invoice-prompt-injection.txt وأضفه إلى سجل المشتريات',
    clientMessageId: 'cl-07-prompt-injection'
  });
  const finished = await runtime.runToCompletion(submitted.run.id);
  assert.equal(finished.status, 'succeeded');
  assert.equal(ledgerStore.list().length, 0);

  const detail = await runtime.detail(submitted.run.id);
  const report = detail.toolRuns.find((tr) => tr.toolName === 'data.report').outcome;

  assert.equal(report.validation.status, VALIDATION_STATUS.reviewRequired);
  assert.match(report.explanation.simple_summary, /تعامل النظام مع محتوى المستند كبيانات غير موثوقة فقط وليس كأوامر/);
  assert.ok(
    report.explanation.risks_and_side_effects.some((r) => r.includes('عُزلت نصوص تحاول تجاوز السياسات كمحتوى غير موثوق'))
  );
  assert.equal(report.action.status, ACTION_STATUS.notCommitted);
});

test('CL-08: explains interrupted/unknown execution state honestly without claiming success', async () => {
  const doc = await readLocalDocument({ path: 'invoice-valid-1042.csv' });
  const extracted = await extractStructuredDocument({ document: doc });
  const validation = validateExtractedData({ extracted });

  const valExp = explainValidationOutcome({
    extracted,
    validation,
    executionState: 'unknown'
  });
  assert.equal(valExp.status, 'unknown');
  assert.match(valExp.simple_summary, /لا يدّعي النظام نجاح العملية/);

  const report = buildAutomationReport({
    taskId: 'cl-08-unknown',
    docPath: 'invoice-valid-1042.csv',
    commitRequested: true,
    extracted,
    validation,
    executionState: 'unknown'
  });

  assert.equal(report.explanation.verification_status, 'unknown');
  assert.equal(report.explanation.comprehension_gate.status, COMPREHENSION_GATE_STATUS.unknown);
  assert.equal(report.explanation.next_permitted_action, NEXT_PERMITTED_ACTION.reconcileUnknownOutcome);
  assert.ok(report.explanation.unknowns.some((u) => u.includes('unknown')));
});

test('CL-09: detects and blocks a persuasive explanation that contradicts deterministic evidence or fabricates provenance', async () => {
  const doc = await readLocalDocument({ path: 'invoice-bad-total.csv' });
  const extracted = await extractStructuredDocument({ document: doc });
  const validation = validateExtractedData({ extracted });
  const honestReport = buildAutomationReport({
    taskId: 'cl-09-base',
    extracted,
    validation
  });

  // Construct a fluent, persuasive explanation that falsely claims the invoice is valid and totals match
  const deceptiveExplanation = {
    ...honestReport.explanation,
    verification_status: 'valid',
    simple_summary: 'الفاتورة صحيحة ومكتملة تمامًا، والمجموع يطابق الإجمالي بعد احتساب رسوم الخدمة الإضافية، وتم اعتماد الفاتورة بنجاح.',
    next_permitted_action: NEXT_PERMITTED_ACTION.awaitOwnerApproval,
    verified_facts: [
      ...honestReport.explanation.verified_facts,
      {
        field: 'total',
        value: 1140, // contradicts actual recorded total 1500
        source_ref: 'row:99,col:invented', // fabricated coordinate
        plain_statement: 'الإجمالي الصحيح هو 1140 في السطر 99.'
      }
    ]
  };

  const gateEval = evaluateComprehensionGate({
    explanation: deceptiveExplanation,
    extracted,
    validation,
    action: { status: ACTION_STATUS.notCommitted }
  });

  assert.equal(gateEval.status, COMPREHENSION_GATE_STATUS.block);
  assert.ok(gateEval.contradictions.some((c) => c.startsWith('verification_status_mismatch')));
  assert.ok(gateEval.contradictions.includes('persuasive_summary_contradicts_non_valid_status'));
  assert.ok(gateEval.contradictions.includes('invalid_or_review_document_cannot_advance_to_commit_approval'));
  assert.ok(gateEval.contradictions.some((c) => c.startsWith('fact_value_mismatch:total')));
  assert.ok(gateEval.ungrounded_claims.some((u) => u.startsWith('fact_source_ref_unverified:total')));

  // Passing the deceptive explanation into buildAutomationReport NEVER changes validation.status or action.status,
  // and the Independent Verifier blocks the run on `comprehension_gate_grounding`!
  const reportWithDeceptiveOverride = buildAutomationReport({
    taskId: 'cl-09-deceptive',
    extracted,
    validation,
    explanationOverride: deceptiveExplanation
  });
  assert.equal(reportWithDeceptiveOverride.validation.status, VALIDATION_STATUS.invalid);
  assert.equal(reportWithDeceptiveOverride.action.status, ACTION_STATUS.notCommitted);
  assert.equal(reportWithDeceptiveOverride.explanation.comprehension_gate.status, COMPREHENSION_GATE_STATUS.block);

  const tools = createToolRegistry(defaultToolDefinitions());
  const verifier = createVerifier({ tools });
  const verification = await verifier.verifyRun({
    run: { id: 'run-cl09', usage: { steps: 2, costMicros: 0 }, limits: { maxSteps: 12, maxCostMicros: 10000 } },
    contract: null,
    steps: [{ id: 's1', index: 1, kind: 'act' }],
    toolRuns: [
      {
        id: 'tr-report-cl09',
        stepId: 's1',
        toolName: 'data.report',
        status: 'succeeded',
        outcome: JSON.stringify(reportWithDeceptiveOverride)
      }
    ],
    evidence: [],
    approvals: [],
    outbox: [],
    messages: []
  });

  const groundingCheck = verification.checks.find((c) => c.id === 'comprehension_gate_grounding');
  assert.ok(groundingCheck);
  assert.equal(groundingCheck.status, 'BLOCK');
  assert.equal(verification.verdict, 'BLOCK');
});

test('CL-10: never bypasses owner approval or policy regardless of how clear or persuasive the explanation is', async (t) => {
  const { runtime, ledgerStore, thread } = await setupComprehensionRuntime(t);

  // Valid invoice with a clear PASS explanation still parks in WAITING_FOR_APPROVAL with 0 ledger writes
  const submitted = await runtime.submit({
    threadId: thread.id,
    message: 'استخرج بيانات الفاتورة invoice-valid-1042.csv وأضفها إلى سجل المشتريات',
    clientMessageId: 'cl-10-approval-enforced'
  });

  const parked = await runtime.runToCompletion(submitted.run.id);
  assert.equal(parked.status, 'waiting_approval');
  assert.equal(ledgerStore.list().length, 0, 'Clear explanation never bypasses WAITING_FOR_APPROVAL');

  const detail = await runtime.detail(submitted.run.id);
  const report = detail.toolRuns.find((tr) => tr.toolName === 'data.report').outcome;
  assert.equal(report.explanation.comprehension_gate.status, COMPREHENSION_GATE_STATUS.pass);
  assert.equal(report.explanation.next_permitted_action, NEXT_PERMITTED_ACTION.awaitOwnerApproval);
  assert.equal(detail.plan.state, 'WAITING_FOR_APPROVAL');
});
