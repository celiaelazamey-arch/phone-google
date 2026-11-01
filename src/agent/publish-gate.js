/**
 * The publish gate (PUB-001 / DEC-092).
 *
 * The owner asked for one thing: to say «انشر» inside the system and have it verify the change, the
 * permissions and the checks, publish, show the result, and keep a way back — instead of driving a
 * GitHub page and a hosting dashboard. This module is that path, built where it can be honest.
 *
 * What it does: it takes a *snapshot* of everything a publish depends on and returns a verdict —
 * `ready`, `needs_owner`, or `blocked` — with every blocker named and attributed to whoever can
 * clear it. It never merges, never pushes, never deploys. It refuses to bypass signed commits,
 * required reviews, or branch protection; those are the owner's rules, and the gate is where they
 * stop being advisory.
 *
 * The gate is deliberately starved of authority: it cannot launch a subprocess, open a socket, or hold a token.
 * Execution belongs to an actor that already holds the right; the gate only decides whether that
 * actor may start, and records what happened.
 */
import { hashOf } from './evidence.js';

export const PUBLISH_GATE_VERSION = 'celiaos-publish-gate-v1';

export const VERDICT = Object.freeze({
  ready: 'ready',
  needsOwner: 'needs_owner',
  blocked: 'blocked'
});

/** Every rule the gate checks, in the order it reports them. */
export const RULES = Object.freeze([
  { id: 'evidence_present', ar: 'لقطة الفحوص موجودة', en: 'A checks snapshot exists', severity: 'block' },
  { id: 'protection_known', ar: 'قواعد الحماية مقروءة', en: 'The protection rules are known', severity: 'block' },
  { id: 'worktree_clean', ar: 'شجرة العمل نظيفة', en: 'The worktree is clean', severity: 'block' },
  { id: 'branch_ahead', ar: 'هناك ما يُنشر', en: 'The branch is ahead of its base', severity: 'block' },
  { id: 'branch_current', ar: 'الفرع لا يتخلف عن الأساس', en: 'The branch is not behind its base', severity: 'block' },
  { id: 'required_checks', ar: 'الفحوص المطلوبة ناجحة', en: 'Required checks passed', severity: 'block' },
  { id: 'signatures', ar: 'الإيداعات موقّعة حين يُشترط التوقيع', en: 'Commits are signed when signatures are required', severity: 'block' },
  { id: 'review_requirements', ar: 'شروط المراجعة مستوفاة', en: 'Review requirements are met', severity: 'block' },
  { id: 'approval_bound', ar: 'موافقة صريحة مربوطة ببصمة الطلب', en: 'An explicit approval matches this exact request', severity: 'block' },
  { id: 'version_fresh', ar: 'رقم الإصدار غير منشور ولا مجمّد', en: 'The version is neither published nor immutable', severity: 'block' },
  { id: 'capability_wired', ar: 'صلاحية النشر موصولة في المنصة', en: 'The publish capability is wired', severity: 'owner' },
  { id: 'ledger_intact', ar: 'سجل النشر سليم', en: 'The publish ledger is intact', severity: 'block' }
]);

const RULE = Object.fromEntries(RULES.map((rule) => [rule.id, rule]));

/** The exact request that an approval is bound to: change this and the approval stops matching. */
export function publishRequest({ channel = 'production', version, commit, artifacts = [] }) {
  const body = { channel, version, commit, artifacts };
  const fingerprint = `pub:${hashOf(body).slice(0, 16)}`;
  return { ...body, fingerprint };
}

const blocker = (rule, detail, fix) => ({
  rule,
  severity: RULE[rule].severity,
  ar: RULE[rule].ar,
  en: RULE[rule].en,
  detail,
  fix
});

/**
 * Decide, never act. `snapshot` carries what the world says; the gate only compares it with the
 * rules. Every missing field is treated as unknown and reported, never assumed good.
 */
