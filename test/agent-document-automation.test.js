import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempStore } from './support/agent-fixtures.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createDemoPlanner } from '../src/agent/planner.js';
import { createDefaultTools } from '../src/agent/tools.js';
import { createConnectorRegistry } from '../src/agent/connectors.js';
import {
  CAPABILITY_NAME,
  AUTOMATION_SCHEMA_VERSION,
  VALIDATION_STATUS,
  ACTION_STATUS,
  readLocalDocument,
  extractStructuredDocument,
  measureExtractionAccuracy,
  validateExtractedData,
  buildAutomationReport,
  createPurchaseLedgerStore,
  createPurchaseLedgerConnector
} from '../src/agent/automation/index.js';

const FIXTURES_DIR = path.resolve(process.cwd(), 'test/fixtures/documents');

async function setupAutomationRuntime(t) {
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
    workerId: 'doc-automation-worker',
    logger: { error() {} }
  });
  t.after(() => runtime.shutdown().catch(() => {}));
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'أتمتة المستندات' });
  return { fixture, ledgerStore, tools, runtime, thread };
}

test('Golden corpus extraction, provenance coordinates, and field-level accuracy measurement', async () => {
  const goldenRaw = await readFile(path.join(FIXTURES_DIR, 'golden-expected.json'), 'utf8');
  const goldenExpected = JSON.parse(goldenRaw);
  const files = Object.keys(goldenExpected);

  const extractedItems = [];
  for (const filename of files) {
    const doc = await readLocalDocument({ path: filename });
    assert.equal(doc.capability, CAPABILITY_NAME);
    assert.equal(doc.source.source_id, filename);
    assert.equal(doc.source.untrusted_content, true);
    assert.match(doc.source.file_sha256, /^[a-f0-9]{64}$/);

    const extracted = await extractStructuredDocument({ document: doc });
    assert.equal(extracted.schema_version, AUTOMATION_SCHEMA_VERSION);
    assert.ok(extracted.provenance.invoice_number?.ref, `Provenance ref missing for ${filename}`);
    extractedItems.push(extracted);
  }

  const accuracy = measureExtractionAccuracy(extractedItems, goldenExpected);
  assert.equal(accuracy.documentsEvaluated, 5);
  assert.equal(accuracy.overallAccuracy, 1);
  assert.equal(accuracy.perField.invoice_number.accuracy, 1);
  assert.equal(accuracy.perField.total.accuracy, 1);
});

test('Case 1: unclear/missing supplier data routes to review_required and corrupted/forbidden paths are rejected', async () => {
  const doc = await readLocalDocument({ path: 'invoice-missing-supplier.csv' });
  const extracted = await extractStructuredDocument({ document: doc });
  const validation = validateExtractedData({ extracted });

  assert.equal(validation.status, VALIDATION_STATUS.reviewRequired);
  assert.ok(validation.errors.includes('supplier_identity_not_verified'));

  const report = buildAutomationReport({
    taskId: 'task-example-001',
    extracted,
    validation,
    // Even if caller asks for committed, buildAutomationReport forces not_committed when status !== valid.
    actionStatus: ACTION_STATUS.committed
  });
  assert.equal(report.validation.status, VALIDATION_STATUS.reviewRequired);
  assert.equal(report.action.status, ACTION_STATUS.notCommitted);

  // Corrupted or empty document is rejected.
  await assert.rejects(
    () => readLocalDocument({ content: '   ', format: 'csv', sourceId: 'empty.csv' }),
    (err) => err.code === 'document_empty'
  );
  await assert.rejects(
    () => readLocalDocument({ content: '{bad-json', format: 'json', sourceId: 'bad.json' }),
    (err) => err.code === 'document_corrupted'
  );
  // Path traversal or secret file access is strictly blocked.
  await assert.rejects(
    () => readLocalDocument({ path: '../../.env' }),
    (err) => err.code === 'document_path_forbidden'
  );
});

