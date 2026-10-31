#!/usr/bin/env node
// MAN-002 / DEC-077 — refuse to upload a Worker bundle that is not the reviewed contract.
//
// The gap this closes: release.yml produces OIDC provenance + SBOM, and pages.yml *verifies*
// it before publishing. cloudflare-deploy.yml — the path that actually serves users — did
// neither. It checked out source and uploaded whatever was on disk.
//
// Why this is not `gh attestation verify` on release files: the edge does not deploy a release
// artifact. It bundles `workers/celia-edge/**` straight from the commit. So the honest,
// buildable properties are two, and they should not be confused:
//
//   1. INTEGRITY (verified here, BEFORE upload, fail-closed): the bytes about to be uploaded
//      hash to exactly what the committed `system.manifest.json` declares — modules, bundle
//      digest and every migration. Uncommitted drift cannot reach production.
//   2. PROVENANCE (emitted here, attested by the workflow): a checksums file naming the bundle
//      digest, so `actions/attest-build-provenance` can bind those exact bytes to this commit
//      and workflow run. Afterwards anyone can verify where a deployed bundle came from.
//
// This does NOT verify a third-party signature on untrusted code, and it does not make the
// bundle trusted because a manifest says so. It makes silent drift impossible and leaves a
// verifiable record. Those are the claims; nothing stronger.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectWorkerModules, loadMigrationFiles } from './deploy-cloudflare-edge.mjs';
import { buildManifest, MANIFEST_FILE } from './build-manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SUBJECTS_FILE = '.validation-artifacts/edge-subjects.txt';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Same concatenation rule the manifest generator and the deploy slice use. */
export function bundleDigestOf(modules) {
  return `sha256:${sha256(modules.map((module) => `${module.name}\n${module.source}`).join('\n'))}`;
}

/**
 * Pure comparison so the rule is testable without a filesystem or a network.
 * Every failure names what diverged; nothing is silently tolerated.
 */
export function compareBundleToManifest({ manifest, modules, migrations }) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, problems: ['manifest_missing'], bundleDigest: null };
  }
  const edge = manifest.targets?.edge;
  if (!edge) return { ok: false, problems: ['manifest_edge_target_missing'], bundleDigest: null };

  const digest = bundleDigestOf(modules);
  if (edge.bundleDigest !== digest) problems.push('bundle_digest_mismatch');

  const declaredModules = Array.isArray(edge.modules) ? edge.modules : [];
  const actualModules = modules.map((module) => module.name);
  if (JSON.stringify(declaredModules) !== JSON.stringify(actualModules)) problems.push('module_graph_mismatch');

  const declaredMigrations = new Map((manifest.schema?.migrations || []).map((entry) => [entry.version, entry.digest]));
  for (const migration of migrations) {
    const expected = declaredMigrations.get(migration.version);
    if (!expected) problems.push(`migration_undeclared:${migration.version}`);
    else if (expected !== `sha256:${sha256(migration.sql)}`) problems.push(`migration_digest_mismatch:${migration.version}`);
    declaredMigrations.delete(migration.version);
  }
  for (const version of declaredMigrations.keys()) problems.push(`migration_missing:${version}`);

  return { ok: problems.length === 0, problems, bundleDigest: digest };
}

/**
 * Checksums file consumed by actions/attest-build-provenance via `subject-checksums`.
 * Format is the sha256sum convention: "<hex>  <name>".
 */
export function renderSubjects({ bundleDigest, manifestText, commit }) {
  const bundleHex = String(bundleDigest).replace(/^sha256:/, '');
  const manifestHex = sha256(manifestText);
  const name = `celia-edge-bundle-${String(commit || 'local').slice(0, 40)}`;
  return `${bundleHex}  ${name}\n${manifestHex}  ${MANIFEST_FILE}\n`;
}

export async function verifyEdgeProvenance({ log = () => {} } = {}) {
  const manifestText = await readFile(path.join(root, MANIFEST_FILE), 'utf8').catch(() => null);
  if (manifestText === null) return { ok: false, problems: ['manifest_file_missing'], bundleDigest: null };

  const manifest = JSON.parse(manifestText);
  const [modules, migrations] = await Promise.all([collectWorkerModules(), loadMigrationFiles()]);
  const integrity = compareBundleToManifest({ manifest, modules, migrations });

  // Drift of the manifest itself against its sources: a bundle can match a stale manifest.
  const regenerated = await buildManifest();
  if (JSON.stringify(regenerated) !== JSON.stringify(manifest)) {
    integrity.ok = false;
    integrity.problems.push('manifest_stale');
  }

  const commit = String(process.env.GITHUB_SHA || '').trim() || 'local';
  const subjects = renderSubjects({ bundleDigest: integrity.bundleDigest, manifestText, commit });
  return { ...integrity, subjects, commit, moduleCount: modules.length };
}

export async function main({ argv = process.argv.slice(2), log = console.log } = {}) {
  const result = await verifyEdgeProvenance({ log });
  if (!result.ok) {
    // Fail closed: the deploy step must never run after this returns non-zero.
    log(`::error title=Edge Provenance::refusing to deploy — ${result.problems.join(', ')}`);
    log('Run `npm run build:manifest` and commit the result, or revert the unreviewed change.');
    process.exitCode = 1;
    return result;
  }
  if (!argv.includes('--no-write')) {
    const target = path.join(root, SUBJECTS_FILE);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, result.subjects, 'utf8');
  }
  log(`::notice title=Edge Provenance::integrity verified — ${result.moduleCount} modules, bundle ${result.bundleDigest.slice(0, 19)}…`);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
