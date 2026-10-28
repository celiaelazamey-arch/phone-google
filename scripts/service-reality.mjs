#!/usr/bin/env node
/**
 * Service reality audit — "no service is just a name".
 *
 * For every service the system claims, this produces evidence of ONE of five truths:
 *   verified        a real request with the real credential did what the service is for
 *   failed          the credential is configured but the real request was rejected / unreachable
 *   not-configured  the credential is absent in this environment
 *   unverifiable    nothing can be sent without an owner action (linked account, unknown endpoint, no host)
 *   not-deployed    the component exists in code and tests but has no live instance
 *
 * Plus the offline truth: the full `node --test` suite with line/branch/function coverage, and the
 * real-MySQL suite when a database is provided (CI service container).
 *
 *   node scripts/service-reality.mjs                 # everything available in this environment
 *   node scripts/service-reality.mjs --skip-offline  # live probes only (CI already ran the suite)
 *   node scripts/service-reality.mjs --skip-live     # offline suite + coverage only
 *   node scripts/service-reality.mjs --min-rate 0.95 # exit 1 when < 95% of configured services work
 *
 * Never prints a secret value, a generated reply, or an email/voice payload. Synthetic, read-only
 * requests only: no job is created, no file written, no message sent.
 */
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = '.validation-artifacts/service-reality.json';
const SECRET_ENV_NAMES = [
  'AGENETROUTERAPI_KEY', 'AI_GATEWAY_API_KEY', 'CELIAOS_CRONJOB_ORG_API_KEY', 'CELIA_MCP_API_TOKEN', 'CELIA_VOICE_ID',
  'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_R2_ACCESS_KEY_ID', 'CLOUDFLARE_R2_S3_ENDPOINT',
  'CLOUDFLARE_R2_SECRET_ACCESS_KEY', 'DEEPSEEK_API_KEY', 'ELEVENLABS_API_KEY', 'FIGMA_ACCESS_TOKEN', 'GEMINI_API_KEY',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'PHONE_NUMBER', 'YOUR_CODATA_API_KEY',
  'RENDER_API_KEY', 'RENDER_DEPLOY_HOOK_URL', 'GITHUB_TOKEN', 'MYSQL_TEST_PASSWORD'
];
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// ---------- pure helpers (unit-tested) ----------

export function parseArgs(argv) {
  const options = { skipOffline: false, skipLive: false, minRate: 0.95, out: DEFAULT_OUT, timeoutMs: 20_000, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => { index += 1; if (index >= argv.length) throw new Error(`${arg} requires a value`); return argv[index]; };
    if (arg === '--skip-offline') options.skipOffline = true;
    else if (arg === '--skip-live') options.skipLive = true;
    else if (arg === '--min-rate') options.minRate = Number(next());
    else if (arg === '--out') options.out = next();
    else if (arg === '--timeout-ms') options.timeoutMs = Number(next());
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

/** Secret values that must never appear in any output of this script. */
export function secretValues(env = process.env) {
  return SECRET_ENV_NAMES.map((name) => String(env[name] || '').trim()).filter((value) => value.length >= 6);
}

export function sanitize(text, env = process.env) {
  let out = String(text ?? '');
  for (const value of secretValues(env)) out = out.split(value).join('<redacted>');
  return out;
}

/** Parses `node --test` TAP/spec output: counts plus the coverage table when present. */
export function parseTestSummary(output) {
  const text = String(output || '');
  const num = (label) => { const match = new RegExp(`^# ${label} (\\d+)`, 'm').exec(text); return match ? Number(match[1]) : null; };
  const files = {};
  let all = null;
  for (const line of text.split('\n')) {
    const row = /^#\s+(.+?)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/.exec(line);
    if (!row) continue;
    const entry = { lines: Number(row[2]), branches: Number(row[3]), functions: Number(row[4]) };
    if (row[1].trim() === 'all files') all = entry;
    else if (/\.(m?js)$/.test(row[1].trim())) files[row[1].trim()] = entry;
  }
  return { tests: num('tests'), pass: num('pass'), fail: num('fail'), skipped: num('skipped'), coverage: all, files };
}

/** AWS Signature V4 (used for Cloudflare R2's S3 API; region "auto"). Generic enough for the AWS test vectors. */
export function signAwsV4({ method = 'GET', url, headers = {}, region, service, accessKeyId, secretAccessKey, date = new Date(), payloadHash = EMPTY_SHA256 }) {
  const target = new URL(url);
  const allHeaders = { host: target.host, ...Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value).trim()])) };
  if (!('x-amz-date' in allHeaders)) allHeaders['x-amz-date'] = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = allHeaders['x-amz-date'].slice(0, 8);
  const signedHeaderNames = Object.keys(allHeaders).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${allHeaders[name].replace(/\s+/g, ' ')}\n`).join('');
  const canonicalQuery = [...target.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
  const canonicalRequest = [method.toUpperCase(), target.pathname || '/', canonicalQuery, canonicalHeaders, signedHeaderNames.join(';'), payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', allHeaders['x-amz-date'], scope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return {
    headers: { ...allHeaders, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}` },
    signature,
    canonicalRequest,
    stringToSign
  };
}

