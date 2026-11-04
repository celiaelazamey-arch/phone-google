#!/usr/bin/env node
/**
 * GA-F0…GA-F3 live evidence for the ordinary Google account sign-in flow.
 *
 * This command proves the parts that are safe to exercise without a Google test
 * account: diagnostics, the exact 302 to Google, HTTPS/redirect/cookie/secret controls,
 * CSRF cookie rejection, a synthetic access_denied callback, and one-use state replay.
 * It never follows the Google redirect, exchanges a code, creates an account, or opens
 * a session. Real consent → /api/account/me=200, human PR review, and the first 60
 * production minutes remain explicit external gates; an automated PASS is NOT a launch.
 *
 * Reports contain no state value, cookie value, authorization code, raw Location query,
 * provider error detail, or client secret. GOOGLE_CLIENT_SECRET is optional and is used
 * only for an in-memory leak comparison against public responses.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_URL = 'https://celia-phone-google.celiaelazamey.workers.dev';
const DEFAULT_OUT = '.validation-artifacts/google-auth-live.json';
const STATE_PATTERN = /^signin:[0-9a-f]{64}$/;
const EXPECTED_SCOPES = 'openid email profile';

export const EXTERNAL_GATES = Object.freeze([
  {
    id: 'GA-F2-quality',
    owner: 'مهندس الجودة والأمن السيبراني',
    requirement: 'نجاح Celia quality & resilience وCodeQL وnpm audit على commit المنشور نفسه، بما فيه اختبارات الجلسة ومنع replay وعدم تسريب الأسرار.',
    evidence: 'روابط GitHub Actions للـcommit نفسه + تقرير فحص الأسرار؛ لا يستنتجها هذا الفاحص من استجابة HTTP.'
  },
  {
    id: 'GA-F3-consent',
    owner: 'مطور الاختبارات التلقائية / مالك حساب الاختبار',
    requirement: 'موافقة حقيقية بحساب Google مدرج في Test users تنتهي بجلسة وGET /api/account/me=200، مع فشل دخول حساب آخر وعزل بياناته.',
    evidence: 'تقرير E2E منقّح ولقطة Network بلا code/state/cookie؛ نجاح شاشة Google وحدها ليس قبولًا.'
  },
  {
    id: 'GA-F4-review',
    owner: 'قائد الفريق التقني / مالك المستودع',
    requirement: 'PR reviewed وapproved وmerged للـcommit نفسه، مع PUB-001 وسجل النشر سليمين؛ لا موافقة ذاتية ولا تجاوز ضمني.',
    evidence: 'رابط PR المدمج + head/merge SHA + سجل CI والمراجعة.'
  },
  {
    id: 'GA-F5-production',
    owner: 'مهندس العمليات DevOps',
    requirement: 'نشر معتمد ثم 60 دقيقة كاملة: attempts>0 وsuccessful=attempts وzero critical errors، مع بقاء F0/F1 وreadiness ناجحة وخطة تراجع جاهزة.',
    evidence: 'لوحة مراقبة وسجلات إنتاج منقّحة تحمل بداية/نهاية النافذة وأعداد الطلبات؛ صفر محاولات ليس 100% نجاحًا.'
  }
]);

function parseArgs(argv) {
  const options = { url: DEFAULT_URL, out: DEFAULT_OUT, timeoutMs: 20_000, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === '--url') options.url = next();
    else if (arg === '--out') options.out = next();
    else if (arg === '--timeout-ms') options.timeoutMs = Number(next());
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 120_000) {
    throw new Error('--timeout-ms must be between 100 and 120000');
  }
  return options;
}

function protocolOf(value) {
  try { return new URL(String(value || '')).protocol; } catch { return null; }
}

function reasonOf(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  if (error?.cause?.code === 'ECONNRESET' || error?.code === 'ECONNRESET') return 'connection_reset';
  return 'request_failed';
}

function cookieFromHeader(header, expectedName) {
  const pair = String(header || '').split(';', 1)[0];
  const separator = pair.indexOf('=');
  if (separator < 1 || pair.slice(0, separator) !== expectedName) return null;
  return {
    pair,
    httpOnly: /;\s*HttpOnly(?:;|$)/i.test(header),
    secure: /;\s*Secure(?:;|$)/i.test(header),
    sameSiteLax: /;\s*SameSite=Lax(?:;|$)/i.test(header),
    path: /;\s*Path=\/auth\/google(?:;|$)/i.test(header),
    maxAge600: /;\s*Max-Age=600(?:;|$)/i.test(header)
  };
}

function secretFindings(texts, knownSecret) {
  const combined = texts.join('\n');
  return {
    knownSecretCompared: Boolean(knownSecret),
    knownSecretExposed: Boolean(knownSecret && combined.includes(knownSecret)),
    googleSecretShapeExposed: /GOCSPX-[A-Za-z0-9_-]{8,}/.test(combined),
    googleApiKeyShapeExposed: /AIza[0-9A-Za-z_-]{20,}/.test(combined)
  };
}

/** Execute only the externally safe gates. `launch.ready` deliberately stays false. */
export async function verifyGoogleAuthLive({
  url = DEFAULT_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
  knownSecret = '',
  clock = () => new Date()
} = {}) {
  const checks = [];
  const publicTexts = [];
  let parsed = null;
  const add = (id, title, status, detail = {}) => {
    checks.push({ id, title, status, detail });
    return status === 'pass';
  };
  const finish = () => {
    const totals = {
      pass: checks.filter((check) => check.status === 'pass').length,
      fail: checks.filter((check) => check.status === 'fail').length,
      skipped: checks.filter((check) => check.status === 'skipped').length
    };
    return {
      kind: 'celia-google-auth-launch-evidence',
      schema: 1,
      capturedAt: clock().toISOString(),
      target: parsed ? { origin: parsed.origin, host: parsed.host, protocol: parsed.protocol.replace(':', '') } : null,
      scope: ['GA-F0', 'GA-F1', 'GA-F2-live-controls', 'GA-F3-denial-and-replay'],
      verdict: totals.fail === 0 && totals.pass > 0 ? 'pass' : 'fail',
      totals,
      checks,
      launch: {
        ready: false,
        status: 'blocked_pending_external_gates',
        pending: EXTERNAL_GATES.map((gate) => gate.id)
      },
      externalGates: EXTERNAL_GATES,
      note: 'PASS يخص الفحوص الآمنة المذكورة فقط؛ لا يعني موافقة مستخدم حقيقية أو مراجعة PR أو جاهزية إطلاق عام.'
    };
  };

  try {
    parsed = new URL(String(url || ''));
  } catch {
    add('GA-F2-https', 'عنوان الهدف صالح وبلا بيانات اعتماد', 'fail', { reason: 'invalid_url' });
    return finish();
  }
  if (parsed.username || parsed.password) {
    add('GA-F2-https', 'عنوان الهدف صالح وبلا بيانات اعتماد', 'fail', { reason: 'credentials_in_url' });
    return finish();
  }
  if (parsed.protocol !== 'https:') {
    add('GA-F2-https', 'كل مسارات OAuth تلزم HTTPS', 'fail', { reason: 'https_required', protocol: parsed.protocol });
    return finish();
  }
  const base = parsed.origin;
  const request = async (route, init = {}) => {
    const response = await fetchImpl(`${base}${route}`, {
      ...init,
      headers: { accept: 'application/json, text/html;q=0.9, text/plain;q=0.8', ...(init.headers || {}) },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* HTML and empty 302 responses are expected. */ }
    return { response, text, body };
  };

  let diagnostics = null;
  try {
    const result = await request('/auth/google/diagnostics');
    diagnostics = result.body;
    publicTexts.push(result.text);
    const accepted = result.response.status === 200
      && diagnostics?.ok === true
      && diagnostics?.google?.accepted === true
      && diagnostics?.google?.reason === null
      && diagnostics?.secretExposed === false
      && /(?:^|,)\s*no-store(?:,|$)/i.test(result.response.headers.get('cache-control') || '');
    add('GA-F0', 'WA-010 يثبت قبول Google بلا redirect_uri_mismatch وبلا كاش', accepted ? 'pass' : 'fail', {
      httpStatus: result.response.status,
      accepted: diagnostics?.google?.accepted ?? null,
      reason: diagnostics?.google?.reason ?? null,
      noStore: /no-store/i.test(result.response.headers.get('cache-control') || ''),
      secretExposed: diagnostics?.secretExposed ?? null,
      failureReason: accepted ? null : 'diagnostics_not_accepted'
    });
  } catch (error) {
    add('GA-F0', 'WA-010 يثبت قبول Google بلا redirect_uri_mismatch وبلا كاش', 'fail', { reason: reasonOf(error) });
  }

  let authUrl = null;
  let oauthState = null;
  let stateCookie = null;
  let signinStatus = null;
  let signinFailureReason;
  try {
    const result = await request('/auth/google/signin', { headers: { accept: 'text/html' } });
    signinStatus = result.response.status;
    publicTexts.push(result.text);
    const location = result.response.headers.get('location') || '';
    publicTexts.push(location);
    try { authUrl = location ? new URL(location, base) : null; } catch { authUrl = null; }
    oauthState = authUrl?.searchParams.get('state') || null;
    stateCookie = cookieFromHeader(result.response.headers.get('set-cookie'), 'celia_oauth_state');
    const params = authUrl?.searchParams;
    const valid = signinStatus === 302
      && authUrl?.protocol === 'https:'
      && authUrl?.hostname === 'accounts.google.com'
      && authUrl?.pathname === '/o/oauth2/v2/auth'
      && authUrl?.username === ''
      && authUrl?.password === ''
      && params?.get('response_type') === 'code'
      && params?.get('scope') === EXPECTED_SCOPES
      && params?.get('prompt') === 'select_account'
      && params?.get('access_type') === null
      && params?.has('client_secret') === false
      && STATE_PATTERN.test(oauthState || '')
      && Boolean(diagnostics?.clientId)
      && params?.get('client_id') === diagnostics?.clientId
      && params?.get('redirect_uri') === diagnostics?.redirectUri;
    signinFailureReason = valid ? null : signinStatus === 200 ? 'local_html_is_not_google_redirect' : 'invalid_google_redirect_contract';
    add('GA-F1', '/auth/google/signin يعيد 302 إلى مسار Google المصرح بعقد OAuth الصحيح', valid ? 'pass' : 'fail', {
      httpStatus: signinStatus,
      authorizationEndpoint: authUrl ? { origin: authUrl.origin, pathname: authUrl.pathname } : null,
      responseType: params?.get('response_type') ?? null,
      scope: params?.get('scope') ?? null,
      prompt: params?.get('prompt') ?? null,
      accessType: params?.get('access_type') ?? null,
      stateShapeValid: STATE_PATTERN.test(oauthState || ''),
      clientIdMatches: Boolean(diagnostics?.clientId) && params?.get('client_id') === diagnostics?.clientId,
      clientSecretParameterPresent: params?.has('client_secret') ?? null,
      reason: signinFailureReason
    });

    const expectedRedirect = `${base}/auth/google/callback`;
    const redirectValid = diagnostics?.redirectUri === expectedRedirect
      && protocolOf(diagnostics.redirectUri) === 'https:'
      && params?.get('redirect_uri') === expectedRedirect
      && diagnostics?.google?.accepted === true;
    add('GA-F2-redirect', 'Redirect URI حرفي ومتطابق في التشخيص والتحويل ومسجل لدى Google', redirectValid ? 'pass' : 'fail', {
      expectedRedirectUri: expectedRedirect,
      diagnosticsRedirectUri: diagnostics?.redirectUri ?? null,
      signinRedirectUri: params?.get('redirect_uri') ?? null,
      acceptedByGoogle: diagnostics?.google?.accepted ?? null,
      reason: redirectValid ? null : 'redirect_uri_not_exactly_matched'
    });

    const httpsValid = authUrl?.protocol === 'https:' && protocolOf(diagnostics?.redirectUri) === 'https:';
    add('GA-F2-https', 'الهدف وRedirect URI ونقطة تفويض Google كلها HTTPS', httpsValid ? 'pass' : 'fail', {
      targetProtocol: parsed.protocol,
      redirectProtocol: protocolOf(diagnostics?.redirectUri),
      authorizationProtocol: authUrl?.protocol ?? null
    });

    const cookieValid = stateCookie?.httpOnly === true
      && stateCookie?.secure === true
      && stateCookie?.sameSiteLax === true
      && stateCookie?.path === true
      && stateCookie?.maxAge600 === true;
    add('GA-F2-cookie', 'كوكي حالة OAuth هو HttpOnly+Secure+SameSite=Lax ومهلته 600 ثانية', cookieValid ? 'pass' : 'fail', {
      present: Boolean(stateCookie),
      httpOnly: stateCookie?.httpOnly ?? false,
      secure: stateCookie?.secure ?? false,
      sameSiteLax: stateCookie?.sameSiteLax ?? false,
      expectedPath: stateCookie?.path ?? false,
      maxAge600: stateCookie?.maxAge600 ?? false,
      valueRecorded: false
    });
  } catch (error) {
    add('GA-F1', '/auth/google/signin يعيد 302 إلى مسار Google المصرح بعقد OAuth الصحيح', 'fail', { reason: reasonOf(error) });
    for (const [id, title] of [
      ['GA-F2-redirect', 'Redirect URI حرفي ومتطابق ومسجل لدى Google'],
      ['GA-F2-https', 'كل مسارات OAuth تلزم HTTPS'],
      ['GA-F2-cookie', 'كوكي حالة OAuth آمن']
    ]) add(id, title, 'fail', { reason: 'signin_evidence_unavailable' });
  }

  let assetReadOk = true;
  for (const route of ['/whatsapp', '/whatsapp.js']) {
    try {
      const result = await request(route, { headers: { accept: route.endsWith('.js') ? 'text/javascript' : 'text/html' } });
      publicTexts.push(result.text);
      if (result.response.status !== 200) assetReadOk = false;
    } catch {
      assetReadOk = false;
    }
  }
  const leaks = secretFindings(publicTexts, String(knownSecret || '').trim());
  const secretsValid = assetReadOk
    && diagnostics?.secretExposed === false
    && authUrl?.searchParams?.has('client_secret') !== true
    && !leaks.knownSecretExposed
    && !leaks.googleSecretShapeExposed
    && !leaks.googleApiKeyShapeExposed;
  add('GA-F2-secrets', 'الردود العامة وحزمة JavaScript بلا Client Secret أو مفتاح API مكشوف', secretsValid ? 'pass' : 'fail', {
    assetsRead: assetReadOk,
    surfaces: ['diagnostics', 'signin', 'whatsapp.html', 'whatsapp.js'],
    ...leaks,
    reason: secretsValid ? null : 'public_secret_or_asset_check_failed'
  });

  const statefulReady = STATE_PATTERN.test(oauthState || '') && Boolean(stateCookie?.pair);
  const deniedPath = statefulReady
    ? `/auth/google/callback?error=access_denied&state=${encodeURIComponent(oauthState)}`
    : null;
  if (!statefulReady) {
    for (const [id, title] of [
      ['GA-F2-csrf', 'Callback يرفض كوكي state غير المطابق قبل استهلاكها'],
      ['GA-F3-denial', 'رفض الموافقة يعود برسالة عربية آمنة وبلا جلسة'],
      ['GA-F2-replay', 'إعادة callback مرفوضة لأن state أحادية الاستخدام']
    ]) add(id, title, 'skipped', { reason: 'valid_signin_state_unavailable' });
  } else {
    try {
      const mismatch = await request(deniedPath, { headers: { cookie: `celia_oauth_state=${encodeURIComponent('signin:wrong')}` } });
      const valid = mismatch.response.status === 400 && mismatch.body?.error === 'oauth_state_cookie_mismatch';
      add('GA-F2-csrf', 'Callback يرفض كوكي state غير المطابق قبل استهلاكها', valid ? 'pass' : 'fail', {
        httpStatus: mismatch.response.status,
        error: mismatch.body?.error ?? null,
        stateValueRecorded: false
      });
    } catch (error) {
      add('GA-F2-csrf', 'Callback يرفض كوكي state غير المطابق قبل استهلاكها', 'fail', { reason: reasonOf(error) });
    }

    try {
      const denied = await request(deniedPath, { headers: { cookie: stateCookie.pair } });
      const setCookie = denied.response.headers.get('set-cookie') || '';
      const valid = denied.response.status === 302
        && denied.response.headers.get('location') === '/whatsapp?google_error=google_access_denied'
        && /celia_oauth_state=;/.test(setCookie)
        && /Max-Age=0/.test(setCookie)
        && /HttpOnly/.test(setCookie)
        && /Secure/.test(setCookie)
        && !setCookie.includes('__Host-celia_wa=');
      add('GA-F3-denial', 'رفض الموافقة يعود برسالة عربية آمنة ويمسح state بلا جلسة', valid ? 'pass' : 'fail', {
        httpStatus: denied.response.status,
        location: denied.response.headers.get('location') || null,
        stateCookieCleared: /celia_oauth_state=;/.test(setCookie) && /Max-Age=0/.test(setCookie),
        accountSessionCreated: setCookie.includes('__Host-celia_wa='),
        providerDetailRecorded: false,
        reason: valid ? null : 'denial_not_handled_gracefully'
      });
    } catch (error) {
      add('GA-F3-denial', 'رفض الموافقة يعود برسالة عربية آمنة ويمسح state بلا جلسة', 'fail', { reason: reasonOf(error) });
    }

    try {
      const replay = await request(deniedPath, { headers: { cookie: stateCookie.pair } });
      const valid = replay.response.status === 400 && replay.body?.error === 'invalid_or_expired_oauth_state';
      add('GA-F2-replay', 'إعادة callback مرفوضة لأن state أحادية الاستخدام', valid ? 'pass' : 'fail', {
        httpStatus: replay.response.status,
        error: replay.body?.error ?? null,
        stateValueRecorded: false
      });
    } catch (error) {
      add('GA-F2-replay', 'إعادة callback مرفوضة لأن state أحادية الاستخدام', 'fail', { reason: reasonOf(error) });
    }
  }

  return finish();
}

export async function runCli(argv = process.argv.slice(2), {
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  fetchImpl = globalThis.fetch,
  clock = () => new Date()
} = {}) {
  let options;
  try { options = parseArgs(argv); } catch (error) {
    stderr.write(`${error.message}\nUsage: npm run verify:google-auth -- --url https://host [--out report.json] [--timeout-ms 20000]\n`);
    return 2;
  }
  if (options.help) {
    stdout.write('Usage: npm run verify:google-auth -- --url https://host [--out report.json] [--timeout-ms 20000]\n');
    return 0;
  }
  const report = await verifyGoogleAuthLive({
    url: options.url,
    fetchImpl,
    timeoutMs: options.timeoutMs,
    knownSecret: env.GOOGLE_CLIENT_SECRET || '',
    clock
  });
  const output = path.resolve(root, options.out);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  for (const check of report.checks) {
    if (check.status === 'fail' && env.GITHUB_ACTIONS === 'true') {
      stdout.write(`::error title=verify-google-auth ${check.id}::${check.id} failed\n`);
    }
    if (check.status === 'skipped' && env.GITHUB_ACTIONS === 'true') {
      stdout.write(`::warning title=verify-google-auth ${check.id}::${check.id} not run\n`);
    }
  }
  const summary = `${report.verdict.toUpperCase()} — ${report.totals.pass} pass, ${report.totals.fail} fail, ${report.totals.skipped} skipped; launch remains blocked pending ${report.launch.pending.join(', ')}`;
  (report.verdict === 'pass' ? stdout : stderr).write(`${summary}\nEvidence: ${options.out}\n`);
  return report.verdict === 'pass' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = await runCli(); } catch {
    process.stderr.write('verify-google-auth failed without writing sensitive details\n');
    process.exitCode = 1;
  }
}
