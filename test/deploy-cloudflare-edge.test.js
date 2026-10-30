// The edge deployer is the component that actually puts the Worker live. Its branches are tested here with an
// injected fetch/environment so no network call and no credential ever leaves the process.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { collectWorkerModules, main, splitSqlStatements, WORKER_ENTRY_MODULE } from '../scripts/deploy-cloudflare-edge.mjs';

const workerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'workers', 'celia-edge');
const migrationsDir = path.join(workerDir, 'migrations');

function createRealD1QueryHandler(sqlite, queriedStatements = []) {
  return (_url, init = {}) => {
    const { sql, params = [] } = JSON.parse(init.body);
    queriedStatements.push(sql);
    try {
      const stmt = sqlite.prepare(sql);
      if (/^\s*(?:SELECT|PRAGMA)\b/i.test(sql)) {
        const results = stmt.all(...params);
        return jsonResponse(200, { success: true, result: [{ success: true, results }] });
      }
      const info = stmt.run(...params);
      return jsonResponse(200, { success: true, result: [{ success: true, meta: { changes: info.changes } }] });
    } catch (err) {
      return jsonResponse(400, { success: false, errors: [{ message: err.message }] });
    }
  };
}

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body)
});

test('edge deploy: without credentials it prepares the bindings and stops at dry-run', async () => {
  const lines = [];
  await main({ argv: [], env: {}, log: (line) => lines.push(line) });
  const report = JSON.parse(lines[0]);
  assert.equal(report.status, 'dry-run');
  assert.equal(report.reason, 'missing_cloudflare_credentials');
  assert.equal(report.scriptName, 'celia-phone-google');
  assert.ok(report.totalSecretsTracked >= 18);
  assert.equal(report.secretBindingsPrepared, 0);
});

test('edge deploy: an explicit --dry-run with credentials still publishes nothing', async () => {
  const lines = [];
  await main({
    argv: ['--dry-run'],
    env: { CLOUDFLARE_ACCOUNT_ID: 'acc-1', CLOUDFLARE_API_TOKEN: 'token-1', CELIA_VOICE_ID: 'voice-1' },
    fetchImpl: async () => {
      throw new Error('network must not be touched in dry-run');
    },
    log: (line) => lines.push(line)
  });
  const report = JSON.parse(lines[0]);
  assert.equal(report.status, 'dry-run');
  assert.equal(report.reason, 'explicit_dry_run');
  // CELIA_VOICE_ID plus the two Cloudflare keys are all secrets the Worker receives.
  assert.equal(report.secretBindingsPrepared, 3);
});

test('edge deploy: a rejected upload reports the provider code, never the token', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'celia-edge-'));
  const summaryPath = path.join(directory, 'summary.md');
  const lines = [];
  const calls = [];
  const sqlite = new DatabaseSync(':memory:');
  const d1Handler = createRealD1QueryHandler(sqlite);
  const returned = await main({
    argv: [],
    env: {
      CLOUDFLARE_ACCOUNT_ID: 'acc-1',
      CLOUDFLARE_API_TOKEN: 'super-secret-token',
      GITHUB_STEP_SUMMARY: summaryPath
    },
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET' });
      if (url.includes('/d1/database?')) {
        return jsonResponse(200, { success: true, result: [{ uuid: 'db-1', name: 'celia-edge-state' }] });
      }
      if (url.includes('/d1/database/db-1/query')) return d1Handler(url, init);
      if (url.includes('/workers/scripts/') && init.method === 'PUT') {
        return jsonResponse(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] });
      }
      return jsonResponse(200, { result: [] });
    },
    log: (line) => lines.push(line)
  });
  const report = JSON.parse(lines.at(-1));
  assert.equal(report.status, 'api-rejected');
  assert.equal(report.httpStatus, 403);
  assert.equal(report.errorCode, 10000);
  assert.equal(report.errorMessage, 'Authentication error');
  assert.ok(calls.length >= 2, 'the account-discovery retry must be attempted');
  assert.ok(lines.some((line) => line.startsWith('::error title=Cloudflare Edge Status::')), 'a rejected upload is an error annotation, not a notice');
  assert.equal(returned?.status, 'api-rejected', 'main() returns the report so the CLI can exit non-zero');
  const printed = lines.join('\n');
  assert.ok(!printed.includes('super-secret-token'), 'the API token must never be printed');
  const summary = await readFile(summaryPath, 'utf8');
  assert.match(summary, /api-rejected/);
});

