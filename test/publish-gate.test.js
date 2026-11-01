import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  PUBLISH_GATE_VERSION,
  RULES,
  VERDICT,
  appendLedgerEvent,
  evaluatePublish,
  ledgerEntryHash,
  publishRequest,
  rollbackTarget,
  verifyLedger
} from '../src/agent/publish-gate.js';

const root = path.resolve(import.meta.dirname, '..');
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

const request = publishRequest({ channel: 'production', version: '0.2.2', commit: SHA });
const clone = (value) => JSON.parse(JSON.stringify(value));

const good = () => ({
  request: clone(request),
  branch: { name: 'arena/x', head: SHA, base: 'main', ahead: 3, behind: 0, clean: true },
  commits: [{ sha: SHA, signed: true }],
  checks: [{ name: 'Node 24 · tests', conclusion: 'success', required: true }],
  protection: {
    known: true,
    requiredSignatures: true,
    requiredApprovals: 1,
    requireCodeOwnerReview: true,
    requiredThreadResolution: true
  },
  approvals: [{ actor: 'owner', decision: 'approved', fingerprint: request.fingerprint, codeOwner: true, threadOpen: false }],
  release: { known: true, publishedVersions: ['0.2.1'], immutableVersions: ['0.2.1'] },
  grant: { id: 'infra.publish.execute', wired: true },
  ledger: []
});

const rulesOf = (result) => result.blockers.map((item) => item.rule);

test('a complete snapshot is ready, and the gate is versioned', () => {
  const result = evaluatePublish(good());
  assert.equal(result.verdict, VERDICT.ready);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.gate, PUBLISH_GATE_VERSION);
  assert.equal(result.satisfied.length, RULES.length);
});

test('the gate has twelve named rules, each bilingual', () => {
  assert.equal(RULES.length, 12);
  for (const rule of RULES) {
    assert.ok(rule.id && rule.ar && rule.en, `${rule.id} needs both languages`);
    assert.ok(['block', 'owner'].includes(rule.severity));
  }
});

test('the approval is bound to the exact request: change one field and it stops matching', () => {
  const other = publishRequest({ channel: 'production', version: '0.2.3', commit: SHA });
  assert.notEqual(other.fingerprint, request.fingerprint);
  assert.notEqual(publishRequest({ channel: 'staging', version: '0.2.2', commit: SHA }).fingerprint, request.fingerprint);
  assert.notEqual(publishRequest({ channel: 'production', version: '0.2.2', commit: OTHER_SHA }).fingerprint, request.fingerprint);

  const snapshot = good();
  snapshot.request = other;
  snapshot.approvals = [{ actor: 'owner', decision: 'approved', fingerprint: request.fingerprint, codeOwner: true }];
  const result = evaluatePublish(snapshot);
  assert.equal(result.verdict, VERDICT.blocked);
  assert.ok(rulesOf(result).includes('approval_bound'));
});

test('nothing in the world is assumed: no checks, no protection, no release state means no', () => {
  const bare = evaluatePublish({ request });
  assert.equal(bare.verdict, VERDICT.blocked);
  assert.deepEqual(new Set(rulesOf(bare)), new Set(['evidence_present', 'protection_known', 'worktree_clean', 'branch_ahead', 'approval_bound', 'version_fresh', 'capability_wired']));
  assert.equal(evaluatePublish({}).verdict, VERDICT.blocked, 'an empty call is not a green light');
});

test('an unwired capability is the owner\'s call, not a failure to hide', () => {
  const snapshot = good();
  snapshot.grant = { id: 'infra.publish.execute', wired: false };
  const result = evaluatePublish(snapshot);
  assert.equal(result.verdict, VERDICT.needsOwner);
  assert.deepEqual(rulesOf(result), ['capability_wired']);
  assert.equal(result.blockers[0].severity, 'owner');
});

test('a skipped required check is not a pass', () => {
  const skipped = good();
  skipped.checks = [{ name: 'audit', conclusion: 'skipped', required: true }];
  const result = evaluatePublish(skipped);
  assert.equal(result.verdict, VERDICT.blocked);
  assert.ok(rulesOf(result).includes('required_checks'));

  const optional = good();
  optional.checks = [{ name: 'audit', conclusion: 'skipped', required: false }];
  assert.equal(evaluatePublish(optional).verdict, VERDICT.ready, 'an optional check does not block');
});