export function evaluatePublish(snapshot = {}) {
  const {
    request,
    branch = {},
    commits = [],
    checks,
    protection = {},
    approvals = [],
    release = {},
    grant = {},
    ledger = []
  } = snapshot;

  const blockers = [];
  const satisfied = [];
  const pass = (rule) => satisfied.push(rule);

  // 1. Evidence present: without a checks snapshot nothing can be called green.
  if (!checks) {
    blockers.push(blocker('evidence_present', 'no checks snapshot was supplied', 'provide the required checks and their conclusions'));
  } else pass('evidence_present');

  // 1b. Protection rules present: absent rules are unknown, and unknown is not "allowed".
  if (protection.known !== true) {
    blockers.push(blocker('protection_known', 'the protection rules were not read, so no rule can be waived', 'read the branch ruleset and pass it in the snapshot'));
  } else pass('protection_known');

  // 2. Clean tree.
  if (branch.clean !== true) blockers.push(blocker('worktree_clean', `worktree clean = ${branch.clean}`, 'commit or stash the pending changes'));
  else pass('worktree_clean');

  // 3. Something to publish.
  if (!(branch.ahead > 0)) blockers.push(blocker('branch_ahead', `ahead = ${branch.ahead}`, 'there is nothing new to publish'));
  else pass('branch_ahead');

  // 4. Branch current with its base.
  if (branch.behind > 0) blockers.push(blocker('branch_current', `behind = ${branch.behind}`, 'rebase on the base branch before publishing'));
  else pass('branch_current');

  // 5. Required checks.
  if (checks) {
    const required = checks.filter((check) => check.required !== false);
    const failed = required.filter((check) => check.conclusion !== 'success');
    if (failed.length) {
      blockers.push(blocker('required_checks', `${failed.length} of ${required.length} required checks are not success: ${failed.map((check) => `${check.name}=${check.conclusion}`).join(', ')}`, 'fix the failing checks; a skipped required check is not a pass'));
    } else pass('required_checks');
  }

  // 6. Signatures, when the protection rule demands them. The gate never signs and never bypasses.
  if (protection.requiredSignatures) {
    const unsigned = commits.filter((commit) => !commit.signed);
    if (unsigned.length) {
      blockers.push(blocker('signatures', `${unsigned.length} of ${commits.length} commits are unsigned (${unsigned.map((commit) => commit.sha.slice(0, 7)).join(', ')})`, 'the owner merges with a signed commit, or the branch is re-pushed with signed commits; the gate will not waive this'));
    } else pass('signatures');
  } else pass('signatures');

  // 7. Review requirements: required approvals, code-owner review, resolved threads.
  const requiredApprovals = protection.requiredApprovals ?? 0;
  const reviewProblems = [];
  const approvedByOthers = approvals.filter((approval) => approval.decision === 'approved').length;
  if (approvedByOthers < requiredApprovals) reviewProblems.push(`${approvedByOthers}/${requiredApprovals} approvals`);
  if (protection.requireCodeOwnerReview && !approvals.some((approval) => approval.decision === 'approved' && approval.codeOwner === true)) reviewProblems.push('code-owner review missing');
  if (protection.requiredThreadResolution && approvals.some((approval) => approval.threadOpen === true)) reviewProblems.push('an open review thread remains');
  if (reviewProblems.length) blockers.push(blocker('review_requirements', reviewProblems.join('; '), 'the owner or a second reviewer completes the required review; the gate cannot self-approve'));
  else pass('review_requirements');

  // 8. Approval bound to the exact request fingerprint.
  if (!request?.fingerprint) {
    blockers.push(blocker('approval_bound', 'the publish request carries no fingerprint', 'build the request with publishRequest()'));
  } else {
    const rejected = approvals.find((approval) => approval.decision === 'rejected' && approval.fingerprint === request.fingerprint);
    const bound = approvals.find((approval) => approval.decision === 'approved' && approval.fingerprint === request.fingerprint);
    const stale = approvals.find((approval) => approval.decision === 'approved' && approval.fingerprint && approval.fingerprint !== request.fingerprint);
    if (rejected) blockers.push(blocker('approval_bound', 'this exact request was rejected', 'a new request needs a new approval'));
    else if (stale && !bound) blockers.push(blocker('approval_bound', `an approval exists for ${stale.fingerprint}, not for ${request.fingerprint}`, 'the request changed after approval; ask again for this fingerprint'));
    else if (!bound) blockers.push(blocker('approval_bound', `no approval for ${request.fingerprint}`, 'the owner approves this fingerprint explicitly'));
    else pass('approval_bound');
  }

  // 9. Version freshness: an immutable or already-published version is not republished.
  const published = Array.isArray(release.publishedVersions) ? release.publishedVersions : [];
  const immutable = Array.isArray(release.immutableVersions) ? release.immutableVersions : [];
  if (release.known !== true) {
    blockers.push(blocker('version_fresh', 'the release state was not read, so "not published" cannot be claimed', 'read the published and immutable versions and pass them in the snapshot'));
  } else if (!request?.version) blockers.push(blocker('version_fresh', 'the request carries no version', 'set the version being published'));
  else if (published.includes(request.version) || immutable.includes(request.version)) {
    blockers.push(blocker('version_fresh', `${request.version} is already published or immutable`, 'publish a new version (this repository freezes published releases)'));
  } else pass('version_fresh');

  // 10. The capability must exist in the access policy and be wired before anyone says "publish".
  if (grant.wired !== true) {
    blockers.push(blocker('capability_wired', `grant ${grant.id || '(none)'} wired = ${grant.wired}`, 'the owner enables the publish capability for the actor that runs it')); 
  } else pass('capability_wired');

  // 11. The ledger must be an intact hash chain — a rewritten history is not a history.
  const chain = verifyLedger(ledger);
  if (!chain.ok) blockers.push(blocker('ledger_intact', `ledger broken at entry ${chain.index}: ${chain.reason}`, 'restore the ledger to its committed form'));
  else pass('ledger_intact');

  const verdict = blockers.some((item) => item.severity === 'block')
    ? VERDICT.blocked
    : blockers.length
      ? VERDICT.needsOwner
      : VERDICT.ready;

  const required = (checks ?? []).filter((check) => check.required !== false);
  return {
    gate: PUBLISH_GATE_VERSION,
    verdict,
    request: request ?? null,
    blockers,
    satisfied,
    summary: {
      checkedRules: RULES.length,
      satisfiedRules: satisfied.length,
      requiredChecks: required.length,
      failedChecks: required.filter((check) => check.conclusion !== 'success').length,
      commits: commits.length,
      unsignedCommits: commits.filter((commit) => !commit.signed).length,
      approvals: approvals.filter((approval) => approval.decision === 'approved').length
    },
    next: blockers.map((item) => item.fix)
  };
}

