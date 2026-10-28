// Computer-agent permissions (AGENT-007). The point of these tests is not that a matrix exists — it is that the
// matrix decides the way the policy claims, that nothing can execute while the executor is parked, and that the
// generated infographic cannot drift from the constants it is drawn from.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  CAPABILITIES,
  CAPABILITY_IDS,
  COMPETITIVE_FEATURE,
  COMPUTER_POLICY_VERSION,
  DECISION_STEPS,
  GROUPS,
  MANDATORY_RULES,
  STATUS,
  SYSTEM_STATE,
  capabilityById,
  decideAction,
  evaluatePlan,
  policySummary
} from '../src/agent/computer-policy.js';
import { DOCS_PATH, PAGE_PATH, buildHtml, buildMarkdown, buildMermaid } from '../scripts/render-computer-permissions.mjs';

const root = path.resolve(import.meta.dirname, '..');
const statuses = Object.values(STATUS);

test('registry: every capability is complete, unique and inside a known group', () => {
  assert.ok(CAPABILITIES.length >= 15, 'the matrix must cover the whole surface');
  assert.equal(new Set(CAPABILITY_IDS).size, CAPABILITY_IDS.length, 'ids must be unique');
  for (const capability of CAPABILITIES) {
    assert.match(capability.id, /^[a-z_]+$/);
    for (const field of ['ar', 'en', 'scope', 'gate']) {
      assert.ok(capability[field] && String(capability[field]).trim(), `${capability.id}.${field} is required`);
    }
    assert.ok(statuses.includes(capability.status), `${capability.id} has an unknown status`);
    assert.ok(GROUPS[capability.group], `${capability.id} has an unknown group`);
    for (const flag of ['external', 'identity', 'wired', 'tested']) {
      assert.equal(typeof capability[flag], 'boolean', `${capability.id}.${flag} must be a boolean`);
    }
  }
});

test('registry: an external capability is never flatly allowed', () => {
  for (const capability of CAPABILITIES.filter((entry) => entry.external)) {
    assert.notEqual(capability.status, STATUS.allowed, `${capability.id} leaves the machine and cannot be allowed`);
  }
});

test('state: the three project facts are declared, not inferred', () => {
  assert.deepEqual(SYSTEM_STATE, { network: 'DENY', externalGates: 'CLOSED', identity: 'NOT_PROVEN' });
  assert.equal(COMPUTER_POLICY_VERSION, 'computer-agent-policy-v1');
});

test('decide: an unknown capability is denied by default', () => {
  const decision = decideAction({ capability: 'teleport_files' });
  assert.equal(decision.verdict, 'deny');
  assert.match(decision.reason, /default_deny/);
  assert.equal(decision.executable, false);
  assert.equal(decideAction({}).verdict, 'deny', 'no capability at all is a denial too');
});

test('decide: nothing is executable while the executor is parked — even what policy allows', () => {
  assert.equal(policySummary().wired, 0, 'no capability is wired in this repository');
  for (const capability of CAPABILITIES) {
    const decision = decideAction({ capability: capability.id, target: { approved: true } });
    assert.equal(decision.executable, false, `${capability.id} must not be executable`);
  }
  const click = decideAction({ capability: 'click' });
  assert.equal(click.verdict, 'allow', 'the policy verdict for click is allow…');
  assert.equal(click.executable, false, '…but nothing can click');
});

test('decide: network is denied and the status cannot be talked around', () => {
  const decision = decideAction({ capability: 'open_url' });
  assert.equal(decision.verdict, 'deny');
  assert.match(decision.reason, /blocked_by_policy|network_denied/);
  // Even if the network switch were flipped, an explicitly denied capability stays denied.
  const withNetworkOpen = decideAction({ capability: 'open_url', state: { ...SYSTEM_STATE, network: 'OPEN' } });
  assert.equal(withNetworkOpen.verdict, 'deny');
  // A capability that merely needs the network is refused while it is DENY.
  const message = decideAction({ capability: 'submit_form' });
  assert.equal(message.verdict, 'deny');
  assert.match(message.reason, /external_gate_closed|network_denied|identity_not_proven/);
});

test('decide: secrets and system commands are refused without an approval path', () => {
  for (const capability of ['read_secrets', 'run_system_command']) {
    const decision = decideAction({ capability, target: { approved: true } });
    assert.equal(decision.verdict, 'deny', `${capability} must not become allowed by approval`);
    assert.equal(decision.executable, false);
  }
});

