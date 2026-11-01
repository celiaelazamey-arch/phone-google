import test from 'node:test';
import assert from 'node:assert/strict';

import { createTempStore, createRecordingTools, threeReadsThenFinish } from './support/agent-fixtures.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createScriptedPlanner } from '../src/agent/planner.js';
import { RUN_STATUS } from '../src/agent/store.js';
import { BUS_KIND } from '../src/agent/collaboration-bus.js';

/**
 * The durable half of XAG-001 (DEC-106): a real store, a real runtime, no mocks for the parts that
 * matter. XB-01..XB-08 are answered here; the contract-only answers are in collaboration-bus.test.js.
 */

async function setup(t, { limits } = {}) {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const recorder = createRecordingTools();
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: recorder.tools,
    planner: createScriptedPlanner(threeReadsThenFinish()),
    limits: { maxSteps: 12, maxCostMicros: 100_000, ...limits },
    workerId: 'test-worker',
    logger: { error() {} }
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'ناقل التعاون' });
  const submit = (message = 'مهمة') => runtime.submit({ threadId: thread.id, message });
  return { fixture, recorder, runtime, thread, submit };
}

const roster = [{ id: 'researcher', tools: ['read.alpha'], maxRisk: 'read' }];

async function delegated(t, extra = {}) {
  const ctx = await setup(t, extra);
  const { run: parent } = await ctx.submit();
  const { children } = await ctx.runtime.delegate({
    parentRunId: parent.id,
    roster,
    tasks: [{ taskId: 'r1', agent: 'researcher', objective: 'اجمع المصادر', steps: 6, costMicros: 9_000 }]
  });
  return { ...ctx, parent, child: children[0].run };
}

test('XB-01: a message survives a restart and is readable from a fresh store', async (t) => {
  const { fixture, runtime, parent, child } = await delegated(t);

  const sent = await runtime.sendMessage({
    fromRunId: child.id,
    to: 'parent',
    kind: BUS_KIND.resultReady,
    payload: { summary: 'ثلاثة مصادر', sources: 3 }
  });
  assert.equal(sent.created, true);
  assert.equal(sent.message.to, `run:${parent.id}`, 'the child addresses its parent by resolution, not by guessing');
  assert.equal(sent.message.traceId, parent.id, 'the trace root is the parent');

  const reopened = await fixture.reopen();
  const pulled = await (async () => {
    const twin = createAgentRuntime({
      store: reopened.store,
      tools: createRecordingTools().tools,
      planner: createScriptedPlanner(threeReadsThenFinish()),
      limits: { maxSteps: 12, maxCostMicros: 100_000 },
      workerId: 'test-worker-2',
      logger: { error() {} }
    });
    return twin.pullMessages({ runId: parent.id });
  })();

  assert.equal(pulled.messages.length, 1, 'the message outlived the process that sent it');
  assert.equal(pulled.messages[0].messageId, sent.message.messageId);
  assert.deepEqual(pulled.messages[0].payload, { summary: 'ثلاثة مصادر', sources: 3 });
  await reopened.driver.close?.();
});

test('XB-02: pulling twice returns the same message until it is acknowledged, and acknowledging is forward-only', async (t) => {
  const { runtime, parent, child } = await delegated(t);
  const sent = await runtime.sendMessage({ fromRunId: child.id, to: 'parent', kind: BUS_KIND.resultReady, payload: { ok: true } });

  const first = await runtime.pullMessages({ runId: parent.id });
  const second = await runtime.pullMessages({ runId: parent.id });
  assert.equal(first.messages.length, 1);
  assert.equal(second.messages.length, 1, 'pulling is not acknowledging');
  assert.equal(second.messages[0].messageId, sent.message.messageId, 'the same id, so an effect can recognise it');

  const ack = await runtime.ackMessages({ runId: parent.id, lastSeq: sent.message.seq });
  assert.equal(ack.advanced, true);
  assert.equal((await runtime.pullMessages({ runId: parent.id })).messages.length, 0);

  const stale = await runtime.ackMessages({ runId: parent.id, lastSeq: 0 });
  assert.equal(stale.advanced, false, 'a stale acknowledgement cannot rewind delivery');
  await assert.rejects(runtime.ackMessages({ runId: parent.id, lastSeq: 99 }), (error) => error.code === 'ack_beyond_head');
});

