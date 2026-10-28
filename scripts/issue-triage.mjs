#!/usr/bin/env node
/**
 * Governed issue triage — the only place that writes.
 *
 * The decision is made by `src/agent/issue-triage` (pure). This script fetches the issue and the ledger, asks for a
 * decision, and performs *only* the effects the gate returned: allowlisted labels, an allowlisted assignee, and
 * comments. It has no code path that edits a file, opens a branch or PR, touches a workflow, a secret or a
 * deployment — those effects do not exist here, so they cannot be added by accident at runtime.
 *
 * Storage is the repository's own issue comments (an append-only ledger issue), which is why the loop needs no
 * database, no secret and no paid tier.
 *
 * Usage:
 *   node scripts/issue-triage.mjs --issue 42 [--mode propose|cautious] [--apply] [--json]
 *   node scripts/issue-triage.mjs --rollback <record-id> [--apply]
 *   node scripts/issue-triage.mjs --event "$GITHUB_EVENT_PATH"
 * Environment: GH_TOKEN (issues:write), GITHUB_REPOSITORY, GITHUB_RUN_URL (optional).
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { triageIssue, resolveMode, TRIAGE_POLICY_VERSION } from '../src/agent/issue-triage/index.js';
import {
  autoAppliedToday,
  parseLedgerComments,
  verifyDecisionChain,
  withinRollbackWindow
} from '../src/agent/issue-triage/audit.js';
import { LABEL_COLORS, LEDGER_LABEL, LEDGER_TITLE } from '../src/agent/issue-triage/policy.js';

export function parseArgs(argv) {
  const options = {
    issue: null,
    event: null,
    mode: resolveMode(process.env.TRIAGE_MODE, 'cautious'),
    apply: false,
    json: false,
    ledger: null,
    rollback: null,
    reviewer: process.env.TRIAGE_REVIEWER || 'github-actions'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--issue') options.issue = Number(argv[++i]);
    else if (arg === '--event') options.event = String(argv[++i]);
    else if (arg === '--mode') options.mode = resolveMode(argv[++i], options.mode);
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--ledger') options.ledger = Number(argv[++i]);
    else if (arg === '--rollback') options.rollback = String(argv[++i]);
    else if (arg === '--reviewer') options.reviewer = String(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.issue === null && !options.event && !options.rollback) {
    throw new Error('one of --issue, --event or --rollback is required');
  }
  if (options.issue !== null && !Number.isInteger(options.issue)) throw new Error('--issue must be an integer');
  return options;
}

export function gh(args, { allowFailure = false } = {}) {
  const result = spawnSync('gh', args, { encoding: 'utf8', env: process.env });
  if (result.status !== 0) {
    if (allowFailure) return { ok: false, stdout: result.stdout || '', stderr: result.stderr || '' };
    throw new Error(`gh ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim().slice(0, 400)}`);
  }
  return { ok: true, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function ghJson(args, options) {
  const result = gh(args, options);
  if (!result.ok) return null;
  const text = result.stdout.trim();
  if (!text) return null;
  return JSON.parse(text);
}

/** `gh api --paginate` emits one JSON array per page; read them as lines so >100 ledger entries still parse. */
export function ghLines(args) {
  const result = gh([...args.slice(0, 1), '--paginate', '--jq', '.[]', ...args.slice(1)], { allowFailure: true });
  if (!result.ok) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function repository(explicit) {
  const repo = explicit || process.env.GITHUB_REPOSITORY;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GITHUB_REPOSITORY (owner/name) is required');
  return repo;
}

/** Find the single ledger issue, creating it (and its label) on first use. */
export function resolveLedger(repo, { existing = null, apply = false } = {}) {
  if (existing) return existing;
  const found = ghJson(['api', `repos/${repo}/issues?labels=${encodeURIComponent(LEDGER_LABEL)}&state=all&per_page=5`]);
  if (Array.isArray(found) && found.length) return found[0].number;
  if (!apply) return null;
  ensureLabels(repo, [LEDGER_LABEL], { apply });
  const created = ghJson([
    'api', '-X', 'POST', `repos/${repo}/issues`,
    '-f', `title=${LEDGER_TITLE}`,
    '-f', 'body=Append-only audit trail for governed issue triage (AGENT-006). One comment per decision; each carries a hash-chained record. Maintained by the governed issue-triage workflow.',
    '-f', `labels[]=${LEDGER_LABEL}`
  ]);
  return created?.number ?? null;
}

/** Labels must exist before they can be applied, otherwise the first real decision fails with HTTP 422. */
export function ensureLabels(repo, labels, { apply = false } = {}) {
  const unique = [...new Set(labels)];
  if (!unique.length) return [];
  const existing = ghJson(['api', `repos/${repo}/labels?per_page=100`]) || [];
  const known = new Set(existing.map((label) => label.name));
  const missing = unique.filter((label) => !known.has(label));
  if (!apply) return missing;
  for (const label of missing) {
    gh(['api', '-X', 'POST', `repos/${repo}/labels`, '-f', `name=${label}`, '-f', `color=${LABEL_COLORS[label] || 'ededed'}`, '-f', `description=${label.startsWith('triage:') ? 'governed issue triage' : 'applied by governed triage'}`]);
  }
  return missing;
}

/**
 * Turn a decision into the exact write list. Kept pure so the plan can be printed, diffed and tested without
 * touching a repository.
 */
export function buildPlan({ result, issue, ledgerNumber }) {
  const effects = [];
  if (!result || result.skipped) return { effects, issueComment: null, ledgerRecord: null };
  const { decision, record } = result;
  if (decision.route === 'auto') {
    for (const label of decision.labels) effects.push({ effect: 'label', value: label, issue: issue.number });
    if (decision.assignee) effects.push({ effect: 'assignee', value: decision.assignee, issue: issue.number });
  }
  const issueComment = decision.route === 'reject' ? null : result.comment;
  effects.push({ effect: 'record', value: record.id.slice(0, 12), issue: ledgerNumber ?? 'ledger-missing' });
  return { effects, issueComment, ledgerRecord: result.comment };
}

/** Rollback is a policy question, not an API call: window, route and what was actually applied. */
export function planRollback(record, { now = new Date(), issueNumber } = {}) {
  if (!record) return { allowed: false, reason: 'record_not_found', removeLabels: [], assignee: null };
  if (issueNumber && record.issue?.number !== Number(issueNumber)) {
    return { allowed: false, reason: 'record_belongs_to_another_issue', removeLabels: [], assignee: null };
  }
  if (record.decision?.route !== 'auto') return { allowed: false, reason: 'record_did_not_change_the_issue', removeLabels: [], assignee: null };
  if (!withinRollbackWindow(record, now)) return { allowed: false, reason: 'rollback_window_expired', removeLabels: [], assignee: null };
  return {
    allowed: true,
    reason: 'within_window',
    removeLabels: [...(record.applied?.labels || [])],
    assignee: record.applied?.assignee || null,
    deadline: record.rollback?.deadline
  };
}

export function readEvent(eventPath) {
  if (!eventPath) return null;
  const raw = JSON.parse(readFileSync(eventPath, 'utf8'));
  const issue = raw.issue;
  if (!issue) return null;
  return {
    number: issue.number,
    title: issue.title || '',
    body: issue.body || '',
    url: issue.html_url || null,
    action: raw.action || 'opened'
  };
}

export function fetchIssue(repo, number) {
  const issue = ghJson(['api', `repos/${repo}/issues/${number}`]);
  if (!issue) throw new Error(`issue #${number} not found`);
  if (issue.pull_request) return null; // pull requests are outside this loop
  return { number: issue.number, title: issue.title || '', body: issue.body || '', url: issue.html_url || null };
}

export function readLedger(repo, ledgerNumber) {
  if (!ledgerNumber) return { comments: [], records: [], chain: { ok: true, count: 0 } };
  const comments = ghLines(['api', `repos/${repo}/issues/${ledgerNumber}/comments?per_page=100`]);
  const records = parseLedgerComments(comments);
  return { comments, records, chain: verifyDecisionChain(records) };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const repo = repository();
  const runUrl = process.env.GITHUB_RUN_URL || null;

  if (options.rollback) {
    const { records } = readLedger(repo, options.ledger ?? resolveLedger(repo));
    const record = records.find((entry) => String(entry.id || '').startsWith(options.rollback));
    const plan = planRollback(record, { now: new Date(), issueNumber: record?.issue?.number });
    if (!plan.allowed) {
      console.error(`rollback refused: ${plan.reason}`);
      process.exit(2);
    }
    if (!options.apply) {
      console.log(JSON.stringify({ dryRun: true, rollback: plan }, null, 2));
      return;
    }
    const issueNumber = record.issue.number;
    if (plan.removeLabels.length) {
      gh(['api', '-X', 'DELETE', `repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(plan.removeLabels.join(','))}`]);
    }
    gh(['api', '-X', 'POST', `repos/${repo}/issues/${issueNumber}/comments`, '-f', `body=↩️ **تم التراجع** عن القرار \`${record.id.slice(0, 12)}\` بواسطة ${options.reviewer}.${plan.removeLabels.length ? ` أُزيلت: ${plan.removeLabels.join(', ')}.` : ''}`]);
    console.log(JSON.stringify({ rolledBack: record.id, issue: issueNumber, removed: plan.removeLabels }, null, 2));
    return;
  }

  const eventIssue = options.event ? readEvent(options.event) : null;
  const issue = eventIssue || fetchIssue(repo, options.issue);
  if (!issue) {
    console.log(JSON.stringify({ skipped: true, reason: 'not_an_issue' }));
    return;
  }

  const ledgerNumber = options.ledger ?? resolveLedger(repo);
  const { records, chain } = readLedger(repo, ledgerNumber);
  const result = triageIssue({ issue, mode: options.mode, history: records, reviewer: options.reviewer });

  if (result.skipped) {
    console.log(JSON.stringify({ skipped: true, reason: result.reason, issue: issue.number, mode: options.mode }));
    return;
  }

  const plan = buildPlan({ result, issue, ledgerNumber });
  const summary = {
    policy: TRIAGE_POLICY_VERSION,
    issue: issue.number,
    mode: result.mode,
    route: result.route,
    confidence: result.proposal.confidence,
    proposal: { type: result.proposal.type, priority: result.proposal.priority, labels: result.proposal.labels },
    reasons: result.decision.reasons,
    injection: result.injection.tainted ? result.injection.ruleIds : [],
    chain: chain.ok ? `${chain.count} ok` : `BROKEN at ${chain.brokenSeq} (${chain.reason})`,
    autoAppliedToday: autoAppliedToday(records),
    effects: plan.effects,
    applied: options.apply
  };

  if (!options.apply) {
    console.log(JSON.stringify({ dryRun: true, ...summary, comment: plan.issueComment, record: plan.ledgerRecord }, null, 2));
    return;
  }

  if (result.route === 'auto') {
    ensureLabels(repo, result.decision.labels, { apply: true });
    if (result.decision.labels.length) {
      gh(['api', '-X', 'POST', `repos/${repo}/issues/${issue.number}/labels`, ...result.decision.labels.flatMap((label) => ['-f', `labels[]=${label}`])]);
    }
    if (result.decision.assignee) {
      gh(['api', '-X', 'POST', `repos/${repo}/issues/${issue.number}/assignees`, '-f', `assignees[]=${result.decision.assignee}`]);
    }
  }
  // A human route changes nothing on the issue: the comment is the recommendation, the ledger is the record.
  if (plan.issueComment) {
    gh(['api', '-X', 'POST', `repos/${repo}/issues/${issue.number}/comments`, '-f', `body=${plan.issueComment}`]);
  }
  const ledger = ledgerNumber ?? resolveLedger(repo, { apply: true });
  gh(['api', '-X', 'POST', `repos/${repo}/issues/${ledger}/comments`, '-f', `body=${plan.ledgerRecord}`]);

  console.log(JSON.stringify({ ...summary, ledger }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
