import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import worker from '../workers/celia-edge/worker.js';
import { loadAllMigrationsSql, splitSqlStatements } from '../scripts/deploy-cloudflare-edge.mjs';

const ORIGIN = 'https://celia.example.workers.dev';
const CLIENT_ID = 'test-google-client.apps.googleusercontent.com';
const CLIENT_SECRET = 'test-google-client-secret';
const SUB = '117842319988776655443';
const EMAIL = 'business.owner@example.com';
const OWNER = 'owner-token-'.padEnd(48, 'x');

async function fixture({
  ownerEmail = '',
  profile = { sub: SUB, email: EMAIL, email_verified: true },
  tokenStatus = 200,
  infoStatus = 200,
  googleProbeMismatch = false
} = {}) {
  const sqlite = new DatabaseSync(':memory:');
  for (const sql of splitSqlStatements(await loadAllMigrationsSql())) sqlite.exec(sql);
  const DB = {
    prepare(sql) {
      let args = [];
      return {
        bind(...v) { args = v; return this; },
        async run() { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
        async first() { return sqlite.prepare(sql).get(...args) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; }
      };
    }
  };
  const env = {
    DB,
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    CELIA_MCP_API_TOKEN: OWNER,
    TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    ...(ownerEmail ? { APP_OWNER_EMAIL: ownerEmail } : {})
  };
  const calls = [];
  env.__FETCH_IMPL = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
      return tokenStatus === 200 ? json({ access_token: 'transient-google-access-token', expires_in: 3600 }) : json({ error: 'bad_code' }, tokenStatus);
    }
    if (url.hostname === 'openidconnect.googleapis.com' && url.pathname === '/v1/userinfo') {
      return infoStatus === 200 ? json(profile) : json({}, infoStatus);
    }
    // WA-009: the read-only authorize probe (no D1 state, no session) decides whether
    // Google would accept the redirect URI before the user is sent there.
    if (url.hostname === 'accounts.google.com' && url.pathname === '/o/oauth2/v2/auth') {
      return new Response(googleProbeMismatch ? 'Error 400: redirect_uri_mismatch' : '<html>Sign in with Google</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' }
      });
    }
    throw new Error(`unexpected_fetch:${url.href}`);
  };
  const call = (path, { method = 'GET', cookie, body, headers = {} } = {}) => worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body ? { 'content-type': 'application/json', origin: ORIGIN, 'x-celia-request': 'whatsapp' } : {}),
        ...headers
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    }),
    env,
    { waitUntil() {} }
  );
  const cookiesOf = (response) => (typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean));
  return { env, sqlite, calls, call, cookiesOf };
}

// The WA-009 authorize probe is a read-only preflight, not a token/identity exchange.
const googleApiCalls = (f) => f.calls.filter((c) => c.url.pathname !== '/o/oauth2/v2/auth');

async function startSignIn(f) {
  const response = await f.call('/auth/google/signin');
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('location'));
  const state = location.searchParams.get('state');
  const setCookie = response.headers.get('set-cookie');
  return { response, location, state, setCookie, cookie: setCookie.split(';')[0] };
}

async function callback(f, { state, cookie }) {
  return f.call(`/auth/google/callback?code=google-auth-code&state=${encodeURIComponent(state)}`, { cookie });
}

function accountCookie(f, response) {
  const value = f.cookiesOf(response).find((entry) => entry.startsWith('__Host-celia_wa='));
  assert.ok(value, 'the callback must open a Celia account session');
  return value.split(';')[0];
}

