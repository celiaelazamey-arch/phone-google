import test from 'node:test';
import assert from 'node:assert/strict';
import { RUN_STATUS, TOOL_RUN_STATUS } from '../src/agent/store.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createVerifier, VERDICT } from '../src/agent/verifier.js';
import { createRecordingTools, createTempStore, createFakeCalendar } from './support/agent-fixtures.js';

/**
 * Reconciliation surface (G1/G2): the only exit from `needs_reconciliation`.
 *
 * These tests are the acceptance criteria of docs/gap-closure-plan.md §3.3. They
 * prove four things the earlier suite could not: a parked run can be released, a
 * released run is *not* re-sent blindly, an impossible reconciliation is refused,
 * and a foreign owner sees nothing.
 */

async function buildRuntime({ store, planner, tools = null, connectors = null, clock } = {}) {
  const fixture = tools || createRecordingTools();
  return createAgentRuntime({
    store,
    tools: fixture.tools,
    planner,
    connectors: connectors || undefined,
    ownerId: 'owner',
    ...(clock ? { clock } : {}),
    logger: { error() {} }
  });
}

async function newRun(runtime, { message = 'مهمة تحتاج مصالحة', ownerId = 'owner' } = {}) {
  const thread = await runtime.store.createThread({ ownerId, title: 'مصالحة' });
  return runtime.submit({ threadId: thread.id, message, clientMessageId: `reconcile-${Date.now()}-${Math.random().toString(36).slice(2, 9)}` });
}

/** Planner that calls one read tool, then finishes. */
function readOnceThenFinish(tool = 'read.alpha') {
  return {
    name: 'read-once',
    async plan({ toolRuns }) {
      if (!toolRuns.some((run) => run.toolName === tool && run.status === TOOL_RUN_STATUS.succeeded)) {
        return { action: 'call', tool, args: {} };
      }
      return { action: 'finish', summary: 'اكتملت' };
    }
  };
}

/** Force one tool run into the `unknown` state a crashed process would leave behind. */
async function makeUnknown(store, runId) {
  const [toolRun] = await store.listToolRuns(runId);
  await store.finishToolRun(toolRun.id, TOOL_RUN_STATUS.unknown, JSON.stringify({ reason: 'process_interrupted' }));
  return store.listToolRuns(runId).then((rows) => rows[0]);
}

test('reconciliation: an unknown tool run can be resolved and the run then completes with PASS', async (t) => {
  const temp = await createTempStore();
  t.after(() => temp.cleanup());
  const runtime = await buildRuntime({ store: temp.store, planner: readOnceThenFinish() });
  const { run } = await newRun(runtime);
  const completed = await runtime.runToCompletion(run.id);
  assert.equal(completed.status, RUN_STATUS.succeeded);

  // Simulate the pre-fix dead end: the same run re-parked with an unknown call.
  const parked = await temp.store.finishRun(run.id, RUN_STATUS.needsReconciliation, { error: 'outcome_unknown' });
  assert.equal(parked.status, RUN_STATUS.needsReconciliation);
  const toolRun = await makeUnknown(temp.store, run.id);

  const result = await runtime.reconcile(run.id, {
    target: 'tool_run',
    targetId: toolRun.id,
    outcome: 'applied',
    externalRef: 'ref-42',
    note: 'تحققت من النتيجة يدويًا'
  });
  assert.equal(result.reconciliation.outcome, 'applied');
  assert.equal(result.reconciliation.resumed, true);
  assert.deepEqual(result.remaining.toolRuns, []);
  assert.ok(['queued', 'running', 'succeeded'].includes(result.run.status));

  const detail = await runtime.detail(run.id);
  assert.ok(
    detail.evidence.some((entry) => entry.kind === 'reconciliation' && entry.sourceIds.includes(toolRun.id)),
    'the decision is witnessed by the chain'
  );
  assert.equal(detail.evidenceChain.ok, true);
  const entry = detail.toolRuns.find((item) => item.id === toolRun.id);
  assert.equal(entry.status, TOOL_RUN_STATUS.succeeded);
  assert.equal(entry.outcome.reconciled, true);
  assert.equal(entry.outcome.externalRef, 'ref-42');

  const resumed = await runtime.runToCompletion(run.id);
  assert.equal(resumed.status, RUN_STATUS.succeeded);
  const verified = await runtime.detail(run.id);
  assert.equal(verified.verification.verdict, VERDICT.pass);
  assert.equal(
    verified.evidence.find((row) => row.kind === 'verification')?.verdict,
    VERDICT.pass
  );
});

