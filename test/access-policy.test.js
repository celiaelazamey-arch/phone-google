// GOV-002 / DEC-084 — the CeliaOS 2026 access policy. These tests are not about a table existing:
// they are about the table deciding what it claims, about the lattice not collapsing into one ladder,
// about owner-only grants being unreachable from every tier, and about the published matrix being a
// deterministic function of the constants rather than a document that drifts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  ACCESS_POLICY_VERSION,
  ACCOUNT_ACCESS,
  DOMAINS,
  GITHUB_GRANTS,
  GRANTS,
  GRANT_IDS,
  LEVELS,
  LIMITS,
  MANAGEMENT_LOOP,
  NETWORK_DEFAULT,
  OWNER_ACTIONS,
  REASON,
  SERVICE_GRANTS,
  TIER_IDS,
  TIERS,
  VERDICT,
  decideAccess,
  grantById,
  policySummary,
  reachableTiers,
  tierSatisfies
} from '../src/agent/access-policy.js';
import { HARNESS_LIFECYCLE_STAGES } from '../src/agent/harness.js';
import { DOCS_PATH, buildMarkdown } from '../scripts/render-access-policy.mjs';

const root = path.resolve(import.meta.dirname, '..');
const digest = (payload) => `sha256:${payload.length}:${payload}`;

test('registry: the matrix is complete, unique and names only known domains, tiers and levels', () => {
  assert.ok(GRANTS.length >= 60, 'the owner asked for the full surface, not a sample');
  assert.equal(new Set(GRANT_IDS).size, GRANT_IDS.length, 'grant ids must be unique');
  for (const grant of GRANTS) {
    assert.match(grant.id, /^[a-z_]+\.[a-z0-9_.]+$/, `${grant.id} must be a dotted id`);
    assert.ok(String(grant.ar || '').trim(), `${grant.id} needs an Arabic label`);
    assert.ok(DOMAINS[grant.domain], `${grant.id} has an unknown domain`);
    assert.ok(TIER_IDS.includes(grant.tier), `${grant.id} requires an unknown tier`);
    assert.ok(LEVELS.includes(grant.level), `${grant.id} has an unknown level`);
    assert.ok(['never', 'always'].includes(grant.approval), `${grant.id} has an unknown approval mode`);
    for (const flag of ['ownerOnly', 'selfGovernance', 'wired']) {
      assert.equal(typeof grant[flag], 'boolean', `${grant.id}.${flag} must be a boolean`);
    }
  }
});

test('registry: every grant cites evidence that exists in this repository', () => {
  for (const grant of GRANTS) {
    assert.ok(grant.evidence, `${grant.id} must cite evidence`);
    const target = path.join(root, grant.evidence);
    assert.ok(existsSync(target), `${grant.id} cites ${grant.evidence}, which does not exist`);
  }
  for (const limit of LIMITS) {
    assert.ok(existsSync(path.join(root, limit.evidence)), `limit ${limit.id} cites a missing file`);
  }
  for (const action of OWNER_ACTIONS) {
    assert.ok(existsSync(path.join(root, action.evidence)), `owner action ${action.id} cites a missing file`);
  }
});

test('the owner\'s GitHub table survives verbatim: nineteen rows, none dropped', () => {
  const expected = [
    'contents.read',
    'contents.write',
    'commit.push',
    'branches.manage',
    'pull_requests.manage',
    'pull_requests.merge',
    'issues.manage',
    'labels_milestones.manage',
    'releases.manage',
    'projects.manage',
    'discussions.manage',
    'actions.manage',
    'workflows.manage',
    'secrets_variables.manage',
    'environments.manage',
    'webhooks.manage',
    'settings.manage',
    'rulesets.manage',
    'pages.manage'
  ];
  assert.deepEqual(
    GITHUB_GRANTS.map((grant) => grant.id.replace('github.', '')),
    expected,
    'the GitHub matrix must keep the owner\'s nineteen rows, in order'
  );
  assert.equal(SERVICE_GRANTS.length, 11, 'eleven external services, as specified');
});

test('default deny: an unnamed grant is refused before any tier is consulted', () => {
  const unknown = decideAccess({ grantId: 'github.delete_repository', tier: 'admin' });
  assert.equal(unknown.verdict, VERDICT.deny);
  assert.equal(unknown.reason, REASON.unknownGrant);
  assert.equal(unknown.executable, false);
  assert.equal(decideAccess({ grantId: null, tier: 'admin' }).reason, REASON.unknownGrant);
  assert.equal(decideAccess({}).reason, REASON.unknownGrant);
});