test('edge deploy: a wrong account id is discovered and the upload retried once', async () => {
  const lines = [];
  let put = 0;
  const sqlite = new DatabaseSync(':memory:');
  const d1Handler = createRealD1QueryHandler(sqlite);
  await main({
    argv: [],
    env: { CLOUDFLARE_ACCOUNT_ID: 'stale-account', CLOUDFLARE_API_TOKEN: 'token-1' },
    fetchImpl: async (url, init = {}) => {
      if (url.includes('/d1/database?')) {
        return jsonResponse(200, { success: true, result: [{ uuid: 'db-1', name: 'celia-edge-state' }] });
      }
      if (url.includes('/d1/database/db-1/query')) return d1Handler(url, init);
      if (url.includes('/accounts?') || url.endsWith('/accounts')) {
        return jsonResponse(200, { result: [{ id: 'right-account' }] });
      }
      if (init.method === 'PUT') {
        put += 1;
        return put === 1
          ? jsonResponse(403, { success: false, errors: [{ code: 7003, message: 'Could not route' }] })
          : jsonResponse(200, { success: true, result: {} });
      }
      if (url.endsWith('/subdomain')) return jsonResponse(200, { result: { subdomain: 'celia' } });
      if (url.endsWith('/readyz')) return jsonResponse(200, { ready: true });
      return jsonResponse(200, { result: {} });
    },
    log: (line) => lines.push(line)
  });
  const report = JSON.parse(lines.at(-1));
  assert.equal(report.status, 'deployed');
  assert.equal(report.workerUrl, 'https://celia-phone-google.celia.workers.dev');
  assert.equal(report.liveReady, true);
  assert.equal(put, 2);
});

test('edge deploy: a worker with no subdomain is deployed but claims no live URL', async () => {
  const lines = [];
  const sqlite = new DatabaseSync(':memory:');
  const d1Handler = createRealD1QueryHandler(sqlite);
  await main({
    argv: [],
    env: { CLOUDFLARE_ACCOUNT_ID: 'acc-1', CLOUDFLARE_API_TOKEN: 'token-1' },
    fetchImpl: async (url, init = {}) => {
      if (url.includes('/d1/database?')) {
        return jsonResponse(200, { success: true, result: [{ uuid: 'db-1', name: 'celia-edge-state' }] });
      }
      if (url.includes('/d1/database/db-1/query')) return d1Handler(url, init);
      if (init.method === 'PUT') return jsonResponse(200, { success: true });
      if (url.endsWith('/subdomain')) return jsonResponse(200, { result: {} });
      return jsonResponse(200, { result: {} });
    },
    log: (line) => lines.push(line)
  });
  const report = JSON.parse(lines.at(-1));
  assert.equal(report.status, 'deployed');
  assert.equal(report.workerUrl, null);
  assert.equal(report.liveReady, false);
});

test('edge deploy: a failing /readyz probe keeps liveReady false instead of throwing', async () => {
  const lines = [];
  const sqlite = new DatabaseSync(':memory:');
  const d1Handler = createRealD1QueryHandler(sqlite);
  await main({
    argv: [],
    env: { CLOUDFLARE_ACCOUNT_ID: 'acc-1', CLOUDFLARE_API_TOKEN: 'token-1' },
    fetchImpl: async (url, init = {}) => {
      if (url.includes('/d1/database?')) {
        return jsonResponse(200, { success: true, result: [{ uuid: 'db-1', name: 'celia-edge-state' }] });
      }
      if (url.includes('/d1/database/db-1/query')) return d1Handler(url, init);
      if (init.method === 'PUT') return jsonResponse(200, { success: true });
      if (url.endsWith('/subdomain')) return jsonResponse(200, { result: { subdomain: 'celia' } });
      if (url.endsWith('/readyz')) throw new Error('connection refused');
      return jsonResponse(200, { result: {} });
    },
    log: (line) => lines.push(line)
  });
  const report = JSON.parse(lines.at(-1));
  assert.equal(report.status, 'deployed');
  assert.equal(report.liveReady, false);
});

