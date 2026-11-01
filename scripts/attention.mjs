#!/usr/bin/env node
/**
 * Print what is waiting for a person, from durable records (UX-004 / DEC-098).
 *
 * Reads a snapshot of runs, approvals, tool runs and outbox rows — the shapes the store returns —
 * and prints the attention queue. It sends nothing, stores nothing, and never marks anything read:
 * an item disappears when the underlying state changes, which is the only honest "read" there is.
 *
 * Exit codes: 0 = nothing owed, 1 = something is owed, 2 = bad input.
 *
 * Usage:
 *   node scripts/attention.mjs snapshot.json [--json] [--now 2026-11-01T12:00:00Z]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { buildAttention, checkQueue, describeAttention } from '../src/agent/attention.js';

export function readSnapshot(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (Array.isArray(parsed)) return { runs: parsed };
  if (parsed && typeof parsed === 'object') {
    return {
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      approvals: Array.isArray(parsed.approvals) ? parsed.approvals : [],
      toolRuns: Array.isArray(parsed.toolRuns) ? parsed.toolRuns : [],
      outbox: Array.isArray(parsed.outbox) ? parsed.outbox : []
    };
  }
  throw new Error('expected a runs array or an object with runs/approvals/toolRuns/outbox');
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const nowIndex = args.indexOf('--now');
  const now = nowIndex > -1 ? args[nowIndex + 1] : null;
  const file = args.find((arg) => !arg.startsWith('--') && arg !== now);
  if (!file) {
    console.error('usage: node scripts/attention.mjs <snapshot.json> [--json] [--now ISO]');
    process.exitCode = 2;
  } else {
    try {
      const sources = readSnapshot(file);
      const queue = buildAttention(sources, { now });
      const check = checkQueue(queue, sources);
      if (!check.ok) {
        console.error(`attention: refused the queue — ${check.problems.join('; ')}`);
        process.exitCode = 2;
      } else {
        if (json) console.log(JSON.stringify(queue, null, 2));
        else for (const line of describeAttention(queue)) console.log(line);
        process.exitCode = queue.owed > 0 ? 1 : 0;
      }
    } catch (error) {
      console.error(`attention: ${error.message}`);
      process.exitCode = 2;
    }
  }
}
