import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  createTempStore,
  createFakeCalendar
} from './support/agent-fixtures.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createDemoPlanner } from '../src/agent/planner.js';
import { createDefaultTools } from '../src/agent/tools.js';
import { createAgentRouter } from '../src/agent-routes.js';
import {
  HARNESS_LIFECYCLE_STAGES,
  HARNESS_COMPONENT_IDS,
  PLAN_LIFECYCLE_STATE,
  verifyApprovedEffectIntegrity
} from '../src/agent/harness.js';
import { hashOf } from '../src/agent/evidence.js';

const OWNER_TOKEN = 'test-owner-token-harness-0123456789abcdef';

async function setupHarness(t, { connectors = null } = {}) {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const calendar = createFakeCalendar();
  const tools = createDefaultTools({ statusProvider: () => ({ version: '0.2.1', storage: 'sqlite' }) });
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools,
    planner: createDemoPlanner(),
    connectors: connectors || calendar.connectors,
    limits: { maxSteps: 12, maxCostMicros: 100_000 },
    workerId: 'test-worker',
    logger: { error() {} }
  });
  t.after(() => runtime.shutdown().catch(() => {}));
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'اختبار الحزام' });
  return { fixture, calendar, runtime, thread };
}

async function startTestServer(runtime) {
  const app = express();
  const agent = {
    mode: 'sqlite',
    ready: Promise.resolve(runtime),
    async status() {
      return runtime.status();
    },
    async get() {
      return runtime;
    }
  };
  const authorize = (req, res, next) => {
    const header = req.get('authorization') || '';
    if (header !== `Bearer ${OWNER_TOKEN}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    return next();
  };
  app.use('/api/agent', createAgentRouter({ agent, authorize }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', token = OWNER_TOKEN, headers = {}, body } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const payload = await response.json().catch(() => ({}));
    return { status: response.status, payload };
  };
  return {
    baseUrl,
    call,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test('Plan lifecycle positive path: PLAN_READY → WAITING_FOR_APPROVAL → APPROVED → EXECUTING', async (t) => {
  const { runtime, calendar, thread } = await setupHarness(t);

  const submitted = await runtime.submit({
    threadId: thread.id,
    message: 'أنشئ موعد مراجعة خطة الربع الرابع غدًا',
    clientMessageId: 'plan-lifecycle-positive-1'
  });

  const parked = await runtime.runToCompletion(submitted.run.id);
  assert.equal(parked.status, 'waiting_approval');
  assert.equal(calendar.sends.length, 0, 'Nothing executes while WAITING_FOR_APPROVAL');

  const parkedDetail = await runtime.detail(submitted.run.id);
  assert.equal(parkedDetail.plan.state, PLAN_LIFECYCLE_STATE.waitingForApproval);
  assert.deepEqual(parkedDetail.plan.transitions, [
    PLAN_LIFECYCLE_STATE.planReady,
    PLAN_LIFECYCLE_STATE.waitingForApproval
  ]);
  assert.equal(parkedDetail.plan.stages.length, 4);
  assert.equal(parkedDetail.plan.proposedEffect.toolName, 'google.calendar_create_event');
  assert.ok(parkedDetail.goalContract.required_outcome);
  assert.ok(Array.isArray(parkedDetail.goalContract.missing_information));

  const approved = await runtime.approve(submitted.run.id, {
    decision: 'approved',
    note: 'موافق على الخطة كما عُرضت',
    idempotencyKey: 'approve-positive-1'
  });
  assert.equal(approved.resumed, true);

  const finished = await runtime.runToCompletion(submitted.run.id);
  assert.equal(finished.status, 'succeeded');
  assert.equal(calendar.sends.length, 1);

  const finalDetail = await runtime.detail(submitted.run.id);
  assert.equal(finalDetail.plan.state, PLAN_LIFECYCLE_STATE.executing);
  assert.deepEqual(finalDetail.plan.transitions, [
    PLAN_LIFECYCLE_STATE.planReady,
    PLAN_LIFECYCLE_STATE.waitingForApproval,
    PLAN_LIFECYCLE_STATE.approved,
    PLAN_LIFECYCLE_STATE.executing
  ]);
  assert.equal(finalDetail.verification.verdict, 'PASS');
  assert.equal(finalDetail.evidenceChain.ok, true);
});

test('Plan lifecycle counter-test 1 (EDITED): PLAN_READY → WAITING_FOR_APPROVAL → EDITED → WAITING_FOR_APPROVAL → APPROVED → EXECUTING', async (t) => {
  const { runtime, calendar, thread } = await setupHarness(t);

  const submitted = await runtime.submit({
    threadId: thread.id,
    message: 'أنشئ موعد مراجعة أسبوعية',
    clientMessageId: 'plan-lifecycle-edited-1'
  });

  await runtime.runToCompletion(submitted.run.id);
  assert.equal(calendar.sends.length, 0);

  const beforeEdit = await runtime.detail(submitted.run.id);
  const editedArgs = {
    ...beforeEdit.plan.proposedEffect.payload,
    summary: 'موعد الخطة المعدّلة والمعتمدة #2'
  };

  // Edit the parked plan: must re-validate policies, record EDITED, and stay in WAITING_FOR_APPROVAL.
  const edited = await runtime.approve(submitted.run.id, {
    decision: 'edited',
    payload: editedArgs,
    note: 'تغيير عنوان الموعد وإعادة طلب الموافقة',
    idempotencyKey: 'edit-plan-key-1'
  });

  assert.equal(edited.resumed, false, 'EDITED must never execute or resume the run before re-approval');
  assert.equal(edited.run.status, 'waiting_approval');
  assert.equal(calendar.sends.length, 0, 'No external call is dispatched on EDITED');
  assert.equal(edited.plan.revision, 2);
  assert.equal(edited.plan.state, PLAN_LIFECYCLE_STATE.waitingForApproval);
  assert.deepEqual(edited.plan.transitions, [
    PLAN_LIFECYCLE_STATE.planReady,
    PLAN_LIFECYCLE_STATE.waitingForApproval,
    PLAN_LIFECYCLE_STATE.edited,
    PLAN_LIFECYCLE_STATE.waitingForApproval
  ]);
  assert.deepEqual(edited.plan.proposedEffect.payload, editedArgs);
  assert.equal(edited.approvals.length, 2);
  assert.equal(edited.approvals[0].decision, 'edited');
  assert.equal(edited.approvals[1].decision, 'pending');

  // Policy violation on edit (wrong tool name or non-object payload) must be rejected without mutating state.
  await assert.rejects(
    () =>
      runtime.editPlan(submitted.run.id, {
        payload: null
      }),
    (err) => err.code === 'plan_edit_payload_required'
  );
  await assert.rejects(
    () =>
      runtime.editPlan(submitted.run.id, {
        payload: editedArgs,
        summary: { toolName: 'celia.system_status' }
      }),
    (err) => err.code === 'plan_edit_tool_mismatch'
  );

  // Now approve the edited plan: must execute the EDITED payload, never the initial payload.
  const approved = await runtime.approve(submitted.run.id, {
    decision: 'approved',
    note: 'اعتماد النسخة المعدّلة #2',
    idempotencyKey: 'approve-edited-key-1'
  });
  assert.equal(approved.resumed, true);

  const finished = await runtime.runToCompletion(submitted.run.id);
  assert.equal(finished.status, 'succeeded');
  assert.equal(calendar.sends.length, 1);
  assert.equal(calendar.sends[0].event.summary, 'موعد الخطة المعدّلة والمعتمدة #2');

  const finalDetail = await runtime.detail(submitted.run.id);
  assert.equal(finalDetail.plan.state, PLAN_LIFECYCLE_STATE.executing);
  assert.deepEqual(finalDetail.plan.transitions, [
    PLAN_LIFECYCLE_STATE.planReady,
    PLAN_LIFECYCLE_STATE.waitingForApproval,
    PLAN_LIFECYCLE_STATE.edited,
    PLAN_LIFECYCLE_STATE.waitingForApproval,
    PLAN_LIFECYCLE_STATE.approved,
    PLAN_LIFECYCLE_STATE.executing
  ]);
  assert.equal(finalDetail.verification.verdict, 'PASS');
  assert.equal(finalDetail.evidenceChain.ok, true);
  assert.ok(finalDetail.evidence.some((entry) => entry.kind === 'plan_edited'));
});

test('Plan lifecycle counter-test 2 (REJECTED): PLAN_READY → WAITING_FOR_APPROVAL → REJECTED blocks execution completely', async (t) => {
  const { runtime, calendar, thread } = await setupHarness(t);

  const submitted = await runtime.submit({
    threadId: thread.id,
    message: 'أنشئ موعد مراجعة سيُرفض',
    clientMessageId: 'plan-lifecycle-rejected-1'
  });
  await runtime.runToCompletion(submitted.run.id);

  const rejected = await runtime.approve(submitted.run.id, {
    decision: 'rejected',
    note: 'رفض قاطع من المالك',
    idempotencyKey: 'reject-plan-key-1'
  });

  assert.equal(rejected.resumed, false);
  assert.equal(rejected.run.status, 'cancelled');
  assert.equal(rejected.plan.state, PLAN_LIFECYCLE_STATE.rejected);
  assert.deepEqual(rejected.plan.transitions, [
    PLAN_LIFECYCLE_STATE.planReady,
    PLAN_LIFECYCLE_STATE.waitingForApproval,
    PLAN_LIFECYCLE_STATE.rejected
  ]);
  assert.equal(calendar.sends.length, 0);

  const detail = await runtime.detail(submitted.run.id);
  assert.equal(detail.outbox.length, 1);
  assert.equal(detail.outbox[0].status, 'cancelled');
  assert.equal(
    detail.toolRuns.filter((tr) => tr.toolName === 'calendar.create_event').length,
    0,
    'Rejected external tool is never executed'
  );
});

test('War-Room Adversarial Test: post-approval payload tampering is blocked before any external dispatch', async (t) => {
  const { runtime, calendar, fixture, thread } = await setupHarness(t);

  const submitted = await runtime.submit({
    threadId: thread.id,
    message: 'أنشئ موعد اجتماع آمن',
    clientMessageId: 'tamper-test-1'
  });
  await runtime.runToCompletion(submitted.run.id);

  // Record owner approval directly in store without immediately starting the loop,
  // then tamper with the outbox payload in the database to simulate silent post-approval mutation.
  const approvals = await fixture.store.listApprovals(submitted.run.id);
  await fixture.store.decideApproval({
    approvalId: approvals[0].id,
    decision: 'approved',
    actor: 'owner',
    note: 'موافقة على الحمولة الأصلية فقط',
    decisionKey: 'tamper-approve-key-1'
  });
  const outboxBefore = await fixture.store.listOutbox(submitted.run.id);
  const tamperedPayload = {
    ...outboxBefore[0].payload,
    summary: 'اجتماع خبيث تم حقنه بعد الموافقة'
  };
  await fixture.driver.run(
    `UPDATE agent_outbox SET payload = ? WHERE id = ?`,
    [JSON.stringify(tamperedPayload), outboxBefore[0].id]
  );

  const outboxAfter = (await fixture.store.listOutbox(submitted.run.id))[0];
  const approvalAfter = (await fixture.store.listApprovals(submitted.run.id))[0];
  const integrity = verifyApprovedEffectIntegrity({
    entry: outboxAfter,
    approval: approvalAfter
  });
  assert.equal(integrity.ok, false);
  assert.equal(integrity.code, 'post_approval_payload_tampered');

  await fixture.store.requeueRun(submitted.run.id);
  const finished = await runtime.runToCompletion(submitted.run.id);

  assert.equal(finished.status, 'failed');
  assert.equal(finished.lastError, 'post_approval_payload_tampered');
  assert.equal(calendar.sends.length, 0, 'Tampered outbox row must NEVER be dispatched to the connector');
});

test('Agent Harness HTTP API: GET /api/agent/harness and GET/POST /api/agent/runs/:id/plan', async (t) => {
  const { runtime, calendar } = await setupHarness(t);
  const server = await startTestServer(runtime);
  t.after(() => server.close());

  const harnessRes = await server.call('/api/agent/harness');
  assert.equal(harnessRes.status, 200);
  assert.equal(harnessRes.payload.ok, true);
  assert.deepEqual(harnessRes.payload.lifecycle, HARNESS_LIFECYCLE_STAGES);
  assert.equal(harnessRes.payload.components.length, 10);
  assert.deepEqual(
    harnessRes.payload.components.map((c) => c.id),
    HARNESS_COMPONENT_IDS
  );

  const threadRes = await server.call('/api/agent/threads', {
    method: 'POST',
    body: { title: 'خيط HTTP للخطة' }
  });
  const runRes = await server.call(`/api/agent/threads/${threadRes.payload.thread.id}/runs`, {
    method: 'POST',
    body: { message: 'أنشئ موعد مراجعة عبر مسار HTTP', clientMessageId: 'http-plan-1' }
  });
  const runId = runRes.payload.runId;
  await runtime.runToCompletion(runId);

  const planGet = await server.call(`/api/agent/runs/${runId}/plan`);
  assert.equal(planGet.status, 200);
  assert.equal(planGet.payload.plan.state, 'WAITING_FOR_APPROVAL');

  const updatedPayload = {
    ...planGet.payload.plan.proposedEffect.payload,
    summary: 'موعد معدل عبر POST /plan'
  };
  const planEdit = await server.call(`/api/agent/runs/${runId}/plan`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'http-edit-key-1' },
    body: { payload: updatedPayload, note: 'تعديل عبر نقطة الخطة' }
  });
  assert.equal(planEdit.status, 200);
  assert.equal(planEdit.payload.resumed, false);
  assert.equal(planEdit.payload.plan.revision, 2);
  assert.equal(planEdit.payload.plan.proposedEffect.payload.summary, 'موعد معدل عبر POST /plan');
  assert.equal(planEdit.payload.outbox[0].payloadHash, hashOf(updatedPayload));

  // Idempotent replay with same Idempotency-Key returns same state without bumping revision to 3.
  const planEditReplay = await server.call(`/api/agent/runs/${runId}/plan`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'http-edit-key-1' },
    body: { payload: updatedPayload, note: 'تعديل عبر نقطة الخطة' }
  });
  assert.equal(planEditReplay.status, 200);
  assert.equal(planEditReplay.payload.idempotentReplay, true);
  assert.equal(planEditReplay.payload.plan.revision, 2);

  const approveRes = await server.call(`/api/agent/runs/${runId}/approval`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'http-approve-key-1' },
    body: { decision: 'approved', note: 'موافقة نهائية' }
  });
  assert.equal(approveRes.status, 200);
  assert.equal(approveRes.payload.resumed, true);

  const finalRun = await runtime.runToCompletion(runId);
  assert.equal(finalRun.status, 'succeeded');
  assert.equal(calendar.sends.length, 1);
  assert.equal(calendar.sends[0].event.summary, 'موعد معدل عبر POST /plan');
});