const GENESIS = `genesis:${PUBLISH_GATE_VERSION}`;

/** What the chain hashes: everything except the hash itself. */
function entryMaterial(entry) {
  const { entryHash: _ignored, ...rest } = entry;
  return rest;
}

export function ledgerEntryHash(entry) {
  return hashOf(entryMaterial(entry));
}

/**
 * Append one event to the ledger. Pure: returns the new array, writes nothing. The chain makes
 * deletion or rewriting visible, which is the point of a deploy history.
 */
export function appendLedgerEvent(entries = [], event) {
  const previous = entries[entries.length - 1];
  const entry = {
    seq: entries.length,
    prevHash: previous ? previous.entryHash : GENESIS,
    at: event.at,
    actor: event.actor,
    action: event.action,
    channel: event.channel,
    version: event.version,
    commit: event.commit,
    requestFingerprint: event.requestFingerprint,
    outcome: event.outcome,
    evidence: event.evidence ?? null
  };
  return [...entries, { ...entry, entryHash: ledgerEntryHash(entry) }];
}

/** Recompute the whole chain and name the first entry that does not fit. */
export function verifyLedger(entries = []) {
  let prevHash = GENESIS;
  for (const [index, entry] of entries.entries()) {
    if (entry.seq !== index) return { ok: false, index, reason: `seq ${entry.seq} != ${index}` };
    if (entry.prevHash !== prevHash) return { ok: false, index, reason: 'prevHash does not match the previous entry' };
    if (entry.entryHash !== ledgerEntryHash(entry)) return { ok: false, index, reason: 'entryHash does not match its content' };
    prevHash = entry.entryHash;
  }
  return { ok: true, index: entries.length, reason: 'chain intact' };
}

/**
 * The way back: the most recent successful publish of a different version. If the ledger is empty
 * the gate says so instead of inventing a target.
 */
export function rollbackTarget(entries = [], { fromVersion } = {}) {
  const published = entries.filter((entry) => entry.outcome === 'published' && entry.version && entry.version !== fromVersion);
  const last = published[published.length - 1];
  return last ? { version: last.version, commit: last.commit, at: last.at, entryHash: last.entryHash } : null;
}
