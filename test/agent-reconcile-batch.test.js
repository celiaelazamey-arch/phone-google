import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempStore } from './support/agent-fixtures.js';
import { RUN_STATUS, TOOL_RUN_STATUS } from '../src/agent/store.js';
import { OUTBOX_STATUS } from '../src/agent/outbox.js';
import {
  MAX_BATCH_ITEMS,
  RECONCILE_BATCH_VERSION,
  RECONCILE_OUTCOME,
  RECONCILE_REPORT_VERSION,
  RECONCILE_TARGET,
  SKIP_REASON,
  UNRESOLVED_REASON,
  buildReconciliationReport,
  describeReconciliationReport,
  reconcileBatch
} from '../src/agent/reconcile-batch.js';

/**
 * DATA-003 — bulk reconciliation and the periodic report.
 *
 * The backlog row says what is missing: «مصالحة جماعية/تقارير مصالحة دورية». These tests are the
 * acceptance criteria, and each one exists because the obvious implementation would break a guarantee
 * the single path already earned (DEC-016, DEC-007):
 *
 *   RB-01 many rows, one finding, every row settled and every decision hashed
 *   RB-02 a lost race is reported, never overwritten
 *   RB-03 an empty batch is refused — zero rows is not "fully reconciled"
 *   RB-04 one outcome per batch; a mixed request cannot smuggle both findings
 *   RB-05 the cap is enforced, so nobody "reconciles" a whole table
 *   RB-06 an outbox intent past its lease is settled; a live dispatch is not
 *   RB-07 a foreign owner cannot even learn which ids exist
 *   RP-01 the report counts what is durable, in the queue's own vocabulary
 *   RP-02 an unmeasured age is stale, not fresh
 *   RP-03 determinism: same snapshot and instant, same bytes — quotable as evidence
 *   RP-04 nothing is scheduled or re-sent by building a report
 */

const NOW = '2026-11-04T09:00:00.000Z';

/** The store keeps `outcome` as JSON text; a reader parses it, the store does not. */
const outcomeOf = (row) => (typeof row.outcome === 'string' ? JSON.parse(row.outcome) : row.outcome);

/** A run with three ambiguous tool calls, the shape a crashed process leaves behind. */
async function seedRun(t, { calls = 3, ownerId = 'owner', park = true } = {}) {
  const temp = await createTempStore({ clock: () => Date.parse(NOW) });
  t.after(() => temp.cleanup());
  const { store } = temp;
  const thread = await store.createThread({ ownerId, title: 'مصالحة جماعية' });
  const { run } = await store.createRun({
    threadId: thread.id,
    ownerId,
    userMessageId: null,
    clientMessageId: `batch-${Math.random().toString(36).slice(2, 10)}-0001`,
    planner: 'test',
    maxSteps: 10,
    maxCostMicros: 100_000
  });
  const toolRunIds = [];
  for (let index = 0; index < calls; index += 1) {
    const { toolRun } = await store.startToolRun({
      runId: run.id,
      toolName: `read.${index}`,
      risk: 'read',
      idempotencyKey: `${run.id}:${index}:read.${index}`
    });
    await store.finishToolRun(toolRun.id, TOOL_RUN_STATUS.unknown, JSON.stringify({ reason: 'process_interrupted' }));
    toolRunIds.push(toolRun.id);
  }
  if (park) await store.finishRun(run.id, RUN_STATUS.needsReconciliation, { error: 'outcome_unknown' });
  return { ...temp, run, thread, toolRunIds };
}

