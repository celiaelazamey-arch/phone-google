// MAN-007 / DEC-075 — the slice ledger must be trustworthy: append-only, and known_good is
// earned by a passing live acceptance for the same commit, never by a green upload.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildSliceRecord,
  recordSlice,
  markSliceAccepted,
  findRollbackTarget,
  schemaVersionFrom,
  insertSliceParams,
  INSERT_SLICE_SQL,
  MARK_ACCEPTED_SQL,
  SELECT_SLICE_SQL,
  SELECT_ROLLBACK_TARGET_SQL
} from '../scripts/deployment-slices.mjs';
import { decidePromotion, main as promoteMain } from '../scripts/promote-deployment-slice.mjs';
import { loadMigrationFiles, splitSqlStatements } from '../scripts/deploy-cloudflare-edge.mjs';

const base = {
  commit: 'a'.repeat(40),
  version: '0.2.1',
  manifestDigest: 'sha256:manifest',
  bundleDigest: 'sha256:bundle',
  schemaVersion: '0008_deployment_slices.sql',
  deployedAt: '2026-10-31T00:00:00.000Z'
};

/** Real SQLite standing in for D1, so the SQL itself is exercised, not a mock of it. */
async function memoryD1() {
  const sqlite = new DatabaseSync(':memory:');
  const files = await loadMigrationFiles();
  const slice = files.find((file) => file.version.startsWith('0008'));
  for (const statement of splitSqlStatements(slice.sql)) sqlite.exec(statement);
  const exec = async (sql, params = []) => {
    const statement = sqlite.prepare(sql);
    if (/^\s*SELECT\b/i.test(sql)) return { rows: statement.all(...params) };
    statement.run(...params);
    return { rows: [] };
  };
  return { exec, sqlite };
}

test('SL-01 a new slice is pending and never optimistic about its own health', () => {
  const record = buildSliceRecord(base);
  assert.equal(record.acceptance, 'pending');
  assert.equal(record.known_good, 0);
  assert.equal(record.accepted_at, null);
});

test('SL-02 a slice refuses to exist without a commit, digests and a timestamp', () => {
  assert.throws(() => buildSliceRecord({ ...base, commit: 'main' }), /slice_commit_invalid/);
  assert.throws(() => buildSliceRecord({ ...base, manifestDigest: '' }), /slice_digest_required/);
  assert.throws(() => buildSliceRecord({ ...base, deployedAt: '' }), /slice_timestamp_required/);
});

test('SL-03 the schema version is the newest migration, because D1 cannot roll back', () => {
  assert.equal(schemaVersionFrom([{ version: '0001_a.sql' }, { version: '0008_b.sql' }]), '0008_b.sql');
  assert.equal(schemaVersionFrom([]), 'none');
});

test('SL-04 re-deploying the same commit and manifest is a replay, not a second slice', async () => {
  const { exec, sqlite } = await memoryD1();
  await recordSlice(exec, buildSliceRecord(base));
  await recordSlice(exec, buildSliceRecord(base));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM edge_deployment_slices').get().n, 1);
});

test('SL-04a an insert without an exact D1 read-back is not reported as recorded', async () => {
  const record = buildSliceRecord(base);
  await assert.rejects(
    () => recordSlice(async () => ({ rows: [] }), record),
    /slice_record_readback_missing/
  );

  const { exec } = await memoryD1();
  await assert.rejects(
    () => recordSlice(async (sql, params) => {
      const result = await exec(sql, params);
      if (sql === SELECT_SLICE_SQL) result.rows[0].bundle_digest = 'sha256:unexpected';
      return result;
    }, record),
    /slice_record_readback_mismatch/
  );
});

test('SL-05 a different manifest for the same commit is a distinct slice', async () => {
  const { exec, sqlite } = await memoryD1();
  await recordSlice(exec, buildSliceRecord(base));
  await recordSlice(exec, buildSliceRecord({ ...base, manifestDigest: 'sha256:changed' }));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM edge_deployment_slices').get().n, 2);
});

test('SL-06 an unproven slice is never a rollback target', async () => {
  const { exec } = await memoryD1();
  await recordSlice(exec, buildSliceRecord(base));
  assert.equal(await findRollbackTarget(exec, { currentCommit: 'b'.repeat(40) }), null);
});

