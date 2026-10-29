#!/usr/bin/env node
/**
 * Owner-only GitHub security controls — plan, apply, verify (DEC-046).
 *
 *   node scripts/security-posture-apply.mjs --plan            # print the exact API calls, no network
 *   node scripts/security-posture-apply.mjs --apply           # run them through `gh api` (needs an ADMIN token)
 *   node scripts/security-posture-apply.mjs --verify [--json] # read-only: what the API says today, in the three states
 *
 * Why this exists: the controls below (branch ruleset on `main`, Dependabot alerts + security updates, CodeQL default
 * setup, secret scanning + push protection) can only be changed with repository-administration permission. The
 * agent's token is an integration token without it — every write answers `403 Resource not accessible by integration`
 * (checked 2026-10-29) — so the owner runs `--apply` from a machine where `gh auth login` holds their own token, and
 * both sides run `--verify`, which needs no admin permission and feeds `docs/security-posture.md` §2.
 *
 * Design decisions (see DEC-046):
 *   - A *ruleset* instead of classic branch protection: its rules are readable by anyone (`GET /rules/branches/main`),
 *     so the agent can verify exactly which checks are required; classic protection details are admin-only (403).
 *   - Required checks are the repository's real quality jobs, derived from `.github/workflows/celia-mcp.yml` and pinned
 *     by a test: a wrong context name (e.g. `CI / build`) would make every pull request unmergeable.
 *   - No required reviews (single-owner repository — the author cannot approve their own PR), no "linear history" (the
 *     repository merges with merge commits and its continuity docs cite branch commit SHAs), `strict` off (PR checks
 *     already run on the merge ref), no bypass actors (the gate also binds the agent; the owner disables the ruleset in
 *     Settings → Rules in an emergency).
 *   - JSON bodies via `--input`, never `-f field=null`: `gh api -f` sends the *string* "null", which the API rejects.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const REPOSITORY = 'celiaelazamey-arch/phone-google';
export const QUALITY_WORKFLOW = '.github/workflows/celia-mcp.yml';
export const RULESET_NAME = 'main — quality gate (Celia)';
export const CODEQL_DYNAMIC_WORKFLOW = 'dynamic/github-code-scanning/codeql';

/**
 * The quality jobs every pull request must pass before merging into `main`. Matrix jobs are listed per leg, with the
 * exact names GitHub reports as status-check contexts. `test/security-posture-apply.test.js` proves this list equals
 * the non-optional jobs of the quality workflow, so a rename there fails CI before it can lock `main`.
 */
export const REQUIRED_CHECK_CONTEXTS = Object.freeze([
  'Node 22 · tests & failure recovery',
  'Node 24 · tests & failure recovery',
  'Python 3.11 · Celia Google Spider tests',
  'Node 24 container smoke test',
  'RTL dashboard · desktop / mobile / accessibility',
  'MySQL 8.4 · persistence / N−1 / backup restore'
]);

/** Job names of the quality workflow with the `${{ matrix.node }}` legs expanded — read from the YAML, no parser needed. */
export function qualityJobContexts(workflowText = readFileSync(path.join(root, QUALITY_WORKFLOW), 'utf8')) {
  const contexts = [];
  const lines = workflowText.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^ {4}name: (.+?)\s*$/);
    if (!match) continue;
    const name = match[1];
    // Find the matrix values of this job (if any) before the next job header.
    let matrixValues = null;
    for (let j = i + 1; j < lines.length && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[j]); j += 1) {
      const matrix = lines[j].match(/^ {8}node: \[(.+)\]\s*$/);
      if (matrix) matrixValues = matrix[1].split(',').map((value) => value.trim().replace(/^['"]|['"]$/g, ''));
    }
    if (name.includes('${{ matrix.node }}') && matrixValues) {
      for (const value of matrixValues) contexts.push(name.replace('${{ matrix.node }}', value));
    } else {
      contexts.push(name);
    }
  }
  return contexts;
}

export function rulesetBody({ contexts = REQUIRED_CHECK_CONTEXTS } = {}) {
  return {
    name: RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    bypass_actors: [],
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: false,
          do_not_enforce_on_create: false,
          required_status_checks: contexts.map((context) => ({ context }))
        }
      }
    ]
  };
}

/** The exact calls, in order. Pure: nothing here touches the network. */
export function plan({ repository = REPOSITORY, contexts = REQUIRED_CHECK_CONTEXTS } = {}) {
  const R = `repos/${repository}`;
  return [
    { control: 'branch_ruleset', method: 'POST', path: `${R}/rulesets`, body: rulesetBody({ contexts }), success: [201] },
    { control: 'dependabot_alerts', method: 'PUT', path: `${R}/vulnerability-alerts`, body: null, success: [204] },
    { control: 'dependabot_security_updates', method: 'PUT', path: `${R}/automated-security-fixes`, body: null, success: [204] },
    { control: 'codeql_default_setup', method: 'PATCH', path: `${R}/code-scanning/default-setup`, body: { state: 'configured', query_suite: 'default' }, success: [200, 202] },
    {
      control: 'secret_scanning',
      method: 'PATCH',
      path: R,
      body: { security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } } },
      success: [200]
    }
  ];
}

