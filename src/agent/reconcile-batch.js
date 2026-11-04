/**
 * DATA-003 — bulk reconciliation and the periodic reconciliation report.
 *
 * The single-target exit already exists: `POST /runs/:id/reconcile` (DEC-016) closes one `unknown`
 * call or one external intent, and the attention queue (UX-004) lists what is owed. What was missing
 * is the work *after* the list: a person with twelve ambiguous outcomes had to open twelve runs and
 * repeat the same finding twelve times, and nobody could answer «what is still unknown, and for how
 * long?» except by reading runs one at a time.
 *
 * This module adds exactly two things, and refuses everything else:
 *
 *   1. **A batch.** Many records, *one* stated finding, settled under the same conditional guards as
 *      the single path. It is not a second way to decide: the owner still asserts `applied` or
 *      `not_applied` from evidence they saw. The batch only spares them retyping it.
 *   2. **A report.** What is still unresolved, how long it has waited, which run owns it, and what
 *      happened to the ones already closed — derived from durable rows, never stored.
 *
 * What it deliberately does **not** do, because each one would cost the guarantee the single path
 * exists to keep:
 *
 *   - It never calls a connector and never re-sends. Reconciliation is bookkeeping.
 *   - It never decides an outcome by inferring one. There is no "assume applied because the provider
 *     probably got it": an outcome is a human statement, and a batch without one is refused.
 *   - It never settles a row that another process settled first. A lost race is reported as
 *     `skipped`, with the reason named, and is *not* counted as resolved.
 *   - It never mixes outcomes inside one batch. Every item in a batch carries the same finding, so
 *     a report can never attribute an `applied` to a record a person called `not_applied`.
 *   - It never treats "no items" as success. An empty batch is refused (`nothing_to_reconcile`), for
 *     the same reason an unmeasured launch window is not a passing one (DEC-135).
 *
 * The periodic half is a *report*, not a scheduler: `buildReconciliationReport` reads a snapshot and
 * returns counts, ages and the rows behind them. Nothing here starts a timer, holds a lock or sends a
 * message. A scheduled workflow, if the owner ever wants one, calls this and reports — the decision
 * to run on a schedule is a separate approved decision, not a side effect of reading state.
 */
import { EVIDENCE_KIND, hashOf } from './evidence.js';
import { RUN_STATUS, TOOL_RUN_STATUS } from './store.js';
import { OUTBOX_STATUS } from './outbox.js';

export const RECONCILE_BATCH_VERSION = 'celiaos-reconcile-batch-v1';
export const RECONCILE_REPORT_VERSION = 'celiaos-reconcile-report-v1';

/** The two records the single path can settle. A batch settles no other kind. */
export const RECONCILE_TARGET = Object.freeze({
  toolRun: 'tool_run',
  outbox: 'outbox'
});

/** The only two findings a person may state. There is no third, and no default. */
export const RECONCILE_OUTCOME = Object.freeze({
  applied: 'applied',
  notApplied: 'not_applied'
});

/** Hard ceiling on one batch: a person states one finding, not a bulk assumption over everything. */
export const MAX_BATCH_ITEMS = 50;

/** Reasons a row is listed as owed. Named so a report can be counted, not re-read. */
export const UNRESOLVED_REASON = Object.freeze({
  toolStarted: 'tool_started',
  toolUnknown: 'tool_unknown',
  outboxUnknown: 'outbox_unknown',
  outboxDispatching: 'outbox_dispatching_lease_expired',
  runNeedsReconciliation: 'run_needs_reconciliation'
});

/** Why one requested item was not settled. None of these is a success. */
export const SKIP_REASON = Object.freeze({
  notFound: 'not_found',
  /** A settled row is a fact, not an opinion: the single path refuses it with 409 and so does a batch. */
  alreadySettled: 'already_settled',
  /** Still genuinely in flight — its lease is alive, so nobody yet knows the outcome. */
  notAmbiguous: 'not_ambiguous',
  /** Ambiguous when read, settled by someone else before the conditional write. */
  lostRace: 'lost_race',
  duplicateId: 'duplicate_id'
});

class BatchError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const requireOutcome = (outcome) => {
  const value = String(outcome ?? '').trim().toLowerCase();
  if (!Object.values(RECONCILE_OUTCOME).includes(value)) {
    throw new BatchError(400, 'invalid_reconcile_outcome', 'outcome must be "applied" or "not_applied"');
  }
  return value;
};

const requireTarget = (target) => {
  const value = String(target ?? '').trim();
  if (!Object.values(RECONCILE_TARGET).includes(value)) {
    throw new BatchError(400, 'invalid_reconcile_target', 'target must be "tool_run" or "outbox"');
  }
  return value;
};

