#!/usr/bin/env node
/**
 * PLAN-002 — the completion plan is bound to the repository, not to the prose that described it.
 *
 * `docs/plan-system-completion.md` is only worth the numbers in it. This gate makes those numbers
 * impossible to drift by hand:
 *
 *   1. Inventory — every OPEN row in `docs/continuity/BACKLOG.md` must appear in exactly one wave of
 *      the plan (W1..W6), no wave may declare a count it does not list, and no task id may be
 *      invented. Closing or adding a backlog row therefore fails here until the plan is updated in
 *      the same change: a plan that lags the register is a second, wrong source of truth.
 *   2. Baseline  — every row of §2 carries a machine key. A key with a live rule is recomputed now
 *      (grants, tools, MCP surface, version, dependencies, coverage floor, syntax files, continuity
 *      counts, sandbox/egress defaults, open-task totals); a key without one must be declared in
 *      `DATED_KEYS` so a "just trust the document" number cannot be smuggled in silently.
 *   3. Links     — every local link in the plan resolves to a real file.
 *
 * Deterministic and offline. No writes, no network, no clock: the same tree always prints the same
 * verdict, and `--check` exits 1 with one named error per drift instead of a diff.
 *
 * Usage:
 *   node scripts/check-plan-coverage.mjs           # verify and print the measured summary
 *   node scripts/check-plan-coverage.mjs --check   # same verdict, no summary line on success
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PLAN_PATH = 'docs/plan-system-completion.md';
export const BACKLOG_PATH = 'docs/continuity/BACKLOG.md';
export const CLOSED_STATUSES = Object.freeze(['متحقق', 'منجز توثيقيًا', 'منشور']);

/**
 * §2 rows that are measurements of a single, dated run. They are *not* recomputed here, and this list
 * is the only place that is allowed to say so. Adding a key here is a decision, not a formality.
 */
export const DATED_KEYS = Object.freeze(['tests', 'coverage', 'skills', 'deploy', 'tenants']);

const TASK_ID = /\b[A-Z]{2,8}-\d{3}\b/g;

/** Rows of the BACKLOG register: `| ID | priority | status | depends-on | text |`. */
export function parseBacklogRows(markdown) {
  const tasks = new Map();
  for (const row of markdown.split('\n')) {
    if (!/^\| [A-Z]{2,8}-\d{3} /.test(row)) continue;
    const cells = row.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
    if (cells.length !== 5) continue;
    if (tasks.has(cells[0])) continue;
    const status = cells[2];
    tasks.set(cells[0], {
      id: cells[0],
      priority: cells[1],
      status,
      closed: CLOSED_STATUSES.some((prefix) => status.startsWith(prefix))
    });
  }
  return tasks;
}

export function openTasksOf(tasks) {
  return [...tasks.values()].filter((task) => !task.closed);
}

