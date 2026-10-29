import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempStore, createRecordingTools } from './support/agent-fixtures.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createScriptedPlanner } from '../src/agent/planner.js';
import {
  createProviderPlanner,
  PROVIDER_PLAN_SCHEMA,
  validateProviderPlan
} from '../src/agent/planner-provider.js';
import { RUN_STATUS, TOOL_RUN_STATUS } from '../src/agent/store.js';

const READ_TOOLS = Object.freeze(['read.alpha', 'read.beta']);

function callPlan(tool, args = {}) {
  return {
    action: 'call',
    tool,
    args,
    summary: null,
    rationale: 'A read is required before the final answer.',
    successCriteria: ['The selected read returns a durable tool result.']
  };
}

function finishPlan(summary) {
  return {
    action: 'finish',
    tool: null,
    args: null,
    summary,
    rationale: 'The available evidence is sufficient.',
    successCriteria: ['The final summary is grounded in the observed state.']
  };
}

function clarifyPlan(summary) {
  return {
    action: 'clarify',
    tool: null,
    args: null,
    summary,
    rationale: 'The goal is ambiguous and no read can disambiguate it.',
    successCriteria: ['The owner receives a specific clarification request.']
  };
}

function envelope(plan, usage = undefined) {
  return { plan, model: 'deterministic-mock', ...(usage ? { usage } : {}) };
}

async function setup(t, {
  provider,
  planner = null,
  recorder = null,
  allowedTools = READ_TOOLS,
  plannerToolAllowlist = allowedTools,
  plannerOptions = {},
  limits = {}
} = {}) {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const tools = recorder || createRecordingTools();
  const selectedPlanner = planner || createProviderPlanner({ provider, tools: tools.tools, allowedTools, ...plannerOptions });
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: tools.tools,
    planner: selectedPlanner,
    plannerToolAllowlist,
    limits: { maxSteps: 12, maxCostMicros: 100_000, ...limits },
    workerId: 'provider-test-worker',
    logger: { error() {} }
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'AI-002 mock slice' });
  const submit = (message = 'مهمة') => runtime.submit({ threadId: thread.id, message });
  return { fixture, runtime, recorder: tools, thread, submit };
}

test('AI-002: provider plan schema is closed and every step needs success criteria', async (t) => {
  const recorder = createRecordingTools();
  assert.equal(PROVIDER_PLAN_SCHEMA.additionalProperties, false);
  // A3: `calls` هي الخاصية الاختيارية الوحيدة — إلزاميتها تخص call_many ويفرضها
  // المدقق (call_many_calls_required)، فتبقى خطط call/finish/clarify القديمة صالحة حرفيًا.
  assert.deepEqual(
    [...PROVIDER_PLAN_SCHEMA.required].sort(),
    Object.keys(PROVIDER_PLAN_SCHEMA.properties).filter((key) => key !== 'calls').sort()
  );
  assert.ok(Object.hasOwn(PROVIDER_PLAN_SCHEMA.properties, 'calls'), 'call_many batch property is part of the closed schema');
  assert.equal(validateProviderPlan(callPlan('read.alpha'), { allowedTools: READ_TOOLS }).ok, true);
  assert.equal(validateProviderPlan({ ...callPlan('read.alpha'), unexpected: true }, { allowedTools: READ_TOOLS }).ok, false);
  assert.equal(validateProviderPlan({ ...callPlan('read.alpha'), successCriteria: [] }, { allowedTools: READ_TOOLS }).ok, false);
  assert.equal(validateProviderPlan({ ...finishPlan('done'), tool: 'read.alpha' }, { allowedTools: READ_TOOLS }).ok, false);
  assert.equal(validateProviderPlan(callPlan('read.gamma'), { allowedTools: READ_TOOLS }).ok, false);
  assert.throws(
    () => createProviderPlanner({
      provider: { createPlan: async () => envelope(finishPlan('no')) },
      tools: recorder.tools,
      allowedTools: ['read.alpha', 'calendar.create']
    }),
    /executable read tool/
  );
});

