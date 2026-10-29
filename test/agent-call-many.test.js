/**
 * M-A/A3 — اختبارات `call_many` للقراءات المستقلة.
 *
 * كلها بلا شبكة: مخططات مبرمجة + SQLite مؤقت + سجل أدوات بزمن استجابة حقيقي.
 * معيار النجاح المعتمد (docs/manus-competitor-plan.md): p50 لمهمة من 5 قراءات
 * ينخفض ≥ 40% — يُقاس هنا بطوابع WP-1.1 نفسها (toolRun created/updated في المخزن).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempStore } from './support/agent-fixtures.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import {
  createProviderPlanner,
  validateProviderPlan,
  CALL_MANY_LIMITS
} from '../src/agent/planner-provider.js';
import { createGovernedFallbackPlanner, PLANNER_FALLBACK_CODES } from '../src/agent/planner-fallback.js';
import { createScriptedPlanner } from '../src/agent/planner.js';
import { createReplanPolicy, REVISION_STEP_TITLE } from '../src/agent/replanner.js';
import { createToolRegistry, RISK } from '../src/agent/tools.js';
import { percentile } from '../src/agent/timing.js';
import { RUN_STATUS } from '../src/agent/store.js';

const READ_NAMES = Object.freeze(['read.r1', 'read.r2', 'read.r3', 'read.r4', 'read.r5']);

/** سجل أدوات بزمن استجابة فعلي + تتبّع التوازي اللحظي — دليل لا تخمين. */
function createLatencyTools({ latencyMs = 0, failOnce = [], failAlways = [] } = {}) {
  const calls = [];
  const failures = new Map(failOnce.map((name) => [name, 1]));
  const tracker = { inFlight: 0, maxInFlight: 0 };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const definitions = READ_NAMES.map((name) => ({
    name,
    description: name,
    risk: RISK.read,
    arguments: { q: 'string' },
    async execute(args) {
      calls.push({ name, args });
      tracker.inFlight += 1;
      tracker.maxInFlight = Math.max(tracker.maxInFlight, tracker.inFlight);
      try {
        if (latencyMs > 0) await sleep(latencyMs);
        const pendingFailures = failures.get(name) ?? 0;
        if (failAlways.includes(name)) throw new Error(`${name}_failed`);
        if (pendingFailures > 0) {
          failures.set(name, pendingFailures - 1);
          throw new Error(`${name}_failed_once`);
        }
        return { tool: name, echo: args?.q ?? null };
      } finally {
        tracker.inFlight -= 1;
      }
    }
  }));
  definitions.push({
    name: 'write.effect',
    description: 'external effect',
    risk: RISK.externalEffect,
    requiresApproval: true,
    connector: 'google.calendar'
  });
  return { tools: createToolRegistry(definitions), calls, tracker };
}

/** مخطط غير مزوّدي يعيد القرارات بالترتيب — call_many متاح لأي مخطط عبر الـruntime. */
function decisionPlanner(decisions) {
  let index = 0;
  return {
    name: 'scripted-decisions',
    async plan() {
      const decision = decisions[Math.min(index, decisions.length - 1)];
      index += 1;
      return decision;
    }
  };
}

function manyDecision(names, args = {}) {
  return { action: 'call_many', calls: names.map((tool) => ({ tool, args })), reason: 'قراءات مستقلة' };
}

async function setupRuntime(t, { planner, toolOptions = {}, limits = {} }) {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const latency = createLatencyTools(toolOptions);
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: latency.tools,
    planner,
    limits: { maxSteps: 24, maxCostMicros: 100_000, ...limits },
    workerId: 'call-many-test-worker',
    logger: { error() {} }
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'A3 call_many' });
  const { run } = await runtime.submit({ threadId: thread.id, message: 'اقرأ المصادر ثم أجب' });
  return { fixture, runtime, latency, run };
}

