/**
 * Deterministic classifier: title + body in, a proposal and a confidence out.
 *
 * No model is called. A rule-based scorer is used on purpose — the decision to relabel someone's issue must be
 * reproducible from the text alone, reviewable in a diff, and testable to the boundary. The same input always
 * produces the same confidence, which is what makes the 0.90 threshold meaningful.
 */
import { LABELS, PRIORITY_SIGNALS, TYPE_SIGNALS, TYPE_TO_PRIORITY, THRESHOLDS } from './policy.js';
import { normalize } from './text.js';

const TITLE_WEIGHT = 2;
const BODY_WEIGHT = 1;
const MAX_EVIDENCE = 5;

function scoreType(text, terms, weight) {
  const hits = [];
  for (const term of terms) {
    const needle = normalize(term);
    if (!needle) continue;
    const occurrence = text.split(needle).length - 1;
    if (occurrence > 0) hits.push({ term, weight: weight * Math.min(occurrence, 2) });
  }
  return hits;
}

/**
 * Untrusted instruction payloads are scrubbed before they reach this function (see `scanForInjection`), so a
 * report cannot raise its own confidence by writing "deploy to main" or "ignore the rules".
 *
 * @param {{title?: string, body?: string}} input
 * @returns {{type: string|null, priority: string, confidence: number, labels: string[], reasons: string[],
 *   evidence: {best: number, margin: number, terms: string[], ambiguous: boolean}}}
 */
export function classifyIssue({ title = '', body = '' } = {}) {
  const titleText = normalize(title);
  const bodyText = normalize(body);
  const reasons = [];

  const perType = {};
  for (const [type, signals] of Object.entries(TYPE_SIGNALS)) {
    const strong = [
      ...scoreType(titleText, signals.strong, TITLE_WEIGHT),
      ...scoreType(bodyText, signals.strong, BODY_WEIGHT)
    ];
    const weak = [
      ...scoreType(titleText, signals.weak, TITLE_WEIGHT),
      ...scoreType(bodyText, signals.weak, BODY_WEIGHT)
    ];
    // A strong term is worth three points, a weak one one: "crash" in a title is evidence, "error" is a hint.
    const score = strong.reduce((sum, hit) => sum + hit.weight * 3, 0) + weak.reduce((sum, hit) => sum + hit.weight, 0);
    perType[type] = { score: Math.min(score, MAX_EVIDENCE * 3), strong, weak };
  }

  const ranked = Object.entries(perType).sort((a, b) => b[1].score - a[1].score);
  const [bestType, best] = ranked[0];
  const second = ranked[1]?.[1]?.score ?? 0;
  const margin = best.score - second;

  let confidence;
  if (best.score === 0) {
    confidence = 0.35;
    reasons.push('no recognised signal: the text names no failure, request, doc gap, question or security term');
  } else {
    confidence = 0.55 + 0.065 * Math.min(best.score / 3, MAX_EVIDENCE);
    if (margin >= 3) confidence += 0.06;
    else if (margin >= 1) confidence += 0.03;
    if (margin < 1 && second > 0) {
      confidence -= 0.1;
      reasons.push(`ambiguous: ${bestType} (${best.score.toFixed(1)}) and ${ranked[1][0]} (${second.toFixed(1)}) are tied`);
    }
    const words = (bodyText ? bodyText.split(' ').length : 0) + (titleText ? titleText.split(' ').length : 0);
    if (words < 5) {
      confidence -= 0.15;
      reasons.push('insufficient detail: fewer than five words to judge');
    }
    const topTerms = [...best.strong, ...best.weak].slice(0, 4).map((hit) => hit.term);
    reasons.push(`type:${bestType} ← ${topTerms.join(', ') || 'no term'}`);
  }

  confidence = Math.max(0, Math.min(0.99, Math.round(confidence * 100) / 100));

  const type = best.score === 0 ? null : bestType;
  const priority = pickPriority({ type, titleText, bodyText, best });

  const labels = [];
  if (type) labels.push(LABELS.type[type]);
  labels.push(LABELS.priority[priority]);

  reasons.push(`priority:${priority} ← ${PRIORITY_SIGNALS[priority]?.find((term) => `${titleText} ${bodyText}`.includes(normalize(term))) || 'type default'}`);
  reasons.push(
    `confidence ${confidence.toFixed(2)} against thresholds auto≥${THRESHOLDS.auto} human≥${THRESHOLDS.human}`
  );

  return {
    type,
    priority,
    confidence,
    labels,
    reasons,
    evidence: {
      best: Math.round(best.score * 10) / 10,
      margin: Math.round(margin * 10) / 10,
      terms: [...best.strong, ...best.weak].slice(0, 6).map((hit) => hit.term),
      ambiguous: margin < 1 && second > 0
    }
  };
}

function pickPriority({ type, titleText, bodyText, best }) {
  const haystack = `${titleText} ${bodyText}`;
  const any = (list) => list.some((term) => haystack.includes(normalize(term)));
  if (any(PRIORITY_SIGNALS.critical)) return 'critical';
  if (any(PRIORITY_SIGNALS.high) && ['low', 'medium'].includes(TYPE_TO_PRIORITY[type] || 'medium')) return 'high';
  if (type && best.score > 0) return TYPE_TO_PRIORITY[type] || 'medium';
  return 'medium';
}
