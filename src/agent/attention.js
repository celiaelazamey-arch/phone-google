/**
 * The attention queue (UX-004 / DEC-098): the last P0 gap — «الإشعارات والتنبيهات».
 *
 * What existed before this file: a live event stream that reaches a page *while it is open*, and two
 * operator scripts that open a GitHub issue when CI or the service audit fails. Neither answers the
 * question a person actually asks — «ما الذي ينتظرني الآن؟» — after closing the tab.
 *
 * So this is not a notification *service*. It invents no messages, stores no "read" flag it does not
 * have, and sends nothing anywhere. It is a view over **durable states that already mean someone is
 * blocked**:
 *
 *   - a run `waiting_approval` (or an approval row still `pending`) → a decision is owed;
 *   - a run `needs_reconciliation`, a tool run `unknown`, an outbox row `unknown`/`dispatching`
 *     → an outcome is ambiguous and must not be replayed blindly;
 *   - a run `failed` or `budget_exhausted` → something stopped and nobody knows why yet;
 *   - a run `succeeded` → nothing is owed; it is listed so the queue can say «لا شيء ينتظرك».
 *
 * Every item carries the identifiers of the record it came from, so nothing on this list is
 * unattributable. When a state changes, the item disappears by itself — that is the only "read"
 * there is, and it is the truth rather than a flag.
 *
 * Deliberately absent: push, email, WhatsApp, websockets, retries, and any notion of urgency that the
 * data does not contain. Severity is derived from the state, not from how long a person has ignored it.
 */
import { createHash } from 'node:crypto';

import { findSecret } from '../knowledge/validate.js';
import { APPROVAL_DECISION, RUN_STATUS, TOOL_RUN_STATUS } from './store.js';
import { OUTBOX_STATUS } from './outbox.js';

export const ATTENTION_VERSION = 'celiaos-attention-v1';

/** Ordered from "someone is blocked" down to "nothing is owed". */
export const SEVERITY = Object.freeze({
  decision: 'decision',
  ambiguous: 'ambiguous',
  failure: 'failure',
  info: 'info'
});

const SEVERITY_RANK = Object.freeze({ decision: 0, ambiguous: 1, failure: 2, info: 3 });

export const REASON = Object.freeze({
  approval_pending: { severity: SEVERITY.decision, ar: 'موافقة تنتظر قرارك', en: 'an approval is waiting for you' },
  run_waiting_approval: { severity: SEVERITY.decision, ar: 'تشغيل متوقّف على موافقتك', en: 'a run is paused on your approval' },
  run_needs_reconciliation: { severity: SEVERITY.ambiguous, ar: 'نتيجة غير محسومة تحتاج مصالحة', en: 'an ambiguous outcome needs reconciliation' },
  tool_unknown: { severity: SEVERITY.ambiguous, ar: 'أداة انتهت بحالة مجهولة', en: 'a tool ended in an unknown state' },
  outbox_unknown: { severity: SEVERITY.ambiguous, ar: 'أثر خارجي غير محسوم', en: 'an external effect is unresolved' },
  outbox_dispatching: { severity: SEVERITY.ambiguous, ar: 'أثر خارجي قيد الإرسال ولم يُحسم', en: 'an external effect is mid-dispatch' },
  run_failed: { severity: SEVERITY.failure, ar: 'تشغيل فشل', en: 'a run failed' },
  budget_exhausted: { severity: SEVERITY.failure, ar: 'تشغيل توقّف لاستنفاد الميزانية', en: 'a run stopped on its budget' },
  run_succeeded: { severity: SEVERITY.info, ar: 'تشغيل اكتمل', en: 'a run completed' },
  // XAG-001: a message that found no reader is owed, not lost. Quarantine means a consumer kept
  // failing; a message addressed to the owner is a decision, because nobody else can take it.
  bus_for_owner: { severity: SEVERITY.decision, ar: 'رسالة من وكيل تنتظرك', en: 'a message from an agent is waiting for you' },
  bus_quarantined: { severity: SEVERITY.failure, ar: 'رسالة حُجِزت بعد فشل قارئها', en: 'a message was quarantined after its reader failed' }
});

