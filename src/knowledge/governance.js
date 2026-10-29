/**
 * Knowledge-claim governance shared by registry ingestion, retrieval and the
 * provider-planner tool boundary. These are data labels, never permissions to
 * execute a tool or proof that a statement is true.
 */
export const CLAIM_TYPES = Object.freeze([
  'operational_guidance',
  'historical_report',
  'unverified_recommendation',
  'deprecated_security_practice'
]);

export const PLANNER_KB_POLICY = Object.freeze({
  profile: 'planner-safe-v1',
  kind: 'doc',
  claimTypes: Object.freeze(['operational_guidance']),
  trust: Object.freeze(['T1', 'T2']),
  reviewRequired: true
});

const REVIEW_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?$/;

/** Reject normalized-but-impossible dates instead of letting Date.parse roll them over. */
export function isValidReviewDate(value) {
  const raw = String(value ?? '');
  if (!REVIEW_DATE.test(raw)) return false;
  const datePart = raw.slice(0, 10);
  const date = new Date(`${datePart}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== datePart) return false;
  if (raw.length === 10) return true;
  const normalized = raw.replace(' ', 'T');
  return Number.isFinite(Date.parse(normalized.endsWith('Z') ? normalized : `${normalized}Z`));
}

/** Date-only review deadlines remain valid through that UTC day. */
export function reviewStatus(reviewDue, now = Date.now()) {
  if (!reviewDue) return 'missing';
  const raw = String(reviewDue);
  if (!isValidReviewDate(raw)) return 'invalid';
  const value = raw.length === 10
    ? `${raw}T23:59:59.999Z`
    : (raw.replace(' ', 'T').endsWith('Z') ? raw.replace(' ', 'T') : `${raw.replace(' ', 'T')}Z`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'invalid';
  return timestamp >= Number(now) ? 'current' : 'expired';
}

/**
 * Return all refusal reasons instead of letting a caller mistake a missing
 * label for an eligible operational document. Supports DB snake_case and API
 * camelCase shapes at the boundary.
 */
export function plannerEligibility(item, now = Date.now()) {
  const claimType = item?.claimType ?? item?.claim_type ?? null;
  const reviewDue = item?.reviewDue ?? item?.review_due ?? null;
  const status = reviewStatus(reviewDue, now);
  const reasons = [];
  if (item?.kind !== PLANNER_KB_POLICY.kind) reasons.push('kind_not_document');
  if (!PLANNER_KB_POLICY.claimTypes.includes(claimType)) reasons.push('claim_type_not_operational');
  if (!PLANNER_KB_POLICY.trust.includes(item?.trust)) reasons.push('trust_not_planner_allowed');
  if (status !== 'current') reasons.push(`review_${status}`);
  return { eligible: reasons.length === 0, reviewStatus: status, reasons };
}
