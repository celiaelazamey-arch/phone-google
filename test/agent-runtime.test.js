import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempStore, createRecordingTools, createObservedPlanner, threeReadsThenFinish } from './support/agent-fixtures.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createScriptedPlanner } from '../src/agent/planner.js';
import { createDefaultTools } from '../src/agent/tools.js';
import { RUN_STATUS, TOOL_RUN_STATUS } from '../src/agent/store.js';

async function setup(t, { limits, tools, planner } = {}) {
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
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'مهمة اختبار' });
  const submit = async (message = 'مهمة', clientMessageId = null) =>
    runtime.submit({ threadId: thread.id, message, clientMessageId });
  return { fixture, recorder, runtime, thread, submit };
}

test('M1: one task runs a multi-step loop and delivers a durable summary', async (t) => {
  const { runtime, recorder, submit } = await setup(t);
  const { run } = await submit('لخّص حالة النظام');
  const finished = await runtime.runToCompletion(run.id);

  assert.equal(finished.status, RUN_STATUS.succeeded);
  assert.deepEqual(
    recorder.calls.map((call) => call.name),
    ['read.alpha', 'read.beta', 'read.gamma']
  );
  const detail = await runtime.detail(run.id);
  assert.ok(detail.steps.length >= 6, 'act + observe steps are persisted');
  assert.equal(detail.steps.at(-1).kind, 'deliver');
  assert.match(detail.steps.at(-1).summary, /اكتملت المهمة/);
  assert.equal(detail.toolRuns.every((toolRun) => toolRun.status === TOOL_RUN_STATUS.succeeded), true);
  assert.equal(detail.run.usage.steps, detail.steps.length);
});

test('M1: repeating the same client_message_id returns the same run and never executes twice', async (t) => {
  const { runtime, recorder, submit, fixture, thread } = await setup(t);
  const first = await submit('مهمة مكررة', 'duplicate-key-01');
  const second = await submit('مهمة مكررة', 'duplicate-key-01');
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.run.id, first.run.id);
  assert.equal((await fixture.store.listMessages(thread.id)).length, 1);
  assert.equal((await fixture.store.listRuns(thread.id)).length, 1);

  await runtime.runToCompletion(first.run.id);
  await runtime.runToCompletion(second.run.id);
  assert.equal(recorder.calls.length, 3, 'a second start of the same run does not replay tools');
});

test('M1: a new process resumes an interrupted run from the last confirmed step', async (t) => {
  const { runtime, recorder, submit, fixture } = await setup(t, { planner: createObservedPlanner() });
  const { run } = await submit('استئناف');
  // Simulate the old process: claimed, one confirmed tool call, then it died.
  assert.equal(await fixture.store.claimRun(run.id, { leaseMs: 60_000, workerId: 'dead-worker' }), true);
  const step = await fixture.store.appendStep({ runId: run.id, kind: 'act', title: 'read.alpha' });
  const started = await fixture.store.startToolRun({
    runId: run.id,
    stepId: step.id,
    toolName: 'read.alpha',
    risk: 'read',
    idempotencyKey: `${run.id}:${step.index}:read.alpha`
  });
  await fixture.store.finishToolRun(started.toolRun.id, TOOL_RUN_STATUS.succeeded, JSON.stringify({ alpha: true }));
  await fixture.store.appendStep({ runId: run.id, kind: 'observe', title: 'read.alpha ✓', summary: 'ok' });
  await fixture.store.heartbeat(run.id, { leaseMs: -5_000 });

  const resumed = await runtime.runToCompletion(run.id);
  assert.equal(resumed.status, RUN_STATUS.succeeded);
  assert.deepEqual(
    recorder.calls.map((call) => call.name),
    ['read.beta', 'read.gamma'],
    'the confirmed step is not executed again'
  );
  const detail = await runtime.detail(run.id);
  assert.equal(detail.steps.filter((item) => item.title === 'read.alpha').length, 1);
});

