#!/usr/bin/env node
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyRetirementsToEnv, flagNameFor, loadServiceRetirements, RETIRABLE_FEATURES } from '../src/service-retirements.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = path.join(root, 'workers/celia-edge/worker.js');
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

export function buildWorkerMetadata({ env = process.env, version = '0.2.1', commit = 'main', retirements = loadServiceRetirements() } = {}) {
  // Retired services (DEC-030) travel to the edge as plain_text flags so /api/secrets/status tells the same truth as Git.
  const effectiveEnv = applyRetirementsToEnv(env, retirements);
  const retirementBindings = RETIRABLE_FEATURES
    .map((feature) => flagNameFor(feature))
    .filter((flag) => String(effectiveEnv[flag] || '').trim() === 'true')
    .map((flag) => ({ type: 'plain_text', name: flag, text: 'true' }));
  const bindings = [
    ...retirementBindings,
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
  const commit = String(env.GITHUB_SHA || 'main').trim();
  const metadata = buildWorkerMetadata({
    env,
    version: pkg.version,
    commit
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
  if (workerUrl) {
    try {
      const probeRes = await fetchImpl(`${workerUrl}/readyz`);
      if (probeRes.ok) {
        const probeData = await probeRes.json().catch(() => ({}));
        liveReady = Boolean(probeData.ready);
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
    version: pkg.version,
    commit,
    secretBindingsInjected: secretBindingsCount,
    totalSecretsTracked: SECRET_KEYS.length
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