test('WA-008 the Google sign-in route asks only for identity scopes on the registered redirect URI', async () => {
  const f = await fixture();
  const { location, state, setCookie } = await startSignIn(f);
  assert.equal(location.hostname, 'accounts.google.com');
  assert.equal(location.pathname, '/o/oauth2/v2/auth');
  assert.equal(location.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(location.searchParams.get('redirect_uri'), `${ORIGIN}/auth/google/callback`);
  assert.equal(location.searchParams.get('response_type'), 'code');
  assert.equal(location.searchParams.get('scope'), 'openid email profile');
  assert.equal(location.searchParams.get('prompt'), 'select_account');
  assert.match(state, /^signin:[0-9a-f]{64}$/);
  assert.equal(location.searchParams.get('access_type'), null, 'no offline access is requested');
  assert.ok(!location.searchParams.get('scope').includes('gmail'), 'no Workspace scope is shown to a business user');
  assert.match(setCookie, /^celia_oauth_state=/);
  assert.match(setCookie, /HttpOnly; Secure; SameSite=Lax/);
  assert.match(setCookie, /Path=\/auth\/google/);
  assert.equal((await f.call('/auth/google/signin', { method: 'POST' })).status, 405);
  // The owner-only browser flow keeps requiring its Bearer token / signed ticket.
  assert.equal((await f.call('/auth/google')).status, 401);
});

test('WA-008 a verified Google identity opens a real account session without storing provider tokens', async () => {
  const f = await fixture();
  const started = await startSignIn(f);
  const response = await callback(f, started);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/whatsapp');
  const cookies = f.cookiesOf(response);
  assert.equal(cookies.length, 2, 'session cookie + cleared one-use state cookie');
  assert.ok(cookies.some((entry) => entry.startsWith('celia_oauth_state=;') && entry.includes('Max-Age=0')));
  const sessionSetCookie = cookies.find((entry) => entry.startsWith('__Host-celia_wa='));
  assert.match(sessionSetCookie, /Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax/, 'GA-F2: the account session is Secure, HttpOnly and SameSite');
  const session = accountCookie(f, response);

  const me = await f.call('/api/account/me', { cookie: session });
  assert.equal(me.status, 200);
  const user = await me.json();
  assert.equal(user.user.email, EMAIL);
  assert.match(user.user.id, /^user_[0-9a-f]{32}$/);

  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM app_accounts').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM account_google_identities').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT user_id FROM account_google_identities WHERE google_sub = ?').get(SUB).user_id, user.user.id);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM google_credentials').get().n, 0, 'no Google token is persisted');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM app_users').get().n, 0, 'the owner Workspace tables stay untouched');
  assert.equal(googleApiCalls(f).length, 2, 'exactly token exchange + userinfo');
  assert.equal(googleApiCalls(f)[0].url.pathname, '/token');
  assert.equal(googleApiCalls(f)[1].url.pathname, '/v1/userinfo');
  assert.ok(!String(googleApiCalls(f)[0].init.body).includes('refresh_token'));
});

test('WA-008 the one-use state cannot be replayed into a second account or token exchange', async () => {
  const f = await fixture();
  const started = await startSignIn(f);
  assert.equal((await callback(f, started)).status, 302);
  const replay = await callback(f, started);
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, 'invalid_or_expired_oauth_state');
  assert.equal(googleApiCalls(f).length, 2, 'the replayed callback never reaches Google');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM app_accounts').get().n, 1);
});

