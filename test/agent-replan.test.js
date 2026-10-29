/**
 * M-A/A2 — اختبارات إعادة التخطيط المحكومة (`plan.revised`).
 * كلها بلا شبكة: مزوّد مبرمج + SQLite مؤقت + سجل أدوات مسجِّل.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTempStore, createRecordingTools } from './support/agent-fixtures.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createProviderPlanner } from '../src/agent/planner-provider.js';
import { createScriptedPlanner } from '../src/agent/planner.js';
import { createGovernedFallbackPlanner } from '../src/agent/planner-fallback.js';
import { createReplanPolicy, REPLAN_LIMITS, REVISION_STEP_TITLE } from '../src/agent/replanner.js';
import { createAgentHost } from '../src/agent/index.js';
import { RUN_STATUS } from '../src/agent/store.js';

const READ_TOOLS = Object.freeze(['read.alpha', 'read.beta', 'read.gamma']);

function callPlan(tool, args = {}) {
  return {
    action: 'call', tool, args, summary: null,
    rationale: 'قراءة مطلوبة.',
    successCriteria: ['القراءة تعيد نتيجة قابلة للفحص.']
  };
}

function finishPlan(summary) {
  return {
    action: 'finish', tool: null, args: null, summary,
    rationale: 'الدليل كافٍ.',
    successCriteria: ['الخلاصة مبنية على الملحوظ.']
  };
}

/** مزوّد مبرمج: يعيد الخطط بالترتيب — المحفّز في اختبارات الطفرة السلبية. */
function scriptedProvider(plans) {
  let index = 0;
  return {
    name: 'scripted-provider',
    async createPlan() {
      const plan = plans[Math.min(index, plans.length - 1)];
      index += 1;
      return { plan, model: 'scripted' };
    }
  };
}

async function setup(t, { plans, failTools = {}, revisionPolicy = createReplanPolicy(), wrapInFallback = false }) {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const recorder = createRecordingTools({ failTools });
  let planner = createProviderPlanner({
    provider: scriptedProvider(plans),
    tools: recorder.tools,
    allowedTools: [...READ_TOOLS],
    revisionPolicy
  });
  if (wrapInFallback) {
    planner = createGovernedFallbackPlanner({ primary: planner, fallback: createScriptedPlanner() });
  }
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: recorder.tools,
    planner,
    limits: { maxSteps: 16, maxCostMicros: 100_000 },
    workerId: 'replan-test-worker',
    logger: { error() {} }
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'A2 replan' });
  const { run } = await runtime.submit({ threadId: thread.id, message: 'اقرأ ثم أجب' });
  return { fixture, runtime, recorder, run };
}

// ─── وحدة السياسة ───────────────────────────────────────────────────────────

test('RPL-01: policy construction and first-revision evaluation are strict and deterministic', () => {
  assert.deepEqual({ ...REPLAN_LIMITS }, { maxPerStep: 1, maxPerRun: 1 });
  assert.throws(() => createReplanPolicy({ maxPerStep: 0 }), /integer >= 1/);
  assert.throws(() => createReplanPolicy({ maxPerRun: 1.5 }), /integer >= 1/);
  assert.throws(() => createReplanPolicy({ maxPerStep: 2, maxPerRun: 1 }), /maxPerRun must be >= maxPerStep/);

  const recorder = createRecordingTools();
  const policy = createReplanPolicy();
  assert.equal(policy.name, 'governed-replan-v1');
  // بلا فشل → لا مراجعة ولا اعتراض.
  assert.deepEqual(
    policy.evaluate({ plan: callPlan('read.alpha'), context: { toolRuns: [], steps: [] }, tools: recorder.tools }),
    { revision: null }
  );
  // أول مراجعة لفشل ملحوظ → مسموحة بعلامة مربوطة بالخطوة الفاشلة.
  const { revision } = policy.evaluate({
    plan: callPlan('read.beta'),
    context: {
      toolRuns: [{ id: 'tr-1', stepId: 'st-1', toolName: 'read.alpha', status: 'failed' }],
      steps: [{ id: 'st-1', index: 2, title: 'read.alpha' }]
    },
    tools: recorder.tools
  });
  assert.deepEqual({ ...revision }, {
    ofStepId: 'st-1', ofToolRunId: 'tr-1', failedTool: 'read.alpha',
    attempt: 1, maxPerStep: 1, maxPerRun: 1
  });
});