test('tiers are a lattice, not a ladder: admin never reaches infrastructure or the operator surface', () => {
  assert.ok(tierSatisfies('admin', 'write'), 'admin can write the repository');
  assert.ok(tierSatisfies('admin', 'execute'), 'admin can run the gates');
  assert.equal(tierSatisfies('admin', 'infra_admin'), false, 'repository admin grants no cloud access');
  assert.equal(tierSatisfies('admin', 'system_operator'), false, 'repository admin grants no browser/computer');
  assert.equal(tierSatisfies('infra_admin', 'admin'), false, 'cloud admin grants no repository settings');
  assert.equal(tierSatisfies('infra_admin', 'write'), false, 'cloud admin grants no repository writes');
  assert.equal(tierSatisfies('system_operator', 'admin'), false, 'operator grants no repository settings');
  assert.equal(tierSatisfies('execute', 'write'), false, 'running jobs is not editing files');
  for (const tier of TIER_IDS) assert.ok(reachableTiers(tier).has('read'), `every tier reads: ${tier}`);
});

test('owner-only grants are unreachable from every tier, including admin', () => {
  const ownerOnly = GRANTS.filter((grant) => grant.ownerOnly);
  assert.ok(ownerOnly.length >= 8, 'secrets, environments, webhooks, settings, rulesets, Pages, identity, keys');
  for (const grant of ownerOnly) {
    for (const tier of TIER_IDS) {
      const decision = decideAccess({
        grantId: grant.id,
        tier,
        context: { ownerAuthorised: true, approval: { decision: 'approved', payloadHash: digest('x') }, payloadHash: digest('x') }
      });
      assert.equal(decision.verdict, VERDICT.deny, `${grant.id} must stay owner-only under ${tier}`);
      assert.equal(decision.reason, REASON.ownerOnly);
      assert.equal(decision.executable, false);
    }
  }
});

test('no grant reads a secret; the secrets row is owner-only and refuses even an owner-authorised admin', () => {
  assert.deepEqual(
    GRANTS.filter((grant) => /secret/i.test(grant.id)).map((grant) => grant.id),
    ['github.secrets_variables.manage'],
    'exactly one grant is named after secrets, and it is owner-only'
  );
  for (const id of ['github.secrets_variables.manage', 'service.whatsapp.meta', 'service.google_ai.keys', 'security.identity.write']) {
    assert.equal(grantById(id).ownerOnly, true, `${id} must be owner-only`);
    const decision = decideAccess({ grantId: id, tier: 'admin', context: { ownerAuthorised: true } });
    assert.equal(decision.reason, REASON.ownerOnly);
  }
});

test('self-governance: policy, approval gate, sandbox, workflow files and rulesets cannot be edited silently', () => {
  const governed = GRANTS.filter((grant) => grant.selfGovernance).map((grant) => grant.id).sort();
  assert.deepEqual(governed, [
    'github.rulesets.manage',
    'github.workflows.manage',
    'security.approval.write',
    'security.policy.write',
    'security.sandbox.write'
  ]);
  const silent = decideAccess({ grantId: 'security.policy.write', tier: 'admin' });
  assert.equal(silent.verdict, VERDICT.deny);
  assert.equal(silent.reason, REASON.selfGovernance);
  const authorised = decideAccess({ grantId: 'security.policy.write', tier: 'admin', context: { ownerAuthorised: true } });
  assert.equal(authorised.verdict, VERDICT.deny);
  assert.equal(authorised.reason, REASON.approvalRequired, 'owner authorisation alone is not an approval');
  assert.equal(authorised.executable, false);
});

test('approval is bound to the payload fingerprint; a different payload is refused', () => {
  const grant = 'github.releases.manage';
  const payloadHash = digest('{"tag":"v0.2.2"}');
  assert.equal(decideAccess({ grantId: grant, tier: 'write' }).reason, REASON.approvalRequired);
  const mismatch = decideAccess({
    grantId: grant,
    tier: 'write',
    context: { payloadHash, approval: { decision: 'approved', payloadHash: digest('{"tag":"v9.9.9"}') } }
  });
  assert.equal(mismatch.verdict, VERDICT.deny);
  assert.equal(mismatch.reason, REASON.approvalFingerprintMismatch);
  const matching = decideAccess({ grantId: grant, tier: 'write', context: { payloadHash, approval: { decision: 'approved', payloadHash } } });
  assert.equal(matching.verdict, VERDICT.allow);
  assert.equal(matching.executable, false, 'policy allows it; nothing is wired to execute it');
});

test('an immutable release cannot be rewritten by any approval', () => {
  const payloadHash = digest('bundle');
  const decision = decideAccess({
    grantId: 'github.releases.manage',
    tier: 'admin',
    context: { releaseImmutable: true, payloadHash, approval: { decision: 'approved', payloadHash } }
  });
  assert.equal(decision.verdict, VERDICT.deny);
  assert.equal(decision.reason, REASON.immutableRelease);
});