test('SL-07 acceptance promotes exactly the matching slice and nothing else', async () => {
  const { exec, sqlite } = await memoryD1();
  await recordSlice(exec, buildSliceRecord(base));
  await recordSlice(exec, buildSliceRecord({ ...base, commit: 'c'.repeat(40) }));
  await markSliceAccepted(exec, { commit: base.commit, manifestDigest: base.manifestDigest, acceptedAt: '2026-10-31T01:00:00Z', acceptancePassed: true });
  const promoted = sqlite.prepare('SELECT commit_sha, known_good, acceptance FROM edge_deployment_slices WHERE known_good = 1').all();
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].commit_sha, base.commit);
  assert.equal(promoted[0].acceptance, 'passed');
});

test('SL-08 a failed or missing acceptance can never grant known_good', async () => {
  const { exec } = await memoryD1();
  for (const value of [false, undefined, 'pass', null, 1]) {
    await assert.rejects(
      () => markSliceAccepted(exec, { commit: base.commit, manifestDigest: base.manifestDigest, acceptedAt: 'now', acceptancePassed: value }),
      /slice_acceptance_not_passed/
    );
  }
});

test('SL-08a promotion is not confirmed unless the accepted row reads back from D1', async () => {
  const { exec } = await memoryD1();
  await assert.rejects(
    () => markSliceAccepted(exec, { commit: base.commit, manifestDigest: base.manifestDigest, acceptedAt: 'now', acceptancePassed: true }),
    /slice_acceptance_readback_missing/
  );

  const seeded = await memoryD1();
  await recordSlice(seeded.exec, buildSliceRecord(base));
  await assert.rejects(
    () => markSliceAccepted(async (sql, params) => {
      const result = await seeded.exec(sql, params);
      if (sql === SELECT_SLICE_SQL) result.rows[0].known_good = 0;
      return result;
    }, { commit: base.commit, manifestDigest: base.manifestDigest, acceptedAt: 'now', acceptancePassed: true }),
    /slice_acceptance_readback_mismatch/
  );
});

test('SL-09 rollback picks the newest proven slice that isn\'t the current commit', async () => {
  const { exec } = await memoryD1();
  const older = { ...base, commit: '1'.repeat(40) };
  const newer = { ...base, commit: '2'.repeat(40) };
  for (const record of [older, newer]) {
    await recordSlice(exec, buildSliceRecord(record));
    await markSliceAccepted(exec, { commit: record.commit, manifestDigest: record.manifestDigest, acceptedAt: 'now', acceptancePassed: true });
  }
  const target = await findRollbackTarget(exec, { currentCommit: newer.commit });
  assert.equal(target.commit_sha, older.commit);
  // Nothing proven for a fresh database: fail closed rather than guess.
  const empty = await memoryD1();
  assert.equal(await findRollbackTarget(empty.exec, { currentCommit: 'x' }), null);
});

test('SL-10 the ledger SQL is append-only: no DELETE and no identity UPDATE', async () => {
  const source = await readFile(new URL('../scripts/deployment-slices.mjs', import.meta.url), 'utf8');
  assert.ok(!/DELETE\s+FROM/i.test(source), 'slices are never deleted');
  // The only UPDATE is the earned promotion, and it touches status columns only.
  assert.match(MARK_ACCEPTED_SQL, /SET acceptance = 'passed', known_good = 1, accepted_at = \?/);
  assert.ok(!/SET\s+commit_sha|SET\s+manifest_digest|SET\s+bundle_digest/i.test(source), 'a slice identity is immutable');
  assert.match(INSERT_SLICE_SQL, /ON CONFLICT\(commit_sha, manifest_digest\) DO NOTHING/);
  assert.match(SELECT_SLICE_SQL, /WHERE commit_sha = \? AND manifest_digest = \?/);
  assert.match(SELECT_ROLLBACK_TARGET_SQL, /known_good = 1/);
  assert.equal(insertSliceParams(buildSliceRecord(base)).length, 11);
});

// ---- promotion decision: the proof gate -------------------------------------------------

const passingReport = (commit = base.commit) => ({
  verdict: 'pass',
  checks: [{ id: 'version', status: 'pass', detail: { commit } }]
});

test('SL-11 promotion requires a passing verdict from the live run', () => {
  assert.equal(decidePromotion({ report: null, expectedCommit: base.commit, manifestDigest: 'd' }).reason, 'report_missing');
  assert.equal(decidePromotion({ report: { verdict: 'fail' }, expectedCommit: base.commit, manifestDigest: 'd' }).reason, 'acceptance_not_passed');
});

