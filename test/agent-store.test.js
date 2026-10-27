import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempStore } from './support/agent-fixtures.js';
import { RUN_STATUS, TOOL_RUN_STATUS } from '../src/agent/store.js';
import { createSqliteDriver } from '../src/agent/drivers.js';

test('agent store: duplicate client_message_id and client run id never create a second row', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const { store } = fixture;
  const thread = await store.createThread({ ownerId: 'owner', title: 'مهمة' });

  const first = await store.appendMessage({ threadId: thread.id, role: 'user', content: 'مرحبا', clientMessageId: 'client-abc-123' });
  assert.equal(first.created, true);
  const again = await store.appendMessage({ threadId: thread.id, role: 'user', content: 'مرحبا', clientMessageId: 'client-abc-123' });
  assert.equal(again.created, false);
  assert.equal(again.message.id, first.message.id);

  const run = await store.createRun({
    threadId: thread.id,
    ownerId: 'owner',
    userMessageId: first.message.id,
    clientMessageId: 'client-abc-123',
    planner: 'scripted',
    maxSteps: 8,
    maxCostMicros: 1000
  });
  assert.equal(run.created, true);
  const duplicate = await store.createRun({
    threadId: thread.id,
    ownerId: 'owner',
    userMessageId: first.message.id,
    clientMessageId: 'client-abc-123',
    planner: 'scripted',
    maxSteps: 8,
    maxCostMicros: 1000
  });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.run.id, run.run.id);
  assert.equal((await store.listRuns(thread.id)).length, 1);
  assert.equal((await store.listMessages(thread.id)).length, 1);
});

test('agent store: a run can be claimed by exactly one worker until the lease expires', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const { store } = fixture;
  const thread = await store.createThread({ ownerId: 'owner', title: 'lease' });
  const run = await store.createRun({
    threadId: thread.id,
    ownerId: 'owner',
    clientMessageId: 'lease-key-0001',
    planner: 'scripted',
    maxSteps: 4,
    maxCostMicros: 1000
  });

  assert.equal(await store.claimRun(run.run.id, { leaseMs: 60_000, workerId: 'w1' }), true);
  assert.equal(await store.claimRun(run.run.id, { leaseMs: 60_000, workerId: 'w2' }), false);
  // An expired lease is reclaimable: this is the crash-recovery path, not a second executor.
  await store.heartbeat(run.run.id, { leaseMs: -60_000 });
  assert.equal(await store.claimRun(run.run.id, { leaseMs: 60_000, workerId: 'w2' }), true);
  const claimed = await store.getRun(run.run.id);
  assert.equal(claimed.status, RUN_STATUS.running);
});

test('agent store: steps get strictly increasing indices under concurrency', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const { store } = fixture;
  const thread = await store.createThread({ ownerId: 'owner', title: 'steps' });
  const run = await store.createRun({
    threadId: thread.id,
    ownerId: 'owner',
    planner: 'scripted',
    maxSteps: 20,
    maxCostMicros: 1000
  });
  await Promise.all(Array.from({ length: 8 }, (_, index) => store.appendStep({ runId: run.run.id, kind: 'act', title: `step ${index}` })));
  const steps = await store.listSteps(run.run.id);
  assert.equal(steps.length, 8);
  assert.deepEqual(
    steps.map((step) => step.index),
    [1, 2, 3, 4, 5, 6, 7, 8]
  );
  assert.equal((await store.getRun(run.run.id)).usage.steps, 8);
});

test('agent store: tool runs are unique per idempotency key and survive a restart', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const { store } = fixture;
  const thread = await store.createThread({ ownerId: 'owner', title: 'tools' });
  const run = await store.createRun({
    threadId: thread.id,
    ownerId: 'owner',
    planner: 'scripted',
    maxSteps: 4,
    maxCostMicros: 1000
  });
  const first = await store.startToolRun({
    runId: run.run.id,
    toolName: 'read.alpha',
    risk: 'read',
    idempotencyKey: `${run.run.id}:1:read.alpha`
  });
  assert.equal(first.created, true);
  const second = await store.startToolRun({
    runId: run.run.id,
    toolName: 'read.alpha',
    risk: 'read',
    idempotencyKey: `${run.run.id}:1:read.alpha`
  });
  assert.equal(second.created, false);
  assert.equal(second.toolRun.status, TOOL_RUN_STATUS.started);
  await store.finishToolRun(first.toolRun.id, TOOL_RUN_STATUS.succeeded, JSON.stringify({ ok: true }));

  const reopened = await fixture.reopen();
  t.after(() => reopened.driver.close());
  const restored = await reopened.store.listToolRuns(run.run.id);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].status, TOOL_RUN_STATUS.succeeded);
  assert.equal(restored[0].outcome, '{"ok":true}');
  const messages = await reopened.store.listMessages(thread.id);
  assert.deepEqual(messages, []);
});

test('agent store: resumable lookup returns only queued runs or expired leases', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const { store } = fixture;
  const thread = await store.createThread({ ownerId: 'owner', title: 'resume' });
  const queued = await store.createRun({ threadId: thread.id, ownerId: 'owner', planner: 'scripted', maxSteps: 4, maxCostMicros: 1000 });
  const running = await store.createRun({
    threadId: thread.id,
    ownerId: 'owner',
    clientMessageId: 'run-b-000001',
    planner: 'scripted',
    maxSteps: 4,
    maxCostMicros: 1000
  });
  await store.claimRun(running.run.id, { leaseMs: 60_000 });
  const done = await store.createRun({
    threadId: thread.id,
    ownerId: 'owner',
    clientMessageId: 'run-c-000001',
    planner: 'scripted',
    maxSteps: 4,
    maxCostMicros: 1000
  });
  await store.finishRun(done.run.id, RUN_STATUS.succeeded);

  const resumable = await store.findResumableRuns();
  assert.deepEqual(resumable.map((run) => run.id), [queued.run.id]);
  await store.heartbeat(running.run.id, { leaseMs: -1000 });
  const afterExpiry = await store.findResumableRuns();
  assert.deepEqual(afterExpiry.map((run) => run.id).sort(), [queued.run.id, running.run.id].sort());
});

test('agent store: production refuses an in-memory pool, SQLite refuses production, and the MySQL driver requires the ledger', async () => {
  await assert.rejects(() => createSqliteDriver({ path: '/tmp/x.sqlite3', nodeEnv: 'production' }), /local\/demo/);
  await assert.rejects(() => createSqliteDriver({ path: '   ' }), /CELIA_AGENT_SQLITE_PATH/);
  const { createMysqlDriver } = await import('../src/agent/drivers.js');
  assert.throws(() => createMysqlDriver({ isMemory: true, execute: async () => [[]] }), /durable MySQL/);
});