test('the kill switch outranks every grant, including a matching approval', () => {
  const payloadHash = digest('payload');
  for (const grant of GRANTS) {
    const decision = decideAccess({
      grantId: grant.id,
      tier: 'admin',
      context: { suspended: true, ownerAuthorised: true, payloadHash, approval: { decision: 'approved', payloadHash } }
    });
    assert.equal(decision.verdict, VERDICT.deny, `${grant.id} survived the kill switch`);
    assert.equal(decision.reason, REASON.killSwitch);
  }
});

test('every external or cloud grant carries a recorded approval; none is flatly allowed', () => {
  const external = GRANTS.filter((grant) => grant.tier === 'infra_admin' || grant.tier === 'system_operator');
  assert.ok(external.length >= 12, 'cloud, database, browser and computer grants exist');
  for (const grant of external) {
    assert.equal(grant.approval, 'always', `${grant.id} leaves the repository and needs an approval`);
    for (const tier of ['infra_admin', 'system_operator']) {
      if (!tierSatisfies(tier, grant.tier)) continue;
      const decision = decideAccess({ grantId: grant.id, tier });
      assert.notEqual(decision.verdict, VERDICT.allow, `${grant.id} must not be allowed without an approval`);
    }
  }
});

test('nothing is wired: policy verdict never becomes an executed action in this repository', () => {
  const summary = policySummary();
  assert.equal(summary.wired, 0, 'no grant is wired to an executor');
  for (const grant of GRANTS) {
    assert.equal(grant.wired, false, `${grant.id} claims to be wired`);
    const decision = decideAccess({ grantId: grant.id, tier: 'system_operator' });
    assert.equal(decision.executable, false, `${grant.id} must not be executable`);
  }
});

test('declared facts: network default, account access, and the eight limits the owner will not lift', () => {
  assert.equal(NETWORK_DEFAULT, 'DENY');
  assert.deepEqual(ACCOUNT_ACCESS, {
    githubOwner: 'forbidden',
    githubOrganisation: 'forbidden',
    personalKeys: 'forbidden',
    paymentMethods: 'forbidden'
  });
  assert.deepEqual(
    LIMITS.map((limit) => limit.id),
    [
      'network_default_deny',
      'human_approval',
      'payload_fingerprint',
      'evidence_chain',
      'independent_verify',
      'no_secrets',
      'kill_switch',
      'no_self_policy'
    ]
  );
  assert.equal(ACCESS_POLICY_VERSION, 'celiaos-access-policy-2026-v1');
});

test('the ten management steps use the harness\'s literal stage names — no invented stage', () => {
  assert.equal(MANAGEMENT_LOOP.length, 10);
  assert.deepEqual(MANAGEMENT_LOOP.map((step) => step.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const used = new Set(MANAGEMENT_LOOP.map((step) => step.stage).filter(Boolean));
  for (const stage of used) {
    assert.ok(HARNESS_LIFECYCLE_STAGES.includes(stage), `${stage} is not one of the ten harness stages`);
  }
  assert.equal(MANAGEMENT_LOOP.filter((step) => step.stage === null).length, 1, 'merge and publish sit outside the harness');
  assert.equal(MANAGEMENT_LOOP[7].stage, null);
  for (const stage of ['Goal', 'Plan', 'Approval', 'Observe', 'Update State']) {
    assert.ok(used.has(stage), `the loop must reference ${stage} by its literal name`);
  }
  assert.equal(HARNESS_LIFECYCLE_STAGES.length, 10, 'the harness still has exactly ten stages');
});

test('the published matrix is generated, not written: it matches the constants byte for byte', () => {
  assert.ok(existsSync(DOCS_PATH), 'docs/access-policy/README.md must exist');
  const published = readFileSync(DOCS_PATH, 'utf8');
  assert.equal(published, buildMarkdown(), 'the matrix is stale — run `npm run access:policy`');
  assert.ok(statSync(DOCS_PATH).size > 4_000, 'a matrix that fits in a paragraph is not a matrix');
  assert.match(published, /حوكمة ذاتية/, 'the published table carries the self-governance column');
  assert.match(published, /HARNESS_LIFECYCLE_STAGES/, 'the stage mapping is stated in the published doc');
});

test('summary counts agree with the registry rather than with the prose', () => {
  const summary = policySummary();
  assert.equal(summary.total, GRANTS.length);
  assert.equal(summary.ownerOnly, GRANTS.filter((grant) => grant.ownerOnly).length);
  assert.equal(summary.approvalAlways, GRANTS.filter((grant) => grant.approval === 'always').length);
  assert.equal(summary.selfGovernance, GRANTS.filter((grant) => grant.selfGovernance).length);
  assert.equal(
    Object.values(summary.byDomain).reduce((sum, count) => sum + count, 0),
    summary.total,
    'every grant belongs to exactly one domain'
  );
  assert.equal(summary.tiers, TIERS.length);
  assert.equal(summary.limits, LIMITS.length);
});