test('SL-12 promotion uses the commit the live service reported, and rejects a mismatch', () => {
  const other = 'f'.repeat(40);
  assert.equal(decidePromotion({ report: passingReport(other), expectedCommit: base.commit, manifestDigest: 'd' }).reason, 'commit_mismatch');
  const ok = decidePromotion({ report: passingReport(), expectedCommit: base.commit, manifestDigest: 'd' });
  assert.equal(ok.promote, true);
  assert.equal(ok.commit, base.commit);
});

test('SL-13 a passing overall verdict cannot hide a failed version check', () => {
  const report = { verdict: 'pass', checks: [{ id: 'version', status: 'fail', detail: { commit: base.commit } }] };
  assert.equal(decidePromotion({ report, expectedCommit: base.commit, manifestDigest: 'd' }).reason, 'version_check_not_passed');
});

test('SL-14 a report with no measured commit promotes nothing', () => {
  const report = { verdict: 'pass', checks: [{ id: 'version', status: 'pass', detail: {} }] };
  assert.equal(decidePromotion({ report, expectedCommit: base.commit, manifestDigest: 'd' }).reason, 'report_commit_missing');
  assert.equal(decidePromotion({ report: passingReport(), expectedCommit: base.commit, manifestDigest: null }).reason, 'manifest_digest_missing');
});

test('SL-15 commit comparison is case-insensitive because GitHub and /version differ in case', () => {
  const report = passingReport(base.commit.toUpperCase());
  assert.equal(decidePromotion({ report, expectedCommit: base.commit, manifestDigest: 'd' }).promote, true);
});

test('SL-16 the deploy workflow promotes only after live acceptance, and needs no new operator variable', async () => {
  const workflow = await readFile(new URL('../.github/workflows/cloudflare-deploy.yml', import.meta.url), 'utf8');
  const verifyAt = workflow.indexOf('node scripts/verify-live.mjs');
  const promoteAt = workflow.indexOf('node scripts/promote-deployment-slice.mjs');
  assert.ok(verifyAt > 0 && promoteAt > verifyAt, 'promotion must run after acceptance');
  assert.match(workflow, /Promote deployment slice[\s\S]{0,200}if: success\(\)/);
  assert.match(workflow, /--out \.validation-artifacts\/deployment-slice-promotion\.json/);
  assert.match(workflow, /Upload token-free Edge deployment evidence/);
  assert.ok(!workflow.includes('vars.CELIA_D1_DATABASE_ID'), 'the database id comes from the deploy, not a new GitHub variable');
});

test('SL-16a successful promotion writes post-live evidence only after an exact D1 read-back', async () => {
  const { exec, sqlite } = await memoryD1();
  await recordSlice(exec, buildSliceRecord(base));
  const directory = await mkdtemp(path.join(tmpdir(), 'celia-promote-'));
  const reportPath = path.join(directory, 'acceptance.json');
  const contextPath = path.join(directory, 'slice-context.json');
  const outputPath = path.join(directory, 'promotion.json');
  const summaryPath = path.join(directory, 'summary.md');
  await writeFile(reportPath, JSON.stringify(passingReport()), 'utf8');
  await writeFile(contextPath, JSON.stringify({ manifestDigest: base.manifestDigest, databaseId: 'db-1' }), 'utf8');
  const logs = [];

  const result = await promoteMain({
    argv: ['--report', reportPath, '--expect-commit', base.commit, '--slice-context', contextPath, '--out', outputPath],
    env: { CLOUDFLARE_ACCOUNT_ID: 'account-1', CLOUDFLARE_API_TOKEN: 'token-test', GITHUB_STEP_SUMMARY: summaryPath },
    fetchImpl: async (url, init) => {
      assert.match(url, /\/d1\/database\/db-1\/query$/);
      const { sql, params } = JSON.parse(init.body);
      const { rows } = await exec(sql, params);
      return { ok: true, json: async () => ({ success: true, result: [{ results: rows }] }) };
    },
    log: (line) => logs.push(line)
  });

  assert.equal(result.promoted, true);
  assert.equal(result.knownGood, true);
  assert.equal(result.d1ReadBack, 'pass');
  assert.equal(result.readBack.acceptance, 'passed');
  assert.equal(result.readBack.knownGood, true);
  const stored = sqlite.prepare('SELECT acceptance, known_good, accepted_at FROM edge_deployment_slices WHERE commit_sha = ?').get(base.commit);
  assert.equal(stored.acceptance, 'passed');
  assert.equal(stored.known_good, 1);
  const artifact = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(artifact.stage, 'post-live-acceptance');
  assert.equal(artifact.status, 'known-good-verified');
  assert.equal(artifact.d1ReadBack, 'pass');
  const summary = await readFile(summaryPath, 'utf8');
  assert.match(summary, /D1 read-back: \*\*pass\*\*/);
  assert.match(summary, /known_good: \*\*true\*\*/);
  assert.doesNotMatch(`${JSON.stringify(artifact)}\n${summary}\n${logs.join('\n')}`, /token-test/);
});

