// Durable edge state (DEC-035). The point of these tests is the honesty rule: `durable: true` is only allowed
// after a fresh token survives a write-and-read-back, and every state write leaves a verifiable hash chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import worker from '../workers/celia-edge/worker.js';
import { createStateStore, probeDurability, verifyAuditChain } from '../workers/celia-edge/state.js';
import { applyMigrations, buildWorkerMetadata, ensureD1Database, splitSqlStatements } from '../scripts/deploy-cloudflare-edge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const OWNER_TOKEN = 'test-owner-token-'.padEnd(48, 'x');

/**
 * Test double for the D1 binding. It interprets exactly the statements `state.js` issues — no more — so a
 * change in the SQL has to be reflected here deliberately instead of silently passing.
 */
function fakeD1({ heartbeat = new Map(), rows = new Map(), audit = [], mismatchToken = false, throwOnPrepare = false } = {}) {
  const db = { heartbeat, rows, audit, seq: audit.length };
  const exec = (sql, params, mode) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (text.startsWith('INSERT INTO edge_heartbeat')) {
      heartbeat.set(params[0], { token: mismatchToken ? 'someone-else' : params[1], updated_at: params[2] });
      return undefined;
    }
    if (text.startsWith('SELECT token, updated_at FROM edge_heartbeat')) {
      return heartbeat.get(params[0]) || null;
    }
    if (text.startsWith('INSERT INTO edge_state')) {
      const previous = rows.get(params[0]);
      rows.set(params[0], { value: params[1], updated_at: params[2], revision: (previous?.revision || 0) + 1 });
      return undefined;
    }
    if (text.startsWith('SELECT revision FROM edge_state')) {
      const row = rows.get(params[0]);
      return row ? { revision: row.revision } : null;
    }
    if (text.startsWith('SELECT key, value, updated_at, revision FROM edge_state')) {
      const row = rows.get(params[0]);
      return row ? { key: params[0], ...row } : null;
    }
    if (text.startsWith('SELECT key, updated_at, revision FROM edge_state ORDER BY')) {
      return [...rows.entries()].sort().slice(0, params[0]).map(([key, row]) => ({ key, updated_at: row.updated_at, revision: row.revision }));
    }
    if (text.startsWith('SELECT hash FROM edge_audit')) {
      return audit.length ? { hash: audit[audit.length - 1].hash } : null;
    }
    if (text.startsWith('INSERT INTO edge_audit')) {
      db.seq += 1;
      audit.push({ seq: db.seq, at: params[0], key: params[1], action: params[2], value_hash: params[3], prev_hash: params[4], hash: params[5] });
      return undefined;
    }
    if (text.startsWith('SELECT seq, at, key, action, value_hash, prev_hash, hash FROM edge_audit')) {
      return audit.slice(0, params[0]);
    }
    throw new Error(`fake D1 does not implement: ${text}`);
  };
  db.prepare = (sql) => {
    if (throwOnPrepare) throw new Error('d1_unavailable');
    let params = [];
    const statement = {
      bind(...args) {
        params = args;
        return statement;
      },
      async run() {
        exec(sql, params, 'run');
        return { success: true };
      },
      async first() {
        return exec(sql, params, 'first');
      },
      async all() {
        return { results: exec(sql, params, 'all') };
      }
    };
    return statement;
  };
  return db;
}

test('durability is never claimed without a bound database', async () => {
  const result = await probeDurability({});
  assert.equal(result.durable, false);
  assert.equal(result.mode, 'cloudflare-edge');
  assert.equal(result.reason, 'd1_not_bound');
});

test('durable:true requires a fresh token to survive the round-trip', async () => {
  const env = { DB: fakeD1() };
  const result = await probeDurability(env);
  assert.equal(result.durable, true);
  assert.equal(result.mode, 'd1');
  assert.match(result.durabilityVerifiedBy, /read-back/);
  assert.equal(typeof result.latencyMs, 'number');
  // A second call writes a new token: the claim is re-earned every time, not cached.
  const again = await probeDurability(env);
  assert.equal(again.durable, true);
  assert.equal(env.DB.heartbeat.get('readiness').token.startsWith('probe-'), true);
});

