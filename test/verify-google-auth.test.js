import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EXTERNAL_GATES, runCli, verifyGoogleAuthLive } from '../scripts/verify-google-auth.mjs';

const ORIGIN = 'https://celia.example.workers.dev';
const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const REDIRECT_URI = `${ORIGIN}/auth/google/callback`;
const STATE = `signin:${'a'.repeat(64)}`;
const SECRET = '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ever-be-reported';
const COOKIE = `celia_oauth_state=${encodeURIComponent(STATE)}; Max-Age=600; Path=/auth/google; HttpOnly; Secure; SameSite=Lax`;
const FIXED_CLOCK = () => new Date('2026-11-03T21:00:00.000Z');

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function fixture({
  accepted = true,
  localSetupPage = false,
  maliciousRedirect = false,
  insecureCookie = false,
  legacyDenial = false,
  leakInBundle = false,
  malformedDiagnosticsUri = false
} = {}) {
  const calls = [];
  let consumed = false;
  const authUrl = new URL(maliciousRedirect ? 'https://evil.example/o/oauth2/v2/auth' : 'https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('state', STATE);
  authUrl.searchParams.set('prompt', 'select_account');
  if (maliciousRedirect) authUrl.searchParams.set('client_secret', SECRET);

  const fetchImpl = async (input, init = {}) => {
    const target = new URL(input);
    const route = target.pathname;
    calls.push({ route, search: target.search, init });
    if (route === '/auth/google/diagnostics') {
      return json({
        ok: accepted,
        clientId: CLIENT_ID,
        redirectUri: malformedDiagnosticsUri ? 'https://' : REDIRECT_URI,
        redirectUriProblem: 'derived_from_request_origin',
        google: { accepted, reason: accepted ? null : 'redirect_uri_mismatch' },
        nextStep: accepted ? null : 'register_redirect_uri_in_google_console',
        instructions: [],
        secretExposed: false
      }, 200, { 'cache-control': 'no-store' });
    }
    if (route === '/auth/google/signin') {
      if (localSetupPage) return new Response('<html lang="ar">إعداد مطلوب redirect_uri_mismatch</html>', { status: 200 });
      const cookie = insecureCookie
        ? `celia_oauth_state=${encodeURIComponent(STATE)}; Max-Age=600; Path=/auth/google; SameSite=Lax`
        : COOKIE;
      return new Response(null, { status: 302, headers: { location: authUrl.toString(), 'set-cookie': cookie } });
    }
    if (route === '/whatsapp') return new Response('<html lang="ar" dir="rtl"><button id="google-signin"></button></html>', { status: 200 });
    if (route === '/whatsapp.js') {
      return new Response(`window.location.assign('/auth/google/signin');${leakInBundle ? `/* ${SECRET} */` : ''}`, { status: 200 });
    }
    if (route === '/auth/google/callback') {
      assert.equal(target.searchParams.get('error'), 'access_denied');
      assert.equal(target.searchParams.get('state'), STATE);
      const cookie = init.headers?.cookie || '';
      if (cookie.includes('signin%3Awrong')) return json({ error: 'oauth_state_cookie_mismatch' }, 400);
      if (legacyDenial) return json({ error: 'missing_oauth_code_or_state' }, 400);
      assert.equal(cookie, COOKIE.split(';')[0], 'only the exact state cookie pair is sent back');
      if (consumed) return json({ error: 'invalid_or_expired_oauth_state' }, 400);
      consumed = true;
      return new Response(null, {
        status: 302,
        headers: {
          location: '/whatsapp?google_error=google_access_denied',
          'set-cookie': 'celia_oauth_state=; Max-Age=0; Path=/auth/google; HttpOnly; Secure; SameSite=Lax'
        }
      });
    }
    throw new Error(`unexpected route: ${route}`);
  };
  return { calls, fetchImpl };
}

const byId = (report) => Object.fromEntries(report.checks.map((check) => [check.id, check]));

test('GA-F0/F1/F2 live evidence passes a strict safe flow and records no OAuth secrets', async () => {
  const f = fixture();
  const report = await verifyGoogleAuthLive({ url: `${ORIGIN}/ignored?token=not-replayed`, fetchImpl: f.fetchImpl, knownSecret: SECRET, clock: FIXED_CLOCK });
  assert.equal(report.verdict, 'pass', JSON.stringify(report.checks.filter((check) => check.status !== 'pass')));
  assert.equal(report.totals.pass, 9);
  assert.equal(report.totals.fail, 0);
  assert.equal(report.totals.skipped, 0);
  assert.equal(report.target.origin, ORIGIN, 'only the origin is recorded, never the input query');
  assert.equal(report.capturedAt, '2026-11-03T21:00:00.000Z');
  assert.equal(report.launch.ready, false);
  assert.equal(report.launch.status, 'blocked_pending_external_gates');
  assert.deepEqual(report.launch.pending, EXTERNAL_GATES.map((gate) => gate.id));
  assert.equal(byId(report)['GA-F2-secrets'].detail.knownSecretCompared, true);
  assert.equal(byId(report)['GA-F3-denial'].detail.accountSessionCreated, false);
  assert.equal(f.calls.filter((call) => call.route === '/auth/google/callback').length, 3, 'wrong cookie, denial, replay');
  assert.ok(f.calls.every((call) => call.init.redirect === 'manual'), 'the verifier never follows Google or consumes a real consent');
  assert.ok(f.calls.every((call) => !call.route.includes('token') && !call.route.includes('userinfo')));
  const raw = JSON.stringify(report);
  for (const forbidden of [STATE, SECRET, 'not-replayed', COOKIE, 'access_denied&state']) {
    assert.equal(raw.includes(forbidden), false, `report leaked sensitive material: ${forbidden.slice(0, 24)}`);
  }
});

test('GA-F0/GA-F1 fail closed when Google refuses and a local HTML 200 is never called success', async () => {
  const report = await verifyGoogleAuthLive({ url: ORIGIN, fetchImpl: fixture({ accepted: false, localSetupPage: true }).fetchImpl, clock: FIXED_CLOCK });
  const checks = byId(report);
  assert.equal(report.verdict, 'fail');
  assert.equal(checks['GA-F0'].status, 'fail');
  assert.equal(checks['GA-F0'].detail.reason, 'redirect_uri_mismatch');
  assert.equal(checks['GA-F1'].status, 'fail');
  assert.equal(checks['GA-F1'].detail.reason, 'local_html_is_not_google_redirect');
  assert.equal(checks['GA-F1'].detail.httpStatus, 200);
  assert.equal(checks['GA-F2-secrets'].status, 'pass', 'the independent secret scan does not invent a leak just because sign-in failed');
  assert.equal(checks['GA-F3-denial'].status, 'skipped');
  assert.notEqual(checks['GA-F3-denial'].status, 'pass');
});

test('GA-F1/GA-F2 reject a look-alike host, a client_secret query, and insecure state cookies', async () => {
  const malicious = await verifyGoogleAuthLive({ url: ORIGIN, fetchImpl: fixture({ maliciousRedirect: true }).fetchImpl, knownSecret: SECRET, clock: FIXED_CLOCK });
  assert.equal(malicious.verdict, 'fail');
  assert.equal(byId(malicious)['GA-F1'].status, 'fail');
  assert.equal(byId(malicious)['GA-F2-secrets'].status, 'fail');
  assert.equal(JSON.stringify(malicious).includes(SECRET), false);

  const insecure = await verifyGoogleAuthLive({ url: ORIGIN, fetchImpl: fixture({ insecureCookie: true }).fetchImpl, clock: FIXED_CLOCK });
  assert.equal(insecure.verdict, 'fail');
  assert.equal(byId(insecure)['GA-F1'].status, 'pass');
  assert.equal(byId(insecure)['GA-F2-cookie'].status, 'fail');
  assert.equal(byId(insecure)['GA-F2-cookie'].detail.secure, false);
  assert.equal(byId(insecure)['GA-F2-cookie'].detail.httpOnly, false);
});

test('GA-F3 old JSON denial behavior and replay are release blockers, not graceful handling', async () => {
  const report = await verifyGoogleAuthLive({ url: ORIGIN, fetchImpl: fixture({ legacyDenial: true }).fetchImpl, clock: FIXED_CLOCK });
  assert.equal(report.verdict, 'fail');
  assert.equal(byId(report)['GA-F0'].status, 'pass');
  assert.equal(byId(report)['GA-F1'].status, 'pass');
  assert.equal(byId(report)['GA-F3-denial'].status, 'fail');
  assert.equal(byId(report)['GA-F3-denial'].detail.httpStatus, 400);
  assert.equal(byId(report)['GA-F2-replay'].status, 'fail');
});

test('GA-F2 secrets detects a real bundle leak without copying its value into evidence', async () => {
  const report = await verifyGoogleAuthLive({ url: ORIGIN, fetchImpl: fixture({ leakInBundle: true }).fetchImpl, clock: FIXED_CLOCK });
  const check = byId(report)['GA-F2-secrets'];
  assert.equal(check.status, 'fail');
  assert.equal(check.detail.googleSecretShapeExposed, true);
  assert.equal(report.verdict, 'fail');
  assert.equal(JSON.stringify(report).includes(SECRET), false);
});

test('GA-F2 HTTPS and malformed redirect validation fail before any insecure request', async () => {
  const f = fixture();
  const insecure = await verifyGoogleAuthLive({ url: 'http://celia.example.workers.dev', fetchImpl: f.fetchImpl, clock: FIXED_CLOCK });
  assert.equal(insecure.verdict, 'fail');
  assert.equal(insecure.checks[0].detail.reason, 'https_required');
  assert.equal(f.calls.length, 0);

  const credentials = await verifyGoogleAuthLive({ url: 'https://user:pass@celia.example.workers.dev', fetchImpl: f.fetchImpl, clock: FIXED_CLOCK });
  assert.equal(credentials.checks[0].detail.reason, 'credentials_in_url');
  assert.equal(JSON.stringify(credentials).includes('user:pass'), false);
  assert.equal(f.calls.length, 0);

  const invalid = await verifyGoogleAuthLive({ url: 'not a url', fetchImpl: f.fetchImpl, clock: FIXED_CLOCK });
  assert.equal(invalid.checks[0].detail.reason, 'invalid_url');
  assert.equal(invalid.target, null);

  const malformed = await verifyGoogleAuthLive({ url: ORIGIN, fetchImpl: fixture({ malformedDiagnosticsUri: true }).fetchImpl, clock: FIXED_CLOCK });
  assert.equal(malformed.verdict, 'fail');
  assert.equal(byId(malformed)['GA-F2-redirect'].status, 'fail');
  assert.equal(byId(malformed)['GA-F2-https'].status, 'fail');
});

test('network failures become named sanitized failures, never stack traces or false passes', async () => {
  const failure = Object.assign(new Error('socket secret details must not be printed'), { cause: { code: 'ECONNRESET' } });
  const report = await verifyGoogleAuthLive({ url: ORIGIN, fetchImpl: async () => { throw failure; }, clock: FIXED_CLOCK });
  assert.equal(report.verdict, 'fail');
  assert.equal(byId(report)['GA-F0'].detail.reason, 'connection_reset');
  const raw = JSON.stringify(report);
  assert.equal(raw.includes('socket secret details'), false);
  assert.equal(raw.includes('    at '), false);
});

test('GA-F0…F3 are wired into the deployment evidence before known_good promotion', async () => {
  const [workflow, manifest] = await Promise.all([
    readFile(new URL('../.github/workflows/cloudflare-deploy.yml', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8')
  ]);
  const pkg = JSON.parse(manifest);
  assert.match(pkg.scripts['verify:google-auth'], /scripts\/verify-google-auth\.mjs/);
  assert.match(workflow, /Verify live Google OAuth start \+ security blockers/);
  assert.match(workflow, /GOOGLE_CLIENT_SECRET: \$\{\{ secrets\.GOOGLE_CLIENT_SECRET \}\}/);
  assert.match(workflow, /\.validation-artifacts\/google-auth-live\.json/);
  assert.ok(
    workflow.indexOf('scripts/verify-google-auth.mjs') < workflow.indexOf('Promote deployment slice to known_good'),
    'Google acceptance must run before the deployment can become known_good'
  );
});

test('verify:google-auth CLI writes token-free evidence and returns strict exit codes', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'celia-google-auth-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const out = path.join(directory, 'google.json');
  const output = { stdout: '', stderr: '' };
  const streams = { stdout: { write: (text) => { output.stdout += text; } }, stderr: { write: (text) => { output.stderr += text; } } };
  const code = await runCli(['--url', ORIGIN, '--out', out], {
    env: { GOOGLE_CLIENT_SECRET: SECRET, GITHUB_ACTIONS: 'true' },
    fetchImpl: fixture().fetchImpl,
    clock: FIXED_CLOCK,
    ...streams
  });
  assert.equal(code, 0, output.stderr);
  const written = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(written.kind, 'celia-google-auth-launch-evidence');
  assert.equal(written.verdict, 'pass');
  assert.match(output.stdout, /PASS — 9 pass, 0 fail, 0 skipped/);
  assert.match(output.stdout, /launch remains blocked/);
  assert.equal(output.stdout.includes('::error'), false);
  for (const raw of [output.stdout, output.stderr, JSON.stringify(written)]) {
    assert.equal(raw.includes(STATE), false);
    assert.equal(raw.includes(SECRET), false);
  }

  const failedOutput = { stdout: '', stderr: '' };
  const failedCode = await runCli(['--url', ORIGIN, '--out', out], {
    env: { GITHUB_ACTIONS: 'true' },
    fetchImpl: fixture({ legacyDenial: true }).fetchImpl,
    clock: FIXED_CLOCK,
    stdout: { write: (text) => { failedOutput.stdout += text; } },
    stderr: { write: (text) => { failedOutput.stderr += text; } }
  });
  assert.equal(failedCode, 1);
  assert.match(failedOutput.stdout, /::error title=verify-google-auth GA-F3-denial::/);

  const usage = await runCli(['--bogus'], { env: {}, ...streams });
  assert.equal(usage, 2);
  assert.match(output.stderr, /Unknown argument: --bogus/);
  const help = await runCli(['--help'], { env: {}, ...streams });
  assert.equal(help, 0);
  assert.match(output.stdout, /Usage: npm run verify:google-auth/);
});