/** What an S3 response proves about the credentials. */
export function classifyS3Response(status, body = '') {
  const code = /<Code>([^<]+)<\/Code>/.exec(String(body))?.[1] || '';
  if (status === 200) return { verdict: 'verified', detail: `ListBuckets ok (${(String(body).match(/<Bucket>/g) || []).length} buckets)` };
  if (code === 'AccessDenied') return { verdict: 'verified', detail: 'credentials authenticated; token scoped below account-level ListBuckets (AccessDenied)' };
  if (['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'InvalidArgument', 'Unauthorized'].includes(code) || status === 401) return { verdict: 'failed', detail: `credentials rejected (${code || status})` };
  return { verdict: 'failed', detail: `unexpected S3 response ${status}${code ? ` ${code}` : ''}` };
}

/** What Google's token endpoint proves about an OAuth client (we send a deliberately invalid refresh token). */
export function classifyGoogleTokenResponse(status, body = {}) {
  const error = String(body?.error || '');
  if (error === 'invalid_grant') return { verdict: 'verified', detail: 'OAuth client authenticated (invalid_grant for the synthetic refresh token, as expected); no account linked by this probe' };
  if (error === 'invalid_client' || error === 'unauthorized_client' || status === 401) return { verdict: 'failed', detail: `OAuth client rejected (${error || status})` };
  if (error === 'invalid_request') return { verdict: 'failed', detail: 'token endpoint rejected the request shape (invalid_request)' };
  return { verdict: 'failed', detail: `unexpected token endpoint response ${status}${error ? ` ${error}` : ''}` };
}

export function scoreServices(services) {
  const counts = { verified: 0, failed: 0, 'not-configured': 0, unverifiable: 0, 'not-deployed': 0 };
  for (const service of services) counts[service.verdict] = (counts[service.verdict] || 0) + 1;
  const configured = counts.verified + counts.failed;
  return { ...counts, configured, workingRate: configured ? Number((counts.verified / configured).toFixed(4)) : null };
}

// ---------- probes (each returns { verdict, detail, ...extra }) ----------

function withTimeout(ms) { return AbortSignal.timeout(ms); }

async function probeJson(fetchImpl, url, init, timeoutMs) {
  const started = Date.now();
  const response = await fetchImpl(url, { ...init, signal: withTimeout(timeoutMs) });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, json, text, latencyMs: Date.now() - started };
}

export function buildProbes({ config, env, fetchImpl = fetch, timeoutMs, publication, version, modules }) {
  const { generateCeliaReply, probeCeliaVoice, fetchFigmaProfile, getCodataStatus, getCronjobStatus, planDeployment } = modules;
  const synthetic = 'مرحبا، كيف أتواصل مع موظف؟';
  const upstreamMeaning = { 401: 'credential rejected (401)', 402: 'authenticated but payment required / no balance (402)', 403: 'forbidden (403) — key invalid for this endpoint or plan', 404: 'endpoint or model not found (404)', 429: 'rate limited or quota exhausted (429) — key accepted' };
  const listModels = async (cfg) => {
    if (!cfg?.baseUrl) return null;
    try {
      const models = await probeJson(fetchImpl, `${cfg.baseUrl}/models`, { headers: { accept: 'application/json', authorization: `Bearer ${cfg.apiKey}` } }, timeoutMs);
      const ids = (Array.isArray(models.json?.data) ? models.json.data : []).map((entry) => String(entry?.id || '')).filter(Boolean);
      return models.status === 200 ? `/models 200 (${ids.length} models${ids.length ? `, e.g. ${ids.slice(0, 4).join(', ')}` : ''})` : `/models ${models.status}`;
    } catch (error) { return `/models unreachable (${error?.cause?.code || error?.name || 'error'})`; }
  };
  const aiProbe = (id, cfg) => async () => {
    if (!cfg?.apiKey) return { verdict: 'not-configured', detail: 'API key absent' };
    const started = Date.now();
    try {
      const result = await generateCeliaReply({ config, customerMessage: synthetic, provider: id });
      const ok = result?.provider === id && typeof result.reply === 'string' && result.reply.trim().length > 0;
      return { verdict: ok ? 'verified' : 'failed', detail: ok ? `model ${result.model} answered (content not logged)` : `provider returned ${result?.provider || 'nothing'}`, latencyMs: Date.now() - started };
    } catch (error) {
      const upstream = Number(error?.upstreamStatus);
      const meaning = upstreamMeaning[upstream] || (upstream ? `upstream ${upstream}` : String(error?.message || error?.code || 'error').slice(0, 200));
      const diagnostics = id === 'gemini' ? null : await listModels(cfg);
      return { verdict: 'failed', detail: [`model ${cfg.model}: ${meaning}`, diagnostics].filter(Boolean).join('; '), latencyMs: Date.now() - started };
    }
  };
  const workerUrl = publication.edgeUrl?.replace(/\/+$/, '');
  const pagesUrl = publication.staticSiteUrl?.replace(/\/+$/, '');

  return [
    { id: 'gemini', label: 'Gemini (AI reply)', secret: 'GEMINI_API_KEY', category: 'ai', run: aiProbe('gemini', config.gemini) },
    { id: 'ai_gateway', label: 'Vercel AI Gateway (AI reply)', secret: 'AI_GATEWAY_API_KEY', category: 'ai', run: aiProbe('ai_gateway', config.aiGateway) },
    { id: 'deepseek', label: 'DeepSeek (AI reply)', secret: 'DEEPSEEK_API_KEY', category: 'ai', run: aiProbe('deepseek', config.deepseek) },
    { id: 'agentrouter', label: 'AgentRouter (AI reply)', secret: 'AGENETROUTERAPI_KEY', category: 'ai', run: aiProbe('agentrouter', config.agentrouter) },
    {
      id: 'elevenlabs', label: 'ElevenLabs voice', secret: 'ELEVENLABS_API_KEY + CELIA_VOICE_ID', category: 'voice',
      run: async () => {
        if (!config.elevenlabs?.apiKey) return { verdict: 'not-configured', detail: 'API key absent' };
        if (!config.elevenlabs?.voiceId) return { verdict: 'failed', detail: 'CELIA_VOICE_ID missing or malformed' };
        const started = Date.now();
        try {
          const voice = await probeCeliaVoice({ config, timeoutMs });
          return { verdict: voice.reachable ? 'verified' : 'failed', detail: voice.reachable ? `voice found (category ${voice.category || 'n/a'})` : 'voice not reachable', latencyMs: Date.now() - started };
        } catch (error) {
          // Split "key is wrong" from "voice id is wrong" so the owner fixes the right secret.
          const headers = { accept: 'application/json', 'xi-api-key': config.elevenlabs.apiKey };
          const user = await probeJson(fetchImpl, `${config.elevenlabs.baseUrl}/user`, { headers }, timeoutMs).catch(() => ({ status: 0 }));
          const voices = await probeJson(fetchImpl, `${config.elevenlabs.baseUrl}/voices`, { headers }, timeoutMs).catch(() => ({ status: 0 }));
          const ids = (Array.isArray(voices.json?.voices) ? voices.json.voices : []).map((entry) => String(entry?.voice_id || ''));
          const keyValid = user.status === 200;
          const detail = `GET /voices/{CELIA_VOICE_ID} → ${error?.upstreamStatus || error?.message || 'error'}; API key ${keyValid ? 'valid (/user 200)' : `rejected (/user ${user.status})`}; ${voices.status === 200 ? `${ids.length} voices visible, configured voice id ${ids.includes(config.elevenlabs.voiceId) ? 'listed' : 'NOT among them'}` : `/voices ${voices.status}`}`;
          return { verdict: 'failed', detail, latencyMs: Date.now() - started };
        }
      }
    },
    {
      id: 'figma', label: 'Figma API', secret: 'FIGMA_ACCESS_TOKEN', category: 'design',
      run: async () => {
        if (!config.figma?.accessToken) return { verdict: 'not-configured', detail: 'token absent' };
        const started = Date.now();
        const me = await fetchFigmaProfile({ config, timeoutMs });
        return { verdict: me.id ? 'verified' : 'failed', detail: me.id ? 'GET /v1/me ok' : 'profile empty', latencyMs: Date.now() - started };
      }
    },
    {
      id: 'codata', label: 'Codata', secret: 'YOUR_CODATA_API_KEY', category: 'data',
      run: async () => {
        if (!config.codata?.apiKey) return { verdict: 'not-configured', detail: 'key absent' };
        if (!config.codata?.baseUrl) return { verdict: 'unverifiable', detail: 'CODATA_BASE_URL not set — no endpoint is known for this key, so it cannot be exercised; owner must supply the API base URL or retire the secret' };
        const started = Date.now();
        const status = await getCodataStatus({ config, probe: true, timeoutMs });
        return { verdict: status.reachable ? 'verified' : 'failed', detail: status.reachable ? 'workspace readable' : 'probe failed', latencyMs: Date.now() - started };
      }
    },
    {
      id: 'cronjob', label: 'cron-job.org scheduler', secret: 'CELIAOS_CRONJOB_ORG_API_KEY', category: 'scheduler',
      run: async () => {
        if (!config.cronjob?.apiKey) return { verdict: 'not-configured', detail: 'key absent' };
        const started = Date.now();
        const status = await getCronjobStatus({ config, probe: true, timeoutMs });
        return { verdict: status.reachable ? 'verified' : 'failed', detail: `GET /jobs ok (${status.jobsCount} jobs)`, latencyMs: Date.now() - started };
      }
    },
    {
      id: 'cloudflare_api', label: 'Cloudflare API token', secret: 'CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID', category: 'edge',
      run: async () => {
        if (!config.cloudflare?.apiToken) return { verdict: 'not-configured', detail: 'token absent' };
        const headers = { accept: 'application/json', authorization: `Bearer ${config.cloudflare.apiToken}` };
        // User-owned tokens verify under /user; account-owned tokens only under /accounts/{id}.
        let verify = await probeJson(fetchImpl, `${config.cloudflare.baseUrl}/user/tokens/verify`, { headers }, timeoutMs);
        let owner = 'user token';
        if ((!verify.json?.success || verify.json?.result?.status !== 'active') && config.cloudflare.accountId) {
          const accountVerify = await probeJson(fetchImpl, `${config.cloudflare.baseUrl}/accounts/${encodeURIComponent(config.cloudflare.accountId)}/tokens/verify`, { headers }, timeoutMs);
          if (accountVerify.json?.success && accountVerify.json?.result?.status === 'active') { verify = accountVerify; owner = 'account token'; }
        }
        if (!verify.json?.success || verify.json?.result?.status !== 'active') {
          const errors = (verify.json?.errors || []).map((entry) => `${entry.code}:${String(entry.message || '').slice(0, 60)}`).join(', ');
          return { verdict: 'failed', detail: `token verify ${verify.status} ${verify.json?.result?.status || ''} ${errors}`.trim(), latencyMs: verify.latencyMs };
        }
        let scripts = null;
        if (config.cloudflare.accountId) {
          const list = await probeJson(fetchImpl, `${config.cloudflare.baseUrl}/accounts/${encodeURIComponent(config.cloudflare.accountId)}/workers/scripts/${encodeURIComponent(publication.workerScript || 'celia-phone-google')}`, { headers }, timeoutMs);
          scripts = list.status === 200 ? 'worker script visible to this token' : `worker script lookup ${list.status}`;
        }
        return { verdict: 'verified', detail: [`${owner} active`, scripts].filter(Boolean).join('; '), latencyMs: verify.latencyMs };
      }
    },
    {
      id: 'cloudflare_r2', label: 'Cloudflare R2 (S3 credentials)', secret: 'CLOUDFLARE_R2_ACCESS_KEY_ID + SECRET + S3_ENDPOINT', category: 'storage',
      run: async () => {
        const r2 = config.cloudflareR2 || {};
        if (!r2.accessKeyId || !r2.secretAccessKey) return { verdict: 'not-configured', detail: 'access key / secret absent' };
        if (!r2.s3Endpoint) return { verdict: 'failed', detail: r2.rawEndpointConfigured ? 'CLOUDFLARE_R2_S3_ENDPOINT malformed' : 'CLOUDFLARE_R2_S3_ENDPOINT absent' };
        const listBuckets = async (endpoint) => {
          const url = `${endpoint.replace(/\/+$/, '')}/`;
          const signed = signAwsV4({ method: 'GET', url, headers: { 'x-amz-content-sha256': EMPTY_SHA256 }, region: 'auto', service: 's3', accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey });
          const { host, ...requestHeaders } = signed.headers;
          const response = await fetchImpl(url, { method: 'GET', headers: requestHeaders, signal: withTimeout(timeoutMs) });
          return classifyS3Response(response.status, await response.text());
        };
        const started = Date.now();
        try {
          return { ...(await listBuckets(r2.s3Endpoint)), latencyMs: Date.now() - started };
        } catch (error) {
          const cause = error?.cause?.code || error?.cause?.message || error?.name || 'error';
          const configuredHost = new URL(r2.s3Endpoint).host;
          const canonical = config.cloudflare?.accountId ? `https://${config.cloudflare.accountId}.r2.cloudflarestorage.com` : null;
          let hint = '';
          if (canonical && new URL(canonical).host !== configuredHost) {
            try {
              const alt = await listBuckets(canonical);
              hint = `; canonical endpoint derived from CLOUDFLARE_ACCOUNT_ID answers (${alt.verdict}: ${alt.detail}) — fix CLOUDFLARE_R2_S3_ENDPOINT to https://<account-id>.r2.cloudflarestorage.com`;
            } catch (altError) { hint = `; canonical endpoint also unreachable (${altError?.cause?.code || altError?.name || 'error'})`; }
          }
          return { verdict: 'failed', detail: `configured endpoint host unreachable (${cause})${hint}`, latencyMs: Date.now() - started };
        }
      }
    },
    {
      id: 'google_oauth_client', label: 'Google OAuth client (Web)', secret: 'GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET', category: 'google',
      run: async () => {
        const clientId = String(env.GOOGLE_CLIENT_ID || '').trim();
        const clientSecret = String(env.GOOGLE_CLIENT_SECRET || '').trim();
        if (!clientId || !clientSecret) return { verdict: 'not-configured', detail: 'client id / secret absent' };
        const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: 'celia-reality-probe-not-a-token' });
        const response = await probeJson(fetchImpl, 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }, timeoutMs);
        return { ...classifyGoogleTokenResponse(response.status, response.json || {}), latencyMs: response.latencyMs };
      }
    },
    {
      id: 'google_workspace', label: 'Gmail / Calendar / Drive on the owner account', secret: '(needs a linked account, not a repository secret)', category: 'google',
      run: async () => ({ verdict: 'unverifiable', detail: 'no Google account is linked (no refresh token exists anywhere); the owner links once via «اربط جوجل» on the live backend — code paths are covered by offline tests only' })
    },
    {
      id: 'whatsapp_cloud_api', label: 'WhatsApp Cloud API (send/receive)', secret: 'WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID (absent)', category: 'messaging',
      run: async () => {
        const configured = Boolean(String(env.WHATSAPP_ACCESS_TOKEN || '').trim() && String(env.WHATSAPP_PHONE_NUMBER_ID || '').trim());
        if (!configured) return { verdict: 'not-configured', detail: 'no Meta access token / phone number id in the repository secrets — outbound WhatsApp cannot work until the owner creates the Meta app; webhook + commands are offline-tested only' };
        return { verdict: 'unverifiable', detail: 'sending a real message is not a synthetic probe; verify via the webhook on the live backend' };
      }
    },
    {
      id: 'owner_token_edge', label: 'Owner token on the live edge Worker', secret: 'CELIA_MCP_API_TOKEN', category: 'auth',
      run: async () => {
        const token = String(env.CELIA_MCP_API_TOKEN || '').trim();
        if (!token) return { verdict: 'not-configured', detail: 'token absent' };
        if (token.length < 32) return { verdict: 'failed', detail: 'token shorter than 32 characters' };
        if (!workerUrl) return { verdict: 'unverifiable', detail: 'no edge URL in deployment profile' };
        const anonymous = await probeJson(fetchImpl, `${workerUrl}/api/secrets/status`, {}, timeoutMs);
        const authed = await probeJson(fetchImpl, `${workerUrl}/api/secrets/status`, { headers: { authorization: `Bearer ${token}` } }, timeoutMs);
        const ok = anonymous.status === 401 && authed.status === 200 && Number.isInteger(authed.json?.configuredCount);
        return { verdict: ok ? 'verified' : 'failed', detail: ok ? `edge rejects anonymous (401) and accepts the owner token (200); ${authed.json.configuredCount}/${authed.json.totalSecretsTracked} bindings present` : `anonymous ${anonymous.status}, bearer ${authed.status}`, latencyMs: authed.latencyMs };
      }
    },
    {
      id: 'phone_number', label: 'Owner phone (E.164)', secret: 'PHONE_NUMBER', category: 'identity',
      run: async () => {
        const phone = String(env.PHONE_NUMBER || '').trim();
        if (!phone) return { verdict: 'not-configured', detail: 'absent' };
        return /^\+[1-9]\d{7,14}$/.test(phone) ? { verdict: 'verified', detail: 'valid E.164 format (format check only — no call or message is sent)' } : { verdict: 'failed', detail: 'not a valid E.164 number' };
      }
    },
    {
      id: 'worker_edge_public', label: 'Edge Worker public endpoints', secret: '(none)', category: 'hosting',
      run: async () => {
        if (!workerUrl) return { verdict: 'unverifiable', detail: 'no edge URL' };
        const ready = await probeJson(fetchImpl, `${workerUrl}/readyz`, {}, timeoutMs);
        const ok = ready.status === 200 && ready.json?.ok === true;
        return { verdict: ok ? 'verified' : 'failed', detail: ok ? `readyz 200, release ${ready.json.release?.version} @ ${String(ready.json.release?.commit || '').slice(0, 7)}` : `readyz ${ready.status}`, latencyMs: ready.latencyMs };
      }
    },
    {
      id: 'pages_static', label: 'GitHub Pages static site', secret: '(none)', category: 'hosting',
      run: async () => {
        if (!pagesUrl) return { verdict: 'unverifiable', detail: 'no Pages URL' };
        const ver = await probeJson(fetchImpl, `${pagesUrl}/version.json`, {}, timeoutMs);
        const ok = ver.status === 200 && typeof ver.json?.version === 'string';
        return { verdict: ok ? 'verified' : 'failed', detail: ok ? `version.json 200 (${ver.json.version} @ ${String(ver.json.commit || '').slice(0, 7)})` : `version.json ${ver.status}`, latencyMs: ver.latencyMs };
      }
    },
    {
      id: 'ghcr_image', label: 'Container image on GHCR (public pull)', secret: '(none)', category: 'release',
      run: async () => {
        const image = publication.containerImage;
        if (!image) return { verdict: 'unverifiable', detail: 'no image in deployment profile' };
        const [repo, tag] = image.replace(/^ghcr\.io\//, '').split(':');
        const token = await probeJson(fetchImpl, `https://ghcr.io/token?service=ghcr.io&scope=repository:${repo}:pull`, {}, timeoutMs);
        if (!token.json?.token) return { verdict: 'failed', detail: `anonymous token ${token.status}` };
        const manifest = await probeJson(fetchImpl, `https://ghcr.io/v2/${repo}/manifests/${tag}`, { headers: { authorization: `Bearer ${token.json.token}`, accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' } }, timeoutMs);
        return { verdict: manifest.status === 200 ? 'verified' : 'failed', detail: manifest.status === 200 ? `manifest ${tag} pullable anonymously` : `manifest ${manifest.status}`, latencyMs: manifest.latencyMs };
      }
    },
    {
      id: 'github_release', label: `GitHub release v${version}`, secret: '(none)', category: 'release',
      run: async () => {
        const headers = env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' } : { accept: 'application/vnd.github+json' };
        const release = await probeJson(fetchImpl, `https://api.github.com/repos/${publication.repository}/releases/tags/v${version}`, { headers }, timeoutMs);
        const assets = Array.isArray(release.json?.assets) ? release.json.assets.length : 0;
        return { verdict: release.status === 200 && assets > 0 ? 'verified' : 'failed', detail: release.status === 200 ? `${assets} assets` : `release lookup ${release.status}`, latencyMs: release.latencyMs };
      }
    },
    {
      id: 'render_backend', label: 'Full backend (Express + MySQL) on Render', secret: 'CELIA_LIVE_URL + RENDER_API_KEY/RENDER_SERVICE_ID', category: 'hosting',
      run: async () => {
        const plan = planDeployment(env);
        if (!plan.ok) return { verdict: 'not-deployed', detail: `no live instance; missing ${plan.missing.join(', ')} — deploy-render.yml activates once added` };
        const ready = await probeJson(fetchImpl, `${plan.liveUrl}/readyz`, {}, timeoutMs);
        const ok = ready.status === 200 && ready.json?.storage?.mode === 'mysql';
        return { verdict: ok ? 'verified' : 'failed', detail: ok ? 'readyz 200 with durable MySQL' : `readyz ${ready.status} mode ${ready.json?.storage?.mode || 'n/a'}`, latencyMs: ready.latencyMs };
      }
    }
  ];
}

export async function runProbes(probes, { env, timeoutMs }) {
  const results = [];
  for (const probe of probes) {
    const started = Date.now();
    try {
      const result = await Promise.race([
        probe.run(),
        new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('probe_timeout'), { code: 'ETIMEDOUT' })), timeoutMs + 5_000).unref())
      ]);
      results.push({ id: probe.id, label: probe.label, category: probe.category, secret: probe.secret, verdict: result.verdict, detail: sanitize(result.detail, env), latencyMs: result.latencyMs ?? Date.now() - started });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : null;
      const cause = error?.cause?.code ? ` [${error.cause.code}]` : '';
      results.push({ id: probe.id, label: probe.label, category: probe.category, secret: probe.secret, verdict: 'failed', detail: sanitize(`${error?.code || error?.name || 'error'}${status ? ` ${status}` : ''}${cause}: ${String(error?.message || '').slice(0, 160)}`, env), latencyMs: Date.now() - started });
    }
  }
  return results;
}