test('a bound but broken database reports false with the reason, not a guess', async () => {
  const thrown = await probeDurability({ DB: fakeD1({ throwOnPrepare: true }) });
  assert.equal(thrown.durable, false);
  assert.match(thrown.reason, /d1_probe_failed/);
  const mismatched = await probeDurability({ DB: fakeD1({ mismatchToken: true }) });
  assert.equal(mismatched.durable, false);
  assert.equal(mismatched.reason, 'd1_roundtrip_mismatch');
});

test('state writes round-trip, increment the revision and reject bad input', async () => {
  const env = { DB: fakeD1() };
  const store = createStateStore(env);
  assert.deepEqual(await store.put('Bad Key!', 'x'), { ok: false, error: 'invalid_key' });
  assert.equal((await store.put('mode', 'cautious')).revision, 1);
  const second = await store.put('mode', 'propose');
  assert.equal(second.revision, 2);
  const read = await store.get('mode');
  assert.equal(read.value, 'propose');
  assert.equal(read.revision, 2);
  assert.equal((await store.get('missing')).error, 'not_found');
  const huge = await store.put('big', 'x'.repeat(5000));
  assert.equal(huge.error, 'value_too_large');
  const listed = await store.list();
  assert.equal(listed.count, 1, 'the oversized value was rejected, so only `mode` is stored');
});

test('every write lands in a hash chain that detects tampering', async () => {
  const env = { DB: fakeD1() };
  const store = createStateStore(env);
  await store.put('a', 'one');
  await store.put('b', 'two');
  await store.put('a', 'three');
  const audit = await store.audit();
  assert.equal(audit.rows.length, 3);
  assert.equal(audit.chain.ok, true);
  assert.equal(audit.rows[0].prev_hash, 'genesis');
  assert.notEqual(audit.rows[1].prev_hash, audit.rows[0].prev_hash);

  // Editing a stored row in place must break verification at that link.
  const tampered = audit.rows.map((row, index) => (index === 1 ? { ...row, value_hash: 'f'.repeat(64) } : row));
  const verdict = await verifyAuditChain(tampered);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'hash_mismatch');
  assert.equal(verdict.atSeq, 2);
});

test('the audit table never stores the value itself', async () => {
  const env = { DB: fakeD1() };
  await createStateStore(env).put('secretish', 'do-not-copy-me');
  const serialised = JSON.stringify(env.DB.audit);
  assert.equal(serialised.includes('do-not-copy-me'), false);
});

test('the worker refuses state access without the owner token', async () => {
  const env = { DB: fakeD1(), CELIA_MCP_API_TOKEN: OWNER_TOKEN };
  const anonymous = await worker.fetch(new Request('https://edge.test/api/state/mode'), env);
  assert.equal(anonymous.status, 401);
  const listed = await worker.fetch(new Request('https://edge.test/api/state'), env);
  assert.equal(listed.status, 401);
  const audit = await worker.fetch(new Request('https://edge.test/api/audit'), env);
  assert.equal(audit.status, 401);
});

test('the worker stores and serves state with the token, and /readyz reflects it', async () => {
  const env = { DB: fakeD1(), CELIA_MCP_API_TOKEN: OWNER_TOKEN };
  const headers = { authorization: `Bearer ${OWNER_TOKEN}` };

  const ready = await worker.fetch(new Request('https://edge.test/readyz'), env);
  const readyBody = await ready.json();
  assert.equal(readyBody.storage.durable, true);
  assert.equal(readyBody.storage.mode, 'd1');

  const put = await worker.fetch(new Request('https://edge.test/api/state/mode', { method: 'PUT', headers, body: JSON.stringify({ value: 'cautious' }) }), env);
  assert.equal(put.status, 200);
  assert.equal((await put.json()).revision, 1);

  const get = await worker.fetch(new Request('https://edge.test/api/state/mode', { headers }), env);
  assert.equal(get.status, 200);
  assert.equal((await get.json()).value, 'cautious');

  const missing = await worker.fetch(new Request('https://edge.test/api/state/nope', { headers }), env);
  assert.equal(missing.status, 404);

  const chain = await worker.fetch(new Request('https://edge.test/api/audit', { headers }), env);
  const chainBody = await chain.json();
  assert.equal(chainBody.chain.ok, true);
  assert.equal(chainBody.count, 1);
});

