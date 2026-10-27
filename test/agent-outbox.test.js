import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempStore } from './support/agent-fixtures.js';
import { createOutbox, outboxKey, OUTBOX_STATUS, classifyConnectorError, definitiveError } from '../src/agent/outbox.js';
import { createConnectorRegistry } from '../src/agent/connectors.js';

const RUN_ID = 'run-0000-0000-0000-000000000001';

async function setup(t, { send, clock } = {}) {
  const fixture = await createTempStore({ clock });
  t.after(() => fixture.cleanup());
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'outbox' });
  const created = await fixture.store.createRun({
    threadId: thread.id,
    ownerId: 'owner',
    planner: 'unit',
    maxSteps: 8,
    maxCostMicros: 1000
  });
  const runId = created.run.id;
  const sends = [];
  const connectors = createConnectorRegistry([
    {
      name: 'google.calendar',
      description: 'test connector',
      async send(payload, options) {
        sends.push({ payload, ...options });
        if (typeof send === 'function') return send(payload, options, sends.length);
        return { externalRef: `ref-${sends.length}` };
      }
    }
  ]);
  const outbox = createOutbox({
    store: fixture.store,
    connectors,
    clock: clock || Date.now,
    workerId: 'test-dispatch'
  });
  const enqueue = (overrides = {}) =>
    outbox.enqueue({
      runId,
      toolName: 'calendar.create',
      connector: 'google.calendar',
      payload: { summary: 'اجتماع', start: '2026-11-01T10:00:00.000Z', end: '2026-11-01T10:30:00.000Z' },
      ...overrides
    });
  return { fixture, store: fixture.store, runId, outbox, sends, connectors, enqueue };
}

test('outbox: the idempotency key is deterministic per run, tool and payload', () => {
  const payload = { summary: 'a', start: 'x' };
  const first = outboxKey({ runId: RUN_ID, toolName: 'calendar.create', payload });
  const second = outboxKey({ runId: RUN_ID, toolName: 'calendar.create', payload: { start: 'x', summary: 'a' } });
  assert.equal(first, second, 'key order in the payload must not change the key');
  assert.notEqual(first, outboxKey({ runId: RUN_ID, toolName: 'calendar.create', payload: { summary: 'b' } }));
  assert.notEqual(first, outboxKey({ runId: 'other-run', toolName: 'calendar.create', payload }));
  assert.ok(first.length <= 120, 'the key must fit the database column');
});

test('outbox: enqueue is idempotent and one run never holds two live intents for one tool', async (t) => {
  const { store, runId, enqueue } = await setup(t);
  const first = await enqueue();
  assert.equal(first.created, true);
  assert.equal(first.entry.status, OUTBOX_STATUS.pending);

  const second = await enqueue();
  assert.equal(second.created, false);
  assert.equal(second.entry.id, first.entry.id);

  // Even a different payload reuses the live intent: one effect per tool per run.
  const third = await enqueue({ payload: { summary: 'مختلف تمامًا' } });
  assert.equal(third.created, false);
  assert.equal(third.entry.id, first.entry.id);
  assert.equal((await store.listOutbox(runId)).length, 1);
});

test('outbox: a provably failed intent is retried on the same row, never duplicated', async (t) => {
  const { store, runId, enqueue } = await setup(t);
  const first = await enqueue();
  await store.settleOutbox(first.entry.id, { status: OUTBOX_STATUS.failed, lastError: 'invalid_summary' });

  const retry = await enqueue();
  assert.equal(retry.created, false);
  assert.equal(retry.retried, true);
  assert.equal(retry.entry.id, first.entry.id, 'same intent, same idempotency key');
  assert.equal(retry.entry.status, OUTBOX_STATUS.pending);
  assert.equal(retry.entry.lastError, null);
  assert.equal((await store.listOutbox(runId)).length, 1, 'one row per effect, always');
});

