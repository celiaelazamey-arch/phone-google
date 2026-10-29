/**
 * M-A/A4 — اختبارات موجّه النماذج (`model_router`).
 *
 * كلها بلا شبكة: مزوّدا طبقتين مبرمجان + SQLite مؤقت.
 * معيار القبول (docs/manus-competitor-plan.md A4): سقف تكلفة لكل تشغيل يُنفَّذ
 * **رفضًا لا تجاوزًا**، والتكلفة رموز فعلية إلى `recordCost` وتظهر في المقاييس.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempStore, createRecordingTools } from './support/agent-fixtures.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createProviderPlanner } from '../src/agent/planner-provider.js';
import { createGovernedFallbackPlanner, PLANNER_FALLBACK_CODES } from '../src/agent/planner-fallback.js';
import { createScriptedPlanner } from '../src/agent/planner.js';
import {
  createModelRouter,
  defaultRoute,
  computeCostMicros,
  MODEL_TIERS,
  ROUTE_REASONS,
  DECLARED_GEMINI_PRICING,
  DEFAULT_PER_CALL_CAPS
} from '../src/agent/model-router.js';
import { computeAgentMetrics } from '../src/agent/evaluation.js';
import { RUN_STATUS } from '../src/agent/store.js';

const READ_TOOLS = Object.freeze(['read.alpha', 'read.beta', 'read.gamma']);
const PRICING = Object.freeze({ inputMicrosPer1K: 100, outputMicrosPer1K: 400 });

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

/** مزوّد طبقة مبرمج: يسجل كل استدعاء ويعيد خططه بالترتيب مع رموز معلنة. */
function tierProvider(name, plans, usage = { inputTokens: 1000, outputTokens: 500 }) {
  let index = 0;
  const calls = [];
  return {
    name,
    calls,
    async createPlan(request) {
      calls.push({ budget: request.budget, toolResults: request.state.toolResults.length });
      const plan = plans[Math.min(index, plans.length - 1)];
      index += 1;
      return { plan, model: name, usage: { ...usage, measured: true } };
    }
  };
}

function routerWith({ fastPlans, plannerPlans, fastUsage, plannerUsage, caps = {} }) {
  const fast = tierProvider('fast-model', fastPlans, fastUsage);
  const planner = tierProvider('planner-model', plannerPlans, plannerUsage);
  const router = createModelRouter({
    tiers: {
      fast: { provider: fast, model: 'fast-model', pricing: PRICING, maxCostMicrosPerCall: caps.fast ?? 500 },
      planner: { provider: planner, model: 'planner-model', pricing: PRICING, maxCostMicrosPerCall: caps.planner ?? 500 }
    }
  });
  return { router, fast, planner };
}

async function setupRuntime(t, { router, failTools = {}, maxCostMicros = 100_000 }) {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const recorder = createRecordingTools({ failTools });
  const planner = createProviderPlanner({ provider: router, tools: recorder.tools, allowedTools: [...READ_TOOLS] });
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: recorder.tools,
    planner,
    limits: { maxSteps: 16, maxCostMicros },
    workerId: 'router-test-worker',
    logger: { error() {} }
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'A4 router' });
  const { run } = await runtime.submit({ threadId: thread.id, message: 'اقرأ ثم أجب' });
  return { fixture, runtime, recorder, run };
}

// ─── الوحدات: التوجيه والتكلفة وعقد البناء ───────────────────────────────────

test('MR-01: defaultRoute is a pure deterministic function of the request state', () => {
  assert.deepEqual(defaultRoute({ state: { toolResults: [] } }),
    { tier: MODEL_TIERS.planner, reason: ROUTE_REASONS.initialPlan });
  assert.deepEqual(defaultRoute({ state: { toolResults: [{ status: 'succeeded' }] } }),
    { tier: MODEL_TIERS.fast, reason: ROUTE_REASONS.extraction });
  assert.deepEqual(defaultRoute({ state: { toolResults: [{ status: 'succeeded' }, { status: 'failed' }] } }),
    { tier: MODEL_TIERS.planner, reason: ROUTE_REASONS.observedFailure });
});

test('MR-02: construction contract rejects missing providers, pricing and non-positive caps', () => {
  const provider = { async createPlan() { return {}; } };
  const tier = { provider, pricing: PRICING, maxCostMicrosPerCall: 100 };
  assert.throws(() => createModelRouter({ tiers: { fast: tier } }), /tier "planner" requires/);
  assert.throws(
    () => createModelRouter({ tiers: { fast: { ...tier, pricing: null }, planner: tier } }),
    /requires declared pricing/
  );
  assert.throws(
    () => createModelRouter({ tiers: { fast: { ...tier, maxCostMicrosPerCall: 0 }, planner: tier } }),
    /maxCostMicrosPerCall must be an integer >= 1/
  );
  assert.ok(Object.isFrozen(DECLARED_GEMINI_PRICING), 'declared pricing is a frozen deliberate config');
  assert.ok(DEFAULT_PER_CALL_CAPS.planner > DEFAULT_PER_CALL_CAPS.fast, 'the stronger tier declares the larger worst case');
});

