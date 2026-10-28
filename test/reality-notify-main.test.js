// The notifier is how a failing weekly audit actually reaches the owner. It is tested against a fake `gh`
// binary on PATH, so the exact commands (create / comment / close) are asserted without touching GitHub.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../scripts/reality-notify.mjs';

const failing = {
  verdict: 'fail',
  commit: 'abcdef1234567890',
  minRate: 0.95,
  score: { verified: 11, failed: 1, disabled: 4, 'not-configured': 1, unverifiable: 2, 'not-deployed': 1, workingRate: 0.9167 },
  live: [
    { id: 'elevenlabs', secret: 'ELEVENLABS_API_KEY + CELIA_VOICE_ID', verdict: 'failed', detail: 'voice_not_found | key CAN synthesize' },
    { id: 'deepseek', secret: 'DEEPSEEK_API_KEY', verdict: 'disabled', detail: 'retired in Git' }
  ],
  offline: { pass: 326, tests: 326, coverage: { lines: 86.1 } },
  mysql: { ran: true, pass: 11, tests: 11 },
  verdictReason: 'only 92% of configured services work (elevenlabs)'
};

const passing = { ...failing, verdict: 'pass', score: { ...failing.score, failed: 0, verified: 12, workingRate: 1 }, live: [], verdictReason: null };

async function fakeGh({ open = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'celia-gh-'));
  const log = path.join(directory, 'calls.log');
  const binary = path.join(directory, 'gh');
  await writeFile(
    binary,
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$1 $2" in
  "issue list") if [ "${open ? '1' : '0'}" = "1" ]; then printf '[{"number":7}]'; else printf '[]'; fi ;;
  "issue create") printf 'https://github.com/celiaelazamey-arch/phone-google/issues/8\\n' ;;
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
  return { directory, calls };
}

const reportPath = async (directory, report) => {
  const file = path.join(directory, 'reality.json');
  await writeFile(file, JSON.stringify(report), 'utf8');
  return file;
};

test('reality notify: a dry run prints the body and calls nothing', async () => {
  const { directory, calls } = await fakeGh();
  const file = await reportPath(directory, failing);
  const printed = [];
  const code = await main({ argv: ['--report', file, '--dry-run'], env: { PATH: `${directory}:${process.env.PATH}` }, log: (line) => printed.push(line) });
  assert.equal(code, 0);
  assert.match(printed.join('\n'), /Service reality — ❌ fail/);
  assert.deepEqual(await calls(), []);
});

test('reality notify: a passing audit closes the open tracking issue itself', async () => {
  const { directory, calls } = await fakeGh({ open: true });
  const file = await reportPath(directory, passing);
  const printed = [];
  const code = await main({
    argv: ['--report', file],
    env: { PATH: `${directory}:${process.env.PATH}`, GH_TOKEN: 'token', RUN_URL: 'https://example.test/run/1' },
    log: (line) => printed.push(line)
  });
  assert.equal(code, 0);
  const issued = await calls();
  assert.ok(issued.some((line) => line.startsWith('label create service-reality')), 'the label is created idempotently');
  assert.ok(issued.some((line) => line.startsWith('issue comment 7 --body-file')), 'the pass is recorded as a comment');
  assert.ok(issued.some((line) => line.startsWith('issue close 7')), 'the issue closes itself');
  assert.match(printed.join('\n'), /closed issue #7/);
});

test('reality notify: a passing audit with no open issue stays silent and green', async () => {
  const { directory, calls } = await fakeGh({ open: false });
  const file = await reportPath(directory, passing);
  const printed = [];
  const code = await main({ argv: ['--report', file], env: { PATH: `${directory}:${process.env.PATH}`, GH_TOKEN: 'token' }, log: (line) => printed.push(line) });
  assert.equal(code, 0);
  assert.match(printed.join('\n'), /no open tracking issue/);
  assert.ok(!(await calls()).some((line) => line.startsWith('issue create')));
});

test('reality notify: a failing audit opens one issue when none is open', async () => {
  const { directory, calls } = await fakeGh({ open: false });
  const file = await reportPath(directory, failing);
  const printed = [];
  const code = await main({ argv: ['--report', file], env: { PATH: `${directory}:${process.env.PATH}`, GITHUB_TOKEN: 'token' }, log: (line) => printed.push(line) });
  assert.equal(code, 0);
  const created = (await calls()).find((line) => line.startsWith('issue create'));
  assert.ok(created, 'an issue must be created');
  assert.match(created, /--title Service reality below threshold \(92%\)/);
  assert.match(created, /--label service-reality/);
  assert.match(printed.join('\n'), /opened https:\/\/github\.com/);
});

test('reality notify: a failing audit comments on the existing issue instead of opening a second one', async () => {
  const { directory, calls } = await fakeGh({ open: true });
  const file = await reportPath(directory, failing);
  const printed = [];
  const code = await main({ argv: ['--report', file], env: { PATH: `${directory}:${process.env.PATH}`, GH_TOKEN: 'token' }, log: (line) => printed.push(line) });
  assert.equal(code, 0);
  const issued = await calls();
  assert.ok(issued.some((line) => line.startsWith('issue comment 7')));
  assert.ok(!issued.some((line) => line.startsWith('issue create')));
  assert.match(printed.join('\n'), /appended to issue #7/);
});

test('reality notify: refusing to call GitHub without a token is an error, not a silent success', async () => {
  const { directory } = await fakeGh();
  const file = await reportPath(directory, failing);
  await assert.rejects(
    main({ argv: ['--report', file], env: { PATH: `${directory}:${process.env.PATH}` }, log: () => {} }),
    /GH_TOKEN \(issues:write\) is required/
  );
});

test('reality notify: an unknown CLI flag is rejected', async () => {
  const { directory } = await fakeGh();
  const file = await reportPath(directory, failing);
  await assert.rejects(main({ argv: ['--report', file, '--nope'], env: {}, log: () => {} }), /unknown argument: --nope/);
});