function wallMsOf(toolRuns) {
  const starts = toolRuns.map((toolRun) => Date.parse(toolRun.createdAt));
  const ends = toolRuns.map((toolRun) => Date.parse(toolRun.updatedAt));
  return Math.max(...ends) - Math.min(...starts);
}

// ─── معيار النجاح المعتمد: p50 لمهمة 5 قراءات ينخفض ≥ 40% ────────────────────

test('CM-01 (acceptance): p50 wall time of a 5-read task drops >= 40% with call_many, measured from WP-1.1 timestamps', async (t) => {
  const LATENCY = 80;
  const TRIALS = 3;
  const runTask = async (mode) => {
    const decisions = mode === 'parallel'
      ? [manyDecision(['read.r1', 'read.r2', 'read.r3', 'read.r4']),
        { action: 'call', tool: 'read.r5', args: {} },
        { action: 'finish', summary: 'جُمعت القراءات الخمس.' }]
      : [...READ_NAMES.map((tool) => ({ action: 'call', tool, args: {} })),
        { action: 'finish', summary: 'جُمعت القراءات الخمس.' }];
    const { runtime, latency, run } = await setupRuntime(t, {
      planner: decisionPlanner(decisions),
      toolOptions: { latencyMs: LATENCY }
    });
    const finished = await runtime.runToCompletion(run.id);
    assert.equal(finished.status, RUN_STATUS.succeeded);
    const detail = await runtime.detail(run.id);
    assert.equal(detail.toolRuns.length, 5, 'exactly five settled reads per task');
    assert.ok(detail.toolRuns.every((toolRun) => toolRun.status === 'succeeded'));
    assert.deepEqual([...latency.calls.map((call) => call.name)].sort(), [...READ_NAMES].sort());
    return wallMsOf(detail.toolRuns);
  };

  const sequential = [];
  const parallel = [];
  for (let trial = 0; trial < TRIALS; trial += 1) {
    sequential.push(await runTask('sequential'));
    parallel.push(await runTask('parallel'));
  }
  const p50Sequential = percentile(sequential, 50);
  const p50Parallel = percentile(parallel, 50);
  assert.ok(p50Sequential >= 5 * LATENCY, `sequential p50 (${p50Sequential}ms) proves 5 real serialized latencies`);
  assert.ok(
    p50Parallel <= 0.6 * p50Sequential,
    `p50 must drop >= 40%: sequential=${p50Sequential}ms parallel=${p50Parallel}ms (drop=${Math.round((1 - p50Parallel / p50Sequential) * 100)}%)`
  );
});

test('CM-02: a 4-read batch truly runs in parallel and the concurrency ceiling is the batch size itself (<= 4)', async (t) => {
  assert.equal(CALL_MANY_LIMITS.maxCalls, 4);
  const { runtime, latency, run } = await setupRuntime(t, {
    planner: decisionPlanner([
      manyDecision(['read.r1', 'read.r2', 'read.r3', 'read.r4']),
      { action: 'finish', summary: 'اكتملت الدفعة.' }
    ]),
    toolOptions: { latencyMs: 60 }
  });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.succeeded);
  assert.equal(latency.tracker.maxInFlight, 4, 'all four reads were in flight simultaneously');
  assert.equal(latency.calls.length, 4);
  const detail = await runtime.detail(run.id);
  // WP-1.1: لكل عنصر دفعة toolRun مستقل بخطوة act خاصة به — المدة مثبتة لا مقدّرة.
  for (const toolRun of detail.toolRuns) {
    const actStep = detail.steps.find((step) => step.id === toolRun.stepId);
    assert.ok(actStep && actStep.kind === 'act', 'every batch element has its own act step');
    assert.ok(actStep.durationMs >= 60, `measured duration (${actStep.durationMs}ms) covers the real latency`);
  }
  assert.equal(detail.evidenceChain.ok, true);
});

// ─── الرفض الذري: أثر خارجي داخل الدفعة ──────────────────────────────────────

