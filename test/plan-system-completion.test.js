/**
 * PLAN-002 — the completion plan is bound to the repository, and this file proves the binding bites.
 *
 * `docs/plan-system-completion.md` claims to be an ordering of the register, not a second source of
 * truth. That claim is only true if a machine reads both and refuses a mismatch, so these tests drive
 * `scripts/check-plan-coverage.mjs` twice: once against the real tree (must pass) and once against
 * deliberately corrupted copies (must fail with a message that names the drift). A gate that has only
 * ever seen a green tree is untested.
 *
 * They also pin the plan to **every part of the repository it is supposed to reach** — the register
 * row, the README index, the two earlier plans, the System Atlas roadmap, the changelog and the
 * handoff — because "linked" means a link a reader (and CI) can follow, not a mention in chat.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BACKLOG_PATH,
  DATED_KEYS,
  PLAN_PATH,
  checkPlan,
  countSyntaxFiles,
  evaluate,
  openTasksOf,
  parseBacklogRows,
  parseBaseline,
  parseContinuitySummary,
  parseCoverageFloor,
  parseDependencyCounts,
  parseSyntaxScope,
  parseWaves
} from '../scripts/check-plan-coverage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const plan = read(PLAN_PATH);
const backlog = read(BACKLOG_PATH);

let real;
async function realRun() {
  real ??= await checkPlan({ root });
  return real;
}

/** The live facts of this tree, so a mutation of the documents is the only thing under test. */
async function liveFacts() {
  const { facts } = await realRun();
  return facts;
}

function errorsOf(result) {
  return result.errors.join('\n');
}

