/**
 * Conflict detection over knowledge claims (VFE-007 / DEC-095).
 *
 * The owner's first P0 gap: when two sources disagree, the system must say so and name both, not
 * quietly pick one. This module therefore has no notion of a winner. It groups claims by
 * `(subject, predicate)`, compares normalized values, and reports every disagreement with both
 * sources, their declared trust, and when each was observed. Choosing what to believe stays with a
 * human — the machine's job is to make the disagreement impossible to miss.
 *
 * Deliberately absent: majority voting, "latest wins", trust-ranked selection, value averaging.
 * Each of those would be a silent arbitration, which is the failure this capability exists to stop.
 */
import { createHash } from 'node:crypto';

export const CONFLICT_VERSION = 'celiaos-claims-conflict-v1';

/** Latin and Arabic digits map to one form so «٤٢» and «42» cannot look like a conflict. */
const DIGITS = '٠١٢٣٤٥٦٧٨٩';

const stripArabic = (text) =>
  text
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '') // diacritics
    .replace(/\u0640/g, '') // tatweel
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627') // alef forms
    .replace(/\u0649/g, '\u064A') // alef maqsura
    .replace(/[\u0624]/g, '\u0648')
    .replace(/\u0626/g, '\u064A');

const toLatinDigits = (text) => text.replace(/[٠-٩]/g, (digit) => String(DIGITS.indexOf(digit)));

