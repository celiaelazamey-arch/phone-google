// QA-009 (DEC-041): a red Quality run on main becomes one issue that names the failing tests — and nothing else.
// The pure parts are asserted on a fixture shaped like the real Actions/Checks API payloads; `main` is asserted
// against a fake `gh` binary on PATH, so the exact writes (create / comment / close) are checked without GitHub.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LABEL, MARKER, TITLE, MAX_ROWS, WORKFLOW_FILE, runMarker,
  parseArgs, redact, classifyRun, collectFailures, buildTitle, buildIssueBody, decide, loadRunData, main
} from '../scripts/ci-failure-notify.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(root, 'test/fixtures/ci-failure-notify/red-run.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const greenRun = { ...fixture.run, id: 41000000002, conclusion: 'success', created_at: '2026-10-29T04:00:00Z' };

test('ci-failure notify: arguments — the run id is mandatory and numeric, flags are explicit', () => {
  assert.deepEqual(parseArgs(['--run', '123', '--dry-run', '--branch', 'main', '--fixture', 'x.json']), { run: '123', branch: 'main', dryRun: true, fixture: 'x.json' });
  assert.throws(() => parseArgs([]), /--run/);
  assert.throws(() => parseArgs(['--run', 'abc']), /--run/);
  assert.throws(() => parseArgs(['--run', '1', '--apply']), /unknown argument/);
});

test('ci-failure notify: redact() removes secret-shaped strings and keeps test names readable', () => {
  assert.equal(redact('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 leaked'), 'token [redacted] leaked');
  assert.equal(redact('github_pat_11AAAAAAA0BBBBBBBBBBBBBBBBBBBBBBB'), '[redacted]');
  assert.equal(redact('Authorization: Bearer abc.def.ghi-jkl'), 'Authorization: [redacted]');
  assert.equal(redact('x-api-key=sk-live-0123456789abcdefghij'), 'x-api-key=[redacted]');
  assert.equal(redact('sha 0123456789abcdef0123456789abcdef01234567 here'), 'sha [redacted] here');
  assert.equal(redact('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.dozjgNryP4J3jVmNHl0w5N'), '[redacted]');
  assert.equal(redact('\u001b[31mKnowledgeStore.stats() orders by lastRunAt\u001b[0m'), 'KnowledgeStore.stats() orders by lastRunAt');
  assert.equal(redact('expected 3 to equal 4 at test/a.test.js:12'), 'expected 3 to equal 4 at test/a.test.js:12');
});

test('ci-failure notify: classifyRun() — only completed pushes to the watched branch carry a verdict', () => {
  const base = fixture.run;
  assert.deepEqual(classifyRun(base), { verdict: 'red' });
  assert.deepEqual(classifyRun({ ...base, conclusion: 'timed_out' }), { verdict: 'red' });
  assert.deepEqual(classifyRun({ ...base, conclusion: 'success' }), { verdict: 'green' });
  assert.equal(classifyRun({ ...base, conclusion: 'cancelled' }).verdict, 'skip');
  assert.match(classifyRun({ ...base, head_branch: 'arena/x' }).reason, /not main/);
  assert.match(classifyRun({ ...base, event: 'pull_request' }).reason, /not push/);
  assert.match(classifyRun({ ...base, status: 'in_progress', conclusion: null }).reason, /not completed/);
  assert.match(classifyRun(null).reason, /not found/);
  const newer = { id: 999, conclusion: 'success', created_at: '2026-10-29T05:00:00Z' };
  assert.match(classifyRun(base, { latest: newer }).reason, /superseded by newer completed run 999/);
  assert.deepEqual(classifyRun(base, { latest: { id: base.id, created_at: base.created_at } }), { verdict: 'red' });
  const older = { id: 1, conclusion: 'success', created_at: '2026-10-29T01:00:00Z' };
  assert.deepEqual(classifyRun(base, { latest: older }), { verdict: 'red' });
  assert.deepEqual(classifyRun({ ...base, head_branch: 'release' }, { branch: 'release' }), { verdict: 'red' });
});