test('RB-01 a batch settles many rows under one stated finding and hashes every decision', async (t) => {
  const fixture = await seedRun(t);
  const report = await reconcileBatch(
    {
      store: fixture.store,
      runId: fixture.run.id,
      actor: 'owner',
      target: RECONCILE_TARGET.toolRun,
      targetIds: fixture.toolRunIds,
      outcome: RECONCILE_OUTCOME.applied,
      externalRef: 'ref-batch-1',
      note: 'تحققت من الثلاثة في التقويم'
    },
    { now: NOW }
  );

  assert.equal(report.version, RECONCILE_BATCH_VERSION);
  assert.equal(report.requested, 3);
  assert.equal(report.settled, 3, 'every requested row moved');
  assert.deepEqual(report.skipped, []);
  assert.equal(report.complete, true);

  // The rows are a fact now, and each records that a human said so.
  const rows = await fixture.store.listToolRuns(fixture.run.id);
  for (const row of rows) {
    assert.equal(row.status, TOOL_RUN_STATUS.succeeded);
    const outcome = outcomeOf(row);
    assert.equal(outcome.reconciled, true);
    assert.equal(outcome.kind, 'reconcile_batch');
    assert.equal(outcome.findingDigest, report.findingDigest, 'one finding, one digest, carried by every row');
  }

  // One evidence entry, naming exactly the rows it settled, and the chain still verifies.
  const evidence = await fixture.store.listEvidence(fixture.run.id);
  const entry = evidence.filter((item) => item.kind === 'reconciliation').at(-1);
  assert.deepEqual([...entry.sourceIds].sort(), [...fixture.toolRunIds].sort());
  const chain = await fixture.store.verifyEvidenceChain(fixture.run.id);
  assert.equal(chain.ok, true, 'the batch extended the chain without breaking it');
});

test('RB-02 a row another process settled first is reported as skipped, never overwritten', async (t) => {
  const fixture = await seedRun(t, { calls: 2 });
  const [first, second] = fixture.toolRunIds;

  // A person resolves one of them through the single path while the batch is being written.
  await fixture.store.reconcileToolRun(first, {
    status: TOOL_RUN_STATUS.failed,
    outcome: { reconciled: true, note: 'single path' }
  });

  const report = await reconcileBatch(
    {
      store: fixture.store,
      runId: fixture.run.id,
      actor: 'owner',
      target: RECONCILE_TARGET.toolRun,
      targetIds: [first, second],
      outcome: RECONCILE_OUTCOME.applied
    },
    { now: NOW }
  );

  assert.equal(report.settled, 1, 'only the still-ambiguous row moved');
  assert.equal(report.complete, false, 'skipped rows are not a complete batch');
  const skipped = report.skipped.find((item) => item.targetId === first);
  assert.equal(skipped.reason, SKIP_REASON.alreadySettled);

  // The earlier human decision stands: `failed` is not silently rewritten to `succeeded`.
  const row = (await fixture.store.listToolRuns(fixture.run.id)).find((item) => item.id === first);
  assert.equal(row.status, TOOL_RUN_STATUS.failed);
  assert.equal(outcomeOf(row).note, 'single path');
});

test('RB-03 an empty batch is refused — zero rows is not "fully reconciled"', async (t) => {
  const fixture = await seedRun(t, { calls: 1 });
  await assert.rejects(
    () =>
      reconcileBatch(
        {
          store: fixture.store,
          runId: fixture.run.id,
          actor: 'owner',
          target: RECONCILE_TARGET.toolRun,
          targetIds: [],
          outcome: RECONCILE_OUTCOME.applied
        },
        { now: NOW }
      ),
    (error) => error.code === 'nothing_to_reconcile' && error.status === 400
  );
});

test('RB-04 one outcome per batch — a mixed finding is impossible by construction', async (t) => {
  const fixture = await seedRun(t, { calls: 2 });
  for (const bad of ['maybe', 'applied_and_not', '', null, undefined]) {
    await assert.rejects(
      () =>
        reconcileBatch(
          {
            store: fixture.store,
            runId: fixture.run.id,
            actor: 'owner',
            target: RECONCILE_TARGET.toolRun,
            targetIds: fixture.toolRunIds,
            outcome: bad
          },
          { now: NOW }
        ),
      (error) => error.code === 'invalid_reconcile_outcome'
    );
  }
  // Nothing was written by the refused attempts.
  for (const row of await fixture.store.listToolRuns(fixture.run.id)) {
    assert.equal(row.status, TOOL_RUN_STATUS.unknown);
  }

  // And the target is equally closed: a batch cannot address a record kind the single path cannot.
  await assert.rejects(
    () =>
      reconcileBatch(
        {
          store: fixture.store,
          runId: fixture.run.id,
          actor: 'owner',
          target: 'run',
          targetIds: fixture.toolRunIds,
          outcome: RECONCILE_OUTCOME.applied
        },
        { now: NOW }
      ),
    (error) => error.code === 'invalid_reconcile_target'
  );
});