test('decide: acting in the user’s name waits for a proven identity', () => {
  const denied = decideAction({ capability: 'act_as_user' });
  assert.equal(denied.verdict, 'deny');
  const proven = decideAction({ capability: 'act_as_user', state: { ...SYSTEM_STATE, identity: 'PROVEN', network: 'OPEN', externalGates: 'OPEN' } });
  assert.equal(proven.verdict, 'deny', 'the capability itself is denied, identity only adds a gate');
  assert.ok(denied.gates.length > 0);
});

test('decide: approval-required stays blocked while the external gate is closed, and needs a recorded human after', () => {
  const closed = decideAction({ capability: 'delete_file' });
  assert.equal(closed.verdict, 'require_approval');
  assert.equal(closed.executable, false);
  const approved = decideAction({ capability: 'delete_file', target: { approved: true } });
  assert.equal(approved.verdict, 'allow');
  assert.match(approved.reason, /approved_by_human/);
  assert.equal(approved.executable, false, 'approval does not wire the executor');
});

test('decide: restricted capabilities need a per-target permission', () => {
  assert.equal(decideAction({ capability: 'edit_file' }).verdict, 'require_approval');
  assert.equal(decideAction({ capability: 'edit_file', target: { approved: true } }).verdict, 'allow');
  assert.equal(decideAction({ capability: 'transfer_file' }).verdict, 'deny', 'external restricted stays closed');
});

test('decide: scope beats status — an allowed capability on the wrong target is denied', () => {
  assert.equal(decideAction({ capability: 'click', target: { inScope: true } }).verdict, 'allow');
  const outside = decideAction({ capability: 'click', target: { inScope: false } });
  assert.equal(outside.verdict, 'deny');
  assert.match(outside.reason, /out_of_scope/);
});

test('decide: the operator kill switch is always available to the operator', () => {
  const stop = decideAction({ capability: 'stop_execution' });
  assert.equal(stop.verdict, 'allow');
  assert.match(stop.reason, /allowed_within_scope/);
});

test('plan: one denial or one pending approval makes the whole plan non-executable', () => {
  const plan = evaluatePlan([{ capability: 'click' }, { capability: 'type_text' }]);
  assert.equal(plan.allowed, 2);
  assert.equal(plan.denied, 0);
  assert.equal(plan.executable, false, 'allowed but not wired');

  const blocked = evaluatePlan([{ capability: 'click' }, { capability: 'open_url' }]);
  assert.equal(blocked.denied, 1);
  assert.equal(blocked.executable, false);

  const pending = evaluatePlan([{ capability: 'delete_file' }]);
  assert.equal(pending.approvals, 1);
  assert.equal(pending.executable, false);
  assert.equal(evaluatePlan([]).executable, false, 'an empty plan executes nothing');
});

test('summary: the counts are derived from the registry', () => {
  const summary = policySummary();
  assert.equal(summary.total, CAPABILITIES.length);
  assert.equal(Object.values(summary.byStatus).reduce((a, b) => a + b, 0), summary.total);
  assert.equal(summary.byStatus[STATUS.denied], CAPABILITIES.filter((c) => c.status === STATUS.denied).length);
  assert.equal(summary.tested, CAPABILITIES.filter((c) => c.tested).length);
});

test('design: five decision steps, six mandatory rules, each rule a sentence not a slogan', () => {
  assert.equal(DECISION_STEPS.length, 5);
  assert.deepEqual(DECISION_STEPS.map((step) => step.n), [1, 2, 3, 4, 5]);
  assert.ok(MANDATORY_RULES.length >= 5);
  for (const rule of MANDATORY_RULES) assert.ok(rule.includes(':'), `rule lacks a reason: ${rule}`);
});

test('competitive feature: pillars and staged gates exist, and the claim stays a proposal', () => {
  assert.equal(COMPETITIVE_FEATURE.id, 'evidence-carrying-autonomy');
  assert.ok(COMPETITIVE_FEATURE.pillars.length >= 4);
  assert.equal(COMPETITIVE_FEATURE.stages.length, 4);
  for (const stage of COMPETITIVE_FEATURE.stages) {
    assert.ok(stage.gate && stage.build, `stage ${stage.n} needs a build item and a success gate`);
  }
  assert.match(COMPETITIVE_FEATURE.notClaimed, /ليست إثبات/, 'the feature must not be presented as proven superiority');
});

