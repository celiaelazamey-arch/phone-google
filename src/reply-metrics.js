/**
 * Reply truncation classifier for the Express engine (WP-1.4, DEC-050).
 *
 * Mirror of `workers/celia-edge/reply-metrics.js#classifyReplyTruncation` — the Docker image ships `src/` only,
 * so the two copies must stay identical; `test/edge-reply-metrics.test.js` runs both against the same fixtures.
 * Two observed facts, never an estimate: the model stopped on `maxOutputTokens` (`finishReason: MAX_TOKENS`),
 * or the runtime cut the candidate to `REPLY_CHAR_CAP` characters.
 */
export const REPLY_CHAR_CAP = 1000;
export const TRUNCATION_REASON = Object.freeze({ maxTokens: 'max_tokens', charCap: 'char_cap', both: 'max_tokens+char_cap' });

export function classifyReplyTruncation({ finishReason = null, candidateText = '', charCap = REPLY_CHAR_CAP } = {}) {
  const text = String(candidateText ?? '');
  const candidateChars = text.length;
  const cap = Number.isInteger(charCap) && charCap > 0 ? charCap : REPLY_CHAR_CAP;
  const sentChars = Math.min(candidateChars, cap);
  const normalizedFinish = typeof finishReason === 'string' && finishReason.trim() ? finishReason.trim().toUpperCase() : null;
  const byTokens = normalizedFinish === 'MAX_TOKENS';
  const byChars = candidateChars > cap;
  const reason = byTokens && byChars ? TRUNCATION_REASON.both : byTokens ? TRUNCATION_REASON.maxTokens : byChars ? TRUNCATION_REASON.charCap : null;
  return { truncated: Boolean(reason), reason, finishReason: normalizedFinish, candidateChars, sentChars };
}
