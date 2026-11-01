#!/usr/bin/env node
/**
 * Consolidate assertions into one view, losing nothing (MEM-001 / DEC-096).
 *
 * Reads claims — a bare array, `{ claims }`, or `{ items }` whose bodies use `subject: value` — and
 * prints the consolidated view: duplicate assertions of one value collapse with every source kept,
 * and disagreeing values stay side by side. It never writes, deletes or picks a value, and there is
 * no `--apply` flag because there is nothing to apply.
 *
 * Exit codes: 0 = nothing to do, 1 = something needs a human decision, 2 = bad input.
 *
 * Usage:
 *   node scripts/memory-consolidate.mjs memory.json [--json] [--now 2026-11-01T00:00:00Z]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { checkReport, consolidate, describeConsolidation } from '../src/agent/consolidation.js';

/** Accepts a claims array, `{ claims: [...] }`, or `{ items: [...] }` where items carry claim text. */
export function readClaims(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.claims)) return parsed.claims;
  if (Array.isArray(parsed?.items)) {
    return parsed.items.flatMap((item) =>
      String(item.body ?? item.text ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && /[:=]/.test(line))
        .map((line) => {
          const at = line.search(/[:=]/);
          const [subject, predicate = 'value'] = line.slice(0, at).split('|').map((part) => part.trim());
          return { subject, predicate, value: line.slice(at + 1).trim(), sourceId: item.sourceId ?? item.source_id ?? 'unknown', itemId: item.id ?? null };
        })
    );
  }
  throw new Error('expected an array, or an object with claims/items');
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const file = args.find((arg) => !arg.startsWith('--'));
  if (!file) {
    console.error('usage: node scripts/memory-consolidate.mjs <claims.json> [--json]');
    process.exitCode = 2;
  } else {
    try {
      const report = consolidate(readClaims(file));
      const check = checkReport(report);
      if (!check.ok) {
        console.error(`memory-consolidate: refused the report — ${check.problems.join('; ')}`);
        process.exitCode = 2;
      } else {
        if (json) console.log(JSON.stringify(report, null, 2));
        else for (const line of describeConsolidation(report)) console.log(line);
        process.exitCode = report.contested > 0 ? 1 : 0;
      }
    } catch (error) {
      console.error(`memory-consolidate: ${error.message}`);
      process.exitCode = 2;
    }
  }
}