test('unsigned commits can never pass when signatures are required — and the gate cannot sign', () => {
  const snapshot = good();
  snapshot.commits = [{ sha: SHA, signed: false }, { sha: OTHER_SHA, signed: true }];
  const result = evaluatePublish(snapshot);
  assert.equal(result.verdict, VERDICT.blocked);
  const blocker = result.blockers.find((item) => item.rule === 'signatures');
  assert.ok(blocker.detail.includes('1 of 2'));
  assert.match(blocker.fix, /will not waive/);

  const notRequired = good();
  notRequired.protection.requiredSignatures = false;
  notRequired.commits = [{ sha: SHA, signed: false }];
  assert.equal(evaluatePublish(notRequired).verdict, VERDICT.ready, 'when the rule is off, an unsigned commit is not a blocker');
});

test('required review, code-owner review and open threads are never self-served', () => {
  const noReview = good();
  noReview.approvals = [{ actor: 'owner', decision: 'approved', fingerprint: request.fingerprint, codeOwner: false, threadOpen: true }];
  const result = evaluatePublish(noReview);
  assert.ok(rulesOf(result).includes('review_requirements'));
  assert.equal(result.verdict, VERDICT.blocked);

  const noOwner = good();
  noOwner.protection.requireCodeOwnerReview = true;
  noOwner.approvals[0].codeOwner = false;
  assert.ok(rulesOf(evaluatePublish(noOwner)).includes('review_requirements'));
});

test('a rejected or stale approval blocks, and a missing one blocks', () => {
  const rejected = good();
  rejected.approvals = [{ actor: 'owner', decision: 'rejected', fingerprint: request.fingerprint, codeOwner: true }];
  assert.ok(rulesOf(evaluatePublish(rejected)).includes('approval_bound'));

  const missing = good();
  missing.approvals = [];
  assert.ok(rulesOf(evaluatePublish(missing)).includes('approval_bound'));
});

test('a published or frozen version is not republished', () => {
  const same = good();
  same.release = { known: true, publishedVersions: ['0.2.2'], immutableVersions: [] };
  assert.ok(rulesOf(evaluatePublish(same)).includes('version_fresh'));

  const frozen = good();
  frozen.release = { known: true, publishedVersions: [], immutableVersions: ['0.2.2'] };
  assert.ok(rulesOf(evaluatePublish(frozen)).includes('version_fresh'));
});

test('a dirty tree, an empty range or a stale branch all stop the publish', () => {
  for (const mutate of [
    (snapshot) => { snapshot.branch.clean = false; },
    (snapshot) => { snapshot.branch.ahead = 0; },
    (snapshot) => { snapshot.branch.behind = 2; }
  ]) {
    const snapshot = good();
    mutate(snapshot);
    assert.equal(evaluatePublish(snapshot).verdict, VERDICT.blocked);
  }
});

test('every single defect turns a ready snapshot into a refusal', () => {
  const mutations = {
    evidence_present: (snapshot) => { snapshot.checks = null; },
    protection_known: (snapshot) => { snapshot.protection.known = false; },
    worktree_clean: (snapshot) => { snapshot.branch.clean = false; },
    branch_ahead: (snapshot) => { snapshot.branch.ahead = 0; },
    branch_current: (snapshot) => { snapshot.branch.behind = 1; },
    required_checks: (snapshot) => { snapshot.checks = [{ name: 'x', conclusion: 'failure', required: true }]; },
    signatures: (snapshot) => { snapshot.commits = [{ sha: SHA, signed: false }]; },
    review_requirements: (snapshot) => { snapshot.approvals = []; },
    approval_bound: (snapshot) => { snapshot.approvals[0].fingerprint = 'pub:0000000000000000'; },
    version_fresh: (snapshot) => { snapshot.release.publishedVersions.push('0.2.2'); },
    capability_wired: (snapshot) => { snapshot.grant.wired = false; },
    ledger_intact: (snapshot) => { snapshot.ledger = [{ seq: 0, prevHash: 'x', entryHash: 'y' }]; }
  };
  for (const [rule, mutate] of Object.entries(mutations)) {
    const snapshot = good();
    mutate(snapshot);
    const result = evaluatePublish(snapshot);
    assert.notEqual(result.verdict, VERDICT.ready, `${rule} must not leave the gate ready`);
    assert.ok(rulesOf(result).includes(rule), `${rule} must be reported by name, got ${rulesOf(result)}`);
  }
  assert.deepEqual(Object.keys(mutations).sort(), RULES.map((rule) => rule.id).sort(), 'every rule has a test that breaks it');
});