test('edge deploy: full D1 migration applies all 20 statements (0001..0005) on real SQLite D1 and records _migrations ledger', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'celia-edge-ok-'));
  const summaryPath = path.join(directory, 'summary.md');
  const lines = [];
  const queriedStatements = [];
  const uploadedParts = [];
  const sqlite = new DatabaseSync(':memory:');
  const d1Handler = createRealD1QueryHandler(sqlite, queriedStatements);

  await main({
    argv: [],
    env: {
      CLOUDFLARE_ACCOUNT_ID: 'acc-1',
      CLOUDFLARE_API_TOKEN: 'token-1',
      GITHUB_STEP_SUMMARY: summaryPath
    },
    fetchImpl: async (url, init = {}) => {
      if (url.includes('/d1/database?')) {
        return jsonResponse(200, { success: true, result: [] });
      }
      if (url.endsWith('/d1/database') && init.method === 'POST') {
        return jsonResponse(200, { success: true, result: { uuid: 'db-live-1', name: 'celia-edge-state' } });
      }
      if (url.includes('/d1/database/db-live-1/query')) {
        return d1Handler(url, init);
      }
      if (init.method === 'PUT') {
        uploadedParts.push([...init.body.keys()]);
        return jsonResponse(200, { success: true });
      }
      if (url.endsWith('/subdomain')) return jsonResponse(200, { result: { subdomain: 'celia' } });
      if (url.endsWith('/readyz')) {
        return jsonResponse(200, {
          ok: true,
          ready: true,
          storage: { mode: 'd1', durable: true, durabilityVerifiedBy: 'this endpoint: write + read-back of a fresh token' }
        });
      }
      return jsonResponse(200, { result: {} });
    },
    log: (line) => lines.push(line)
  });

  const report = JSON.parse(lines.at(-1));
  assert.equal(report.status, 'deployed');
  assert.equal(report.d1.ok, true);
  assert.equal(report.d1.id, 'db-live-1');
  assert.equal(report.d1.migrations.statements, 20);
  assert.equal(report.d1.migrations.appliedFiles, 5);
  assert.equal(queriedStatements.filter((stmt) => stmt.includes('edge_cron_outbox')).length, 2, 'the cron outbox table and its index ship with the deploy');
  assert.equal(queriedStatements.some((stmt) => stmt.includes('every statement is')), false);
  const cols = sqlite.prepare('PRAGMA table_info(edge_idempotency)').all().map((c) => c.name);
  assert.ok(cols.includes('status') && cols.includes('dispatched_at'), '0005 columns exist on real SQLite');
  const recordedVersions = sqlite.prepare('SELECT version FROM _migrations ORDER BY version ASC').all().map((r) => r.version);
  assert.equal(recordedVersions.length, 5);
  assert.equal(report.liveReady, true);
  assert.equal(report.storage?.durable, true);
  assert.equal(report.storage?.mode, 'd1');

  // The upload carries every module of the Worker's import graph — a missing one is rejected by Cloudflare
  // (10021 "No such module") while the previous version keeps running, which is how 2026-10-29's deploy failed.
  const expectedModules = (await collectWorkerModules()).map((module) => module.name);
  assert.equal(uploadedParts.length, 1, 'exactly one upload');
  assert.deepEqual(uploadedParts[0], ['metadata', ...expectedModules]);
  assert.deepEqual(report.modules, expectedModules);
  assert.ok(expectedModules.includes('cron.js'), 'the cron outbox module ships with the Worker');

  const summary = await readFile(summaryPath, 'utf8');
  assert.match(summary, /durable=true/);
  assert.match(summary, /db-live-1/);
  assert.match(summary, /Modules uploaded: .*`cron\.js`/);
});