/**
 * The durable snapshot both views read: the ambiguous records and the bus messages nobody consumed.
 *
 * `reconciliationReport` and the attention queue (`UX-004`) must never disagree about *what* is
 * ambiguous, so there is exactly one function that finds the rows. It returns payload-free records —
 * ids, names, statuses, timestamps — which is what lets the result be quoted or sent across a
 * process boundary.
 */
export async function readAmbiguitySnapshot({ store, limit = 200 } = {}) {
  if (!store) throw new BatchError(500, 'reconcile_store_required');
  const unrested =
    typeof store.listUnrestedOutcomes === 'function'
      ? await store.listUnrestedOutcomes({ limit })
      : { toolRuns: [], outbox: [] };
  const busMessages = typeof store.listBusOutstanding === 'function' ? await store.listBusOutstanding({ limit }) : [];
  return {
    toolRuns: unrested.toolRuns ?? [],
    outbox: unrested.outbox ?? [],
    busMessages
  };
}


/**
 * One stated finding, canonicalised. `at` is the reporting instant and is deliberately excluded from
 * the digest so the same decision replayed at another second is recognisably the same decision — the
 * durable evidence chain, not process memory, decides whether it was already recorded.
 */
function batchFinding({ outcome, actor, note = null, externalRef = null, items }) {
  return {
    kind: 'reconcile_batch',
    version: RECONCILE_BATCH_VERSION,
    outcome,
    actor,
    externalRef,
    note,
    targets: items.map((item) => ({ target: item.target, targetId: item.targetId }))
  };
}

/**
 * Decide, per requested id, whether this batch may settle it.
 *
 * The store is the authority on current status: the module never assumes a row is still ambiguous
 * because the caller said so. The three refusals are kept apart on purpose, because they mean
 * different things to a person — a settled row needs no action, an in-flight one needs waiting, and a
 * missing id means the caller is looking at stale data.
 */
function classify({ requested, byId, target, isAmbiguous }) {
  const accepted = [];
  const skipped = [];
  const seen = new Set();
  for (const raw of requested) {
    const targetId = typeof raw === 'string' ? raw.trim() : '';
    if (!targetId) {
      skipped.push({ target, targetId: null, reason: SKIP_REASON.notFound });
      continue;
    }
    if (seen.has(targetId)) {
      skipped.push({ target, targetId, reason: SKIP_REASON.duplicateId });
      continue;
    }
    seen.add(targetId);
    const row = byId.get(targetId);
    if (!row) {
      skipped.push({ target, targetId, reason: SKIP_REASON.notFound });
      continue;
    }
    if (isAmbiguous(row)) {
      accepted.push(row);
      continue;
    }
    // A `dispatching`/`started` row inside a live lease is not settled — it is undecided, and a
    // finding stated now could contradict a request that is still in flight.
    const inFlight =
      target === RECONCILE_TARGET.outbox
        ? row.status === OUTBOX_STATUS.dispatching
        : row.status === TOOL_RUN_STATUS.started;
    skipped.push({ target, targetId, reason: inFlight ? SKIP_REASON.notAmbiguous : SKIP_REASON.alreadySettled });
  }
  return { accepted, skipped };
}

/**
 * Settle many ambiguous records under one stated finding.
 *
 * `store` must expose the conditional settle methods. The runtime passes its own store, so this
 * module never grows a second persistence path; it is deliberately a *policy* over the store, not a
 * driver.
 */
