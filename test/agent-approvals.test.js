import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTempStore,
  createRecordingTools,
  threeReadsThenFinish
} from './support/agent-fixtures.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createScriptedPlanner, createDemoPlanner } from '../src/agent/planner.js';
import { createDefaultTools } from '../src/agent/tools.js';
import { RUN_STATUS, TOOL_RUN_STATUS, APPROVAL_DECISION } from '../src/agent/store.js';

async function setup(t, { planner, tools, limits } = {}) {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const recorder = tools || createRecordingTools();
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: recorder.tools,
    planner: planner || createScriptedPlanner(threeReadsThenFinish()),
    limits: { maxSteps: 12, maxCostMicros: 100_000, ...limits },
    workerId: 'test-worker',
    logger: { error() {} }
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'موافقات' });
  const submit = async (message = 'مهمة', clientMessageId = null) =>
    runtime.submit({ threadId: thread.id, message, clientMessageId });
  return { fixture, recorder, runtime, thread, submit };
}

test('approval gate: an external effect parks the run with a durable pending approval and executes nothing', async (t) => {
  const { runtime, recorder, submit, fixture } = await setup(t, {
    planner: createScriptedPlanner([{ action: 'call', tool: 'calendar.create', args: { summary: 'اجتماع' } }])
  });
  const { run } = await submit('أنشئ موعدًا');
  const finished = await runtime.runToCompletion(run.id);

  assert.equal(finished.status, RUN_STATUS.waitingApproval);
  assert.equal(finished.lastError, 'approval_required');
  assert.equal(recorder.calls.length, 0, 'no external tool executes while the gate is open');

  const approvals = await fixture.store.listApprovals(run.id);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].decision, APPROVAL_DECISION.pending);
  assert.equal(approvals[0].toolName, 'calendar.create');
  assert.equal(approvals[0].idempotencyKey, `approval:${run.id}:calendar.create`);
  assert.ok(approvals[0].requestedAt);

  const detail = await runtime.detail(run.id);
  assert.equal(detail.approvals[0].id, approvals[0].id);
  assert.equal(detail.steps.at(-1).kind, 'decide');
});

test('approval gate: a repeated request for the same tool reuses the approval row instead of cloning it', async (t) => {
  const { fixture } = await setup(t);
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'idempotent' });
  const run = await fixture.store.createRun({
    threadId: thread.id,
    ownerId: 'owner',
    planner: 'scripted',
    maxSteps: 5,
    maxCostMicros: 1000
  });
  const key = `approval:${run.run.id}:calendar.create`;
  const first = await fixture.store.requestApproval({
    runId: run.run.id,
    toolName: 'calendar.create',
    risk: 'external_effect',
    idempotencyKey: key
  });
  const second = await fixture.store.requestApproval({
    runId: run.run.id,
    toolName: 'calendar.create',
    risk: 'external_effect',
    idempotencyKey: key
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.approval.id, first.approval.id);
  assert.equal((await fixture.store.listApprovals(run.run.id)).length, 1);
});

test('approval gate: an approved run resumes and completes without replaying any unknown call', async (t) => {
  const { runtime, recorder, submit } = await setup(t, {
    planner: createScriptedPlanner([{ action: 'call', tool: 'calendar.create', args: { summary: 'اجتماع' } }])
  });
  const { run } = await submit('أنشئ موعدًا', 'approval-approve-01');
  await runtime.runToCompletion(run.id);

  const result = await runtime.approve(run.id, { decision: 'approved', note: 'موافقة اختبار' });
  assert.equal(result.resumed, true);
  assert.equal(result.approvals[0].decision, APPROVAL_DECISION.approved);
  assert.equal(result.approvals[0].actor, 'owner');
  assert.equal(result.approvals[0].note, 'موافقة اختبار');

  const completed = await runtime.runToCompletion(run.id);
  assert.equal(completed.status, RUN_STATUS.succeeded);
  assert.equal(recorder.calls.length, 0, 'the external connector still does not exist; approval alone never executes');

  const detail = await runtime.detail(run.id);
  const approvalEvidence = detail.evidence.filter((entry) => entry.kind === 'approval');
  assert.equal(approvalEvidence.length, 1);
  assert.equal(approvalEvidence[0].verdict, 'PASS');
  assert.equal(detail.verification.verdict, 'PASS');
});

test('approval gate: the demo planner turns an approved external request into a bounded delivery naming AGENT-002', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: createDefaultTools({ statusProvider: () => ({ version: '0.2.1', storage: 'test' }) }),
    planner: createDemoPlanner(),
    logger: { error() {} }
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'تقويم' });
  const submitted = await runtime.submit({
    threadId: thread.id,
    message: 'أنشئ موعد اجتماع الأسبوع القادم',
    clientMessageId: 'demo-approval-001'
  });
  assert.equal((await runtime.runToCompletion(submitted.run.id)).status, RUN_STATUS.waitingApproval);
  await runtime.approve(submitted.run.id, { decision: 'approved' });
  const finished = await runtime.runToCompletion(submitted.run.id);
  assert.equal(finished.status, RUN_STATUS.succeeded);
  const detail = await runtime.detail(submitted.run.id);
  assert.match(detail.steps.at(-1).summary, /AGENT-002/);
  assert.match(detail.steps.at(-1).summary, /لم يُجرَ أي اتصال خارجي/);
  assert.equal(detail.verification.verdict, 'PASS');
});