/** What a person can do next. Named, never performed here. */
export const NEXT = Object.freeze({
  decide: 'decide',
  reconcile: 'reconcile',
  inspect: 'inspect',
  none: 'none'
});

const RANK = (reason) => SEVERITY_RANK[REASON[reason].severity];

/** A title that echoes a credential is replaced, not copied — the queue leaves the machine too. */
function safeTitle(value) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  if (findSecret(text)) return null;
  return text.slice(0, 160);
}

const digestOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);

const byOldest = (left, right) => {
  if (typeof left.waitingMs === 'number' && typeof right.waitingMs === 'number' && left.waitingMs !== right.waitingMs) {
    return right.waitingMs - left.waitingMs;
  }
  return String(left.since ?? '').localeCompare(String(right.since ?? '')) || String(left.id).localeCompare(String(right.id));
};

const ageing = (since, now) => {
  if (!now || !since) return null;
  const started = Date.parse(since);
  const at = Date.parse(now);
  if (!Number.isFinite(started) || !Number.isFinite(at) || at < started) return null;
  return at - started;
};

const makeItem = ({ reason, id, runId = null, since = null, now, title = null, evidence = {}, next = NEXT.inspect }) => {
  const waitingMs = ageing(since, now);
  return {
    id,
    reason,
    severity: REASON[reason].severity,
    ar: REASON[reason].ar,
    en: REASON[reason].en,
    runId,
    title: safeTitle(title),
    since,
    waitingMs,
    next,
    evidence: { runId, ...evidence },
    source: reason
  };
};

/**
 * Build the queue from durable records. Pure and deterministic: the same snapshot and clock produce
 * the same bytes, so the digest can be quoted as evidence.
 */