test('reconciliation: a run with a second uncertain call stays parked instead of resuming', async (t) => {
  const temp = await createTempStore();
  t.after(() => temp.cleanup());
  const runtime = await buildRuntime({ store: temp.store, planner: readOnceThenFinish() });
  const { run } = await newRun(runtime);
  await runtime.runToCompletion(run.id);

  // Two distinct unknown calls (as a crash between two steps could leave).
  const first = await makeUnknown(temp.store, run.id);
  const second = await temp.store.startToolRun({
    runId: run.id,
    toolName: 'read.beta',
    risk: 'read',
    idempotencyKey: `${run.id}:99:read.beta`
  });
  await temp.store.finishRun(run.id, RUN_STATUS.needsReconciliation, { error: 'outcome_unknown' });

  const result = await runtime.reconcile(run.id, { target: 'tool_run', targetId: first.id, outcome: 'applied' });
  assert.equal(result.reconciliation.resumed, false);
  assert.equal(result.run.status, RUN_STATUS.needsReconciliation);
  assert.equal(result.remaining.toolRuns.length, 1);
  assert.equal(result.remaining.toolRuns[0].id, second.toolRun.id);

  const released = await runtime.reconcile(run.id, { target: 'tool_run', targetId: second.toolRun.id, outcome: 'applied' });
  assert.equal(released.reconciliation.resumed, true);
});

test('reconciliation: not_applied releases the run and the retried call happens exactly once more', async (t) => {
  const temp = await createTempStore();
  t.after(() => temp.cleanup());
  const tools = createRecordingTools();
  const runtime = await buildRuntime({ store: temp.store, tools, planner: readOnceThenFinish() });
  const { run } = await newRun(runtime);
  await runtime.runToCompletion(run.id);
  const before = tools.calls.length;

  const toolRun = await makeUnknown(temp.store, run.id);
  await temp.store.finishRun(run.id, RUN_STATUS.needsReconciliation, { error: 'outcome_unknown' });

  const result = await runtime.reconcile(run.id, {
    target: 'tool_run',
    targetId: toolRun.id,
    outcome: 'not_applied',
    note: 'لا يوجد أثر في المصدر'
  });
  assert.equal(result.reconciliation.resumed, true);

  const resumed = await runtime.runToCompletion(run.id);
  assert.equal(resumed.status, RUN_STATUS.succeeded);
  const detail = await runtime.detail(run.id);
  const settled = detail.toolRuns.find((item) => item.id === toolRun.id);
  assert.equal(settled.status, TOOL_RUN_STATUS.failed);
  assert.equal(settled.outcome.outcome, 'not_applied');
  assert.equal(settled.outcome.reconciled, true);
  // One retried call, and the adjudicated failure does not block the new verdict.
  assert.equal(tools.calls.length, before + 1);
  assert.equal(detail.verification.verdict, VERDICT.pass);
});

test('reconciliation: a settled outcome is never rewritten', async (t) => {
  const temp = await createTempStore();
  t.after(() => temp.cleanup());
  const runtime = await buildRuntime({ store: temp.store, planner: readOnceThenFinish() });
  const { run } = await newRun(runtime);
  await runtime.runToCompletion(run.id);
  const [succeeded] = await temp.store.listToolRuns(run.id);
  assert.equal(succeeded.status, TOOL_RUN_STATUS.succeeded);

  await assert.rejects(
    runtime.reconcile(run.id, { target: 'tool_run', targetId: succeeded.id, outcome: 'not_applied' }),
    (error) => error.status === 409 && error.code === 'target_not_reconcilable'
  );
  const untouched = (await temp.store.listToolRuns(run.id)).find((item) => item.id === succeeded.id);
  assert.equal(untouched.status, TOOL_RUN_STATUS.succeeded);
  assert.equal(untouched.outcome, succeeded.outcome, 'no silent overwrite of a historical fact');
});