export async function reconcileBatch(
  {
    store,
    runId,
    actor,
    outcome,
    target,
    targetIds = [],
    note = null,
    externalRef = null,
    requireRun = true
  } = {},
  { now = null } = {}
) {
  if (!store) throw new BatchError(500, 'reconcile_store_required');
  if (!actor) throw new BatchError(401, 'reconcile_actor_required');
  const settledOutcome = requireOutcome(outcome);
  const settledTarget = requireTarget(target);
  if (!Array.isArray(targetIds) || targetIds.length === 0) {
    // An empty batch is not a successful batch. State it, do not quietly return zero.
    throw new BatchError(400, 'nothing_to_reconcile');
  }
  if (targetIds.length > MAX_BATCH_ITEMS) {
    throw new BatchError(400, 'batch_too_large', `a batch settles at most ${MAX_BATCH_ITEMS} records; state your finding again`);
  }
  if (requireRun) {
    if (!runId) throw new BatchError(400, 'reconcile_run_required');
    // Ownership first: a foreign run must not even disclose whether its records exist.
    const run = await store.getRunForOwner(runId, actor);
    if (!run) throw new BatchError(404, 'run_not_found');
  }

  // The instant the lease comparison uses. When the caller states it, the SQL guard in the store
  // compares against that same instant; otherwise the store's own clock decides.
  const at = now ?? null;
  // An expired lease means the dispatcher is gone and the outcome is genuinely unknown. The boundary
  // is deliberately the same strict `lease_until < at` the store's conditional UPDATE uses: a list
  // that disagrees with its own write would offer a target the write then refuses.
  const leaseExpired = (row) => {
    if (!at) return true; // the store answered the question against its own clock
    const until = Date.parse(row.leaseUntil ?? '');
    return !Number.isFinite(until) || until < Date.parse(at);
  };
  // Every row of this run, then one predicate per record kind. Reading the full list (not only the
  // ambiguous slice) is what lets a refusal say *why* it refused.
  const isAmbiguousToolRun = (row) => row.status === TOOL_RUN_STATUS.started || row.status === TOOL_RUN_STATUS.unknown;
  const isAmbiguousOutbox = (row) =>
    row.status === OUTBOX_STATUS.unknown || (row.status === OUTBOX_STATUS.dispatching && leaseExpired(row));
  const isAmbiguous = settledTarget === RECONCILE_TARGET.toolRun ? isAmbiguousToolRun : isAmbiguousOutbox;
  const rows =
    settledTarget === RECONCILE_TARGET.toolRun ? await store.listToolRuns(runId) : await store.listOutbox(runId);
  const { accepted, skipped } = classify({
    requested: targetIds,
    byId: new Map(rows.map((row) => [row.id, row])),
    target: settledTarget,
    isAmbiguous
  });

  const settledStatus =
    settledTarget === RECONCILE_TARGET.toolRun
      ? settledOutcome === RECONCILE_OUTCOME.applied
        ? TOOL_RUN_STATUS.succeeded
        : TOOL_RUN_STATUS.failed
      : settledOutcome === RECONCILE_OUTCOME.applied
        ? OUTBOX_STATUS.sent
        : OUTBOX_STATUS.failed;

  const finding = batchFinding({ outcome: settledOutcome, actor, note, externalRef, items: accepted });
  const findingDigest = hashOf(finding);
  const settled = [];

  for (const row of accepted) {
    // The finding is stamped into the row and hashed in the evidence chain, exactly like the single
    // path, so a batch decision is auditable one row at a time and not only as an aggregate.
    const stamped = { ...finding, targetId: row.id, findingDigest, reconciled: true };
    const written =
      settledTarget === RECONCILE_TARGET.toolRun
        ? await store.settleUnrestedToolRun(row.id, { status: settledStatus, outcome: stamped })
        : await store.settleUnrestedOutboxEntry(row.id, {
            status: settledStatus,
            externalRef: settledOutcome === RECONCILE_OUTCOME.applied ? externalRef : null,
            result: stamped,
            lastError: settledOutcome === RECONCILE_OUTCOME.applied ? 'reconciled_by_owner_batch' : 'reconciled_not_applied_batch',
            at
          });
    if (!written.changed) {
      // Someone settled it between the read and the write. Report the conflict; never overwrite.
      skipped.push({ target: settledTarget, targetId: row.id, reason: SKIP_REASON.lostRace });
      continue;
    }
    settled.push({ target: settledTarget, targetId: row.id, status: settledStatus });
  }

  const sourceIds = settled.map((item) => item.targetId);
  const report = {
    version: RECONCILE_BATCH_VERSION,
    runId: runId ?? null,
    target: settledTarget,
    outcome: settledOutcome,
    findingDigest,
    requested: targetIds.length,
    settled: settled.length,
    skipped,
    // Stated so a caller cannot read `skipped` as success: the count that matters is `settled`.
    complete: skipped.length === 0,
    settledItems: settled
  };

  if (typeof store.appendEvidence === 'function' && runId) {
    await store.appendEvidence({
      runId,
      kind: EVIDENCE_KIND.reconciliation,
      input: finding,
      output: { ...report, at: now ?? null },
      sourceIds,
      verdict: settledOutcome === RECONCILE_OUTCOME.applied ? 'PASS' : 'BLOCK'
    });
  }

  return report;
}

const ageMs = (since, at) => {
  const start = Date.parse(String(since ?? ''));
  const end = Date.parse(String(at ?? ''));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
};

/**
 * Derive the reconciliation report from durable records.
 *
 * Pure and deterministic: the same snapshot and instant produce the same bytes, so the report can be
 * quoted as evidence. Every row it counts is named by id, and every count is computed from the list
 * rather than incremented in parallel — the two cannot disagree.
 *
 * `toolRuns`/`outbox` are the shapes `store.listUnrestedOutcomes()` returns (or a test snapshot of
 * the same shape); `runs` is any list of runs carrying `id`, `status` and `createdAt`.
 */