test('AI-002: Arabic goal executes one allowed read and feeds tool_result back with separated evidence', async (t) => {
  const requests = [];
  const provider = {
    name: 'mock-provider',
    async createPlan(request) {
      requests.push(request);
      const results = request.state.toolResults;
      if (results.length === 0) {
        return envelope(callPlan('read.alpha'), { inputTokens: 3, outputTokens: 2, costMicros: 1 });
      }
      return envelope(
        finishPlan(`النتيجة المقروءة alpha=${results[0].content.alpha}`),
        { inputTokens: 4, outputTokens: 1, costMicros: 1 }
      );
    }
  };
  const { fixture, runtime, recorder, thread, submit } = await setup(t, { provider });
  const { run } = await submit('اقرأ الحالة ثم أجب من النتيجة');
  await fixture.store.saveThreadSummary({
    threadId: thread.id,
    ownerId: 'owner',
    sourceRunId: run.id,
    summary: 'ملخص محفوظ يجب أن يصل إلى المخطط.'
  });
  await fixture.store.saveOwnerFact({
    ownerId: 'owner',
    sourceRunId: run.id,
    tag: 'preference',
    value: 'الإجابة بالعربية'
  });
  const events = [];
  runtime.subscribe(run.id, (event) => events.push(event));
  const finished = await runtime.runToCompletion(run.id);

  assert.equal(finished.status, RUN_STATUS.succeeded);
  assert.deepEqual(recorder.calls.map((call) => call.name), ['read.alpha']);
  assert.equal(requests.length, 2, 'one initial decision and one decision after tool_result');
  assert.equal(requests[0].goal, 'اقرأ الحالة ثم أجب من النتيجة');
  assert.deepEqual(requests[0].allowedTools, READ_TOOLS);
  assert.equal(requests[0].tools.length, 2);
  assert.equal(requests[0].tools.every((tool) => tool.risk === 'read'), true);
  assert.equal(requests[0].tools.every((tool) => tool.input_schema.additionalProperties === false), true);
  assert.deepEqual(requests[0].planSchema.properties.tool.enum, ['read.alpha', 'read.beta', null]);
  assert.equal(requests[0].memory.summaries[0].summary, 'ملخص محفوظ يجب أن يصل إلى المخطط.');
  assert.equal(requests[0].context.memory.facts[0].value, 'الإجابة بالعربية');
  assert.equal(requests[0].threadMessages.at(-1).content, 'اقرأ الحالة ثم أجب من النتيجة');
  const toolMessage = requests[1].messages.find((message) => message.type === 'tool_result');
  assert.equal(toolMessage.name, 'read.alpha');
  assert.equal(toolMessage.content.alpha, true);
  assert.ok(toolMessage.tool_run_id);
  assert.equal(requests[1].state.steps.length >= 3, true);

  const detail = await runtime.detail(run.id);
  assert.equal(detail.verification.verdict, 'PASS');
  assert.equal(detail.evidenceChain.ok, true);
  assert.equal(detail.toolRuns.length, 1);
  assert.equal(detail.outbox.length, 0);
  assert.equal(detail.approvals.length, 0);
  assert.equal(detail.run.usage.tokens, 10);
  assert.equal(detail.run.usage.costMicros, 2);
  const decisionEvidence = detail.evidence.filter((entry) => (
    ['plan_created', 'tool_selected', 'tool_executed', 'verification_result'].includes(entry.kind)
  ));
  assert.deepEqual(
    decisionEvidence.map((entry) => entry.kind),
    ['plan_created', 'tool_selected', 'tool_executed', 'plan_created', 'verification_result']
  );
  for (const entry of decisionEvidence) {
    assert.ok(entry.stepId, `${entry.kind} must link to its step`);
    assert.match(entry.inputHash, /^[a-f0-9]{64}$/);
    assert.match(entry.outputHash, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(
    events.map((event) => event.type).filter((type) => (
      ['plan_created', 'tool_selected', 'tool_executed', 'verification_result'].includes(type)
    )),
    ['plan_created', 'tool_selected', 'tool_executed', 'plan_created', 'verification_result']
  );
  assert.match(detail.steps.at(-1).summary, /alpha=true/);
});

test('AI-002: English goal can finish without a tool', async (t) => {
  let calls = 0;
  const provider = {
    async createPlan(request) {
      calls += 1;
      assert.equal(request.goal, 'Answer from the existing goal only.');
      return envelope(finishPlan('No read is necessary.'));
    }
  };
  const { runtime, recorder, submit } = await setup(t, { provider });
  const { run } = await submit('Answer from the existing goal only.');
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.succeeded);
  assert.equal(calls, 1);
  assert.equal(recorder.calls.length, 0);
  const detail = await runtime.detail(run.id);
  assert.equal(detail.toolRuns.length, 0);
  assert.deepEqual(detail.evidence.map((entry) => entry.kind).filter((kind) => kind.startsWith('tool_')), []);
});

test('AI-002: clarification is bounded and executes no tool', async (t) => {
  const provider = { createPlan: async () => envelope(clarifyPlan('Which document do you mean?')) };
  const { runtime, recorder, submit } = await setup(t, { provider });
  const { run } = await submit('Please handle the document.');
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.failed);
  assert.equal(finished.lastError, 'bounded_delivery');
  assert.equal(recorder.calls.length, 0);
  const detail = await runtime.detail(run.id);
  assert.equal(detail.steps.at(-1).summary, 'Which document do you mean?');
  assert.equal(detail.toolRuns.length, 0);
});