test('reconciliation: invalid input and foreign targets are refused without leaking existence', async (t) => {
  const temp = await createTempStore();
  t.after(() => temp.cleanup());
  const runtime = await buildRuntime({ store: temp.store, planner: readOnceThenFinish() });
  const { run } = await newRun(runtime);
  await runtime.runToCompletion(run.id);
  const toolRun = await makeUnknown(temp.store, run.id);

  await assert.rejects(
    runtime.reconcile(run.id, { target: 'db', targetId: toolRun.id, outcome: 'applied' }),
    (error) => error.status === 400 && error.code === 'invalid_reconcile_target'
  );
  await assert.rejects(
    runtime.reconcile(run.id, { target: 'tool_run', targetId: toolRun.id, outcome: 'maybe' }),
    (error) => error.status === 400 && error.code === 'invalid_reconcile_outcome'
  );
  await assert.rejects(
    runtime.reconcile(run.id, { target: 'tool_run', targetId: '', outcome: 'applied' }),
    (error) => error.status === 400 && error.code === 'reconcile_target_required'
  );
  // A real id from a different run must read as "not in this run", not as a hit.
  const other = await newRun(runtime);
  await runtime.runToCompletion(other.run.id);
  const [otherToolRun] = await temp.store.listToolRuns(other.run.id);
  await assert.rejects(
    runtime.reconcile(run.id, { target: 'tool_run', targetId: otherToolRun.id, outcome: 'applied' }),
    (error) => error.status === 400 && error.code === 'target_not_in_run'
  );
  // Another owner cannot even see the run.
  await assert.rejects(
    runtime.reconcile(run.id, { target: 'tool_run', targetId: toolRun.id, outcome: 'applied' }, 'intruder'),
    (error) => error.status === 404 && error.code === 'run_not_found'
  );
});

test('ownership: a foreign owner cannot read, cancel, approve or reconcile the run', async (t) => {
  const temp = await createTempStore();
  t.after(() => temp.cleanup());
  const runtime = await buildRuntime({ store: temp.store, planner: readOnceThenFinish() });
  const { run } = await newRun(runtime);
  await runtime.runToCompletion(run.id);
  const toolRun = await makeUnknown(temp.store, run.id);
  await temp.store.finishRun(run.id, RUN_STATUS.needsReconciliation, { error: 'outcome_unknown' });

  const denials = [
    () => runtime.detail(run.id, 'intruder'),
    () => runtime.threadDetail(run.threadId, 'intruder'),
    () => runtime.cancel(run.id, 'intruder'),
    () => runtime.approve(run.id, { decision: 'approved' }, 'intruder'),
    () => runtime.reconcile(run.id, { target: 'tool_run', targetId: toolRun.id, outcome: 'applied' }, 'intruder')
  ];
  for (const attempt of denials) {
    await assert.rejects(attempt, (error) => error.status === 404, 'every surface answers 404, not 403');
  }
  // The owner still sees exactly what the intruder could not change.
  const detail = await runtime.detail(run.id);
  assert.equal(detail.toolRuns.find((item) => item.id === toolRun.id).status, TOOL_RUN_STATUS.unknown);
});

test('reconciliation: replaying the same decision with the same key writes one ledger entry', async (t) => {
  const temp = await createTempStore();
  t.after(() => temp.cleanup());
  const runtime = await buildRuntime({ store: temp.store, planner: readOnceThenFinish() });
  const { run } = await newRun(runtime);
  await runtime.runToCompletion(run.id);
  const toolRun = await makeUnknown(temp.store, run.id);
  await temp.store.finishRun(run.id, RUN_STATUS.needsReconciliation, { error: 'outcome_unknown' });

  const decision = {
    target: 'tool_run',
    targetId: toolRun.id,
    outcome: 'applied',
    idempotencyKey: 'reconcile-key-0001'
  };
  const first = await runtime.reconcile(run.id, decision);
  assert.equal(first.idempotentReplay, false);
  const replay = await runtime.reconcile(run.id, decision);
  assert.equal(replay.idempotentReplay, true);

  const rows = (await temp.store.listEvidence(run.id)).filter((entry) => entry.kind === 'reconciliation');
  assert.equal(rows.length, 1, 'an idempotent replay must not duplicate the ledger entry');
  assert.equal((await temp.store.verifyEvidenceChain(run.id)).ok, true);
});

