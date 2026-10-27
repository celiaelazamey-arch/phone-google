#!/usr/bin/env node
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

export function buildWorkerMetadata({ env = process.env, version = '0.2.1', commit = 'main' } = {}) {
  const bindings = [
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

async function main() {
  const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const apiToken = String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
  const scriptName = String(process.env.CELIA_WORKER_NAME || 'celia-phone-google').trim();
  const dryRun = process.argv.includes('--dry-run') || !accountId || !apiToken;

  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  const workerSource = await readFile(workerPath, 'utf8');
  const commit = String(process.env.GITHUB_SHA || 'main').trim();
  const metadata = buildWorkerMetadata({
    env: process.env,
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
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}`;
  const authHeaders = {
    authorization: `Bearer ${apiToken}`
  };

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

  const uploadRes = await fetch(
    `${baseUrl}/workers/scripts/${encodeURIComponent(scriptName)}`,
    {
      method: 'PUT',
      headers: authHeaders,
      body: form
    }
  );
  const uploadJson = await uploadRes.json().catch(() => ({}));

  if (!uploadRes.ok || uploadJson.success === false) {
    const code = uploadJson?.errors?.[0]?.code || uploadRes.status;
    const summary = {
      status: 'api-rejected',
      httpStatus: uploadRes.status,
      errorCode: code,
      scriptName,
      secretBindingsPrepared: secretBindingsCount,
      totalSecretsTracked: SECRET_KEYS.length,
      note: 'Ensure CLOUDFLARE_API_TOKEN has Account -> Workers Scripts -> Edit permission.'
    };
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `### Cloudflare Worker Edge Deployment\n- Status: \`api-rejected\` (HTTP ${uploadRes.status}, code \`${code}\`)\n- Secrets prepared: **${secretBindingsCount} / ${SECRET_KEYS.length}**\n`,
        'utf8'
      );
    }
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  // Enable workers.dev route if available
  await fetch(
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

  const subRes = await fetch(`${baseUrl}/workers/subdomain`, {
    method: 'GET',
    headers: authHeaders
  }).catch(() => null);
  const subJson = subRes ? await subRes.json().catch(() => ({})) : {};
  const subdomain = subJson?.result?.subdomain || null;
  const workerUrl = subdomain ? `https://${scriptName}.${subdomain}.workers.dev` : null;

  let liveReady = false;
  if (workerUrl) {
    try {
      const probeRes = await fetch(`${workerUrl}/readyz`);
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

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
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

  console.log(JSON.stringify(report, null, 2));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await main();
}
