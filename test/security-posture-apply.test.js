// The owner-only security controls can only be *applied* with an admin token, but the plan, the required-check names,
// the response handling and the read-only verification are deterministic — so they are pinned here without a network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GITHUB_ACTIONS_APP_ID,
  REQUIRED_CHECK_CONTEXTS,
  RULESET_IMPORT_FILE,
  RULESET_NAME,
  apply,
  classifyApply,
  formatVerify,
  ghApi,
  main,
  plan,
  qualityJobContexts,
  rulesetBody,
  rulesetImportJson,
  verify
} from '../scripts/security-posture-apply.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

/** Builds a fake `spawnSync('gh', ['api', '-i', '--method', M, ..., route, ...])` from a `${method} ${route}` table. */
function fakeGh(table, { calls = [] } = {}) {
  return (cmd, args, options = {}) => {
    assert.equal(cmd, 'gh');
    const method = args[args.indexOf('--method') + 1];
    const route = args.find((arg, index) => index > 0 && arg.startsWith('repos/'));
    const key = `${method} ${route}`;
    calls.push({ key, input: options.input ?? null });
    const entry = table[key] || table[`${method} ${route.split('?')[0]}`];
    if (!entry) return { status: 1, stdout: 'HTTP/2.0 404 Not Found\r\ncontent-type: application/json\r\n\r\n{"message":"Not Found"}', stderr: 'gh: Not Found (HTTP 404)' };
    const bodyText = entry.body === undefined ? '' : JSON.stringify(entry.body);
    return {
      status: entry.status >= 200 && entry.status < 300 ? 0 : 1,
      stdout: `HTTP/2.0 ${entry.status} ${entry.status === 204 ? 'No Content' : 'X'}\r\ncontent-type: application/json\r\n\r\n${bodyText}`,
      stderr: entry.status >= 400 ? `gh: ${entry.body?.message || 'error'} (HTTP ${entry.status})` : ''
    };
  };
}

const R = 'repos/celiaelazamey-arch/phone-google';
const FORBIDDEN = { status: 403, body: { message: 'Resource not accessible by integration' } };

// What the API answered on 2026-10-29 (recorded in docs/security-posture.md §2).
const negativeReads = {
  [`GET ${R}/branches/main`]: { status: 200, body: { name: 'main', protected: false } },
  [`GET ${R}/rules/branches/main`]: { status: 200, body: [] },
  [`GET ${R}/dependabot/alerts`]: { status: 403, body: { message: 'Dependabot alerts are disabled for this repository.' } },
  [`GET ${R}/actions/workflows`]: { status: 200, body: { workflows: [{ path: '.github/workflows/celia-mcp.yml' }, { path: 'dynamic/dependabot/dependabot-updates' }] } },
  [`GET ${R}/secret-scanning/alerts`]: FORBIDDEN,
  [`GET ${R}/actions/permissions/workflow`]: FORBIDDEN
};

const positiveReads = {
  [`GET ${R}/branches/main`]: { status: 200, body: { name: 'main', protected: false } },
  [`GET ${R}/rules/branches/main`]: {
    status: 200,
    body: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: REQUIRED_CHECK_CONTEXTS.map((context) => ({ context, integration_id: 15368 })) } }
    ]
  },
  [`GET ${R}/dependabot/alerts`]: { status: 200, body: [] },
  [`GET ${R}/actions/workflows`]: { status: 200, body: { workflows: [{ path: '.github/workflows/celia-mcp.yml' }, { path: 'dynamic/github-code-scanning/codeql' }] } },
  [`GET ${R}/secret-scanning/alerts`]: { status: 200, body: [] },
  [`GET ${R}/actions/permissions/workflow`]: { status: 200, body: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false } }
};