/** The §3 inventory table: `| **W1** title | TASK-001 · TASK-002 | 7 | L |`. */
export function parseWaves(markdown) {
  const waves = [];
  for (const row of markdown.split('\n')) {
    if (!/^\|\s*\*\*W\d\*\*/.test(row)) continue;
    const cells = row.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
    if (cells.length < 4) continue;
    const label = /\*\*(W\d)\*\*/.exec(cells[0]);
    if (!label) continue;
    waves.push({
      wave: label[1],
      title: cells[0].replace(/\*\*/g, '').replace(/`/g, '').trim(),
      tasks: cells[1].match(TASK_ID) || [],
      declared: Number.parseInt(cells[2], 10)
    });
  }
  return waves;
}

/** The §2 baseline table: `| \`key\` | indicator | value | command | binding |`. */
export function parseBaseline(markdown) {
  const rows = [];
  for (const row of markdown.split('\n')) {
    const match = /^\|\s*`([a-z_]+)`\s*\|/.exec(row);
    if (!match) continue;
    const cells = row.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
    if (cells.length < 5) continue;
    rows.push({ key: match[1], value: cells[2], command: cells[3], binding: cells[4] });
  }
  return rows;
}

export function parseContinuitySummary(stdout) {
  const match = /(\d+) documents?, (\d+) local links?, (\d+) unique tasks?/.exec(stdout);
  if (!match) return null;
  return { documents: Number(match[1]), links: Number(match[2]), tasks: Number(match[3]) };
}

export function parseSyntaxScope(checkSource) {
  const match = /for \(const directory of \[([^\]]+)\]\)/.exec(checkSource);
  if (!match) return null;
  return match[1]
    .split(',')
    .map((name) => name.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/** The count `npm run check` would print, without spawning 251 processes. */
export async function countSyntaxFiles(root) {
  const scope = parseSyntaxScope(await readFile(path.join(root, 'scripts/check.mjs'), 'utf8'));
  if (!scope) return null;
  const files = ['playwright.config.js'];
  for (const directory of scope) {
    const entries = await readdir(path.join(root, directory), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && /\.(m?js)$/.test(entry.name)) files.push(path.join(directory, entry.name));
    }
  }
  return files.length;
}

/** `5 prod · 2 dev`, from package.json itself. */
export function parseDependencyCounts(pkg) {
  return {
    prod: Object.keys(pkg.dependencies || {}).length,
    dev: Object.keys(pkg.devDependencies || {}).length
  };
}

/** `--test-coverage-lines=89` and friends, so the floor in the plan is the floor CI enforces. */
export function parseCoverageFloor(pkg) {
  const script = String(pkg.scripts?.['test:coverage'] || '');
  const read = (name) => {
    const match = new RegExp(`--test-coverage-${name}=(\\d+)`).exec(script);
    return match ? Number(match[1]) : null;
  };
  return { lines: read('lines'), branches: read('branches'), functions: read('functions') };
}

/** The first two numbers of a value cell, e.g. `14 (5 بموافقة)` → `14,5`. */
function leadingNumbers(value, count = 2) {
  // `22 P0 · 30 P1` must read as 22/30/7, not 22/0/30/1 — the priority token is not a measurement.
  return (value.replace(/\bP\d\b/g, '').match(/\d+/g) || []).slice(0, count).map(Number);
}

function sameTriple(value, actual) {
  const numbers = leadingNumbers(value, 3);
  return numbers.length === 3 && numbers.every((number, index) => number === actual[index]);
}

/**
 * Pure verdict: no filesystem, no spawn. `facts` is what the repository says now; `plan` and
 * `backlog` are the two documents under test. Every mutation test in
 * `test/plan-system-completion.test.js` drives this function directly.
 */
export function evaluate({ plan, backlog, facts }) {
  const errors = [];
  const tasks = parseBacklogRows(backlog);
  const open = openTasksOf(tasks);
  const openIds = new Set(open.map((task) => task.id));
  const waves = parseWaves(plan);

  if (!waves.length) errors.push('plan: §3 inventory has no wave rows (expected W1..W6)');

  const seen = new Map();
  for (const wave of waves) {
    if (!Number.isFinite(wave.declared)) {
      if (wave.tasks.length) errors.push(`plan: ${wave.wave} lists tasks but declares no count`);
    } else if (wave.declared !== wave.tasks.length)
      errors.push(`plan: ${wave.wave} declares ${wave.declared} tasks but lists ${wave.tasks.length}`);
    for (const id of wave.tasks) {
      if (seen.has(id)) errors.push(`plan: ${id} appears in ${seen.get(id)} and ${wave.wave} — one task, one wave`);
      else seen.set(id, wave.wave);
    }
  }
  for (const id of seen.keys()) {
    if (!tasks.has(id)) errors.push(`plan: ${id} is not a BACKLOG task`);
    else if (!openIds.has(id)) errors.push(`plan: ${id} is closed in BACKLOG but still scheduled in ${seen.get(id)}`);
  }
  for (const id of openIds) {
    if (!seen.has(id)) errors.push(`plan: ${id} is open in BACKLOG but belongs to no wave`);
  }

  const summary = summarize({ tasks, open, waves });
  const ruleFacts = { ...facts, openTasks: summary };
  const baseline = parseBaseline(plan);
  for (const row of baseline) {
    const rule = LIVE_RULES[row.key];
    if (rule) {
      const problem = rule(row.value, ruleFacts);
      if (problem) errors.push(`plan: baseline "${row.key}" ${problem}`);
    } else if (!DATED_KEYS.includes(row.key)) {
      errors.push(`plan: baseline "${row.key}" has no live rule — wire it or declare it dated in DATED_KEYS`);
    } else if (row.binding.includes('🔗')) {
      errors.push(`plan: baseline "${row.key}" is dated but marked 🔗 (live) — the gate would not recompute it`);
    }
  }
  for (const key of LIVE_RULES_KEYS) {
    if (!baseline.some((row) => row.key === key))
      errors.push(`plan: baseline row "${key}" is missing — a measured number was dropped, not fixed`);
  }

  for (const [index, line] of plan.split('\n').entries()) {
    for (const match of line.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const href = match[1];
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href) || href.startsWith('#')) continue;
      const gone = facts.missingLinks?.find((missing) => missing.href === href);
      if (gone) errors.push(`plan: line ${index + 1} links ${href}, which does not exist`);
    }
  }

  return { ok: errors.length === 0, errors, facts: summary };
}

function summarize({ tasks, open, waves }) {
  const byPriority = { P0: 0, P1: 0, P2: 0 };
  for (const task of open) byPriority[task.priority] = (byPriority[task.priority] || 0) + 1;
  return {
    total: tasks.size,
    open: open.length,
    byPriority,
    waves: Object.fromEntries(waves.map((wave) => [wave.wave, wave.tasks.length]))
  };
}

/** One rule per live baseline row. A rule returns `null` when the document agrees with the repository. */
const LIVE_RULES = {
  open_tasks: (value, facts) => {
    const [total, p0, p1, p2] = leadingNumbers(value, 4);
    const expected = [facts.openTasks.open, facts.openTasks.byPriority.P0, facts.openTasks.byPriority.P1, facts.openTasks.byPriority.P2];
    const actual = [total, p0, p1, p2];
    return actual.every((number, index) => number === expected[index])
      ? null
      : `says ${actual.join(' / ')} but BACKLOG has ${expected.join(' / ')} (open / P0 / P1 / P2)`;
  },
  grants: (value, facts) => (leadingNumbers(value, 1)[0] === facts.grants ? null : `says ${leadingNumbers(value, 1)[0]} but access-policy.js has ${facts.grants}`),
  agent_tools: (value, facts) => {
    const [total, approval] = leadingNumbers(value, 2);
    return total === facts.agentTools && approval === facts.agentToolsWithApproval
      ? null
      : `says ${total}/${approval} but createDefaultTools() has ${facts.agentTools}/${facts.agentToolsWithApproval}`;
  },
  mcp_tools: (value, facts) => (leadingNumbers(value, 1)[0] === facts.mcpTools ? null : `says ${leadingNumbers(value, 1)[0]} but MCP_TOOLS has ${facts.mcpTools}`),
  version: (value, facts) => (value.startsWith(facts.version) ? null : `says ${value} but package.json is ${facts.version}`),
  deps: (value, facts) => {
    const [prod, dev] = leadingNumbers(value, 2);
    return prod === facts.deps.prod && dev === facts.deps.dev ? null : `says ${prod} prod / ${dev} dev but package.json has ${facts.deps.prod}/${facts.deps.dev}`;
  },
  coverage_floor: (value, facts) => (sameTriple(value, [facts.floor.lines, facts.floor.branches, facts.floor.functions]) ? null : `says ${value} but test:coverage enforces ${facts.floor.lines}/${facts.floor.branches}/${facts.floor.functions}`),
  syntax_files: (value, facts) => (leadingNumbers(value, 1)[0] === facts.syntaxFiles ? null : `says ${leadingNumbers(value, 1)[0]} but npm run check scans ${facts.syntaxFiles}`),
  continuity: (value, facts) => (sameTriple(value, [facts.continuity.documents, facts.continuity.links, facts.continuity.tasks]) ? null : `says ${value} but check:continuity reports ${facts.continuity.documents}/${facts.continuity.links}/${facts.continuity.tasks}`),
  sandbox: (value, facts) => (value.replace(/`/g, '').trim() === facts.sandbox ? null : `says ${value} but the runtime default is ${facts.sandbox}`),
  egress: (value, facts) => (value.replace(/`/g, '').trim() === facts.egress ? null : `says ${value} but the runtime default is ${facts.egress}`)
};
const LIVE_RULES_KEYS = Object.keys(LIVE_RULES);

async function exists(root, href) {
  const target = path.resolve(root, path.dirname(PLAN_PATH), decodeURIComponent(href.split(/[?#]/)[0]));
  return (await stat(target).catch(() => null))?.isFile() === true;
}

export async function collectFacts(root, plan) {
  const { GRANT_IDS } = await import(pathToFileURL(path.join(root, 'src/agent/access-policy.js')).href);
  const { createDefaultTools } = await import(pathToFileURL(path.join(root, 'src/agent/tools.js')).href);
  const { RELEASE } = await import(pathToFileURL(path.join(root, 'src/version.js')).href);
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const runtime = await readFile(path.join(root, 'src/agent/index.js'), 'utf8');
  const mcpSource = await readFile(path.join(root, 'src/celia-mcp.js'), 'utf8');

  const tools = createDefaultTools();
  const list = Array.isArray(tools) ? tools : typeof tools?.list === 'function' ? tools.list() : Object.values(tools || {});
  const mcpBlock = mcpSource.slice(mcpSource.indexOf('export const MCP_TOOLS'), mcpSource.indexOf('export const EXTENDED_MCP_TOOLS'));

  const continuityRun = spawnSync(process.execPath, ['scripts/check-continuity.mjs'], { cwd: root, encoding: 'utf8' });
  const continuity = parseContinuitySummary(`${continuityRun.stdout || ''}${continuityRun.stderr || ''}`);

  const missingLinks = [];
  for (const match of plan.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1];
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href) || href.startsWith('#')) continue;
    if (!(await exists(root, href))) missingLinks.push({ href });
  }

  return {
    grants: GRANT_IDS.length,
    agentTools: list.length,
    agentToolsWithApproval: list.filter((tool) => tool?.requiresApproval || tool?.requires_approval).length,
    mcpTools: (mcpBlock.match(/\n\s*name: '/g) || []).length,
    version: RELEASE.version,
    deps: parseDependencyCounts(pkg),
    floor: parseCoverageFloor(pkg),
    syntaxFiles: await countSyntaxFiles(root),
    continuity: continuity || { documents: -1, links: -1, tasks: -1 },
    continuityError: continuityRun.status === 0 ? null : `${(continuityRun.stderr || continuityRun.stdout || '').trim().split('\n')[0]}`,
    sandbox: (runtime.match(/CELIA_AGENT_SANDBOX \|\| '([^']+)'/) || [, 'unknown'])[1],
    egress: (runtime.match(/CELIA_AGENT_EGRESS \|\| '([^']+)'/) || [, 'unknown'])[1],
    missingLinks
  };
}

export async function checkPlan({ root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') } = {}) {
  const plan = await readFile(path.join(root, PLAN_PATH), 'utf8');
  const backlog = await readFile(path.join(root, BACKLOG_PATH), 'utf8');
  const facts = await collectFacts(root, plan);
  const verdict = evaluate({ plan, backlog, facts });
  if (facts.continuityError) verdict.errors.push(`plan: check:continuity could not be read — ${facts.continuityError}`);
  return { ...verdict, ok: verdict.errors.length === 0, facts: { ...verdict.facts, ...facts } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check');
  const result = await checkPlan();
  if (!result.ok) {
    console.error(result.errors.join('\n'));
    console.error(`Plan coverage failed: ${result.errors.length} drift(s) between ${PLAN_PATH} and the repository.`);
    process.exit(1);
  }
  if (!check) {
    const { open, byPriority, waves } = result.facts;
    console.log(
      `Plan verified: ${open} open tasks (P0 ${byPriority.P0} · P1 ${byPriority.P1} · P2 ${byPriority.P2}) in ${Object.keys(waves).length} waves ` +
        `(${Object.entries(waves).map(([wave, count]) => `${wave}:${count}`).join(' ')}); ` +
        `${result.facts.grants} grants · ${result.facts.agentTools} agent tools · ${result.facts.mcpTools} MCP tools · ${result.facts.syntaxFiles} files · ` +
        `continuity ${result.facts.continuity.documents}/${result.facts.continuity.links}/${result.facts.continuity.tasks}.`
    );
  }
}