test('AI-002: malformed or unauthorized provider plans fail before tool execution', async (t) => {
  const plans = [
    { ...callPlan('read.alpha'), successCriteria: [] },
    callPlan('read.gamma'),
    { ...callPlan('read.alpha'), extra: true }
  ];
  for (const plan of plans) {
    const provider = { createPlan: async () => envelope(plan) };
    const { runtime, recorder, submit } = await setup(t, { provider });
    const { run } = await submit('Reject an invalid plan.');
    const finished = await runtime.runToCompletion(run.id);
    assert.equal(finished.status, RUN_STATUS.failed);
    assert.equal(finished.lastError, 'invalid_provider_plan');
    assert.equal(recorder.calls.length, 0);
    const detail = await runtime.detail(run.id);
    const rejected = detail.evidence.find((entry) => entry.kind === 'plan_created');
    assert.equal(rejected.verdict, 'BLOCK');
    assert.ok(rejected.stepId);
    assert.equal(detail.toolRuns.length, 0);
    assert.equal(detail.outbox.length, 0);
  }
});

test('AI-002: executor allowlist blocks an external tool before approval or outbox', async (t) => {
  const planner = createScriptedPlanner([{ action: 'call', tool: 'calendar.create', args: { summary: 'لا أثر' } }]);
  const { runtime, recorder, submit } = await setup(t, { planner, plannerToolAllowlist: ['read.alpha'] });
  const { run } = await submit('Attempt a tool outside the allowlist.');
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.failed);
  assert.equal(finished.lastError, 'planner_tool_not_allowed');
  assert.equal(recorder.calls.length, 0);
  const detail = await runtime.detail(run.id);
  assert.equal(detail.approvals.length, 0);
  assert.equal(detail.outbox.length, 0);
  assert.equal(detail.toolRuns.length, 0);
});

