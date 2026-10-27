#!/usr/bin/env node
/**
 * Schema migration ledger (COMP-003 prerequisite).
 *
 * - `npm run migrate`            → dry run: shows pending files, changes nothing.
 * - `npm run migrate -- --apply` → applies pending files and records name + checksum
 *   in `schema_migrations`.
 * - `npm run migrate -- --status`→ ledger contents only, writes nothing.
 *
 * MySQL commits DDL implicitly, so a failure mid-file can leave earlier statements
 * applied. Migration files must therefore stay idempotent (`IF NOT EXISTS`); the
 * runner refuses to continue, prints the safe retry, and never drops anything.
 * Never rewrites an applied migration and never runs at server startup.
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { loadMysqlConfig } from '../src/mysql-config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRECTORY = path.join(root, 'sql', 'migrations');
const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const statusOnly = args.has('--status');

function statementsOf(source) {
  if (/\bDELIMITER\b/i.test(source)) throw new Error('DELIMITER blocks are not supported by the ledger runner');
  return source
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
}

async function listMigrations() {
  const files = (await readdir(DIRECTORY)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  return Promise.all(
    files.map(async (name) => {
      const source = await readFile(path.join(DIRECTORY, name), 'utf8');
      return {
        version: Number(name.slice(0, 4)),
        name,
        checksum: crypto.createHash('sha256').update(source).digest('hex'),
        statements: statementsOf(source)
      };
    })
  );
}

async function main() {
  const config = loadMysqlConfig(process.env);
  const migrations = await listMigrations();
  if (!migrations.length) throw new Error('No migration files found');
  if (new Set(migrations.map((migration) => migration.version)).size !== migrations.length) {
    throw new Error('Duplicate migration version numbers');
  }
  const connection = await mysql.createConnection({
    ...config,
    ...(config.ssl ? { ssl: { ...config.ssl } } : {}),
    connectTimeout: 5000,
    charset: 'utf8mb4',
    timezone: 'Z',
    multipleStatements: false
  });
  try {
    const [ledgerExists] = await connection.query(
      "SELECT COUNT(*) AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations'"
    );
    const hasLedger = Number(ledgerExists[0]?.total) > 0;
    if (!hasLedger && !apply) {
      console.log(
        JSON.stringify(
          {
            database: config.database,
            mode: statusOnly ? 'status' : 'dry-run',
            ledger: 'missing',
            wouldCreateLedger: true,
            pending: migrations.map((migration) => ({ version: migration.version, name: migration.name, statements: migration.statements.length }))
          },
          null,
          2
        )
      );
      return;
    }
    if (!hasLedger) {
      await connection.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
          version INT NOT NULL PRIMARY KEY,
          name VARCHAR(128) NOT NULL,
          checksum CHAR(64) NOT NULL,
          applied_at VARCHAR(32) NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
      );
    }
    const [applied] = await connection.query('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version');
    const appliedByVersion = new Map(applied.map((row) => [Number(row.version), row]));
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
      database: config.database,
      mode: statusOnly ? 'status' : apply ? 'apply' : 'dry-run',
      applied: applied.map((row) => ({ version: Number(row.version), name: row.name, appliedAt: row.applied_at })),
      pending: pending.map((migration) => ({ version: migration.version, name: migration.name, statements: migration.statements.length }))
    };
    if (apply && !statusOnly) {
      for (const migration of pending) {
        try {
          for (const statement of migration.statements) await connection.query({ sql: statement, timeout: 20000 });
          await connection.query('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)', [
            migration.version,
            migration.name,
            migration.checksum,
            new Date().toISOString()
          ]);
        } catch (error) {
          throw new Error(
            `Migration ${migration.name} failed (${error.code || 'sql_error'}). ` +
              'MySQL commits DDL implicitly, so earlier statements in this file may already be applied; ' +
              'files are idempotent and can be retried after fixing the cause. Nothing was dropped.'
          );
        }
      }
      report.appliedNow = pending.map((migration) => migration.name);
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await connection.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