test('outbox: only one dispatcher can claim an intent, and only from pending', async (t) => {
  const { store, enqueue } = await setup(t);
  const { entry } = await enqueue();
  assert.equal(await store.claimOutbox(entry.id, { leaseMs: 30_000, workerId: 'a' }), true);
  assert.equal(await store.claimOutbox(entry.id, { leaseMs: 30_000, workerId: 'b' }), false);
  const claimed = await store.getOutbox(entry.id);
  assert.equal(claimed.status, OUTBOX_STATUS.dispatching);
  assert.equal(claimed.attempts, 1);
});

test('outbox: a successful dispatch settles sent with an external reference', async (t) => {
  const { store, outbox, sends, enqueue } = await setup(t);
  const { entry } = await enqueue();
  const result = await outbox.dispatch(entry.id);
  assert.equal(result.status, OUTBOX_STATUS.sent);
  assert.equal(result.dispatched, true);
  assert.equal(sends.length, 1);
  const settled = await store.getOutbox(entry.id);
  assert.equal(settled.status, OUTBOX_STATUS.sent);
  assert.equal(settled.attempts, 1);
  assert.ok(settled.externalRef);
  assert.ok(settled.settledAt);

  // A second dispatch is a no-op: the intent is terminal.
  const again = await outbox.dispatch(entry.id);
  assert.equal(again.dispatched, false);
  assert.equal(sends.length, 1, 'a settled intent is never sent twice');
});

test('outbox: a definitive provider rejection settles failed and is never retried', async (t) => {
  const { store, outbox, sends, enqueue } = await setup(t, {
    send: async () => {
      throw definitiveError('invalid_summary');
    }
  });
  const { entry } = await enqueue();
  const result = await outbox.dispatch(entry.id);
  assert.equal(result.status, OUTBOX_STATUS.failed);
  assert.equal(result.error, 'invalid_summary');
  const settled = await store.getOutbox(entry.id);
  assert.equal(settled.status, OUTBOX_STATUS.failed);
  assert.equal(settled.lastError, 'invalid_summary');

  await outbox.dispatch(entry.id);
  assert.equal(sends.length, 1, 'a definitive failure is terminal too');
});

test('outbox: an ambiguous transport error settles unknown and is never re-sent', async (t) => {
  const { store, outbox, sends, enqueue } = await setup(t, {
    send: async () => {
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    }
  });
  const { entry } = await enqueue();
  const first = await outbox.dispatch(entry.id);
  assert.equal(first.status, OUTBOX_STATUS.unknown, 'a dropped connection cannot prove the request failed');
  const settled = await store.getOutbox(entry.id);
  assert.equal(settled.status, OUTBOX_STATUS.unknown);
  assert.equal(settled.lastError, 'econnreset');

  const second = await outbox.dispatch(entry.id);
  assert.equal(second.dispatched, false);
  assert.equal(sends.length, 1, 'AGENTS.md: never replay an external mutation blindly');
});

test('outbox: a dispatcher that died mid-flight is settled unknown by recovery, never re-sent', async (t) => {
  let now = Date.parse('2026-11-01T09:00:00.000Z');
  const { store, outbox, sends, enqueue } = await setup(t, { clock: () => now });
  const { entry } = await enqueue();
  // Simulate a worker that claimed the row and vanished before calling the provider.
  assert.equal(await store.claimOutbox(entry.id, { leaseMs: 1000, workerId: 'dead-worker' }), true);
  assert.equal(sends.length, 0);

  now += 5000;
  const recovered = await outbox.recoverStale({ limit: 10 });
  assert.equal(recovered.recovered.length, 1);
  assert.equal(recovered.recovered[0].status, OUTBOX_STATUS.unknown);
  assert.equal(sends.length, 0, 'recovery never invokes the connector');

  const afterRecovery = await outbox.dispatch(entry.id);
  assert.equal(afterRecovery.dispatched, false);
  assert.equal(sends.length, 0);
});

test('outbox: fetching a row held by a live dispatcher reports in_progress without sending', async (t) => {
  const { store, outbox, sends, enqueue } = await setup(t);
  const { entry } = await enqueue();
  assert.equal(await store.claimOutbox(entry.id, { leaseMs: 60_000, workerId: 'other' }), true);
  const result = await outbox.dispatch(entry.id);
  assert.equal(result.dispatched, false);
  assert.equal(result.status, 'in_progress');
  assert.equal(sends.length, 0);
});