test('MR-03: cost is measured tokens times declared pricing, always rounded UP', () => {
  assert.equal(computeCostMicros({ inputTokens: 1000, outputTokens: 500 }, PRICING), 100 + 200);
  // 1 رمز واحد لا يساوي صفرًا أبدًا — التقريب لأعلى دائمًا.
  assert.equal(computeCostMicros({ inputTokens: 1, outputTokens: 1 }, PRICING), 2);
  assert.equal(computeCostMicros({}, PRICING), 0);
});

// ─── الرفض قبل الإرسال: «رفض لا تجاوز» ───────────────────────────────────────

test('MR-04 (negative mutation): a call whose declared worst case does not fit is refused BEFORE the provider is invoked', async () => {
  const { router, planner } = routerWith({ fastPlans: [], plannerPlans: [callPlan('read.alpha')] });
  await assert.rejects(
    router.createPlan({ state: { toolResults: [] }, budget: { maxCostMicros: 400, usedCostMicros: 0 } }),
    (error) => error.code === 'cost_budget_refused'
      && error.details.includes('worst_case_call_micros:500')
      && error.details.includes('max_micros:400')
  );
  assert.equal(planner.calls.length, 0, 'zero spend: the provider was never reached');
});

test('MR-05: a provider reporting usage above its declared per-call cap halts with model_cost_contract_violation', async () => {
  const { router } = routerWith({
    fastPlans: [],
    plannerPlans: [callPlan('read.alpha')],
    plannerUsage: { inputTokens: 100_000, outputTokens: 0 } // 10_000 micros > cap 500
  });
  await assert.rejects(
    router.createPlan({ state: { toolResults: [] }, budget: { maxCostMicros: 100_000, usedCostMicros: 0 } }),
    (error) => error.code === 'model_cost_contract_violation'
  );
});

test('MR-06 (fail-closed): a request without a budget contract is refused with cost_budget_unknown, zero calls', async () => {
  const { router, planner } = routerWith({ fastPlans: [], plannerPlans: [callPlan('read.alpha')] });
  await assert.rejects(
    router.createPlan({ state: { toolResults: [] } }),
    (error) => error.code === 'cost_budget_unknown'
  );
  assert.equal(planner.calls.length, 0);
});

// ─── التكامل مع الحلقة: توجيه فعلي وتكلفة مسجلة ─────────────────────────────

test('MR-07: in a real run the first plan uses the planner tier, extraction uses fast, and real cost reaches recordCost', async (t) => {
  const { router, fast, planner } = routerWith({
    plannerPlans: [callPlan('read.alpha')],
    fastPlans: [finishPlan('اكتمل من الملاحظات.')],
    plannerUsage: { inputTokens: 2000, outputTokens: 500 }, // 200 + 200 = 400
    fastUsage: { inputTokens: 1000, outputTokens: 250 } // 100 + 100 = 200
  });
  const { runtime, run } = await setupRuntime(t, { router });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.succeeded);
  assert.equal(planner.calls.length, 1, 'initial plan went to the strong tier');
  assert.equal(fast.calls.length, 1, 'extraction over successful observations went to the fast tier');
  assert.equal(finished.usage.costMicros, 600, 'recordCost received the summed real token cost (400 + 200)');
  assert.ok(finished.usage.tokens >= 3750, 'real token counts were recorded, not zeros');

  const detail = await runtime.detail(run.id);
  const planEvidence = detail.evidence.filter((entry) => entry.kind === 'plan_created');
  assert.equal(planEvidence.length, 2, 'both routed plans are hash-chained evidence rows');
  assert.ok(planEvidence.every((entry) => entry.outputHash), 'the router decision payload is bound by outputHash (store keeps hashes, not payloads)');
  assert.equal(detail.evidenceChain.ok, true);

  // القرار نفسه (الطبقة/السبب/التسعير) يظهر في providerTrace.usage.router — وهو
  // الحمولة التي بُصمت أعلاه: نثبته مباشرة من مستوى المخطط بنفس المزوّدين.
  const { router: router2 } = routerWith({
    plannerPlans: [callPlan('read.alpha')],
    fastPlans: [finishPlan('اكتمل.')],
    plannerUsage: { inputTokens: 2000, outputTokens: 500 }
  });
  const recorder2 = createRecordingTools();
  const planner2 = createProviderPlanner({ provider: router2, tools: recorder2.tools, allowedTools: [...READ_TOOLS] });
  const baseContext = {
    messages: [{ role: 'user', content: 'هدف' }],
    steps: [],
    memory: { summaries: [], facts: [] },
    run: { id: 'r1', status: 'running', limits: { maxCostMicros: 100_000 }, usage: { costMicros: 0 } }
  };
  const first = await planner2.plan({ ...baseContext, toolRuns: [] });
  assert.equal(first.providerTrace.usage.router.tier, 'planner');
  assert.equal(first.providerTrace.usage.router.reason, ROUTE_REASONS.initialPlan);
  assert.equal(first.costMicros, 400, 'the decision carries the real computed cost');
  const second = await planner2.plan({
    ...baseContext,
    toolRuns: [{ id: 'tr-1', stepId: 'st-1', toolName: 'read.alpha', status: 'succeeded', outcome: '{}' }]
  });
  assert.equal(second.providerTrace.usage.router.tier, 'fast');
  assert.equal(second.providerTrace.usage.router.reason, ROUTE_REASONS.extraction);
});