test('RB-05 the batch cap is enforced so one request cannot settle a whole table', async (t) => {
  const fixture = await seedRun(t, { calls: 1, park: false });
  const ids = Array.from({ length: MAX_BATCH_ITEMS + 1 }, (_, index) => `synthetic-${index}`);
  await assert.rejects(
    () =>
      reconcileBatch(
        {
          store: fixture.store,
          runId: fixture.run.id,
          actor: 'owner',
          target: RECONCILE_TARGET.toolRun,
          targetIds: ids,
          outcome: RECONCILE_OUTCOME.applied
        },
        { now: NOW }
      ),
    (error) => error.code === 'batch_too_large'
  );
});

test('RB-06 an outbox intent past its lease is settled; a live dispatch is left alone', async (t) => {
  const fixture = await seedRun(t, { calls: 0, park: false });
  const { run, store } = fixture;

  const stale = await store.enqueueOutbox({
    runId: run.id,
    toolName: 'calendar.create',
    connector: 'google.calendar',
    idempotencyKey: `outbox:${run.id}:stale`,
    payload: { summary: 'موعد قديم' }
  });
  const live = await store.enqueueOutbox({
    runId: run.id,
    toolName: 'calendar.update',
    connector: 'google.calendar',
    idempotencyKey: `outbox:${run.id}:live`,
    payload: { summary: 'موعد حي' }
  });
  // Both were claimed; only the first claim's lease has run out by the measurement instant. A
  // zero-length lease makes the dead worker's expiry unambiguous, and the reconciliation instant is
  // stated one second later so the strict `lease_until < at` boundary is exercised for real.
  assert.equal(await store.claimOutbox(stale.entry.id, { leaseMs: 0, workerId: 'dead-worker' }), true);
  assert.equal(await store.claimOutbox(live.entry.id, { leaseMs: 3_600_000, workerId: 'live-worker' }), true);
  const at = '2026-11-04T09:00:01.000Z';

  const report = await reconcileBatch(
    {
      store,
      runId: run.id,
      actor: 'owner',
      target: RECONCILE_TARGET.outbox,
      targetIds: [stale.entry.id, live.entry.id],
      outcome: RECONCILE_OUTCOME.applied,
      externalRef: 'ref-calendar-9'
    },
    { now: at }
  );

  assert.equal(report.settled, 1);
  assert.equal(report.skipped[0].targetId, live.entry.id, 'the live dispatch is not reconcilable yet');
  assert.equal((await store.getOutbox(stale.entry.id)).status, OUTBOX_STATUS.sent);
  assert.equal((await store.getOutbox(stale.entry.id)).externalRef, 'ref-calendar-9');
  assert.equal((await store.getOutbox(live.entry.id)).status, OUTBOX_STATUS.dispatching);
});

test('RB-07 a foreign owner cannot learn which of another owner’s ids exist', async (t) => {
  const fixture = await seedRun(t, { calls: 2 });
  await assert.rejects(
    () =>
      reconcileBatch(
        {
          store: fixture.store,
          runId: fixture.run.id,
          actor: 'someone-else',
          target: RECONCILE_TARGET.toolRun,
          targetIds: fixture.toolRunIds,
          outcome: RECONCILE_OUTCOME.applied
        },
        { now: NOW }
      ),
    // `run_not_found`, not `target_not_in_run`: the refusal itself discloses nothing.
    (error) => error.status === 404 && error.code === 'run_not_found'
  );
  for (const row of await fixture.store.listToolRuns(fixture.run.id)) {
    assert.equal(row.status, TOOL_RUN_STATUS.unknown);
  }
});

test('RP-01 the report counts durable ambiguity in the queue’s own vocabulary', async (t) => {
  const fixture = await seedRun(t, { calls: 2 });
  const { run, store } = fixture;
  const { entry } = await store.enqueueOutbox({
    runId: run.id,
    toolName: 'calendar.create',
    connector: 'google.calendar',
    idempotencyKey: `outbox:${run.id}:report`,
    payload: { summary: 'موعد' }
  });
  await store.claimOutbox(entry.id, { leaseMs: 60_000, workerId: 'w' });
  await store.settleOutbox(entry.id, { status: OUTBOX_STATUS.unknown, lastError: 'timeout' });

  const unrested = await store.listUnrestedOutcomes();
  assert.equal(unrested.toolRuns.length, 2, 'both unknown calls are found without being asked about');
  assert.equal(unrested.outbox.length, 1);
  // Payload text never leaves the store through this listing.
  assert.equal(JSON.stringify(unrested).includes('موعد'), false);

  const report = buildReconciliationReport(
    { runs: [{ id: run.id, status: RUN_STATUS.needsReconciliation, createdAt: '2026-11-04T03:00:00.000Z' }], ...unrested },
    { now: NOW }
  );
  assert.equal(report.version, RECONCILE_REPORT_VERSION);
  assert.equal(report.unresolvedTotal, 4, 'two tools, one outbox row, one parked run');
  assert.equal(report.byReason[UNRESOLVED_REASON.toolUnknown], 2);
  assert.equal(report.byReason[UNRESOLVED_REASON.outboxUnknown], 1);
  assert.equal(report.byReason[UNRESOLVED_REASON.runNeedsReconciliation], 1);
  assert.ok(report.items.every((item) => item.targetId), 'every counted row is named by id');
  assert.equal(report.schedules, false);
  assert.equal(report.resends, false);

  const lines = describeReconciliationReport(report);
  assert.match(lines[0], /غير محسوم/);
  assert.match(lines.at(-1), /لا يرسل شيئًا ولا يجدول شيئًا/);
});