test('RPL-02: policy unit — a write tool can never pass evaluation even if an allowlist ever leaked it', () => {
  const recorder = createRecordingTools();
  const policy = createReplanPolicy();
  const failedContext = {
    toolRuns: [{ id: 'tr-1', stepId: 'st-1', toolName: 'read.alpha', status: 'failed' }],
    steps: [{ id: 'st-1', index: 2, title: 'read.alpha' }]
  };
  assert.throws(
    () => policy.evaluate({ plan: callPlan('calendar.create'), context: failedContext, tools: recorder.tools }),
    (error) => error.code === 'replan_requires_read_tool'
  );
  assert.throws(
    () => policy.evaluate({ plan: callPlan('tool.unregistered'), context: failedContext, tools: recorder.tools }),
    (error) => error.code === 'replan_requires_read_tool' && error.details.includes('risk:unregistered')
  );
});

// ─── المسار السعيد: مراجعة واحدة مسموحة ومسجلة في السلسلة ────────────────────

test('RPL-03: one failed read allows exactly one read-only revision, recorded as plan.revised in the chain', async (t) => {
  const { runtime, recorder, run } = await setup(t, {
    plans: [callPlan('read.alpha'), callPlan('read.beta'), finishPlan('اكتمل من قراءة المراجعة.')],
    failTools: { alpha: true }
  });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.succeeded);
  assert.deepEqual(recorder.calls.map((call) => call.name), ['read.alpha', 'read.beta']);

  const detail = await runtime.detail(run.id);
  const revisionStep = detail.steps.find((step) => step.title === REVISION_STEP_TITLE);
  assert.ok(revisionStep, 'the revision is a visible plan.revised step');
  assert.match(revisionStep.summary, /مراجعة محكومة 1\/1 بعد فشل read\.alpha/);
  assert.equal(revisionStep.toolName, 'read.beta');
  const revisionEvidence = detail.evidence.find(
    (entry) => entry.kind === 'plan_created' && entry.stepId === revisionStep.id
  );
  assert.ok(revisionEvidence, 'plan.revised is hash-chained evidence, not UI decoration');
  assert.match(revisionEvidence.inputHash, /^[a-f0-9]{64}$/);
  assert.equal(detail.evidenceChain.ok, true);
  assert.equal(detail.verification.verdict, 'PASS');
});

// ─── اختبار الطفرة السلبي 1: محاولة إعادة تخطيط ثانية ────────────────────────

test('RPL-04 (negative mutation 1): a second revision attempt halts immediately with max_replan_exceeded (run-level loop guard)', async (t) => {
  // فشل أ ← مراجعة ب (تفشل أيضًا) ← المحفّز يطلب ج: حارس الحلقة يرفض فورًا.
  const { runtime, recorder, run } = await setup(t, {
    plans: [callPlan('read.alpha'), callPlan('read.beta'), callPlan('read.gamma')],
    failTools: { alpha: true, beta: true }
  });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.failed);
  assert.equal(finished.lastError, 'max_replan_exceeded');
  assert.deepEqual(
    recorder.calls.map((call) => call.name),
    ['read.alpha', 'read.beta'],
    'read.gamma never executes — fail-closed before any tool start'
  );
  const detail = await runtime.detail(run.id);
  assert.ok(
    detail.steps.some((step) => step.title === 'فشل التخطيط' && step.summary === 'max_replan_exceeded'),
    'the deviation code is a recorded step'
  );
  const blocked = detail.evidence.filter((entry) => entry.kind === 'plan_created');
  assert.ok(blocked.length >= 1, 'the rejected plan is BLOCK evidence in the chain');
  assert.equal(detail.evidenceChain.ok, true);
});

test('RPL-05 (negative mutation 1b): with maxPerRun=2, a second revision for the SAME failed step is still refused', async (t) => {
  // فشل أ ← مراجعة ب (تنجح) ← المحفّز يطلب ج لنفس الفشل: حد الخطوة maxPerStep=1 يرفض.
  const { runtime, recorder, run } = await setup(t, {
    plans: [callPlan('read.alpha'), callPlan('read.beta'), callPlan('read.gamma')],
    failTools: { alpha: true },
    revisionPolicy: createReplanPolicy({ maxPerRun: 2 })
  });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.failed);
  assert.equal(finished.lastError, 'max_replan_exceeded');
  assert.deepEqual(recorder.calls.map((call) => call.name), ['read.alpha', 'read.beta']);
});

// ─── اختبار الطفرة السلبي 2: طلب أداة كتابة أثناء الاستعادة ──────────────────

test('RPL-06 (negative mutation 2): a mutation tool requested after a failure is blocked before approval, outbox or execution', async (t) => {
  // calendar.create أداة أثر خارجي مسجلة في السجل — خارج allowedTools للمزوّد أصلًا.
  const { runtime, recorder, run } = await setup(t, {
    plans: [callPlan('read.alpha'), callPlan('calendar.create', { title: 'اجتماع' })],
    failTools: { alpha: true }
  });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.failed);
  assert.equal(finished.lastError, 'invalid_provider_plan');
  assert.deepEqual(recorder.calls.map((call) => call.name), ['read.alpha'], 'the write tool never starts');
  const detail = await runtime.detail(run.id);
  assert.equal(detail.approvals.length, 0, 'no approval row was opened');
  assert.equal(detail.outbox.length, 0, 'no outbox intent was created');
  assert.equal(detail.evidenceChain.ok, true);
});