test('M1: a call in flight during a crash is marked unknown, never replayed', async (t) => {
  const { runtime, recorder, submit, fixture } = await setup(t);
  const { run } = await submit('انقطاع');
  assert.equal(await fixture.store.claimRun(run.id, { leaseMs: 60_000, workerId: 'dead-worker' }), true);
  const step = await fixture.store.appendStep({ runId: run.id, kind: 'act', title: 'read.alpha' });
  const inFlight = await fixture.store.startToolRun({
    runId: run.id,
    stepId: step.id,
    toolName: 'read.alpha',
    risk: 'read',
    idempotencyKey: `${run.id}:${step.index}:read.alpha`
  });
  await fixture.store.heartbeat(run.id, { leaseMs: -5_000 });

  const result = await runtime.runToCompletion(run.id);
  assert.equal(result.status, RUN_STATUS.needsReconciliation);
  assert.equal(recorder.calls.length, 0, 'no blind retry of the unknown call');
  const toolRuns = await fixture.store.listToolRuns(run.id);
  assert.equal(toolRuns.find((toolRun) => toolRun.id === inFlight.toolRun.id).status, TOOL_RUN_STATUS.unknown);
  const detail = await runtime.detail(run.id);
  assert.match(detail.steps.at(-1).summary, /لا إعادة تنفيذ عمياء/);
});

test('M1: two workers cannot execute the same run concurrently', async (t) => {
  const { runtime, recorder, submit, fixture } = await setup(t);
  const { run } = await submit('تزامن');
  const second = createAgentRuntime({
    store: fixture.store,
    tools: recorder.tools,
    planner: createScriptedPlanner(threeReadsThenFinish()),
    workerId: 'other-worker',
    logger: { error() {} }
  });
  const [a, b] = await Promise.all([runtime.runToCompletion(run.id), second.runToCompletion(run.id)]);
  assert.equal(a.status, RUN_STATUS.succeeded);
  assert.equal(recorder.calls.length, 3, 'exactly one worker executed the three tools');
  assert.ok([a.id, b.id].includes(run.id));
});

test('M1: cancellation stops between steps without any further tool call', async (t) => {
  const { runtime, recorder, submit } = await setup(t, {
    tools: createRecordingTools({ slowMs: 60 }),
    planner: createScriptedPlanner(Array.from({ length: 6 }, () => ({ action: 'call', tool: 'read.alpha', args: {} })))
  });
  const { run } = await submit('إلغاء');
  const running = runtime.start(run.id);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const detail = await runtime.detail(run.id).catch(() => null);
    if (detail?.steps.length >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await runtime.cancel(run.id);
  const finished = await running;
  assert.equal(finished.run.status, RUN_STATUS.cancelled);
  const callsAtCancel = recorder.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(recorder.calls.length, callsAtCancel, 'cancelled run makes no further calls');
});

test('M1: external effects are refused with waiting_approval instead of executed', async (t) => {
  const { runtime, recorder, submit } = await setup(t, {
    planner: createScriptedPlanner([{ action: 'call', tool: 'calendar.create', args: { summary: 'اجتماع' } }])
  });
  const { run } = await submit('أنشئ موعدًا');
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.waitingApproval);
  assert.equal(recorder.calls.length, 0);
  const detail = await runtime.detail(run.id);
  assert.match(detail.steps.at(-1).summary, /AGENT-002/);
});

test('M1: irreversible sandbox execution is refused before any isolation exists', async (t) => {
  const { runtime, submit } = await setup(t, {
    planner: createScriptedPlanner([{ action: 'call', tool: 'sandbox.exec', args: { code: 'ls' } }])
  });
  const { run } = await submit('نفّذ كودًا');
  assert.equal((await runtime.runToCompletion(run.id)).status, RUN_STATUS.waitingApproval);
});

test('M1: an unregistered tool fails the run without side effects', async (t) => {
  const { runtime, recorder, submit } = await setup(t, {
    planner: createScriptedPlanner([{ action: 'call', tool: 'not.registered', args: {} }])
  });
  const { run } = await submit('أداة مجهولة');
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.failed);
  assert.equal(finished.lastError, 'unknown_tool');
  assert.equal(recorder.calls.length, 0);
});