test('RP-02 an unmeasured age is stale, not fresh — and the threshold is stated', async (t) => {
  const fresh = buildReconciliationReport(
    { toolRuns: [{ id: 't1', runId: 'r1', toolName: 'read.x', status: TOOL_RUN_STATUS.unknown, createdAt: '2026-11-04T08:30:00.000Z' }] },
    { now: NOW, thresholdMs: 3_600_000 }
  );
  assert.equal(fresh.stale, 0, 'thirty minutes is inside a one-hour threshold');

  const aged = buildReconciliationReport(
    { toolRuns: [{ id: 't1', runId: 'r1', toolName: 'read.x', status: TOOL_RUN_STATUS.unknown, createdAt: '2026-11-04T04:00:00.000Z' }] },
    { now: NOW, thresholdMs: 3_600_000 }
  );
  assert.equal(aged.stale, 1);

  // A row whose timestamps cannot be parsed has no age. That is unmeasured, and it counts as stale
  // rather than being quietly reported as fresh.
  const unmeasurable = buildReconciliationReport(
    { toolRuns: [{ id: 't2', runId: 'r1', toolName: 'read.y', status: TOOL_RUN_STATUS.started, createdAt: 'not-a-date' }] },
    { now: NOW, thresholdMs: 3_600_000 }
  );
  assert.equal(unmeasurable.items[0].waitingMs, null);
  assert.equal(unmeasurable.stale, 1);
});

test('RP-03 the report is deterministic: the same snapshot and instant give the same digest', async () => {
  const snapshot = {
    toolRuns: [
      { id: 'b-run', runId: 'r1', toolName: 'read.b', status: TOOL_RUN_STATUS.unknown, createdAt: '2026-11-04T05:00:00.000Z' },
      { id: 'a-run', runId: 'r1', toolName: 'read.a', status: TOOL_RUN_STATUS.unknown, createdAt: '2026-11-04T05:00:00.000Z' }
    ],
    outbox: []
  };
  const first = buildReconciliationReport(snapshot, { now: NOW });
  const second = buildReconciliationReport(snapshot, { now: NOW });
  assert.equal(first.digest, second.digest);
  // Ordering is by age then id, so two rows with equal age are still ordered deterministically.
  assert.deepEqual(first.items.map((item) => item.targetId), ['a-run', 'b-run']);

  const later = buildReconciliationReport(snapshot, { now: '2026-11-04T10:00:00.000Z' });
  assert.notEqual(later.digest, first.digest, 'a different instant is a different measurement');
});

test('RP-04 the empty report states its own limit instead of claiming 100% reconciled', async () => {
  const report = buildReconciliationReport({}, { now: NOW });
  assert.equal(report.unresolvedTotal, 0);
  assert.equal(report.settledTotal, 0);
  assert.equal(report.reading.includes('لا شيء غير محسوم'), true);
  // Two zeroes are not a rate; the report says a measurement, never a percentage.
  assert.equal(Object.hasOwn(report, 'rate'), false);
  const lines = describeReconciliationReport(report);
  assert.match(lines[0], /لا شيء غير محسوم/);
  assert.match(lines.at(-1), /لا يرسل شيئًا ولا يجدول شيئًا/);
});

/**
 * RB-08 and RB-09 exist because mutation testing found them missing: deleting the lost-race guard,
 * or the store's status guard, left every other test green. A guard nobody tests is a comment.
 */