test('SPA-01 the required check contexts are exactly the non-optional jobs of the quality workflow (a wrong name would lock main)', () => {
  const fromWorkflow = qualityJobContexts();
  assert.ok(fromWorkflow.includes('Optional external provider availability probes'), 'the optional probes job is seen but not required');
  const expected = fromWorkflow.filter((name) => !/^Optional\b/.test(name));
  assert.deepEqual([...REQUIRED_CHECK_CONTEXTS].sort(), [...expected].sort());
  assert.equal(REQUIRED_CHECK_CONTEXTS.length, 6);
  assert.ok(!REQUIRED_CHECK_CONTEXTS.includes('CI / build'), 'the externally proposed "CI / build" context does not exist in this repository');
  const workflow = read('.github/workflows/celia-mcp.yml');
  for (const context of REQUIRED_CHECK_CONTEXTS) {
    const template = context.replace(/^Node (22|24) · /, 'Node ${{ matrix.node }} · ');
    assert.ok(workflow.includes(`name: ${template}`), `${context} is a job name in the quality workflow`);
  }
});

test('SPA-02 the plan is a readable ruleset plus three security toggles — no reviews, no linear history, no string "null"', () => {
  const steps = plan();
  assert.deepEqual(steps.map((step) => step.control), ['branch_ruleset', 'dependabot_alerts', 'dependabot_security_updates', 'codeql_default_setup', 'secret_scanning']);
  const ruleset = steps[0];
  assert.equal(ruleset.method, 'POST');
  assert.equal(ruleset.path, `${R}/rulesets`);
  assert.equal(ruleset.body.name, RULESET_NAME);
  assert.equal(ruleset.body.enforcement, 'active');
  assert.deepEqual(ruleset.body.conditions.ref_name.include, ['~DEFAULT_BRANCH']);
  assert.deepEqual(ruleset.body.bypass_actors, [], 'no bypass: the gate binds the agent too; the owner disables it in Settings in an emergency');
  const types = ruleset.body.rules.map((rule) => rule.type);
  assert.deepEqual(types, ['deletion', 'non_fast_forward', 'required_status_checks']);
  assert.ok(!types.includes('pull_request'), 'required reviews would lock a single-owner repository');
  assert.ok(!types.includes('required_linear_history'), 'the repository merges with merge commits (continuity docs cite branch SHAs)');
  const checks = ruleset.body.rules[2].parameters;
  assert.equal(checks.strict_required_status_checks_policy, false);
  assert.deepEqual(checks.required_status_checks.map((entry) => entry.context), [...REQUIRED_CHECK_CONTEXTS]);
  assert.ok(checks.required_status_checks.every((entry) => entry.integration_id === GITHUB_ACTIONS_APP_ID), 'every required check is pinned to the GitHub Actions app (15368) so no other app can satisfy it');

  assert.deepEqual(steps[1], { control: 'dependabot_alerts', method: 'PUT', path: `${R}/vulnerability-alerts`, body: null, success: [204] });
  assert.deepEqual(steps[2], { control: 'dependabot_security_updates', method: 'PUT', path: `${R}/automated-security-fixes`, body: null, success: [204] });
  assert.equal(steps[3].method, 'PATCH');
  assert.equal(steps[3].path, `${R}/code-scanning/default-setup`);
  assert.deepEqual(steps[3].body, { state: 'configured', query_suite: 'default' });
  assert.equal(steps[4].method, 'PATCH');
  assert.equal(steps[4].path, R);
  assert.equal(steps[4].body.security_and_analysis.secret_scanning.status, 'enabled');
  assert.equal(steps[4].body.security_and_analysis.secret_scanning_push_protection.status, 'enabled');
  assert.ok(!JSON.stringify(steps).includes('"null"'), 'a JSON null is never sent as the string "null" (gh api -f would)');
});