test('PSC-01 the real tree passes: every open task sits in exactly one wave', async () => {
  const result = await realRun();
  assert.deepEqual(result.errors, [], errorsOf(result));
  assert.equal(result.facts.open, 62, 'the register has exactly 62 open tasks on 2026-11-03');
  assert.equal(result.facts.byPriority.P0, 22);
  assert.deepEqual(Object.keys(result.facts.waves).sort(), ['W0', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6']);
  const covered = Object.values(result.facts.waves).reduce((sum, count) => sum + count, 0);
  assert.equal(covered, result.facts.open, 'waves cover the open set exactly once');
});

test('PSC-02 closing a task in BACKLOG without updating the plan fails and names it', async () => {
  const facts = await liveFacts();
  const target = [...parseBacklogRows(backlog).values()].find((task) => !task.closed && task.id === 'SEC-004');
  assert.ok(target, 'SEC-004 is expected to be open in the schedule');
  const closed = backlog.replace(
    /(\| SEC-004 \| P1 \| )جارٍ/,
    '$1متحقق'
  );
  assert.notEqual(closed, backlog, 'the fixture must actually close SEC-004');
  const result = evaluate({ plan, backlog: closed, facts });
  assert.equal(result.ok, false);
  assert.match(errorsOf(result), /SEC-004 is closed in BACKLOG but still scheduled in W1/);
});

test('PSC-03 a new open task with no wave fails, and so does an invented task id', async () => {
  const facts = await liveFacts();
  const withNewTask = backlog.replace(
    /^(\| SEC-004 \|)/m,
    '| NEW-001 | P0 | مخطط | — | مهمة جديدة بلا حزمة |\n$1'
  );
  const added = evaluate({ plan, backlog: withNewTask, facts });
  assert.match(errorsOf(added), /NEW-001 is open in BACKLOG but belongs to no wave/);

  const invented = plan.replace('COMP-001 ·', 'COMP-999 · COMP-001 ·').replace('| 7 | L |', '| 8 | L |');
  const fake = evaluate({ plan: invented, backlog, facts });
  assert.match(errorsOf(fake), /COMP-999 is not a BACKLOG task/);
});

test('PSC-04 one task in two waves, or two tasks in one slot, is refused', async () => {
  const facts = await liveFacts();
  const duplicated = plan.replace('DATA-001 · DATA-002 · DATA-003', 'DATA-001 · DATA-001 · DATA-003');
  const result = evaluate({ plan: duplicated, backlog, facts });
  assert.match(errorsOf(result), /DATA-001 appears in W1 and W1/);

  // A task cannot be listed twice even when both waves count it "correctly" — the count is not the guard.
  const moved = plan.replace('LEARN-001 ·', 'LEARN-001 · SEC-004 ·').replace('| 17 | XL |', '| 18 | XL |');
  const wave = evaluate({ plan: moved, backlog, facts });
  assert.match(errorsOf(wave), /SEC-004 appears in W1 and W4/);
});

test('PSC-05 a wave that declares a count it does not list fails', async () => {
  const facts = await liveFacts();
  const result = evaluate({ plan: plan.replace('· SEC-004 | 7 | L |', '· SEC-004 | 9 | L |'), backlog, facts });
  assert.match(errorsOf(result), /W1 declares 9 tasks but lists 7/);
});

test('PSC-06 every live baseline row is recomputed, and a stale number is named', async () => {
  const facts = await liveFacts();
  const cases = [
    ['grants', '67 (`GRANT_IDS`)', '66 (`GRANT_IDS`)', /baseline "grants" says 66 but access-policy\.js has 67/],
    ['agent_tools', '17 (5 بموافقة)', '18 (5 بموافقة)', /baseline "agent_tools" says 18\/5 but createDefaultTools\(\) has 17\/5/],
    ['mcp_tools', '12 مُعلنة', '13 مُعلنة', /baseline "mcp_tools" says 13 but MCP_TOOLS has 12/],
    ['deps', '5 prod · 2 dev', '6 prod · 2 dev', /baseline "deps" says 6 prod \/ 2 dev but package\.json has 5\/2/],
    ['open_tasks', '**62** (22 P0 · 30 P1 · 10 P2)', '**61** (22 P0 · 30 P1 · 9 P2)', /baseline "open_tasks" says 61 \/ 22 \/ 30 \/ 9 but BACKLOG has 62 \/ 22 \/ 30 \/ 10/],
    ['sandbox', '| `sandbox` | العزل | off |', '| `sandbox` | العزل | exec |', /baseline "sandbox" says exec but the runtime default is off/]
  ];
  for (const [key, from, to, expected] of cases) {
    assert.ok(plan.includes(from), `the plan must still contain "${from}" for ${key} to be checked`);
    const result = evaluate({ plan: plan.replace(from, to), backlog, facts });
    assert.equal(result.ok, false, `${key} drift must fail`);
    assert.match(errorsOf(result), expected);
  }
});

test('PSC-07 dropping a live row, or dressing a dated row as live, is refused', async () => {
  const facts = await liveFacts();
  const dropped = plan.replace(/^\| `grants` \|.*$/m, '');
  assert.match(errorsOf(evaluate({ plan: dropped, backlog, facts })), /baseline row "grants" is missing/);

  assert.ok(DATED_KEYS.length > 0 && plan.includes('| `tests` |'));
  const dressed = plan.replace(/(\| `tests` \|.*\| )📅( \|)$/m, '$1🔗$2');
  assert.match(errorsOf(evaluate({ plan: dressed, backlog, facts })), /baseline "tests" is dated but marked 🔗/);

  const smuggled = plan.replace(/^\| `grants` \|.*$/m, '$&\n| `made_up` | x | 1 | y | 📅 |');
  assert.match(errorsOf(evaluate({ plan: smuggled, backlog, facts })), /baseline "made_up" has no live rule/);
});

test('PSC-08 a link to a file that is not there is a failure, not a footnote', async () => {
  const facts = await liveFacts();
  const broken = plan.replace('](../scripts/check-plan-coverage.mjs)', '](../scripts/does-not-exist.mjs)');
  const result = evaluate({ plan: broken, backlog, facts: { ...facts, missingLinks: [{ href: '../scripts/does-not-exist.mjs' }] } });
  assert.match(errorsOf(result), /links \.\.\/scripts\/does-not-exist\.mjs, which does not exist/);
});

test('PSC-09 the parsers read the two documents the way the tables are written', () => {
  const tasks = parseBacklogRows(backlog);
  assert.ok(tasks.size >= 120, `expected the full register, saw ${tasks.size}`);
  assert.equal(openTasksOf(tasks).length, 62);
  assert.equal(openTasksOf(tasks).filter((task) => task.priority === 'P0').length, 22);

  const waves = parseWaves(plan);
  assert.deepEqual(waves.map((wave) => wave.wave), ['W0', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6']);
  assert.equal(waves.find((wave) => wave.wave === 'W0').tasks.length, 0, 'W0 is work on the register, not a backlog id');
  assert.equal(waves.reduce((sum, wave) => sum + wave.tasks.length, 0), 62);

  const baseline = parseBaseline(plan);
  assert.equal(new Set(baseline.map((row) => row.key)).size, baseline.length, 'baseline keys are unique');
  for (const key of ['grants', 'agent_tools', 'mcp_tools', 'open_tasks', 'continuity', 'syntax_files', 'sandbox', 'egress']) {
    assert.ok(baseline.some((row) => row.key === key), `missing live baseline row ${key}`);
  }
  assert.deepEqual(parseContinuitySummary('Continuity verified: 136 documents, 426 local links, 122 unique tasks; ok'), {
    documents: 136,
    links: 426,
    tasks: 122
  });
  assert.deepEqual(parseDependencyCounts({ dependencies: { a: '1' }, devDependencies: { b: '1', c: '1' } }), { prod: 1, dev: 2 });
  assert.deepEqual(
    parseCoverageFloor({ scripts: { 'test:coverage': 'x --test-coverage-lines=89 --test-coverage-branches=71 --test-coverage-functions=82' } }),
    { lines: 89, branches: 71, functions: 82 }
  );
});

test('PSC-10 the file count in the plan is derived from the scope of `npm run check`, not typed', async () => {
  const scope = parseSyntaxScope(read('scripts/check.mjs'));
  assert.deepEqual(scope, ['src', 'test', 'public', 'scripts', 'e2e', 'integration']);
  const counted = await countSyntaxFiles(root);
  const topLevel = scope.reduce(
    (sum, directory) =>
      sum + readdirSync(path.join(root, directory), { withFileTypes: true }).filter((entry) => entry.isFile() && /\.m?js$/.test(entry.name)).length,
    0
  );
  assert.equal(counted, topLevel + 1, 'top-level JavaScript files plus playwright.config.js');
  assert.match(plan, new RegExp(`\\| \`syntax_files\` \\|[^\\n]*\\b${counted}\\b`));
});

test('PSC-11 the plan is wired into every part of the repository it claims to reach', async () => {
  const { facts } = await realRun();
  const register = read(BACKLOG_PATH);
  assert.match(register, /^\| PLAN-002 \| P0 \| منجز توثيقيًا \| PLAN-001 \|/m, 'PLAN-002 has a register row');
  assert.match(register.match(/^\| PLAN-002 \|.*$/m)[0], /\.\.\/plan-system-completion\.md/, 'the register row links the plan');

  assert.match(read('README.md'), /plan-system-completion\.md/, 'README indexes the plan');
  assert.match(read('docs/plan-100-percent.md'), /plan-system-completion\.md/, 'the 100% plan points forward to it');
  assert.match(read('docs/executive-completion-plan.md'), /plan-system-completion\.md/, 'the executive plan points forward to it');
  assert.match(read('docs/design/system-atlas.html'), /plan-system-completion\.md/, 'the System Atlas roadmap cites it');
  assert.match(read('CHANGELOG.md'), /PLAN-002/, 'the changelog records its arrival');

  const handoff = 'docs/continuity/sessions/2026-11-01-plan-system-completion.md';
  const session = read(handoff);
  assert.match(session, /PLAN-002/);
  assert.match(session, /^## الدليل البصري$/m, 'VFE-001: the handoff carries its visual evidence section');

  assert.match(read('package.json'), /"plan:check"/, 'the gate is a named command');
  assert.match(read('.github/workflows/celia-mcp.yml'), /npm run plan:check/, 'the gate runs in CI');
  assert.match(read('AGENTS.md'), /npm run plan:check/, 'the working agreement lists the gate');
  assert.ok(facts.continuity.documents > 0 && facts.continuity.tasks > 0);
});
