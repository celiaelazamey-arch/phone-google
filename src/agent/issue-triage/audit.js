/**
 * The audit trail: every decision becomes an entry with the fields the governance design requires, chained by
 * SHA-256 so a later edit to the ledger is detectable instead of deniable.
 *
 * Entries are stored as comments on one ledger issue (append-only by construction, no database and no secret
 * needed — which is what keeps the whole loop on the free tier). Each comment carries one machine-readable
 * marker line; the chain is recomputed from those markers, not from the human summary.
 */
import { hashOf, sha256Text } from '../evidence.js';
import { ROLLBACK_WINDOW_DAYS, THRESHOLDS, TRIAGE_POLICY_VERSION } from './policy.js';

export const LEDGER_MARKER = 'celia-triage-record';

export function decisionHash({ prevHash, seq, at, issueNumber, contentHash, proposalHash, route, appliedHash }) {
  return sha256Text(
    [prevHash, String(seq), at, String(issueNumber), contentHash, proposalHash, route, appliedHash, TRIAGE_POLICY_VERSION].join('|')
  );
}

/**
 * @param {object} input
 * @param {{number: number, title: string, url?: string}} input.issue
 * @param {object} input.proposal
 * @param {object} input.decision
 * @param {'propose'|'cautious'} input.mode
 * @param {number} input.dailyAutoApplied auto-applied decisions already recorded today (before this one)
 * @param {string} [input.reviewer] identity of the human who will review a `human` route
 * @param {Date} [input.now]
 * @param {string|null} [input.prevHash]
 * @param {number} [input.seq]
 * @param {object} [input.injection]
 */
export function buildRecord({
  issue,
  proposal,
  decision,
  mode,
  dailyAutoApplied = 0,
  reviewer = null,
  now = new Date(),
  prevHash = null,
  seq = 1,
  injection = { tainted: false }
}) {
  const at = now.toISOString();
  const contentHash = hashOf({ title: issue.title || '', body: issue.body || '' });
  const proposalHash = hashOf({
    type: proposal.type,
    priority: proposal.priority,
    labels: proposal.labels,
    confidence: proposal.confidence
  });
  const appliedHash = hashOf({ labels: decision.labels, assignee: decision.assignee, route: decision.route });
  const id = decisionHash({ prevHash, seq, at, issueNumber: issue.number, contentHash, proposalHash, route: decision.route, appliedHash });
  const rollbackDeadline = new Date(now.getTime() + ROLLBACK_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  return {
    version: TRIAGE_POLICY_VERSION,
    id,
    seq,
    at,
    issue: { number: issue.number, title: String(issue.title || '').slice(0, 200), url: issue.url || null },
    contentHash,
    mode,
    thresholds: { auto: THRESHOLDS.auto, human: THRESHOLDS.human },
    proposal: {
      type: proposal.type,
      priority: proposal.priority,
      labels: [...(proposal.labels || [])],
      confidence: proposal.confidence,
      reasons: [...(proposal.reasons || [])]
    },
    decision: { route: decision.route, reasons: [...(decision.reasons || [])] },
    applied: {
      changed: decision.labels.length > 0 || Boolean(decision.assignee),
      labels: [...decision.labels],
      assignee: decision.assignee,
      refusedLabels: [...(decision.refusedLabels || [])]
    },
    reviewer: decision.route === 'human' ? reviewer || 'unassigned-human' : null,
    rollback: { deadline: rollbackDeadline, windowDays: ROLLBACK_WINDOW_DAYS },
    dailyCounter: { autoAppliedToday: dailyAutoApplied + (decision.route === 'auto' ? 1 : 0) },
    injection: {
      tainted: Boolean(injection.tainted),
      ruleIds: [...(injection.ruleIds || [])],
      payloads: (injection.payloads || []).map((entry) => ({ id: entry.id, value: String(entry.value).slice(0, 60) }))
    },
    prevHash,
    hash: id
  };
}

/** One-line marker + human summary. The marker is what the chain is rebuilt from. */
export function formatRecordComment(record) {
  const lines = [];
  lines.push(`<!-- ${LEDGER_MARKER} ${JSON.stringify(record)} -->`);
  lines.push(`### ${routeLabel(record.decision.route)} · issue #${record.issue.number} · ${record.at.slice(0, 19)}Z`);
  lines.push('');
  lines.push(`- **الاقتراح:** type=${record.proposal.type ?? '—'} · priority=${record.proposal.priority} · labels=${record.proposal.labels.join(', ') || '—'}`);
  lines.push(`- **الثقة:** ${record.proposal.confidence.toFixed(2)} (auto ≥ ${record.thresholds.auto} · human ≥ ${record.thresholds.human}) · mode=${record.mode}`);
  lines.push(`- **المسار:** ${record.decision.route} — ${record.decision.reasons.join('; ')}`);
  lines.push(`- **المطبَّق:** ${record.applied.changed ? `${record.applied.labels.join(', ') || '—'}${record.applied.assignee ? ` · @${record.applied.assignee}` : ''}` : 'لا تغيير على الـIssue'}`);
  lines.push(`- **التراجع:** متاح حتى ${record.rollback.deadline.slice(0, 19)}Z (${record.rollback.windowDays} أيام) · id \`${record.id.slice(0, 12)}\``);
  if (record.injection.tainted) {
    lines.push(`- **حقن محجوب:** ${record.injection.ruleIds.join(', ')} — نص الـIssue بيانات لا تعليمات`);
  }
  lines.push(`- **السلسلة:** seq ${record.seq} · prev ${record.prevHash ? `\`${record.prevHash.slice(0, 12)}\`` : 'genesis'} · hash \`${record.hash.slice(0, 12)}\``);
  return lines.join('\n');
}