test('WA-008 a mismatched state cookie is rejected before the code is exchanged', async () => {
  const f = await fixture();
  const started = await startSignIn(f);
  const response = await callback(f, { state: started.state, cookie: 'celia_oauth_state=signin:wrong' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'oauth_state_cookie_mismatch');
  assert.equal(googleApiCalls(f).length, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM app_accounts').get().n, 0);
});

test('GA-F3 a Google consent denial returns to the Arabic UI, consumes state once and never exchanges a code', async () => {
  const f = await fixture();
  const started = await startSignIn(f);
  const deniedPath = `/auth/google/callback?error=access_denied&error_description=private-provider-detail&state=${encodeURIComponent(started.state)}`;
  const response = await f.call(deniedPath, { cookie: started.cookie });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/whatsapp?google_error=google_access_denied');
  assert.equal(JSON.stringify(response.headers).includes('private-provider-detail'), false, 'raw provider details are never reflected');
  const cookies = f.cookiesOf(response);
  assert.ok(cookies.some((entry) => entry.startsWith('celia_oauth_state=;') && entry.includes('Max-Age=0')));
  assert.equal(cookies.some((entry) => entry.startsWith('__Host-celia_wa=')), false, 'denial never opens an account session');
  assert.equal(googleApiCalls(f).length, 0, 'no token exchange or userinfo request occurs');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM app_accounts').get().n, 0);
  assert.ok(f.sqlite.prepare('SELECT used_at FROM oauth_states').get().used_at, 'the denial consumes the one-use state');

  const replay = await f.call(deniedPath, { cookie: started.cookie });
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, 'invalid_or_expired_oauth_state');
  assert.equal(googleApiCalls(f).length, 0, 'a replay still cannot reach Google');
});

test('GA-F2 a consent denial with the wrong state cookie is rejected without burning the pending state', async () => {
  const f = await fixture();
  const started = await startSignIn(f);
  const deniedPath = `/auth/google/callback?error=access_denied&state=${encodeURIComponent(started.state)}`;
  const response = await f.call(deniedPath, { cookie: 'celia_oauth_state=signin:wrong' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'oauth_state_cookie_mismatch');
  assert.equal(f.sqlite.prepare('SELECT used_at FROM oauth_states').get().used_at, null);
  assert.equal(googleApiCalls(f).length, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM app_accounts').get().n, 0);
});

test('WA-008 signing in again with the same Google sub reuses the account', async () => {
  const f = await fixture();
  const first = await callback(f, await startSignIn(f));
  const second = await callback(f, await startSignIn(f));
  assert.equal(second.status, 302);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM app_accounts').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM account_google_identities').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM account_sessions').get().n, 2);
  assert.notEqual(accountCookie(f, first), accountCookie(f, second), 'each sign-in gets a fresh session token');
});

test('WA-008 a Google address never takes over an existing password account', async () => {
  const f = await fixture();
  const registration = await f.call('/api/account/register', { method: 'POST', body: { email: EMAIL, password: 'a-strong-password-123' } });
  assert.equal(registration.status, 201);
  const response = await callback(f, await startSignIn(f));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/whatsapp?google_error=google_email_already_registered');
  assert.equal(f.cookiesOf(response).some((entry) => entry.startsWith('__Host-celia_wa=')), false);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM app_accounts').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM account_google_identities').get().n, 0);
});

test('WA-008 an unverified Google email is refused without creating an account', async () => {
  const f = await fixture({ profile: { sub: SUB, email: EMAIL, email_verified: false } });
  const response = await callback(f, await startSignIn(f));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/whatsapp?google_error=google_identity_not_verified');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM app_accounts').get().n, 0);
});

test('WA-008 a failed token exchange or userinfo lookup yields only a stable reason code', async () => {
  const badToken = await fixture({ tokenStatus: 400 });
  const tokenResponse = await callback(badToken, await startSignIn(badToken));
  assert.equal(tokenResponse.headers.get('location'), '/whatsapp?google_error=google_token_exchange_failed');
  assert.equal(badToken.sqlite.prepare('SELECT COUNT(*) AS n FROM app_accounts').get().n, 0);
  const badInfo = await fixture({ infoStatus: 503 });
  const infoResponse = await callback(badInfo, await startSignIn(badInfo));
  assert.equal(infoResponse.headers.get('location'), '/whatsapp?google_error=google_userinfo_verification_failed');
  assert.equal(badInfo.sqlite.prepare('SELECT COUNT(*) AS n FROM app_accounts').get().n, 0);
});

test('WA-008 APP_OWNER_EMAIL does not gate ordinary Google accounts', async () => {
  const f = await fixture({ ownerEmail: 'someone.else@example.com' });
  const response = await callback(f, await startSignIn(f));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/whatsapp');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM app_accounts').get().n, 1);
});

test('WA-009 an unregistered redirect URI shows an Arabic setup page instead of Google\'s 400', async () => {
  const f = await fixture({ googleProbeMismatch: true });
  const response = await f.call('/auth/google/signin');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const html = await response.text();
  const expectedUri = `${ORIGIN}/auth/google/callback`;
  // Exact equality against the rendered <code> blocks (not a URL substring check), so the
  // assertion cannot be satisfied by a look-alike host embedded elsewhere in the page.
  const codeBlocks = [...html.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)].map((match) => match[1].trim());
  assert.equal(codeBlocks.filter((value) => value === expectedUri).length, 1, 'the exact URI is shown for copy/paste');
  assert.equal(codeBlocks.filter((value) => value === CLIENT_ID).length, 1, 'the public client id is shown so the right OAuth client is edited');
  assert.match(html, /Authorized redirect URIs/);
  assert.match(html, /أعد المحاولة الآن/);
  assert.equal(codeBlocks.filter((value) => value === CLIENT_SECRET).length, 0, 'the OAuth secret never reaches the browser');
  assert.equal(response.headers.get('set-cookie'), null, 'no OAuth state is created for a refused flow');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM oauth_states').get().n, 0);
});