test('CM-03 (negative mutation): one write tool inside the batch rejects the WHOLE batch before any execution', async (t) => {
  const { runtime, latency, run } = await setupRuntime(t, {
    planner: decisionPlanner([
      { action: 'call_many', calls: [{ tool: 'read.r1', args: {} }, { tool: 'write.effect', args: {} }] }
    ])
  });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.failed);
  assert.equal(finished.lastError, 'call_many_requires_read_tools');
  assert.equal(latency.calls.length, 0, 'read.r1 never executes either — the rejection is atomic');
  const detail = await runtime.detail(run.id);
  assert.equal(detail.toolRuns.length, 0, 'no tool run row was opened');
  assert.equal(detail.approvals.length, 0, 'no approval row was opened');
  assert.equal(detail.outbox.length, 0, 'no outbox intent was created');
  assert.ok(detail.steps.some((step) => step.title === 'أثر خارجي داخل call_many'), 'the rejection is a visible step');
  assert.equal(detail.evidenceChain.ok, true);
});

test('CM-04 (negative mutation): a batch of 5 exceeds the declared ceiling and nothing executes', async (t) => {
  const { runtime, latency, run } = await setupRuntime(t, {
    planner: decisionPlanner([manyDecision([...READ_NAMES])])
  });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.failed);
  assert.equal(finished.lastError, 'call_many_batch_too_large');
  assert.equal(latency.calls.length, 0);
  const detail = await runtime.detail(run.id);
  assert.equal(detail.toolRuns.length, 0);
});

test('CM-05: an unregistered tool anywhere in the batch rejects atomically with unknown_tool', async (t) => {
  const { runtime, latency, run } = await setupRuntime(t, {
    planner: decisionPlanner([
      { action: 'call_many', calls: [{ tool: 'read.r1', args: {} }, { tool: 'tool.ghost', args: {} }] }
    ])
  });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.failed);
  assert.equal(finished.lastError, 'unknown_tool');
  assert.equal(latency.calls.length, 0);
});

test('CM-06: one failed read inside the batch keeps the others settled; an unrevised finish stays verification_blocked', async (t) => {
  const { runtime, latency, run } = await setupRuntime(t, {
    planner: decisionPlanner([
      manyDecision(['read.r1', 'read.r2', 'read.r3']),
      { action: 'finish', failed: true, summary: 'فشلت قراءة r2 ولم يُعد المحاولة.' }
    ]),
    toolOptions: { failAlways: ['read.r2'] }
  });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.failed);
  assert.equal(finished.lastError, 'verification_blocked', 'the independent verifier still blocks on the unresolved batch failure');
  assert.equal(latency.calls.length, 3, 'all three batch elements executed');
  const detail = await runtime.detail(run.id);
  const statuses = Object.fromEntries(detail.toolRuns.map((toolRun) => [toolRun.toolName, toolRun.status]));
  assert.deepEqual(statuses, { 'read.r1': 'succeeded', 'read.r2': 'failed', 'read.r3': 'succeeded' });
  assert.ok(detail.steps.some((step) => step.title === 'read.r2 ✗'), 'the batch failure is a visible observe step');
  assert.equal(detail.evidenceChain.ok, true);
});

// ─── التركيب مع A2: الاستعادة بمراجعة مفردة محكومة فقط ──────────────────────