test('AI-002: failed read is returned once and stops safely without automatic retry', async (t) => {
  const requests = [];
  const provider = {
    async createPlan(request) {
      requests.push(request);
      if (request.state.toolResults.length === 0) return envelope(callPlan('read.beta'));
      assert.equal(request.state.toolResults[0].status, TOOL_RUN_STATUS.failed);
      return envelope(finishPlan('Stopped after the failed read; no retry was attempted.'));
    }
  };
  const recorder = createRecordingTools({ failTools: { beta: true } });
  const { runtime, submit } = await setup(t, { provider, recorder });
  const { run } = await submit('Fail safely.');
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.failed);
  assert.equal(finished.lastError, 'verification_blocked');
  assert.deepEqual(recorder.calls.map((call) => call.name), ['read.beta']);
  assert.equal(requests.length, 2);
  const detail = await runtime.detail(run.id);
  assert.equal(detail.toolRuns.length, 1);
  assert.equal(detail.toolRuns[0].status, TOOL_RUN_STATUS.failed);
  assert.equal(detail.evidence.find((entry) => entry.kind === 'tool_executed').verdict, 'BLOCK');
  assert.equal(detail.evidence.find((entry) => entry.kind === 'verification_result').verdict, 'BLOCK');
  assert.equal(detail.outbox.length, 0);
});

test('AI-002: a failed read cannot trigger an implicit replacement plan', async (t) => {
  let calls = 0;
  const provider = {
    async createPlan(request) {
      calls += 1;
      if (request.state.toolResults.length === 0) return envelope(callPlan('read.beta'));
      return envelope(callPlan('read.alpha'));
    }
  };
  const recorder = createRecordingTools({ failTools: { beta: true } });
  const { runtime, submit } = await setup(t, { provider, recorder });
  const { run } = await submit('Do not revise automatically.');
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.failed);
  assert.equal(finished.lastError, 'automatic_replan_disabled');
  assert.equal(calls, 2);
  assert.deepEqual(recorder.calls.map((call) => call.name), ['read.beta']);
  const detail = await runtime.detail(run.id);
  assert.equal(detail.toolRuns.length, 1);
  assert.equal(detail.outbox.length, 0);
});

test('AI-002: provider timeout stops the run without a tool or external effect', async (t) => {
  const provider = { createPlan: async () => new Promise(() => {}) };
  const { runtime, recorder, submit } = await setup(t, { provider, plannerOptions: { timeoutMs: 5 } });
  const { run } = await submit('Bounded provider latency.');
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.failed);
  assert.equal(finished.lastError, 'planner_provider_timeout');
  assert.equal(recorder.calls.length, 0);
  const detail = await runtime.detail(run.id);
  assert.equal(detail.toolRuns.length, 0);
  assert.equal(detail.outbox.length, 0);
});

test('AI-002: resumed run consumes a confirmed result without repeating its tool', async (t) => {
  const requests = [];
  const provider = {
    async createPlan(request) {
      requests.push(request);
      assert.equal(request.state.toolResults.length, 1);
      assert.equal(request.state.toolResults[0].content.alpha, true);
      return envelope(finishPlan('Resumed from the confirmed read.'));
    }
  };
  const { fixture, runtime, recorder, submit } = await setup(t, { provider });
  const { run } = await submit('Resume after interruption.');
  assert.equal(await fixture.store.claimRun(run.id, { leaseMs: 60_000, workerId: 'dead-provider-worker' }), true);
  const step = await fixture.store.appendStep({ runId: run.id, kind: 'act', title: 'read.alpha' });
  const started = await fixture.store.startToolRun({
    runId: run.id,
    stepId: step.id,
    toolName: 'read.alpha',
    risk: 'read',
    idempotencyKey: `${run.id}:${step.index}:read.alpha`
  });
  await fixture.store.finishToolRun(started.toolRun.id, TOOL_RUN_STATUS.succeeded, JSON.stringify({ alpha: true }));
  await fixture.store.appendStep({ runId: run.id, kind: 'observe', title: 'read.alpha ✓', summary: 'confirmed' });
  await fixture.store.heartbeat(run.id, { leaseMs: -5_000 });

  const resumed = await runtime.runToCompletion(run.id);
  assert.equal(resumed.status, RUN_STATUS.succeeded);
  assert.equal(recorder.calls.length, 0, 'confirmed read.alpha is never executed again');
  assert.equal(requests.length, 1);
  const detail = await runtime.detail(run.id);
  assert.equal(detail.toolRuns.length, 1);
  assert.equal(detail.evidenceChain.ok, true);
});
