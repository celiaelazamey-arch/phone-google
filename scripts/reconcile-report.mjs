#!/usr/bin/env node
/**
 * DATA-003 — print the reconciliation report from a durable store.
 *
 * The periodic half of the backlog row is a *report*, not a scheduler. This command answers «what is
 * still unknown, and for how long?» at the moment it is asked, and nothing else: it opens the local
 * store read-only in effect (it only SELECTs), prints, and exits. It never reconciles anything, never
 * calls a connector, and never re-sends.
 *
 * Exit codes follow the same honesty rule as `scripts/attention.mjs`:
 *   0 = nothing unresolved
 *   1 = something is unresolved (including anything past the staleness threshold)
 *   2 = bad input or an unreadable store
 *
 * Usage:
 *   node scripts/reconcile-report.mjs [--db path.sqlite3] [--threshold-hours 6] [--json] [--now ISO]
 *
 * If `--db` is omitted, `CELIA_AGENT_SQLITE_PATH` is used. MySQL is deliberately not opened here:
 * a report that can run against production from a laptop is a report nobody authorised.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { createSqliteDriver } from '../src/agent/drivers.js';
import { createAgentStore } from '../src/agent/store.js';
import {
  buildReconciliationReport,
  describeReconciliationReport,
  readAmbiguitySnapshot
} from '../src/agent/reconcile-batch.js';

function parseArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : null;
  };
  const db = value('--db') || process.env.CELIA_AGENT_SQLITE_PATH || null;
  const thresholdHours = Number(value('--threshold-hours'));
  const now = value('--now');
  return {
    db,
    json: argv.includes('--json'),
    thresholdHours: Number.isFinite(thresholdHours) && thresholdHours > 0 ? thresholdHours : 6,
    now: typeof now === 'string' && Number.isFinite(Date.parse(now)) ? now : null
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.db) {
    console.error('usage: node scripts/reconcile-report.mjs [--db path.sqlite3] [--threshold-hours 6] [--json] [--now ISO]');
    console.error('set CELIA_AGENT_SQLITE_PATH or pass --db');
    return 2;
  }
  // A report must not create a database as a side effect of asking a question, so a missing file is
  // refused instead of being manufactured. (Opening an *existing* store still runs the driver's
  // idempotent `CREATE TABLE IF NOT EXISTS` DDL; that adds nothing to a store that already has them,
  // and this command writes no rows.)
  const file = path.resolve(args.db);
  if (!existsSync(file)) throw new Error(`no agent store at that path (nothing was created): ${file}`);
  const driver = await createSqliteDriver({ path: file });
  const store = createAgentStore({ driver });
  try {
    const snapshot = await readAmbiguitySnapshot({ store });
    const report = buildReconciliationReport(snapshot, {
      now: args.now,
      thresholdMs: Math.round(args.thresholdHours * 3_600_000)
    });
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else for (const line of describeReconciliationReport(report)) console.log(line);
    return report.unresolvedTotal > 0 ? 1 : 0;
  } finally {
    await store.close().catch(() => {});
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`reconcile-report: ${error.message}`);
    process.exitCode = 2;
  });
