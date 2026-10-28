#!/usr/bin/env node
/**
 * Turn a service-reality report into a notification the owner actually receives.
 *
 * Scheduled workflow failures notify nobody useful in this repository (the schedule's actor is the automation
 * that last touched the workflow), so the weekly audit upserts ONE tracking issue instead:
 *   - verdict `fail`  → create the issue (label `service-reality`) or append a comment to the open one;
 *   - verdict `pass`  → comment on the open issue, if any, and close it.
 * The report is already sanitized by scripts/service-reality.mjs (exit 3 on any secret leak), and this script
 * only repeats service ids, verdicts and short details — never values.
 *
 * Usage: node scripts/reality-notify.mjs [--report .validation-artifacts/service-reality.json] [--dry-run]
 * Needs: GH_TOKEN with issues:write, GITHUB_REPOSITORY, RUN_URL (optional).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LABEL = 'service-reality';
export const TITLE = 'Service reality below threshold';

export function parseArgs(argv) {
  const options = { report: '.validation-artifacts/service-reality.json', dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--report') options.report = String(argv[++i] || options.report);
    else if (arg === '--dry-run') options.dryRun = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const pct = (value) => (typeof value === 'number' ? `${Math.round(value * 100)}%` : 'n/a');

/** Markdown body/comment for a report. Deterministic; contains ids, verdicts and short details only. */
export function buildIssueBody(report, { runUrl = null, now = new Date() } = {}) {
  const score = report?.score || {};
  const live = Array.isArray(report?.live) ? report.live : [];
  const failed = live.filter((entry) => entry.verdict === 'failed');
  const disabled = live.filter((entry) => entry.verdict === 'disabled');
  const lines = [];
  lines.push(`### Service reality — ${report?.verdict === 'pass' ? '✅ pass' : '❌ fail'} (${now.toISOString().slice(0, 10)})`);
  lines.push('');
  if (runUrl) lines.push(`Run: ${runUrl}`);
  if (report?.commit) lines.push(`Commit: \`${String(report.commit).slice(0, 7)}\``);
  lines.push(`Working rate of configured services: **${pct(score.workingRate)}** (threshold ${pct(report?.minRate ?? 0.95)})`);
  lines.push(`Live: ${score.verified ?? 0} verified · ${score.failed ?? 0} failed · ${score.disabled ?? 0} retired · ${score['not-configured'] ?? 0} not configured · ${score.unverifiable ?? 0} unverifiable · ${score['not-deployed'] ?? 0} not deployed`);
  if (report?.offline) lines.push(`Offline suite: ${report.offline.pass}/${report.offline.tests} · coverage lines ${report.offline.coverage?.lines ?? 'n/a'}%`);
  if (report?.mysql?.ran) lines.push(`Real MySQL suite: ${report.mysql.pass}/${report.mysql.tests}`);
  if (report?.verdictReason) lines.push(`Reason: ${report.verdictReason}`);
  if (failed.length) {
    lines.push('');
    lines.push('| service | secret | what happened |');
    lines.push('|---|---|---|');
    for (const entry of failed) lines.push(`| \`${entry.id}\` | \`${entry.secret || '—'}\` | ${String(entry.detail || '').replace(/\|/g, '\\|').slice(0, 220)} |`);
  }
  if (disabled.length) {
    lines.push('');
    lines.push(`Retired by decision (not counted): ${disabled.map((entry) => `\`${entry.id}\``).join(', ')} — see \`docs/deployment-profile.json → serviceRetirements\`.`);
  }
  lines.push('');
  lines.push('Fix the account/secret named above (or retire the service explicitly), then re-run **Service reality audit** from the Actions tab or push a commit containing `[reality]`. The issue closes itself on the next passing run. Truth table: `docs/service-reality.md`.');
  return lines.join('\n');
}

function gh(args, { env, allowFailure = false } = {}) {
  const result = spawnSync('gh', args, { encoding: 'utf8', env });
  if (result.status !== 0 && !allowFailure) throw new Error(`gh ${args[0]} ${args[1] || ''} failed (${result.status}): ${String(result.stderr || '').trim().slice(0, 300)}`);
  return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

export function findOpenIssue(env) {
  const list = gh(['issue', 'list', '--label', LABEL, '--state', 'open', '--limit', '1', '--json', 'number'], { env });
  const parsed = JSON.parse(list.stdout || '[]');
  return Array.isArray(parsed) && parsed[0]?.number ? Number(parsed[0].number) : null;
}

export async function main({ argv = process.argv.slice(2), env = process.env, log = console.log } = {}) {
  const options = parseArgs(argv);
  const report = JSON.parse(readFileSync(path.resolve(options.report), 'utf8'));
  const body = buildIssueBody(report, { runUrl: env.RUN_URL || null });
  if (options.dryRun) {
    log(body);
    return 0;
  }
  if (!env.GH_TOKEN && !env.GITHUB_TOKEN) throw new Error('GH_TOKEN (issues:write) is required');
  const ghEnv = { ...env, GH_TOKEN: env.GH_TOKEN || env.GITHUB_TOKEN };
  const bodyFile = path.join(mkdtempSync(path.join(tmpdir(), 'reality-')), 'body.md');
  writeFileSync(bodyFile, body, 'utf8');

  gh(['label', 'create', LABEL, '--description', 'Weekly service-reality audit tracking', '--color', 'B60205', '--force'], { env: ghEnv, allowFailure: true });
  const open = findOpenIssue(ghEnv);

  if (report.verdict === 'pass') {
    if (open) {
      gh(['issue', 'comment', String(open), '--body-file', bodyFile], { env: ghEnv });
      gh(['issue', 'close', String(open), '--comment', 'Closed automatically: the audit passed.'], { env: ghEnv });
      log(`::notice title=Service Reality · notify::audit passed — closed issue #${open}`);
    } else {
      log('::notice title=Service Reality · notify::audit passed — no open tracking issue');
    }
    return 0;
  }

  if (open) {
    gh(['issue', 'comment', String(open), '--body-file', bodyFile], { env: ghEnv });
    log(`::notice title=Service Reality · notify::appended to issue #${open}`);
  } else {
    const created = gh(['issue', 'create', '--title', `${TITLE} (${pct(report?.score?.workingRate)})`, '--label', LABEL, '--body-file', bodyFile], { env: ghEnv });
    log(`::notice title=Service Reality · notify::opened ${created.stdout.trim()}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`::error title=Service Reality · notify::${error.message}`);
    process.exit(1);
  });
}

export const __filename = fileURLToPath(import.meta.url);
