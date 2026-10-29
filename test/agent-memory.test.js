import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempStore, createRecordingTools, threeReadsThenFinish } from './support/agent-fixtures.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createScriptedPlanner } from '../src/agent/planner.js';
import { buildMemoryFromSteps, memoryIsSafe, safeMemoryText } from '../src/agent/memory.js';
import { findSecret } from '../src/knowledge/validate.js';
import { EVIDENCE_KIND } from '../src/agent/evidence.js';
import { RUN_STATUS } from '../src/agent/store.js';

const fixedClock = () => Date.parse('2026-10-29T12:00:00.000Z');

function memorySteps() {
  return [
    { index: 4, kind: 'deliver', summary: 'نتيجة آمنة قابلة للمراجعة.' },
    { index: 2, kind: 'act', toolName: 'read.alpha' },
    { index: 1, kind: 'decide', summary: 'فهم الطلب' },
    { index: 3, kind: 'act', toolName: 'read.beta' },
    { index: 3, kind: 'act', toolName: 'read.alpha' }
  ];
}

test('MEM-01: deterministic summaries and tagged facts omit credential-shaped text', () => {
  const input = { run: { status: RUN_STATUS.succeeded }, steps: memorySteps() };
  const first = buildMemoryFromSteps(input);
  const second = buildMemoryFromSteps(input);
  assert.deepEqual(first, second);
  assert.match(first.summary, /read\.alpha/);
  assert.match(first.summary, /read\.beta/);
  assert.match(first.summary, /نتيجة آمنة/);
  assert.deepEqual(first.facts.map((fact) => fact.tag), [
    'owner.last_run_status',
    'owner.last_run_steps',
    'owner.last_tools',
    'owner.last_result'
  ]);
  assert.equal(memoryIsSafe(first), true);
  assert.equal(findSecret(first.summary), null);

  const secret = 'api_key=do-not-persist-this-value';
  assert.equal(safeMemoryText(secret), null);
  const unsafe = buildMemoryFromSteps({
    run: { status: RUN_STATUS.failed },
    steps: [{ index: 1, kind: 'deliver', summary: `failed: ${secret}` }]
  });
  assert.equal(memoryIsSafe(unsafe), true);
  assert.equal(unsafe.summary.includes(secret), false);
  assert.equal(unsafe.facts.some((fact) => fact.tag === 'owner.last_result'), false);
  const credentialTool = `AIza${'a'.repeat(30)}`;
  const toolAttempt = buildMemoryFromSteps({
    run: { status: RUN_STATUS.succeeded },
    steps: [{ index: 1, kind: 'act', toolName: credentialTool }]
  });
  assert.equal(toolAttempt.facts.some((fact) => fact.tag === 'owner.last_tools'), false);
  assert.equal(memoryIsSafe(toolAttempt), true);
});

test('MEM-02: run.finished persists memory and exposes context_memory in the planner context and harness', async (t) => {
  const fixture = await createTempStore({ clock: fixedClock });
  t.after(() => fixture.cleanup());
  const recorder = createRecordingTools();
  const contexts = [];
  const planner = createScriptedPlanner(threeReadsThenFinish(), { summary: 'ملخص تسليم آمن' });
  const originalPlan = planner.plan;
  planner.plan = async (context) => {
    contexts.push(context);
    return originalPlan(context);
  };
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: recorder.tools,
    planner,
    clock: fixedClock,
    workerId: 'memory-test-worker',
    logger: { error() {} }
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'memory' });
  const { run } = await runtime.submit({ threadId: thread.id, message: 'اختبار الذاكرة', clientMessageId: 'memory-run-0001' });
  assert.equal((await runtime.runToCompletion(run.id)).status, RUN_STATUS.succeeded);

  const memory = await runtime.memory('owner');
  assert.equal(memory.summaries.length, 1);
  assert.equal(memory.summaries[0].threadId, thread.id);
  assert.equal(memory.summaries[0].sourceRunId, run.id);
  assert.equal(memory.facts.length, 4);
  assert.equal(memoryIsSafe({ summary: memory.summaries[0].summary, facts: memory.facts }), true);
  assert.ok(contexts.every((context) => context.context_memory?.summaries === true && context.context_memory?.facts === true));
  const harness = runtime.harness();
  assert.deepEqual(harness.context_memory, { summaries: true, facts: true });
  const component = harness.components.find((item) => item.id === 'context_memory');
  assert.equal(component.summaries, true);
  assert.equal(component.facts, true);

  const reopened = await fixture.reopen();
  t.after(() => reopened.driver.close());
  assert.deepEqual(await reopened.store.listMemory('owner'), memory);
});