// ---------- offline + mysql ----------

export function runOfflineSuite({ cwd = root, env = process.env } = {}) {
  // TAP is forced: Node ≥ 23 defaults to the spec reporter even without a TTY, whose summary lines differ.
  const args = ['--test', '--test-reporter=tap', '--test-reporter-destination=stdout', '--experimental-test-coverage', '--test-coverage-include=src/**', '--test-coverage-include=scripts/**', '--test-coverage-include=workers/**'];
  const result = spawnSync(process.execPath, args, { cwd, env: { ...env, CELIA_SERVICE_REALITY_CHILD: '1' }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const summary = parseTestSummary(`${result.stdout}\n${result.stderr}`);
  return { ...summary, exitCode: result.status, weakest: Object.entries(summary.files).sort((a, b) => a[1].lines - b[1].lines).slice(0, 8).map(([file, cov]) => ({ file, ...cov })) };
}

export function runMysqlSuite({ cwd = root, env = process.env } = {}) {
  if (env.CELIA_MYSQL_TESTS !== 'true') return { ran: false, reason: 'CELIA_MYSQL_TESTS != true (no real MySQL in this environment)' };
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-reporter-destination=stdout', 'integration/mysql.integration.mjs'], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const summary = parseTestSummary(`${result.stdout}\n${result.stderr}`);
  return { ran: true, tests: summary.tests, pass: summary.pass, fail: summary.fail, exitCode: result.status };
}

// ---------- report ----------

const VERDICT_ICON = { verified: '✅', failed: '❌', 'not-configured': '⚪', unverifiable: '🟡', 'not-deployed': '🚫' };

export function renderMarkdown(report) {
  const lines = ['## Service reality — ما هو حقيقي فعلًا', ''];
  if (report.offline) {
    const o = report.offline;
    lines.push(`- **Offline suite:** ${o.pass}/${o.tests} pass${o.fail ? ` (**${o.fail} fail**)` : ''}${o.coverage ? ` · coverage lines ${o.coverage.lines}% · branches ${o.coverage.branches}% · functions ${o.coverage.functions}%` : ''}`);
  }
  if (report.mysql?.ran) lines.push(`- **Real MySQL suite:** ${report.mysql.pass}/${report.mysql.tests} pass${report.mysql.fail ? ` (**${report.mysql.fail} fail**)` : ''}`);
  else if (report.mysql) lines.push(`- **Real MySQL suite:** not run — ${report.mysql.reason}`);
  if (report.live) {
    const s = report.score;
    lines.push(`- **Live probes:** ${s.verified} verified · ${s.failed} failed · ${s['not-configured']} not configured · ${s.unverifiable} unverifiable · ${s['not-deployed']} not deployed → working rate of configured services **${s.workingRate === null ? 'n/a' : `${Math.round(s.workingRate * 100)}%`}** (threshold ${Math.round(report.minRate * 100)}%)`);
    lines.push('', '| | Service | Credential | Result | ms |', '|---|---|---|---|---|');
    for (const service of report.live) lines.push(`| ${VERDICT_ICON[service.verdict] || '•'} | ${service.label} | \`${service.secret}\` | **${service.verdict}** — ${service.detail} | ${service.latencyMs ?? ''} |`);
  }
  lines.push('', `Verdict: **${report.verdict}** — ${report.verdictReason}`, '', '_Synthetic read-only probes; no content, keys or tokens are logged. "verified" means the real credential performed the real operation from this runner, nothing more._', '');
  return lines.join('\n');
}

export async function main({ argv = process.argv.slice(2), env = process.env, fetchImpl = fetch } = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write('Usage: node scripts/service-reality.mjs [--skip-offline] [--skip-live] [--min-rate 0.95] [--timeout-ms 20000] [--out path]\n');
    return 0;
  }
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const profile = JSON.parse(await readFile(path.join(root, 'docs/deployment-profile.json'), 'utf8'));
  const publication = { ...profile.publication, repository: profile.repository?.replace(/^https?:\/\/github\.com\//, '') || 'celiaelazamey-arch/phone-google', workerScript: 'celia-phone-google' };
  const report = { schema: 1, generatedAt: new Date().toISOString(), commit: env.GITHUB_SHA || null, minRate: options.minRate, offline: null, mysql: null, live: null, score: null };

  if (!options.skipOffline) report.offline = runOfflineSuite({ env });
  if (!options.skipOffline) report.mysql = runMysqlSuite({ env });

  if (!options.skipLive) {
    const [{ loadCeliaMcpConfig }, { generateCeliaReply }, hub, { planDeployment }] = await Promise.all([
      import('../src/celia-mcp.js'), import('../src/ollama.js'), import('../src/secrets-hub.js'), import('./deploy-render.mjs')
    ]);
    const token = String(env.CELIA_MCP_API_TOKEN || '').trim().length >= 32 ? env.CELIA_MCP_API_TOKEN : crypto.randomBytes(32).toString('hex');
    const config = loadCeliaMcpConfig({ ...env, CELIA_MCP_API_TOKEN: token, CELIA_MCP_DISABLE_MYSQL: 'true', CELIA_DISABLE_OLLAMA: 'true', CELIA_SERVICE_TIMEOUT_MS: env.CELIA_SERVICE_TIMEOUT_MS || String(Math.min(Math.max(options.timeoutMs, 50), 60_000)) });
    const probes = buildProbes({ config, env, fetchImpl, timeoutMs: options.timeoutMs, publication, version: pkg.version, modules: { generateCeliaReply, planDeployment, ...hub } });
    report.live = await runProbes(probes, { env, timeoutMs: options.timeoutMs });
    report.score = scoreServices(report.live);
  }

  const reasons = [];
  if (report.offline && (report.offline.fail || report.offline.exitCode !== 0)) reasons.push(`offline suite failed (${report.offline.fail} failing)`);
  if (report.mysql?.ran && (report.mysql.fail || report.mysql.exitCode !== 0)) reasons.push('real MySQL suite failed');
  if (report.score && report.score.workingRate !== null && report.score.workingRate < options.minRate) reasons.push(`only ${Math.round(report.score.workingRate * 100)}% of configured services work (${report.live.filter((s) => s.verdict === 'failed').map((s) => s.id).join(', ')})`);
  report.verdict = reasons.length ? 'fail' : 'pass';
  report.verdictReason = reasons.length ? reasons.join('; ') : 'every configured service performed its real operation; unverifiable / not-deployed items are listed, not claimed';

  let serialized = JSON.stringify(report, null, 2);
  const leaked = secretValues(env).filter((value) => serialized.includes(value));
  if (leaked.length) { report.leakGuardTriggered = true; serialized = sanitize(JSON.stringify(report, null, 2), env); }
  const outPath = path.resolve(root, options.out);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${serialized}\n`, 'utf8');
  const markdown = sanitize(renderMarkdown(report), env);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${markdown}\n`, 'utf8');
  process.stdout.write(`${markdown}\n`);
  const annotation = sanitize(JSON.stringify({ verdict: report.verdict, offline: report.offline ? `${report.offline.pass}/${report.offline.tests}` : null, coverageLines: report.offline?.coverage?.lines ?? null, mysql: report.mysql?.ran ? `${report.mysql.pass}/${report.mysql.tests}` : 'not-run', live: report.score, failed: report.live?.filter((s) => s.verdict === 'failed').map((s) => s.id) || [] }), env);
  process.stdout.write(`::${report.verdict === 'pass' ? 'notice' : 'error'} title=Service Reality::${annotation}\n`);
  for (const service of report.live || []) {
    if (service.verdict === 'failed') process.stdout.write(`::warning title=Service Reality · ${service.id} failed::${sanitize(service.detail, env).replace(/\n/g, ' ')}\n`);
  }
  if (report.offline) process.stdout.write(`::notice title=Service Reality · offline::${sanitize(JSON.stringify({ tests: report.offline.tests, pass: report.offline.pass, fail: report.offline.fail, exitCode: report.offline.exitCode, coverage: report.offline.coverage, weakest: report.offline.weakest?.slice(0, 5) }), env)}\n`);
  if (report.mysql) process.stdout.write(`::notice title=Service Reality · mysql::${sanitize(JSON.stringify(report.mysql), env)}\n`);
  if (leaked.length) return 3;
  return report.verdict === 'pass' ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = await main();
}