/** Runs one `gh api` call and returns { status, body } without ever throwing on HTTP errors. */
export function ghApi({ method = 'GET', path: route, body = null, run = spawnSync } = {}) {
  const args = ['api', '-i', '--method', method, '-H', 'Accept: application/vnd.github+json', route];
  if (body !== null) args.push('--input', '-');
  const result = run('gh', args, { encoding: 'utf8', input: body === null ? undefined : JSON.stringify(body) });
  const raw = String(result.stdout || '');
  const statusMatch = raw.match(/^HTTP\/[\d.]+ (\d{3})/m);
  const status = statusMatch ? Number(statusMatch[1]) : (result.status === 0 ? 200 : 0);
  const headerEnd = raw.search(/\r?\n\r?\n/);
  const text = headerEnd >= 0 ? raw.slice(headerEnd).trim() : raw.trim();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  const stderr = String(result.stderr || '').trim();
  return { status, body: parsed, text, stderr, spawnError: result.error ? String(result.error.message || result.error) : null };
}

export function classifyApply(step, response) {
  if (response.spawnError) return { outcome: 'failed', detail: `gh not runnable: ${response.spawnError}` };
  if (step.success.includes(response.status)) return { outcome: 'applied', detail: `HTTP ${response.status}` };
  if (response.status === 403) {
    return {
      outcome: 'forbidden',
      detail: `HTTP 403 — ${response.body?.message || 'forbidden'}; the token has no repository-administration permission (run this from the owner's machine after \`gh auth login\`)`
    };
  }
  if (response.status === 422 && step.control === 'branch_ruleset' && /already exists|name has already been taken/i.test(JSON.stringify(response.body || {}))) {
    return { outcome: 'already_present', detail: `HTTP 422 — a ruleset named "${RULESET_NAME}" already exists; verify it with --verify` };
  }
  return { outcome: 'failed', detail: `HTTP ${response.status} — ${response.body?.message || response.text.slice(0, 200) || response.stderr.slice(0, 200)}` };
}

export function apply({ repository = REPOSITORY, run = spawnSync, log = console.log } = {}) {
  const results = [];
  for (const step of plan({ repository })) {
    const response = ghApi({ method: step.method, path: step.path, body: step.body, run });
    const verdict = classifyApply(step, response);
    results.push({ control: step.control, method: step.method, path: step.path, ...verdict });
    log(`${verdict.outcome === 'applied' ? '✓' : verdict.outcome === 'already_present' ? '•' : '✗'} ${step.control}: ${verdict.detail}`);
  }
  const ok = results.every((entry) => entry.outcome === 'applied' || entry.outcome === 'already_present');
  return { ok, results };
}

/* ----------------------------------------------------------------------------------------------------------------- */
/* --verify: the same read-only probes the posture document cites, mapped to UNKNOWN / VERIFIED / NOT ENABLED.          */