test('MEM-03: memory reads and permanent deletion are owner-scoped and deletion is hash-chained evidence', async (t) => {
  const fixture = await createTempStore({ clock: fixedClock });
  t.after(() => fixture.cleanup());
  const { store } = fixture;
  const thread = await store.createThread({ ownerId: 'owner', title: 'owned memory' });
  const { run } = await store.createRun({
    threadId: thread.id,
    ownerId: 'owner',
    planner: 'memory-test',
    maxSteps: 12,
    maxCostMicros: 1000
  });
  await store.finishRun(run.id, RUN_STATUS.succeeded);
  const summary = await store.saveThreadSummary({
    threadId: thread.id,
    ownerId: 'owner',
    sourceRunId: run.id,
    summary: 'ملخص مملوك'
  });
  const fact = await store.saveOwnerFact({ ownerId: 'owner', sourceRunId: run.id, tag: 'owner.preference', value: 'قيمة آمنة' });
  const runtime = createAgentRuntime({
    store,
    tools: createRecordingTools().tools,
    planner: createScriptedPlanner(),
    clock: fixedClock,
    logger: { error() {} }
  });
  t.after(() => runtime.shutdown());

  await assert.rejects(runtime.memoryItem('summary', summary.id, 'another-owner'), (error) => error.status === 404);
  await assert.rejects(runtime.deleteMemory('fact', fact.id, 'another-owner'), (error) => error.status === 404);
  assert.equal((await store.getMemoryItem('fact', fact.id, 'owner')).id, fact.id);
  assert.deepEqual(await store.listMemory('another-owner'), { summaries: [], facts: [] });

  const deleted = await runtime.deleteMemory('summary', summary.id, 'owner');
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.evidence.kind, EVIDENCE_KIND.memoryDeleted);
  assert.equal(await store.getMemoryItem('summary', summary.id, 'owner'), null);
  await assert.rejects(runtime.deleteMemory('summary', summary.id, 'owner'), (error) => error.status === 404);
  const evidence = await store.listEvidence(run.id);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].kind, EVIDENCE_KIND.memoryDeleted);
  assert.deepEqual(evidence[0].sourceIds, [summary.id]);
  assert.equal((await store.verifyEvidenceChain(run.id)).ok, true);

  const deletedFact = await runtime.deleteMemory('fact', fact.id, 'owner');
  assert.equal(deletedFact.deleted, true);
  assert.equal((await store.verifyEvidenceChain(run.id)).ok, true);
  assert.deepEqual(await store.listMemory('owner'), { summaries: [], facts: [] });
});

test('MEM-04: upserts retain provenance, enforce source ownership and hide expired rows', async (t) => {
  let now = fixedClock();
  const fixture = await createTempStore({ clock: () => now });
  t.after(() => fixture.cleanup());
  const { store } = fixture;
  const thread = await store.createThread({ ownerId: 'owner', title: 'upsert' });
  const { run } = await store.createRun({ threadId: thread.id, ownerId: 'owner', planner: 'test', maxSteps: 1, maxCostMicros: 1 });
  const first = await store.saveOwnerFact({ ownerId: 'owner', sourceRunId: run.id, tag: 'owner.preference', value: 'أول' });
  now += 1000;
  const second = await store.saveOwnerFact({ ownerId: 'owner', sourceRunId: run.id, tag: 'owner.preference', value: 'ثانٍ' });
  assert.equal(second.id, first.id);
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(second.value, 'ثانٍ');
  await assert.rejects(
    store.saveOwnerFact({ ownerId: 'another-owner', sourceRunId: run.id, tag: 'owner.preference', value: 'مرفوض' }),
    (error) => error.code === 'memory_source_not_found'
  );
  await assert.rejects(
    store.saveThreadSummary({ threadId: thread.id, ownerId: 'owner', sourceRunId: run.id, summary: 'api_key=must-not-persist' }),
    (error) => error.code === 'memory_secret_detected'
  );
  const expired = await store.saveOwnerFact({
    ownerId: 'owner',
    sourceRunId: run.id,
    tag: 'owner.expired',
    value: 'منتهي',
    expiresAt: new Date(now - 1).toISOString()
  });
  assert.equal(await store.getMemoryItem('fact', expired.id, 'owner'), null);
  assert.equal((await store.getMemoryItem('fact', expired.id, 'owner', { includeExpired: true })).id, expired.id);
  assert.equal((await store.listMemory('owner')).facts.some((fact) => fact.tag === 'owner.expired'), false);
  assert.equal((await store.listMemory('owner', { includeExpired: true })).facts.some((fact) => fact.tag === 'owner.expired'), true);
});
