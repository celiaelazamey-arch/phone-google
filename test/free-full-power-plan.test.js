/**
 * PLAN-003 — «بلا بطاقة، بكامل الطاقة»: the free-deployment plan is bound to the artefacts it promises.
 *
 * A deployment plan that is not checked against the profile, the workflows and the code becomes a wish
 * list within a week. These tests do not measure the network (this environment has no egress to the
 * edge); they measure that every claim in `docs/plan-free-full-power.md` still matches the file it came
 * from — the deployment profile, the edge worker, the MCP surface, the two workflows and the register.
 *
 * What they cannot prove is stated in the plan itself: that the live URL answers today. That requires
 * `verify:live` from a runner with egress, and the plan names that gate (`F1`) instead of assuming it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

const PLAN = 'docs/plan-free-full-power.md';
const plan = read(PLAN);
const profile = JSON.parse(read('docs/deployment-profile.json'));

test('FFP-01 the plan states the six gates and the single completion formula', () => {
  for (const gate of ['`F0`', '`F1`', '`F2`', '`F3`', '`F4`', '`F5`']) {
    assert.ok(plan.includes(gate), `missing gate ${gate}`);
  }
  assert.match(plan, /كامل الطاقة = F0 ∧ F1 ∧ F2 ∧ F3 ∧ \(F4 ≥ 5\/6\) ∧ \(F5 = 2\/2\)/);
  assert.match(plan, /لا يُكتب «مكتمل» قبل/);
});

test('FFP-02 «بلا بطاقة» is the profile’s own constraint, not the plan’s opinion', () => {
  assert.equal(profile.constraints.paymentCardAuthorized, false);
  assert.equal(profile.constraints.paidResourcesAuthorized, false);
  const primary = profile.selectedPath.cardFreePrimaryRuntime;
  assert.equal(primary.visaRequired, false);
  assert.equal(primary.monthlyCostUsd, 0);
  assert.match(plan, /visaRequired = false/);
  assert.match(plan, /monthlyCostUsd = 0/);
});

test('FFP-03 every retired service in the profile is named in the plan', () => {
  const retired = Object.keys(profile.serviceRetirements);
  assert.ok(retired.length >= 4, `expected the four card-blocked services, saw ${retired.length}`);
  for (const id of retired) assert.ok(plan.includes(id), `plan must name the retired service ${id}`);
  assert.match(plan, /DEC-030/);
});

test('FFP-04 the free URLs are the profile’s URLs, and the guide agrees', () => {
  const edge = profile.publication.edgeUrl;
  const pages = profile.publication.staticSiteUrl;
  const guide = read('docs/no-visa-deployment.md');
  assert.ok(plan.includes(edge), 'the plan must carry the live edge URL');
  assert.ok(guide.includes(edge), 'the guide must carry the same URL');
  assert.equal(primaryEdge(profile), edge);
  assert.match(plan, new RegExp(escape(pages)));
});

function primaryEdge(p) {
  return p.selectedPath.cardFreePrimaryRuntime.web.match(/https:\/\/[^ )]+/)[0];
}

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('FFP-05 the owner actions use the exact callback and webhook paths the guide documents', () => {
  const edge = profile.publication.edgeUrl;
  const guide = read('docs/no-visa-deployment.md');
  const callback = `${edge}/auth/google/callback`;
  const webhook = `${edge}/webhooks/whatsapp`;
  for (const [label, value] of [['redirect URI', callback], ['webhook', webhook]]) {
    assert.ok(guide.includes(value), `the guide must document the ${label}`);
    assert.ok(plan.includes(value), `the plan must reuse the documented ${label} — never invent one`);
  }
  const secrets = read('docs/no-visa-deployment.md').match(/WHATSAPP_[A-Z_]+/g);
  const unique = [...new Set(secrets)].sort();
  assert.deepEqual(unique, ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN']);
  assert.match(plan, /4 أسرار `WHATSAPP_\*`/);
  assert.match(read('docs/plan-free-full-power.md'), /`POST \/auth\/google\/link`/);
});

test('FFP-06 the measured edge surface matches the numbers the plan prints', () => {
  const mcpSource = read('src/celia-mcp.js');
  const block = mcpSource.slice(mcpSource.indexOf('export const MCP_TOOLS'), mcpSource.indexOf('export const EXTENDED_MCP_TOOLS'));
  const mcpTools = (block.match(/\n\s*name: '/g) || []).length;
  assert.equal(mcpTools, 12);
  assert.match(plan, /\*\*12\*\*/);

  const migrations = readdirSync(path.join(root, 'workers/celia-edge/migrations')).filter((name) => name.endsWith('.sql'));
  assert.equal(migrations.length, 9, 'the D1 migration count changed — update §2 and the plan');

  const worker = read('workers/celia-edge/worker.js');
  const paths = new Set([...worker.matchAll(/url\.pathname\s*===\s*'([^']+)'|pathname\.startsWith\('([^']+)'\)/g)].map((match) => match[1] || match[2]));
  assert.equal(paths.size, 13, `the edge route groups changed (${[...paths].sort().join(', ')}) — §2 must be re-measured`);

  const agentRoutes = (read('src/agent-routes.js').match(/router\.(get|post|put|patch|delete)\(/g) || []).length;
  assert.equal(agentRoutes, 24, 'the agent route count changed — the capability table must be re-measured');

  const expressEndpoints = ['src'].flatMap((directory) =>
    readdirSync(path.join(root, directory))
      .filter((name) => name.endsWith('.js'))
      .map((name) => (read(path.join(directory, name)).match(/\b(?:router|app)\.(?:get|post|put|patch|delete)\(/g) || []).length)
  ).reduce((sum, count) => sum + count, 0);
  assert.ok(expressEndpoints >= 90 && expressEndpoints <= 120, `expected ≈100 Express endpoints, measured ${expressEndpoints}`);
  assert.match(plan, /≈100/);
});