test('approval gate: rejection cancels the run and leaves no tool run or external trace', async (t) => {
  const { runtime, recorder, submit, fixture } = await setup(t, {
    planner: createScriptedPlanner([{ action: 'call', tool: 'calendar.create', args: {} }])
  });
  const { run } = await submit('موعد مرفوض', 'approval-reject-01');
  await runtime.runToCompletion(run.id);
  const result = await runtime.approve(run.id, { decision: 'rejected', note: 'لا الآن' });
  assert.equal(result.resumed, false);
  assert.equal(result.run.status, RUN_STATUS.cancelled);
  assert.equal(result.run.lastError, 'approval_rejected');
  assert.equal(recorder.calls.length, 0);
  assert.equal((await fixture.store.listToolRuns(run.id)).length, 0, 'rejection never created a tool invocation row');

  const approvals = await fixture.store.listApprovals(run.id);
  assert.equal(approvals[0].decision, APPROVAL_DECISION.rejected);
  const evidence = await fixture.store.listEvidence(run.id);
  const approvalEvidence = evidence.filter((entry) => entry.kind === 'approval');
  assert.equal(approvalEvidence[0].verdict, 'BLOCK');
});

test('approval gate: the same decision key is idempotent, a different decision afterwards conflicts', async (t) => {
  const { runtime, submit, fixture } = await setup(t, {
    planner: createScriptedPlanner([{ action: 'call', tool: 'calendar.create', args: {} }])
  });
  const { run } = await submit('موعد', 'approval-idem-01');
  await runtime.runToCompletion(run.id);
  const [pending] = await fixture.store.listApprovals(run.id);

  const first = await fixture.store.decideApproval({
    approvalId: pending.id,
    decision: 'approved',
    actor: 'owner',
    decisionKey: 'decision-key-0001'
  });
  assert.equal(first.changed, true);
  const retry = await fixture.store.decideApproval({
    approvalId: pending.id,
    decision: 'approved',
    actor: 'owner',
    decisionKey: 'decision-key-0001'
  });
  assert.equal(retry.changed, false);
  assert.equal(retry.approval.id, pending.id);

  await assert.rejects(
    () =>
      fixture.store.decideApproval({
        approvalId: pending.id,
        decision: 'rejected',
        actor: 'owner',
        decisionKey: 'decision-key-0002'
      }),
    /approval_already_decided/
  );
});

test('approval gate: an unknown tool outcome forces reconciliation and refuses the approval', async (t) => {
  const { runtime, submit, fixture } = await setup(t, {
    planner: createScriptedPlanner([{ action: 'call', tool: 'calendar.create', args: {} }])
  });
  const { run } = await submit('موعد غامض', 'approval-unknown-01');
  await runtime.runToCompletion(run.id);
  assert.equal((await fixture.store.getRun(run.id)).status, RUN_STATUS.waitingApproval);

  // Simulate an interrupted in-flight call left behind before the owner decision.
  const step = await fixture.store.appendStep({ runId: run.id, kind: 'act', title: 'calendar.create' });
  const started = await fixture.store.startToolRun({
    runId: run.id,
    stepId: step.id,
    toolName: 'calendar.create',
    risk: 'external_effect',
    idempotencyKey: `${run.id}:${step.index}:calendar.create`
  });
  await fixture.store.finishToolRun(started.toolRun.id, TOOL_RUN_STATUS.unknown, JSON.stringify({ reason: 'process_interrupted' }));

  await assert.rejects(
    () => runtime.approve(run.id, { decision: 'approved' }),
    (error) => error.status === 409 && error.code === 'reconciliation_required'
  );
  assert.equal((await fixture.store.getRun(run.id)).status, RUN_STATUS.needsReconciliation);
  const approvals = await fixture.store.listApprovals(run.id);
  assert.equal(approvals[0].decision, APPROVAL_DECISION.pending, 'the approval stays pending until reconciliation');
});

test('approval gate: decisions on non-waiting runs or by other owners are refused', async (t) => {
  const { runtime, submit } = await setup(t);
  const { run } = await submit('مهمة عادية', 'approval-guard-01');
  await runtime.runToCompletion(run.id);
  assert.equal((await runtime.detail(run.id)).run.status, RUN_STATUS.succeeded);

  await assert.rejects(
    () => runtime.approve(run.id, { decision: 'approved' }),
    (error) => error.status === 409 && error.code === 'run_not_waiting_approval'
  );
  await assert.rejects(
    () => runtime.approve(run.id, { decision: 'maybe' }),
    (error) => error.status === 400 && error.code === 'invalid_approval_decision'
  );
  await assert.rejects(
    () => runtime.approve(run.id, { decision: 'approved' }, 'intruder'),
    (error) => error.status === 404 && error.code === 'run_not_found'
  );
});

test('approval gate: an approved tool that still lacks a connector fails honestly instead of looping', async (t) => {
  // Two identical external decisions: after approval the planner asks again, proving
  // the runtime safety net never fakes execution or parks the run forever.
  const { runtime, submit } = await setup(t, {
    planner: createScriptedPlanner([
      { action: 'call', tool: 'calendar.create', args: {} },
      { action: 'call', tool: 'calendar.create', args: {} }
    ])
  });
  const { run } = await submit('موعد مكرر الطلب', 'approval-safetynet-01');
  await runtime.runToCompletion(run.id);
  await runtime.approve(run.id, { decision: 'approved' });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.failed);
  assert.equal(finished.lastError, 'external_connector_unavailable');
  const detail = await runtime.detail(run.id);
  assert.equal(detail.toolRuns.length, 0, 'still no fabricated external invocation');
});
