import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { LIVE_SCENARIOS, evaluateLiveGate, timedProvider } from '../scripts/planner-live.mjs';
import { sanitize } from '../scripts/service-reality.mjs';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'gemini-live-key-that-must-never-surface';

function cleanRun(overrides = {}) {
  return {
    id: 'live-1',
    status: 'succeeded',
    fallbacks: 0,
    fallbackCodes: [],
    tokens: 42,
    costMicros: 0,
    toolNames: ['celia.thread_context'],
    toolRisks: { 'celia.thread_context': 'read' },
    verificationVerdict: 'PASS',
    evidenceChainOk: true,
    outboxCount: 0,
    approvalsCount: 0,
    ...overrides
  };
}

test('LIVE-01 — the gate passes only a clean, measured, fallback-free, read-only live run', () => {
  assert.deepEqual(evaluateLiveGate({ runs: [cleanRun()], env: {} }), { ok: true, failures: [] });
  const two = [cleanRun(), { ...cleanRun(), id: 'live-2', toolNames: [], toolRisks: {} }];
  assert.equal(evaluateLiveGate({ runs: two, env: {} }).ok, true);

  // Each rule names the fact it refuses, so a failure is never a bare "false".
  const cases = [
    [{ status: 'failed' }, /live-1:status_failed/],
    [{ fallbacks: 1, fallbackCodes: ['planner_provider_timeout'] }, /live-1:planner_fallback_planner_provider_timeout/],
    [{ tokens: 0 }, /live-1:tokens_not_measured/],
    [{ costMicros: 7 }, /live-1:cost_claimed_without_price_table/],
    [{ verificationVerdict: 'BLOCK' }, /live-1:verification_BLOCK/],
    [{ evidenceChainOk: false }, /live-1:evidence_chain_unverified/],
    [{ outboxCount: 1 }, /live-1:external_effect_attempted/],
    [{ approvalsCount: 1 }, /live-1:approval_required/],
    [{ toolNames: ['whatsapp.send_text'], toolRisks: { 'whatsapp.send_text': 'external_effect' } }, /live-1:non_read_tool_whatsapp.send_text/]
  ];
  for (const [override, pattern] of cases) {
    const verdict = evaluateLiveGate({ runs: [cleanRun(override)], env: {} });
    assert.equal(verdict.ok, false, JSON.stringify(override));
    assert.match(verdict.failures.join(' '), pattern);
  }
  assert.match(evaluateLiveGate({ runs: [], env: {} }).failures.join(' '), /no_runs/);
  assert.match(evaluateLiveGate({ runs: [cleanRun({ status: 'failed', error: 'planner_failed' })], env: {} }).failures.join(' '), /live-1:status_failed_planner_failed/);
});

test('LIVE-02 — scenario shapes are enforced: a required read, no gratuitous tool, and a vague brief that stays bounded', () => {
  // live-1 must actually read; live-2 must not call anything; live-3 must not guess a tool from "نفّذ المهمة".
  const noRead = evaluateLiveGate({ runs: [{ ...cleanRun(), id: 'live-1', toolNames: [], toolRisks: {} }], env: {} });
  assert.match(noRead.failures.join(' '), /live-1:expected_a_read/);

  const extraTool = evaluateLiveGate({ runs: [{ ...cleanRun(), id: 'live-2' }], env: {} });
  assert.match(extraTool.failures.join(' '), /live-2:unnecessary_tool_call/);

  // DEC-061: a vague brief may read once before asking, and a clarification is recorded as a bounded delivery.
  const vagueRead = evaluateLiveGate({ runs: [{ ...cleanRun(), id: 'live-3', status: 'failed', error: 'bounded_delivery' }], env: {} });
  assert.equal(vagueRead.ok, true, vagueRead.failures.join(' '));
  const vagueSpin = evaluateLiveGate({ runs: [{ ...cleanRun(), id: 'live-3', toolNames: ['celia.thread_context', 'product.catalog_audit'], toolRisks: { 'celia.thread_context': 'read', 'product.catalog_audit': 'read' } }], env: {} });
  assert.match(vagueSpin.failures.join(' '), /live-3:vague_brief_exceeded_one_read/);
  // A bounded delivery is only acceptable for the vague brief and only when the verifier said PASS.
  const boundedWrongScenario = evaluateLiveGate({ runs: [{ ...cleanRun(), status: 'failed', error: 'bounded_delivery' }], env: {} });
  assert.match(boundedWrongScenario.failures.join(' '), /live-1:status_failed_bounded_delivery/);
  const boundedBlocked = evaluateLiveGate({ runs: [{ ...cleanRun(), id: 'live-3', status: 'failed', error: 'bounded_delivery', verificationVerdict: 'BLOCK' }], env: {} });
  assert.match(boundedBlocked.failures.join(' '), /live-3:verification_BLOCK/);
  const failedNoReason = evaluateLiveGate({ runs: [{ ...cleanRun(), id: 'live-3', status: 'failed' }], env: {} });
  assert.match(failedNoReason.failures.join(' '), /live-3:status_failed/);

  assert.deepEqual(LIVE_SCENARIOS.map((scenario) => scenario.id), ['live-1', 'live-2', 'live-3']);
  assert.equal(LIVE_SCENARIOS.every((scenario) => scenario.goal.length > 0), true);
});

