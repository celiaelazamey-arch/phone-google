/**
 * SEC-006 — security posture pinned as breakable constraints (SP-01..SP-12).
 *
 * Every property below was verified by hand on 2026-10-29 (docs/security-posture.md records the evidence).
 * The tests turn that snapshot into a regression gate: if a future change weakens one layer, the change
 * has to say so here, in the open, instead of drifting silently. Deterministic and offline: no network,
 * no model, no secrets — only files in the repository and one pure function.
 *
 * Tracks (mirroring docs/security-posture.md):
 *   A. CI & supply chain  (SP-01..SP-06)   — workflows, permissions, pinned actions, npm audit, Dependabot
 *   B. Secrets            (SP-07..SP-08)   — .env never tracked, check:secrets wired into the quality gate
 *   C. Runtime hardening  (SP-09..SP-11)   — no dynamic code execution, SSRF guard, append-only audit chain
 *   D. Governance         (SP-12)          — the owner-only controls are documented, not simulated
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDisallowedTargetHost } from '../workers/celia-edge/cron.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const workflowDir = path.join(root, '.github', 'workflows');
const workflows = readdirSync(workflowDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .sort()
  .map((name) => ({ name, text: readFileSync(path.join(workflowDir, name), 'utf8') }));

/** Walks a directory and returns every .js/.mjs/.cjs file under it (skipping node_modules and build output). */
function sourceFiles(directory, bucket = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'coverage'].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(full, bucket);
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) bucket.push(full);
  }
  return bucket;
}

// ---------------------------------------------------------------------------------------------------------
// A. CI & supply chain
// ---------------------------------------------------------------------------------------------------------

test('SP-01 every workflow declares a top-level permissions block and none asks for write-all', () => {
  assert.ok(workflows.length >= 1, 'workflows exist');
  for (const { name, text } of workflows) {
    assert.match(text, /^permissions:\s*$/m, `${name}: top-level permissions block is declared`);
    assert.ok(!/permissions:\s*write-all/.test(text), `${name}: never permissions: write-all`);
    assert.ok(!/^\s*[a-z-]+:\s*write-all\s*$/m.test(text), `${name}: no scope is granted write-all`);
  }
});

test('SP-02 the default token is read-only everywhere; only the release job may write repository contents', () => {
  for (const { name, text } of workflows) {
    const topLevel = text.match(/^permissions:\s*\n((?:  [a-z-]+: [a-z-]+\s*\n)+)/m);
    assert.ok(topLevel, `${name}: top-level permissions block is a map of scopes`);
    assert.match(topLevel[1], /^  contents: read$/m, `${name}: top-level contents permission is read`);
    const contentWrites = (text.match(/^\s*contents:\s*write\s*$/gm) || []).length;
    if (name === 'release.yml') {
      assert.equal(contentWrites, 1, 'release.yml escalates contents: write once, at job level, to publish the release');
    } else {
      assert.equal(contentWrites, 0, `${name}: must not write repository contents`);
    }
  }
});

test('SP-03 no workflow uses pull_request_target (fork code never runs with repository secrets)', () => {
  for (const { name, text } of workflows) {
    assert.ok(!/pull_request_target/.test(text), `${name}: pull_request_target is forbidden`);
  }
});

test('SP-04 every third-party action is pinned to a full commit SHA with a version comment', () => {
  const uses = [];
  for (const { name, text } of workflows) {
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*-?\s*uses:\s*(\S+)(.*)$/);
      if (!match) continue;
      const [, ref, rest] = match;
      if (ref.startsWith('./')) continue; // local composite actions carry no external supply chain
      uses.push(`${name}: ${ref}`);
      assert.match(ref, /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[a-f0-9]{40}$/, `${name}: "${ref}" must be pinned to a 40-hex commit SHA`);
      assert.match(rest, /#\s*v\d+/, `${name}: "${ref}" carries a human-readable version comment`);
    }
  }
  assert.ok(uses.length >= 10, `pinned actions found (${uses.length})`);
});

test('SP-05 npm audit (production dependencies, moderate+) gates both the quality workflow and the release', () => {
  const audit = /npm audit --omit=dev --audit-level=moderate/;
  assert.match(read('.github/workflows/celia-mcp.yml'), audit, 'quality workflow runs npm audit');
  assert.match(read('.github/workflows/release.yml'), audit, 'release workflow runs npm audit before publishing');
});

