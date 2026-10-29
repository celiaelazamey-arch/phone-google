import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTempStore, createRecordingTools } from './support/agent-fixtures.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createProviderPlanner } from '../src/agent/planner-provider.js';
import { createScriptedPlanner, DEMO_PLANNER_TOOL_SURFACE } from '../src/agent/planner.js';
import {
  GEMINI_PLANNER_INPUT_LIMITS,
  GEMINI_PLANNER_MAX_OUTPUT_TOKENS,
  buildGeminiPlannerPrompt,
  buildGeminiPlannerRequestBody,
  createGeminiPlannerProvider
} from '../src/agent/gemini-planner-provider.js';
import { createGovernedFallbackPlanner, PLANNER_FALLBACK_CODES } from '../src/agent/planner-fallback.js';
import { createAgentHost } from '../src/agent/index.js';
import { RUN_STATUS } from '../src/agent/store.js';

const READ_TOOLS = Object.freeze(['read.alpha', 'read.beta']);
const TEST_KEY = 'test-gemini-key-0123456789abcdef';

function finishPlan(summary) {
  return {
    action: 'finish',
    tool: null,
    args: null,
    summary,
    rationale: 'الدليل المتاح كافٍ.',
    successCriteria: ['الخلاصة مبنية على الحالة الملحوظة.']
  };
}

function callPlan(tool, args = {}) {
  return {
    action: 'call',
    tool,
    args,
    summary: null,
    rationale: 'مطلوب قراءة واحدة قبل الإجابة.',
    successCriteria: ['القراءة تعيد نتيجة دائمة.']
  };
}

function geminiHttpResponse(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => payload };
}

function geminiResult(planText, { usage = true, modelVersion = 'gemini-2.5-flash-001' } = {}) {
  return {
    modelVersion,
    candidates: [{ content: { parts: [{ text: planText }] } }],
    ...(usage
      ? { usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 } }
      : {})
  };
}

/** fetch وهمي: يسجل الطلبات ويعيد الاستجابات بالترتيب — لا شبكة إطلاقًا. */
function fakeFetch(responses) {
  const requests = [];
  const queue = [...responses];
  const impl = async (url, options) => {
    requests.push({ url, options });
    if (options?.signal?.aborted) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    const next = queue.shift();
    if (!next) throw new Error('fakeFetch queue exhausted');
    if (typeof next === 'function') return next(url, options);
    return next;
  };
  return { impl, requests };
}

function hangingFetch() {
  return async (_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }, { once: true });
  });
}

async function setupRuntime(t, { planner, recorder, limits = {} }) {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: recorder.tools,
    planner,
    limits: { maxSteps: 12, maxCostMicros: 100_000, ...limits },
    workerId: 'gemini-test-worker',
    logger: { error() {} }
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'A1 gemini slice' });
  return { fixture, runtime, recorder, thread };
}

function providerPlanner(provider, recorder, options = {}) {
  return createProviderPlanner({ provider, tools: recorder.tools, allowedTools: READ_TOOLS, ...options });
}

// ─── المحوّل: بناء الطلب ─────────────────────────────────────────────────────

test('GEM-01: request body is strict JSON mode with the full contract in the system prompt', () => {
  const request = {
    goal: 'اقرأ الحالة ثم أجب',
    threadMessages: [{ role: 'user', content: 'اقرأ الحالة ثم أجب' }],
    state: { steps: [], toolResults: [] },
    memory: { summaries: [], facts: [] },
    allowedTools: [...READ_TOOLS],
    tools: [{ name: 'read.alpha', description: 'alpha', risk: 'read', input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
    planSchema: { type: 'object', properties: { tool: { enum: ['read.alpha', 'read.beta', null] } } }
  };
  const body = buildGeminiPlannerRequestBody(request);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(body.generationConfig.temperature, 0);
  assert.equal(body.generationConfig.maxOutputTokens, GEMINI_PLANNER_MAX_OUTPUT_TOKENS);
  const system = body.systemInstruction.parts[0].text;
  assert.match(system, /JSON واحد فقط/);
  assert.ok(system.includes('"read.alpha"'), 'allowed tools reach the contract');
  assert.ok(system.includes('planSchema'), 'plan schema reaches the contract');
  const user = body.contents[0].parts[0].text;
  assert.ok(user.includes('اقرأ الحالة ثم أجب'));
  assert.equal(body.contents[0].role, 'user');
});

test('GEM-02: oversized inputs are truncated deterministically with an explicit marker', () => {
  const long = 'م'.repeat(GEMINI_PLANNER_INPUT_LIMITS.maxMessageChars + 500);
  const prompt = buildGeminiPlannerPrompt({
    goal: long,
    threadMessages: Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: `رسالة ${i}` })),
    state: { steps: [], toolResults: [{ name: 'read.alpha', status: 'succeeded', content: { blob: 'x'.repeat(10_000) } }] },
    memory: { summaries: [], facts: [] },
    allowedTools: [...READ_TOOLS],
    tools: [],
    planSchema: {}
  });
  const state = JSON.parse(prompt.user);
  assert.equal(state.threadMessages.length, GEMINI_PLANNER_INPUT_LIMITS.maxThreadMessages);
  assert.equal(state.threadMessages.at(-1).content, 'رسالة 29', 'the newest messages are kept');
  assert.match(state.goal, /قُصّ \d+ حرفًا/);
  assert.ok(state.toolResults[0].content.length <= GEMINI_PLANNER_INPUT_LIMITS.maxToolResultChars + 30);
});

