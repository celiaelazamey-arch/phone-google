/**
 * ASSUR-002 — حارس «التقدّم الصفري».
 *
 * ما تُثبته هذه الاختبارات (لا ما تدّعيه):
 * - المفتاح القديم يحوي رقم الخطوة، فالتكرار المتطابق **كان** يُنفَّذ فعلًا.
 * - المحاولة الثالثة المتطابقة تُرفض **قبل** التنفيذ: عدّاد الاستدعاءات لا يتحرك.
 * - العدّ من المخزن: تشغيل جديد على نفس المخزن يرى الفشلين السابقين.
 * - المعطيات المختلفة والأداة المختلفة والنجاح المتكرر **لا** تُحظر.
 * - `call_many` تُرفض كاملة قبل بدء أي عنصر.
 *
 * كلها بلا شبكة: SQLite مؤقت + سجل أدوات يسجّل كل تنفيذ.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempStore, createRecordingTools } from './support/agent-fixtures.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createScriptedPlanner } from '../src/agent/planner.js';
import { createNoProgressPolicy, NO_PROGRESS_LIMITS, NO_PROGRESS_CODE } from '../src/agent/no-progress.js';
import { hashOf } from '../src/agent/evidence.js';
import { RUN_STATUS, TOOL_RUN_STATUS } from '../src/agent/store.js';

const ARGS = Object.freeze({ echo: 'same' });

function row({ toolName = 'read.alpha', argumentsDigest = hashOf(ARGS), status = TOOL_RUN_STATUS.failed } = {}) {
  return { toolName, argumentsDigest, status };
}

async function setup(t, { decisions, failTools = { alpha: true }, limits = {} } = {}) {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const recorder = createRecordingTools({ failTools });
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: recorder.tools,
    planner: createScriptedPlanner(decisions),
    limits: { maxSteps: 12, maxCostMicros: 100_000, ...limits },
    workerId: 'no-progress-worker',
    logger: { error() {} }
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'تقدّم صفري' });
  const submit = (message = 'مهمة') => runtime.submit({ threadId: thread.id, message });
  return { fixture, recorder, runtime, submit };
}

test('NP-01: الحدود المعلنة تُرفض إن لم تكن عددًا صحيحًا موجبًا', () => {
  assert.equal(NO_PROGRESS_LIMITS.maxIdenticalFailures, 2);
  for (const bad of [0, -1, 1.5, '2', null]) {
    assert.throws(() => createNoProgressPolicy({ maxIdenticalFailures: bad }), /integer >= 1/);
  }
  assert.equal(createNoProgressPolicy({ maxIdenticalFailures: 3 }).maxIdenticalFailures, 3);
});

test('NP-02: الحارس يعدّ الفشل المتطابق فقط ويحظر عند الحد', () => {
  const policy = createNoProgressPolicy();
  const evaluate = (toolRuns) => policy.evaluate({ toolName: 'read.alpha', argumentsDigest: hashOf(ARGS), toolRuns });

  assert.equal(evaluate([]).blocked, false);
  assert.equal(evaluate([row()]).blocked, false, 'الفشل الأول لا يحظر');
  assert.equal(evaluate([row(), row()]).priorFailures, 2);
  assert.equal(evaluate([row(), row()]).blocked, true, 'الثالثة تُحظر');
  assert.equal(evaluate([row(), row()]).code, NO_PROGRESS_CODE);
});

test('NP-03: اختلاف المعطيات أو الأداة، والنجاح، والحالة غير المستقرة — لا حظر', () => {
  const policy = createNoProgressPolicy();
  const base = { toolName: 'read.alpha', argumentsDigest: hashOf(ARGS) };
  const cases = [
    [row({ ...base, argumentsDigest: hashOf({ echo: 'other' }) }), row({ ...base, argumentsDigest: hashOf({ echo: 'other' }) })],
    [row({ ...base, toolName: 'read.beta' }), row({ ...base, toolName: 'read.beta' })],
    [row({ ...base, status: TOOL_RUN_STATUS.succeeded }), row({ ...base, status: TOOL_RUN_STATUS.succeeded })],
    // غير مستقر شأن المصالحة (DEC-007) لا شأن هذا الحارس.
    [row({ ...base, status: TOOL_RUN_STATUS.unknown }), row({ ...base, status: TOOL_RUN_STATUS.started })],
    // صفوف سابقة للشريحة بلا بصمة: غياب دليل التطابق ليس دليل تطابق.
    [row({ ...base, argumentsDigest: null }), row({ ...base, argumentsDigest: null })]
  ];
  for (const toolRuns of cases) {
    assert.equal(policy.evaluate({ ...base, toolRuns }).blocked, false);
  }
});

test('NP-04: بلا بصمة لا حظر بالتخمين', () => {
  const policy = createNoProgressPolicy();
  const toolRuns = [row(), row(), row()];
  assert.equal(policy.evaluate({ toolName: 'read.alpha', argumentsDigest: null, toolRuns }).blocked, false);
  assert.equal(policy.evaluate({ toolName: '', argumentsDigest: hashOf(ARGS), toolRuns }).blocked, false);
});

test('NP-05: الحلقة ترفض المحاولة الثالثة المتطابقة قبل تنفيذها', async (t) => {
  const call = { action: 'call', tool: 'read.alpha', args: ARGS };
  const { runtime, recorder, submit, fixture } = await setup(t, { decisions: [call, call, call, call] });
  const { run } = await submit();
  const finished = await runtime.runToCompletion(run.id);

  assert.equal(finished.status, RUN_STATUS.failed);
  assert.equal(finished.lastError, NO_PROGRESS_CODE);
  assert.equal(recorder.calls.length, 2, 'التنفيذ الثالث لم يحدث: الرفض قبل الأثر');

  const detail = await runtime.detail(run.id);
  assert.ok(detail.steps.some((step) => step.title === 'تقدّم صفري'), 'الرفض خطوة مسجّلة في السجل');
  const digests = detail.toolRuns.map((toolRun) => toolRun.argumentsDigest);
  assert.equal(digests.length, 2);
  assert.ok(digests.every((digest) => digest === hashOf(ARGS)), 'البصمة persisted مع كل استدعاء');

  // بلا حارس، المفتاح المختلف (رقم خطوة مختلف) كان سينفّذ أربع مرات.
  const keys = detail.toolRuns.map((toolRun) => toolRun.idempotencyKey);
  assert.equal(new Set(keys).size, 2, 'المفاتيح مختلفة أصلًا — لهذا لم يمنعها منع التكرار');
  assert.equal((await fixture.store.listToolRuns(run.id)).length, 2);
});

test('NP-06: المعطيات المتغيرة تُنفَّذ ولا يحظرها الحارس', async (t) => {
  const { runtime, recorder, submit } = await setup(t, {
    decisions: [
      { action: 'call', tool: 'read.alpha', args: { echo: 'one' } },
      { action: 'call', tool: 'read.alpha', args: { echo: 'two' } },
      { action: 'call', tool: 'read.alpha', args: { echo: 'three' } }
    ]
  });
  const { run } = await submit();
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(recorder.calls.length, 3, 'ثلاث محاولات بمعطيات مختلفة = معلومة جديدة');
  assert.notEqual(finished.lastError, NO_PROGRESS_CODE);
});

test('NP-07: نجاح متكرر بمعطيات واحدة لا يُحظر — الحارس يقيس الفشل لا التكرار', async (t) => {
  const call = { action: 'call', tool: 'read.alpha', args: ARGS };
  const { runtime, recorder, submit } = await setup(t, { decisions: [call, call, call], failTools: {} });
  const { run } = await submit();
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.succeeded);
  assert.equal(recorder.calls.length, 3);
});

test('NP-08: العدّ من المخزن — عملية جديدة ترى الفشلين السابقين ولا تمنح نافذة جديدة', async (t) => {
  const { fixture, recorder, submit } = await setup(t, { decisions: [] });
  const { run } = await submit();
  // عملية سابقة: فشلان مستقران متطابقان لنفس الأداة والمعطيات.
  for (const index of [1, 2]) {
    const step = await fixture.store.appendStep({ runId: run.id, kind: 'act', title: 'read.alpha' });
    const started = await fixture.store.startToolRun({
      runId: run.id,
      stepId: step.id,
      toolName: 'read.alpha',
      risk: 'read',
      idempotencyKey: `${run.id}:${index}:read.alpha`,
      argumentsDigest: hashOf(ARGS)
    });
    await fixture.store.finishToolRun(started.toolRun.id, TOOL_RUN_STATUS.failed, JSON.stringify({ error: 'alpha_failed' }));
  }
  await fixture.store.heartbeat(run.id, { leaseMs: -5_000 });

  // عملية جديدة على نفس المخزن: أول اقتراح متطابق يجب أن يُرفض فورًا.
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: recorder.tools,
    planner: createScriptedPlanner([{ action: 'call', tool: 'read.alpha', args: ARGS }]),
    workerId: 'resumed-worker',
    logger: { error() {} }
  });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.lastError, NO_PROGRESS_CODE, 'الاستئناف لا يصفّر العدّ');
  assert.equal(recorder.calls.length, 0, 'لا تنفيذ على الإطلاق بعد الاستئناف');
});

test('NP-09: call_many تُرفض كاملة قبل بدء أي عنصر', async (t) => {
  const { fixture, recorder, submit } = await setup(t, { decisions: [] });
  const { run } = await submit();
  for (const index of [1, 2]) {
    const step = await fixture.store.appendStep({ runId: run.id, kind: 'act', title: 'read.alpha' });
    const started = await fixture.store.startToolRun({
      runId: run.id,
      stepId: step.id,
      toolName: 'read.alpha',
      risk: 'read',
      idempotencyKey: `${run.id}:${index}:read.alpha`,
      argumentsDigest: hashOf(ARGS)
    });
    await fixture.store.finishToolRun(started.toolRun.id, TOOL_RUN_STATUS.failed, JSON.stringify({ error: 'alpha_failed' }));
  }
  await fixture.store.heartbeat(run.id, { leaseMs: -5_000 });

  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: recorder.tools,
    planner: createScriptedPlanner([
      {
        action: 'call_many',
        calls: [
          { tool: 'read.beta', args: {} },
          { tool: 'read.alpha', args: ARGS }
        ]
      }
    ]),
    workerId: 'batch-worker',
    logger: { error() {} }
  });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.lastError, NO_PROGRESS_CODE);
  assert.equal(recorder.calls.length, 0, 'حتى العنصر السليم لم يُنفَّذ: الرفض قبل الدفعة كلها');
});
