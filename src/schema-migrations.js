import crypto from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Migration ledger (COMP-003 prerequisite).
 *
 * MySQL commits DDL implicitly, so this runner never pretends a multi-statement
 * file is transactional: it applies statements in order, records the file in
 * `schema_migrations` only after all statements succeed, and refuses to continue
 * on error. Files must therefore stay idempotent (`IF NOT EXISTS`). It also
 * refuses to run a file whose checksum changed after being applied, never drops,
 * and never runs at server startup.
 */

export const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INT NOT NULL PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  checksum CHAR(64) NOT NULL,
  applied_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

export function statementsOf(source) {
  if (/\bDELIMITER\b/i.test(source)) throw new Error('DELIMITER blocks are not supported by the ledger runner');
  return source
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
}

export async function listMigrations(directory) {
  const files = (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  const migrations = await Promise.all(
    files.map(async (name) => {
      const source = await readFile(path.join(directory, name), 'utf8');
      return {
        version: Number(name.slice(0, 4)),
        name,
        checksum: crypto.createHash('sha256').update(source).digest('hex'),
        statements: statementsOf(source)
      };
    })
  );
  if (!migrations.length) throw new Error('No migration files found');
  if (new Set(migrations.map((migration) => migration.version)).size !== migrations.length) {
    throw new Error('Duplicate migration version numbers');
  }
  return migrations;
}

const query = (connection, sql, params = []) => connection.query({ sql, timeout: 20000 }, params);

export async function runMigrations({ connection, directory, apply = false, statusOnly = false, now = () => new Date().toISOString() }) {
  const migrations = await listMigrations(directory);
  const [ledgerRows] = await query(
    connection,
    "SELECT COUNT(*) AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations'"
  );
  const hasLedger = Number(ledgerRows[0]?.total) > 0;
  if (!hasLedger && !apply) {
    return {
      mode: statusOnly ? 'status' : 'dry-run',
      ledger: 'missing',
      wouldCreateLedger: true,
      applied: [],
      pending: migrations.map(({ version, name, statements }) => ({ version, name, statements: statements.length }))
    };
  }
  if (!hasLedger) await query(connection, LEDGER_DDL);
  const [appliedRows] = await query(connection, 'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version');
  const appliedByVersion = new Map(appliedRows.map((row) => [Number(row.version), row]));
  const drift = migrations.filter((migration) => {
    const row = appliedByVersion.get(migration.version);
    return row && (row.name !== migration.name || row.checksum !== migration.checksum);
  });
  if (drift.length) {
    throw new Error(
      `Applied migration changed on disk: ${drift.map((migration) => migration.name).join(', ')}. Add a new migration instead of editing history.`
    );
  }
  const pending = migrations.filter((migration) => !appliedByVersion.has(migration.version));
  const report = {
    mode: statusOnly ? 'status' : apply ? 'apply' : 'dry-run',
    ledger: 'present',
    applied: appliedRows.map((row) => ({ version: Number(row.version), name: row.name, appliedAt: row.applied_at })),
    pending: pending.map(({ version, name, statements }) => ({ version, name, statements: statements.length }))
  };
  if (!apply || statusOnly) return report;
  for (const migration of pending) {
    try {
      for (const statement of migration.statements) await query(connection, statement);
      await query(connection, 'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)', [
        migration.version,
        migration.name,
        migration.checksum,
        now()
      ]);
    } catch (error) {
      throw new Error(
        `Migration ${migration.name} failed (${error?.code || 'sql_error'}). Earlier statements in this file may already be applied ` +
          '(MySQL commits DDL implicitly); the file is idempotent, fix the cause and re-run. Nothing was dropped.'
      );
    }
  }
  return { ...report, appliedNow: pending.map((migration) => migration.name) };
}