test('WA-009 the probe is re-run on every click, so registering the URI needs no redeploy', async () => {
  const broken = await fixture({ googleProbeMismatch: true });
  assert.equal((await broken.call('/auth/google/signin')).status, 200);
  const fixed = await fixture({ googleProbeMismatch: false });
  const ok = await fixed.call('/auth/google/signin');
  assert.equal(ok.status, 302);
  assert.match(new URL(ok.headers.get('location')).searchParams.get('state'), /^signin:[0-9a-f]{64}$/);
  assert.equal(fixed.calls.filter((c) => c.url.pathname === '/o/oauth2/v2/auth').length, 1);
});

test('WA-010 /auth/google/diagnostics answers in JSON whether Google accepts the redirect URI', async () => {
  const broken = await fixture({ googleProbeMismatch: true });
  const refused = await broken.call('/auth/google/diagnostics');
  assert.equal(refused.status, 200);
  assert.equal(refused.headers.get('cache-control'), 'no-store', 'the verdict is never cached');
  const refusedBody = await refused.json();
  assert.equal(refusedBody.ok, false);
  assert.equal(refusedBody.google.accepted, false);
  assert.equal(refusedBody.google.reason, 'redirect_uri_mismatch');
  assert.equal(refusedBody.redirectUri, `${ORIGIN}/auth/google/callback`);
  assert.equal(refusedBody.clientId, CLIENT_ID);
  assert.equal(refusedBody.nextStep, 'register_redirect_uri_in_google_console');
  assert.ok(refusedBody.instructions.some((line) => line.includes(`${ORIGIN}/auth/google/callback`)));
  // Public facts only: the secret, the client secret's env name and any token never appear.
  const raw = JSON.stringify(refusedBody);
  assert.equal(raw.includes(CLIENT_SECRET), false, 'the OAuth secret never reaches the browser');
  assert.equal(refusedBody.secretExposed, false);
  // Read-only: no OAuth state row, no cookie, no session.
  assert.equal(broken.sqlite.prepare('SELECT COUNT(*) AS n FROM oauth_states').get().n, 0);
  assert.equal(refused.headers.get('set-cookie'), null);

  const fixed = await fixture({ googleProbeMismatch: false });
  const acceptedBody = await (await fixed.call('/auth/google/diagnostics')).json();
  assert.equal(acceptedBody.ok, true);
  assert.equal(acceptedBody.google.accepted, true);
  assert.equal(acceptedBody.nextStep, null);
  assert.equal((await fixed.call('/auth/google/diagnostics', { method: 'POST' })).status, 405);
});

test('WA-010 the setup page names the four remaining causes and links the JSON diagnostics', async () => {
  const f = await fixture({ googleProbeMismatch: true });
  const html = await (await f.call('/auth/google/signin')).text();
  assert.match(html, /إن بقي الرفض بعد الحفظ/);
  assert.match(html, /عميل آخر/);
  assert.match(html, /مشروع آخر/);
  assert.match(html, /الحرفية/);
  assert.match(html, /الانتشار/);
  assert.match(html, /Test users/);
  assert.match(html, /href="\/auth\/google\/diagnostics"/);
  assert.equal(html.includes(CLIENT_SECRET), false);
});

test('WA-008 the WhatsApp account panel ships the Google icon wired to the sign-in route', async () => {
  const [html, js] = await Promise.all([
    readFile(new URL('../public/whatsapp.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/whatsapp.js', import.meta.url), 'utf8')
  ]);
  assert.match(html, /id="google-signin"/);
  assert.match(html, /class="google-icon"/);
  assert.match(html, /#EA4335/);
  assert.match(html, /الدخول بحساب Google/);
  assert.match(js, /window\.location\.assign\('\/auth\/google\/signin'\)/);
  assert.match(js, /google_error/);
  assert.match(js, /google_access_denied: 'لم تمنح Google الإذن\. لم يتم تسجيل الدخول أو إنشاء حساب\.'/);
  assert.match(js, /onEdge[\s\S]*google-signin'\)\.disabled = true/, 'the static preview disables a non-functional button');
});