// ─── التفاعل مع التحويل المرئي والسلوك الافتراضي ─────────────────────────────

test('RPL-07: under the governed fallback, max_replan_exceeded becomes a visible planner_fallback bounded delivery', async (t) => {
  const { runtime, recorder, run } = await setup(t, {
    plans: [callPlan('read.alpha'), callPlan('read.beta'), callPlan('read.gamma')],
    failTools: { alpha: true, beta: true },
    wrapInFallback: true
  });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.failed);
  // فشل القراءة الثاني (المراجعة نفسها فشلت) غير مستدرَك → المُتحقِّق المستقل يبقى حاجبًا.
  assert.equal(finished.lastError, 'verification_blocked');
  assert.deepEqual(recorder.calls.map((call) => call.name), ['read.alpha', 'read.beta']);
  const detail = await runtime.detail(run.id);
  const fallbackStep = detail.steps.find((step) => step.title === 'planner_fallback');
  assert.ok(fallbackStep, 'the halt is visible, not silent');
  assert.match(fallbackStep.summary, /max_replan_exceeded/);
  assert.ok(detail.steps.some((step) => /أُنهي التشغيل بأمان/.test(step.summary ?? '')), 'safe-finish wording is delivered');
  assert.match(detail.verification?.verdict ?? '', /BLOCK/, 'unresolved read failures still block the independent verifier');
});

test('RPL-08: without a revision policy the previous contract is byte-for-byte intact (automatic_replan_disabled)', async (t) => {
  const { runtime, recorder, run } = await setup(t, {
    plans: [callPlan('read.alpha'), callPlan('read.beta')],
    failTools: { alpha: true },
    revisionPolicy: null
  });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.failed);
  assert.equal(finished.lastError, 'automatic_replan_disabled');
  assert.deepEqual(recorder.calls.map((call) => call.name), ['read.alpha']);
  // وعقد البناء يرفض سياسة مشوهة بدل تجاهلها.
  const recorder2 = createRecordingTools();
  assert.throws(
    () => createProviderPlanner({
      provider: scriptedProvider([finishPlan('x')]),
      tools: recorder2.tools,
      allowedTools: ['read.alpha', 'read.beta'],
      revisionPolicy: { notEvaluate: true }
    }),
    /revisionPolicy/
  );
});

// ─── توصيل الـhost في وضع gemini ─────────────────────────────────────────────

test('RPL-09: the gemini host mode ships the replan policy — a failed read gets one governed revision end-to-end', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-replan-host-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let statusCalls = 0;
  const plans = [
    callPlan('celia.system_status'),            // سيفشل: statusProvider يرمي
    callPlan('celia.thread_context'),           // المراجعة المحكومة 1/1
    finishPlan('اكتمل من سياق الخيط بعد فشل قراءة الحالة.')
  ];
  let planIndex = 0;
  const host = createAgentHost({
    config: { nodeEnv: 'test', gemini: { apiKey: 'test-gemini-key-0123456789abcdef', model: 'gemini-2.5-flash' } },
    env: {
      NODE_ENV: 'test',
      CELIA_AGENT_RUNTIME: 'sqlite',
      CELIA_AGENT_SQLITE_PATH: path.join(directory, 'agent.sqlite3'),
      CELIA_AGENT_PLANNER: 'gemini'
    },
    statusProvider: () => { statusCalls += 1; throw new Error('status backend down'); },
    plannerProvider: {
      name: 'mock-gemini',
      async createPlan() {
        const plan = plans[Math.min(planIndex, plans.length - 1)];
        planIndex += 1;
        return { plan, model: 'mock' };
      }
    },
    logger: { info() {}, error() {} }
  });
  const runtime = await host.ready;
  t.after(() => runtime.shutdown());
  const thread = await runtime.store.createThread({ ownerId: 'owner', title: 'A2 host' });
  const { run } = await runtime.submit({ threadId: thread.id, message: 'اقرأ الحالة ثم أجب' });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.succeeded);
  assert.equal(statusCalls, 1, 'the failed read ran once and was never blindly retried');
  const detail = await runtime.detail(run.id);
  const revisionStep = detail.steps.find((step) => step.title === REVISION_STEP_TITLE);
  assert.ok(revisionStep, 'the governed revision is visible in the host-wired runtime');
  assert.equal(revisionStep.toolName, 'celia.thread_context');
  assert.equal(detail.evidenceChain.ok, true);
});