test('CM-07: a batch failure composes with the governed A2 revision — one targeted retry, then PASS', async (t) => {
  const plans = [
    {
      action: 'call_many',
      tool: null,
      args: null,
      calls: [{ tool: 'read.r1', args: {} }, { tool: 'read.r2', args: {} }],
      summary: null,
      rationale: 'قراءتان مستقلتان بالتوازي.',
      successCriteria: ['كل قراءة تعيد نتيجة قابلة للفحص.']
    },
    {
      action: 'call',
      tool: 'read.r2',
      args: {},
      summary: null,
      rationale: 'إعادة القراءة الفاشلة وحدها.',
      successCriteria: ['القراءة المعادة تنجح.']
    },
    {
      action: 'finish',
      tool: null,
      args: null,
      summary: 'اكتملت القراءات بعد مراجعة واحدة.',
      rationale: 'الدليل كافٍ.',
      successCriteria: ['الخلاصة مبنية على الملحوظ.']
    }
  ];
  let planIndex = 0;
  const provider = {
    name: 'scripted-provider',
    async createPlan() {
      const plan = plans[Math.min(planIndex, plans.length - 1)];
      planIndex += 1;
      return { plan, model: 'scripted' };
    }
  };
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const latency = createLatencyTools({ failOnce: ['read.r2'] });
  const planner = createProviderPlanner({
    provider,
    tools: latency.tools,
    allowedTools: ['read.r1', 'read.r2', 'read.r3', 'read.r4'],
    revisionPolicy: createReplanPolicy()
  });
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: latency.tools,
    planner,
    limits: { maxSteps: 24, maxCostMicros: 100_000 },
    workerId: 'call-many-test-worker',
    logger: { error() {} }
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'A3+A2' });
  const { run } = await runtime.submit({ threadId: thread.id, message: 'اقرأ ثم أجب' });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.succeeded);
  assert.deepEqual(latency.calls.map((call) => call.name), ['read.r1', 'read.r2', 'read.r2']);
  const detail = await runtime.detail(run.id);
  const revisionStep = detail.steps.find((step) => step.title === REVISION_STEP_TITLE);
  assert.ok(revisionStep, 'recovery went through the single governed plan.revised window');
  assert.equal(revisionStep.toolName, 'read.r2');
  assert.equal(detail.verification.verdict, 'PASS');
  assert.equal(detail.evidenceChain.ok, true);
});

// ─── عقد المزوّد: التحقق الصارم + منع call_many كوسيلة استعادة ───────────────

test('CM-08a: validateProviderPlan accepts a well-formed call_many and stays byte-compatible for plans without calls', () => {
  const allowedTools = ['read.r1', 'read.r2'];
  const good = {
    action: 'call_many',
    tool: null,
    args: null,
    calls: [{ tool: 'read.r1', args: {} }, { tool: 'read.r2', args: { q: 'x' } }],
    summary: null,
    rationale: 'قراءات مستقلة.',
    successCriteria: ['نتائج قابلة للفحص.']
  };
  assert.deepEqual(validateProviderPlan(good, { allowedTools }), { ok: true, errors: [] });
  // خطة call قديمة بلا حقل calls إطلاقًا تبقى صالحة حرفيًا (التوافق الخلفي).
  const legacy = {
    action: 'call', tool: 'read.r1', args: {}, summary: null,
    rationale: 'قراءة.', successCriteria: ['نتيجة.']
  };
  assert.deepEqual(validateProviderPlan(legacy, { allowedTools }), { ok: true, errors: [] });
});

test('CM-08b: validateProviderPlan rejects every malformed call_many shape with explicit codes', () => {
  const allowedTools = ['read.r1', 'read.r2'];
  const base = { summary: null, rationale: 'سبب.', successCriteria: ['معيار.'] };
  const errorsOf = (plan) => validateProviderPlan(plan, { allowedTools }).errors;
  const entry = (tool) => ({ tool, args: {} });

  assert.ok(errorsOf({ ...base, action: 'call_many', tool: null, args: null, calls: [] }).includes('call_many_calls_required'));
  assert.ok(errorsOf({ ...base, action: 'call_many', tool: null, args: null, calls: null }).includes('call_many_calls_required'));
  assert.ok(
    errorsOf({ ...base, action: 'call_many', tool: null, args: null, calls: ['r1', 'r2', 'r1', 'r2', 'r1'].map((n) => entry(`read.${n}`)) })
      .includes('call_many_batch_too_large')
  );
  assert.ok(errorsOf({ ...base, action: 'call_many', tool: 'read.r1', args: null, calls: [entry('read.r1')] }).includes('call_many_tool_must_be_null'));
  assert.ok(errorsOf({ ...base, action: 'call_many', tool: null, args: null, calls: [{ tool: 'read.r1', args: {}, extra: 1 }] }).includes('call_many_entry_invalid:0'));
  assert.ok(errorsOf({ ...base, action: 'call_many', tool: null, args: null, calls: [entry('write.effect')] }).includes('tool_not_allowed:write.effect'));
  assert.ok(errorsOf({ ...base, action: 'call', tool: 'read.r1', args: {}, calls: [entry('read.r1')] }).includes('call_calls_must_be_null'));
  assert.ok(errorsOf({ ...base, action: 'finish', tool: null, args: null, summary: 'تم', calls: [entry('read.r1')] }).includes('non_call_calls_must_be_null'));
});