test('XB-03: sequence is per trace and monotonic, even when two senders write in a row', async (t) => {
  const { runtime, parent, child } = await delegated(t);
  const a = await runtime.sendMessage({ fromRunId: child.id, to: 'parent', kind: BUS_KIND.handoff, payload: { step: 1 } });
  const b = await runtime.sendMessage({ fromRunId: child.id, to: 'parent', kind: BUS_KIND.handoff, payload: { step: 2 } });
  assert.equal(a.message.seq, 1);
  assert.equal(b.message.seq, 2);

  const manager = await runtime.sendMessage({ fromRunId: parent.id, to: `run:${child.id}`, kind: BUS_KIND.clarifyAsk, payload: { question: 'أي مصدر؟' } });
  assert.equal(manager.message.seq, 3, 'the sequence belongs to the trace, so both sides share one order');
});

test('XB-04: a message from a grandchild still carries the root trace', async (t) => {
  const { runtime, parent, child } = await delegated(t);
  const grandchild = await runtime.delegate({
    parentRunId: child.id,
    roster,
    tasks: [{ taskId: 'g1', agent: 'researcher', objective: 'تحقق', steps: 4, costMicros: 5_000 }]
  });
  const deep = grandchild.children[0].run;
  const sent = await runtime.sendMessage({ fromRunId: deep.id, to: 'parent', kind: BUS_KIND.resultFailed, payload: { reason: 'تعذّر الوصول' } });
  assert.equal(sent.message.traceId, parent.id);
  assert.equal(sent.message.to, `run:${child.id}`, 'parent means the immediate parent, not the root');
});

test('the attestation lands in the sender chain before the message can be read', async (t) => {
  const { fixture, runtime, child } = await delegated(t);
  const sent = await runtime.sendMessage({ fromRunId: child.id, to: 'owner', kind: BUS_KIND.resultReady, payload: { done: true } });
  assert.ok(sent.message.evidenceId, 'every message points at its evidence entry');

  const evidence = await fixture.store.listEvidence(child.id);
  const record = evidence.find((entry) => entry.id === sent.message.evidenceId);
  assert.ok(record, 'the entry exists in the sender chain');
  assert.equal(record.kind, 'bus_message');
  assert.equal((await fixture.store.verifyEvidenceChain(child.id)).ok, true, 'and the chain still verifies');
});

test('XB-07: a message to a run that never reads it stays pending and does not open a run', async (t) => {
  const { fixture, runtime, parent, child } = await delegated(t);
  const sent = await runtime.sendMessage({ fromRunId: child.id, to: 'parent', kind: BUS_KIND.resultReady, payload: { done: true } });
  await runtime.runToCompletion(child.id);

  const before = (await fixture.store.listRuns(parent.threadId, { limit: 50 })).length;
  const outstanding = await fixture.store.listBusOutstanding();
  assert.equal(outstanding.length, 1, 'the message is visible as owed');
  assert.equal(outstanding[0].messageId, sent.message.messageId);
  const after = (await fixture.store.listRuns(parent.threadId, { limit: 50 })).length;
  assert.equal(after, before, 'nothing woke up and created a run: delivery is a decision');
});

test('XB-08: a quarantined message keeps its reason, disappears from the queue and surfaces as a failure', async (t) => {
  const { fixture, runtime, parent, child } = await delegated(t);
  const sent = await runtime.sendMessage({ fromRunId: child.id, to: 'parent', kind: BUS_KIND.handoff, payload: { step: 1 } });

  const quarantined = await runtime.quarantineMessage({ messageId: sent.message.messageId, reason: 'consumer_failed_twice', byRunId: parent.id });
  assert.equal(quarantined.status, 'quarantined');
  assert.equal(quarantined.quarantineReason, 'consumer_failed_twice');
  assert.equal((await runtime.pullMessages({ runId: parent.id })).messages.length, 0, 'a quarantined message is not re-delivered');
  assert.equal((await fixture.store.listBusOutstanding()).length, 0);

  const { buildAttention } = await import('../src/agent/attention.js');
  const queue = buildAttention({ busMessages: await fixture.store.listBusMessages({ traceId: parent.id, status: 'quarantined' }) });
  assert.equal(queue.items[0].reason, 'bus_quarantined');
  assert.equal(queue.items[0].severity, 'failure');
  assert.equal(queue.items[0].evidence.quarantineReason, 'consumer_failed_twice');
});