test('ci-failure notify: collectFailures() names tests from reporter annotations, drops the generic exit-code line, dedupes, and keeps silent jobs honest', () => {
  const failures = collectFailures({ jobs: fixture.jobs, annotationsByJob: fixture.annotations });
  assert.deepEqual(failures.failedJobs.map((job) => job.id), [901, 902, 904], 'success/skipped jobs are not failures');
  assert.equal(failures.tests.length, 2, 'one node --test failure (its duplicate dropped) + one Playwright failure');
  assert.deepEqual(failures.tests.map((entry) => [entry.title, entry.file, entry.line]), [
    ['KnowledgeStore.stats() orders by lastRunAt', 'test/knowledge-store.test.js', 88],
    ['[chromium] › e2e/agent.spec.js:12:3 › agent page › shows the plan | with a pipe', 'e2e/agent.spec.js', 12]
  ]);
  assert.deepEqual(failures.coverage.map((entry) => entry.message), ['coverage lines 88.90% is below the 89% floor']);
  assert.equal(failures.summary.length, 1, 'the reporter closing line is kept as the summary');
  assert.deepEqual(failures.other, [], '"Process completed with exit code 1." is never reported as a finding');
  assert.deepEqual(failures.silentJobs.map((job) => job.id), [904], 'a failed job without named annotations is listed as silent, not hidden');
  assert.deepEqual(collectFailures(), { failedJobs: [], tests: [], coverage: [], summary: [], other: [], silentJobs: [] });
});

test('ci-failure notify: the red body carries names, locations, jobs, coverage, silent jobs, the repro command — and no secrets', () => {
  const failures = collectFailures({ jobs: fixture.jobs, annotationsByJob: fixture.annotations });
  const body = buildIssueBody({ run: fixture.run, verdict: 'red', failures, now: new Date('2026-10-29T03:05:00Z') });
  assert.ok(body.startsWith(`${MARKER}\n${runMarker(fixture.run.id)}\n`), 'both markers lead the body (issue identity + run idempotency)');
  assert.match(body, /### Celia quality & resilience — ❌ red on `main` \(2026-10-29\)/);
  assert.match(body, /Run: https:\/\/github\.com\/celiaelazamey-arch\/phone-google\/actions\/runs\/41000000001 · Commit: `0123456` · Event: push · Conclusion: `failure`/);
  assert.match(body, /\| 1 \| `KnowledgeStore\.stats\(\) orders by lastRunAt` \| `test\/knowledge-store\.test\.js:88` \| Node 24 · tests & failure recovery \| AssertionError/);
  assert.match(body, /shows the plan \\\| with a pipe` \| `e2e\/agent\.spec\.js:12` \| RTL dashboard/, 'pipes inside names are escaped so the table survives');
  assert.match(body, /Coverage: coverage lines 88\.90% is below the 89% floor \(Node 24/);
  assert.match(body, /Reporter summary \(Node 24[^\n]*521 tests · 520 passed · 1 failed/);
  assert.match(body, /Failed without a named test \(open the job log\): \[MySQL 8\.4 · persistence \/ N−1 \/ backup restore\]\(https:\/\/github\.com\/[^)]+\/job\/904\)/);
  assert.match(body, /Reproduce: `npm run test:ci` · `GITHUB_ACTIONS=true npm run test:coverage:ci` · browser: `npm run test:browser`/);
  assert.match(body, /No retry, no generated patch, no rollback, no merge \(DEC-039, DEC-041\)/);
  assert.ok(!body.includes('ghp_'), 'a token printed by a failing assertion never reaches the issue');
  assert.ok(!body.includes('eyJhbGciOiJIUzI1NiJ9'), 'a JWT printed by a browser failure never reaches the issue');
  assert.ok(!body.includes(fixture.run.head_sha), 'only the short commit is shown');
  assert.equal(buildIssueBody({ run: fixture.run, verdict: 'red', failures, now: new Date('2026-10-29T03:05:00Z') }), body, 'deterministic for the same input');
});

test('ci-failure notify: long failure lists are capped at MAX_ROWS with an explicit remainder', () => {
  const many = Array.from({ length: MAX_ROWS + 5 }, (_, index) => ({ path: `test/t${index}.test.js`, start_line: index + 1, annotation_level: 'failure', title: `case ${index}`, message: 'boom' }));
  const failures = collectFailures({ jobs: [{ id: 1, name: 'Node 24', conclusion: 'failure' }], annotationsByJob: { 1: many } });
  const body = buildIssueBody({ run: fixture.run, verdict: 'red', failures });
  assert.equal((body.match(/^\| \d+ \| `case /gm) || []).length, MAX_ROWS);
  assert.match(body, new RegExp(`and 5 more — see the run annotations`));
  assert.equal(buildTitle(failures), `${TITLE} — ${MAX_ROWS + 5} failing tests`);
});

