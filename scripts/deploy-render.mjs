#!/usr/bin/env node
/**
 * Full-backend release to the owner's FREE Render service — trigger, wait, verify, keep awake.
 *
 *   node scripts/deploy-render.mjs            # real run (GitHub Actions: .github/workflows/deploy-render.yml)
 *   node scripts/deploy-render.mjs --plan     # print what would happen and what is missing, no network
 *
 * What it needs (all optional — missing pieces produce a clear `not-configured` report, never a fake deploy):
 *   RENDER_API_KEY           secret: Render API key — enough on its own: the service is discovered by name
 *                            (`celia-phone-google` from render.yaml) and its public URL is read off the API
 *   CELIA_LIVE_URL           public https URL — accepted from an Actions VARIABLE or a SECRET (either tab);
 *                            optional when the API key is present, because the URL is discovered instead
 *   RENDER_SERVICE_ID        secret: srv-… — optional; skips discovery
 *   RENDER_DEPLOY_HOOK_URL   secret: deploy hook — alternative trigger when no API key (then /version is polled)
 *   CELIA_MCP_API_TOKEN      secret: enables the owner-only checks of verify:live (never printed)
 *   CELIAOS_CRONJOB_ORG_API_KEY  secret: creates/updates the 10-minute /readyz keep-alive job after a PASS
 *   GITHUB_SHA / CELIA_EXPECT_COMMIT  commit the live service must report on /version
 *
 * What it never does: create accounts, add payment methods, print secrets, or claim a deployment that
 * `npm run verify:live` did not confirm. The Render service itself is created once by the owner from
 * `render.yaml` (Dashboard → New → Blueprint); Aiven MySQL credentials live in Render only.
 */
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { runCli as runVerifyLive } from './verify-live.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RENDER_API = 'https://api.render.com/v1';
/** Service name declared in render.yaml — the only guess discovery is allowed to make. */
export const RENDER_SERVICE_NAME = 'celia-phone-google';
export const CRONJOB_API = 'https://api.cron-job.org';
export const TERMINAL_DEPLOY_STATUSES = Object.freeze({
  live: 'success',
  build_failed: 'failure',
  update_failed: 'failure',
  pre_deploy_failed: 'failure',
  canceled: 'failure',
  deactivated: 'failure'
});

const trim = (value) => String(value ?? '').trim();
const isHttps = (value) => /^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/.*)?$/i.test(value);

/**
 * Pure: reads the public URL from wherever the owner actually put it. The first real run of this workflow sat
 * at `not-configured` while the URL existed, because the workflow only looked at `vars` and the owner had
 * stored it as a secret — so both tabs are accepted now, and the caller passes them separately.
 */
export function resolveLiveUrl(env = process.env) {
  for (const value of [env.CELIA_LIVE_URL, env.CELIA_LIVE_URL_VAR, env.CELIA_LIVE_URL_SECRET]) {
    const url = trim(value).replace(/\/+$/, '');
    if (url) return url;
  }
  return '';
}

/** Pure: the service names the key can see — printed when discovery fails so the owner sees *why*. */
export function serviceNames(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.services || payload?.items || [];
  return rows
    .map((row) => row?.service || row)
    .map((entry) => trim(entry?.name))
    .filter(Boolean)
    .slice(0, 12);
}

/**
 * Pure: `GET /v1/services` → the one service this repo deploys. Exact name wins; a single unrelated service is
 * accepted; anything else returns null so the caller reports ambiguity instead of deploying the wrong service.
 */
export function pickService(payload, wanted = RENDER_SERVICE_NAME) {
  const rows = Array.isArray(payload) ? payload : payload?.services || payload?.items || [];
  const services = rows.map((row) => row?.service || row).filter((entry) => entry?.id);
  if (!services.length) return null;
  const exact = services.find((entry) => entry.name === wanted);
  if (exact) return { id: exact.id, name: exact.name || null, url: trim(exact.serviceDetails?.url || exact.url) || null };
  if (services.length === 1) {
    const only = services[0];
    return { id: only.id, name: only.name || null, url: trim(only.serviceDetails?.url || only.url) || null };
  }
  return null;
}