test('SPA-03 ghApi parses `gh api -i` output: status line, JSON body, empty 204 bodies and spawn failures', () => {
  const ok = ghApi({ method: 'GET', path: `${R}/x`, run: () => ({ status: 0, stdout: 'HTTP/2.0 200 OK\r\nx-a: 1\r\n\r\n{"a":1}', stderr: '' }) });
  assert.deepEqual([ok.status, ok.body], [200, { a: 1 }]);
  const empty = ghApi({ method: 'PUT', path: `${R}/x`, body: null, run: () => ({ status: 0, stdout: 'HTTP/2.0 204 No Content\r\n\r\n', stderr: '' }) });
  assert.deepEqual([empty.status, empty.body], [204, null]);
  const forbidden = ghApi({ method: 'POST', path: `${R}/x`, body: { a: 1 }, run: (cmd, args, options) => {
    assert.equal(options.input, '{"a":1}', 'JSON bodies travel through --input -');
    assert.ok(args.includes('--input'));
    return { status: 1, stdout: 'HTTP/2.0 403 Forbidden\r\n\r\n{"message":"Resource not accessible by integration"}', stderr: 'gh: ... (HTTP 403)' };
  } });
  assert.deepEqual([forbidden.status, forbidden.body.message], [403, 'Resource not accessible by integration']);
  const missing = ghApi({ method: 'GET', path: `${R}/x`, run: () => ({ status: null, stdout: '', stderr: '', error: new Error('spawnSync gh ENOENT') }) });
  assert.match(missing.spawnError, /ENOENT/);
  assert.equal(classifyApply(plan()[1], missing).outcome, 'failed');
});

