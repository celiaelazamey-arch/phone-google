#!/usr/bin/env node
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyRetirementsToEnv, flagNameFor, loadServiceRetirements, RETIRABLE_FEATURES } from '../src/service-retirements.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = path.join(root, 'workers/celia-edge/worker.js');
const statePath = path.join(root, 'workers/celia-edge/state.js');
const migrationPath = path.join(root, 'workers/celia-edge/migrations/0001_state.sql');
const pkgPath = path.join(root, 'package.json');

const SECRET_KEYS = [
  'AGENETROUTERAPI_KEY',
  'AI_GATEWAY_API_KEY',
  'CELIAOS_CRONJOB_ORG_API_KEY',
  'CELIA_MCP_API_TOKEN',
  'CELIA_VOICE_ID',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_R2_ACCESS_KEY_ID',
  'CLOUDFLARE_R2_S3_ENDPOINT',
  'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
  'DEEPSEEK_API_KEY',
  'ELEVENLABS_API_KEY',
  'FIGMA_ACCESS_TOKEN',
  'GEMINI_API_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'PHONE_NUMBER',
  'YOUR_CODATA_API_KEY'
];

export const D1_DATABASE_NAME = 'celia-edge-state';

/**
 * Creates the D1 database if the account does not have it yet, so the first deploy after this change does not
 * need a manual step. Idempotent: an existing database with the same name is reused untouched.
 */
export async function ensureD1Database({ accountId, apiToken, fetchImpl = fetch, name = D1_DATABASE_NAME, log = () => {} }) {
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}`;
  const headers = { authorization: `Bearer ${apiToken}` };
  const listed = await fetchImpl(`${baseUrl}/d1/database?per_page=100`, { headers });
  const listedJson = await listed.json().catch(() => ({}));
  if (!listed.ok) throw new Error(`d1_list_${listed.status}`);
  const existing = (listedJson?.result || []).find((entry) => entry?.name === name);
  if (existing?.uuid) return { id: existing.uuid, name, created: false };
  const created = await fetchImpl(`${baseUrl}/d1/database`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ name })
  });
  const createdJson = await created.json().catch(() => ({}));
  const id = createdJson?.result?.uuid;
  if (!created.ok || !id) throw new Error(`d1_create_${created.status}`);
  log(`D1 database ${name} created (${id})`);
  return { id, name, created: true };
}

/**
 * Splits a SQL migration script into individual executable statements while stripping `--` line comments
 * and `/* ... *\/` block comments BEFORE splitting on semicolons, and preserving quoted string/identifier
 * literals (`'...'`, `"..."`, `` `...` ``) intact.
 *
 * Regression context: `0001_state.sql` line 2 contains a semicolon inside a `--` comment
 * (`-- ... D1 query API; every statement is`). Splitting on `;` first left `every statement is` without `--`
 * at the start of statement 1 (`SQLITE_ERROR: near "every": syntax error`).
 */
