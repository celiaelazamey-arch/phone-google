import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  LIMITS,
  createReporter,
  describeError,
  escapeData,
  escapeProperty,
  formatAnnotation,
  summarize,
  toFailure,
} from '../scripts/test-reporter-gha.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reporterPath = path.join(root, 'scripts/test-reporter-gha.mjs');

function testFailure(error, { code = 'ERR_TEST_FAILURE', failureType = 'testCodeFailure', ...rest } = {}) {
  return Object.assign(new Error(typeof error === 'string' ? error : error.message), { code, failureType, cause: error, ...rest });
}

function failEvent({ name, file = '/repo/test/x.test.js', line = 4, column = 1, nesting = 0, type = 'test', error }) {
  return { type: 'test:fail', data: { name, file, line, column, nesting, details: { type, duration_ms: 1, error } } };
}

async function collect(reporter, events) {
  const out = [];
  for await (const chunk of reporter((async function* () { yield* events; })())) out.push(chunk);
  return out;
}

test('workflow-command escaping follows GitHub rules for data and properties', () => {
  assert.equal(escapeData('50% done\r\nnext'), '50%25 done%0D%0Anext');
  assert.equal(escapeProperty('a:b,c%d\n'), 'a%3Ab%2Cc%25d%0A');
  const line = formatAnnotation('error', { title: 'fails: nested %, comma', file: 'test/x.test.js', line: 6, column: 3, message: 'boom\nline 2' });
  assert.equal(line, '::error file=test/x.test.js,line=6,col=3,title=fails%3A nested %25%2C comma::boom%0Aline 2\n');
  assert.equal(formatAnnotation('notice', { message: 'plain' }), '::notice::plain\n');
  const long = formatAnnotation('error', { title: 'x'.repeat(500), message: 'y'.repeat(5000) });
  assert.ok(long.length < LIMITS.title + LIMITS.message + 40, 'title and message are bounded');
});

test('describeError prefers the real cause and labels non-code failure types', () => {
  assert.equal(describeError(testFailure(Object.assign(new Error('one is not two'), { name: 'AssertionError' }))), 'one is not two');
  assert.equal(describeError(testFailure('test timed out after 50ms', { failureType: 'testTimeoutFailure' })), '[testTimeoutFailure] test timed out after 50ms');
  assert.equal(describeError(Object.assign(new Error('hook broke'), { failureType: 'hookFailed' })), '[hookFailed] hook broke');
  assert.equal(describeError(undefined), 'failed');
});

test('toFailure skips parents that only failed through children, relativises files and attaches a crashed file’s stderr', () => {
  const cwd = '/repo';
  assert.equal(toFailure(failEvent({ name: 'suite', type: 'suite', error: testFailure('1 subtest failed', { failureType: 'subtestsFailed' }) }), { cwd }), null);
  const plain = toFailure(failEvent({ name: 'adds', nesting: 1, error: testFailure(new Error('1 !== 2')) }), { cwd });
  assert.deepEqual(plain, { name: 'adds', file: 'test/x.test.js', line: 4, column: 1, failureType: 'testCodeFailure', message: '1 !== 2' });
  const stderrTails = new Map([[path.resolve(cwd, 'test/x.test.js'), 'Error [ERR_MODULE_NOT_FOUND]: Cannot find module\n    at resolve\n']]);
  const crashed = toFailure(failEvent({ name: 'x.test.js', line: 1, error: testFailure('test failed', { exitCode: 1, signal: null }) }), { cwd, stderrTails });
  assert.equal(crashed.message, 'test file exit code 1\nError [ERR_MODULE_NOT_FOUND]: Cannot find module\n    at resolve');
  const signalled = toFailure(failEvent({ name: 'y.test.js', file: '/repo/test/y.test.js', line: 1, error: testFailure('test failed', { exitCode: null, signal: 'SIGKILL' }) }), { cwd });
  assert.equal(signalled.message, 'test file signal SIGKILL (no stderr captured)');
  const outside = toFailure(failEvent({ name: 'elsewhere', file: '/other/place.test.js', error: testFailure(new Error('x')) }), { cwd });
  assert.equal(outside.file, '/other/place.test.js');
});

