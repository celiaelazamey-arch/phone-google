import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';

export const REQUIRED_COLUMNS = Object.freeze({
  app_users: ['id', 'email', 'phone_e164', 'created_at'],
  oauth_states: ['state_hash', 'user_id', 'expires_at', 'used_at', 'created_at'],
  google_credentials: ['user_id', 'encrypted_tokens', 'scopes', 'updated_at'],
  whatsapp_contacts: ['phone_e164', 'opted_in', 'ai_opted_in', 'consent_source', 'consented_at', 'last_inbound_at', 'created_at', 'updated_at'],
  whatsapp_messages: ['id', 'provider_message_id', 'phone_e164', 'direction', 'message_type', 'body', 'status', 'created_at']
});

/** Explicit FIRST installation only. Never alters or drops any existing table or row. */
async function initialize(config, { connect = mysql.createConnection } = {}) {
  if (config.envDisableMysql) throw new Error('Empty database initialization requires MySQL, not demonstration memory');
  const connection = await connect({ ...config.mysql, ...(config.mysql.ssl ? { ssl: { ...config.mysql.ssl } } : {}), connectTimeout: 5000, charset: 'utf8mb4', timezone: 'Z' });
  const lock = `celia-install-${crypto.createHash('sha256').update(config.mysql.database).digest('hex').slice(0, 24)}`;
  const query = (sql, values = []) => connection.query({ sql, timeout: 10000 }, values);
  let acquired = false;
  try {
    const [locks] = await query('SELECT GET_LOCK(?, 5) AS acquired', [lock]);
    if (Number(locks[0]?.acquired) !== 1) throw new Error('Database installation lock is busy; no schema changes attempted');
    acquired = true;
    const [tables] = await query("SELECT TABLE_NAME AS tableName FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()");
    let created = false;
    if (!tables.length) {
      const source = await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8');
      for (const sql of source.split(';').map((part) => part.trim()).filter(Boolean)) await query(sql);
      created = true;
    }
    const [columns] = await query('SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()');
    for (const [table, expected] of Object.entries(REQUIRED_COLUMNS)) {
      const actual = new Set(columns.filter((c) => c.tableName === table).map((c) => c.columnName));
      if (expected.some((column) => !actual.has(column))) {
        throw new Error('Database is non-empty or incompatible; automatic repair/migration is refused');
      }
    }
    return { action: created ? 'initialized-empty-database' : 'existing-database-unchanged', schema: 1, tables: Object.keys(REQUIRED_COLUMNS).length };
  } finally {
    if (acquired) await query('SELECT RELEASE_LOCK(?) AS released', [lock]).catch(() => {});
    await connection.end().catch(() => {});
  }
}

export async function bootstrapEmptySchema(config, options) {
  try { return await initialize(config, options); }
  catch (error) {
    const safe = [
      'Empty database initialization requires MySQL, not demonstration memory',
      'Database installation lock is busy; no schema changes attempted',
      'Database is non-empty or incompatible; automatic repair/migration is refused'
    ];
    throw new Error(safe.includes(error.message) ? error.message : 'Database first installation failed; verify TLS, credentials and permissions in the hosting settings');
  }
}