/** Pure: decides the mode and lists what the owner still has to provide. */
export function planDeployment(env = process.env) {
  const liveUrl = resolveLiveUrl(env);
  const apiKey = trim(env.RENDER_API_KEY);
  const serviceId = trim(env.RENDER_SERVICE_ID);
  const hook = trim(env.RENDER_DEPLOY_HOOK_URL);
  const missing = [];
  // With an API key the service can be looked up by name, so neither an id nor a URL has to be typed by hand.
  const canDiscover = Boolean(apiKey);
  const needsDiscovery = canDiscover && (!serviceId || !liveUrl);
  let trigger = null;
  if (!liveUrl && !canDiscover) missing.push('CELIA_LIVE_URL (Actions variable or secret)');
  if (apiKey) trigger = 'render-api';
  else if (hook) trigger = 'deploy-hook';
  else missing.push('RENDER_API_KEY (or RENDER_DEPLOY_HOOK_URL)');
  if (liveUrl && !isHttps(liveUrl)) missing.push('CELIA_LIVE_URL must be an https URL');
  if (hook && !isHttps(hook)) missing.push('RENDER_DEPLOY_HOOK_URL must be an https URL');
  const expectCommit = trim(env.CELIA_EXPECT_COMMIT || env.GITHUB_SHA) || null;
  return {
    ok: missing.length === 0,
    mode: missing.length === 0 ? trigger : 'not-configured',
    liveUrl: liveUrl || null,
    serviceId: serviceId || null,
    needsDiscovery,
    expectCommit,
    ownerChecks: Boolean(trim(env.CELIA_MCP_API_TOKEN)),
    keepalive: Boolean(trim(env.CELIAOS_CRONJOB_ORG_API_KEY)),
    missing
  };
}

/** Runtime: fills the service id and the public URL from the Render API when the owner did not type them. */
export async function resolveService(env, plan, { log = () => {} } = {}) {
  if (!plan.needsDiscovery) return plan;
  const payload = await renderRequest(env, 'GET', '/services?limit=100');
  const found = pickService(payload);
  if (!found) {
    const names = serviceNames(payload);
    throw new Error(`render_service_not_found:${RENDER_SERVICE_NAME}${names.length ? `(visible: ${names.join(', ')})` : '(no services visible to this key)'}`);
  }
  if (!plan.serviceId) log(`service ${found.id} discovered by name (${found.name})`);
  if (!plan.liveUrl) {
    if (!found.url || !isHttps(found.url)) throw new Error('render_service_url_missing:' + found.id);
    log(`live URL ${found.url} read from the Render API`);
  }
  return { ...plan, serviceId: plan.serviceId || found.id, liveUrl: plan.liveUrl || found.url.replace(/\/+$/, ''), discovered: !plan.serviceId || !plan.liveUrl };
}

/** Pure: the cron-job.org job that keeps the free instance awake within its 750 h/month quota. */
export function buildKeepaliveJob(liveUrl) {
  const host = new URL(liveUrl).host;
  return {
    title: `celia-keepalive:${host}`,
    url: `${liveUrl.replace(/\/+$/, '')}/readyz`,
    enabled: true,
    saveResponses: false,
    requestMethod: 0,
    schedule: { timezone: 'UTC', expiresAt: 0, hours: [-1], mdays: [-1], minutes: [0, 10, 20, 30, 40, 50], months: [-1], wdays: [-1] }
  };
}

/** Pure: strips every configured secret value from anything we are about to print. */
export function sanitize(text, env = process.env) {
  let out = String(text ?? '');
  for (const key of ['RENDER_API_KEY', 'RENDER_DEPLOY_HOOK_URL', 'CELIA_MCP_API_TOKEN', 'CELIAOS_CRONJOB_ORG_API_KEY']) {
    const value = trim(env[key]);
    if (value.length >= 8) out = out.split(value).join(`<${key}>`);
  }
  return out;
}

export function classifyDeployStatus(status) {
  return TERMINAL_DEPLOY_STATUSES[String(status || '')] || 'pending';
}