test('GEM-03: provider construction rejects missing, placeholder or short keys and bad models', () => {
  assert.throws(() => createGeminiPlannerProvider({}), /GEMINI_API_KEY/);
  assert.throws(() => createGeminiPlannerProvider({ apiKey: 'replace-with-your-gemini-key' }), /GEMINI_API_KEY/);
  assert.throws(() => createGeminiPlannerProvider({ apiKey: 'short' }), /GEMINI_API_KEY/);
  assert.throws(() => createGeminiPlannerProvider({ apiKey: TEST_KEY, model: 'bad model!' }), /model id/);
  assert.throws(() => createGeminiPlannerProvider({ apiKey: TEST_KEY, fetchImpl: 'not-a-fn' }), /fetch implementation/);
});

// ─── المحوّل داخل الحلقة الفعلية ────────────────────────────────────────────

test('GEM-04: a finish plan from mocked Gemini completes the run with measured usage', async (t) => {
  const { impl, requests } = fakeFetch([geminiHttpResponse(geminiResult(JSON.stringify(finishPlan('تمت الإجابة من الحالة.'))))]);
  const provider = createGeminiPlannerProvider({ apiKey: TEST_KEY, fetchImpl: impl });
  const recorder = createRecordingTools();
  const { fixture, runtime, thread } = await setupRuntime(t, { recorder, planner: providerPlanner(provider, recorder) });
  const { run } = await runtime.submit({ threadId: thread.id, message: 'أجب مباشرة' });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.succeeded);
  assert.equal(recorder.calls.length, 0);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(requests[0].options.headers['x-goog-api-key'], TEST_KEY);
  const detail = await runtime.detail(run.id);
  assert.equal(detail.run.usage.tokens, 10, 'usageMetadata tokens are recorded, not invented');
  await fixture.store.close?.();
});

test('GEM-05: a call plan executes exactly one allowed read then finishes from the tool_result', async (t) => {
  const { impl } = fakeFetch([
    geminiHttpResponse(geminiResult(JSON.stringify(callPlan('read.alpha', { echo: 'now' })))),
    geminiHttpResponse(geminiResult(JSON.stringify(finishPlan('alpha=true حسب القراءة.'))))
  ]);
  const provider = createGeminiPlannerProvider({ apiKey: TEST_KEY, fetchImpl: impl });
  const recorder = createRecordingTools();
  const { runtime, thread } = await setupRuntime(t, { recorder, planner: providerPlanner(provider, recorder) });
  const { run } = await runtime.submit({ threadId: thread.id, message: 'اقرأ ثم أجب' });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.succeeded);
  assert.deepEqual(recorder.calls.map((call) => call.name), ['read.alpha']);
  assert.deepEqual(recorder.calls[0].args, { echo: 'now' });
});

test('GEM-06: args returned as a JSON string are normalized once, not silently repaired further', async (t) => {
  const plan = { ...callPlan('read.alpha'), args: JSON.stringify({ echo: 'stringified' }) };
  const { impl } = fakeFetch([
    geminiHttpResponse(geminiResult(JSON.stringify(plan))),
    geminiHttpResponse(geminiResult(JSON.stringify(finishPlan('تم.'))))
  ]);
  const provider = createGeminiPlannerProvider({ apiKey: TEST_KEY, fetchImpl: impl });
  const recorder = createRecordingTools();
  const { runtime, thread } = await setupRuntime(t, { recorder, planner: providerPlanner(provider, recorder) });
  const { run } = await runtime.submit({ threadId: thread.id, message: 'اقرأ' });
  await runtime.runToCompletion(run.id);
  assert.deepEqual(recorder.calls[0].args, { echo: 'stringified' });
});

