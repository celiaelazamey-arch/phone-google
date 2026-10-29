/**
 * Governed issue triage — the whole loop in one call:
 *   untrusted text → injection scan → deterministic proposal → confidence gate → audit record (hash-chained).
 *
 * Everything is pure: no network, no clock surprises, no repository writes. The CLI owns the I/O and can only
 * perform the effects the gate returned, which is what keeps "the agent decided" and "the agent did" separate.
 */
import { classifyIssue } from './classify.js';
import { decide } from './gate.js';
import { scanForInjection } from './injection.js';
import { autoAppliedToday, buildRecord, formatRecordComment, latestForIssue } from './audit.js';
import { resolveMode, TRIAGE_POLICY_VERSION } from './policy.js';
import { hashOf } from '../evidence.js';

export * from './policy.js';
export * from './classify.js';
export * from './gate.js';
export * from './audit.js';
export * from './injection.js';

/**
 * @param {object} input
 * @param {{number: number, title?: string, body?: string, url?: string}} input.issue
 * @param {'propose'|'cautious'} [input.mode]
 * @param {object[]} [input.history] previous audit records (oldest first) — chain and daily counter
 * @param {Date} [input.now]
 * @param {string|null} [input.reviewer]
 * @returns {{skipped: boolean, reason?: string, mode: string, route?: string, record?: object, comment?: string}}
 */
export function triageIssue({ issue, mode = 'propose', history = [], now = new Date(), reviewer = null } = {}) {
  if (!issue || !Number.isInteger(Number(issue.number))) throw new Error('issue.number is required');
  const resolvedMode = resolveMode(mode, 'propose');
  const records = Array.isArray(history) ? history.filter((record) => record && !record.unparsable) : [];

  // Scan first, classify second: the payload is removed from the text the classifier reads, so injected words
  // ("deploy to main") can never become evidence, and only the gate decides what a tainted issue gets.
  const injection = scanForInjection(issue.title, issue.body);
  const [safeTitle = '', safeBody = ''] = injection.scrubbedParts || [];
  const proposal = classifyIssue({ title: safeTitle, body: safeBody });

  // Idempotency: an issue edited twice (or a re-run of the same event) must not produce a second decision that
  // could double-apply labels or inflate the daily counter.
  const latest = latestForIssue(records, issue.number);
  const contentHash = buildRecordContentHash(issue);
  if (latest && latest.contentHash === contentHash && latest.mode === resolvedMode) {
    return { skipped: true, reason: 'duplicate_content', mode: resolvedMode, record: latest };
  }

  const dailyAutoApplied = autoAppliedToday(records, now);
  const decision = decide({ proposal, injection, mode: resolvedMode, dailyAutoApplied });
  const record = buildRecord({
    issue,
    proposal,
    decision,
    mode: resolvedMode,
    dailyAutoApplied,
    reviewer,
    now,
    prevHash: records.length ? records[records.length - 1].hash ?? null : null,
    seq: records.length + 1,
    injection
  });

  return {
    skipped: false,
    mode: resolvedMode,
    policy: TRIAGE_POLICY_VERSION,
    route: decision.route,
    decision,
    proposal,
    injection,
    record,
    comment: formatRecordComment(record)
  };
}

function buildRecordContentHash(issue) {
  // Same material the record hashes, recomputed here so the dedupe check does not need a record to exist.
  return hashOf({ title: issue.title || '', body: issue.body || '' });
}
