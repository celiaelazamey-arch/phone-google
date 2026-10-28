/**
 * The decision gate. Confidence alone never authorises a change — the mode, the allowlist, the injection scan and
 * the daily cap each get a veto, and the first one to fire is the reason the audit records.
 *
 * Order matters and is asserted by tests: a high-confidence proposal that arrives in `propose` mode, or carrying
 * an instruction payload, or on a repository that already hit its cap, is routed to a human. The gate never
 * upgrades a decision; it can only ever downgrade one.
 */
import { ALLOWED_LABELS, ASSIGNEE_ALLOWLIST, DAILY_AUTO_APPLY_CAP, THRESHOLDS } from './policy.js';

export const ROUTES = Object.freeze({ auto: 'auto', human: 'human', reject: 'reject' });

/**
 * @param {object} input
 * @param {{type: string|null, priority: string, labels: string[], confidence: number, reasons: string[]}} input.proposal
 * @param {{tainted: boolean, ruleIds?: string[]}} [input.injection]
 * @param {'propose'|'cautious'} [input.mode]
 * @param {number} [input.dailyAutoApplied] auto-applied decisions already recorded today
 * @param {string[]} [input.assigneeAllowlist]
 */
export function decide({
  proposal,
  injection = { tainted: false },
  mode = 'propose',
  dailyAutoApplied = 0,
  assigneeAllowlist = ASSIGNEE_ALLOWLIST,
  proposedAssignee = null
} = {}) {
  const reasons = [];
  const wanted = Array.isArray(proposal?.labels) ? proposal.labels : [];
  const refusedLabels = wanted.filter((label) => !ALLOWED_LABELS.has(label));
  const allowedLabels = wanted.filter((label) => ALLOWED_LABELS.has(label));
  const assigneeAllowed = proposedAssignee && assigneeAllowlist.includes(proposedAssignee);
  const assigneeRefused = Boolean(proposedAssignee) && !assigneeAllowed;

  const reject = (reason) => ({ route: ROUTES.reject, labels: [], assignee: null, refusedLabels, reasons: [...reasons, reason] });
  const human = (reason) => ({ route: ROUTES.human, labels: [], assignee: null, refusedLabels, reasons: [...reasons, reason] });

  if (!proposal?.type) return reject('no recognised type: nothing to apply and nothing to guess');
  if (proposal.confidence < THRESHOLDS.human) {
    return reject(`confidence ${proposal.confidence.toFixed(2)} < human floor ${THRESHOLDS.human}: proposal dropped, issue untouched`);
  }
  if (mode === 'propose') return human('mode propose: recommendation recorded for a human, no issue change');
  if (injection?.tainted) {
    return human(`untrusted instructions in issue text (${(injection.ruleIds || []).join(', ')}): human review required`);
  }
  if (refusedLabels.length) {
    return human(`label outside the closed vocabulary: ${refusedLabels.join(', ')}`);
  }
  if (assigneeRefused) return human(`assignee ${proposedAssignee} is not on the allowlist`);
  if (dailyAutoApplied >= DAILY_AUTO_APPLY_CAP) {
    return human(`daily auto-apply cap reached (${dailyAutoApplied}/${DAILY_AUTO_APPLY_CAP}): remaining proposals wait for a human`);
  }
  if (proposal.confidence < THRESHOLDS.auto) {
    return human(`confidence ${proposal.confidence.toFixed(2)} is in the human band (${THRESHOLDS.human}–${THRESHOLDS.auto})`);
  }

  reasons.push(`confidence ${proposal.confidence.toFixed(2)} ≥ ${THRESHOLDS.auto}, mode ${mode}, allowlisted labels only`);
  return { route: ROUTES.auto, labels: allowedLabels, assignee: assigneeAllowed ? proposedAssignee : null, refusedLabels, reasons };
}

/** What the loop is allowed to write, in one place, so the CLI cannot invent a second write path. */
export function plannedEffects(decision, proposal) {
  const effects = [];
  if (decision.route === ROUTES.auto) {
    for (const label of decision.labels) effects.push({ effect: 'labels', value: label });
    if (decision.assignee) effects.push({ effect: 'assignee', value: decision.assignee });
    effects.push({ effect: 'comment', value: 'decision-record' });
  } else if (decision.route === ROUTES.human) {
    effects.push({ effect: 'comment', value: 'recommendation' });
  }
  void proposal;
  return effects;
}
