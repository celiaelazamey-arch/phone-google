import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTempStore, createRecordingTools } from './support/agent-fixtures.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createAgentHost, readAgentPlanner, selectProviderTools } from '../src/agent/index.js';
import {
  GEMINI_PLANNER_POLICY,
  PLANNER_PROVIDER_FAILURES,
  PROVIDER_PLAN_SCHEMA,
  createFallbackPlanner,
  createGeminiPlannerProvider,
  createProviderPlanner,
  toGeminiSchema,
  validateProviderPlan
} from '../src/agent/planner-provider.js';
import { EVIDENCE_KIND } from '../src/agent/evidence.js';
import { VERDICT } from '../src/agent/verifier.js';
import { RISK } from '../src/agent/tools.js';

const READ_TOOLS = Object.freeze(['read.alpha', 'read.beta']);
const KEY = 'gemini-key-that-must-never-leak';

function callPlan(tool = 'read.alpha', args = { echo: 'x' }) {
  return {
    action: 'call',
    tool,
    args,
    summary: null,
    rationale: 'A read is required first.',
    successCriteria: ['A durable tool result exists.']
  };
}

function finishPlan(summary = 'تم') {
  return {
    action: 'finish',
    tool: null,
    args: null,
    summary,
    rationale: 'The observed state is enough.',
    successCriteria: ['The summary cites what was observed.']
  };
}

/** A fake Gemini transport that records the exact wire request and replays one scripted answer. */
function fakeGemini({ status = 200, plan = callPlan(), plans = null, text = null, usage = true, modelVersion = 'gemini-2.5-flash-001', failWith = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    if (failWith) throw failWith;
    if (status !== 200) {
      return new Response(JSON.stringify({ error: { code: status } }), { status, headers: { 'content-type': 'application/json' } });
    }
    const scripted = plans ? plans[Math.min(calls.length - 1, plans.length - 1)] : null;
    const payloadText = text ?? JSON.stringify(scripted || plan);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: payloadText }] }, finishReason: 'STOP' }],
      modelVersion,
      ...(usage ? { usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, totalTokenCount: 150 } } : {})
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

async function setupRuntime(t, { provider, allowedTools = READ_TOOLS, plannerOptions = {} } = {}) {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const recorder = createRecordingTools();
  const providerPlanner = createProviderPlanner({ provider, tools: recorder.tools, allowedTools, ...plannerOptions });
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: recorder.tools,
    planner: providerPlanner,
    limits: { maxSteps: 12, maxCostMicros: 100_000, sessionBudgetMicros: 100_000 },
    workerId: 'wp31-test-worker',
    logger: { error() {} }
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'WP-3.1' });
  return { fixture, runtime, recorder, thread, providerPlanner };
}

test('GEM-01 — the wire schema is Gemini-shaped while the local validator stays the authority', () => {
  const wire = toGeminiSchema(PROVIDER_PLAN_SCHEMA);
  assert.deepEqual(wire.properties.tool, { type: 'string', nullable: true });
  assert.deepEqual(wire.properties.args, { type: 'object', nullable: true });
  assert.equal(wire.properties.successCriteria.type, 'array');
  assert.deepEqual(wire.properties.action.enum, ['call', 'finish', 'clarify']);
  assert.equal('additionalProperties' in wire, false);
  assert.equal('maxLength' in wire.properties.summary, false);
  assert.equal('minItems' in wire.properties.successCriteria, false);
  assert.deepEqual([...wire.required].sort(), Object.keys(PROVIDER_PLAN_SCHEMA.properties).sort());

  // The dropped constraints are still enforced locally: a 4001-character summary is rejected here, not by Gemini.
  assert.equal(validateProviderPlan({ ...finishPlan('x'.repeat(4001)) }, { allowedTools: READ_TOOLS }).ok, false);
  assert.equal(validateProviderPlan({ ...finishPlan('ok'), extra: 1 }, { allowedTools: READ_TOOLS }).ok, false);
});