test('ci-failure notify: titles say what kind of red it is; the green body says what was (not) done', () => {
  const failures = collectFailures({ jobs: fixture.jobs, annotationsByJob: fixture.annotations });
  assert.equal(buildTitle(failures), `${TITLE} — 2 failing tests`);
  assert.equal(buildTitle({ ...failures, tests: failures.tests.slice(0, 1) }), `${TITLE} — 1 failing test`);
  assert.equal(buildTitle({ ...failures, tests: [] }), `${TITLE} — coverage below floor`);
  assert.equal(buildTitle({ failedJobs: [{ name: 'MySQL 8.4' }], tests: [], coverage: [], other: [{ job: 'MySQL 8.4', title: 'container', message: 'pull failed' }] }), `${TITLE} — MySQL 8.4`);
  assert.equal(buildTitle({ failedJobs: [{ name: 'MySQL 8.4' }], tests: [], coverage: [], other: [] }), `${TITLE} — job failed without a named test`);
  assert.equal(buildTitle(failures, { branch: 'release' }), 'Quality workflow red on release — 2 failing tests');
  const green = buildIssueBody({ run: greenRun, verdict: 'green', now: new Date('2026-10-29T04:01:00Z') });
  assert.match(green, /✅ green on `main` \(2026-10-29\)/);
  assert.match(green, /Closed automatically: `main` is green again\. Nothing was retried, patched or rolled back by automation\./);
  assert.ok(green.includes(runMarker(greenRun.id)));
  assert.ok(!green.includes('| # | test |'), 'a green comment carries no failure table');
});

test('ci-failure notify: decide() — one write per run, never a duplicate, never a reopen', () => {
  assert.equal(decide({ verdict: 'red', openIssue: null }), 'create');
  assert.equal(decide({ verdict: 'red', openIssue: { number: 7 } }), 'comment');
  assert.equal(decide({ verdict: 'red', openIssue: { number: 7 }, alreadyRecorded: true }), 'noop');
  assert.equal(decide({ verdict: 'green', openIssue: { number: 7 } }), 'close');
  assert.equal(decide({ verdict: 'green', openIssue: null }), 'noop');
  assert.equal(decide({ verdict: 'skip', openIssue: { number: 7 } }), 'noop');
});

test('ci-failure notify: loadRunData() reads a fixture in the same shape as the live API path', () => {
  const data = loadRunData({ runId: '41000000001', repository: 'x/y', env: {}, fixture: fixturePath });
  assert.equal(data.run.id, 41000000001);
  assert.equal(data.jobs.length, 5);
  assert.equal(Object.keys(data.annotationsByJob).length, 3);
  assert.equal(data.latest.id, 41000000001);
});

async function fakeGh({ open = null, comments = '' } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'celia-gh-'));
  const log = path.join(directory, 'calls.log');
  const binary = path.join(directory, 'gh');
  const listJson = open ? JSON.stringify([{ number: open.number, body: open.body || '' }]) : '[]';
  await writeFile(
    binary,
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$1 $2" in
  "issue list") printf '%s' '${listJson.replace(/'/g, "'\\''")}' ;;
  "issue view") printf '%s' '${comments.replace(/'/g, "'\\''")}' ;;
  "issue create") printf 'https://github.com/celiaelazamey-arch/phone-google/issues/8\\n' ;;
  "api "*) echo "unexpected gh api call: $*" >&2; exit 9 ;;