export function buildAttention({ runs = [], approvals = [], toolRuns = [], outbox = [], busMessages = [] } = {}, { now = null } = {}) {
  const items = [];
  const dropped = [];
  const approvalsByRun = new Map();
  for (const approval of approvals) {
    const runId = approval?.runId ?? approval?.run_id ?? null;
    if (!runId) {
      dropped.push({ kind: 'approval', reason: 'no_run_id', id: approval?.id ?? null });
      continue;
    }
    if (!approvalsByRun.has(runId)) approvalsByRun.set(runId, []);
    approvalsByRun.get(runId).push(approval);
  }
  const toolRunsByRun = new Map();
  for (const toolRun of toolRuns) {
    const runId = toolRun?.runId ?? toolRun?.run_id ?? null;
    if (!runId) {
      dropped.push({ kind: 'tool_run', reason: 'no_run_id', id: toolRun?.id ?? null });
      continue;
    }
    if (!toolRunsByRun.has(runId)) toolRunsByRun.set(runId, []);
    toolRunsByRun.get(runId).push(toolRun);
  }
  const outboxByRun = new Map();
  for (const entry of outbox) {
    const runId = entry?.runId ?? entry?.run_id ?? null;
    if (!runId) {
      dropped.push({ kind: 'outbox', reason: 'no_run_id', id: entry?.id ?? null });
      continue;
    }
    if (!outboxByRun.has(runId)) outboxByRun.set(runId, []);
    outboxByRun.get(runId).push(entry);
  }

  const seenRuns = new Set();
  for (const run of runs) {
    const id = run?.id ?? null;
    if (!id) {
      dropped.push({ kind: 'run', reason: 'no_id', id: null });
      continue;
    }
    if (seenRuns.has(id)) continue;
    seenRuns.add(id);
    const status = run.status ?? null;
    const pending = (approvalsByRun.get(id) ?? []).filter((approval) => approval.decision === APPROVAL_DECISION.pending);
    const pendingIds = pending.map((approval) => approval.id).filter(Boolean);
    const since = run.createdAt ?? run.created_at ?? null;
    const base = { runId: id, since, now, title: run.title ?? run.goal ?? null };

    if (status === RUN_STATUS.waitingApproval) {
      items.push(
        makeItem({
          ...base,
          // One decision may be owed; if the store has no pending approval row, the queue still says
          // a decision is owed and reports that the record is missing rather than hiding the run.
          reason: pending.length ? 'approval_pending' : 'run_waiting_approval',
          id: `run:${id}`,
          evidence: { approvalIds: pendingIds, missingApprovalRecord: pending.length === 0 },
          next: NEXT.decide
        })
      );
      continue;
    }
    if (status === RUN_STATUS.needsReconciliation) {
      items.push(makeItem({ ...base, reason: 'run_needs_reconciliation', id: `run:${id}`, next: NEXT.reconcile }));
      continue;
    }
    if (status === RUN_STATUS.failed) {
      items.push(makeItem({ ...base, reason: 'run_failed', id: `run:${id}`, next: NEXT.inspect }));
      continue;
    }
    if (status === RUN_STATUS.budgetExhausted) {
      items.push(makeItem({ ...base, reason: 'budget_exhausted', id: `run:${id}`, next: NEXT.inspect }));
      continue;
    }
    if (status === RUN_STATUS.succeeded) {
      items.push(makeItem({ ...base, reason: 'run_succeeded', id: `run:${id}`, next: NEXT.none }));
      continue;
    }
    // queued / running / cancelled / unknown status: nothing is owed, and nothing is invented.
    if (!Object.values(RUN_STATUS).includes(status)) dropped.push({ kind: 'run', reason: 'unknown_status', id });
  }

  // Approvals whose run is not in the snapshot still owe a decision; silence would hide them.
  for (const [runId, list] of approvalsByRun) {
    if (seenRuns.has(runId)) continue;
    const pending = list.filter((approval) => approval.decision === APPROVAL_DECISION.pending);
    if (!pending.length) continue;
    items.push(
      makeItem({
        reason: 'approval_pending',
        id: `run:${runId}`,
        runId,
        since: pending[0].createdAt ?? pending[0].created_at ?? null,
        now,
        evidence: { approvalIds: pending.map((approval) => approval.id).filter(Boolean), runMissingFromSnapshot: true },
        next: NEXT.decide
      })
    );
  }

  // Ambiguous effects are reported per record, not per run: two unknown tools are two unknowns.
  for (const toolRun of toolRuns) {
    if (toolRun.status !== TOOL_RUN_STATUS.unknown) continue;
    const runId = toolRun.runId ?? toolRun.run_id ?? null;
    items.push(
      makeItem({
        reason: 'tool_unknown',
        id: `tool:${toolRun.id}`,
        runId,
        since: toolRun.createdAt ?? toolRun.created_at ?? null,
        now,
        evidence: { toolRunId: toolRun.id ?? null, toolName: toolRun.toolName ?? toolRun.tool_name ?? null },
        next: NEXT.reconcile
      })
    );
  }
  for (const entry of outbox) {
    if (entry.status !== OUTBOX_STATUS.unknown && entry.status !== OUTBOX_STATUS.dispatching) continue;
    const runId = entry.runId ?? entry.run_id ?? null;
    items.push(
      makeItem({
        reason: entry.status === OUTBOX_STATUS.unknown ? 'outbox_unknown' : 'outbox_dispatching',
        id: `outbox:${entry.id}`,
        runId,
        since: entry.createdAt ?? entry.created_at ?? null,
        now,
        evidence: { outboxId: entry.id ?? null, toolName: entry.toolName ?? entry.tool_name ?? null },
        next: NEXT.reconcile
      })
    );
  }

  // XAG-001: messages that nobody consumed. A quarantined message is a failure by definition; a
  // message waiting for the owner is a decision only the owner can take. Neither opens a run.
  for (const message of busMessages) {
    const status = message?.status ?? 'pending';
    const to = String(message?.to ?? '');
    if (status !== 'quarantined' && !(status === 'pending' && to === 'owner')) continue;
    items.push(
      makeItem({
        reason: status === 'quarantined' ? 'bus_quarantined' : 'bus_for_owner',
        id: `bus:${message.messageId}`,
        runId: message.from ?? null,
        since: message.createdAt ?? null,
        now,
        title: message.kind ?? null,
        evidence: {
          messageId: message.messageId ?? null,
          kind: message.kind ?? null,
          to,
          sequence: message.seq ?? null,
          quarantineReason: message.quarantineReason ?? null
        },
        next: status === 'quarantined' ? NEXT.inspect : NEXT.decide
      })
    );
  }

  items.sort((left, right) => RANK(left.reason) - RANK(right.reason) || byOldest(left, right));

  const counts = Object.fromEntries(Object.values(SEVERITY).map((severity) => [severity, 0]));
  for (const item of items) counts[item.severity] += 1;
  const queue = {
    version: ATTENTION_VERSION,
    now,
    total: items.length,
    counts,
    owed: counts[SEVERITY.decision] + counts[SEVERITY.ambiguous] + counts[SEVERITY.failure],
    clear: items.every((item) => item.severity === SEVERITY.info),
    items,
    dropped,
    /** Stated, not implied: this view sends nothing and remembers nothing about being seen. */
    sends: false,
    tracksRead: false
  };
  return { ...queue, digest: digestOf(stripDigest(queue)) };
}

