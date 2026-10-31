#!/usr/bin/env node
// VER-06 — a green run must not hide un-run acceptance tests.
//
// Some tests genuinely cannot run on a given machine (real Linux user namespaces are
// blocked on GitHub-hosted runners). Pretending they ran is dishonest; failing every CI
// run because of the host is useless. So: allow ONLY a named, documented set of
// environment-gated tests, print them loudly as NOT RUN, and fail on anything else.
//
// Usage: node scripts/check-test-skips.mjs <tap-file> [--allow-env-gates]
import { readFile } from 'node:fs/promises';

/**
 * The only skips this repository tolerates, and only when the host truly lacks the
 * capability. Each entry names the missing capability so a reader can judge the gap.
 */
export const ENVIRONMENT_GATES = [
  { pattern: /^AGENT-003 /, capability: 'linux-user-namespaces' },
  { pattern: /^ART-09 \(real integration\)/, capability: 'linux-user-namespaces' },
  { pattern: /^SBX-09 \(REAL acceptance\)/, capability: 'linux-user-namespaces' },
  { pattern: /^MCP_TOOLS preserves strict N\/N-1 backward compatibility/, capability: 'git-history-baseline-commit' },
];

/** Parse `ok N - name # SKIP reason` lines out of TAP output. */
export function parseSkips(tap) {
  const skips = [];
  for (const line of String(tap).split('\n')) {
    const match = line.match(/^\s*(?:ok|not ok)\s+\d+\s+-\s+(.*?)\s+#\s+SKIP\b\s*(.*)$/);
    if (match) skips.push({ name: match[1], reason: match[2].trim() });
  }
  return skips;
}

/**
 * @returns {{ok:boolean, allowed:Array, unexpected:Array}}
 */
export function evaluateSkips(skips, { allowEnvironmentGates = false } = {}) {
  const allowed = [];
  const unexpected = [];
  for (const skip of skips) {
    const gate = allowEnvironmentGates && ENVIRONMENT_GATES.find((g) => g.pattern.test(skip.name));
    if (gate) allowed.push({ ...skip, capability: gate.capability });
    else unexpected.push(skip);
  }
  return { ok: unexpected.length === 0, allowed, unexpected };
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node scripts/check-test-skips.mjs <tap-file> [--allow-env-gates]');
    process.exit(2);
  }
  const result = evaluateSkips(parseSkips(await readFile(file, 'utf8')), {
    allowEnvironmentGates: args.includes('--allow-env-gates'),
  });
  if (result.allowed.length) {
    console.log(`\nNOT RUN on this host (${result.allowed.length}) — environment-gated, not counted as passing:`);
    for (const skip of result.allowed) console.log(`  - [${skip.capability}] ${skip.name}`);
    console.log('Run these on a capable Linux host: CELIA_SANDBOX_INTEGRATION=1 npm run test:full\n');
  }
  if (!result.ok) {
    console.error(`Unexpected skipped tests (${result.unexpected.length}) — the acceptance gate is incomplete:`);
    for (const skip of result.unexpected) console.error(`  - ${skip.name} (${skip.reason})`);
    process.exit(1);
  }
  console.log(`Skip gate passed: ${result.allowed.length} environment-gated, 0 unexpected.`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