test('MR-08 (acceptance, negative mutation): the per-run cost cap is enforced by REFUSAL — spend never exceeds the cap', async (t) => {
  // النداء الأول (planner، تكلفة 400) يتسع في السقف 800؛ الثاني (fast، أسوأ حالة 500)
  // يحتاج 400+500=900 > 800 → رفض قبل الإرسال؛ الإنفاق يبقى 400 ≤ 800 دائمًا.
  const { router, fast } = routerWith({
    plannerPlans: [callPlan('read.alpha')],
    fastPlans: [finishPlan('لن يصل.')],
    plannerUsage: { inputTokens: 2000, outputTokens: 500 } // 400
  });
  const { runtime, recorder, run } = await setupRuntime(t, { router, maxCostMicros: 800 });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.budgetExhausted, 'refusal ends the run as budget_exhausted, not a generic failure');
  assert.equal(finished.lastError, 'cost_budget_refused');
  assert.equal(fast.calls.length, 0, 'the second provider call was never sent');
  assert.equal(finished.usage.costMicros, 400, 'spend is the first call only');
  assert.ok(finished.usage.costMicros <= 800, 'the cap was never exceeded — refusal, not overrun');
  assert.deepEqual(recorder.calls.map((call) => call.name), ['read.alpha'], 'no extra tool ran after the refusal');
  const detail = await runtime.detail(run.id);
  assert.ok(
    detail.steps.some((step) => step.title === 'فشل التخطيط' && step.summary === 'cost_budget_refused'),
    'the refusal is a visible recorded step'
  );
});

test('MR-09: cost appears in the metrics aggregate that feeds /api/agent/metrics', async (t) => {
  const { router } = routerWith({
    plannerPlans: [callPlan('read.alpha')],
    fastPlans: [finishPlan('تم.')],
    plannerUsage: { inputTokens: 2000, outputTokens: 500 },
    fastUsage: { inputTokens: 1000, outputTokens: 250 }
  });
  const { runtime, run } = await setupRuntime(t, { router });
  await runtime.runToCompletion(run.id);
  const detail = await runtime.detail(run.id);
  const metrics = computeAgentMetrics([detail]);
  assert.equal(metrics.cost.totalCostMicros, 600);
  assert.ok(metrics.cost.totalTokens >= 3750);
  assert.equal(metrics.cost.runsWithCost, 1);
  // والحالة الفارغة تحمل البند نفسه — العقد ثابت الشكل.
  assert.deepEqual(computeAgentMetrics([]).cost, { totalCostMicros: 0, totalTokens: 0, runsWithCost: 0 });
});

test('MR-10: budget refusal is governance — never converted by the governed fallback planner', async () => {
  assert.ok(!PLANNER_FALLBACK_CODES.includes('cost_budget_refused'));
  assert.ok(!PLANNER_FALLBACK_CODES.includes('cost_budget_unknown'));
  assert.ok(!PLANNER_FALLBACK_CODES.includes('model_cost_contract_violation'));
  const { router } = routerWith({ fastPlans: [], plannerPlans: [callPlan('read.alpha')] });
  const recorder = createRecordingTools();
  const primary = createProviderPlanner({ provider: router, tools: recorder.tools, allowedTools: [...READ_TOOLS] });
  const wrapped = createGovernedFallbackPlanner({ primary, fallback: createScriptedPlanner() });
  await assert.rejects(
    wrapped.plan({
      messages: [{ role: 'user', content: 'هدف' }],
      toolRuns: [],
      steps: [],
      memory: { summaries: [], facts: [] },
      run: { id: 'r1', status: 'running', limits: { maxCostMicros: 400 }, usage: { costMicros: 0 } }
    }),
    (error) => error.code === 'cost_budget_refused',
    'the refusal surfaces as-is instead of a silent deterministic plan'
  );
});