test('LIVE-03 — a report carrying any tracked secret value is rejected, and sanitize() redacts it first', () => {
  const env = { GEMINI_API_KEY: KEY, GOOGLE_CLIENT_SECRET: 'another-secret-value' };
  const leaky = { model: 'gemini-2.5-flash', debug: `key=${KEY}` };
  const verdict = evaluateLiveGate({ runs: [cleanRun()], report: leaky, env });
  assert.match(verdict.failures.join(' '), /secret_leaked_in_report/);

  const cleaned = JSON.parse(sanitize(JSON.stringify(leaky), env));
  assert.equal(cleaned.debug.includes(KEY), false);
  assert.equal(cleaned.debug.includes('<redacted>'), true);
  assert.equal(evaluateLiveGate({ runs: [cleanRun()], report: cleaned, env }).ok, true);
});

test('LIVE-03b — a 429 is retried once by the probe and both attempts stay visible in the call log', async () => {
  const quota = Object.assign(new Error('planner_provider_failed'), { code: 'planner_provider_failed', details: ['http_status:429'] });
  let attempts = 0;
  const flaky = {
    name: 'gemini',
    model: 'gemini-2.5-flash',
    kind: 'cloud',
    async createPlan() {
      attempts += 1;
      if (attempts === 1) throw quota;
      return { plan: '{}', usage: { totalTokens: 42 } };
    }
  };
  const latencies = [];
  const calls = [];
  const provider = timedProvider(flaky, latencies, calls, null, { retryMs: 0, retries: 1 });
  const envelope = await provider.createPlan({});
  assert.equal(envelope.usage.totalTokens, 42);
  assert.deepEqual(calls.map((call) => [call.ok, call.attempt]), [[false, 0], [true, 1]]);
  assert.deepEqual(calls[0].details, ['http_status:429']);

  // Any other failure is not retried: a broken plan is a planning result, not a quota answer.
  let hardAttempts = 0;
  const broken = { name: 'gemini', model: 'm', kind: 'cloud', async createPlan() { hardAttempts += 1; throw Object.assign(new Error('planner_provider_timeout'), { code: 'planner_provider_timeout' }); } };
  await assert.rejects(() => timedProvider(broken, [], [], null, { retryMs: 0 }).createPlan({}), /planner_provider_timeout/);
  assert.equal(hardAttempts, 1, 'a timeout is reported, not retried');
});

test('LIVE-04 — without a key the script refuses to run (exit 2) and never pretends to have planned', async () => {
  const env = { ...process.env };
  delete env.GEMINI_API_KEY;
  await assert.rejects(
    () => run(process.execPath, ['scripts/planner-live.mjs'], { cwd: root, env }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(String(error.stderr), /GEMINI_API_KEY is not set/);
      return true;
    }
  );
  await assert.rejects(
    () => run(process.execPath, ['scripts/planner-live.mjs', '--max-runs', '9'], { cwd: root, env: { ...process.env, GEMINI_API_KEY: KEY } }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(String(error.stderr), /between 1 and 3/);
      return true;
    }
  );
});

test('LIVE-05 — the workflow is manual/opted-in only, read-only, pinned and sanitized by construction', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/planner-live.yml'), 'utf8');
  assert.match(workflow, /^permissions:\n {2}contents: read$/m, 'the token is read-only');
  assert.equal(/contents:\s*write/.test(workflow), false, 'never writes repository contents');
  assert.match(workflow, /workflow_dispatch:/, 'the owner can trigger it manually');
  assert.match(workflow, /contains\(github\.event\.head_commit\.message, '\[planner-live\]'\)/, 'push needs an explicit marker');
  assert.equal(/pull_request_target/.test(workflow), false);
  assert.match(workflow, /GEMINI_API_KEY: \$\{\{ secrets\.GEMINI_API_KEY \}\}/, 'the key comes from the repository secret');
  assert.match(workflow, /CELIA_AGENT_PLANNER: provider/, 'provider mode is scoped to this job');
  assert.equal((workflow.match(/\$\{\{ secrets\./g) || []).length, 1, 'exactly one secret reference exists');
  for (const line of workflow.split('\n')) {
    if (!/^\s*(?:- )?(?:run:|echo|printenv)/.test(line)) continue;
    assert.equal(/\$\{?GEMINI_API_KEY\}?/.test(line) && /echo/.test(line), false, `no echo of the key: ${line.trim()}`);
  }
  assert.equal(/printenv/.test(workflow), false, 'the environment is never dumped');
  for (const line of workflow.split('\n')) {
    const match = line.match(/^\s*-?\s*uses:\s*(\S+)(.*)$/);
    if (!match) continue;
    assert.match(match[1], /@[a-f0-9]{40}$/, `${match[1]} is pinned to a commit SHA`);
    assert.match(match[2], /#\s*v\d+/, `${match[1]} carries a version comment`);
  }
  assert.match(workflow, /node scripts\/planner-live\.mjs/, 'runs the reviewed script');
  assert.match(workflow, /refuse|exit 2|not configured/, 'a missing secret fails the job instead of skipping silently');
});
