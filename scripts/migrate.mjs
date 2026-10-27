#!/usr/bin/env node
/**
 * CLI wrapper around the migration ledger (`src/schema-migrations.js`).
 *
 * - `npm run migrate`            → dry run: shows pending files, changes nothing.
 * - `npm run migrate -- --apply` → applies pending files and records name + checksum.
 * - `npm run migrate -- --status`→ ledger contents only, writes nothing.
 *
 * Never drops, never rewrites an applied migration, never runs at server startup.
 */
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { loadMysqlConfig } from '../src/mysql-config.js';
import { runMigrations } from '../src/schema-migrations.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRECTORY = path.join(root, 'sql', 'migrations');
const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const statusOnly = args.has('--status');

async function main() {
  const config = loadMysqlConfig(process.env);
  const connection = await mysql.createConnection({
    ...config,
    ...(config.ssl ? { ssl: { ...config.ssl } } : {}),
    connectTimeout: 5000,
    charset: 'utf8mb4',
    timezone: 'Z',
    multipleStatements: false
  });
  try {
    const report = await runMigrations({ connection, directory: DIRECTORY, apply, statusOnly });
    console.log(JSON.stringify({ database: config.database, ...report }, null, 2));
  } finally {
    await connection.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