test('CM-08c: call_many after an observed failure is refused with call_many_after_failure and is NEVER converted by the fallback', async () => {
  assert.ok(!PLANNER_FALLBACK_CODES.includes('call_many_after_failure'), 'the refusal is governance, not a convertible provider failure');
  const latency = createLatencyTools();
  const provider = {
    name: 'scripted-provider',
    async createPlan() {
      return {
        plan: {
          action: 'call_many',
          tool: null,
          args: null,
          calls: [{ tool: 'read.r1', args: {} }, { tool: 'read.r3', args: {} }],
          summary: null,
          rationale: 'توزيع متوازٍ بعد فشل — ممنوع.',
          successCriteria: ['لن يصل.']
        },
        model: 'scripted'
      };
    }
  };
  const primary = createProviderPlanner({
    provider,
    tools: latency.tools,
    allowedTools: ['read.r1', 'read.r2', 'read.r3'],
    revisionPolicy: createReplanPolicy()
  });
  const context = {
    messages: [{ role: 'user', content: 'هدف' }],
    toolRuns: [{ id: 'tr-1', stepId: 'st-1', toolName: 'read.r2', status: 'failed', outcome: null }],
    steps: [{ id: 'st-1', index: 2, title: 'read.r2' }],
    memory: { summaries: [], facts: [] }
  };
  await assert.rejects(primary.plan(context), (error) => error.code === 'call_many_after_failure');
  // وحتى مع وجود سياسة مراجعة A2: المراجعة نافذة لنداء واحد مستهدف، لا لدفعة.
  const wrapped = createGovernedFallbackPlanner({ primary, fallback: createScriptedPlanner() });
  await assert.rejects(wrapped.plan(context), (error) => error.code === 'call_many_after_failure');
});

// ─── حُرّاس إضافيون: المدخلات والميزانية ─────────────────────────────────────

test('CM-09: an invalid argument in ONE batch element rejects the whole batch with zero executions', async (t) => {
  const { runtime, latency, run } = await setupRuntime(t, {
    planner: decisionPlanner([
      { action: 'call_many', calls: [{ tool: 'read.r1', args: { q: 'صالح' } }, { tool: 'read.r2', args: { q: 7 } }] }
    ])
  });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.failed);
  assert.equal(finished.lastError, 'policy_violation_argument_type');
  assert.equal(latency.calls.length, 0, 'the valid element never executes either');
  const detail = await runtime.detail(run.id);
  assert.equal(detail.toolRuns.length, 0);
});

test('CM-10: a batch that cannot fit the remaining step budget is refused BEFORE any execution, not mid-way', async (t) => {
  const { runtime, latency, run } = await setupRuntime(t, {
    planner: decisionPlanner([manyDecision(['read.r1', 'read.r2', 'read.r3', 'read.r4'])]),
    limits: { maxSteps: 6 }
  });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.budgetExhausted);
  assert.equal(finished.lastError, 'step_budget_exhausted');
  assert.equal(latency.calls.length, 0, 'no partial batch execution under budget pressure');
  const detail = await runtime.detail(run.id);
  assert.equal(detail.toolRuns.length, 0);
});