test('GEM-02 — one POST with the closed schema and the key in a header; tokens are measured and cost is not claimed', async (t) => {
  // First decision reads, the second (seeing tool_result) finishes — the real loop shape.
  const gemini = fakeGemini({ plans: [callPlan('read.alpha'), finishPlan('قُرئت الحالة.')] });
  const { runtime, recorder, thread } = await setupRuntime(t, {
    provider: createGeminiPlannerProvider({ apiKey: KEY, model: 'gemini-2.5-flash', fetchImpl: gemini.fetchImpl })
  });
  const submitted = await runtime.submit({ threadId: thread.id, message: 'اقرأ الحالة ثم أجب' });
  const run = await runtime.runToCompletion(submitted.run.id);

  assert.equal(gemini.calls.length >= 1, true);
  const { url, options, body } = gemini.calls[0];
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(options.headers['x-goog-api-key'], KEY);
  assert.equal(options.headers['content-type'], 'application/json');
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(body.generationConfig.temperature, 0);
  // The closed tool set travels as an enum, so the model is offered exactly the reads the executor will allow.
  assert.deepEqual(body.generationConfig.responseSchema.properties.tool, { type: 'string', nullable: true, enum: [...READ_TOOLS] });
  assert.match(body.systemInstruction.parts[0].text, /أعد كائن JSON واحدًا فقط/);
  assert.equal(body.systemInstruction.parts[0].text, GEMINI_PLANNER_POLICY);
  const sentState = JSON.parse(body.contents[0].parts[0].text);
  assert.equal(sentState.goal, 'اقرأ الحالة ثم أجب');
  assert.deepEqual(sentState.allowedTools, [...READ_TOOLS]);
  assert.deepEqual(sentState.state.run, { id: run.id, status: sentState.state.run.status });

  // The model decision ran a real read, and its usage reached the durable counters.
  assert.deepEqual(recorder.calls.map((call) => call.name), ['read.alpha']);
  const detail = await runtime.detail(run.id);
  // Two decisions in this run (read, then finish), 150 tokens each: the counters accumulate per decision.
  assert.equal(gemini.calls.length, 2);
  assert.equal(detail.run.usage.tokens, 300);
  assert.equal(detail.run.usage.costMicros, 0, 'no price table is invented');
});

test('GEM-03 — provider failures are coded, carry no key/body, and never retry by themselves', async (t) => {
  const http = fakeGemini({ status: 429 });
  const failed = createGeminiPlannerProvider({ apiKey: KEY, fetchImpl: http.fetchImpl });
  await assert.rejects(() => failed.createPlan({ goal: 'g', planSchema: PROVIDER_PLAN_SCHEMA, tools: [], allowedTools: [], state: {}, memory: {}, threadMessages: [] }), (error) => {
    assert.equal(error.code, 'planner_provider_failed');
    assert.deepEqual(error.details, ['http_status:429']);
    assert.equal(String(error.message).includes(KEY), false);
    assert.equal(JSON.stringify(error).includes(KEY), false);
    return true;
  });
  assert.equal(http.calls.length, 1, 'one attempt only');

  const empty = fakeGemini({ text: '   ' });
  const noReply = createGeminiPlannerProvider({ apiKey: KEY, fetchImpl: empty.fetchImpl });
  await assert.rejects(() => noReply.createPlan({ goal: 'g', planSchema: PROVIDER_PLAN_SCHEMA, tools: [], allowedTools: [], state: {}, memory: {}, threadMessages: [] }), (error) => error.code === 'planner_provider_empty');

  const broken = createGeminiPlannerProvider({ apiKey: KEY, fetchImpl: async () => { throw new TypeError('boom'); } });
  await assert.rejects(() => broken.createPlan({ goal: 'g', planSchema: PROVIDER_PLAN_SCHEMA, tools: [], allowedTools: [], state: {}, memory: {}, threadMessages: [] }), (error) => error.code === 'planner_provider_unreachable');

  assert.throws(() => createGeminiPlannerProvider({ apiKey: '   ' }), (error) => error.code === 'planner_provider_not_configured');
});

test('FB-01 — a valid provider plan passes through untouched; a provider failure yields a marked deterministic decision', async () => {
  const fine = createFallbackPlanner({
    primary: { name: 'gemini', providerDriven: true, allowedTools: READ_TOOLS, plan: async () => ({ action: 'call', tool: 'read.alpha', args: {} }) },
    fallback: { name: 'demo-deterministic', plan: async () => ({ action: 'finish', summary: 'fallback' }) }
  });
  const direct = await fine.plan({ toolRuns: [] });
  assert.equal(direct.action, 'call');
  assert.equal(direct.plannerFallback, undefined, 'a healthy provider is not decorated');
  assert.equal(fine.name, 'gemini+deterministic-fallback');
  assert.deepEqual(fine.allowedTools, [...READ_TOOLS]);
  assert.equal(fine.providerDriven, true);

  const degraded = createFallbackPlanner({
    primary: {
      name: 'gemini',
      providerDriven: true,
      allowedTools: READ_TOOLS,
      plan: async () => {
        throw Object.assign(new Error('planner_provider_timeout'), {
          code: 'planner_provider_timeout',
          details: ['timeout'],
          providerTrace: { provider: 'gemini', model: 'gemini-2.5-flash', request: { goal: 'g' } }
        });
      }
    },
    fallback: { name: 'demo-deterministic', plan: async () => ({ action: 'finish', summary: 'حتمي' }) }
  });
  const decision = await degraded.plan({ toolRuns: [] });
  assert.equal(decision.action, 'finish');
  assert.equal(decision.summary, 'حتمي');
  assert.equal(decision.plannerFallback.code, 'planner_provider_timeout');
  assert.deepEqual(decision.plannerFallback.details, ['timeout']);
  assert.equal(decision.plannerFallback.provider, 'gemini');
  assert.equal(decision.plannerFallback.model, 'gemini-2.5-flash');
  assert.deepEqual(decision.plannerFallback.request, { goal: 'g' });
  assert.equal(PLANNER_PROVIDER_FAILURES.includes('planner_provider_timeout'), true);
});

