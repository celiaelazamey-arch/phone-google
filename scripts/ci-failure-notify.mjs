#!/usr/bin/env node
/**
 * QA-009 — a red "Celia quality & resilience" run on `main` becomes ONE tracking issue that names the failing tests.
 *
 * Closes the loop "detect → name → tell the owner" and deliberately stops there (DEC-041): no retry, no patch,
 * no rollback, no merge. The failing test names come from the annotations the reporter already emits
 * (DEC-039: `scripts/test-reporter-gha.mjs` for `node --test`, Playwright's `github` reporter for the browser
 * job), read back through the Checks API — so a failure that only says "Process completed with exit code 1"
 * is reported as exactly that, never dressed up.
 *
 *   - run concluded `failure`/`timed_out` on `main` → create the issue (label `ci-failure`) or append one
 *     comment per run to the open one (a run id is never recorded twice);
 *   - run concluded `success` on `main`             → comment on the open issue, if any, and close it;
 *   - anything else (other branch, PR run, cancelled, superseded by a newer completed run) → notice, exit 0.
 *
 * Every string copied from an annotation passes through `redact()`; paths are already repository-relative.
 *
 * Usage: node scripts/ci-failure-notify.mjs --run <workflow_run_id> [--branch main] [--dry-run] [--fixture file.json]
 * Needs: GH_TOKEN or GITHUB_TOKEN (actions:read, checks:read, issues:write), GH_REPO or GITHUB_REPOSITORY.
 * Fixture (tests / offline dry runs): {"run": {...}, "jobs": [...], "annotations": {"<jobId>": [...]}, "latest": {...}}
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LABEL = 'ci-failure';
export const TITLE = 'Quality workflow red on main';
export const MARKER = '<!-- qa-009 -->';
export const WORKFLOW_FILE = 'celia-mcp.yml';
export const MAX_ROWS = 30;
export const runMarker = (runId) => `<!-- qa-009 run:${runId} -->`;

const RED = new Set(['failure', 'timed_out', 'startup_failure']);
const GENERIC = [/^Process completed with exit code \d+\.?$/i, /^The (?:job|operation) was cancel+ed/i, /^The hosted runner/i];

export function parseArgs(argv) {
  const options = { run: null, branch: 'main', dryRun: false, fixture: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--run') options.run = String(argv[++i] || '').trim();
    else if (arg === '--branch') options.branch = String(argv[++i] || options.branch).trim();
    else if (arg === '--fixture') options.fixture = String(argv[++i] || '').trim();
    else if (arg === '--dry-run') options.dryRun = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.run || !/^\d+$/.test(options.run)) throw new Error('--run <workflow_run_id> (digits) is required');
  return options;
}

/** Secret-shaped substrings never reach an issue, whatever a failing assertion happened to print. */
export function redact(input) {
  let text = String(input ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  const rules = [
    [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[redacted]'],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted]'],
    [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted]'],
    [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[redacted]'],
    [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]'],
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
    [/\b((?:api[_-]?key|token|secret|password|passwd|pwd|authorization|cookie)\s*[=:]\s*)["']?(?:Bearer\s+)?[^\s"',;]{6,}["']?/gi, '$1[redacted]'],
    [/\b[A-Fa-f0-9]{32,}\b/g, '[redacted]'],
    [/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]']
  ];
  for (const [pattern, replacement] of rules) text = text.replace(pattern, replacement);
  return text;
}

const short = (sha) => String(sha || '').slice(0, 7);
const cell = (value, max = 220) => redact(value).replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim().slice(0, max);
const pathCell = (value, max = 120) => String(value ?? '').replace(/[\r\n`|]/g, ' ').trim().slice(0, max); // repository-relative paths are never secrets

/** What this run means for the issue: red, green, or skip (with the reason). Pure. */
export function classifyRun(run, { branch = 'main', latest = null } = {}) {
  if (!run) return { verdict: 'skip', reason: 'run not found' };
  if (run.head_branch !== branch) return { verdict: 'skip', reason: `head branch ${run.head_branch || '?'} is not ${branch}` };
  if (run.event !== 'push') return { verdict: 'skip', reason: `event ${run.event || '?'} is not push` };
  if (run.status && run.status !== 'completed') return { verdict: 'skip', reason: `run is ${run.status}, not completed` };
  if (latest && String(latest.id) !== String(run.id) && Date.parse(latest.created_at || 0) > Date.parse(run.created_at || 0)) {
    return { verdict: 'skip', reason: `superseded by newer completed run ${latest.id} (${latest.conclusion})` };
  }
  if (run.conclusion === 'success') return { verdict: 'green' };
  if (RED.has(run.conclusion)) return { verdict: 'red' };
  return { verdict: 'skip', reason: `conclusion ${run.conclusion || '?'} is neither success nor failure` };
}

/** Group the failure-level annotations of the failed jobs: named tests, coverage, reporter summary, silent jobs. Pure. */
export function collectFailures({ jobs = [], annotationsByJob = {} } = {}) {
  const failedJobs = jobs.filter((job) => RED.has(job.conclusion)).map((job) => ({ id: job.id, name: job.name, url: job.html_url || null }));
  const tests = [];
  const coverage = [];
  const summary = [];
  const other = [];
  const seen = new Set();
  for (const job of failedJobs) {
    const annotations = Array.isArray(annotationsByJob[job.id]) ? annotationsByJob[job.id] : [];
    let named = 0;
    for (const annotation of annotations) {
      if (annotation.annotation_level !== 'failure') continue;
      const title = String(annotation.title || '').trim();
      const message = String(annotation.message || '').trim();
      const file = String(annotation.path || '').trim();
      if (GENERIC.some((pattern) => pattern.test(message))) continue;
      if (title === 'coverage threshold') {
        coverage.push({ job: job.name, message });
        named += 1;
      } else if (title === 'node --test') {
        summary.push({ job: job.name, message });
      } else if (file && file !== '.github') {
        const key = `${file}:${annotation.start_line || 0}:${title || message.split('\n')[0]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tests.push({ job: job.name, title: title || message.split('\n')[0], file, line: annotation.start_line || null, message });
        named += 1;
      } else {
        other.push({ job: job.name, title, message });
        named += 1;
      }
    }
    job.silent = named === 0;
  }
  return { failedJobs, tests, coverage, summary, other, silentJobs: failedJobs.filter((job) => job.silent) };
}

export function buildTitle(failures, { branch = 'main' } = {}) {
  const base = `Quality workflow red on ${branch}`;
  const n = failures.tests.length;
  if (n > 0) return `${base} — ${n} failing test${n === 1 ? '' : 's'}`;
  if (failures.coverage.length) return `${base} — coverage below floor`;
  if (failures.other.length) return `${base} — ${failures.failedJobs.map((job) => cell(job.name, 60)).join(', ')}`.slice(0, 200);
  return `${base} — job failed without a named test`;
}

/** Markdown body/comment. Deterministic; names, paths, lines and redacted error heads only. */
export function buildIssueBody({ run, verdict, failures = null, now = new Date(), serverUrl = 'https://github.com', repository = '' }) {
  const lines = [MARKER, runMarker(run.id)];
  const day = now.toISOString().slice(0, 10);
  const workflow = run.name || 'Celia quality & resilience';
  const runUrl = run.html_url || (repository ? `${serverUrl}/${repository}/actions/runs/${run.id}` : `run ${run.id}`);
  lines.push(`### ${workflow} — ${verdict === 'green' ? '✅ green' : '❌ red'} on \`${run.head_branch || 'main'}\` (${day})`);
  lines.push('');
  lines.push(`Run: ${runUrl} · Commit: \`${short(run.head_sha)}\` · Event: ${run.event || 'push'} · Conclusion: \`${run.conclusion || '?'}\``);
  if (verdict === 'green') {
    lines.push('');
    lines.push('Closed automatically: `main` is green again. Nothing was retried, patched or rolled back by automation.');
    return lines.join('\n');
  }
  const f = failures || collectFailures();
  if (f.failedJobs.length) lines.push(`Failed jobs: ${f.failedJobs.map((job) => `\`${cell(job.name, 80)}\``).join(', ')}`);
  if (f.tests.length) {
    lines.push('');
    lines.push('| # | test | file:line | job | error (head) |');
    lines.push('|---|---|---|---|---|');
    f.tests.slice(0, MAX_ROWS).forEach((entry, index) => {
      const location = entry.line ? `${entry.file}:${entry.line}` : entry.file;
      lines.push(`| ${index + 1} | \`${cell(entry.title, 120)}\` | \`${pathCell(location)}\` | ${cell(entry.job, 60)} | ${cell(entry.message, 200)} |`);
    });
    if (f.tests.length > MAX_ROWS) lines.push(`| … | and ${f.tests.length - MAX_ROWS} more — see the run annotations | | | |`);
  }
  if (f.coverage.length) {
    lines.push('');
    for (const entry of f.coverage) lines.push(`Coverage: ${cell(entry.message, 200)} (${cell(entry.job, 60)})`);
  }
  if (f.summary.length) {
    lines.push('');
    for (const entry of f.summary) lines.push(`Reporter summary (${cell(entry.job, 60)}): ${cell(entry.message, 300)}`);
  }
  if (f.other.length) {
    lines.push('');
    for (const entry of f.other.slice(0, 10)) lines.push(`- ${cell(entry.job, 60)}: ${entry.title ? `**${cell(entry.title, 80)}** — ` : ''}${cell(entry.message, 200)}`);
  }
  if (f.silentJobs.length) {
    lines.push('');
    lines.push(`Failed without a named test (open the job log): ${f.silentJobs.map((job) => (job.url ? `[${cell(job.name, 80)}](${job.url})` : `\`${cell(job.name, 80)}\``)).join(', ')}`);
  }
  lines.push('');
  lines.push('Reproduce: `npm run test:ci` · `GITHUB_ACTIONS=true npm run test:coverage:ci` · browser: `npm run test:browser` · continuity: `npm run check:continuity`');
  lines.push('');
  lines.push('What happens next: nothing automatic. No retry, no generated patch, no rollback, no merge (DEC-039, DEC-041). Fix on a branch, open a PR; this issue closes itself on the next green run of `main`.');
  return lines.join('\n');
}

/** The single write decision. Pure. */
export function decide({ verdict, openIssue = null, alreadyRecorded = false }) {
  if (verdict === 'skip') return 'noop';
  if (verdict === 'green') return openIssue ? 'close' : 'noop';
  if (!openIssue) return 'create';
  return alreadyRecorded ? 'noop' : 'comment';
}

function gh(args, { env, allowFailure = false } = {}) {
  const result = spawnSync('gh', args, { encoding: 'utf8', env });
  if (result.status !== 0 && !allowFailure) throw new Error(`gh ${args[0]} ${args[1] || ''} failed (${result.status}): ${String(result.stderr || '').trim().slice(0, 300)}`);
  return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

const api = (route, env) => JSON.parse(gh(['api', route], { env }).stdout || 'null');

/** Live reads through `gh api`, or the fixture when one is given — same shape either way. */
export function loadRunData({ runId, repository, env, fixture = null }) {
  if (fixture) {
    const data = JSON.parse(readFileSync(path.resolve(fixture), 'utf8'));
    return { run: data.run || null, jobs: data.jobs || [], annotationsByJob: data.annotations || {}, latest: data.latest || null };
  }
  const run = api(`repos/${repository}/actions/runs/${runId}`, env);
  const jobs = api(`repos/${repository}/actions/runs/${runId}/jobs?per_page=100`, env)?.jobs || [];
  const annotationsByJob = {};
  for (const job of jobs) {
    if (!RED.has(job.conclusion)) continue;
    annotationsByJob[job.id] = api(`repos/${repository}/check-runs/${job.id}/annotations?per_page=100`, env) || [];
  }
  const latest = api(`repos/${repository}/actions/workflows/${WORKFLOW_FILE}/runs?branch=${encodeURIComponent(run?.head_branch || 'main')}&event=push&status=completed&per_page=1`, env)?.workflow_runs?.[0] || null;
  return { run, jobs, annotationsByJob, latest };
}

export function findOpenIssue(env) {
  const list = gh(['issue', 'list', '--label', LABEL, '--state', 'open', '--limit', '1', '--json', 'number,body'], { env });
  const parsed = JSON.parse(list.stdout || '[]');
  return Array.isArray(parsed) && parsed[0]?.number ? { number: Number(parsed[0].number), body: String(parsed[0].body || '') } : null;
}

export function issueRecordsRun(issue, runId, env) {
  const marker = runMarker(runId);
  if (issue.body.includes(marker)) return true;
  const comments = gh(['issue', 'view', String(issue.number), '--json', 'comments', '--jq', '[.comments[].body] | join("\\n")'], { env, allowFailure: true });
  return comments.stdout.includes(marker);
}

export async function main({ argv = process.argv.slice(2), env = process.env, log = console.log } = {}) {
  const options = parseArgs(argv);
  const repository = env.GH_REPO || env.GITHUB_REPOSITORY || 'celiaelazamey-arch/phone-google';
  const ghEnv = { ...env, GH_TOKEN: env.GH_TOKEN || env.GITHUB_TOKEN || '', GH_REPO: repository };
  if (!options.fixture && !ghEnv.GH_TOKEN) throw new Error('GH_TOKEN (actions:read, checks:read, issues:write) is required');

  const { run, jobs, annotationsByJob, latest } = loadRunData({ runId: options.run, repository, env: ghEnv, fixture: options.fixture });
  const { verdict, reason } = classifyRun(run, { branch: options.branch, latest });
  if (verdict === 'skip') {
    log(`::notice title=QA-009 · ci-failure notify::run ${options.run} skipped — ${reason}`);
    return 0;
  }
  const failures = verdict === 'red' ? collectFailures({ jobs, annotationsByJob }) : null;
  const body = buildIssueBody({ run, verdict, failures, repository, serverUrl: env.GITHUB_SERVER_URL || 'https://github.com' });
  const title = verdict === 'red' ? buildTitle(failures, { branch: options.branch }) : TITLE;

  if (options.dryRun) {
    log(`::notice title=QA-009 · ci-failure notify::dry run — verdict ${verdict}, ${failures ? `${failures.tests.length} named test(s), ${failures.failedJobs.length} failed job(s)` : 'no failures'}`);
    log(`title: ${title}`);
    log(body);
    return 0;
  }

  gh(['label', 'create', LABEL, '--description', 'QA-009: Celia quality & resilience is red on main', '--color', 'B60205', '--force'], { env: ghEnv, allowFailure: true });
  const openIssue = findOpenIssue(ghEnv);
  const alreadyRecorded = openIssue && verdict === 'red' ? issueRecordsRun(openIssue, run.id, ghEnv) : false;
  const action = decide({ verdict, openIssue, alreadyRecorded });

  const bodyFile = path.join(mkdtempSync(path.join(tmpdir(), 'ci-failure-')), 'body.md');
  writeFileSync(bodyFile, body, 'utf8');

  if (action === 'noop') {
    log(`::notice title=QA-009 · ci-failure notify::${verdict} run ${run.id} — nothing to do${openIssue ? ` (issue #${openIssue.number} already records it)` : ' (no open tracking issue)'}`);
  } else if (action === 'close') {
    gh(['issue', 'comment', String(openIssue.number), '--body-file', bodyFile], { env: ghEnv });
    gh(['issue', 'close', String(openIssue.number), '--comment', `Closed automatically: run ${run.id} on main passed.`], { env: ghEnv });
    log(`::notice title=QA-009 · ci-failure notify::main is green — closed issue #${openIssue.number}`);
  } else if (action === 'comment') {
    gh(['issue', 'comment', String(openIssue.number), '--body-file', bodyFile], { env: ghEnv });
    log(`::warning title=QA-009 · ci-failure notify::main still red — appended run ${run.id} to issue #${openIssue.number}`);
  } else {
    const created = gh(['issue', 'create', '--title', title, '--label', LABEL, '--body-file', bodyFile], { env: ghEnv });
    log(`::warning title=QA-009 · ci-failure notify::main is red — opened ${created.stdout.trim()}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`::error title=QA-009 · ci-failure notify::${error.message}`);
    process.exit(1);
  });
}

export const __filename = fileURLToPath(import.meta.url);