test('FFP-07 the plan rides the workflows that actually deploy, and quotes their real gate', () => {
  const deploy = read('.github/workflows/cloudflare-deploy.yml');
  assert.match(deploy, /branches:\s*\[\s*'main'\s*\]|branches: \[main\]|branches: \['main'\]/, 'the edge deploy must run on main');
  assert.match(deploy, /Verify live card-free Edge/, 'the live acceptance step is the gate the plan quotes');
  assert.match(deploy, /workflow_dispatch/, 'the workflow permits an explicit manual dispatch');
  assert.match(read('.github/workflows/pages.yml'), /deploy|pages/i);

  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts['verify:edge'], /verify-live\.mjs --mode edge/);
  assert.ok(pkg.scripts['verify:edge'].includes(profile.publication.edgeUrl), 'verify:edge must target the documented URL');

  assert.match(plan, /10\/10/, 'the plan quotes the current deploy step count');
  assert.match(plan, /workflow_dispatch/, 'the plan documents the supported owner-triggered path');
  assert.doesNotMatch(plan, /لا نشر يدوي/, 'the plan no longer denies the manual dispatch path');
  assert.match(plan, /whatsapp-onboarding configured=false/, 'the plan does not treat WhatsApp onboarding as connected');
  assert.match(plan, /SECRET_KEYS/, 'the plan defines the scope of the 18/18 binding count');
  assert.match(plan, /F5[\s\S]*?0\/2/, 'the current channel gate remains incomplete');
  assert.match(plan, /قبل القبول والترقية/, 'the initial pending slice snapshot is distinguished from post-acceptance state');
  assert.match(plan, /read-back مستقل/, 'the plan calls for verifying the promoted D1 row instead of assuming it');
  assert.match(plan, /41332109821/, 'the plan names the latest owner-dispatched Edge attempt');
  assert.match(plan, /attempt 2/, 'the plan records the latest rerun attempt number');
  assert.match(plan, /41332266884/, 'the plan preserves the earlier successful dispatch run');
  assert.match(plan, /41327476448/, 'the plan names the current Pages deployment run');
  assert.match(plan, /41327476455/, 'the plan names the frozen-release no-op rather than implying a new release');
});

test('FFP-08 the plan cannot claim parity it does not have', () => {
  assert.match(plan, /1\.5 \/ 6|1\.5\/6/, 'the measured edge score is stated');
  assert.match(plan, /24 مسارًا/, 'the agent routes are named as the gap');
  assert.match(plan, /HOST-003/, 'the deferred engine is named, not silently dropped');
  assert.match(plan, /لا يُقال/, 'the plan keeps its explicit "what is not claimed" list');
  assert.doesNotMatch(plan, /الحافة = Express/, 'the plan must not equate the edge with the deferred engine');
});

test('FFP-09 the plan is registered and reachable from every door a reader uses', () => {
  const register = read('docs/continuity/BACKLOG.md');
  const row = register.match(/^\| PLAN-003 \|.*$/m);
  assert.ok(row, 'PLAN-003 has a register row');
  assert.match(row[0], /\.\.\/plan-free-full-power\.md/, 'the register row links the plan');
  assert.match(read('README.md'), /plan-free-full-power\.md/, 'README indexes the plan');
  assert.match(read('docs/no-visa-deployment.md'), /plan-free-full-power\.md/, 'the deployment guide points to it');
  assert.match(read('docs/plan-system-completion.md'), /plan-free-full-power\.md/, 'PLAN-002 hands W3 over to it');
  assert.match(read('CHANGELOG.md'), /PLAN-003/, 'the changelog records its arrival');
});