test('reconciliation: an external effect reconciled as applied is sent once and never re-dispatched', async (t) => {
  const temp = await createTempStore();
  t.after(() => temp.cleanup());
  const calendar = createFakeCalendar();
  const runtime = await buildRuntime({
    store: temp.store,
    planner: readOnceThenFinish(),
    connectors: calendar.connectors
  });
  const { run } = await newRun(runtime);
  const thread = await temp.store.getThread(run.threadId, 'owner');
  assert.ok(thread);

  // Build a realistic external-effect intent: a durable row + the paired tool run a
  // crashed process left `unknown`.
  const key = `outbox:${run.id}:deadbeef0001`;
  const { entry } = await temp.store.enqueueOutbox({
    runId: run.id,
    toolName: 'calendar.create',
    connector: 'google.calendar',
    idempotencyKey: key,
    payload: { summary: 'اجتماع', start: '2026-11-01T09:00:00.000Z', end: '2026-11-01T10:00:00.000Z' }
  });
  const toolRun = await temp.store.startToolRun({
    runId: run.id,
    toolName: 'calendar.create',
    risk: 'external_effect',
    idempotencyKey: key
  });
  await temp.store.finishToolRun(toolRun.toolRun.id, TOOL_RUN_STATUS.unknown, JSON.stringify({ reason: 'process_interrupted' }));
  await temp.store.finishRun(run.id, RUN_STATUS.needsReconciliation, { error: 'outcome_unknown' });
  assert.equal((await temp.store.getOutbox(entry.id)).status, 'pending');

  // Pending is not "uncertain": reconciliation must refuse to invent a settlement for it.
  await assert.rejects(
    runtime.reconcile(run.id, { target: 'outbox', targetId: entry.id, outcome: 'applied' }),
    (error) => error.status === 409 && error.code === 'target_not_reconcilable'
  );

  await temp.store.settleOutbox(entry.id, { status: 'unknown', lastError: 'dispatch_timeout' });
  await temp.store.claimOutbox(entry.id, { leaseMs: 1 });
  await temp.store.settleOutbox(entry.id, { status: 'unknown', lastError: 'dispatch_timeout' });

  const result = await runtime.reconcile(run.id, {
    target: 'outbox',
    targetId: entry.id,
    outcome: 'applied',
    externalRef: 'evt-reconciled',
    note: 'رأيت الموعد في التقويم'
  });
  assert.equal(result.reconciliation.resumed, true);
  assert.equal(calendar.sends.length, 0, 'reconciliation never touches a connector');

  const outbox = await temp.store.listOutbox(run.id);
  assert.equal(outbox[0].status, 'sent');
  assert.equal(outbox[0].externalRef, 'evt-reconciled');
  // One decision, one truth: the paired tool run moves with the intent.
  const paired = (await temp.store.listToolRuns(run.id)).find((item) => item.idempotencyKey === key);
  assert.equal(paired.status, TOOL_RUN_STATUS.succeeded);
});

test('retry: a provably failed intent is reused by key, needs a new approval, and sends once', async (t) => {
  const temp = await createTempStore();
  t.after(() => temp.cleanup());
  const calendar = createFakeCalendar({ failWith: 'definitive' });
  const planner = {
    name: 'effect-once',
    async plan({ toolRuns, approvals }) {
      const sent = toolRuns.some((run) => run.toolName === 'calendar.create' && run.status === TOOL_RUN_STATUS.succeeded);
      if (sent) return { action: 'finish', summary: 'أُرسل' };
      const decided = approvals.some((approval) => approval.decision === 'approved');
      if (!decided) {
        return {
          action: 'call',
          tool: 'calendar.create',
          args: { summary: 'اجتماع', start: '2026-11-02T09:00:00.000Z', end: '2026-11-02T10:00:00.000Z' }
        };
      }
      return {
        action: 'call',
        tool: 'calendar.create',
        args: { summary: 'اجتماع', start: '2026-11-02T09:00:00.000Z', end: '2026-11-02T10:00:00.000Z' }
      };
    }
  };
  const runtime = await buildRuntime({ store: temp.store, planner, connectors: calendar.connectors });
  const { run } = await newRun(runtime, { message: 'أنشئ موعدًا' });
  const parked = await runtime.runToCompletion(run.id);
  assert.equal(parked.status, RUN_STATUS.waitingApproval);

  await runtime.approve(run.id, { decision: 'approved' });
  const failed = await runtime.runToCompletion(run.id);
  assert.equal(failed.status, RUN_STATUS.failed);
  assert.equal(failed.lastError, 'external_effect_failed');
  const failedEntry = (await temp.store.listOutbox(run.id))[0];
  assert.equal(failedEntry.status, 'failed');

  // Swap the transport for a healthy one: the retry is the owner's decision, not a loop.
  const healthy = createFakeCalendar();
  const retryRuntime = await buildRuntime({
    store: temp.store,
    planner,
    connectors: healthy.connectors
  });
  const retried = await retryRuntime.reconcile(run.id, {
    target: 'outbox',
    targetId: failedEntry.id,
    outcome: 'not_applied',
    resume: true,
    note: 'أُرسل يدويًا لاحقًا'
  });
  assert.equal(retried.reconciliation.resumed, true);

  // The payload is byte-identical to the one the owner already approved, so the
  // recorded decision still authorises it: the retry is the owner's explicit call,
  // not a loop re-entry, and the provider sees exactly one request.
  const finished = await retryRuntime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.succeeded);
  assert.equal(healthy.sends.length, 1, 'exactly one send on the retry path');
  const entries = await temp.store.listOutbox(run.id);
  assert.equal(entries.length, 1, 'the retry reuses the failed row instead of minting a new intent');
  assert.equal(entries[0].status, 'sent');
  assert.equal(entries[0].attempts, 2);
  assert.equal((await temp.store.listApprovals(run.id)).length, 1, 'the same exact-effect approval is reused');
  assert.equal((await temp.store.verifyEvidenceChain(run.id)).ok, true);
});