export function routeLabel(route) {
  if (route === 'auto') return '✅ تطبيق تلقائي (Cautious)';
  if (route === 'human') return '👤 مراجعة بشرية';
  return '⛔ رفض';
}

/** Parse the machine-readable markers out of ledger comments, in comment order. */
export function parseLedgerComments(comments) {
  const records = [];
  for (const comment of comments || []) {
    const body = typeof comment === 'string' ? comment : comment?.body;
    if (!body) continue;
    const match = body.match(new RegExp(`<!--\\s*${LEDGER_MARKER}\\s*(\\{.*?\\})\\s*-->`, 's'));
    if (!match) continue;
    try {
      records.push(JSON.parse(match[1]));
    } catch {
      records.push({ unparsable: true, body: body.slice(0, 120) });
    }
  }
  return records;
}

/** Recompute the chain; returns the first break instead of a boolean so a failure names the entry. */
export function verifyDecisionChain(records) {
  if (!Array.isArray(records)) return { ok: false, count: 0, reason: 'records_not_array' };
  let prevHash = null;
  let expectedSeq = 1;
  for (const record of records) {
    if (record?.unparsable) return { ok: false, count: records.length, brokenSeq: expectedSeq, reason: 'unparsable_record' };
    if (record.seq !== expectedSeq) return { ok: false, count: records.length, brokenSeq: record.seq, reason: 'seq_gap_or_reorder' };
    if ((record.prevHash ?? null) !== prevHash) return { ok: false, count: records.length, brokenSeq: record.seq, reason: 'prev_hash_mismatch' };
    const expected = decisionHash({
      prevHash: record.prevHash ?? null,
      seq: record.seq,
      at: record.at,
      issueNumber: record.issue?.number,
      contentHash: record.contentHash,
      proposalHash: hashOf({
        type: record.proposal?.type,
        priority: record.proposal?.priority,
        labels: record.proposal?.labels,
        confidence: record.proposal?.confidence
      }),
      route: record.decision?.route,
      appliedHash: hashOf({ labels: record.applied?.labels ?? [], assignee: record.applied?.assignee ?? null, route: record.decision?.route })
    });
    if (expected !== record.hash) return { ok: false, count: records.length, brokenSeq: record.seq, reason: 'hash_mismatch' };
    prevHash = record.hash;
    expectedSeq += 1;
  }
  return { ok: true, count: records.length, head: prevHash };
}

/** Auto-applied decisions recorded on the same UTC day — the counter the cap is enforced against. */
export function autoAppliedToday(records, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  return (records || []).filter((record) => record?.decision?.route === 'auto' && String(record.at || '').slice(0, 10) === day).length;
}

/** The latest record for one issue, used for idempotency and for rollback. */
export function latestForIssue(records, issueNumber) {
  const matching = (records || []).filter((record) => record?.issue?.number === Number(issueNumber));
  return matching.length ? matching[matching.length - 1] : null;
}

export function withinRollbackWindow(record, now = new Date()) {
  if (!record?.rollback?.deadline) return false;
  return new Date(record.rollback.deadline).getTime() >= now.getTime();
}