test('RB-08 a row settled between the read and the write is reported as a lost race, not a success', async (t) => {
  const fixture = await seedRun(t, { calls: 2 });
  const [first, second] = fixture.toolRunIds;

  // A store that answers the read honestly and then lets another writer win, exactly once. This is
  // the interleaving a real second request produces: both read the same ambiguous row, one writes.
  let raced = false;
  const racingStore = {
    ...fixture.store,
    async settleUnrestedToolRun(id, options) {
      if (!raced && id === first) {
        raced = true;
        // The competing decision lands first, through the single path.
        await fixture.store.reconcileToolRun(first, {
          status: TOOL_RUN_STATUS.failed,
          outcome: { reconciled: true, note: 'the other request' }
        });
      }
      return fixture.store.settleUnrestedToolRun(id, options);
    }
  };

  const report = await reconcileBatch(
    {
      store: racingStore,
      runId: fixture.run.id,
      actor: 'owner',
      target: RECONCILE_TARGET.toolRun,
      targetIds: [first, second],
      outcome: RECONCILE_OUTCOME.applied
    },
    { now: NOW }
  );

  assert.equal(raced, true, 'the interleaving actually happened');
  assert.equal(report.settled, 1, 'a lost race is not counted as settled');
  assert.equal(report.complete, false);
  assert.equal(report.skipped[0].targetId, first);
  assert.equal(report.skipped[0].reason, SKIP_REASON.lostRace);

  // The winner's finding survives untouched, and only the winner is named in the evidence.
  const rows = await fixture.store.listToolRuns(fixture.run.id);
  assert.equal(rows.find((row) => row.id === first).status, TOOL_RUN_STATUS.failed);
  assert.equal(outcomeOf(rows.find((row) => row.id === first)).note, 'the other request');
  assert.equal(rows.find((row) => row.id === second).status, TOOL_RUN_STATUS.succeeded);
  const entry = (await fixture.store.listEvidence(fixture.run.id))
    .filter((item) => item.kind === 'reconciliation')
    .at(-1);
  assert.deepEqual(entry.sourceIds, [second], 'evidence names the row this batch actually settled');
});

test('RB-09 the store’s conditional settle refuses a settled row and reports changed:false', async (t) => {
  const fixture = await seedRun(t, { calls: 1 });
  const { store, run } = fixture;
  const [toolRunId] = fixture.toolRunIds;

  // First settle succeeds.
  const first = await store.settleUnrestedToolRun(toolRunId, {
    status: TOOL_RUN_STATUS.succeeded,
    outcome: { reconciled: true, note: 'first' }
  });
  assert.equal(first.changed, true);
  // A second attempt on the same row changes nothing: it is a fact now, and the caller is told so.
  const second = await store.settleUnrestedToolRun(toolRunId, {
    status: TOOL_RUN_STATUS.failed,
    outcome: { reconciled: true, note: 'second' }
  });
  assert.equal(second.changed, false);
  assert.equal(second.toolRun.status, TOOL_RUN_STATUS.succeeded, 'the attempt did not rewrite the row');

  // The same guard for external intents, including a settled (`sent`) row and a valid status set.
  const { entry } = await store.enqueueOutbox({
    runId: run.id,
    toolName: 'calendar.create',
    connector: 'google.calendar',
    idempotencyKey: `outbox:${run.id}:guard`,
    payload: { summary: 'موعد' }
  });
  const unsettled = await store.settleUnrestedOutboxEntry(entry.id, {
    status: OUTBOX_STATUS.sent,
    externalRef: 'ref-1',
    at: NOW
  });
  assert.equal(unsettled.changed, false, 'a `pending` intent is not an ambiguous one');
  await assert.rejects(
    () => store.settleUnrestedOutboxEntry(entry.id, { status: 'probably', at: NOW }),
    /Invalid reconciled outbox status/
  );
  await assert.rejects(
    () => store.settleUnrestedToolRun(toolRunId, { status: 'unknown' }),
    /Invalid reconciled tool status/
  );
});

/**
 * RB-10 pins the lease boundary that the batch and the store must agree on.
 *
 * The store's conditional UPDATE compares `lease_until < at` (strict), and this batch lists with the
 * same strictness, so a row sitting exactly on the boundary is reported `not_ambiguous` rather than
 * offered as a target the write would then refuse with a 409. Mutation testing found this test
 * missing: relaxing the SQL to `<=` left the whole suite green.
 */