test('with no D1 binding the worker says so instead of pretending', async () => {
  const env = { CELIA_MCP_API_TOKEN: OWNER_TOKEN };
  const ready = await worker.fetch(new Request('https://edge.test/readyz'), env);
  const body = await ready.json();
  assert.equal(body.storage.durable, false);
  assert.equal(body.storage.reason, 'd1_not_bound');
  const put = await worker.fetch(new Request('https://edge.test/api/state/mode', { method: 'PUT', headers: { authorization: `Bearer ${OWNER_TOKEN}` }, body: 'x' }), env);
  assert.equal(put.status, 503);
  assert.equal((await put.json()).error, 'd1_not_bound');
});

test('the deploy metadata carries a D1 binding only when the database exists', () => {
  const without = buildWorkerMetadata({ env: {}, version: '0.2.1', commit: 'abc', retirements: {} });
  assert.equal(without.bindings.some((binding) => binding.type === 'd1'), false);
  const withDb = buildWorkerMetadata({ env: {}, version: '0.2.1', commit: 'abc', d1DatabaseId: 'db-123', retirements: {} });
  assert.deepEqual(withDb.bindings.find((binding) => binding.type === 'd1'), { type: 'd1', name: 'DB', id: 'db-123' });
});

test('the database is reused when it exists and created only when it does not', async () => {
  const calls = [];
  const existing = async (url, init = {}) => {
    calls.push(`${init.method || 'GET'} ${url}`);
    return new Response(JSON.stringify({ success: true, result: [{ uuid: 'db-existing', name: 'celia-edge-state' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const reused = await ensureD1Database({ accountId: 'acc', apiToken: 'tok', fetchImpl: existing });
  assert.deepEqual(reused, { id: 'db-existing', name: 'celia-edge-state', created: false });
  assert.equal(calls.length, 1);

  const creating = async (url, init = {}) => {
    calls.push(`${init.method || 'GET'} ${url}`);
    if (!init.method) return new Response(JSON.stringify({ success: true, result: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ success: true, result: { uuid: 'db-new' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const created = await ensureD1Database({ accountId: 'acc', apiToken: 'tok', fetchImpl: creating });
  assert.deepEqual(created, { id: 'db-new', name: 'celia-edge-state', created: true });
});

test('migrations run statement by statement and skip comments', async () => {
  const posted = [];
  const fetchImpl = async (url, init = {}) => {
    posted.push(JSON.parse(init.body).sql);
    return new Response(JSON.stringify({ success: true, result: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const sql = '-- a comment only\n\nCREATE TABLE IF NOT EXISTS a (id TEXT);\n-- another\nCREATE INDEX IF NOT EXISTS i ON a (id);\n';
  const result = await applyMigrations({ accountId: 'acc', apiToken: 'tok', databaseId: 'db-1', sql, fetchImpl });
  assert.equal(result.statements, 2);
  assert.equal(posted.length, 2);
  assert.match(posted[0], /CREATE TABLE IF NOT EXISTS a/);
  assert.match(posted[1], /CREATE INDEX IF NOT EXISTS i/);
  assert.equal(posted[0].startsWith('--'), false, 'comment lines are stripped before the statement is sent');
});

test('an already-existing table is not a failure, and a real rejection names the statement', async () => {
  const already = async () =>
    new Response(JSON.stringify({ success: false, errors: [{ message: 'table edge_state already exists: SQLITE_ERROR' }] }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  const tolerated = await applyMigrations({ accountId: 'acc', apiToken: 'tok', databaseId: 'db-1', sql: 'CREATE TABLE IF NOT EXISTS a (id TEXT);', fetchImpl: already });
  assert.equal(tolerated.statements, 1);

  const rejected = async () =>
    new Response(JSON.stringify({ success: false, errors: [{ message: 'near "CREAT": syntax error' }] }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  await assert.rejects(
    () => applyMigrations({ accountId: 'acc', apiToken: 'tok', databaseId: 'db-1', sql: 'CREAT TABLE a (id TEXT);', fetchImpl: rejected }),
    /d1_migration_failed:statement_1:near "CREAT": syntax error/
  );

  const itemRejected = async () =>
    new Response(JSON.stringify({ success: true, result: [{ success: false, error: 'SQLITE_ERROR: syntax error' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  await assert.rejects(
    () => applyMigrations({ accountId: 'acc', apiToken: 'tok', databaseId: 'db-1', sql: 'SELECT 1;', fetchImpl: itemRejected }),
    /d1_migration_failed:statement_1:SQLITE_ERROR: syntax error/
  );
});

test('splitSqlStatements ignores semicolons inside -- comments, /* */ comments and quoted literals', () => {
  const sql = [
    '-- Applied through the D1 query API; every statement is',
    '-- idempotent; even with multiple; semicolons.',
    'CREATE TABLE t (',
    '  id TEXT PRIMARY KEY, -- inline comment; must not split here',
    "  note TEXT DEFAULT 'semi;colon -- not a comment ''escaped''; ok',",
    '  /* block comment; across',
    '     lines; still ignored */',
    '  "weird;col" INTEGER DEFAULT 0',
    ');',
    'CREATE INDEX idx_t ON t (`id`);'
  ].join('\n');

  const statements = splitSqlStatements(sql);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /^CREATE TABLE t/);
  assert.equal(statements[0].includes('every statement is'), false);
  assert.equal(statements[0].includes('must not split here'), false);
  assert.equal(statements[0].includes('still ignored'), false);
  assert.match(statements[0], /'semi;colon -- not a comment ''escaped''; ok'/);
  assert.match(statements[0], /"weird;col" INTEGER DEFAULT 0/);
  assert.equal(statements[1], 'CREATE INDEX idx_t ON t (`id`)');
});

test('real 0001_state.sql migrates cleanly on real SQLite and powers worker /readyz, /api/state and /api/audit', async () => {
  const migrationSql = await readFile(path.join(ROOT, 'workers/celia-edge/migrations/0001_state.sql'), 'utf8');
  const sqlite = new DatabaseSync(':memory:');

  const d1QueryFetch = async (_url, init = {}) => {
    const { sql, params } = JSON.parse(init.body);
    assert.deepEqual(params, []);
    try {
      sqlite.exec(sql);
      return new Response(JSON.stringify({ success: true, result: [{ success: true, results: [] }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    } catch (error) {
      return new Response(
        JSON.stringify({ success: false, errors: [{ code: 7500, message: `${error.message}: SQLITE_ERROR` }] }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      );
    }
  };

  const firstRun = await applyMigrations({ accountId: 'acc', apiToken: 'tok', databaseId: 'db-real', sql: migrationSql, fetchImpl: d1QueryFetch });
  assert.equal(firstRun.statements, 4);

  // Re-running on an already-migrated database must stay 100% idempotent.
  const secondRun = await applyMigrations({ accountId: 'acc', apiToken: 'tok', databaseId: 'db-real', sql: migrationSql, fetchImpl: d1QueryFetch });
  assert.equal(secondRun.statements, 4);

  const realD1Binding = {
    prepare(sql) {
      let bound = [];
      const stmt = sqlite.prepare(sql);
      const wrapper = {
        bind(...args) {
          bound = args;
          return wrapper;
        },
        async run() {
          stmt.run(...bound);
          return { success: true };
        },
        async first() {
          return stmt.get(...bound) ?? null;
        },
        async all() {
          return { results: stmt.all(...bound) };
        }
      };
      return wrapper;
    }
  };

  const env = { DB: realD1Binding, CELIA_MCP_API_TOKEN: OWNER_TOKEN };
  const headers = { authorization: `Bearer ${OWNER_TOKEN}` };

  const ready = await worker.fetch(new Request('https://edge.test/readyz'), env);
  const readyBody = await ready.json();
  assert.equal(readyBody.storage.durable, true);
  assert.equal(readyBody.storage.mode, 'd1');

  const put1 = await worker.fetch(new Request('https://edge.test/api/state/mode', { method: 'PUT', headers, body: JSON.stringify({ value: 'cautious' }) }), env);
  assert.equal(put1.status, 200);
  assert.equal((await put1.json()).revision, 1);

  const put2 = await worker.fetch(new Request('https://edge.test/api/state/mode', { method: 'PUT', headers, body: JSON.stringify({ value: 'verified' }) }), env);
  assert.equal(put2.status, 200);
  assert.equal((await put2.json()).revision, 2);

  const getMode = await worker.fetch(new Request('https://edge.test/api/state/mode', { headers }), env);
  assert.equal((await getMode.json()).value, 'verified');

  const listed = await worker.fetch(new Request('https://edge.test/api/state', { headers }), env);
  assert.equal((await listed.json()).count, 1);

  const audit = await worker.fetch(new Request('https://edge.test/api/audit', { headers }), env);
  const auditBody = await audit.json();
  assert.equal(auditBody.count, 2);
  assert.equal(auditBody.chain.ok, true);

  sqlite.close();
});