test('SP-06 Dependabot watches npm, GitHub Actions and Docker', () => {
  const config = read('.github/dependabot.yml');
  for (const ecosystem of ['npm', 'github-actions', 'docker']) {
    assert.match(config, new RegExp(`package-ecosystem:\\s*["']?${ecosystem}["']?`), `dependabot covers ${ecosystem}`);
  }
  assert.match(config, /interval:\s*["']?(?:daily|weekly)["']?/, 'at least one ecosystem is checked weekly or faster');
});

// ---------------------------------------------------------------------------------------------------------
// B. Secrets
// ---------------------------------------------------------------------------------------------------------

test('SP-07 .env files are ignored and only .env.example is ever tracked', () => {
  const ignore = read('.gitignore').split('\n').map((line) => line.trim());
  assert.ok(ignore.includes('.env'), '.gitignore lists .env');
  assert.ok(ignore.includes('.env.*'), '.gitignore lists .env.*');
  assert.ok(ignore.includes('!.env.example'), '.env.example stays visible as the documented template');
  let tracked = null;
  try {
    tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  } catch {
    tracked = null; // git unavailable: the .gitignore assertions above still hold
  }
  if (tracked !== null) {
    const envFiles = tracked.split('\n').filter((file) => /(^|\/)\.env(\.|$)/.test(file));
    assert.deepEqual(envFiles, ['.env.example'], 'no real .env file is committed');
  }
  const example = read('.env.example');
  assert.ok(!/(?:sk|ghp|github_pat|AIza)[A-Za-z0-9_-]{20,}/.test(example), '.env.example holds placeholders, not live keys');
});

test('SP-08 the secrets-wiring check exists and runs inside the quality workflow on every push', () => {
  assert.ok(existsSync(path.join(root, 'scripts', 'check-secrets-wiring.mjs')));
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['check:secrets'], 'node scripts/check-secrets-wiring.mjs');
  const quality = read('.github/workflows/celia-mcp.yml');
  assert.match(quality, /npm run check:secrets/, 'quality workflow runs check:secrets');
  assert.match(quality, /npm run check:continuity/, 'quality workflow runs check:continuity');
  assert.match(quality, /npm run test:coverage:ci/, 'quality workflow runs the coverage-gated test suite');
  assert.match(quality, /^\s*branches:\s*\['\*\*'\]\s*$/m, 'the quality gate runs on pushes to every branch');
});

// ---------------------------------------------------------------------------------------------------------
// C. Runtime hardening
// ---------------------------------------------------------------------------------------------------------

test('SP-09 runtime code never evaluates strings or spawns processes (src/ and workers/)', () => {
  const forbidden = [
    ['eval(', /\beval\s*\(/],
    ['new Function(', /\bnew\s+Function\s*\(/],
    ['child_process', /child_process/],
    ['node:vm', /\bnode:vm\b|\bfrom\s+['"]vm['"]|require\(\s*['"]vm['"]\s*\)/],
    ['execSync/spawn', /\b(?:execSync|execFileSync|spawnSync|spawn|execFile)\s*\(/]
  ];
  const files = [...sourceFiles(path.join(root, 'src')), ...sourceFiles(path.join(root, 'workers'))];
  assert.ok(files.length >= 50, `runtime files scanned (${files.length})`);
  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const [label, pattern] of forbidden) {
      if (pattern.test(text)) hits.push(`${path.relative(root, file)}: ${label}`);
    }
  }
  assert.deepEqual(hits, [], 'dynamic code execution or process spawning found in runtime code');
});

test('SP-10 the outbound-target guard blocks loopback, private, link-local and metadata hosts', () => {
  const blocked = [
    'localhost',
    'api.localhost',
    '127.0.0.1',
    '10.0.0.8',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    'metadata.google.internal',
    'metadata',
    'service.internal',
    'printer.local',
    '2130706433',
    '0x7f000001',
    '[::1]',
    '::1',
    '::ffff:127.0.0.1',
    'fd12:3456::1',
    'fe80::1',
    ''
  ];
  for (const host of blocked) assert.equal(isDisallowedTargetHost(host), true, `${JSON.stringify(host)} must be refused`);
  for (const host of ['api.cron-job.org', 'example.com', 'celia-edge.example.workers.dev', '93.184.216.34']) {
    assert.equal(isDisallowedTargetHost(host), false, `${host} is a legitimate public target`);
  }
});

test('SP-11 the edge audit log is a hash chain and append-only (no UPDATE/DELETE anywhere in workers/)', () => {
  const state = read('workers/celia-edge/state.js');
  assert.match(state, /INSERT INTO edge_audit \(at, key, action, value_hash, prev_hash, hash\)/, 'every row links to the previous hash');
  const files = sourceFiles(path.join(root, 'workers'));
  const migrations = readdirSync(path.join(root, 'workers', 'celia-edge', 'migrations')).map((name) =>
    path.join(root, 'workers', 'celia-edge', 'migrations', name)
  );
  for (const file of [...files, ...migrations]) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!/\b(?:UPDATE|DELETE\s+FROM|DROP\s+TABLE|TRUNCATE)\s+(?:IF\s+EXISTS\s+)?edge_audit\b/i.test(text), `${path.relative(root, file)}: edge_audit is append-only`);
  }
  const schema = read('workers/celia-edge/migrations/0001_state.sql');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS edge_audit/);
  assert.match(schema, /prev_hash/);
});

// ---------------------------------------------------------------------------------------------------------
// D. Governance
// ---------------------------------------------------------------------------------------------------------

test('SP-12 the owner-only controls are documented with their verified status, never claimed as done', () => {
  const doc = read('docs/security-posture.md');
  for (const control of ['Branch protection', 'Dependabot alerts', 'Secret scanning']) {
    assert.match(doc, new RegExp(control, 'i'), `${control} is documented`);
  }
  assert.match(doc, /SP-01/);
  assert.match(doc, /SP-12/);
  assert.match(doc, /403/, 'the doc records that the agent cannot read branch protection (API 403), so it is marked owner-only');
  // Owner-only rows: "| **<control>** | <status> | ..." — the status is UNKNOWN until the owner confirms, then VERIFIED (date).
  const rows = doc.split('\n').filter((line) => /^\| \*\*/.test(line));
  for (const control of ['Branch protection', 'Dependabot alerts', 'Secret scanning']) {
    const row = rows.find((line) => line.toLowerCase().includes(control.toLowerCase()));
    assert.ok(row, `${control} has a status row in the owner-only table`);
    const status = row.split('|')[2].trim();
    assert.match(status, /^(?:UNKNOWN\b|VERIFIED \(\d{4}-\d{2}-\d{2}\))/, `${control}: status is UNKNOWN or VERIFIED with a confirmation date, got "${status}"`);
  }
  assert.ok(statSync(path.join(root, 'docs', 'security-posture.md')).size > 2000, 'the posture doc is substantive');
});