export function splitSqlStatements(sql) {
  const source = String(sql ?? '');
  const statements = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (quote) {
      current += ch;
      if (ch === quote) {
        if (next === quote) {
          current += next;
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === '-' && next === '-') {
      i += 2;
      while (i < source.length && source[i] !== '\n') {
        i += 1;
      }
      current += '\n';
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        i += 1;
      }
      i += 1;
      current += ' ';
      continue;
    }

    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

/** Applies the DDL in `migrations/0001_state.sql`, statement by statement, through the D1 query API. */
export async function applyMigrations({ accountId, apiToken, databaseId, sql, fetchImpl = fetch, log = () => {} }) {
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}`;
  const headers = { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' };
  const statements = splitSqlStatements(sql);

  let applied = 0;
  for (const [index, statement] of statements.entries()) {
    let lastDetail = 'status_unknown';
    // A database created seconds ago is not always queryable immediately; one short retry covers that.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetchImpl(`${baseUrl}/d1/database/${encodeURIComponent(databaseId)}/query`, {
        method: 'POST',
        headers,
        // `params` is sent explicitly: an omitted field is accepted by the dashboard but has produced 400s here.
        body: JSON.stringify({ sql: statement, params: [] })
      });
      const payload = await response.json().catch(() => ({}));
      const itemError = Array.isArray(payload?.result)
        ? payload.result.find((entry) => entry && (entry.success === false || entry.error))?.error
        : null;
      const resultFailed = Array.isArray(payload?.result) && payload.result.some((entry) => entry && entry.success === false);
      const detail = payload?.errors?.[0]?.message || itemError || `status_${response.status}`;
      // Re-running the deploy must not fail on tables that already exist.
      if (/already exists/i.test(detail)) {
        applied += 1;
        lastDetail = null;
        break;
      }
      if (response.ok && payload?.success !== false && !resultFailed) {
        applied += 1;
        lastDetail = null;
        break;
      }
      lastDetail = detail;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
    if (lastDetail) {
      throw new Error(`d1_migration_failed:statement_${index + 1}:${String(lastDetail).slice(0, 160)}`);
    }
  }
  log(`D1 migrations applied: ${applied} statement(s)`);
  return { statements: applied };
}

export function buildWorkerMetadata({ env = process.env, version = '0.2.1', commit = 'main', d1DatabaseId = null, retirements = loadServiceRetirements() } = {}) {
  // Retired services (DEC-030) travel to the edge as plain_text flags so /api/secrets/status tells the same truth as Git.
  const effectiveEnv = applyRetirementsToEnv(env, retirements);
  const retirementBindings = RETIRABLE_FEATURES
    .map((feature) => flagNameFor(feature))
    .filter((flag) => String(effectiveEnv[flag] || '').trim() === 'true')
    .map((flag) => ({ type: 'plain_text', name: flag, text: 'true' }));
  const bindings = [
    ...retirementBindings,
    // D1 binding. Absent when the database could not be created — the worker then reports
    // storage.durable = false with the reason instead of pretending to persist.
    ...(d1DatabaseId ? [{ type: 'd1', name: 'DB', id: d1DatabaseId }] : []),
    {
      type: 'plain_text',
      name: 'ALLOWED_ORIGIN',
      text: String(env.ALLOWED_ORIGIN || 'https://celiaelazamey-arch.github.io').trim()
    },
    {
      type: 'plain_text',
      name: 'CELIA_VERSION',
      text: String(version)
    },
    {
      type: 'plain_text',
      name: 'CELIA_BUILD_SHA',
      text: String(commit)
    }
  ];

  for (const key of SECRET_KEYS) {
    const val = String(env[key] || '').trim();
    if (val && !/^replace-with-/i.test(val)) {
      bindings.push({
        type: 'secret_text',
        name: key,
        text: val
      });
    }
  }

  return {
    main_module: 'worker.js',
    compatibility_date: '2025-01-01',
    bindings
  };
}

export async function main({ argv = process.argv.slice(2), env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const apiToken = String(env.CLOUDFLARE_API_TOKEN || '').trim();
  const scriptName = String(env.CELIA_WORKER_NAME || 'celia-phone-google').trim();
  const dryRun = argv.includes('--dry-run') || !accountId || !apiToken;

  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  const workerSource = await readFile(workerPath, 'utf8');
  const stateSource = await readFile(statePath, 'utf8');
  const migrationSql = await readFile(migrationPath, 'utf8');
  const commit = String(env.GITHUB_SHA || 'main').trim();

  let d1 = { ok: false, reason: 'dry_run' };
  let database = null;
  // Bound even when the DDL fails: a bound-but-empty database makes /readyz say *why* (no such table) instead
  // of "not bound", which is the difference between a diagnosis and a shrug.
  let d1BindingId = null;
  if (!dryRun) {
    try {
      database = await ensureD1Database({ accountId, apiToken, fetchImpl, log });
      d1BindingId = database.id;
      const migrations = await applyMigrations({ accountId, apiToken, databaseId: database.id, sql: migrationSql, fetchImpl, log });
      d1 = { ok: true, id: database.id, name: database.name, created: database.created, migrations };
    } catch (error) {
      d1 = {
        ok: false,
        reason: String(error?.message || error).slice(0, 240),
        databaseId: database?.id || null,
        databaseCreated: database?.created ?? null,
        bindingApplied: Boolean(d1BindingId)
      };
      const bindingNote = d1BindingId
        ? 'binding applied so /readyz reports the exact probe error'
        : 'deploying without the binding; the worker will report storage.durable=false';
      log(`::warning title=Celia D1::${d1.reason} — ${bindingNote}`);
    }
  }

  const metadata = buildWorkerMetadata({
    env,
    version: pkg.version,
    commit,
    d1DatabaseId: d1BindingId
  });
  const secretBindingsCount = metadata.bindings.filter((b) => b.type === 'secret_text').length;

  if (dryRun) {
    const report = {
      status: 'dry-run',
      scriptName,
      version: pkg.version,
      commit,
      secretBindingsPrepared: secretBindingsCount,
      totalSecretsTracked: SECRET_KEYS.length,
      reason: !accountId || !apiToken ? 'missing_cloudflare_credentials' : 'explicit_dry_run'
    };
    log(JSON.stringify(report, null, 2));
    return;
  }

  let resolvedAccountId = accountId;
  const authHeaders = {
    authorization: `Bearer ${apiToken}`
  };

  const makeForm = () => {
    const form = new FormData();
    form.append(
      'metadata',
      new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
      'metadata.json'
    );
    form.append(
      'worker.js',
      new Blob([workerSource], { type: 'application/javascript+module' }),
      'worker.js'
    );
    // `worker.js` imports `./state.js`; both modules must travel in the same upload or the deploy fails.
    form.append(
      'state.js',
      new Blob([stateSource], { type: 'application/javascript+module' }),
      'state.js'
    );
    return form;
  };

  let baseUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(resolvedAccountId)}`;
  let uploadRes = await fetchImpl(
    `${baseUrl}/workers/scripts/${encodeURIComponent(scriptName)}`,
    {
      method: 'PUT',
      headers: authHeaders,
      body: makeForm()
    }
  );
  let uploadJson = await uploadRes.json().catch(() => ({}));

  if (!uploadRes.ok || uploadJson.success === false) {
    // Attempt automatic account ID discovery via Cloudflare Accounts API in case CLOUDFLARE_ACCOUNT_ID differs
    const accRes = await fetchImpl('https://api.cloudflare.com/client/v4/accounts? page=1&per_page=5', {
      method: 'GET',
      headers: authHeaders
    }).catch(() => null);
    const accJson = accRes ? await accRes.json().catch(() => ({})) : {};
    const discoveredId = accJson?.result?.[0]?.id;
    if (discoveredId && discoveredId !== resolvedAccountId) {
      resolvedAccountId = String(discoveredId).trim();
      baseUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(resolvedAccountId)}`;
      uploadRes = await fetchImpl(
        `${baseUrl}/workers/scripts/${encodeURIComponent(scriptName)}`,
        {
          method: 'PUT',
          headers: authHeaders,
          body: makeForm()
        }
      );
      uploadJson = await uploadRes.json().catch(() => ({}));
    }
  }

  if (!uploadRes.ok || uploadJson.success === false) {
    const code = uploadJson?.errors?.[0]?.code || uploadRes.status;
    const message = uploadJson?.errors?.[0]?.message || 'cloudflare_api_rejected';
    const summary = {
      status: 'api-rejected',
      httpStatus: uploadRes.status,
      errorCode: code,
      errorMessage: message,
      scriptName,
      secretBindingsPrepared: secretBindingsCount,
      totalSecretsTracked: SECRET_KEYS.length,
      note: 'Ensure CLOUDFLARE_API_TOKEN has Account -> Workers Scripts -> Edit permission.'
    };
    if (env.GITHUB_STEP_SUMMARY) {
      await appendFile(
        env.GITHUB_STEP_SUMMARY,
        `### Cloudflare Worker Edge Deployment\n- Status: \`api-rejected\` (HTTP ${uploadRes.status}, code \`${code}\`, message: \`${message}\`)\n- Secrets prepared: **${secretBindingsCount} / ${SECRET_KEYS.length}**\n`,
        'utf8'
      );
    }
    log(`::notice title=Cloudflare Edge Status::${JSON.stringify(summary)}`);
    log(JSON.stringify(summary, null, 2));
    return;
  }

  // Enable workers.dev route if available
  await fetchImpl(
    `${baseUrl}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`,
    {
      method: 'POST',
      headers: {
        ...authHeaders,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ enabled: true })
    }
  ).catch(() => {});

  const subRes = await fetchImpl(`${baseUrl}/workers/subdomain`, {
    method: 'GET',
    headers: authHeaders
  }).catch(() => null);
  const subJson = subRes ? await subRes.json().catch(() => ({})) : {};
  const subdomain = subJson?.result?.subdomain || null;
  const workerUrl = subdomain ? `https://${scriptName}.${subdomain}.workers.dev` : null;

  let liveReady = false;
  let liveStorage = null;
  if (workerUrl) {
    try {
      const probeRes = await fetchImpl(`${workerUrl}/readyz`);
      if (probeRes.ok) {
        const probeData = await probeRes.json().catch(() => ({}));
        liveReady = Boolean(probeData.ready);
        liveStorage = probeData.storage ?? null;
      }
    } catch {
      liveReady = false;
    }
  }

  const report = {
    status: 'deployed',
    scriptName,
    workerUrl,
    liveReady,
    storage: liveStorage,
    version: pkg.version,
    commit,
    secretBindingsInjected: secretBindingsCount,
    totalSecretsTracked: SECRET_KEYS.length,
    d1
  };

  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      env.GITHUB_STEP_SUMMARY,
      [
        '### Cloudflare Worker Edge Deployment',
        `- Status: **deployed**`,
        `- Worker Name: \`${scriptName}\``,
        workerUrl ? `- Live Edge URL: ${workerUrl}` : '- Live Edge URL: subdomain not enabled yet',
        `- Secrets Injected: **${secretBindingsCount} / ${SECRET_KEYS.length}**`,
        `- Live \`/readyz\` check: **${liveReady ? 'PASS' : 'pending propagation'}**`,
        ...(liveStorage
          ? [`- Live \`/readyz\` storage: \`durable=${Boolean(liveStorage.durable)}\` (\`mode=${liveStorage.mode || 'unknown'}\`${liveStorage.reason ? `, \`reason=${liveStorage.reason}\`` : ''})`]
          : []),
        `- Durable storage (D1 \`${D1_DATABASE_NAME}\`): **${d1.ok ? `${d1.id}${d1.created ? ' (created)' : ''}` : `degraded — ${d1.reason}${d1BindingId ? ' (binding applied, check /readyz)' : ' (no binding)'}`}**`,
        ''
      ].join('\n'),
      'utf8'
    );
  }

  log(`::notice title=Cloudflare Edge Status::${JSON.stringify(report)}`);
  log(JSON.stringify(report, null, 2));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await main();
}
