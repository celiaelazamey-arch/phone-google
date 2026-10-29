/**
 * Reply truncation metrics (WP-1.4, DEC-050).
 *
 * Two facts decide whether a generated WhatsApp reply reached the customer whole:
 *   1. the model stopped because it hit `maxOutputTokens` (Gemini `finishReason: "MAX_TOKENS"`), or
 *   2. the runtime cut the candidate to `REPLY_CHAR_CAP` characters before sending.
 * Both are observed, never estimated. Each generated reply writes one row to `whatsapp_reply_metrics`
 * keyed by the outbound provider message id, and the summary turns the rows into a ratio the owner can
 * read before changing `maxOutputTokens`. Counts and reasons only — no text, no phone numbers.
 *
 * The pure classifier is mirrored in `src/reply-metrics.js` for the Express engine (the Docker image does
 * not ship `workers/`); `test/edge-reply-metrics.test.js` proves both copies agree on the same fixtures.
 */

export const REPLY_CHAR_CAP = 1000;
export const TRUNCATION_REASON = Object.freeze({ maxTokens: 'max_tokens', charCap: 'char_cap', both: 'max_tokens+char_cap' });

/** @returns {{ truncated: boolean, reason: string|null, finishReason: string|null, candidateChars: number, sentChars: number }} */
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

function isD1Bound(env) {
  return Boolean(env?.DB && typeof env.DB.prepare === 'function');
}

/**
 * Stores one metric row. Never throws: a metrics failure must not break the reply path, so the caller gets
 * `{ ok: false, reason }` and the reply still goes out.
 */
export async function recordReplyMetric(env, {
  providerMessageId,
  source,
  provider,
  model = null,
  finishReason = null,
  candidateChars,
  sentChars,
  truncated,
  truncationReason = null,
  maxOutputTokens = null,
  at = new Date().toISOString()
} = {}) {
  if (!isD1Bound(env)) return { ok: false, reason: 'd1_not_bound' };
  if (!providerMessageId || !source || !provider) return { ok: false, reason: 'missing_fields' };
  if (!Number.isInteger(candidateChars) || !Number.isInteger(sentChars)) return { ok: false, reason: 'missing_counts' };
  try {
    const result = await env.DB
      .prepare(
        'INSERT OR IGNORE INTO whatsapp_reply_metrics (provider_message_id, source, provider, model, finish_reason, candidate_chars, sent_chars, truncated, truncation_reason, max_output_tokens, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        String(providerMessageId).slice(0, 191),
        String(source).slice(0, 32),
        String(provider).slice(0, 64),
        model ? String(model).slice(0, 128) : null,
        finishReason ? String(finishReason).slice(0, 64) : null,
        candidateChars,
        sentChars,
        truncated ? 1 : 0,
        truncationReason ? String(truncationReason).slice(0, 64) : null,
        Number.isInteger(maxOutputTokens) ? maxOutputTokens : null,
        at
      )
      .run();
    const changes = result?.meta?.changes;
    return { ok: true, inserted: typeof changes === 'number' ? changes > 0 : true };
  } catch (error) {
    return { ok: false, reason: 'metrics_write_failed', detail: String(error?.message || error).slice(0, 160) };
  }
}

const ratio = (part, whole) => (whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : null);

/**
 * The number the owner needs before touching `maxOutputTokens`: how many replies were cut, by which reason,
 * per provider, over a window (default 30 days). `null` ratios mean "no replies measured yet" — never 0.
 */
export async function summarizeReplyMetrics(env, { sinceDays = 30, now = () => new Date() } = {}) {
  if (!isD1Bound(env)) return { ok: false, reason: 'd1_not_bound' };
  const days = Number.isFinite(Number(sinceDays)) && Number(sinceDays) > 0 ? Math.min(Number(sinceDays), 365) : 30;
  const since = new Date(now().getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    const totals = await env.DB
      .prepare(
        'SELECT COUNT(*) AS replies, COALESCE(SUM(truncated), 0) AS truncated, MAX(created_at) AS last_at, MAX(candidate_chars) AS max_candidate_chars ' +
          'FROM whatsapp_reply_metrics WHERE created_at >= ?'
      )
      .bind(since)
      .first();
    const byReason = await env.DB
      .prepare('SELECT truncation_reason AS reason, COUNT(*) AS n FROM whatsapp_reply_metrics WHERE created_at >= ? AND truncated = 1 GROUP BY truncation_reason')
      .bind(since)
      .all();
    const byProvider = await env.DB
      .prepare(
        'SELECT provider, source, COUNT(*) AS replies, COALESCE(SUM(truncated), 0) AS truncated FROM whatsapp_reply_metrics WHERE created_at >= ? GROUP BY provider, source'
      )
      .bind(since)
      .all();
    const replies = Number(totals?.replies || 0);
    const truncated = Number(totals?.truncated || 0);
    return {
      ok: true,
      since,
      windowDays: days,
      replies,
      truncated,
      truncatedRatio: ratio(truncated, replies),
      byReason: Object.fromEntries((byReason?.results || []).map((row) => [row.reason, Number(row.n)])),
      byProvider: (byProvider?.results || []).map((row) => ({
        provider: row.provider,
        source: row.source,
        replies: Number(row.replies),
        truncated: Number(row.truncated),
        truncatedRatio: ratio(Number(row.truncated), Number(row.replies))
      })),
      maxCandidateChars: totals?.max_candidate_chars == null ? null : Number(totals.max_candidate_chars),
      lastAt: totals?.last_at || null
    };
  } catch (error) {
    return { ok: false, reason: 'metrics_unavailable', detail: String(error?.message || error).slice(0, 160) };
  }
}