const stripDigest = ({ digest: _ignored, ...rest }) => rest;

/**
 * Re-derive the queue from the same snapshot and compare. This catches an edited queue — a removed
 * item, an added one, a softened severity, a rewritten title — not a defect in the rules themselves.
 * The digest alone would catch edits too; re-derivation is what lets the message say *which* edit.
 */
export function checkQueue(queue, sources = {}) {
  const problems = [];
  if (queue?.version !== ATTENTION_VERSION) problems.push('unknown_queue_version');
  if (queue?.sends !== false) problems.push('the queue may not send anything');
  if (queue?.tracksRead !== false) problems.push('the queue may not track read state');

  const expected = buildAttention(sources, { now: queue?.now ?? null });
  if (queue?.digest !== digestOf(stripDigest(queue ?? {}))) problems.push('digest does not match the queue');
  // Compare item by item regardless of the digest, so the message names *which* edit happened rather
  // than only saying the bytes changed.
  const got = new Set((queue?.items ?? []).map((item) => `${item.id}|${item.reason}`));
  const want = new Set(expected.items.map((item) => `${item.id}|${item.reason}`));
  for (const missing of want) if (!got.has(missing)) problems.push(`item dropped: ${missing}`);
  for (const extra of got) if (!want.has(extra)) problems.push(`item invented: ${extra}`);
  for (const item of queue?.items ?? []) {
    if (!REASON[item.reason]) problems.push(`${item.id}: unknown reason ${item.reason}`);
    else if (item.severity !== REASON[item.reason].severity) problems.push(`${item.id}: severity softened to ${item.severity}`);
    const evidence = item.evidence ?? {};
    const hasId = [evidence.runId, evidence.toolRunId, evidence.outboxId, ...(evidence.approvalIds ?? [])].some(Boolean);
    if (!hasId) problems.push(`${item.id}: no evidence identifier`);
  }
  return { ok: problems.length === 0, problems };
}

/** The lines a person reads. Owed items first, and the count is stated rather than implied. */
export function describeAttention(queue) {
  if (queue.total === 0) return ['لا شيء ينتظرك الآن — لا تشغيل متوقف، ولا أثر غير محسوم.'];
  const lines = queue.items
    .filter((item) => item.severity !== SEVERITY.info)
    .map((item) => {
      const age = typeof item.waitingMs === 'number' ? ` · منذ ${Math.round(item.waitingMs / 60000)} دقيقة` : '';
      const tool = item.evidence.toolName ? ` · ${item.evidence.toolName}` : '';
      return `[${item.severity}] ${item.ar} — ${item.id}${tool}${age}`;
    });
  lines.push(
    `المجموع: ${queue.total} بندًا — ${queue.counts.decision} قرارًا مطلوبًا، ${queue.counts.ambiguous} غير محسوم، ${queue.counts.failure} فشلًا، ${queue.counts.info} مكتملًا.`
  );
  if (queue.owed === 0) lines.push('لا شيء مستحق عليك؛ المكتمل مذكور للعلم فقط.');
  lines.push(`بصمة الطابور ${queue.digest} — لا يرسل شيئًا ولا يتذكّر ما رأيته.`);
  return lines;
}