test('infographic: it is generated from the registry and cannot go stale', async () => {
  const page = await readFile(PAGE_PATH, 'utf8');
  const docs = await readFile(DOCS_PATH, 'utf8');
  assert.equal(page, buildHtml(), 'public/computer-permissions.html is stale — run npm run computer:permissions');
  assert.equal(docs, buildMarkdown(), 'docs/computer-permissions/README.md is stale');
  // Every capability is named in the picture, and the version is stamped.
  for (const capability of CAPABILITIES) assert.ok(page.includes(capability.ar), `${capability.id} missing from the page`);
  assert.ok(page.includes(COMPUTER_POLICY_VERSION));
  const mermaid = buildMermaid();
  for (const capability of CAPABILITIES) assert.ok(mermaid.includes(capability.id), `${capability.id} missing from mermaid`);
});

test('infographic: it states the limits before it shows any capability', async () => {
  const page = await readFile(PAGE_PATH, 'utf8');
  for (const fact of ['NETWORK = DENY', 'EXTERNAL GATES = CLOSED', 'IDENTITY = NOT_PROVEN']) {
    assert.ok(page.includes(fact), `${fact} must be printed`);
  }
  assert.match(page, /ليست قدرات مُشغَّلة/);
  assert.match(page, new RegExp(`0 من ${CAPABILITIES.length} قدرة موصولة`));
  assert.match(page, /executable/);
  assert.ok(page.includes(COMPETITIVE_FEATURE.ar));
});

test('infographic: nothing renders as undefined — every column has its note', async () => {
  const page = await readFile(PAGE_PATH, 'utf8');
  const docs = await readFile(DOCS_PATH, 'utf8');
  assert.doesNotMatch(page.replace(/<script[\s\S]*?<\/script>/g, ''), /\bundefined\b/, 'the page prints undefined');
  assert.doesNotMatch(docs, /\bundefined\b/, 'the markdown prints undefined');
  for (const status of Object.values(STATUS)) {
    assert.ok(buildHtml().includes(`data-status="${status}"`), `column ${status} missing from the page`);
  }
});

test('infographic: no third-party request and no unlabelled motion', async () => {
  const page = await readFile(PAGE_PATH, 'utf8');
  assert.deepEqual([...page.matchAll(/(?:src|href)="https?:\/\/[^"]+"/g)].map((m) => m[0]), []);
  assert.doesNotMatch(page, /fonts\.googleapis|cdn\./i);
  assert.match(page, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(page, /href="\.\/fonts\.css"/);
});

test('infographic: it is reachable from the studio, the status page and the computer page', async () => {
  for (const page of ['index.html', 'system.html', 'computer.html']) {
    const source = await readFile(path.join(root, 'public', page), 'utf8');
    assert.match(source, /href="\.\/computer-permissions/, `${page} must link to the permission matrix`);
  }
  const buildScript = await readFile(path.join(root, 'scripts/build-pages.mjs'), 'utf8');
  const rewriteFn = buildScript.slice(buildScript.indexOf('function rewriteStaticHostLinks'), buildScript.indexOf('export async function build'));
  assert.match(rewriteFn, /computer-permissions\.html/, 'the rewrite map must resolve ./computer-permissions');
});

test('infographic: every internal link resolves to a page that exists', async () => {
  const page = await readFile(PAGE_PATH, 'utf8');
  const internal = [...page.matchAll(/href="\.\/([^"#?]+)"/g)].map(([, target]) => target).filter(Boolean);
  assert.ok(internal.length >= 5, 'the matrix should link back into the site');
  for (const target of new Set(internal)) {
    const candidates = [target, `${target}.html`].map((name) => path.join(root, 'public', name));
    let found = false;
    for (const candidate of candidates) {
      try {
        await readFile(candidate);
        found = true;
        break;
      } catch {
        /* try the next candidate */
      }
    }
    assert.ok(found, `dead link: ./${target}`);
  }
});

test('capabilityById is a lookup, not a second registry', () => {
  assert.equal(capabilityById('click').id, 'click');
  assert.equal(capabilityById('nope'), null);
});