async function renderRequest(env, method, endpoint, body) {
  const response = await fetch(`${RENDER_API}${endpoint}`, {
    method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${trim(env.RENDER_API_KEY)}`,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`render_api_${response.status}:${json?.message || endpoint}`);
  return json;
}

async function triggerViaApi(env, plan, { pollMs, timeoutMs, log }) {
  const created = await renderRequest(env, 'POST', `/services/${encodeURIComponent(plan.serviceId)}/deploys`, { clearCache: 'do_not_clear' });
  const deployId = created?.id;
  if (!deployId) throw new Error('render_deploy_id_missing');
  log(`deploy ${deployId} created (commit ${created?.commit?.id?.slice(0, 7) || '?'})`);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(pollMs);
    const deploy = await renderRequest(env, 'GET', `/services/${encodeURIComponent(plan.serviceId)}/deploys/${encodeURIComponent(deployId)}`);
    const verdict = classifyDeployStatus(deploy?.status);
    log(`deploy ${deployId}: ${deploy?.status}`);
    if (verdict === 'success') return { deployId, status: deploy.status, commit: deploy?.commit?.id || null };
    if (verdict === 'failure') throw new Error(`render_deploy_${deploy.status}`);
  }
  throw new Error('render_deploy_timeout');
}

async function triggerViaHook(env, plan, { pollMs, timeoutMs, log }) {
  const response = await fetch(trim(env.RENDER_DEPLOY_HOOK_URL), { method: 'POST' });
  if (!response.ok) throw new Error(`render_hook_${response.status}`);
  log('deploy hook accepted');
  const startedAt = Date.now();
  let lastCommit = null;
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(pollMs);
    try {
      const res = await fetch(`${plan.liveUrl}/version`, { headers: { 'cache-control': 'no-cache' } });
      const json = res.ok ? await res.json().catch(() => ({})) : {};
      lastCommit = json?.commit || null;
      log(`/version commit ${lastCommit ? lastCommit.slice(0, 7) : '?'} (want ${plan.expectCommit ? plan.expectCommit.slice(0, 7) : 'any'})`);
      if (!plan.expectCommit || (lastCommit && lastCommit.toLowerCase() === plan.expectCommit.toLowerCase())) {
        return { deployId: null, status: 'live', commit: lastCommit };
      }
    } catch {
      log('/version not reachable yet');
    }
  }
  throw new Error(`render_hook_timeout:last_commit=${lastCommit || 'none'}`);
}

async function ensureKeepalive(env, plan, log) {
  const headers = { accept: 'application/json', authorization: `Bearer ${trim(env.CELIAOS_CRONJOB_ORG_API_KEY)}`, 'content-type': 'application/json' };
  const job = buildKeepaliveJob(plan.liveUrl);
  const listed = await fetch(`${CRONJOB_API}/jobs`, { headers });
  if (!listed.ok) throw new Error(`cronjob_list_${listed.status}`);
  const jobs = (await listed.json().catch(() => ({})))?.jobs || [];
  const existing = jobs.find((entry) => entry?.title === job.title);
  if (existing?.jobId) {
    const patched = await fetch(`${CRONJOB_API}/jobs/${encodeURIComponent(existing.jobId)}`, { method: 'PATCH', headers, body: JSON.stringify({ job }) });
    if (!patched.ok) throw new Error(`cronjob_update_${patched.status}`);
    log(`keep-alive job ${existing.jobId} updated`);
    return { action: 'updated', jobId: existing.jobId, title: job.title };
  }
  const created = await fetch(`${CRONJOB_API}/jobs`, { method: 'PUT', headers, body: JSON.stringify({ job }) });
  if (!created.ok) throw new Error(`cronjob_create_${created.status}`);
  const jobId = (await created.json().catch(() => ({})))?.jobId ?? null;
  log(`keep-alive job ${jobId} created`);
  return { action: 'created', jobId, title: job.title };
}

async function writeSummary(env, lines) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  await appendFile(env.GITHUB_STEP_SUMMARY, `${sanitize(lines.join('\n'), env)}\n`, 'utf8');
}

export async function main({ env = process.env, argv = process.argv.slice(2), log = (m) => console.error(sanitize(m, env)) } = {}) {
  let plan = planDeployment(env);
  const planOnly = argv.includes('--plan');
  const report = { status: 'not-configured', mode: plan.mode, liveUrl: plan.liveUrl, expectCommit: plan.expectCommit, missing: plan.missing };

  // `--plan` stays offline by contract; a real run fills the gaps from the Render API before claiming anything.
  if (plan.ok && plan.needsDiscovery && !planOnly) {
    try {
      plan = await resolveService(env, plan, { log });
      report.liveUrl = plan.liveUrl;
      report.serviceId = plan.serviceId;
    } catch (error) {
      plan = { ...plan, ok: false, mode: 'not-configured', missing: [...plan.missing, `service lookup failed: ${error?.message || 'render_api_error'}`] };
      report.missing = plan.missing;
    }
  }
  // A real run cannot verify anything without a URL; `--plan` reports the discovery it would do instead.
  if (plan.ok && !plan.liveUrl && !planOnly) {
    plan = { ...plan, ok: false, mode: 'not-configured', missing: [...plan.missing, 'CELIA_LIVE_URL (Actions variable or secret)'] };
    report.missing = plan.missing;
  }
  report.mode = plan.mode;

  if (!plan.ok || planOnly) {
    report.status = plan.ok ? 'planned' : 'not-configured';
    report.needsDiscovery = plan.ok ? plan.needsDiscovery : undefined;
    report.note = plan.ok
      ? 'All inputs present; rerun without --plan to deploy.'
      : plan.missing.some((entry) => entry.startsWith('service lookup failed'))
        ? 'RENDER_API_KEY is present but the service could not be resolved. Check that the Blueprint was created (Dashboard → New → Blueprint on render.yaml) and that the key belongs to the same account. No deployment is claimed.'
      : 'Owner action required: create the FREE Render service from render.yaml (Dashboard → New → Blueprint) and the Aiven MySQL Free database, then add the names listed under `missing` in Settings → Secrets and variables → Actions. No deployment is claimed.';
    await writeSummary(env, ['### Render full-backend release', `- Status: \`${report.status}\``, `- Missing: ${plan.missing.length ? plan.missing.map((m) => `\`${m}\``).join(', ') : 'nothing'}`, '']);
    console.log(`::notice title=Render Live Status::${sanitize(JSON.stringify(report), env)}`);
    console.log(sanitize(JSON.stringify(report, null, 2), env));
    return 0;
  }

  const pollMs = Number(env.CELIA_DEPLOY_POLL_MS || 15_000);
  const timeoutMs = Number(env.CELIA_DEPLOY_TIMEOUT_MS || 20 * 60_000);
  try {
    const deploy = plan.mode === 'render-api' ? await triggerViaApi(env, plan, { pollMs, timeoutMs, log }) : await triggerViaHook(env, plan, { pollMs, timeoutMs, log });
    report.deploy = deploy;
  } catch (error) {
    report.status = 'deploy-failed';
    report.error = sanitize(error?.message || 'deploy_failed', env);
    await writeSummary(env, ['### Render full-backend release', `- Status: \`deploy-failed\` — ${report.error}`, '']);
    console.log(`::error title=Render Live Status::${sanitize(JSON.stringify(report), env)}`);
    return 1;
  }

  const outPath = '.validation-artifacts/live-acceptance.json';
  const verifyArgs = ['--url', plan.liveUrl, '--out', outPath, '--timeout-ms', '120000', '--max-first-ms', '90000'];
  if (plan.expectCommit) verifyArgs.push('--expect-commit', plan.expectCommit);
  const verifyExit = await runVerifyLive(verifyArgs, { env, stdout: { write: (chunk) => process.stdout.write(sanitize(chunk, env)) }, stderr: { write: (chunk) => process.stderr.write(sanitize(chunk, env)) } });
  report.verifyLive = { exitCode: verifyExit, report: path.relative(root, path.resolve(root, outPath)), ownerChecks: plan.ownerChecks };
  if (verifyExit !== 0) {
    report.status = verifyExit === 3 ? 'report-withheld-token-detected' : 'verification-failed';
    await writeSummary(env, ['### Render full-backend release', `- Status: \`${report.status}\` (verify:live exit ${verifyExit})`, '']);
    console.log(`::error title=Render Live Status::${sanitize(JSON.stringify(report), env)}`);
    return 1;
  }

  report.status = 'verified';
  if (plan.keepalive && !argv.includes('--skip-keepalive')) {
    try {
      report.keepalive = await ensureKeepalive(env, plan, log);
    } catch (error) {
      report.keepalive = { action: 'failed', error: sanitize(error?.message || 'keepalive_failed', env) };
    }
  } else {
    report.keepalive = { action: 'skipped', reason: plan.keepalive ? 'flag' : 'CELIAOS_CRONJOB_ORG_API_KEY missing' };
  }
  await writeSummary(env, [
    '### Render full-backend release',
    '- Status: **verified** (`npm run verify:live` PASS on the public URL)',
    `- URL: ${plan.liveUrl}`,
    `- Commit: \`${plan.expectCommit || report.deploy?.commit || 'n/a'}\``,
    `- Owner-only checks: ${plan.ownerChecks ? 'included' : 'skipped (no CELIA_MCP_API_TOKEN)'}`,
    `- Keep-alive: ${report.keepalive.action}${report.keepalive.jobId ? ` (job ${report.keepalive.jobId})` : ''}`,
    ''
  ]);
  console.log(`::notice title=Render Live Status::${sanitize(JSON.stringify(report), env)}`);
  console.log(sanitize(JSON.stringify(report, null, 2), env));
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = await main();
}
