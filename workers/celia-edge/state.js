/**
 * Durable state for the edge worker (DEC-035).
 *
 * Why this exists: the worker used to answer `/readyz` with `storage.mode: "cloudflare-edge"` and
 * `durable: false` — an honest admission that nothing it served survived a restart. Render cannot host the
 * Express + MySQL backend without a card authorization (DEC-034), so the durable path is D1, which is part of
 * the free Cloudflare plan the owner already has.
 *
 * The rule this file enforces is the same one the rest of the repo lives by: never claim durability that was
 * not just proven. `probeDurability` writes a token and reads it back on every call; only an exact match with a
 * fresh token counts. A bound-but-broken D1 reports `durable: false` with the reason, not a guess.
 *
 * Every written key is recorded in an append-only audit chain (`edge_audit`), so a state change can be
 * reconstructed and tampering is detectable: each row hashes the previous row's hash with its own content.
 */

export const STATE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_STATE_VALUE_BYTES = 4096;
export const AUDIT_ORIGIN = 'genesis';

/** True when the worker has a D1 binding it can actually query. */
export function isD1Bound(env) {
  return Boolean(env?.DB && typeof env.DB.prepare === 'function');
}

export function normaliseKey(raw) {
  const key = String(raw ?? '').trim().toLowerCase();
  return STATE_KEY_PATTERN.test(key) ? key : null;
}

export function serialiseValue(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_STATE_VALUE_BYTES) {
    return { ok: false, error: 'value_too_large', bytes, limit: MAX_STATE_VALUE_BYTES };
  }
  return { ok: true, text, bytes };
}

export async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(input)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Writes a fresh token and reads it back. `durable: true` requires an exact round-trip; anything else — no
 * binding, a thrown query, a mismatched read — is reported as false with the reason attached.
 */
export async function probeDurability(env, { now = () => new Date(), token = null } = {}) {
  if (!isD1Bound(env)) {
    return { mode: 'cloudflare-edge', durable: false, reason: 'd1_not_bound', checkedAt: now().toISOString() };
  }
  const expected = token || `probe-${crypto.randomUUID()}`;
  const at = now().toISOString();
  const started = Date.now();
  try {
    await env.DB
      .prepare('INSERT INTO edge_heartbeat (key, token, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET token = excluded.token, updated_at = excluded.updated_at')
      .bind('readiness', expected, at)
      .run();
    const row = await env.DB.prepare('SELECT token, updated_at FROM edge_heartbeat WHERE key = ?').bind('readiness').first();
    if (!row || row.token !== expected) {
      return { mode: 'cloudflare-edge', durable: false, reason: 'd1_roundtrip_mismatch', checkedAt: at, latencyMs: Date.now() - started };
    }
    return {
      mode: 'd1',
      durable: true,
      checkedAt: at,
      writtenAt: row.updated_at || at,
      latencyMs: Date.now() - started,
      durabilityVerifiedBy: 'this endpoint: write + read-back of a fresh token'
    };
  } catch (error) {
    return {
      mode: 'cloudflare-edge',
      durable: false,
      reason: `d1_probe_failed:${String(error?.message || error).slice(0, 120)}`,
      checkedAt: at,
      latencyMs: Date.now() - started
    };
  }
}

/** The store exposed to the worker routes; every method refuses to run without a D1 binding. */
export function createStateStore(env, { now = () => new Date() } = {}) {
  const requireDb = () => {
    if (!isD1Bound(env)) {
      const error = new Error('d1_not_bound');
      error.code = 'd1_not_bound';
      throw error;
    }
    return env.DB;
  };

  return {
    async get(rawKey) {
      const key = normaliseKey(rawKey);
      if (!key) return { ok: false, error: 'invalid_key' };
      const row = await requireDb()
        .prepare('SELECT key, value, updated_at, revision FROM edge_state WHERE key = ?')
        .bind(key)
        .first();
      if (!row) return { ok: false, error: 'not_found', key };
      return { ok: true, key, value: row.value, updatedAt: row.updated_at, revision: row.revision };
    },

    async put(rawKey, value, { action = 'set' } = {}) {
      const key = normaliseKey(rawKey);
      if (!key) return { ok: false, error: 'invalid_key' };
      const serialised = serialiseValue(value);
      if (!serialised.ok) return serialised;
      const db = requireDb();
      const at = now().toISOString();
      await db
        .prepare('INSERT INTO edge_state (key, value, updated_at, revision) VALUES (?, ?, ?, 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, revision = edge_state.revision + 1')
        .bind(key, serialised.text, at)
        .run();
      const stored = await db.prepare('SELECT revision FROM edge_state WHERE key = ?').bind(key).first();
      const audit = await appendAudit(env, { key, action, valueHash: await sha256Hex(serialised.text), at });
      return { ok: true, key, bytes: serialised.bytes, updatedAt: at, revision: stored?.revision ?? null, audit };
    },

    async list({ limit = 50 } = {}) {
      const capped = Math.min(Math.max(Number(limit) || 50, 1), 200);
      const result = await requireDb()
        .prepare('SELECT key, updated_at, revision FROM edge_state ORDER BY key LIMIT ?')
        .bind(capped)
        .all();
      const rows = Array.isArray(result?.results) ? result.results : [];
      return { ok: true, count: rows.length, keys: rows };
    },

    async audit({ limit = 100 } = {}) {
      const capped = Math.min(Math.max(Number(limit) || 100, 1), 500);
      const result = await requireDb()
        .prepare('SELECT seq, at, key, action, value_hash, prev_hash, hash FROM edge_audit ORDER BY seq ASC LIMIT ?')
        .bind(capped)
        .all();
      const rows = Array.isArray(result?.results) ? result.results : [];
      return { ok: true, count: rows.length, chain: await verifyAuditChain(rows), rows };
    }
  };
}

/** Appends one link to the audit chain. The hash covers the previous hash, the timestamp and the content. */
export async function appendAudit(env, { key, action, valueHash, at }) {
  if (!isD1Bound(env)) return { ok: false, error: 'd1_not_bound' };
  const previous = await env.DB.prepare('SELECT hash FROM edge_audit ORDER BY seq DESC LIMIT 1').first();
  const prevHash = previous?.hash || AUDIT_ORIGIN;
  const hash = await sha256Hex([prevHash, at, key, action, valueHash].join('|'));
  await env.DB
    .prepare('INSERT INTO edge_audit (at, key, action, value_hash, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(at, key, action, valueHash, prevHash, hash)
    .run();
  return { ok: true, prevHash, hash };
}

/** Recomputes the chain. Any edited or reordered row breaks it, and the first broken link is named. */
export async function verifyAuditChain(rows) {
  let prevHash = AUDIT_ORIGIN;
  for (const [index, row] of (rows || []).entries()) {
    if (row.prev_hash !== prevHash) {
      return { ok: false, reason: 'broken_link', atSeq: row.seq ?? index + 1 };
    }
    // The value itself is never stored in the audit table — only its hash — so the chain cannot leak secrets.
    const expected = await sha256Hex([prevHash, row.at, row.key, row.action, row.value_hash ?? ''].join('|'));
    if (row.hash !== expected) {
      return { ok: false, reason: 'hash_mismatch', atSeq: row.seq ?? index + 1 };
    }
    prevHash = row.hash;
  }
  return { ok: true, links: (rows || []).length, head: prevHash };
}