test('SPA-04 apply: an integration token is reported as forbidden per control (what the agent got on 2026-10-29); an admin token applies all five', () => {
  const lines = [];
  const forbiddenTable = Object.fromEntries(plan().map((step) => [`${step.method} ${step.path}`, FORBIDDEN]));
  const forbidden = apply({ run: fakeGh(forbiddenTable), log: (line) => lines.push(line) });
  assert.equal(forbidden.ok, false);
  assert.deepEqual(forbidden.results.map((entry) => entry.outcome), ['forbidden', 'forbidden', 'forbidden', 'forbidden', 'forbidden']);
  assert.ok(forbidden.results.every((entry) => /owner's machine/.test(entry.detail)));
  assert.equal(lines.filter((line) => line.startsWith('✗')).length, 5);

  const calls = [];
  const adminTable = {
    [`POST ${R}/rulesets`]: { status: 201, body: { id: 1, name: RULESET_NAME } },
    [`PUT ${R}/vulnerability-alerts`]: { status: 204 },
    [`PUT ${R}/automated-security-fixes`]: { status: 204 },
    [`PATCH ${R}/code-scanning/default-setup`]: { status: 200, body: { state: 'configured' } },
    [`PATCH ${R}`]: { status: 200, body: { security_and_analysis: { secret_scanning: { status: 'enabled' } } } }
  };
  const applied = apply({ run: fakeGh(adminTable, { calls }), log: () => {} });
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.results.map((entry) => entry.outcome), ['applied', 'applied', 'applied', 'applied', 'applied']);
  assert.equal(JSON.parse(calls[0].input).rules.length, 3, 'the ruleset body is sent as JSON');
  assert.equal(calls[1].input, null, 'PUT toggles carry no body');

  const duplicate = apply({ run: fakeGh({ ...adminTable, [`POST ${R}/rulesets`]: { status: 422, body: { message: 'Validation Failed', errors: ['Name has already been taken'] } } }), log: () => {} });
  assert.equal(duplicate.results[0].outcome, 'already_present');
  assert.equal(duplicate.ok, true, 'an existing ruleset is not a failure — --verify decides whether it is complete');
});

test('SPA-05 verify maps real responses to the three documented states — negative reads are dated facts, 403 stays UNKNOWN', () => {
  const negative = verify({ run: fakeGh(negativeReads), today: '2026-10-29' });
  const byControl = Object.fromEntries(negative.controls.map((entry) => [entry.control, entry]));
  assert.equal(byControl['Branch protection'].status, 'NOT ENABLED (2026-10-29)');
  assert.match(byControl['Branch protection'].detail, /rules\/branches\/main → \[\]/);
  assert.equal(byControl['Dependabot alerts'].status, 'NOT ENABLED (2026-10-29)');
  assert.match(byControl['Dependabot alerts'].detail, /disabled for this repository/);
  assert.equal(byControl.CodeQL.status, 'NOT ENABLED (2026-10-29)');
  assert.equal(byControl['Secret scanning'].status, 'UNKNOWN');
  assert.equal(byControl['Workflow permissions'].status, 'UNKNOWN');
  const text = formatVerify(negative);
  assert.match(text, /✗ Branch protection: NOT ENABLED \(2026-10-29\)/);
  assert.match(text, /\? Secret scanning: UNKNOWN/);
  assert.match(text, /no inference/);

  const positive = verify({ run: fakeGh(positiveReads), today: '2026-11-01' });
  assert.deepEqual(positive.controls.map((entry) => entry.state), ['VERIFIED', 'VERIFIED', 'VERIFIED', 'VERIFIED', 'VERIFIED']);
  assert.ok(positive.controls.every((entry) => entry.status.endsWith('(2026-11-01)')));

  const partialRules = structuredClone(positiveReads);
  partialRules[`GET ${R}/rules/branches/main`].body[2].parameters.required_status_checks.pop();
  const partial = verify({ run: fakeGh(partialRules), today: '2026-11-01' });
  assert.equal(partial.controls[0].state, 'NOT ENABLED');
  assert.match(partial.controls[0].detail, /missing checks: \[MySQL 8.4/);

  const reviewsLocked = structuredClone(positiveReads);
  reviewsLocked[`GET ${R}/rules/branches/main`].body.push({ type: 'pull_request', parameters: { required_approving_review_count: 1 } });
  const locked = verify({ run: fakeGh(reviewsLocked), today: '2026-11-01' });
  assert.equal(locked.controls[0].state, 'VERIFIED');
  assert.match(locked.controls[0].detail, /WARNING: pull_request reviews required/);
});

test('SPA-06 CLI exit codes: --plan 0, --verify 2 while anything is not VERIFIED, --apply 1 when forbidden; outputs are JSON on request', async () => {
  const out = [];
  assert.equal(await main({ argv: ['--plan', '--json'], log: (line) => out.push(line) }), 0);
  assert.equal(JSON.parse(out[0]).length, 5);
  assert.equal(await main({ argv: ['--verify', '--json'], log: () => {}, run: fakeGh(negativeReads) }), 2);
  assert.equal(await main({ argv: ['--verify'], log: () => {}, run: fakeGh(positiveReads) }), 0);
  const applyLines = [];
  const forbiddenTable = Object.fromEntries(plan().map((step) => [`${step.method} ${step.path}`, FORBIDDEN]));
  assert.equal(await main({ argv: ['--apply'], log: (line) => applyLines.push(line), run: fakeGh(forbiddenTable) }), 1);
  assert.match(applyLines.at(-1), /owner's machine/);
});

test('SPA-07 the posture document and package.json point at this script, and the document never states a control as enabled without a date', () => {
  const doc = read('docs/security-posture.md');
  assert.match(doc, /security-posture-apply\.mjs/);
  assert.match(doc, /--verify/);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['security:posture'], 'node scripts/security-posture-apply.mjs');
  assert.ok(!/\|\s*ENABLED\s*\|/.test(doc));
});

test('SPA-08 the committed importable ruleset (browser path: Settings → Rules → Import a ruleset) is byte-identical to what --apply would POST', async () => {
  const committed = read(RULESET_IMPORT_FILE);
  assert.equal(committed, rulesetImportJson(), `${RULESET_IMPORT_FILE} is stale — regenerate with: npm run -s security:posture -- --ruleset-json > ${RULESET_IMPORT_FILE}`);
  const parsed = JSON.parse(committed);
  assert.equal(parsed.source_type, 'Repository');
  const { source_type: _ignored, ...withoutSource } = parsed;
  assert.deepEqual(withoutSource, JSON.parse(JSON.stringify(rulesetBody())));
  assert.equal(parsed.enforcement, 'active');
  assert.deepEqual(parsed.bypass_actors, []);
  assert.ok(!parsed.rules.some((rule) => rule.type === 'pull_request' || rule.type === 'required_linear_history'));
  assert.equal(await main({ argv: ['--ruleset-json'] }), 0);
  assert.match(read('docs/security-posture.md'), /Import a ruleset/);
});
