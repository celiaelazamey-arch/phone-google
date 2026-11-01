#!/usr/bin/env node
/**
 * Report contradictions between knowledge claims, naming both sides (VFE-007 / DEC-095).
 *
 * Input is either a claims file (`[{ subject, predicate, value, sourceId, trust }]`) or plain text
 * files in the declared `subject: value` syntax, each carrying its own source id. Output is a
 * conflict report with a digest; nothing is resolved.
 *
 * Exit codes: 0 = no measured conflict, 1 = conflicts found, 2 = bad input.
 *
 * Usage:
 *   node scripts/kb-conflicts.mjs claims.json
 *   node scripts/kb-conflicts.mjs docs/a.md drive/b.md --json
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { claimsFromItems, conflictDigest, describeConflicts, extractClaims, findConflicts } from '../src/knowledge/conflict.js';

export function readClaims(file) {
  const text = readFileSync(file, 'utf8');
  const sourceId = path.basename(file);
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map((claim) => ({ ...claim, sourceId: claim.sourceId ?? sourceId }));
    if (Array.isArray(parsed.claims)) return parsed.claims.map((claim) => ({ ...claim, sourceId: claim.sourceId ?? sourceId }));
    if (Array.isArray(parsed.items)) return claimsFromItems(parsed.items);
    throw new Error('expected an array, or an object with claims/items');
  } catch (error) {
    if (error instanceof SyntaxError) return extractClaims(text, { sourceId });
    throw error;
  }
}

export function collect(files) {
  const claims = [];
  for (const file of files) claims.push(...readClaims(file));
  return claims;
}

export function report(files) {
  const claims = collect(files);
  const result = findConflicts(claims);
  return { ...result, digest: conflictDigest(result), lines: describeConflicts(result) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const files = args.filter((arg) => !arg.startsWith('--'));
  if (files.length === 0) {
    console.error('usage: node scripts/kb-conflicts.mjs <claims.json|doc.md> [...] [--json]');
    process.exitCode = 2;
  } else {
    try {
      const result = report(files);
      if (json) console.log(JSON.stringify(result, null, 2));
      else for (const line of result.lines) console.log(line);
      process.exitCode = result.count > 0 ? 1 : 0;
    } catch (error) {
      console.error(`kb-conflicts: ${error.message}`);
      process.exitCode = 2;
    }
  }
}
