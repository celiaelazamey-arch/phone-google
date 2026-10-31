// MAN-002 / DEC-077 — the live deploy path must refuse a bundle that is not the reviewed
// contract, and must leave verifiable provenance for what it did upload.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import {
  compareBundleToManifest,
  bundleDigestOf,
  renderSubjects,
  verifyEdgeProvenance,
  SUBJECTS_FILE
} from '../scripts/verify-edge-provenance.mjs';
import { buildManifest } from '../scripts/build-manifest.mjs';
import { collectWorkerModules, loadMigrationFiles } from '../scripts/deploy-cloudflare-edge.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const modules = [{ name: 'a.js', source: 'export const a = 1;' }, { name: 'worker.js', source: 'import "./a.js";' }];
const migrations = [{ version: '0001_x.sql', sql: 'CREATE TABLE x (id TEXT);' }];

function manifestFor(overrides = {}) {
  return {
    targets: { edge: { modules: modules.map((m) => m.name), bundleDigest: bundleDigestOf(modules), ...overrides } },
    schema: { migrations: migrations.map((m) => ({ version: m.version, digest: `sha256:${sha256(m.sql)}` })) }
  };
}

test('PR-01 an untouched bundle verifies against its manifest', () => {
  const result = compareBundleToManifest({ manifest: manifestFor(), modules, migrations });
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

test('PR-02 a single changed byte in any module fails closed', () => {
  const tampered = [{ ...modules[0], source: 'export const a = 2;' }, modules[1]];
  const result = compareBundleToManifest({ manifest: manifestFor(), modules: tampered, migrations });
  assert.equal(result.ok, false);
  assert.ok(result.problems.includes('bundle_digest_mismatch'));
});

test('PR-03 adding or dropping a module is caught even if a digest were forged', () => {
  const extra = [...modules, { name: 'sneaky.js', source: '// extra' }];
  const manifest = manifestFor({ bundleDigest: bundleDigestOf(extra) });
  const result = compareBundleToManifest({ manifest, modules: extra, migrations });
  assert.equal(result.ok, false, 'the declared module list must match, not just the hash');
  assert.ok(result.problems.includes('module_graph_mismatch'));
});

test('PR-04 module ORDER matters because the upload order is dependency-first', () => {
  const reordered = [modules[1], modules[0]];
  const result = compareBundleToManifest({ manifest: manifestFor(), modules: reordered, migrations });
  assert.equal(result.ok, false);
  assert.ok(result.problems.includes('module_graph_mismatch'));
});

test('PR-05 an undeclared, changed or missing migration each fails with its own reason', () => {
  const undeclared = compareBundleToManifest({
    manifest: manifestFor(), modules, migrations: [...migrations, { version: '0009_new.sql', sql: 'SELECT 1;' }]
  });
  assert.ok(undeclared.problems.includes('migration_undeclared:0009_new.sql'));

  const changed = compareBundleToManifest({
    manifest: manifestFor(), modules, migrations: [{ version: '0001_x.sql', sql: 'DROP TABLE x;' }]
  });
  assert.ok(changed.problems.includes('migration_digest_mismatch:0001_x.sql'));

  const missing = compareBundleToManifest({ manifest: manifestFor(), modules, migrations: [] });
  assert.ok(missing.problems.includes('migration_missing:0001_x.sql'));
});

test('PR-06 a missing or malformed manifest is a refusal, never a pass', () => {
  assert.equal(compareBundleToManifest({ manifest: null, modules, migrations }).ok, false);
  assert.deepEqual(compareBundleToManifest({ manifest: {}, modules, migrations }).problems, ['manifest_edge_target_missing']);
});

test('PR-07 the digest rule matches what the deploy records in its slice', () => {
  // Both sides concatenate `name\nsource` joined by newline; a divergence here would make
  // the attested subject a different artifact from the recorded slice.
  const expected = `sha256:${sha256('a.js\nexport const a = 1;\nworker.js\nimport "./a.js";')}`;
  assert.equal(bundleDigestOf(modules), expected);
});

test('PR-08 the subjects file is sha256sum format naming the bundle and the manifest', () => {
  const text = renderSubjects({ bundleDigest: bundleDigestOf(modules), manifestText: '{"a":1}', commit: 'c'.repeat(40) });
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) assert.match(line, /^[a-f0-9]{64} {2}\S+$/);
  assert.ok(lines[0].includes(`celia-edge-bundle-${'c'.repeat(40)}`));
  assert.ok(lines[1].endsWith('system.manifest.json'));
  assert.equal(lines[1].split('  ')[0], sha256('{"a":1}'));
});

test('PR-09 the real repository passes its own gate right now', async () => {
  const result = await verifyEdgeProvenance();
  assert.equal(result.ok, true, `gate must pass on a clean tree: ${result.problems?.join(', ')}`);
  assert.ok(result.moduleCount >= 11);
  assert.match(result.bundleDigest, /^sha256:[a-f0-9]{64}$/);
});

test('PR-10 a stale manifest is refused even when the bundle matches it', async () => {
  // The gate regenerates from sources; a committed manifest that no longer describes them
  // is exactly the "reviewed contract" failure this exists to catch.
  const committed = JSON.parse(await readFile(new URL('../system.manifest.json', import.meta.url), 'utf8'));
  const regenerated = await buildManifest();
  assert.deepEqual(committed, regenerated, 'committed manifest must equal its sources');
});

test('PR-11 the subjects carry no secret value, only digests and names', async () => {
  const result = await verifyEdgeProvenance();
  assert.ok(!/sk-|ghp_|BEGIN [A-Z ]*PRIVATE KEY|AIza/.test(result.subjects));
  for (const line of result.subjects.trim().split('\n')) {
    assert.match(line.split('  ')[1], /^[A-Za-z0-9._-]+$/, 'subject names stay path-safe');
  }
});

// ---- workflow wiring: the gate cannot be skipped or fail open ---------------------------

test('PR-12 the deploy workflow verifies integrity BEFORE it uploads', async () => {
  const workflow = await readFile(new URL('../.github/workflows/cloudflare-deploy.yml', import.meta.url), 'utf8');
  const gateAt = workflow.indexOf('node scripts/verify-edge-provenance.mjs');
  const deployAt = workflow.indexOf('node scripts/deploy-cloudflare-edge.mjs');
  assert.ok(gateAt > 0, 'the integrity gate must be wired into the live deploy path');
  assert.ok(gateAt < deployAt, 'verification must run before the upload');
});

test('PR-13 the gate installs its dependencies, because it reads the Node tool registry', async () => {
  const workflow = await readFile(new URL('../.github/workflows/cloudflare-deploy.yml', import.meta.url), 'utf8');
  const installAt = workflow.indexOf('npm ci');
  const gateAt = workflow.indexOf('node scripts/verify-edge-provenance.mjs');
  assert.ok(installAt > 0 && installAt < gateAt, 'without npm ci the gate crashes with ERR_MODULE_NOT_FOUND');
});

test('PR-14 the gate cannot fail open and attestation is wired to the verified subjects', async () => {
  const workflow = await readFile(new URL('../.github/workflows/cloudflare-deploy.yml', import.meta.url), 'utf8');
  const gateBlock = workflow.slice(workflow.indexOf('Verify edge bundle integrity'), workflow.indexOf('Deploy Cloudflare Worker & bind'));
  assert.ok(!/continue-on-error:\s*true/.test(gateBlock), 'the integrity gate must never fail open');
  assert.ok(!/if:\s*always\(\)/.test(gateBlock));
  assert.match(workflow, /attest-build-provenance@[a-f0-9]{40}/);
  assert.ok(workflow.includes(`subject-checksums: ${SUBJECTS_FILE}`));
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /attestations: write/);
});

test('PR-15 attestation happens after upload, so it signs what actually shipped', async () => {
  const workflow = await readFile(new URL('../.github/workflows/cloudflare-deploy.yml', import.meta.url), 'utf8');
  const deployAt = workflow.indexOf('node scripts/deploy-cloudflare-edge.mjs');
  const attestAt = workflow.indexOf('attest-build-provenance@');
  assert.ok(attestAt > deployAt);
});