test('M1: the step budget stops the loop and reports budget_exhausted', async (t) => {
  const { runtime, recorder, submit } = await setup(t, {
    limits: { maxSteps: 3 },
    planner: createScriptedPlanner(Array.from({ length: 6 }, () => ({ action: 'call', tool: 'read.alpha', args: {} })))
  });
  const { run } = await submit('ميزانية');
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.budgetExhausted);
  assert.equal(finished.lastError, 'step_budget_exhausted');
  assert.ok(recorder.calls.length <= 2);
});

test('M1: a failing read tool ends with a truthful failure summary, not a fake success', async (t) => {
  const { runtime, submit } = await setup(t, {
    tools: createRecordingTools({ failTools: { beta: true } }),
    planner: createObservedPlanner()
  });
  const { run } = await submit('فشل');
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.failed);
  const detail = await runtime.detail(run.id);
  assert.match(detail.steps.at(-1).summary, /read\.beta/);
});

test('M1: the demo planner produces a multi-step delivery from the default tool set', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const { createDemoPlanner } = await import('../src/agent/planner.js');
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: createDefaultTools({ statusProvider: () => ({ version: '0.2.1', storage: 'mysql', toolsCount: 12 }) }),
    planner: createDemoPlanner(),
    logger: { error() {} }
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'demo' });
  const submitted = await runtime.submit({ threadId: thread.id, message: 'جهّز خطة أسبوعية وراجع حالة النظام' });
  const finished = await runtime.runToCompletion(submitted.run.id);
  assert.equal(finished.status, RUN_STATUS.succeeded);
  const detail = await runtime.detail(submitted.run.id);
  assert.ok(detail.steps.length >= 6);
  assert.match(detail.steps.at(-1).summary, /مسودة مخطط/);
  assert.match(detail.steps.at(-1).summary, /لم يُنفَّذ أي أثر خارجي/);
});

test('M1: a calendar request reaches the approval gate instead of creating an event', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const { createDemoPlanner } = await import('../src/agent/planner.js');
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: createDefaultTools({ statusProvider: () => ({ version: '0.2.1', storage: 'mysql' }) }),
    planner: createDemoPlanner(),
    logger: { error() {} }
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'demo' });
  const submitted = await runtime.submit({ threadId: thread.id, message: 'أنشئ موعد اجتماع الأسبوع القادم' });
  const finished = await runtime.runToCompletion(submitted.run.id);
  assert.equal(finished.status, RUN_STATUS.waitingApproval);
  const detail = await runtime.detail(submitted.run.id);
  assert.equal(detail.toolRuns.some((toolRun) => toolRun.status !== TOOL_RUN_STATUS.succeeded), false);
});

test('M1: owner isolation — another owner cannot read or cancel the run', async (t) => {
  const { runtime, submit } = await setup(t);
  const { run } = await submit('ملكية');
  await assert.rejects(() => runtime.detail(run.id, 'intruder'), /not_found|run_not_found/);
  await assert.rejects(() => runtime.cancel(run.id, 'intruder'), /run_not_found/);
  assert.equal((await runtime.detail(run.id, 'owner')).run.id, run.id);
});

test('M1: resumePending finds and finishes runs a previous process left queued', async (t) => {
  const { runtime, recorder, submit, fixture } = await setup(t);
  const { run } = await submit('استئناف جماعي');
  assert.equal(run.status, RUN_STATUS.queued);
  const report = await runtime.resumePending();
  assert.equal(report.attempted, 1);
  assert.equal(report.resumed[0].runId, run.id);
  assert.equal((await fixture.store.getRun(run.id)).status, RUN_STATUS.succeeded);
  assert.equal(recorder.calls.length, 3);
});

test('M1: status reports the store dialect and refuses to describe SQLite as production', async (t) => {
  const { runtime } = await setup(t);
  const status = runtime.status();
  assert.equal(status.dialect, 'sqlite');
  assert.equal(status.enabled, true);
  assert.equal(status.planner, 'scripted');
  assert.match(status.note, /محلي\/تجريبي/);
});
