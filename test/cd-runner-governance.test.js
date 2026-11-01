/**
 * CD-001 / DEC-108 — Deterministic CD gating, immutable release protection, and runner pinning.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const workflowDir = path.join(root, '.github', 'workflows');
const workflows = readdirSync(workflowDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .sort()
  .map((name) => ({ name, text: readFileSync(path.join(workflowDir, name), 'utf8') }));

const ALLOWED_RUNNERS = new Set(['ubuntu-24.04', 'ubuntu-26.04', 'ubuntu-slim']);

test('CDR-01: no workflow uses floating ubuntu-latest; every job pins an explicit runner and Docker-service jobs avoid single-CPU ubuntu-slim', () => {
  assert.ok(workflows.length >= 11, 'all repository workflows are scanned');
  for (const { name, text } of workflows) {
    assert.ok(!/runs-on:\s*ubuntu-latest\b/.test(text), `${name}: floating ubuntu-latest is forbidden`);
    const matches = [...text.matchAll(/^\s*runs-on:\s*(\S+)\s*$/gm)];
    assert.ok(matches.length >= 1, `${name}: declares at least one runs-on label`);
    for (const [, label] of matches) {
      assert.ok(ALLOWED_RUNNERS.has(label), `${name}: runner "${label}" must be in ${[...ALLOWED_RUNNERS].join(', ')}`);
    }
    const jobsIdx = text.search(/^jobs:\s*$/m);
    assert.ok(jobsIdx >= 0, `${name}: declares jobs:`);
    const jobBlocks = text.slice(jobsIdx).split(/\n(?=  [a-zA-Z0-9_-]+:\s*(?:\n|$))/).slice(1);
    assert.ok(jobBlocks.length >= 1, `${name}: has at least one job block`);
    for (const block of jobBlocks) {
      const jobName = block.match(/^\s*([a-zA-Z0-9_-]+):/)?.[1] || '<job>';
      if (/^\s{4}services:\s*$/m.test(block) || /docker build|docker\/setup-buildx-action/.test(block)) {
        assert.ok(!/runs-on:\s*ubuntu-slim\b/.test(block), `${name} (${jobName}): Docker jobs must run on a full VM, not ubuntu-slim`);
      }
    }
  }
});

test('CDR-02: celia-mcp.yml exercises both Ubuntu 26.04 (migration canary) and Ubuntu-Slim (lightweight governance smoke)', () => {
  const quality = read('.github/workflows/celia-mcp.yml');
  assert.match(quality, /^\s*ubuntu26-canary:\s*\n[\s\S]*?runs-on:\s*ubuntu-26\.04\b/m);
  assert.match(quality, /^\s*slim-runner-probe:\s*\n[\s\S]*?runs-on:\s*ubuntu-slim\b/m);
  for (const slimFile of ['quality-failure-notify.yml', 'issue-triage.yml', 'issue-triage-selftest.yml']) {
    assert.match(read(`.github/workflows/${slimFile}`), /runs-on:\s*ubuntu-slim\b/, `${slimFile} uses ubuntu-slim`);
  }
});

test('CDR-03: cloudflare-deploy.yml waits for Celia quality & resilience on main, binds production-edge, guards superseded commits, and threads CELIA_EXPECT_COMMIT', () => {
  const edge = read('.github/workflows/cloudflare-deploy.yml');
  assert.ok(!/^\s*push:\s*\n\s*branches:\s*\[main\]/m.test(edge), 'cloudflare-deploy.yml must not race quality checks on raw push');
  assert.match(edge, /workflow_run:\s*\n\s*workflows:\s*\['Celia quality & resilience'\]\s*\n\s*types:\s*\[completed\]\s*\n\s*branches:\s*\[main\]/);
  assert.match(edge, /github\.event\.workflow_run\.event\s*==\s*'push'/);
  assert.match(edge, /github\.event\.workflow_run\.conclusion\s*==\s*'success'/);
  assert.match(edge, /environment:\s*\n\s*name:\s*production-edge/);
  assert.match(edge, /CELIA_EXPECT_COMMIT:\s*\$\{\{\s*github\.event\.workflow_run\.head_sha\s*\|\|\s*github\.sha\s*\}\}/);
  assert.match(edge, /git merge-base --is-ancestor "\$CELIA_EXPECT_COMMIT" "\$MAIN_HEAD"/);
  assert.match(edge, /verify-live\.mjs[\s\S]{0,200}--expect-commit "\$CELIA_EXPECT_COMMIT"/);
  assert.match(edge, /promote-deployment-slice\.mjs[\s\S]{0,200}--expect-commit "\$CELIA_EXPECT_COMMIT"/);
});

test('CDR-04: verify-edge-provenance and deploy-cloudflare-edge honour CELIA_EXPECT_COMMIT ahead of GITHUB_SHA', async () => {
  const { verifyEdgeProvenance } = await import('../scripts/verify-edge-provenance.mjs');
  const prevExpect = process.env.CELIA_EXPECT_COMMIT;
  const prevSha = process.env.GITHUB_SHA;
  try {
    process.env.CELIA_EXPECT_COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    process.env.GITHUB_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const res = await verifyEdgeProvenance();
    assert.equal(res.commit, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.match(res.subjects, /celia-edge-bundle-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
  } finally {
    if (prevExpect === undefined) delete process.env.CELIA_EXPECT_COMMIT;
    else process.env.CELIA_EXPECT_COMMIT = prevExpect;
    if (prevSha === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = prevSha;
  }
  const deploySource = read('scripts/deploy-cloudflare-edge.mjs');
  assert.match(deploySource, /env\.CELIA_EXPECT_COMMIT\s*\|\|\s*env\.GITHUB_SHA/);
});

test('CDR-05: release.yml checks GitHub Release immutability inside identity resolution BEFORE building or pushing the container tag', () => {
  const release = read('.github/workflows/release.yml');
  const identityAt = release.indexOf('id: identity');
  const immutableAt = release.indexOf(".immutable");
  const dockerPushAt = release.indexOf('docker/build-push-action@');
  assert.ok(identityAt > 0 && immutableAt > identityAt, 'immutability is checked in the identity step');
  assert.ok(immutableAt < dockerPushAt, 'immutable check runs before docker/build-push-action can overwrite GHCR :vX.Y.Z');
});

test('CDR-06: the 0.3.0 release decision proposal is prepared while package.json stays at 0.2.1 pending owner decision (REL-003)', () => {
  assert.ok(existsSync(path.join(root, 'docs', 'release-0.3.0-proposal.md')));
  const pkg = JSON.parse(read('package.json'));
  const current = JSON.parse(read('releases/current.json'));
  assert.equal(pkg.version, '0.2.1', 'no automatic version bump without explicit owner approval');
  assert.equal(current.version, '0.2.1');
});