export function verify({ repository = REPOSITORY, run = spawnSync, contexts = REQUIRED_CHECK_CONTEXTS, today = new Date().toISOString().slice(0, 10) } = {}) {
  const R = `repos/${repository}`;
  const get = (route) => ghApi({ method: 'GET', path: route, run });
  const controls = [];
  const push = (control, status, detail) => controls.push({ control, status: `${status}${status === 'UNKNOWN' ? '' : ` (${today})`}`, state: status, detail });

  // 1. Branch ruleset on main — rules are public to readers; classic protection is only visible as a flag.
  const branch = get(`${R}/branches/main`);
  const rules = get(`${R}/rules/branches/main`);
  if (rules.status === 200 && Array.isArray(rules.body)) {
    const types = new Set(rules.body.map((rule) => rule.type));
    const required = rules.body
      .filter((rule) => rule.type === 'required_status_checks')
      .flatMap((rule) => rule.parameters?.required_status_checks || [])
      .map((entry) => entry.context);
    const missingContexts = contexts.filter((context) => !required.includes(context));
    const missingRules = ['deletion', 'non_fast_forward', 'required_status_checks'].filter((type) => !types.has(type));
    const reviews = types.has('pull_request');
    if (rules.body.length === 0) {
      push('Branch protection', 'NOT ENABLED', `rules/branches/main → [] · branches/main.protected=${branch.body?.protected ?? 'n/a'}${branch.body?.protected ? ' (classic protection present but not inspectable: details are admin-only; prefer a ruleset)' : ''}`);
    } else if (missingContexts.length === 0 && missingRules.length === 0) {
      push('Branch protection', 'VERIFIED', `ruleset active: ${[...types].join(', ')} · ${required.length} required checks${reviews ? ' · WARNING: pull_request reviews required — a single owner cannot approve their own PR' : ''}`);
    } else {
      push('Branch protection', 'NOT ENABLED', `ruleset present but incomplete — missing rules: [${missingRules.join(', ')}] missing checks: [${missingContexts.join(' | ')}]`);
    }
  } else {
    push('Branch protection', 'UNKNOWN', `rules/branches/main → HTTP ${rules.status}`);
  }

  // 2. Dependabot alerts — the error text is explicit when disabled; a 200 (even empty) means enabled.
  const alerts = get(`${R}/dependabot/alerts?per_page=1`);
  if (alerts.status === 200) push('Dependabot alerts', 'VERIFIED', 'dependabot/alerts → 200');
  else if (alerts.status === 403 && /disabled/i.test(alerts.body?.message || '')) push('Dependabot alerts', 'NOT ENABLED', `dependabot/alerts → 403 "${alerts.body.message}"`);
  else push('Dependabot alerts', 'UNKNOWN', `dependabot/alerts → HTTP ${alerts.status} ${alerts.body?.message || ''}`.trim());

  // 3. CodeQL default setup — admin-only to read directly, but it materialises a dynamic workflow any reader can list.
  const workflows = get(`${R}/actions/workflows?per_page=100`);
  if (workflows.status === 200) {
    const paths = (workflows.body?.workflows || []).map((entry) => entry.path);
    const codeql = paths.find((entry) => entry.includes('code-scanning'));
    if (codeql) push('CodeQL', 'VERIFIED', `${codeql} present in actions/workflows`);
    else push('CodeQL', 'NOT ENABLED', `no ${CODEQL_DYNAMIC_WORKFLOW} among ${paths.length} workflows`);
  } else {
    push('CodeQL', 'UNKNOWN', `actions/workflows → HTTP ${workflows.status}`);
  }

  // 4. Secret scanning — alerts endpoint is admin/security-manager only; a 200 proves it is on, a 404 proves it is off.
  const secrets = get(`${R}/secret-scanning/alerts?per_page=1`);
  if (secrets.status === 200) push('Secret scanning', 'VERIFIED', 'secret-scanning/alerts → 200');
  else if (secrets.status === 404 && /not enabled|disabled/i.test(secrets.body?.message || '')) push('Secret scanning', 'NOT ENABLED', `secret-scanning/alerts → 404 "${secrets.body.message}"`);
  else push('Secret scanning', 'UNKNOWN', `secret-scanning/alerts → HTTP ${secrets.status} (not readable with this token)`);

  // 5. Default workflow permissions — admin-only; every workflow declares `permissions:` anyway (SP-01).
  const perms = get(`${R}/actions/permissions/workflow`);
  if (perms.status === 200) {
    const readOnly = perms.body?.default_workflow_permissions === 'read' && perms.body?.can_approve_pull_request_reviews === false;
    push('Workflow permissions', readOnly ? 'VERIFIED' : 'NOT ENABLED', `default=${perms.body?.default_workflow_permissions} approve_prs=${perms.body?.can_approve_pull_request_reviews}`);
  } else {
    push('Workflow permissions', 'UNKNOWN', `actions/permissions/workflow → HTTP ${perms.status}`);
  }

  return { checkedAt: today, repository, controls };
}

export function formatVerify(report) {
  const lines = [`Security posture — owner-only controls as read from the API (${report.checkedAt}, ${report.repository})`];
  for (const entry of report.controls) lines.push(`${entry.state === 'VERIFIED' ? '✓' : entry.state === 'NOT ENABLED' ? '✗' : '?'} ${entry.control}: ${entry.status} — ${entry.detail}`);
  lines.push('Legend: VERIFIED = positive read · NOT ENABLED = explicit negative read · UNKNOWN = not readable with this token (no inference).');
  return lines.join('\n');
}

export async function main({ argv = process.argv.slice(2), log = console.log, run = spawnSync } = {}) {
  const json = argv.includes('--json');
  if (argv.includes('--apply')) {
    const result = apply({ run, log });
    if (json) log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      log('Not every control was applied. Forbidden = this token lacks repository-administration permission; re-run from the owner\'s machine. Then run --verify.');
      return 1;
    }
    log('All controls applied. Run --verify to read them back.');
    return 0;
  }
  if (argv.includes('--verify')) {
    const report = verify({ run });
    log(json ? JSON.stringify(report, null, 2) : formatVerify(report));
    return report.controls.every((entry) => entry.state === 'VERIFIED') ? 0 : 2;
  }
  const steps = plan();
  log(json ? JSON.stringify(steps, null, 2) : steps.map((step) => `${step.method} ${step.path}${step.body ? `\n${JSON.stringify(step.body, null, 2)}` : ''}`).join('\n\n'));
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = await main();
}