/** One normalization used for keys and values, so comparison never depends on spelling noise. */
export function normalizeText(raw) {
  return toLatinDigits(stripArabic(String(raw ?? '')))
    .toLowerCase()
    .replace(/[\u200B-\u200F\u202A-\u202E]/g, '')
    .replace(/[.,\u060C\u061B;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A claim key is `subject / predicate`, both normalized. */
export function claimKey({ subject, predicate }) {
  return `${normalizeText(subject)}/${normalizeText(predicate)}`;
}

const NUMBER_UNIT = /^([+-]?\d+(?:[.,]\d+)?)\s*([^\d\s].{0,15})?$/;

const UNIT_ALIASES = Object.freeze({
  'كم': 'km',
  'كلم': 'km',
  km: 'km',
  'كجم': 'kg',
  kg: 'kg',
  'غ': 'g',
  g: 'g',
  'م': 'm',
  m: 'm',
  'سم': 'cm',
  cm: 'cm',
  'د': 'min',
  min: 'min',
  'س': 'h',
  h: 'h',
  'ساعة': 'h',
  '%': '%',
  '٪': '%',
  'ريال': 'sar',
  sar: 'sar',
  'جنيه': 'egp',
  egp: 'egp',
  'دولار': 'usd',
  usd: 'usd'
});

/**
 * Value normalization: numbers with a known unit compare as numbers, everything else as text.
 * Unknown units stay literal — guessing a conversion would invent agreement that does not exist.
 */
export function normalizeValue(raw) {
  const text = normalizeText(raw);
  const match = NUMBER_UNIT.exec(text);
  if (!match) return { kind: 'text', value: text, number: null, unit: null };
  const number = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(number)) return { kind: 'text', value: text, number: null, unit: null };
  const unit = match[2] ? UNIT_ALIASES[match[2]] ?? match[2].trim() : '';
  return { kind: 'number', value: `${number}${unit ? ` ${unit}` : ''}`, number, unit };
}

const valuesAgree = (left, right) =>
  left.kind === 'number' && right.kind === 'number'
    ? left.number === right.number && left.unit === right.unit
    : left.value === right.value;

/** Trust labels are evidence, never a tie-breaker. Ordering is only used to print them consistently. */
const TRUST_RANK = Object.freeze({ T0: 0, T1: 1, T2: 2, T3: 3 });
const trustRank = (trust) => TRUST_RANK[String(trust ?? '').toUpperCase()] ?? 9;

/**
 * Extract claims from text. The syntax is deliberately narrow — one claim per line, `subject:
 * value` or `subject = value` — because a loose extractor would invent claims and then "find"
 * conflicts in its own invention.
 */
export function extractClaims(text, { sourceId = 'inline', trust = 'T1', observedAt = null } = {}) {
  const claims = [];
  for (const [index, line] of String(text ?? '').split('\n').entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    const separator = trimmed.search(/[:=]/);
    if (separator < 1) continue;
    const rawSubject = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    const [subject, predicate = 'value'] = rawSubject.split('|').map((part) => part.trim());
    if (!subject || !rawValue) continue;
    claims.push({
      subject,
      predicate,
      value: rawValue,
      sourceId,
      trust,
      observedAt,
      statement: trimmed,
      line: index + 1
    });
  }
  return claims;
}

/** Turn knowledge items into claims, keeping each item's own source and trust. */
export function claimsFromItems(items = []) {
  const claims = [];
  for (const item of items) {
    const sourceId = item.source_id ?? item.sourceId ?? item.source ?? 'unknown';
    const trust = item.trust ?? 'T2';
    const observedAt = item.updated_at ?? item.updatedAt ?? item.last_sync_at ?? null;
    for (const claim of extractClaims(item.body ?? item.text ?? '', { sourceId, trust, observedAt })) {
      claims.push({ ...claim, itemId: item.id ?? null, title: item.title ?? null, license: item.license ?? null });
    }
  }
  return claims;
}

const asClaim = (claim, index) => ({
  index,
  subject: String(claim.subject ?? '').trim(),
  predicate: String(claim.predicate ?? 'value').trim(),
  rawValue: String(claim.value ?? '').trim(),
  value: normalizeValue(claim.value),
  sourceId: claim.sourceId ?? claim.source_id ?? 'unknown',
  trust: claim.trust ?? null,
  observedAt: claim.observedAt ?? claim.observed_at ?? null,
  statement: claim.statement ?? null,
  itemId: claim.itemId ?? claim.item_id ?? null,
  title: claim.title ?? null
});

/**
 * Find disagreements. Returns every claim group with more than one distinct normalized value, and
 * explicitly states that none of them has been resolved.
 */
export function findConflicts(claims = []) {
  const groups = new Map();
  const rejected = [];
  claims.map(asClaim).forEach((claim) => {
    if (!claim.subject || !claim.rawValue) {
      rejected.push({ claim, reason: 'empty_subject_or_value' });
      return;
    }
    const key = claimKey(claim);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(claim);
  });

  const conflicts = [];
  for (const [key, group] of groups) {
    const distinct = [];
    for (const claim of group) {
      if (!distinct.some((other) => valuesAgree(other.value, claim.value))) distinct.push(claim);
    }
    if (distinct.length < 2) continue;
    const ordered = [...group].sort(
      (left, right) => trustRank(left.trust) - trustRank(right.trust) || left.index - right.index
    );
    conflicts.push({
      key,
      subject: ordered[0].subject,
      predicate: ordered[0].predicate,
      values: distinct.map((claim) => ({
        value: claim.rawValue,
        normalized: claim.value.value,
        kind: claim.value.kind,
        sourceId: claim.sourceId,
        trust: claim.trust,
        observedAt: claim.observedAt,
        statement: claim.statement,
        itemId: claim.itemId
      })),
      sources: [...new Set(distinct.map((claim) => claim.sourceId))],
      claims: ordered,
      resolution: 'unresolved',
      newestSource: ordered
        .filter((claim) => claim.observedAt)
        .sort((left, right) => String(right.observedAt).localeCompare(String(left.observedAt)))[0] ?? null
    });
  }

  conflicts.sort((left, right) => left.key.localeCompare(right.key));
  return {
    version: CONFLICT_VERSION,
    checked: claims.length,
    rejected: rejected.length,
    groups: groups.size,
    conflicts,
    count: conflicts.length,
    unresolved: conflicts.length,
    /** Stated in the payload so a caller cannot read a winner where none exists. */
    arbitrated: false
  };
}

/** Deterministic digest of the report, so the finding itself can be cited as evidence. */
export function conflictDigest(report) {
  const canonical = JSON.stringify({
    version: report.version,
    conflicts: report.conflicts.map((conflict) => ({
      key: conflict.key,
      values: conflict.values.map((value) => [value.sourceId, value.normalized]),
      resolution: conflict.resolution
    }))
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

/** One line per conflict, in Arabic, naming both sides. Used in answers and in the CLI. */
export function describeConflicts(report) {
  if (!report.count) return [`لا تعارض مقيس بين ${report.checked} ادعاءً.`, `no measured conflict across ${report.checked} claims`];
  const lines = report.conflicts.map((conflict) => {
    const sides = conflict.values.map((value) => `${value.value} (${value.sourceId}${value.trust ? ` · ${value.trust}` : ''})`).join(' ≠ ');
    return `تعارض غير محسوم — ${conflict.subject} / ${conflict.predicate}: ${sides}`;
  });
  return [...lines, `المجموع: ${report.count} تعارضًا غير محسوم من ${report.checked} ادعاءً (${conflictDigest(report)}).`];
}