test('edge deploy: the upload module list is derived from the import graph and covers every module the Worker imports', async () => {
  const modules = await collectWorkerModules();
  const names = modules.map((module) => module.name);
  assert.equal(names.at(-1), WORKER_ENTRY_MODULE, 'the entry module is appended last (dependencies first)');
  assert.equal(new Set(names).size, names.length, 'no module is uploaded twice');
  // Independent cross-check: every relative `./x.js` import found in any module of the directory must be in the list.
  const files = (await readdir(workerDir)).filter((name) => name.endsWith('.js'));
  const imported = new Set();
  for (const file of files) {
    const source = await readFile(path.join(workerDir, file), 'utf8');
    for (const match of source.matchAll(/from\s*['"]\.\/([^'"]+)['"]/g)) imported.add(match[1]);
  }
  assert.ok(imported.size >= 3, `relative imports found (${imported.size})`);
  for (const name of imported) {
    assert.ok(names.includes(name), `${name} is imported by a Worker module and must ship in the upload`);
    assert.ok(files.includes(name), `${name} exists in workers/celia-edge`);
  }
  for (const required of ['worker.js', 'state.js', 'runtime.js', 'crypto.js', 'cron.js']) {
    assert.ok(names.includes(required), `${required} ships`);
  }
});

test('edge deploy: a module imported but missing from the bundle fails the deploy locally, before any upload', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'celia-edge-modules-'));
  await writeFile(path.join(directory, 'worker.js'), "import { a } from './a.js';\nexport { b } from './lib/b.js';\nexport default { fetch: () => import('./lazy.js') };\n");
  await writeFile(path.join(directory, 'a.js'), "import './side-effect.js';\nexport const a = 1;\n");
  await writeFile(path.join(directory, 'side-effect.js'), 'globalThis.touched = true;\n');
  await writeFile(path.join(directory, 'lazy.js'), 'export const lazy = true;\n');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(path.join(directory, 'lib')));
  await writeFile(path.join(directory, 'lib', 'b.js'), "import { a } from '../a.js';\nexport const b = a + 1;\n");
  const modules = await collectWorkerModules({ dir: directory });
  assert.deepEqual(
    modules.map((module) => module.name),
    ['side-effect.js', 'a.js', 'lib/b.js', 'lazy.js', 'worker.js'],
    'static, re-export, bare side-effect and dynamic imports are all followed, dependencies first'
  );

  await writeFile(path.join(directory, 'worker.js'), "import { gone } from './gone.js';\n");
  await assert.rejects(collectWorkerModules({ dir: directory }), /worker_module_missing: gone\.js \(imported by worker\.js\)/);

  await writeFile(path.join(directory, 'worker.js'), "import { outside } from '../outside.js';\n");
  await assert.rejects(collectWorkerModules({ dir: directory }), /worker_module_outside_bundle/);
});

test('edge deploy: fail-closed when existing D1 database migration fails — Worker upload is aborted', async () => {
  const lines = [];
  let putCalls = 0;
  const returned = await main({
    argv: [],
    env: { CLOUDFLARE_ACCOUNT_ID: 'acc-1', CLOUDFLARE_API_TOKEN: 'token-1' },
    fetchImpl: async (url, init = {}) => {
      if (url.includes('/d1/database?')) {
        return jsonResponse(200, { success: true, result: [{ uuid: 'db-existing', name: 'celia-edge-state' }] });
      }
      if (url.includes('/d1/database/db-existing/query')) {
        return jsonResponse(400, { success: false, errors: [{ message: 'simulated_ddl_rejection' }] });
      }
      if (init.method === 'PUT') {
        putCalls += 1;
        return jsonResponse(200, { success: true });
      }
      return jsonResponse(200, { result: {} });
    },
    retryDelayMs: 5,
    log: (line) => lines.push(line)
  });

  const report = JSON.parse(lines.at(-1));
  assert.equal(returned?.status, 'migration-failed');
  assert.equal(report.status, 'migration-failed');
  assert.equal(report.d1.ok, false);
  assert.equal(report.d1.created, false);
  assert.equal(putCalls, 0, 'Worker PUT upload must never run when migration fails on existing D1');
  assert.ok(lines.some((line) => line.startsWith('::error title=Celia D1::')), 'migration failure emits an error annotation');
});