for (const [label, response, expectedError] of [
  ['HTTP 500', geminiHttpResponse({}, { ok: false, status: 500 }), 'planner_provider_unavailable'],
  ['HTTP 429', geminiHttpResponse({ error: { status: 'RESOURCE_EXHAUSTED' } }, { ok: false, status: 429 }), 'planner_provider_unavailable'],
  ['empty candidates', geminiHttpResponse({ candidates: [] }), 'planner_provider_unavailable'],
  ['prose instead of JSON', geminiHttpResponse(geminiResult('أعتقد أن الخطوة التالية هي القراءة.')), 'invalid_provider_plan'],
  ['markdown-fenced JSON is rejected, not unfenced', geminiHttpResponse(geminiResult('```json\n{"action":"finish"}\n```')), 'invalid_provider_plan'],
  ['schema violation: extra property', geminiHttpResponse(geminiResult(JSON.stringify({ ...finishPlan('ok'), extra: 1 }))), 'invalid_provider_plan'],
  ['schema violation: unknown action', geminiHttpResponse(geminiResult(JSON.stringify({ ...finishPlan('ok'), action: 'execute' }))), 'invalid_provider_plan'],
  ['schema violation: tool outside allowlist', geminiHttpResponse(geminiResult(JSON.stringify(callPlan('read.gamma')))), 'invalid_provider_plan']
]) {
  test(`GEM-07: ${label} fails the bare provider planner with ${expectedError} and zero tools`, async (t) => {
    const { impl } = fakeFetch([response]);
    const provider = createGeminiPlannerProvider({ apiKey: TEST_KEY, fetchImpl: impl });
    const recorder = createRecordingTools();
    const { runtime, thread } = await setupRuntime(t, { recorder, planner: providerPlanner(provider, recorder) });
    const { run } = await runtime.submit({ threadId: thread.id, message: 'مهمة' });
    const finished = await runtime.runToCompletion(run.id);
    assert.equal(finished.status, RUN_STATUS.failed);
    assert.equal(finished.lastError, expectedError);
    assert.equal(recorder.calls.length, 0, 'no tool may run after a rejected plan');
  });
}

test('GEM-08: a hanging Gemini call times out as planner_provider_timeout without any tool', async (t) => {
  const provider = createGeminiPlannerProvider({ apiKey: TEST_KEY, fetchImpl: hangingFetch() });
  const recorder = createRecordingTools();
  const { runtime, thread } = await setupRuntime(t, {
    recorder,
    planner: providerPlanner(provider, recorder, { timeoutMs: 50 })
  });
  const { run } = await runtime.submit({ threadId: thread.id, message: 'مهمة' });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.failed);
  assert.equal(finished.lastError, 'planner_provider_timeout');
  assert.equal(recorder.calls.length, 0);
});

test('GEM-09: missing usageMetadata yields zero unmeasured usage, never invented numbers', async (t) => {
  const { impl } = fakeFetch([geminiHttpResponse(geminiResult(JSON.stringify(finishPlan('تم.')), { usage: false }))]);
  const provider = createGeminiPlannerProvider({ apiKey: TEST_KEY, fetchImpl: impl });
  const envelope = await provider.createPlan({
    goal: 'x', threadMessages: [], state: { steps: [], toolResults: [] },
    memory: { summaries: [], facts: [] }, allowedTools: [...READ_TOOLS], tools: [], planSchema: {}
  });
  assert.equal(envelope.usage.measured, false);
  assert.equal(envelope.usage.inputTokens, 0);
  assert.equal(envelope.usage.outputTokens, 0);
  assert.equal('totalTokens' in envelope.usage, false);
  assert.equal(envelope.model, 'gemini-2.5-flash-001');
});

// ─── الغلاف المحكوم planner_fallback ────────────────────────────────────────

test('FBK-01: the governed wrapper enforces its own construction contract', () => {
  const primary = { name: 'p', providerDriven: true, allowedTools: READ_TOOLS, plan: async () => ({}) };
  const fallback = createScriptedPlanner();
  assert.throws(() => createGovernedFallbackPlanner({ primary: fallback, fallback }), /provider-driven primary/);
  assert.throws(() => createGovernedFallbackPlanner({ primary, fallback: primary }), /deterministic/);
  assert.throws(() => createGovernedFallbackPlanner({ primary, fallback, extraAllowedTools: [7] }), /tool names/);
  const wrapper = createGovernedFallbackPlanner({ primary, fallback, extraAllowedTools: ['celia.thread_context'] });
  assert.equal(wrapper.providerDriven, true);
  assert.deepEqual([...wrapper.allowedTools], ['read.alpha', 'read.beta', 'celia.thread_context']);
  assert.deepEqual([...PLANNER_FALLBACK_CODES].sort(), [
    'invalid_provider_plan', 'invalid_provider_tool_arguments',
    'planner_provider_timeout', 'planner_provider_unavailable',
    'max_replan_exceeded', 'replan_requires_read_tool'
  ].sort());
});

