/**
 * Two explicit drivers for the agent store.
 *
 * - `mysql`: production. Tables are created only by `scripts/migrate.mjs` from
 *   `sql/migrations/*.sql`; this driver never creates or alters schema.
 * - `sqlite`: durable local/demo store (`node:sqlite`). Never used automatically
 *   and never in production; it creates its own local tables on open.
 *
 * No in-memory driver exists on purpose: an agent run that forgets its steps is
 * worse than a run that refuses to start (AGENTS.md: no silent memory fallback).
 */

const SQLITE_DDL = [
  `CREATE TABLE IF NOT EXISTS agent_threads (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_agent_threads_owner ON agent_threads (owner_id, updated_at)',
  `CREATE TABLE IF NOT EXISTS agent_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    client_message_id TEXT NULL,
    created_at TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_messages_client ON agent_messages (thread_id, client_message_id)',
  'CREATE INDEX IF NOT EXISTS idx_agent_messages_thread ON agent_messages (thread_id, created_at)',
  `CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,
    user_message_id TEXT NULL,
    client_message_id TEXT NULL,
    status TEXT NOT NULL,
    planner TEXT NOT NULL,
    plan_summary TEXT NULL,
    max_steps INTEGER NOT NULL,
    max_cost_micros INTEGER NOT NULL,
    steps_used INTEGER NOT NULL DEFAULT 0,
    cost_micros INTEGER NOT NULL DEFAULT 0,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    lease_until TEXT NULL,
    lease_owner TEXT NULL,
    last_error TEXT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_runs_client ON agent_runs (thread_id, client_message_id)',
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_owner ON agent_runs (owner_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs (status, lease_until)',
  `CREATE TABLE IF NOT EXISTS agent_steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    step_index INTEGER NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NULL,
    tool_name TEXT NULL,
    created_at TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_steps_index ON agent_steps (run_id, step_index)',
  `CREATE TABLE IF NOT EXISTS agent_tool_runs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    step_id TEXT NULL,
    tool_name TEXT NOT NULL,
    risk TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    arguments_digest TEXT NULL,
    status TEXT NOT NULL,
    outcome TEXT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_tool_runs_key ON agent_tool_runs (idempotency_key)',
  'CREATE INDEX IF NOT EXISTS idx_agent_tool_runs_run ON agent_tool_runs (run_id)',
  `CREATE TABLE IF NOT EXISTS agent_approvals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    step_id TEXT NULL,
    tool_name TEXT NOT NULL,
    risk TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    decision TEXT NOT NULL DEFAULT 'pending',
    decision_key TEXT NULL,
    actor TEXT NULL,
    note TEXT NULL,
    requested_at TEXT NOT NULL,
    decided_at TEXT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_approvals_key ON agent_approvals (idempotency_key)',
  'CREATE INDEX IF NOT EXISTS idx_agent_approvals_decision_key ON agent_approvals (decision_key)',
  'CREATE INDEX IF NOT EXISTS idx_agent_approvals_run ON agent_approvals (run_id, requested_at)',
  `CREATE TABLE IF NOT EXISTS agent_goal_contracts (
    run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
    contract TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agent_evidence (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    step_id TEXT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    output_hash TEXT NULL,
    source_ids TEXT NULL,
    verdict TEXT NULL,
    version TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_evidence_seq ON agent_evidence (run_id, seq)',
  'CREATE INDEX IF NOT EXISTS idx_agent_evidence_run ON agent_evidence (run_id, seq)'
];

const MYSQL_AGENT_TABLES = [
  'agent_threads',
  'agent_messages',
  'agent_runs',
  'agent_steps',
  'agent_tool_runs',
  'agent_approvals',
  'agent_goal_contracts',
  'agent_evidence'
];

function uniqueViolation(error) {
  return (
    error?.code === 'ER_DUP_ENTRY' ||
    error?.errno === 1062 ||
    /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(error?.message || '')
  );
}

/** Production driver. Uses an existing mysql2 pool; never creates schema. */
export function createMysqlDriver(pool) {
  if (!pool || pool.isMemory) {
    throw new Error('Agent runs require durable MySQL, not demonstration memory');
  }
  const run = async (target, sql, params = []) => {
    const [rows] = await target.execute(sql, params);
    if (Array.isArray(rows)) return { changes: rows.affectedRows ?? 0, rows };
    return { changes: rows.affectedRows ?? 0, rows: [] };
  };
  const normalized = (sql) => sql.replace(/\s+/g, ' ').trim();
  const driver = {
    dialect: 'mysql',
    async all(sql, params) {
      const [rows] = await pool.execute(normalized(sql), params);
      return Array.isArray(rows) ? rows : [];
    },
    async get(sql, params) {
      const rows = await driver.all(sql, params);
      return rows[0];
    },
    async run(sql, params) {
      return run(pool, normalized(sql), params);
    },
    async transaction(fn) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const tx = {
          dialect: 'mysql',
          async all(sql, params) {
            const [rows] = await connection.execute(normalized(sql), params);
            return Array.isArray(rows) ? rows : [];
          },
          async get(sql, params) {
            const rows = await tx.all(sql, params);
            return rows[0];
          },
          run: (sql, params) => run(connection, normalized(sql), params)
        };
        const result = await fn(tx);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback().catch(() => {});
        throw error;
      } finally {
        connection.release();
      }
    },
    async verifySchema() {
      const [rows] = await pool.execute(
        'SELECT TABLE_NAME AS tableName FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()'
      );
      const existing = new Set(rows.map((row) => row.tableName));
      const missing = MYSQL_AGENT_TABLES.filter((table) => !existing.has(table));
      return { ok: missing.length === 0, missing, migration: 'npm run migrate -- --apply' };
    },
    isUniqueViolation: uniqueViolation,
    close: async () => {}
  };
  return driver;
}

/** Durable local/demo driver backed by node:sqlite. Refused in production. */
export async function createSqliteDriver({ path, nodeEnv = 'development' } = {}) {
  if (nodeEnv === 'production') {
    throw new Error('The SQLite agent store is a local/demo store and is refused in production');
  }
  if (!path || typeof path !== 'string' || !path.trim()) {
    throw new Error('CELIA_AGENT_SQLITE_PATH is required for the SQLite agent store');
  }
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(path.trim());
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 3000');
  for (const statement of SQLITE_DDL) database.exec(statement);
  const normalized = (sql) => sql.replace(/\s+/g, ' ').trim();
  const bind = (params) => params.map((value) => (value === undefined ? null : value));
  let queue = Promise.resolve();
  const driver = {
    dialect: 'sqlite',
    async all(sql, params = []) {
      return database.prepare(normalized(sql)).all(...bind(params));
    },
    async get(sql, params = []) {
      return database.prepare(normalized(sql)).get(...bind(params));
    },
    async run(sql, params = []) {
      const result = database.prepare(normalized(sql)).run(...bind(params));
      return { changes: Number(result.changes), rows: [] };
    },
    // node:sqlite is one synchronous connection: transactions must not interleave.
    async transaction(fn) {
      const runExclusive = async () => {
        database.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn(driver);
          database.exec('COMMIT');
          return result;
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      };
      const result = queue.then(runExclusive, runExclusive);
      queue = result.catch(() => {});
      return result;
    },
    async verifySchema() {
      const rows = await driver.all("SELECT name FROM sqlite_master WHERE type = 'table'");
      const existing = new Set(rows.map((row) => row.name));
      const missing = MYSQL_AGENT_TABLES.filter((table) => !existing.has(table));
      return { ok: missing.length === 0, missing, migration: 'created-on-open' };
    },
    isUniqueViolation: uniqueViolation,
    close: async () => {
      database.close();
    }
  };
  return driver;
}