test('outbox: no connector means a definitive non-effect, not a fake success', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'بلا موصل' });
  const created = await fixture.store.createRun({
    threadId: thread.id,
    ownerId: 'owner',
    planner: 'unit',
    maxSteps: 4,
    maxCostMicros: 100
  });
  const outbox = createOutbox({ store: fixture.store, connectors: createConnectorRegistry([]) });
  const { entry } = await outbox.enqueue({
    runId: created.run.id,
    toolName: 'calendar.create',
    connector: 'google.calendar',
    payload: { summary: 'اجتماع' }
  });
  const result = await outbox.dispatch(entry.id);
  assert.equal(result.status, OUTBOX_STATUS.failed);
  assert.equal(result.error, 'connector_unavailable');
  const settled = await fixture.store.getOutbox(entry.id);
  assert.equal(settled.lastError, 'connector_unavailable');
  assert.equal(settled.externalRef, null, 'no reference is invented when nothing was sent');
});

test('outbox: cancelling pending intents is how a rejection leaves no trace', async (t) => {
  const { store, runId, enqueue } = await setup(t);
  const { entry } = await enqueue();
  const cancelled = await store.cancelPendingOutbox(runId);
  assert.equal(cancelled, 1);
  const settled = await store.getOutbox(entry.id);
  assert.equal(settled.status, OUTBOX_STATUS.cancelled);
  assert.equal(settled.lastError, 'approval_rejected');

  // A dispatching intent is never cancelled under the dispatcher's feet.
  const second = await enqueue();
  assert.equal(second.retried, true, 'a cancelled intent may be attempted again');
  await store.claimOutbox(second.entry.id, { leaseMs: 30_000, workerId: 'w' });
  assert.equal(await store.cancelPendingOutbox(runId), 0);
  assert.equal((await store.getOutbox(second.entry.id)).status, OUTBOX_STATUS.dispatching);
});

test('outbox: intents survive a store reopen (durable, not process memory)', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'استمرارية' });
  const created = await fixture.store.createRun({
    threadId: thread.id,
    ownerId: 'owner',
    planner: 'unit',
    maxSteps: 4,
    maxCostMicros: 100
  });
  const outbox = createOutbox({ store: fixture.store, connectors: createConnectorRegistry([]) });
  const { entry } = await outbox.enqueue({
    runId: created.run.id,
    toolName: 'calendar.create',
    connector: 'google.calendar',
    payload: { summary: 'صدفة' }
  });

  const reopened = await fixture.reopen();
  const rows = await reopened.store.listOutbox(created.run.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, entry.id);
  assert.equal(rows[0].status, OUTBOX_STATUS.pending);
  await reopened.driver.close();
});

test('outbox: connector error classification separates provable non-effects from unknowns', () => {
  assert.equal(classifyConnectorError(definitiveError('invalid_summary')), OUTBOX_STATUS.failed);
  assert.equal(classifyConnectorError({ status: 400 }), OUTBOX_STATUS.failed);
  assert.equal(classifyConnectorError({ status: 403 }), OUTBOX_STATUS.failed);
  assert.equal(classifyConnectorError({ response: { status: 404 } }), OUTBOX_STATUS.failed);
  assert.equal(classifyConnectorError({ status: 408 }), OUTBOX_STATUS.unknown, 'a timeout may have been processed');
  assert.equal(classifyConnectorError({ status: 429 }), OUTBOX_STATUS.unknown, 'a rate limit response proves nothing');
  assert.equal(classifyConnectorError({ status: 500 }), OUTBOX_STATUS.unknown);
  assert.equal(classifyConnectorError({ code: 'ECONNRESET' }), OUTBOX_STATUS.unknown);
  assert.equal(classifyConnectorError(new Error('boom')), OUTBOX_STATUS.unknown);
});