export function buildReconciliationReport(
  { runs = [], toolRuns = [], outbox = [], settled = [] } = {},
  { now = null, thresholdMs = 6 * 60 * 60 * 1000 } = {}
) {
  const at = now ?? null;
  const unresolved = [];

  for (const row of toolRuns) {
    const reason =
      row.status === TOOL_RUN_STATUS.started ? UNRESOLVED_REASON.toolStarted : UNRESOLVED_REASON.toolUnknown;
    unresolved.push({
      target: RECONCILE_TARGET.toolRun,
      targetId: row.id,
      runId: row.runId ?? null,
      toolName: row.toolName ?? null,
      reason,
      since: row.createdAt ?? null,
      waitingMs: ageMs(row.createdAt, at)
    });
  }
  for (const row of outbox) {
    const reason =
      row.status === OUTBOX_STATUS.unknown ? UNRESOLVED_REASON.outboxUnknown : UNRESOLVED_REASON.outboxDispatching;
    unresolved.push({
      target: RECONCILE_TARGET.outbox,
      targetId: row.id,
      runId: row.runId ?? null,
      toolName: row.toolName ?? null,
      reason,
      since: row.createdAt ?? null,
      waitingMs: ageMs(row.createdAt, at)
    });
  }
  for (const row of runs) {
    if (row?.status !== RUN_STATUS.needsReconciliation) continue;
    unresolved.push({
      target: 'run',
      targetId: row.id,
      runId: row.id,
      toolName: null,
      reason: UNRESOLVED_REASON.runNeedsReconciliation,
      since: row.createdAt ?? null,
      waitingMs: ageMs(row.createdAt, at)
    });
  }

  // Oldest first: the row nobody has looked at for longest is the one that costs most to keep guessing.
  unresolved.sort((left, right) => {
    const leftWait = typeof left.waitingMs === 'number' ? left.waitingMs : -1;
    const rightWait = typeof right.waitingMs === 'number' ? right.waitingMs : -1;
    return rightWait - leftWait || String(left.targetId).localeCompare(String(right.targetId));
  });

  const byReason = Object.fromEntries(Object.values(UNRESOLVED_REASON).map((reason) => [reason, 0]));
  const byTarget = Object.fromEntries(Object.values(RECONCILE_TARGET).map((target) => [target, 0]));
  let stale = 0;
  for (const item of unresolved) {
    byReason[item.reason] += 1;
    if (byTarget[item.target] !== undefined) byTarget[item.target] += 1;
    // A row with no measurable age is not "fresh" — it is unmeasured, and counts as stale.
    if (typeof item.waitingMs !== 'number' || item.waitingMs >= thresholdMs) stale += 1;
  }

  const settledByOutcome = { [RECONCILE_OUTCOME.applied]: 0, [RECONCILE_OUTCOME.notApplied]: 0 };
  for (const item of settled) {
    if (Object.hasOwn(settledByOutcome, item?.outcome)) settledByOutcome[item.outcome] += 1;
  }
  // A rate is only a rate when the denominator is measured. No unknowns yet is not "100% reconciled".
  const measured = settled.length;
  const report = {
    version: RECONCILE_REPORT_VERSION,
    now: at,
    thresholdMs,
    unresolvedTotal: unresolved.length,
    stale,
    byTarget,
    byReason,
    settledTotal: measured,
    settledByOutcome,
    // Stated in words because the number alone invites the wrong reading.
    reading:
      unresolved.length === 0
        ? 'لا شيء غير محسوم الآن — وهذا مقياس لا يُدّعى بعد إغلاق أي صف.'
        : `${unresolved.length} صفًا غير محسوم، منها ${stale} تجاوز ${Math.round(thresholdMs / 3_600_000)} ساعة.`,
    items: unresolved,
    /** Reported, not performed: this view contacts nothing and starts nothing. */
    schedules: false,
    resends: false
  };
  return { ...report, digest: hashOf(report) };
}

/** The lines a person reads. Owed rows first; the count is stated, never implied. */
export function describeReconciliationReport(report) {
  const lines = [];
  if (!report || report.unresolvedTotal === 0) {
    lines.push('لا شيء غير محسوم الآن — لا استدعاء ولا نية خارجية بلا نتيجة معلنة.');
    if (report) lines.push(`بصمة التقرير ${report.digest} — لا يرسل شيئًا ولا يجدول شيئًا.`);
    return lines;
  }
  lines.push(`غير محسوم: ${report.unresolvedTotal} · متأخر: ${report.stale} · منذ ≥ ${Math.round(report.thresholdMs / 3_600_000)} ساعة`);
  for (const item of report.items.slice(0, 20)) {
    const age = typeof item.waitingMs === 'number' ? `${Math.round(item.waitingMs / 60_000)} دقيقة` : 'عمر غير مقيس';
    lines.push(`- [${item.reason}] ${item.target}:${item.targetId} · تشغيل ${item.runId ?? '—'} · ${age}`);
  }
  if (report.items.length > 20) lines.push(`… و${report.items.length - 20} أخرى في التقرير الكامل.`);
  lines.push(`بصمة التقرير ${report.digest} — لا يرسل شيئًا ولا يجدول شيئًا.`);
  return lines;
}