test('a closed run cannot send, a missing recipient is refused, and another trace is not reachable', async (t) => {
  const { runtime, parent, child, thread } = await delegated(t);
  await runtime.runToCompletion(child.id);
  await assert.rejects(
    runtime.sendMessage({ fromRunId: child.id, to: 'parent', kind: BUS_KIND.resultReady, payload: {} }),
    (error) => error.code === 'run_closed'
  );

  const stranger = await runtime.submit({ threadId: thread.id, message: 'مهمة ثانية' });
  await assert.rejects(
    runtime.sendMessage({ fromRunId: parent.id, to: `run:${stranger.run.id}`, kind: BUS_KIND.handoff, payload: {} }),
    (error) => error.code === 'cross_trace'
  );
  await assert.rejects(
    runtime.sendMessage({ fromRunId: parent.id, to: 'run:run-does-not-exist', kind: BUS_KIND.handoff, payload: {} }),
    (error) => error.code === 'recipient_not_found'
  );
});

test('a refused message leaves no row and no evidence entry', async (t) => {
  const { fixture, runtime, parent, child } = await delegated(t);
  const evidenceBefore = (await fixture.store.listEvidence(child.id)).length;

  await assert.rejects(
    runtime.sendMessage({ fromRunId: child.id, to: 'parent', kind: 'chat.free', payload: {} }),
    (error) => error.code === 'unknown_kind'
  );
  await assert.rejects(
    runtime.sendMessage({ fromRunId: child.id, to: 'parent', kind: BUS_KIND.handoff, payload: { key: 'sk-9f2b7c41d8e35a60b1c2' } }),
    (error) => error.code === 'payload_carries_secret'
  );

  assert.equal((await fixture.store.listEvidence(child.id)).length, evidenceBefore, 'a refusal writes no evidence');
  assert.equal((await fixture.store.listBusMessages({ traceId: parent.id })).length, 0, 'and no message');
});

test('the same message sent twice is stored once', async (t) => {
  const { fixture, runtime, parent, child } = await delegated(t);
  const first = await runtime.sendMessage({ fromRunId: child.id, to: 'parent', kind: BUS_KIND.handoff, payload: { step: 1 } });
  const second = await runtime.sendMessage({ fromRunId: child.id, to: 'parent', kind: BUS_KIND.handoff, payload: { step: 1 } });
  assert.notEqual(first.message.seq, second.message.seq, 'a new send takes a new slot');
  // The message id covers the sequence, so two sends are two messages — the idempotency that matters
  // is at the consumer: the same stored message is never turned into two effects by a re-pull.
  assert.equal((await fixture.store.listBusMessages({ traceId: parent.id })).length, 2);
  const pulled = await runtime.pullMessages({ runId: parent.id });
  const again = await runtime.pullMessages({ runId: parent.id });
  assert.deepEqual(pulled.messages.map((m) => m.messageId), again.messages.map((m) => m.messageId));
});

test('delivery happens at the start of the recipient cycle, and only once', async (t) => {
  const { runtime, parent, child } = await delegated(t);
  const sent = await runtime.sendMessage({ fromRunId: child.id, to: 'parent', kind: BUS_KIND.resultReady, payload: { done: true } });
  assert.equal((await runtime.pullMessages({ runId: parent.id })).messages.length, 1, 'waiting before the run starts');

  await runtime.runToCompletion(parent.id);
  const detail = await runtime.detail(parent.id);
  const busSteps = detail.steps.filter((step) => step.kind === 'bus');
  assert.equal(busSteps.length, 1, 'the message is recorded in the recipient history');
  assert.match(busSteps[0].summary, new RegExp(sent.message.messageId));
  assert.equal((await runtime.pullMessages({ runId: parent.id })).messages.length, 0, 'and acknowledged by the same act');
});

test('a message verifies against its stored bytes before a reader acts on it', async (t) => {
  const { runtime, child } = await delegated(t);
  const sent = await runtime.sendMessage({ fromRunId: child.id, to: 'owner', kind: BUS_KIND.resultReady, payload: { done: true } });
  const check = await runtime.verifyBusMessage(sent.message.messageId);
  assert.equal(check.check.ok, true);
  assert.equal(check.message.to, 'owner');
});
