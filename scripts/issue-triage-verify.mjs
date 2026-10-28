#!/usr/bin/env node
/**
 * Read-only verification of the triage ledger (AGENT-006).
 *
 * Rebuilds the hash chain from the ledger issue's comments and prints a summary. No writes, no secret, no
 * database: the ledger plus this script is the whole audit story, so anyone can re-check a decision later
 * instead of trusting a log line.
 *
 * Usage: GITHUB_REPOSITORY=owner/name node scripts/issue-triage-verify.mjs [--json]
 * Exits 1 if the chain is broken (edited, reordered or deleted entries).
 */
import { pathToFileURL } from 'node:url';
import { ROLLBACK_MARKER, readLedger, repository, resolveLedger } from './issue-triage.mjs';

export function parseRollbacks(comments) {
  return (comments || [])
    .map((comment) => String(comment?.body ?? '').match(new RegExp(`<!--\\s*${ROLLBACK_MARKER}\\s*(\\{.*?\\})\\s*-->`, 's')))
    .filter(Boolean)
    .map((match) => {
      try {
        return JSON.parse(match[1]);
      } catch {
        return { unparsable: true };
      }
    });
}

export function summarize({ ledger, records, chain, rollbacks = [] }) {
  const routes = { auto: 0, human: 0, reject: 0 };
  for (const record of records) {
    const route = record?.decision?.route;
    if (route in routes) routes[route] += 1;
  }
  return {
    ledger,
    records: records.length,
    chain: chain.ok ? `ok (${chain.count} entries, head ${String(chain.head).slice(0, 12)})` : `BROKEN at seq ${chain.brokenSeq}: ${chain.reason}`,
    routes,
    rollbacks,
    issues: records.map((record) => ({
      issue: record?.issue?.number,
      route: record?.decision?.route,
      confidence: record?.proposal?.confidence,
      appliedLabels: record?.applied?.labels ?? [],
      injection: record?.injection?.tainted ? record.injection.ruleIds : [],
      rollbackDeadline: record?.rollback?.deadline
    }))
  };
}

function main() {
  const repo = repository();
  const ledger = resolveLedger(repo);
  if (!ledger) {
    console.log(JSON.stringify({ ledger: null, records: 0, chain: 'no ledger yet' }, null, 2));
    return;
  }
  const { comments, records, chain } = readLedger(repo, ledger);
  const summary = summarize({ ledger, records, chain, rollbacks: parseRollbacks(comments) });
  console.log(JSON.stringify(summary, null, 2));
  if (!chain.ok) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