test('FB-02 — cancellation and unknown errors are never softened into a fallback plan', async () => {
  const fallbackCalls = [];
  const fallback = { name: 'demo-deterministic', plan: async () => { fallbackCalls.push(1); return { action: 'finish', summary: 'x' }; } };
  const cancelled = createFallbackPlanner({
    primary: { name: 'gemini', providerDriven: true, allowedTools: READ_TOOLS, plan: async () => { throw Object.assign(new Error('planner_cancelled'), { code: 'planner_cancelled' }); } },
    fallback
  });
  await assert.rejects(() => cancelled.plan({ toolRuns: [] }), (error) => error.code === 'planner_cancelled');

  const aborted = createFallbackPlanner({
    primary: { name: 'gemini', providerDriven: true, allowedTools: READ_TOOLS, plan: async () => { throw Object.assign(new Error('boom'), { code: 'planner_provider_failed' }); } },
    fallback
  });
  await assert.rejects(() => aborted.plan({ toolRuns: [], signal: { aborted: true } }), (error) => error.code === 'planner_provider_failed');

  const unknown = createFallbackPlanner({
    primary: { name: 'gemini', providerDriven: true, allowedTools: READ_TOOLS, plan: async () => { throw Object.assign(new Error('weird'), { code: 'totally_unexpected' }); } },
    fallback
  });
  await assert.rejects(() => unknown.plan({ toolRuns: [] }), (error) => error.code === 'totally_unexpected');
  assert.deepEqual(fallbackCalls, [], 'no fallback ran for a cancellation, an aborted context or an unknown code');
});

test('FB-03 — in the runtime a fallback is a visible step plus blocked evidence, and the fallback decision is what runs', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const recorder = createRecordingTools();
  const providerPlanner = createProviderPlanner({
    provider: createGeminiPlannerProvider({ apiKey: KEY, fetchImpl: async () => new Response('{"error":{}}', { status: 503 }) }),
    tools: recorder.tools,
    allowedTools: READ_TOOLS
  });
  const planner = createFallbackPlanner({ primary: providerPlanner, fallback: { name: 'demo-deterministic', plan: async () => ({ action: 'finish', summary: 'أنهيت دون أي أداة.' }) } });
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: recorder.tools,
    planner,
    limits: { maxSteps: 6, maxCostMicros: 50_000 },
    workerId: 'wp31-fallback',
    logger: { error() {} }
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'fallback' });
  const submitted = await runtime.submit({ threadId: thread.id, message: 'أجب دون أدوات' });
  const run = await runtime.runToCompletion(submitted.run.id);

  assert.equal(run.status, 'succeeded');
  const steps = await fixture.store.listSteps(run.id);
  const fallbackStep = steps.find((step) => step.title === 'احتياط حتمي مرئي');
  assert.ok(fallbackStep, 'the fallback step is in the durable trace');
  assert.match(fallbackStep.summary, /planner_provider_failed/);

  const evidence = await fixture.store.listEvidence(run.id);
  const planEntry = evidence.find((entry) => entry.kind === EVIDENCE_KIND.planCreated && entry.verdict === VERDICT.block);
  assert.ok(planEntry, 'the failed model plan is evidence with verdict block');
  // Evidence bodies are hashed, not stored: what is provable is the kind, the verdict, the link to the step and
  // the intact chain — the same shape the approver and the verifier consume.
  assert.equal(planEntry.stepId, fallbackStep.id);
  assert.match(planEntry.inputHash, /^[a-f0-9]{64}$/);
  assert.match(planEntry.outputHash, /^[a-f0-9]{64}$/);
  const chain = await fixture.store.verifyEvidenceChain(run.id);
  assert.equal(chain.ok, true);
  assert.equal(recorder.calls.length, 0, 'the fallback decision ran, not a phantom tool call');
});