esac
exit 0
`,
    'utf8'
  );
  await chmod(binary, 0o755);
  const calls = async () => {
    const text = await readFile(log, 'utf8').catch(() => '');
    return text.trim() ? text.trim().split('\n') : [];
  };
  const fixtureFile = async (data) => {
    const file = path.join(directory, `${Math.random().toString(36).slice(2)}.json`);
    await writeFile(file, JSON.stringify(data), 'utf8');
    return file;
  };
  return { directory, calls, fixtureFile, env: (extra = {}) => ({ PATH: `${directory}:${process.env.PATH}`, GH_TOKEN: 'token', GH_REPO: 'celiaelazamey-arch/phone-google', ...extra }) };
}

test('ci-failure notify: a dry run prints the title and body and calls nothing', async () => {
  const gh = await fakeGh();
  const printed = [];
  const code = await main({ argv: ['--run', '41000000001', '--fixture', fixturePath, '--dry-run'], env: gh.env(), log: (line) => printed.push(line) });
  assert.equal(code, 0);
  assert.match(printed.join('\n'), /dry run — verdict red, 2 named test\(s\), 3 failed job\(s\)/);
  assert.match(printed.join('\n'), /title: Quality workflow red on main — 2 failing tests/);
  assert.deepEqual(await gh.calls(), []);
});

test('ci-failure notify: red on main with no open issue → label ensured, ONE issue created with the label and the body file', async () => {
  const gh = await fakeGh();
  const printed = [];
  const code = await main({ argv: ['--run', '41000000001', '--fixture', fixturePath], env: gh.env(), log: (line) => printed.push(line) });
  assert.equal(code, 0);
  const calls = await gh.calls();
  assert.ok(calls.some((line) => line.startsWith(`label create ${LABEL} `)), 'the label is created idempotently');
  assert.ok(calls.some((line) => line.startsWith(`issue list --label ${LABEL} --state open --limit 1 --json number,body`)));
  const create = calls.find((line) => line.startsWith('issue create '));
  assert.ok(create, 'an issue is created');
  assert.match(create, /--title Quality workflow red on main — 2 failing tests --label ci-failure --body-file /);
  assert.equal(calls.filter((line) => line.startsWith('issue create')).length, 1);
  assert.ok(!calls.some((line) => line.startsWith('issue comment') || line.startsWith('issue close')));
  assert.match(printed.join('\n'), /::warning title=QA-009 · ci-failure notify::main is red — opened https:\/\/github\.com\/celiaelazamey-arch\/phone-google\/issues\/8/);
});

test('ci-failure notify: red on main with an open issue → one comment per run; the same run is never recorded twice', async () => {
  const first = await fakeGh({ open: { number: 7, body: `${MARKER}\n${runMarker(41000000000)}\nolder run` } });
  let code = await main({ argv: ['--run', '41000000001', '--fixture', fixturePath], env: first.env(), log: () => {} });
  assert.equal(code, 0);
  let calls = await first.calls();
  assert.ok(calls.some((line) => line.startsWith('issue comment 7 --body-file')), 'the new run is appended');
  assert.ok(!calls.some((line) => line.startsWith('issue create')), 'no second issue');
  assert.ok(!calls.some((line) => line.startsWith('issue close')));

  const recordedInBody = await fakeGh({ open: { number: 7, body: `${MARKER}\n${runMarker(41000000001)}` } });
  const printed = [];
  code = await main({ argv: ['--run', '41000000001', '--fixture', fixturePath], env: recordedInBody.env(), log: (line) => printed.push(line) });
  assert.equal(code, 0);
  calls = await recordedInBody.calls();
  assert.ok(!calls.some((line) => line.startsWith('issue comment') || line.startsWith('issue create')), 'a run already in the body is not repeated');
  assert.match(printed.join('\n'), /nothing to do \(issue #7 already records it\)/);

  const recordedInComment = await fakeGh({ open: { number: 7, body: MARKER }, comments: `earlier\n${runMarker(41000000001)}` });
  code = await main({ argv: ['--run', '41000000001', '--fixture', fixturePath], env: recordedInComment.env(), log: () => {} });
  assert.equal(code, 0);
  calls = await recordedInComment.calls();
  assert.ok(calls.some((line) => line.startsWith('issue view 7 --json comments')), 'comments are consulted for the run marker');
  assert.ok(!calls.some((line) => line.startsWith('issue comment')), 'a run already in a comment is not repeated');
});

test('ci-failure notify: green on main → comment then close the open issue; nothing to do without one', async () => {
  const withIssue = await fakeGh({ open: { number: 7, body: MARKER } });
  const greenFixture = await withIssue.fixtureFile({ run: greenRun, jobs: fixture.jobs.map((job) => ({ ...job, conclusion: job.conclusion === 'failure' ? 'success' : job.conclusion })), annotations: {}, latest: null });
  const printed = [];
  let code = await main({ argv: ['--run', String(greenRun.id), '--fixture', greenFixture], env: withIssue.env(), log: (line) => printed.push(line) });
  assert.equal(code, 0);
  const calls = await withIssue.calls();
  assert.ok(calls.some((line) => line.startsWith('issue comment 7 --body-file')), 'the green run is recorded on the issue');
  assert.ok(calls.some((line) => line.startsWith(`issue close 7 --comment Closed automatically: run ${greenRun.id} on main passed.`)), 'the issue closes itself');
  assert.ok(!calls.some((line) => line.startsWith('issue create')));
  assert.match(printed.join('\n'), /main is green — closed issue #7/);

  const without = await fakeGh();
  const greenFixture2 = await without.fixtureFile({ run: greenRun, jobs: [], annotations: {}, latest: null });
  code = await main({ argv: ['--run', String(greenRun.id), '--fixture', greenFixture2], env: without.env(), log: (line) => printed.push(line) });
  assert.equal(code, 0);
  assert.ok(!(await without.calls()).some((line) => line.startsWith('issue ') && !line.startsWith('issue list')), 'green without an open issue writes nothing');
});

test('ci-failure notify: runs that are not pushes to main, not completed, or superseded, touch nothing (and never reopen)', async () => {
  const gh = await fakeGh({ open: { number: 7, body: MARKER } });
  const cases = [
    { ...fixture.run, head_branch: 'arena/other' },
    { ...fixture.run, event: 'pull_request' },
    { ...fixture.run, conclusion: 'cancelled' },
    { ...fixture.run, status: 'in_progress', conclusion: null }
  ];
  for (const run of cases) {
    const file = await gh.fixtureFile({ run, jobs: fixture.jobs, annotations: fixture.annotations, latest: null });
    const printed = [];
    const code = await main({ argv: ['--run', String(run.id), '--fixture', file], env: gh.env(), log: (line) => printed.push(line) });
    assert.equal(code, 0);
    assert.match(printed.join('\n'), /::notice title=QA-009 · ci-failure notify::run \d+ skipped — /);
  }
  const superseded = await gh.fixtureFile({ run: fixture.run, jobs: fixture.jobs, annotations: fixture.annotations, latest: { id: 41000000009, conclusion: 'success', created_at: '2026-10-29T06:00:00Z' } });
  const printed = [];
  await main({ argv: ['--run', '41000000001', '--fixture', superseded], env: gh.env(), log: (line) => printed.push(line) });
  assert.match(printed.join('\n'), /skipped — superseded by newer completed run 41000000009 \(success\)/);
  assert.deepEqual(await gh.calls(), [], 'skips happen before any gh call');
});

test('ci-failure notify: without a fixture a token is mandatory; the CLI entry point reports errors as one annotation', async () => {
  await assert.rejects(() => main({ argv: ['--run', '1'], env: { PATH: process.env.PATH }, log: () => {} }), /GH_TOKEN/);
});

test('ci-failure notify: the parser tracks the emitters — reporter titles, Playwright github reporter, and the real Checks API shape', () => {
  const reporter = fs.readFileSync(path.join(root, 'scripts/test-reporter-gha.mjs'), 'utf8');
  assert.match(reporter, /yield emit\('error', \{ title: failure\.name, file: failure\.file, line: failure\.line/, 'test failures are emitted with the test name as title and a repository-relative file (what collectFailures names)');
  assert.match(reporter, /yield emit\('error', \{ title: 'coverage threshold', message \}\)/, "coverage shortfalls carry the title 'coverage threshold'");
  assert.match(reporter, /yield emit\(red \? 'error' : 'notice', \{ title: 'node --test', message: text \}\)/, "the closing line carries the title 'node --test'");
  const playwright = fs.readFileSync(path.join(root, 'playwright.config.js'), 'utf8');
  assert.match(playwright, /\[\["list"\], \["github"\]\]/, 'browser failures are annotated by the built-in github reporter, so the browser job is never silent');
  assert.equal(WORKFLOW_FILE, 'celia-mcp.yml');
  assert.equal(fs.readFileSync(path.join(root, '.github/workflows', WORKFLOW_FILE), 'utf8').split('\n')[0], 'name: Celia quality & resilience');
});

test('ci-failure notify: workflow wiring — workflow_run on the Quality workflow for main, least privilege, pinned actions, no secrets beyond GITHUB_TOKEN', () => {
  const file = path.join(root, '.github/workflows/quality-failure-notify.yml');
  const text = fs.readFileSync(file, 'utf8');
  const qualityName = fs.readFileSync(path.join(root, '.github/workflows/celia-mcp.yml'), 'utf8').match(/^name: (.+)$/m)[1];
  assert.match(text, new RegExp(`workflow_run:\\n\\s+workflows: \\['${qualityName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\]\\n\\s+types: \\[completed\\]\\n\\s+branches: \\[main\\]`), 'listens to the Quality workflow by its exact name, for main only');
  assert.match(text, /if: github\.event_name == 'workflow_dispatch' \|\| github\.event\.workflow_run\.event == 'push'/, 'PR runs never produce a verdict about main');
  const permissions = text.match(/^permissions:\n((?:  [a-z-]+: [a-z]+\n)+)/m);
  assert.ok(permissions, 'top-level permissions block');
  assert.deepEqual(permissions[1].trim().split('\n').map((line) => line.trim()).sort(), ['actions: read', 'checks: read', 'contents: read', 'issues: write'], 'exactly what reading jobs/annotations and writing one issue needs');
  assert.ok(!/pull_request_target|contents: write|pull-requests: write|id-token/.test(text), 'no write beyond issues, no PR/token surface');
  assert.deepEqual([...text.matchAll(/\$\{\{\s*secrets\.([A-Z_]+)\s*\}\}/g)].map((match) => match[1]), ['GITHUB_TOKEN'], 'the only credential is the workflow token');
  assert.match(text, /run: \|[\s\S]*node scripts\/ci-failure-notify\.mjs --run "\$WORKFLOW_RUN_ID"\n/, 'the workflow_run path evaluates the triggering run id');
  assert.match(text, /node scripts\/ci-failure-notify\.mjs --run "\$INPUT_RUN_ID" \$flags/, 'workflow_dispatch replays a run id through env, not interpolated into the shell');
  assert.match(text, /dry_run:[\s\S]*type: boolean\n\s+default: true/, 'manual replays are dry runs unless the owner says otherwise');
  for (const uses of text.matchAll(/uses: ([^@\s]+)@([0-9a-f]+)/g)) assert.equal(uses[2].length, 40, `${uses[1]} is pinned to a full commit SHA`);
  assert.match(text, /concurrency:\n\s+group: quality-failure-notify\n\s+cancel-in-progress: false/, 'runs are serialized so create/comment/close never race');
  assert.ok(!/npm ci|npm install/.test(text), 'the notifier has no dependencies, so nothing is installed');
});