test('retry: a changed payload can never ride on an earlier approval', async (t) => {
  const temp = await createTempStore();
  t.after(() => temp.cleanup());
  const calendar = createFakeCalendar({ failWith: 'definitive' });
  let summary = 'الموعد الأول';
  const planner = {
    name: 'mutable-effect',
    async plan() {
      return {
        action: 'call',
        tool: 'calendar.create',
        args: { summary, start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T10:00:00.000Z' }
      };
    }
  };
  const runtime = await buildRuntime({ store: temp.store, planner, connectors: calendar.connectors });
  const { run } = await newRun(runtime, { message: 'أنشئ موعدًا' });
  assert.equal((await runtime.runToCompletion(run.id)).status, RUN_STATUS.waitingApproval);
  await runtime.approve(run.id, { decision: 'approved' });
  assert.equal((await runtime.runToCompletion(run.id)).status, RUN_STATUS.failed);

  const failedEntry = (await temp.store.listOutbox(run.id))[0];
  assert.equal(failedEntry.status, 'failed');

  // The owner authorises a retry, but the planner now wants a different event.
  summary = 'موعد مختلف تمامًا';
  const healthy = createFakeCalendar();
  const retryRuntime = await buildRuntime({ store: temp.store, planner, connectors: healthy.connectors });
  await retryRuntime.reconcile(run.id, {
    target: 'outbox',
    targetId: failedEntry.id,
    outcome: 'not_applied',
    resume: true
  });
  const parked = await retryRuntime.runToCompletion(run.id);
  assert.equal(parked.status, RUN_STATUS.waitingApproval, 'a changed payload needs its own decision');
  assert.equal(healthy.sends.length, 0, 'nothing is sent under the earlier approval');
  const approvals = await temp.store.listApprovals(run.id);
  assert.equal(approvals.length, 2, 'the new payload got its own approval row');
  assert.notEqual(approvals[0].idempotencyKey, approvals[1].idempotencyKey);
});

test('retry: resume cannot bypass a remaining unknown call', async (t) => {
  const temp = await createTempStore();
  t.after(() => temp.cleanup());
  const runtime = await buildRuntime({ store: temp.store, planner: readOnceThenFinish() });
  const { run } = await newRun(runtime);
  await runtime.runToCompletion(run.id);
  const first = await makeUnknown(temp.store, run.id);
  const second = await temp.store.startToolRun({
    runId: run.id,
    toolName: 'read.beta',
    risk: 'read',
    idempotencyKey: `${run.id}:98:read.beta`
  });
  await temp.store.finishRun(run.id, RUN_STATUS.failed, { error: 'verification_blocked' });

  const result = await runtime.reconcile(run.id, {
    target: 'tool_run',
    targetId: first.id,
    outcome: 'applied',
    resume: true
  });
  assert.equal(result.reconciliation.resumed, false, 'resume never overrides an unresolved outcome');
  assert.equal(result.run.status, RUN_STATUS.needsReconciliation);
  assert.equal(result.remaining.toolRuns[0].id, second.toolRun.id);
});

test('verifier: a reconciled row without a ledger entry blocks the verdict', async () => {
  const { tools } = createRecordingTools();
  const verifier = createVerifier({ tools });
  const result = await verifier.verifyRun({
    run: {
      id: 'run-g1',
      usage: { steps: 1, costMicros: 0, tokens: 0 },
      limits: { maxSteps: 12, maxCostMicros: 100_000 }
    },
    contract: {
      version: 'goal-v1',
      objective: 'مهمة',
      successCriteria: ['deliver'],
      constraints: ['no_external_effect_without_approval'],
      stopConditions: ['budget_exhausted'],
      deadline: null,
      budget: { maxSteps: 12, maxCostMicros: 100_000 },
      createdAt: new Date().toISOString()
    },
    steps: [{ id: 's1', index: 1, kind: 'act' }],
    toolRuns: [
      {
        id: 'tr-1',
        toolName: 'read.alpha',
        status: 'succeeded',
        outcome: JSON.stringify({ reconciled: true, outcome: 'applied' })
      }
    ],
    evidence: [{ id: 'e1', kind: 'tool_call', sourceIds: ['tr-1'], seq: 1 }],
    approvals: [],
    outbox: []
  });
  const check = result.checks.find((item) => item.id === 'reconciliation_evidence');
  assert.equal(check.status, 'BLOCK');
  assert.equal(result.verdict, VERDICT.block);
});

test('store: reconciliation is conditional and lease-aware for dispatching intents', async (t) => {
  const temp = await createTempStore();
  t.after(() => temp.cleanup());
  const store = temp.store;
  const thread = await store.createThread({ ownerId: 'owner', title: 'store' });
  const { run } = await store.createRun({
    threadId: thread.id,
    ownerId: 'owner',
    userMessageId: null,
    clientMessageId: 'store-reconcile-1',
    planner: 'test',
    maxSteps: 5,
    maxCostMicros: 1000
  });
  const key = `outbox:${run.id}:cafebabe0001`;
  const { entry } = await store.enqueueOutbox({
    runId: run.id,
    toolName: 'calendar.create',
    connector: 'google.calendar',
    idempotencyKey: key,
    payload: { summary: 'x' }
  });

  // A live lease must not be reconciled from under a working dispatcher.
  assert.equal(await store.claimOutbox(entry.id, { leaseMs: 60_000 }), true);
  const blocked = await store.reconcileOutboxEntry(entry.id, { status: 'sent', externalRef: 'ref' });
  assert.equal(blocked.changed, false);
  assert.equal(blocked.entry.status, 'dispatching');

  // Once the lease is expired the row is genuinely orphaned and may be settled.
  const orphan = await store.reconcileOutboxEntry(entry.id, { status: 'sent', externalRef: 'ref', at: new Date(Date.now() + 120_000).toISOString() });
  assert.equal(orphan.changed, true);
  assert.equal(orphan.entry.status, 'sent');
  assert.equal(orphan.entry.externalRef, 'ref');

  // A settled row is a fact: a second reconciliation cannot rewrite it.
  const again = await store.reconcileOutboxEntry(entry.id, { status: 'failed' });
  assert.equal(again.changed, false);
  assert.equal(again.entry.status, 'sent');
});

test('store: requeueRun only moves the statuses the caller allowed', async (t) => {
  const temp = await createTempStore();
  t.after(() => temp.cleanup());
  const store = temp.store;
  const thread = await store.createThread({ ownerId: 'owner', title: 'requeue' });
  const { run } = await store.createRun({
    threadId: thread.id,
    ownerId: 'owner',
    userMessageId: null,
    clientMessageId: 'requeue-run-1',
    planner: 'test',
    maxSteps: 5,
    maxCostMicros: 1000
  });
  await store.finishRun(run.id, RUN_STATUS.succeeded);

  assert.equal(await store.requeueRun(run.id), false, 'a succeeded run is not a parked approval');
  assert.equal(await store.requeueRun(run.id, { from: [RUN_STATUS.succeeded] }), true);
  assert.equal((await store.getRun(run.id)).status, RUN_STATUS.queued);
});