test('FBK-02: an invalid initial plan falls back visibly to the deterministic planner and the run completes', async (t) => {
  const { impl } = fakeFetch([
    geminiHttpResponse(geminiResult('ليست خطة JSON.')),
    geminiHttpResponse(geminiResult(JSON.stringify(finishPlan('اكتمل بعد قراءة المسار الحتمي.'))))
  ]);
  const provider = createGeminiPlannerProvider({ apiKey: TEST_KEY, fetchImpl: impl });
  const recorder = createRecordingTools();
  const planner = createGovernedFallbackPlanner({
    primary: providerPlanner(provider, recorder),
    fallback: createScriptedPlanner([{ action: 'call', tool: 'read.beta', args: {} }], { summary: 'اكتمل عبر المسار الحتمي.' })
  });
  const { runtime, thread } = await setupRuntime(t, { recorder, planner });
  const { run } = await runtime.submit({ threadId: thread.id, message: 'مهمة' });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.succeeded, 'the run survives the provider failure');
  assert.deepEqual(recorder.calls.map((call) => call.name), ['read.beta']);
  const detail = await runtime.detail(run.id);
  const fallbackStep = detail.steps.find((step) => step.title === 'planner_fallback');
  assert.ok(fallbackStep, 'the fallback is a visible step, not a silent recovery');
  assert.match(fallbackStep.summary, /invalid_provider_plan/);
  const blockEvidence = detail.evidence.find((entry) => entry.kind === 'plan_created' && entry.stepId === fallbackStep.id);
  assert.ok(blockEvidence, 'the provider failure is chained as BLOCK evidence');
  assert.equal(detail.evidenceChain.ok, true);
});

test('FBK-03: a provider failure after an executed read ends in a safe finish without new tools', async (t) => {
  const { impl } = fakeFetch([
    geminiHttpResponse(geminiResult(JSON.stringify(callPlan('read.alpha')))),
    geminiHttpResponse({}, { ok: false, status: 503 })
  ]);
  const provider = createGeminiPlannerProvider({ apiKey: TEST_KEY, fetchImpl: impl });
  const recorder = createRecordingTools();
  const planner = createGovernedFallbackPlanner({
    primary: providerPlanner(provider, recorder),
    fallback: createScriptedPlanner([{ action: 'call', tool: 'read.beta', args: {} }])
  });
  const { runtime, thread } = await setupRuntime(t, { recorder, planner });
  const { run } = await runtime.submit({ threadId: thread.id, message: 'اقرأ ثم أجب' });
  const finished = await runtime.runToCompletion(run.id);
  assert.deepEqual(recorder.calls.map((call) => call.name), ['read.alpha'], 'no replacement tool after observation');
  const detail = await runtime.detail(run.id);
  assert.match(detail.steps.at(-1).summary ?? '', /أُنهي التشغيل بأمان/);
  assert.ok(detail.steps.some((step) => step.title === 'planner_fallback'));
  // الإنهاء الآمن تسليم بحدود: التشغيل يُعلَّم فاشلًا بصدق، بلا إعادة محاولة عمياء وبلا أداة بديلة.
  assert.equal(finished.status, RUN_STATUS.failed);
  assert.equal(finished.lastError, 'bounded_delivery');
  assert.equal(detail.verification.verdict, 'PASS', 'the independent verifier accepts the safe bounded delivery');
});

test('FBK-04: cancellation and automatic_replan_disabled always propagate, never fall back', async () => {
  let fallbackCalls = 0;
  const fallback = { name: 'spy', async plan() { fallbackCalls += 1; return { action: 'finish', summary: 'لا' }; } };
  const failWith = (code) => createGovernedFallbackPlanner({
    primary: {
      name: 'p', providerDriven: true, allowedTools: READ_TOOLS,
      async plan() { throw Object.assign(new Error(code), { code }); }
    },
    fallback
  });
  await assert.rejects(() => failWith('planner_cancelled').plan({ toolRuns: [] }), /planner_cancelled/);
  await assert.rejects(() => failWith('automatic_replan_disabled').plan({ toolRuns: [] }), /automatic_replan_disabled/);
  await assert.rejects(() => failWith('some_unknown_code').plan({ toolRuns: [] }), /some_unknown_code/);
  assert.equal(fallbackCalls, 0);
});

