#!/usr/bin/env node
// MAN-007 — grant `known_good` to a deployment slice, but only on proof.
//
// Runs AFTER scripts/verify-live.mjs in the deploy workflow. A successful upload is not
// health (DEC-073: production deployed fine while linking was unconfigured), so the slice
// ledger starts every row at acceptance=pending. Only a passing live acceptance report for
// the same commit may promote it, and that promoted row is what a rollback points at.
//
// Fails closed: a missing report, a non-pass verdict, or a commit mismatch promotes nothing.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { markSliceAccepted } from './deployment-slices.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Pure decision, so the rule is testable without a network or a database. */
export function decidePromotion({ report, expectedCommit, manifestDigest }) {
  if (!report || typeof report !== 'object') return { promote: false, reason: 'report_missing' };
  if (report.verdict !== 'pass') return { promote: false, reason: 'acceptance_not_passed' };
  // The commit the LIVE service reported, not the commit we hoped to deploy. verify-live
  // records it in the `version` check after comparing /version against --expect-commit.
  const versionCheck = Array.isArray(report.checks) ? report.checks.find((check) => check.id === 'version') : null;
  if (versionCheck && versionCheck.status !== 'pass') return { promote: false, reason: 'version_check_not_passed' };
  const observed = String(versionCheck?.detail?.commit ?? '').trim();
  if (!observed) return { promote: false, reason: 'report_commit_missing' };
  if (expectedCommit && observed.toLowerCase() !== String(expectedCommit).toLowerCase()) return { promote: false, reason: 'commit_mismatch' };
  if (!manifestDigest) return { promote: false, reason: 'manifest_digest_missing' };
  return { promote: true, commit: observed, manifestDigest };
}

export async function main({ argv = process.argv.slice(2), env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const arg = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : null;
  };
  const reportPath = arg('report') || '.validation-artifacts/edge-live-acceptance.json';
  const expectedCommit = arg('expect-commit') || env.GITHUB_SHA || null;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  // The deploy step already resolved the database id and wrote it next to the report, so the
  // operator never has to add a GitHub variable for it.
  const sliceContext = await readFile(path.resolve(root, '.validation-artifacts/deployment-slice.json'), 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => null);
  const databaseId = arg('database-id') || sliceContext?.databaseId || env.CELIA_D1_DATABASE_ID || null;

  const report = await readFile(path.resolve(root, reportPath), 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => null);
  const manifestText = await readFile(path.join(root, 'system.manifest.json'), 'utf8').catch(() => '');
  const { createHash } = await import('node:crypto');
  const manifestDigest = sliceContext?.manifestDigest
    || (manifestText ? `sha256:${createHash('sha256').update(manifestText).digest('hex')}` : null);

  const decision = decidePromotion({ report, expectedCommit, manifestDigest });
  if (!decision.promote) {
    log(`::notice title=Deployment Slice::not promoted (${decision.reason})`);
    return { promoted: false, reason: decision.reason };
  }
  if (!accountId || !apiToken || !databaseId) {
    log('::warning title=Deployment Slice::proof accepted but Cloudflare/D1 settings absent; slice stays pending');
    return { promoted: false, reason: 'cloudflare_settings_missing' };
  }

  const execD1 = async (sql, params = []) => {
    const response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`,
      { method: 'POST', headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ sql, params }) }
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.success === false) throw new Error('slice_promote_rejected');
    const first = Array.isArray(payload?.result) ? payload.result[0] : null;
    return { rows: Array.isArray(first?.results) ? first.results : [] };
  };

  await markSliceAccepted(execD1, {
    commit: decision.commit,
    manifestDigest: decision.manifestDigest,
    acceptedAt: new Date().toISOString(),
    acceptancePassed: true
  });
  log(`::notice title=Deployment Slice::known_good granted to ${decision.commit.slice(0, 7)} after passing live acceptance`);
  return { promoted: true, commit: decision.commit };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main().catch((error) => {
    // Promotion is bookkeeping; it must never turn a proven-good deploy red.
    console.log(`::warning title=Deployment Slice::promotion failed (${String(error?.message || 'unknown').slice(0, 80)})`);
  });
}