test('FB-04 — provider mode inherits the closed read allowlist, so the flag cannot widen the tool surface', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const recorder = createRecordingTools();
  const primary = createProviderPlanner({
    provider: createGeminiPlannerProvider({ apiKey: KEY, fetchImpl: async () => new Response('{}', { status: 500 }) }),
    tools: recorder.tools,
    allowedTools: READ_TOOLS,
    name: 'gemini'
  });
  const planner = createFallbackPlanner({ primary, fallback: { name: 'demo-deterministic', plan: async () => ({ action: 'finish', summary: 'x' }) } });
  const runtime = createAgentRuntime({ store: fixture.store, tools: recorder.tools, planner, limits: {}, workerId: 'wp31-allow', logger: { error() {} } });
  assert.deepEqual(runtime.status().plannerToolAllowlist, [...READ_TOOLS]);
  assert.equal(runtime.status().planner, 'gemini+deterministic-fallback');
});

test('HOST-01 — the planner mode is a closed set, the default stays demo, and provider mode fails closed without a key', async (t) => {
  assert.equal(readAgentPlanner({}), 'demo');
  assert.equal(readAgentPlanner({ CELIA_AGENT_PLANNER: ' DEMO ' }), 'demo');
  assert.equal(readAgentPlanner({ CELIA_AGENT_PLANNER: 'provider' }), 'provider');
  assert.equal(readAgentPlanner({ CELIA_AGENT_PLANNER: 'gemini' }), 'provider');
  assert.throws(() => readAgentPlanner({ CELIA_AGENT_PLANNER: 'ollama' }), /demo or provider/);

  // Selection keeps only executable reads, dedupes, and stops at four.
  const recorder = createRecordingTools();
  const tools = recorder.tools;
  assert.deepEqual(selectProviderTools({ tools, requested: ['read.alpha', 'read.alpha', 'read.beta', 'missing.tool'] }), ['read.alpha', 'read.beta']);
  assert.deepEqual(selectProviderTools({ tools, requested: [] }).length >= 2, false);

  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-wp31-host-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const baseEnv = { CELIA_AGENT_RUNTIME: 'sqlite', CELIA_AGENT_SQLITE_PATH: path.join(directory, 'agent.sqlite3') };
  const logger = { error() {}, info() {} };

  const withoutKey = createAgentHost({ config: { nodeEnv: 'test', userId: 'owner' }, env: { ...baseEnv, CELIA_AGENT_PLANNER: 'provider' }, statusProvider: () => ({}), logger });
  const blocked = await withoutKey.status();
  assert.equal(blocked.enabled, false);
  assert.equal(blocked.reason, 'planner_provider_not_configured');

  const invalid = createAgentHost({ config: { nodeEnv: 'test', userId: 'owner' }, env: { ...baseEnv, CELIA_AGENT_PLANNER: 'magic' }, statusProvider: () => ({}), logger });
  assert.equal((await invalid.status()).reason, 'invalid_agent_planner');

  const providerHost = createAgentHost({
    config: { nodeEnv: 'test', userId: 'owner' },
    env: { ...baseEnv, CELIA_AGENT_PLANNER: 'provider', GEMINI_API_KEY: KEY },
    statusProvider: () => ({}),
    logger
  });
  t.after(async () => {
    const runtime = await providerHost.get().catch(() => null);
    await runtime?.shutdown?.().catch(() => {});
  });
  const status = await providerHost.status();
  assert.equal(status.enabled, true);
  assert.equal(status.planner, 'gemini+deterministic-fallback');
  assert.ok(status.plannerToolAllowlist.length >= 2 && status.plannerToolAllowlist.length <= 4);
  for (const name of status.plannerToolAllowlist) {
    assert.equal(status.tools.find((tool) => tool.name === name).risk, RISK.read);
  }

  const demoHost = createAgentHost({ config: { nodeEnv: 'test', userId: 'owner' }, env: baseEnv, statusProvider: () => ({}), logger });
  t.after(async () => {
    const runtime = await demoHost.get().catch(() => null);
    await runtime?.shutdown?.().catch(() => {});
  });
  const demoStatus = await demoHost.status();
  assert.equal(demoStatus.planner, 'demo-deterministic');
  assert.equal(demoStatus.plannerToolAllowlist, null);
});
