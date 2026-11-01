#!/usr/bin/env node
/**
 * Read the world, ask the gate, print the answer (PUB-001 / DEC-092).
 *
 * This script is the "say انشر" surface: it gathers what is locally knowable — branch, range, worktree,
 * commit signatures, version — reads the rest from a snapshot file, and prints the verdict with every
 * blocker named. It does not merge, push or deploy; when the verdict is `ready`, an actor that holds
 * the publish right runs the last mile and records it in the ledger.
 *
 * Usage:
 *   node scripts/publish-gate.mjs                     # local facts + empty snapshot
 *   node scripts/publish-gate.mjs --state snap.json   # add checks, protection, approvals, ledger
 *   node scripts/publish-gate.mjs --json              # machine-readable only
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { VERDICT, evaluatePublish, publishRequest, rollbackTarget, verifyLedger } from '../src/agent/publish-gate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
export const LEDGER_PATH = path.join(ROOT, 'docs', 'deployments', 'ledger.json');

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const gitOk = (...args) => {
  try {
    return git(...args);
  } catch {
    return null;
  }
};

/** A signature counts as present when git can see one; validity is reported, not assumed. */
const SIGNED = new Set(['G', 'U', 'B', 'X', 'Y']);

export function readLocalFacts() {
  const head = git('rev-parse', 'HEAD');
  const base = gitOk('rev-parse', 'origin/main') ?? 'origin/main';
  const branch = gitOk('rev-parse', '--abbrev-ref', 'HEAD') ?? '(detached)';
  const range = `${base}..HEAD`;
  const ahead = Number(gitOk('rev-list', '--count', range) ?? 0);
  const behind = Number(gitOk('rev-list', '--count', `HEAD..${base}`) ?? 0);
  const clean = gitOk('status', '--porcelain') === '';
  const log = gitOk('log', range, '--format=%H%x09%G?') ?? '';
  const commits = log
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, status] = line.split('\t');
      return { sha, signed: SIGNED.has(status), signatureStatus: status };
    });
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return { head, base, branch, ahead, behind, clean, commits, version: pkg.version };
}

export function buildSnapshot({ statePath } = {}) {
  const local = readLocalFacts();
  const provided = statePath ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  const request = publishRequest({
    channel: provided.channel ?? 'production',
    version: provided.version ?? local.version,
    commit: local.head,
    artifacts: provided.artifacts ?? []
  });
  const ledger = provided.ledger ?? (existsSync(LEDGER_PATH) ? JSON.parse(readFileSync(LEDGER_PATH, 'utf8')) : []);
  return {
    request,
    branch: { name: local.branch, head: local.head, base: local.base, ahead: local.ahead, behind: local.behind, clean: local.clean },
    commits: local.commits,
    checks: provided.checks ?? null,
    protection: provided.protection ?? {},
    approvals: provided.approvals ?? [],
    release: provided.release ?? { known: false, current: local.version },
    grant: provided.grant ?? { id: 'infra.publish.execute', wired: false },
    ledger
  };
}

const MARK = { [VERDICT.ready]: '✓', [VERDICT.needsOwner]: '!', [VERDICT.blocked]: '✕' };

export function format(result) {
  const lines = [];
  lines.push(`${MARK[result.verdict]} الحكم: ${result.verdict} — ${result.blockers.length} مانع، ${result.satisfied.length}/${result.summary.checkedRules} قاعدة مستوفاة`);
  if (result.request) lines.push(`الطلب: ${result.request.channel} · ${result.request.version} · ${result.request.commit.slice(0, 7)} · بصمة ${result.request.fingerprint}`);
  for (const item of result.blockers) lines.push(`  ${item.severity === 'block' ? '✕' : '!'} ${item.ar} — ${item.detail}`);
  for (const item of result.next) lines.push(`  ← ${item}`);
  return lines.join('\n');
}

export function verifyOnly({ json = false } = {}) {
  const ledger = existsSync(LEDGER_PATH) ? JSON.parse(readFileSync(LEDGER_PATH, 'utf8')) : [];
  const chain = verifyLedger(ledger);
  const rollback = rollbackTarget(ledger, { fromVersion: null });
  if (json) console.log(JSON.stringify({ ledger: chain, entries: ledger.length, rollback }, null, 2));
  else console.log(`${chain.ok ? '✓' : '✕'} سجل النشر: ${chain.ok ? 'سليم' : 'مكسور'} · ${ledger.length} قيدًا · ${chain.reason}${rollback ? ` · آخر نشر عبر البوابة ${rollback.version}` : ''}`);
  return chain.ok ? 0 : 1;
}

export function run({ statePath = null, json = false } = {}) {
  const snapshot = buildSnapshot({ statePath });
  const result = evaluatePublish(snapshot);
  const rollback = rollbackTarget(snapshot.ledger, { fromVersion: snapshot.request.version });
  const chain = verifyLedger(snapshot.ledger);
  const output = { ...result, ledger: chain, rollback };
  if (json) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(format(result));
    console.log(`السجل: ${chain.ok ? 'سليم' : 'مكسور'} · ${snapshot.ledger.length} قيدًا · التراجع إلى: ${rollback ? `${rollback.version} (${rollback.commit.slice(0, 7)})` : 'لا سجل سابق'}`);
    console.log(JSON.stringify({ verdict: output.verdict, fingerprint: output.request?.fingerprint ?? null, blockers: output.blockers.map((item) => item.rule) }));
  }
  return result.verdict === VERDICT.ready ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stateIndex = process.argv.indexOf('--state');
  if (process.argv.includes('--verify-ledger')) {
    process.exitCode = verifyOnly({ json: process.argv.includes('--json') });
  } else process.exitCode = run({
    statePath: stateIndex > -1 ? process.argv[stateIndex + 1] : null,
    json: process.argv.includes('--json')
  });
}