test('SL-16b a missing ledger row leaves post-live evidence pending, never falsely known_good', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'celia-promote-missing-'));
  const reportPath = path.join(directory, 'acceptance.json');
  const contextPath = path.join(directory, 'slice-context.json');
  const outputPath = path.join(directory, 'promotion.json');
  await writeFile(reportPath, JSON.stringify(passingReport()), 'utf8');
  await writeFile(contextPath, JSON.stringify({ manifestDigest: base.manifestDigest, databaseId: 'db-1' }), 'utf8');
  const { exec } = await memoryD1();
  const result = await promoteMain({
    argv: ['--report', reportPath, '--expect-commit', base.commit, '--slice-context', contextPath, '--out', outputPath],
    env: { CLOUDFLARE_ACCOUNT_ID: 'account-1', CLOUDFLARE_API_TOKEN: 'token-test' },
    fetchImpl: async (_url, init) => {
      const { sql, params } = JSON.parse(init.body);
      const { rows } = await exec(sql, params);
      return { ok: true, json: async () => ({ success: true, result: [{ results: rows }] }) };
    },
    log: () => {}
  });
  assert.equal(result.promoted, false);
  assert.equal(result.knownGood, false);
  assert.equal(result.d1ReadBack, 'failed');
  assert.equal(result.reason, 'slice_acceptance_readback_missing');
  const artifact = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(artifact.knownGood, false);
  assert.equal(artifact.status, 'pending');
});

test('SL-16c post-live evidence records failed or mismatched acceptance without promoting', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'celia-promote-not-accepted-'));
  const contextPath = path.join(directory, 'slice-context.json');
  const failedReportPath = path.join(directory, 'failed-acceptance.json');
  const failedOutputPath = path.join(directory, 'failed-promotion.json');
  const mismatchReportPath = path.join(directory, 'mismatch-acceptance.json');
  const mismatchOutputPath = path.join(directory, 'mismatch-promotion.json');
  await writeFile(contextPath, JSON.stringify({ manifestDigest: base.manifestDigest, databaseId: 'db-1' }), 'utf8');
  await writeFile(failedReportPath, JSON.stringify({ verdict: 'fail', checks: [] }), 'utf8');
  await writeFile(mismatchReportPath, JSON.stringify(passingReport('f'.repeat(40))), 'utf8');
  const common = ['--expect-commit', base.commit, '--slice-context', contextPath];
  const failed = await promoteMain({
    argv: ['--report', failedReportPath, ...common, '--out', failedOutputPath],
    env: { CLOUDFLARE_ACCOUNT_ID: 'account-1', CLOUDFLARE_API_TOKEN: 'token-test' },
    fetchImpl: async () => { throw new Error('D1 must not be touched'); },
    log: () => {}
  });
  const mismatch = await promoteMain({
    argv: ['--report', mismatchReportPath, ...common, '--out', mismatchOutputPath],
    env: { CLOUDFLARE_ACCOUNT_ID: 'account-1', CLOUDFLARE_API_TOKEN: 'token-test' },
    fetchImpl: async () => { throw new Error('D1 must not be touched'); },
    log: () => {}
  });
  assert.equal(failed.promoted, false);
  assert.equal(failed.knownGood, false);
  assert.equal(failed.acceptance, 'failed');
  assert.equal(failed.reason, 'acceptance_not_passed');
  assert.equal(mismatch.promoted, false);
  assert.equal(mismatch.knownGood, false);
  assert.equal(mismatch.acceptance, 'passed');
  assert.equal(mismatch.reason, 'commit_mismatch');
  assert.equal(JSON.parse(await readFile(failedOutputPath, 'utf8')).acceptance, 'failed');
  assert.equal(JSON.parse(await readFile(mismatchOutputPath, 'utf8')).acceptance, 'passed');
});

test('SL-17 the migration is idempotent and re-applies cleanly', async () => {
  const files = await loadMigrationFiles();
  const slice = files.find((file) => file.version.startsWith('0008'));
  const sqlite = new DatabaseSync(':memory:');
  const statements = splitSqlStatements(slice.sql);
  for (const statement of statements) sqlite.exec(statement);
  for (const statement of statements) sqlite.exec(statement);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'edge_deployment_slices'").get().n, 1);
});
