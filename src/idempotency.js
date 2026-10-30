/**
 * Idempotency guard — prevents blind replay of external mutations.
 * In-memory with operation-scope isolation, bounded in-progress lease takeover,
 * and active-claim protection against cache-flood eviction.
 */

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_IN_PROGRESS_TTL_MS = 30_000;
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

function buildStorageKey(key, scope) {
  const cleanKey = key.trim();
  const cleanScope = typeof scope === 'string' ? scope.trim() : '';
  return cleanScope ? `${cleanScope}:${cleanKey}` : cleanKey;
}

/**
 * Create an idempotency store. Pure memory by default.
 */
export function createIdempotencyStore({
  ttlMs = DEFAULT_TTL_MS,
  inProgressTtlMs = DEFAULT_IN_PROGRESS_TTL_MS,
  maxEntries = MAX_ENTRIES,
  now = Date.now
} = {}) {
  const store = new Map(); // storageKey -> { result, status, claimToken, expiresAt, createdAt }
  let seq = 0;

  function pruneExpired(t = now()) {
    for (const [k, v] of store) {
      if (v.expiresAt <= t) store.delete(k);
    }
  }

  function evictCompletedToFit(targetMax) {
    if (store.size <= targetMax) return;
    let excess = store.size - targetMax;
    for (const [k, v] of store) {
      if (excess <= 0) break;
      if (v.status === 'completed') {
        store.delete(k);
        excess -= 1;
      }
    }
  }

  return {
    /**
     * Check if key was already completed or is actively in progress in `scope`.
     */
    get(key, scope = '') {
      if (!isValidIdempotencyKey(key)) return null;
      const t = now();
      const storageKey = buildStorageKey(key, scope);
      const entry = store.get(storageKey);
      if (!entry) return null;
      if (entry.expiresAt <= t) {
        store.delete(storageKey);
        return null;
      }
      if (entry.status === 'in_progress') {
        return { _idempotencyStatus: 'in_progress', _retryAfterMs: 2000 };
      }
      return cloneResult(entry.result);
    },

    /**
     * Mark key as in-progress before executing side effect.
     * Returns positive numeric claimToken if newly claimed (or reclaimed after stale lease),
     * or `false` if already completed or actively in progress.
     */
    claim(key, scope = '') {
      if (!isValidIdempotencyKey(key)) return false;
      const t = now();
      pruneExpired(t);
      const storageKey = buildStorageKey(key, scope);
      const existing = store.get(storageKey);
      if (existing) {
        if (existing.expiresAt <= t) {
          store.delete(storageKey);
        } else {
          return false;
        }
      }
      evictCompletedToFit(Math.max(0, maxEntries - 1));
      if (store.size >= maxEntries) {
        // Never evict active non-expired in_progress claims under flood pressure.
        return false;
      }
      const claimToken = ++seq;
      store.set(storageKey, {
        status: 'in_progress',
        claimToken,
        createdAt: t,
        expiresAt: t + inProgressTtlMs,
        result: null
      });
      return claimToken;
    },

    /**
     * Store successful result immediately after upstream mutation succeeds.
     * Upserts even if the short in-progress lease elapsed during a slow upstream call.
     */
    complete(key, result, scope = '') {
      if (!isValidIdempotencyKey(key)) return;
      const t = now();
      pruneExpired(t);
      const storageKey = buildStorageKey(key, scope);
      const existing = store.get(storageKey);
      store.set(storageKey, {
        status: 'completed',
        claimToken: existing?.claimToken ?? ++seq,
        createdAt: existing?.createdAt ?? t,
        expiresAt: t + ttlMs,
        result: cloneResult(result)
      });
      evictCompletedToFit(maxEntries);
    },

    /**
     * Release claim on pre-effect failure so caller can retry.
     * Never deletes an already-completed entry or a newer claim holder's token.
     */
    fail(key, scope = '', claimToken = undefined) {
      if (!isValidIdempotencyKey(key)) return;
      const storageKey = buildStorageKey(key, scope);
      const existing = store.get(storageKey);
      if (!existing || existing.status === 'completed') return;
      if (claimToken !== undefined && existing.claimToken !== claimToken) return;
      store.delete(storageKey);
    },

    _size() { return store.size; },
    _entries() { return [...store.entries()]; }
  };
}

function cloneResult(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

/**
 * Helper to extract idempotency key from MCP args or HTTP header.
 */
export function extractIdempotencyKey({ args, headers } = {}) {
  const fromArgs = typeof args?.idempotencyKey === 'string' ? args.idempotencyKey.trim() : '';
  if (isValidIdempotencyKey(fromArgs)) return fromArgs;
  const headerKey = headers?.['idempotency-key'] || headers?.['Idempotency-Key'] || headers?.['IDEMPOTENCY-KEY'];
  if (typeof headerKey === 'string' && isValidIdempotencyKey(headerKey.trim())) return headerKey.trim();
  const alt = typeof args?.idempotency_key === 'string' ? args.idempotency_key.trim() : '';
  if (isValidIdempotencyKey(alt)) return alt;
  return null;
}