// ─── توصيل الـhost والعلم ───────────────────────────────────────────────────

function hostEnv(directory, extra = {}) {
  return {
    NODE_ENV: 'test',
    CELIA_AGENT_RUNTIME: 'sqlite',
    CELIA_AGENT_SQLITE_PATH: path.join(directory, 'agent.sqlite3'),
    ...extra
  };
}

test('HOST-01: an unknown planner value is rejected explicitly and the default stays demo', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-planner-host-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bad = createAgentHost({
    config: { nodeEnv: 'test' },
    env: hostEnv(directory, { CELIA_AGENT_PLANNER: 'gpt5' }),
    logger: { info() {}, error() {} }
  });
  await assert.rejects(() => bad.ready, (error) => error.code === 'agent_planner_unavailable');

  const demo = createAgentHost({
    config: { nodeEnv: 'test' },
    env: hostEnv(directory),
    logger: { info() {}, error() {} }
  });
  const runtime = await demo.ready;
  t.after(() => runtime.shutdown());
  assert.equal(runtime.status().planner, 'demo-deterministic');
  assert.equal(runtime.status().plannerToolAllowlist, null, 'demo mode keeps today\'s behaviour untouched');
});

test('HOST-02: CELIA_AGENT_PLANNER=gemini without a key fails loudly instead of silently reverting to demo', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-planner-nokey-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const host = createAgentHost({
    config: { nodeEnv: 'test', gemini: { apiKey: '', model: 'gemini-2.5-flash' } },
    env: hostEnv(directory, { CELIA_AGENT_PLANNER: 'gemini' }),
    logger: { info() {}, error() {} }
  });
  await assert.rejects(() => host.ready, (error) => error.code === 'agent_planner_misconfigured');
  const status = await host.status();
  assert.equal(status.enabled, false);
  assert.equal(status.reason, 'agent_planner_misconfigured');
});

test('HOST-03: gemini mode wires provider + governed fallback with the read-only allowlist and completes a run offline', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-planner-gemini-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const providerRequests = [];
  const host = createAgentHost({
    config: { nodeEnv: 'test', gemini: { apiKey: TEST_KEY, model: 'gemini-2.5-flash' } },
    env: hostEnv(directory, { CELIA_AGENT_PLANNER: 'gemini' }),
    statusProvider: () => ({ version: '0.2.1' }),
    plannerProvider: {
      name: 'mock-gemini',
      async createPlan(request) {
        providerRequests.push(request);
        return { plan: finishPlan('تمت الإجابة.'), model: 'mock', usage: { inputTokens: 1, outputTokens: 1 } };
      }
    },
    logger: { info() {}, error() {} }
  });
  const runtime = await host.ready;
  t.after(() => runtime.shutdown());

  const status = runtime.status();
  assert.match(status.planner, /\+fallback\(demo-deterministic\)$/);
  for (const name of ['celia.thread_context', 'celia.system_status', 'celia.draft_outline']) {
    assert.ok(status.plannerToolAllowlist.includes(name), `${name} in executor allowlist`);
  }
  for (const name of DEMO_PLANNER_TOOL_SURFACE) {
    assert.ok(status.plannerToolAllowlist.includes(name), `fallback surface ${name} in executor allowlist`);
  }

  const thread = await runtime.store.createThread({ ownerId: 'owner', title: 'A1 host' });
  const { run } = await runtime.submit({ threadId: thread.id, message: 'أجب مباشرة' });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.succeeded);
  assert.equal(providerRequests.length, 1);
  assert.deepEqual(
    providerRequests[0].allowedTools,
    ['celia.thread_context', 'celia.system_status', 'celia.draft_outline'],
    'the provider only ever sees the closed read-only tool set'
  );
});

test('HOST-04: the real Gemini provider is constructed from config without any network call at boot', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-planner-boot-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const host = createAgentHost({
    config: { nodeEnv: 'test', gemini: { apiKey: TEST_KEY, model: 'gemini-2.5-flash' } },
    env: hostEnv(directory, { CELIA_AGENT_PLANNER: 'gemini' }),
    logger: { info() {}, error() {} }
  });
  const runtime = await host.ready;
  t.after(() => runtime.shutdown());
  assert.equal(runtime.status().enabled, true);
  assert.match(runtime.status().planner, /provider-structured-v1\+fallback/);
});