test('RB-10 the batch and the store agree at the exact lease boundary', async (t) => {
  const fixture = await seedRun(t, { calls: 0, park: false });
  const { run, store } = fixture;
  const { entry } = await store.enqueueOutbox({
    runId: run.id,
    toolName: 'calendar.create',
    connector: 'google.calendar',
    idempotencyKey: `outbox:${run.id}:boundary`,
    payload: { summary: 'على الحد' }
  });
  // The clock instant is NOW, so a zero-length lease puts `lease_until` exactly on NOW.
  assert.equal(await store.claimOutbox(entry.id, { leaseMs: 0, workerId: 'worker' }), true);
  assert.equal((await store.getOutbox(entry.id)).leaseUntil, NOW);

  // At the boundary the store refuses the settlement: `lease_until < at` is false.
  const atBoundary = await store.settleUnrestedOutboxEntry(entry.id, { status: OUTBOX_STATUS.sent, at: NOW });
  assert.equal(atBoundary.changed, false, 'the boundary row is not yet relocatable');

  // And the batch says so in words instead of reporting a settlement it did not make.
  const report = await reconcileBatch(
    {
      store,
      runId: run.id,
      actor: 'owner',
      target: RECONCILE_TARGET.outbox,
      targetIds: [entry.id],
      outcome: RECONCILE_OUTCOME.applied
    },
    { now: NOW }
  );
  assert.equal(report.settled, 0);
  assert.equal(report.skipped[0].reason, SKIP_REASON.notAmbiguous);
  assert.equal((await store.getOutbox(entry.id)).status, OUTBOX_STATUS.dispatching);

  // One second later the same row is genuinely abandoned, and the batch can settle it.
  const after = await reconcileBatch(
    {
      store,
      runId: run.id,
      actor: 'owner',
      target: RECONCILE_TARGET.outbox,
      targetIds: [entry.id],
      outcome: RECONCILE_OUTCOME.applied,
      externalRef: 'ref-after-boundary'
    },
    { now: '2026-11-04T09:00:01.000Z' }
  );
  assert.equal(after.settled, 1);
  assert.equal((await store.getOutbox(entry.id)).status, OUTBOX_STATUS.sent);
});

/**
 * CLI-01 — `reconcile:report` is the operator's view, and its exit codes are part of its contract.
 *
 * The honest default matters more than the printing: a missing store must not be created, and a
 * report with anything unresolved must exit non-zero so a scheduled caller cannot read silence as
 * health. Mutation testing is why the "does not create" assert exists at all.
 */
test('CLI-01 the report command refuses a missing store, and its exit code follows the findings', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = new URL('..', import.meta.url).pathname;

  const directory = mkdtempSync(join(tmpdir(), 'celia-reconcile-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const missing = join(directory, 'absent.sqlite3');

  const noStore = spawnSync(process.execPath, ['scripts/reconcile-report.mjs', '--db', missing], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.equal(noStore.status, 2, 'silence about a missing store would be a false all-clear');
  assert.match(noStore.stderr, /nothing was created/);
  assert.equal(existsSync(missing), false, 'asking a question must not manufacture a database');

  // Build a real store with one unknown call, then ask.
  const fixture = await seedRun(t, { calls: 1 });
  const withFindings = spawnSync(
    process.execPath,
    ['scripts/reconcile-report.mjs', '--db', fixture.file, '--json', '--now', NOW],
    { cwd: root, encoding: 'utf8' }
  );
  assert.equal(withFindings.status, 1, 'an unresolved row exits non-zero');
  const report = JSON.parse(withFindings.stdout);
  assert.equal(report.unresolvedTotal, 1);
  assert.equal(report.schedules, false);

  // Settle it and the same command exits zero — the change came from the data, not from a flag.
  await reconcileBatch(
    {
      store: fixture.store,
      runId: fixture.run.id,
      actor: 'owner',
      target: RECONCILE_TARGET.toolRun,
      targetIds: fixture.toolRunIds,
      outcome: RECONCILE_OUTCOME.notApplied
    },
    { now: NOW }
  );
  const cleared = spawnSync(
    process.execPath,
    ['scripts/reconcile-report.mjs', '--db', fixture.file, '--json', '--now', NOW],
    { cwd: root, encoding: 'utf8' }
  );
  assert.equal(cleared.status, 0);
  assert.equal(JSON.parse(cleared.stdout).unresolvedTotal, 0);
});