test('GitHub mode: one annotation per failing test, capped detail budget, complete closing list, threshold errors, step summary', async () => {
  const appended = [];
  const reporter = createReporter({ env: { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: '/dev/null-summary' }, cwd: '/repo', append: (file, text) => appended.push({ file, text }) });
  const events = [
    { type: 'test:start', data: { name: 'ignored' } },
    { type: 'test:pass', data: { name: 'fine', nesting: 0, details: { type: 'test' } } },
    { type: 'test:pass', data: { name: 'suite', nesting: 0, details: { type: 'suite' } } },
  ];
  for (let i = 1; i <= 12; i += 1) events.push(failEvent({ name: `case ${i}`, line: i, error: testFailure(new Error(`expected ${i}`)) }));
  events.push(failEvent({ name: 'parent', type: 'suite', error: testFailure('2 subtests failed', { failureType: 'subtestsFailed' }) }));
  events.push({ type: 'test:diagnostic', data: { nesting: 0, level: 'info', message: 'tests 14' } });
  events.push({ type: 'test:diagnostic', data: { nesting: 0, level: 'error', message: 'Error: 66.67% branch coverage does not meet threshold of 70%.' } });
  events.push({ type: 'test:coverage', data: { nesting: 0, summary: { totals: { coveredLinePercent: 85.7, coveredBranchPercent: 66.67, coveredFunctionPercent: 83.76 }, thresholds: { line: 80, branch: 70, function: 78 } } } });
  events.push({ type: 'test:summary', data: { file: '/repo/test/x.test.js', counts: { tests: 13, failed: 12, passed: 1 }, success: false } });
  events.push({ type: 'test:summary', data: { counts: { tests: 13, failed: 12, passed: 1, cancelled: 0, skipped: 0, todo: 0 }, success: false } });
  const out = await collect(reporter, events);

  const detail = out.filter((l) => l.startsWith('::error file='));
  assert.equal(detail.length, LIMITS.detailAnnotations, 'per-test annotations stop at the display cap');
  assert.equal(detail[0], '::error file=test/x.test.js,line=1,col=1,title=case 1::expected 1\n');
  assert.ok(!out.some((l) => l.includes('title=parent')), 'subtestsFailed parent is not repeated');
  assert.ok(!out.some((l) => l.includes('title=coverage threshold')), 'threshold error arrives after the budget is spent → only in the closing line');
  const closing = out.at(-1);
  assert.ok(closing.startsWith('::error title=node --test::13 tests · 1 passed · 12 failed · coverage lines 85.70%25 · branches 66.67%25 · functions 83.76%25 (floor 80/70/78)%0Afailing: case 1 (test/x.test.js:1); '), closing);
  assert.ok(closing.includes('case 12 (test/x.test.js:12)'), 'every failing test is named in the closing annotation');
  assert.ok(closing.includes('%0AError: 66.67%25 branch coverage does not meet threshold of 70%25.'), closing);
  assert.equal(out.length, LIMITS.detailAnnotations + 1);

  assert.equal(appended.length, 1);
  assert.equal(appended[0].file, '/dev/null-summary');
  assert.match(appended[0].text, /^### node --test — ❌ failing\n/);
  assert.match(appended[0].text, /\| case 12 \| test\/x\.test\.js:12 \| expected 12 \|/);
  assert.match(appended[0].text, /- ⚠️ Error: 66\.67% branch coverage does not meet threshold of 70%\./);
});

test('GitHub mode: a green run ends with one notice and no error annotations; counts fall back to the stream when no summary event exists', async () => {
  const reporter = createReporter({ env: { GITHUB_ACTIONS: 'true' }, cwd: '/repo' });
  const out = await collect(reporter, [
    { type: 'test:pass', data: { name: 'a', nesting: 0, details: { type: 'test' } } },
    { type: 'test:pass', data: { name: 'b', nesting: 1, details: { type: 'test' } } },
    { type: 'test:pass', data: { name: 'describe', nesting: 0, details: { type: 'suite' } } },
  ]);
  assert.deepEqual(out, ['::notice title=node --test::2 tests · 2 passed · 0 failed\n']);
  const red = summarize({ counts: null, success: null, failures: [{ name: 'x', file: 't.js', line: 2 }], thresholdErrors: [], coverage: null, ownCounts: { pass: 3, fail: 1 } });
  assert.equal(red.red, true);
  assert.equal(red.text, '4 tests · 3 passed · 1 failed\nfailing: x (t.js:2)');
});

test('outside GitHub Actions the same facts are printed as plain text, never as workflow commands', async () => {
  const reporter = createReporter({ env: {}, cwd: '/repo' });
  const out = await collect(reporter, [
    failEvent({ name: 'fails: nested', nesting: 1, line: 6, error: testFailure(new Error('boom\nsecond line')) }),
    { type: 'test:summary', data: { counts: { tests: 1, failed: 1, passed: 0, cancelled: 0, skipped: 0, todo: 0 }, success: false } },
  ]);
  assert.deepEqual(out, [
    '✖ test/x.test.js:6 fails: nested — boom ⏎ second line\n',
    '✖ node --test — 1 tests · 0 passed · 1 failed ⏎ failing: fails: nested (test/x.test.js:6)\n',
  ]);
  assert.ok(out.every((l) => !l.startsWith('::')));
});

test('a reporter crash on one event becomes a warning instead of taking the run down', async () => {
  const reporter = createReporter({ env: { GITHUB_ACTIONS: 'true' }, cwd: '/repo' });
  const poisoned = { type: 'test:fail', get data() { throw new Error('poisoned event'); } };
  const out = await collect(reporter, [poisoned, { type: 'test:pass', data: { name: 'ok', nesting: 0, details: { type: 'test' } } }]);
  assert.equal(out[0], '::warning title=test-reporter-gha::poisoned event\n');
  assert.equal(out.at(-1), '::notice title=node --test::1 tests · 1 passed · 0 failed\n');
});

test('end to end: node --test with the reporter names failing tests and crashed files, and stays silent-green otherwise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'celia-gha-reporter-'));
  try {
    fs.writeFileSync(path.join(dir, 'red.mjs'), [
      "import { test, describe, it } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('passes', () => {});",
      "test('top-level failure', () => { assert.equal(1, 2, 'one is not two'); });",
      "describe('suite', () => { it('nested % failure, with comma', () => { throw new Error('boom'); }); });",
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'broken.mjs'), "import { nope } from './missing.mjs';\n");
    fs.writeFileSync(path.join(dir, 'green.mjs'), "import { test } from 'node:test';\ntest('fine', () => {});\n");
    const summaryFile = path.join(dir, 'summary.md');
    // The child must not inherit the outer runner's context (NODE_TEST_CONTEXT makes a nested `node --test` skip its files).
    const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summaryFile };
    for (const key of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'NODE_V8_COVERAGE']) delete env[key];
    const run = (files) => spawnSync(process.execPath, ['--test', `--test-reporter=${reporterPath}`, '--test-reporter-destination=stdout', ...files], {
      cwd: dir,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });

    const red = run(['red.mjs', 'broken.mjs']);
    assert.equal(red.status, 1, red.stderr);
    const lines = red.stdout.split('\n').filter(Boolean);
    assert.ok(lines.includes('::error file=red.mjs,line=4,col=1,title=top-level failure::one is not two%0A%0A1 !== 2'), red.stdout);
    assert.ok(lines.some((l) => l.startsWith('::error file=red.mjs,line=5,') && l.includes('title=nested %25 failure%2C with comma::boom')), red.stdout);
    assert.ok(lines.some((l) => l.startsWith('::error file=broken.mjs,line=1,col=1,title=broken.mjs::test file exit code 1%0A') && l.includes('ERR_MODULE_NOT_FOUND')), 'a file that fails to load is named with its stderr');
    assert.ok(!lines.some((l) => l.includes('title=suite::')), 'the parent suite is not reported separately');
    const closing = lines.at(-1);
    assert.match(closing, /^::error title=node --test::\d+ tests · 1 passed · \d+ failed/);
    for (const named of ['top-level failure (red.mjs:4)', 'nested %25 failure, with comma (red.mjs:5)', 'broken.mjs (broken.mjs:1)']) {
      assert.ok(closing.includes(named), `${closing} should name ${named}`); // files run concurrently, so the order varies
    }
    const summary = fs.readFileSync(summaryFile, 'utf8');
    assert.match(summary, /### node --test — ❌ failing/);
    assert.match(summary, /\| top-level failure \| red\.mjs:4 \| one is not two/);

    fs.rmSync(summaryFile, { force: true });
    const green = run(['green.mjs']);
    assert.equal(green.status, 0, green.stdout + green.stderr);
    assert.deepEqual(green.stdout.split('\n').filter(Boolean), ['::notice title=node --test::1 tests · 1 passed · 0 failed']);
    assert.match(fs.readFileSync(summaryFile, 'utf8'), /### node --test — ✅ green\n\n1 tests · 1 passed · 0 failed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CI never runs the suite blind: the :ci scripts carry the reporter and every test-running workflow uses them', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const reporterFlags = '--test-reporter=spec --test-reporter-destination=stdout --test-reporter=./scripts/test-reporter-gha.mjs --test-reporter-destination=stdout';
  assert.equal(pkg.scripts['test:ci'], `node --test ${reporterFlags}`);
  assert.equal(pkg.scripts['test:coverage:ci'], `npm run test:coverage -- ${reporterFlags}`);
  const coverageTokens = pkg.scripts['test:coverage'].split(/\s+/);
  assert.deepEqual(coverageTokens.slice(0, 2), ['node', '--test']);
  assert.ok(coverageTokens.slice(2).every((token) => token.startsWith('--')), 'test:coverage has no positional file arguments, so appended reporter flags apply to the whole suite');
  const workflows = {
    'celia-mcp.yml': /npm run check && npm run release:check && npm run check:continuity && npm run test:coverage:ci\b/,
    'release.yml': /npm run check && npm run release:check && npm run test:ci && npm audit --omit=dev --audit-level=moderate/,
    'pages.yml': /npm run check && npm run release:check && npm run test:ci && npm run build:pages/,
  };
  for (const [file, expected] of Object.entries(workflows)) {
    const text = fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8');
    assert.match(text, expected, `${file} must run the suite through the annotating reporter`);
    assert.ok(!/run: .*\bnpm test\b/.test(text) && !/&& npm test\b/.test(text), `${file} must not run a blind "npm test"`);
  }
});