test('the ledger is a hash chain: append, verify, and catch a rewrite', () => {
  let ledger = [];
  ledger = appendLedgerEvent(ledger, { at: '2026-11-01T00:00:00Z', actor: 'owner', action: 'publish', channel: 'production', version: '0.2.1', commit: SHA, requestFingerprint: request.fingerprint, outcome: 'published' });
  ledger = appendLedgerEvent(ledger, { at: '2026-11-02T00:00:00Z', actor: 'owner', action: 'publish', channel: 'production', version: '0.2.2', commit: OTHER_SHA, requestFingerprint: request.fingerprint, outcome: 'published' });
  assert.deepEqual(verifyLedger(ledger), { ok: true, index: 2, reason: 'chain intact' });
  assert.equal(ledger[1].prevHash, ledger[0].entryHash, 'each entry names the one before it');

  const rewritten = clone(ledger);
  rewritten[0].version = '9.9.9';
  const broken = verifyLedger(rewritten);
  assert.equal(broken.ok, false);
  assert.equal(broken.index, 0);
  assert.match(broken.reason, /entryHash/);

  const three = appendLedgerEvent(ledger, { at: '2026-11-03T00:00:00Z', actor: 'owner', action: 'publish', channel: 'production', version: '0.2.3', commit: SHA, requestFingerprint: request.fingerprint, outcome: 'published' });
  const removedMiddle = [three[0], three[2]];
  const gap = verifyLedger(removedMiddle);
  assert.equal(gap.ok, false, 'deleting an entry breaks the chain');
  assert.equal(gap.index, 1);
  assert.equal(verifyLedger(three).ok, true);

  const tampered = good();
  tampered.ledger = rewritten;
  assert.ok(rulesOf(evaluatePublish(tampered)).includes('ledger_intact'));
});

test('the way back is the last different version, never invented', () => {
  let ledger = [];
  for (const [version, commit] of [['0.2.0', SHA], ['0.2.1', OTHER_SHA]]) {
    ledger = appendLedgerEvent(ledger, { at: '2026-11-01T00:00:00Z', actor: 'owner', action: 'publish', channel: 'production', version, commit, requestFingerprint: request.fingerprint, outcome: 'published' });
  }
  assert.deepEqual(
    (({ version, commit }) => ({ version, commit }))(rollbackTarget(ledger, { fromVersion: '0.2.2' })),
    { version: '0.2.1', commit: OTHER_SHA }
  );
  assert.equal(rollbackTarget([], { fromVersion: '0.2.2' }), null);
  assert.equal(rollbackTarget(ledger, { fromVersion: '0.2.1' }).version, '0.2.0', 'rolling back from the newest skips it');
});

test('the gate module cannot act: no process, no network, no filesystem', () => {
  const source = readFileSync(path.join(root, 'src', 'agent', 'publish-gate.js'), 'utf8');
  for (const forbidden of ['node:child_process', 'node:http', 'node:https', 'node:fs', 'fetch(']) {
    assert.ok(!source.includes(forbidden), `the gate must not import ${forbidden}`);
  }
});

test('the CLI reads the local world, refuses without evidence, and never exits green on doubt', () => {
  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync(process.execPath, [path.join(root, 'scripts', 'publish-gate.mjs'), '--json'], { cwd: root, encoding: 'utf8' });
  } catch (error) {
    stdout = String(error.stdout ?? '');
    status = error.status;
  }
  const output = JSON.parse(stdout);
  assert.equal(status, 1);
  assert.equal(output.verdict, VERDICT.blocked);
  assert.ok(output.blockers.some((item) => item.rule === 'evidence_present'));
  assert.equal(output.request.commit.length, 40);
  assert.match(output.request.fingerprint, /^pub:[a-f0-9]{16}$/);
});