test('Case 2 & Case 7: model returning non-conforming JSON or provider quota failure never writes bad data', async () => {
  const doc = await readLocalDocument({ path: 'invoice-valid-1042.csv' });

  // Model returns malformed non-JSON string.
  const brokenJsonModel = {
    async extract() {
      return 'not valid json {{{';
    }
  };
  await assert.rejects(
    () => extractStructuredDocument({ document: doc, mode: 'model' }, { modelRouter: brokenJsonModel }),
    (err) => err.code === 'malformed_model_output'
  );

  // Model returns JSON that violates schema 1.0 (total is a string instead of a finite number).
  const invalidSchemaModel = {
    async extract() {
      return {
        fields: {
          invoice_number: 'INV-1042',
          currency: 'EGP',
          total: 'ألف ومائتان وخمسون'
        }
      };
    }
  };
  await assert.rejects(
    () => extractStructuredDocument({ document: doc, mode: 'model' }, { modelRouter: invalidSchemaModel }),
    (err) => err.code === 'malformed_model_output'
  );

  // Provider outage / free quota exhausted fails closed when fallback is disabled,
  // and falls back safely to deterministic local extraction when allowModelFallback is true.
  const quotaExhaustedModel = {
    async extract() {
      throw Object.assign(new Error('Free tier quota exhausted'), { code: 'quota_exhausted', status: 429 });
    }
  };
  await assert.rejects(
    () =>
      extractStructuredDocument(
        { document: doc, mode: 'model', allowModelFallback: false },
        { modelRouter: quotaExhaustedModel }
      ),
    (err) => err.code === 'quota_exhausted'
  );

  const fallbackExtracted = await extractStructuredDocument(
    { document: doc, mode: 'model', allowModelFallback: true },
    { modelRouter: quotaExhaustedModel }
  );
  assert.equal(fallbackExtracted.fields.invoice_number, 'INV-1042');
  assert.equal(fallbackExtracted.fields.total, 1250);
});

test('Case 3 & Case 4: mismatched total is rejected as invalid, and duplicate invoices are blocked', async () => {
  const badTotalDoc = await readLocalDocument({ path: 'invoice-bad-total.csv' });
  const badExtracted = await extractStructuredDocument({ document: badTotalDoc });
  const badValidation = validateExtractedData({ extracted: badExtracted });

  assert.equal(badValidation.status, VALIDATION_STATUS.invalid);
  assert.ok(badValidation.errors.includes('total_mismatch'));

  const badReport = buildAutomationReport({
    taskId: 'task-bad-total',
    extracted: badExtracted,
    validation: badValidation
  });
  assert.equal(badReport.action.status, ACTION_STATUS.notCommitted);

  // Duplicate invoice detection on valid invoice.
  const validDoc = await readLocalDocument({ path: 'invoice-valid-1042.csv' });
  const validExtracted = await extractStructuredDocument({ document: validDoc });
  const firstValidation = validateExtractedData({ extracted: validExtracted });
  assert.equal(firstValidation.status, VALIDATION_STATUS.valid);

  const secondValidation = validateExtractedData({
    extracted: validExtracted,
    seenFingerprints: [firstValidation.invoice_fingerprint]
  });
  assert.equal(secondValidation.status, VALIDATION_STATUS.invalid);
  assert.ok(secondValidation.errors.includes('duplicate_invoice'));
  assert.equal(secondValidation.duplicate_of, firstValidation.invoice_fingerprint);
});

test('Case 5: malicious prompt injection inside document is isolated and blocks purchase ledger commitment', async (t) => {
  const { runtime, ledgerStore, thread } = await setupAutomationRuntime(t);

  const submitted = await runtime.submit({
    threadId: thread.id,
    message: 'استخرج بيانات الفاتورة invoice-prompt-injection.txt وأضفها إلى سجل المشتريات',
    clientMessageId: 'doc-injection-run-1'
  });

  const finished = await runtime.runToCompletion(submitted.run.id);
  assert.equal(finished.status, 'succeeded');
  assert.equal(ledgerStore.list().length, 0, 'Malicious invoice must NEVER be committed to the purchase ledger');

  const detail = await runtime.detail(submitted.run.id);
  assert.equal(detail.outbox.length, 0, 'No outbox intent is even enqueued when validation is review_required');
  assert.equal(detail.approvals.length, 0);

  const reportRun = detail.toolRuns.find((tr) => tr.toolName === 'data.report');
  assert.ok(reportRun);
  assert.equal(reportRun.outcome.security.promptInjectionDetected, true);
  assert.equal(reportRun.outcome.validation.status, VALIDATION_STATUS.reviewRequired);
  assert.ok(reportRun.outcome.validation.errors.includes('untrusted_instruction_in_document'));
  assert.equal(reportRun.outcome.action.status, ACTION_STATUS.notCommitted);
  assert.equal(detail.verification.verdict, 'PASS');
});

