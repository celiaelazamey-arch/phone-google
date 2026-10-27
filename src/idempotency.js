/**
 * Idempotency guard — prevents blind replay of external mutations.
 * In-memory with TTL, ready for durable backing store (operation_outbox).
 * No schema change: if MySQL table operation_idempotency exists, use it; otherwise memory only.
 */

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 2000;

/**
 * Validate client-supplied idempotency key.
 * 8-64 chars, URL-safe. Prevents arbitrary large keys from polluting cache.
 */
export function isValidIdempotencyKey(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(v);
}

/**
 * Create an idempotency store. Pure memory by default.
 * Future: pass { pool } to enable durable check (SELECT from operation_idempotency).
 */
export function createIdempotencyStore({ ttlMs = DEFAULT_TTL_MS, maxEntries = MAX_ENTRIES, now = Date.now } = {}) {
  const store = new Map(); // key -> { result, status, expiresAt, createdAt }

  function prune() {
    const t = now();
    for (const [k, v] of store) {
      if (v.expiresAt <= t) store.delete(k);
    }
    // LRU-ish: if over limit, delete oldest entries
    if (store.size > maxEntries) {
      const excess = store.size - maxEntries;
      let i = 0;
      for (const k of store.keys()) {
        if (i++ >= excess) break;
        store.delete(k);
      }
    }
  }

  return {
    /**
     * Check if key was already completed. Returns stored result or null.
     */
    get(key) {
      if (!isValidIdempotencyKey(key)) return null;
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        store.delete(key);
        return null;
      }
      // If another concurrent execution is in progress, signal to wait/reject
      if (entry.status === 'in_progress') {
        return { _idempotencyStatus: 'in_progress', _retryAfterMs: 2000 };
      }
      return entry.result;
    },

    /**
     * Mark key as in-progress before executing side effect.
     * Returns true if newly claimed, false if already claimed/in_progress.
     */
    claim(key) {
      if (!isValidIdempotencyKey(key)) return false;
      prune();
      const existing = store.get(key);
      if (existing) {
        if (existing.expiresAt <= now()) {
          store.delete(key);
        } else {
          return false; // already has result or in_progress
        }
      }
      store.set(key, {
        status: 'in_progress',
        createdAt: now(),
        expiresAt: now() + ttlMs,
        result: null
      });
      return true;
    },

    /**
     * Store successful result for future replays.
     */
    complete(key, result) {
      if (!isValidIdempotencyKey(key)) return;
      const entry = store.get(key);
      if (!entry) return;
      entry.status = 'completed';
      entry.result = cloneResult(result);
      entry.expiresAt = now() + ttlMs;
    },

    /**
     * Release claim on failure so caller can retry with same or new key.
     * We do NOT cache failures — retry should be explicit.
     */
    fail(key) {
      if (!isValidIdempotencyKey(key)) return;
      store.delete(key);
    },

    /**
     * For testing: size and raw snapshot
     */
    _size() { return store.size; },
    _entries() { return [...store.entries()]; }
  };
}

function cloneResult(value) {
  // Structured clone for JSON-safe results; avoid leaking mutable refs
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

/**
 * Helper to extract idempotency key from MCP args or HTTP header.
 * MCP tools may pass args.idempotencyKey; HTTP may send Idempotency-Key header.
 */
export function extractIdempotencyKey({ args, headers } = {}) {
  const fromArgs = typeof args?.idempotencyKey === 'string' ? args.idempotencyKey.trim() : '';
  if (isValidIdempotencyKey(fromArgs)) return fromArgs;
  const headerKey = headers?.['idempotency-key'] || headers?.['Idempotency-Key'] || headers?.['IDEMPOTENCY-KEY'];
  if (typeof headerKey === 'string' && isValidIdempotencyKey(headerKey.trim())) return headerKey.trim();
  // Also check explicit args.idempotency_key snake_case for compatibility
  const alt = typeof args?.idempotency_key === 'string' ? args.idempotency_key.trim() : '';
  if (isValidIdempotencyKey(alt)) return alt;
  return null;
}