test('edge deploy: fail-closed when newly created D1 database migration fails — Worker upload is aborted', async () => {
  const lines = [];
  let putCalls = 0;
  const returned = await main({
    argv: [],
    env: { CLOUDFLARE_ACCOUNT_ID: 'acc-1', CLOUDFLARE_API_TOKEN: 'token-1' },
    fetchImpl: async (url, init = {}) => {
      if (url.includes('/d1/database?')) {
        return jsonResponse(200, { success: true, result: [] });
      }
      if (url.endsWith('/d1/database') && init.method === 'POST') {
        return jsonResponse(200, { success: true, result: { uuid: 'db-brand-new', name: 'celia-edge-state' } });
      }
      if (url.includes('/d1/database/db-brand-new/query')) {
        return jsonResponse(400, { success: false, errors: [{ message: 'simulated_new_db_ddl_rejection' }] });
      }
      if (init.method === 'PUT') {
        putCalls += 1;
        return jsonResponse(200, { success: true });
      }
      return jsonResponse(200, { result: {} });
    },
    retryDelayMs: 5,
    log: (line) => lines.push(line)
  });

  const report = JSON.parse(lines.at(-1));
  assert.equal(returned?.status, 'migration-failed');
  assert.equal(report.status, 'migration-failed');
  assert.equal(report.d1.ok, false);
  assert.equal(report.d1.created, true);
  assert.equal(putCalls, 0, 'Worker PUT upload must never run when migration fails on newly created D1');
  assert.ok(lines.some((line) => line.startsWith('::error title=Celia D1::')));
});

test('edge deploy: running main() twice back-to-back on pre-0005 live D1 state marks 0001..0004 pre-applied, runs 0005 once, backfills legacy rows, and skips all on second deploy', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const pre0005Names = (await readdir(migrationsDir)).filter((n) => n.endsWith('.sql') && n < '0005_').sort();
  for (const name of pre0005Names) {
    const raw = await readFile(path.join(migrationsDir, name), 'utf8');
    for (const stmt of splitSqlStatements(raw)) sqlite.exec(stmt);
  }
  sqlite
    .prepare('INSERT INTO edge_idempotency (scope_key, response_json, created_at) VALUES (?, ?, ?)')
    .run('whatsapp.send:legacy-1', '{"ok":true,"providerMessageId":"wamid.old"}', '2026-10-30T17:15:00.000Z');

  const queried = [];
  const d1Handler = createRealD1QueryHandler(sqlite, queried);
  const runDeploy = async () => {
    const lines = [];
    const res = await main({
      argv: [],
      env: { CLOUDFLARE_ACCOUNT_ID: 'acc-1', CLOUDFLARE_API_TOKEN: 'token-1' },
      fetchImpl: async (url, init = {}) => {
        if (url.includes('/d1/database?')) {
          return jsonResponse(200, { success: true, result: [{ uuid: 'db-live-upgrade', name: 'celia-edge-state' }] });
        }
        if (url.includes('/d1/database/db-live-upgrade/query')) return d1Handler(url, init);
        if (init.method === 'PUT') return jsonResponse(200, { success: true });
        if (url.endsWith('/subdomain')) return jsonResponse(200, { result: { subdomain: 'celia' } });
        if (url.endsWith('/readyz')) return jsonResponse(200, { ready: true, storage: { mode: 'd1', durable: true } });
        return jsonResponse(200, { result: {} });
      },
      retryDelayMs: 5,
      log: (line) => lines.push(line)
    });
    return res;
  };

  // Deploy #1: pre-marks 0001..0004 without re-executing them, applies 0005 (4 statements)
  const first = await runDeploy();
  assert.equal(first.status, 'deployed');
  assert.equal(first.d1.ok, true);
  assert.equal(first.d1.migrations.preAppliedFiles, 4);
  assert.equal(first.d1.migrations.appliedFiles, 1);
  assert.equal(first.d1.migrations.statements, 4);

  const upgradedRow = sqlite
    .prepare('SELECT status, dispatched_at, response_json FROM edge_idempotency WHERE scope_key = ?')
    .get('whatsapp.send:legacy-1');
  assert.equal(upgradedRow.status, 'completed');
  assert.equal(upgradedRow.dispatched_at, Date.parse('2026-10-30T17:15:00.000Z'));

  // Deploy #2 back-to-back: skips all 5 recorded migrations with zero ALTER TABLE re-runs
  const second = await runDeploy();
  assert.equal(second.status, 'deployed');
  assert.equal(second.d1.ok, true);
  assert.equal(second.d1.migrations.appliedFiles, 0);
  assert.equal(second.d1.migrations.skippedFiles, 5);
  assert.equal(second.d1.migrations.statements, 0);
});