test('Case 6: crash between saving data and recording evidence reconstructs tool_call_reconciled and mid-flight crash parks in needs_reconciliation', async (t) => {
  const { runtime, fixture, thread } = await setupAutomationRuntime(t);

  // 6a: Process saved the tool outcome in agent_tool_runs, then crashed before appendEvidence.
  const doc = await readLocalDocument({ path: 'invoice-valid-1042.csv' });
  const extracted = await extractStructuredDocument({ document: doc });
  const validation = validateExtractedData({ extracted });
  const savedReport = buildAutomationReport({
    taskId: 'task-crash-after-save',
    extracted,
    validation
  });

  const submitted = await runtime.submit({
    threadId: thread.id,
    message: 'استخرج بيانات الفاتورة invoice-valid-1042.csv',
    clientMessageId: 'doc-crash-before-evidence-1'
  });

  assert.equal(await fixture.store.claimRun(submitted.run.id, { leaseMs: 60_000, workerId: 'crashed-worker' }), true);
  const s1 = await fixture.store.appendStep({ runId: submitted.run.id, kind: 'act', title: 'document.read', toolName: 'document.read' });
  const tr1 = await fixture.store.startToolRun({ runId: submitted.run.id, stepId: s1.id, toolName: 'document.read', risk: 'read', idempotencyKey: `${submitted.run.id}:1:document.read` });
  await fixture.store.finishToolRun(tr1.toolRun.id, 'succeeded', JSON.stringify(doc));

  const s2 = await fixture.store.appendStep({ runId: submitted.run.id, kind: 'act', title: 'document.extract', toolName: 'document.extract' });
  const tr2 = await fixture.store.startToolRun({ runId: submitted.run.id, stepId: s2.id, toolName: 'document.extract', risk: 'read', idempotencyKey: `${submitted.run.id}:2:document.extract` });
  await fixture.store.finishToolRun(tr2.toolRun.id, 'succeeded', JSON.stringify(extracted));

  const s3 = await fixture.store.appendStep({ runId: submitted.run.id, kind: 'act', title: 'data.validate', toolName: 'data.validate' });
  const tr3 = await fixture.store.startToolRun({ runId: submitted.run.id, stepId: s3.id, toolName: 'data.validate', risk: 'read', idempotencyKey: `${submitted.run.id}:3:data.validate` });
  await fixture.store.finishToolRun(tr3.toolRun.id, 'succeeded', JSON.stringify(validation));

  const s4 = await fixture.store.appendStep({ runId: submitted.run.id, kind: 'act', title: 'data.report', toolName: 'data.report' });
  const tr4 = await fixture.store.startToolRun({ runId: submitted.run.id, stepId: s4.id, toolName: 'data.report', risk: 'internal_write', idempotencyKey: `${submitted.run.id}:4:data.report` });
  // Data is saved in agent_tool_runs, but the process crashes BEFORE appendEvidence is called!
  await fixture.store.finishToolRun(tr4.toolRun.id, 'succeeded', JSON.stringify(savedReport));
  await fixture.store.heartbeat(submitted.run.id, { leaseMs: -5000 });

  const resumed = await runtime.runToCompletion(submitted.run.id);
  assert.equal(resumed.status, 'succeeded');
  const resumedDetail = await runtime.detail(submitted.run.id);
  assert.ok(
    resumedDetail.evidence.some((e) => e.kind === 'tool_call_reconciled'),
    'Missing evidence after data save is reconstructed as tool_call_reconciled'
  );
  assert.equal(resumedDetail.evidenceChain.ok, true);
  assert.equal(resumedDetail.verification.verdict, 'PASS');

  // 6b: Process crashes mid-flight while tool status is still 'started' -> parks in needs_reconciliation.
  const midFlightSubmit = await runtime.submit({
    threadId: thread.id,
    message: 'استخرج بيانات الفاتورة invoice-valid-1042.csv',
    clientMessageId: 'doc-crash-midflight-2'
  });
  assert.equal(await fixture.store.claimRun(midFlightSubmit.run.id, { leaseMs: 60_000, workerId: 'crashed-worker-2' }), true);
  const stepMid = await fixture.store.appendStep({
    runId: midFlightSubmit.run.id,
    kind: 'act',
    title: 'data.report',
    toolName: 'data.report'
  });
  const inFlight = await fixture.store.startToolRun({
    runId: midFlightSubmit.run.id,
    stepId: stepMid.id,
    toolName: 'data.report',
    risk: 'internal_write',
    idempotencyKey: `${midFlightSubmit.run.id}:${stepMid.index}:data.report`
  });
  await fixture.store.heartbeat(midFlightSubmit.run.id, { leaseMs: -5000 });

  const recovered = await runtime.runToCompletion(midFlightSubmit.run.id);
  assert.equal(recovered.status, 'needs_reconciliation');
  const midDetail = await runtime.detail(midFlightSubmit.run.id);
  const crashedToolRun = midDetail.toolRuns.find((tr) => tr.id === inFlight.toolRun.id);
  assert.equal(crashedToolRun.status, 'unknown');
});

