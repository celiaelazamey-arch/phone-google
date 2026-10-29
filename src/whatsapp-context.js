/**
 * WhatsApp reply context (WP-2.2 / WA-006, DEC-058) — a recent-message window for the same number plus the
 * top knowledge-network results, both behind `CELIA_WA_CONTEXT` (default `off`).
 *
 * Why this file exists: `src/context-policy.js` (WP-2.1) already decides what reaches a model and what is cut,
 * but the WhatsApp auto-reply never handed it any history or knowledge. This module only *collects* candidates
 * from durable sources that already exist; the budget, the priority cuts and the framing stay in the policy.
 *
 * Boundaries that are enforced here, not promised:
 *   - The window is strictly per phone: `WHERE phone_e164 = ?` — two customers can never see each other.
 *   - The message being answered is excluded by its provider id, so it cannot appear twice (history + turn).
 *   - Knowledge is only T1/T2, at most three items, through the planner-safe profile; a store that is off or
 *     unreadable yields zero knowledge items with a named reason instead of an invented answer.
 *   - Nothing here writes, sends or retries: it is a read of local state with no network.
 *
 * What this module deliberately does not do: pick the model, build the prompt, or count the budget. Those remain
 * the context policy's job (`buildContext`), so the flag cannot fork into a second prompt authority.
 */

/** Closed set of accepted flag values; an unknown value fails configuration loudly instead of guessing. */
export const WA_CONTEXT_MODES = Object.freeze(['off', 'on']);

export const WA_CONTEXT_LIMITS = Object.freeze({
  /** Same-number messages considered, newest first (the policy then trims to its 1500-char history cap). */
  historyMessages: 6,
  /** Knowledge items offered to the policy (the WA-006 acceptance says "top three"). */
  knowledgeItems: 3,
  /** Character budget for the knowledge search itself. */
  knowledgeChars: 900,
  /** Per-item snippet ceiling so one long document cannot crowd out the other two. */
  snippetChars: 240,
  /** Per-message ceiling before the policy sees it (the stored body is already capped at 4000). */
  messageChars: 1000
});

export const WA_CONTEXT_SQL = `SELECT direction, body, created_at FROM whatsapp_messages
  WHERE phone_e164 = ? AND provider_message_id <> ? AND body IS NOT NULL
    AND direction IN ('inbound', 'outbound')
  ORDER BY created_at DESC, id DESC
  LIMIT ?`;

/** `CELIA_WA_CONTEXT=on|true` enables; `off|false|''` (default) disables; anything else is a configuration error. */
export function readWaContextMode(env = process.env) {
  const raw = String(env?.CELIA_WA_CONTEXT ?? 'off').trim().toLowerCase();
  if (!raw) return 'off';
  if (raw === 'on' || raw === 'true') return 'on';
  if (raw === 'off' || raw === 'false') return 'off';
  throw new Error('CELIA_WA_CONTEXT must be off or on');
}

export function isWaContextEnabled(env = process.env) {
  return readWaContextMode(env) === 'on';
}

/**
 * Rows arrive newest-first from SQL and leave oldest → newest, which is the order the policy expects.
 * Only text bodies survive; the role is the direction, never an identifier.
 */
export function historyWindow(rows = [], { limit = WA_CONTEXT_LIMITS.historyMessages, messageChars = WA_CONTEXT_LIMITS.messageChars } = {}) {
  if (!Array.isArray(rows)) return [];
  return rows
    .slice(0, limit)
    .filter((row) => row && typeof row.body === 'string' && row.body.trim())
    .map((row) => ({
      role: row.direction === 'outbound' ? 'assistant' : 'customer',
      text: String(row.body).trim().slice(0, messageChars)
    }))
    .reverse();
}

/**
 * Search results → policy knowledge items `{ text, source, tier }`.
 * Only T1/T2 are admitted (WA-006), the order is the store's rank order, and the source marker is the
 * registry id (falling back to the item URI) so every injected line is attributable — never a bare sentence.
 */
export function knowledgeFromSearch(result, { limit = WA_CONTEXT_LIMITS.knowledgeItems, snippetChars = WA_CONTEXT_LIMITS.snippetChars } = {}) {
  const items = Array.isArray(result?.items) ? result.items : [];
  const admitted = [];
  for (const item of items) {
    if (!item || (item.trust !== 'T1' && item.trust !== 'T2')) continue;
    const body = String(item.snippet || '').trim();
    if (!body) continue;
    const title = String(item.title || '').trim();
    const source = String(item.sourceId || item.uri || '').trim().slice(0, 120);
    admitted.push({
      tier: item.trust,
      source,
      text: (title ? `${title}: ${body}` : body).slice(0, snippetChars)
    });
    if (admitted.length >= limit) break;
  }
  return admitted;
}

/**
 * Collects the window and the knowledge pack for one inbound message.
 *
 * Never throws: a failed read is reported as a named reason so the caller can log a safe code and still answer
 * the customer. `failures` is the honest part — an empty `knowledge` array with `failures: ['knowledge_disabled']`
 * means "knowledge is off", not "the KB had nothing to say".
 */
export async function loadWhatsAppContext({
  pool,
  kb = null,
  config,
  phone,
  message = '',
  excludeProviderMessageId = '',
  limits = WA_CONTEXT_LIMITS
} = {}) {
  const enabled = config?.whatsapp?.contextEnabled === true;
  if (!enabled) {
    return { enabled: false, history: [], knowledge: [], reason: 'flag_off', failures: [], counts: { history: 0, knowledge: 0 } };
  }
  const result = { enabled: true, history: [], knowledge: [], reason: null, failures: [], counts: { history: 0, knowledge: 0 } };
  if (pool?.execute) {
    try {
      const [rows] = await pool.execute(WA_CONTEXT_SQL, [phone, excludeProviderMessageId || '', limits.historyMessages]);
      result.history = historyWindow(rows, limits);
    } catch {
      result.failures.push('history_unavailable');
    }
  } else {
    result.failures.push('history_unavailable');
  }
  const query = String(message || '').trim();
  if (query && kb?.search) {
    try {
      const search = await kb.search({
        query,
        limit: Math.min(limits.knowledgeItems, 3),
        maxChars: limits.knowledgeChars,
        minTrust: 'T2',
        profile: 'planner'
      });
      result.knowledge = knowledgeFromSearch(search, limits);
      result.reason = search?.reason || null;
    } catch {
      result.failures.push('knowledge_unavailable');
    }
  } else if (!kb?.search) {
    result.failures.push('knowledge_disabled');
  }
  result.counts = { history: result.history.length, knowledge: result.knowledge.length };
  return result;
}
