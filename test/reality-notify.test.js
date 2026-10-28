import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIssueBody, parseArgs, LABEL } from '../scripts/reality-notify.mjs';
import { COVERAGE_FLOOR, coverageShortfalls } from '../scripts/service-reality.mjs';

const report = {
  verdict: 'fail', minRate: 0.95, commit: '0ea7600abcdef',
  offline: { tests: 324, pass: 324, fail: 0, coverage: { lines: 85.8, branches: 72, functions: 84 } },
  mysql: { ran: true, tests: 11, pass: 11, fail: 0 },
  score: { verified: 10, failed: 2, disabled: 4, 'not-configured': 1, unverifiable: 2, 'not-deployed': 1, configured: 12, workingRate: 0.8333 },
  live: [
    { id: 'elevenlabs', secret: 'ELEVENLABS_API_KEY + CELIA_VOICE_ID', verdict: 'failed', detail: 'voice_not_found | key CAN synthesize' },
    { id: 'figma', secret: 'FIGMA_ACCESS_TOKEN', verdict: 'failed', detail: 'figma API rejected the request (401)' },
    { id: 'deepseek', verdict: 'disabled', detail: 'retired in Git' },
    { id: 'gemini', verdict: 'verified', detail: 'answered' }
  ]
};

test('the tracking-issue body names failed services, their secrets and the retired set, and tells the owner how it closes', () => {
  const body = buildIssueBody(report, { runUrl: 'https://github.com/o/r/actions/runs/1', now: new Date('2026-11-02T06:00:00Z') });
  assert.match(body, /❌ fail \(2026-11-02\)/);
  assert.match(body, /Run: https:\/\/github\.com\/o\/r\/actions\/runs\/1/);
  assert.match(body, /Working rate of configured services: \*\*83%\*\* \(threshold 95%\)/);
  assert.match(body, /10 verified · 2 failed · 4 retired/);
  assert.match(body, /Offline suite: 324\/324 · coverage lines 85\.8%/);
  assert.match(body, /Real MySQL suite: 11\/11/);
  assert.match(body, /\| `elevenlabs` \| `ELEVENLABS_API_KEY \+ CELIA_VOICE_ID` \| voice_not_found \\\| key CAN synthesize \|/);
  assert.match(body, /\| `figma` \| `FIGMA_ACCESS_TOKEN` \|/);
  assert.match(body, /Retired by decision \(not counted\): `deepseek`/);
  assert.match(body, /closes itself on the next passing run/);
  assert.ok(!body.includes('gemini'), 'verified services are not listed as problems');
  const pass = buildIssueBody({ ...report, verdict: 'pass', score: { ...report.score, failed: 0, workingRate: 1 }, live: [] });
  assert.match(pass, /✅ pass/);
  assert.equal(LABEL, 'service-reality');
  assert.deepEqual(parseArgs(['--report', 'x.json', '--dry-run']), { report: 'x.json', dryRun: true });
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
});

test('coverage floor: below any metric is a named shortfall, the floor leaves headroom under the current suite', () => {
  assert.deepEqual(COVERAGE_FLOOR, { lines: 89, branches: 71, functions: 82 });
  assert.deepEqual(coverageShortfalls({ lines: 90.3, branches: 73.2, functions: 83.8 }), []);
  assert.deepEqual(coverageShortfalls({ lines: 88.9, branches: 70.9, functions: 81.9 }), [
    'lines 88.9% < 89%',
    'branches 70.9% < 71%',
    'functions 81.9% < 82%'
  ]);
  assert.deepEqual(coverageShortfalls(null), []);
});