test('Case 8: full 8-step invoice workflow gates write behind WAITING_FOR_APPROVAL, commits once, prevents replay duplicates, and passes Independent Verifier', async (t) => {
  const { runtime, tools, ledgerStore, thread } = await setupAutomationRuntime(t);

  // Direct policy check: attempting to validateInput on document.commit_purchase_ledger with non-valid status is refused.
  const policyBlock = tools.validateInput('document.commit_purchase_ledger', {
    invoice_fingerprint: 'fp_1',
    invoice_number: 'INV-1042',
    supplier_name: 'شركة النور',
    total: 1250,
    validation_status: 'review_required'
  });
  assert.equal(policyBlock.ok, false);
  assert.equal(policyBlock.code, 'policy_violation_unvalidated_document');

  // Submit full workflow: read -> extract -> validate -> report -> gate -> approve -> commit -> verify.
  const submitted = await runtime.submit({
    threadId: thread.id,
    message: 'استخرج بيانات الفاتورة invoice-valid-1042.csv وأضفها إلى سجل المشتريات',
    clientMessageId: 'doc-full-commit-1'
  });

  const parked = await runtime.runToCompletion(submitted.run.id);
  assert.equal(parked.status, 'waiting_approval');
  assert.equal(ledgerStore.list().length, 0, 'Zero writes before owner approval');

  const parkedDetail = await runtime.detail(submitted.run.id);
  assert.equal(parkedDetail.plan.state, 'WAITING_FOR_APPROVAL');
  assert.equal(parkedDetail.plan.proposedEffect.toolName, 'document.commit_purchase_ledger');
  assert.equal(parkedDetail.plan.proposedEffect.payload.invoice_number, 'INV-1042');
  assert.equal(parkedDetail.plan.proposedEffect.payload.total, 1250);

  // Approve and resume.
  const approved = await runtime.approve(submitted.run.id, {
    decision: 'approved',
    note: 'موافقة على إدراج الفاتورة INV-1042 في سجل المشتريات',
    idempotencyKey: 'approve-invoice-1042'
  });
  assert.equal(approved.resumed, true);

  const finished = await runtime.runToCompletion(submitted.run.id);
  assert.equal(finished.status, 'succeeded');
  assert.equal(ledgerStore.list().length, 1, 'Exactly one record committed to the purchase ledger');
  assert.equal(ledgerStore.list()[0].invoice_number, 'INV-1042');
  assert.equal(ledgerStore.list()[0].total, 1250);

  const finalDetail = await runtime.detail(submitted.run.id);
  assert.equal(finalDetail.verification.verdict, 'PASS');
  assert.equal(finalDetail.evidenceChain.ok, true);

  // Re-running the same file in a second run detects the already-committed fingerprint and refuses a second commit!
  const secondSubmit = await runtime.submit({
    threadId: thread.id,
    message: 'استخرج بيانات الفاتورة invoice-valid-1042.csv وأضفها إلى سجل المشتريات',
    clientMessageId: 'doc-full-commit-duplicate-2'
  });
  const secondFinished = await runtime.runToCompletion(secondSubmit.run.id);
  assert.equal(secondFinished.status, 'succeeded');
  assert.equal(ledgerStore.list().length, 1, 'Duplicate run must NOT create a second record');

  const secondDetail = await runtime.detail(secondSubmit.run.id);
  const secondReport = secondDetail.toolRuns.find((tr) => tr.toolName === 'data.report');
  assert.equal(secondReport.outcome.validation.status, VALIDATION_STATUS.invalid);
  assert.ok(secondReport.outcome.validation.errors.includes('duplicate_invoice'));
  assert.equal(secondReport.outcome.action.status, ACTION_STATUS.notCommitted);
  assert.equal(secondDetail.outbox.length, 0);
});
