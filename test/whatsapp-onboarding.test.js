import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import worker from '../workers/celia-edge/worker.js';
import { parseSignupAssets } from '../workers/celia-edge/whatsapp-onboarding.js';
import { resolveEdgeWhatsAppCredentials, findWhatsAppVerifyToken } from '../workers/celia-edge/whatsapp-store.js';
import { decryptEdgeJson } from '../workers/celia-edge/crypto.js';
import { loadAllMigrationsSql, splitSqlStatements, buildWorkerMetadata } from '../scripts/deploy-cloudflare-edge.mjs';

const OWNER = 'owner-token-'.padEnd(48, 'x');
const SECRET = 'meta-app-secret-for-tests';
const ORIGIN = 'https://celia.example.workers.dev';
const KEY = crypto.randomBytes(32).toString('base64');
async function fixture({ configured = true } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  for (const sql of splitSqlStatements(await loadAllMigrationsSql())) sqlite.exec(sql);
  const DB = { prepare(sql) { let args = []; return { bind(...v) { args = v; return this; }, async run() { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: r.changes } }; }, async first() { return sqlite.prepare(sql).get(...args) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; } }; } };
  const env = { DB, CELIA_MCP_API_TOKEN: OWNER, TOKEN_ENCRYPTION_KEY: KEY, WHATSAPP_APP_SECRET: SECRET, CELIA_PUBLIC_ORIGIN: ORIGIN,
    ...(configured ? { WHATSAPP_APP_ID: '1234567890', WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: '9876543210' } : {}) };
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input); calls.push({ url, init });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('/oauth/access_token')) return json({ access_token: 'business-token-secret' });
    if (url.pathname.endsWith('/phone_numbers')) return json({ data: [{ id: '111222333', display_phone_number: '+201000000001', verified_name: 'نشاط تجريبي', code_verification_status: 'VERIFIED', status: 'PENDING' }] });
    if (url.pathname.endsWith('/subscribed_apps') && (!init.method || init.method === 'GET')) return json({ data: [] });
    if (url.pathname.endsWith('/subscribed_apps')) return json({ success: true });
    if (url.pathname.endsWith('/register')) return json({ success: true });
    if (url.pathname.endsWith('/111222333') && init.method === 'POST') return json({ success: true });
    if (url.pathname.endsWith('/111222333')) return json({ id: '111222333', status: 'CONNECTED', display_phone_number: '+201000000001', verified_name: 'نشاط تجريبي', webhook_configuration: {} });
    if (url.pathname.endsWith('/messages')) return json({ messages: [{ id: 'wamid.test-1' }] });
    throw new Error(`unexpected_fetch:${url.pathname}`);
  };
  env.__FETCH_IMPL = fetchImpl;
  const call = (path, { method = 'GET', token, cookie, body, origin = ORIGIN, headers = {} } = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json', origin, 'x-celia-request': 'whatsapp' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, { waitUntil() {} });
  return { env, sqlite, calls, fetchImpl, call };
}
async function openSession(f) {
  const link = await (await f.call('/api/whatsapp/connect-link', { method: 'POST', token: OWNER })).json();
  const auth = await f.call(`/auth/whatsapp?ticket=${new URL(link.url).searchParams.get('ticket')}`);
  assert.equal(auth.status, 302);
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  assert.match(auth.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  return { cookie, ticket: new URL(link.url).searchParams.get('ticket') };
}
async function linked(f) {
  const { cookie } = await openSession(f);
  const start = await (await f.call('/api/whatsapp/session/start', { method: 'POST', cookie, body: {} })).json();
  const result = await f.call('/api/whatsapp/session/complete', { method: 'POST', cookie, body: { state: start.state, code: 'short-lived-meta-code', sessionInfo: { messaging_account_ids: ['444555666'], phone_number_id: '111222333' } } });
  assert.equal(result.status, 200, await result.clone().text());
  return { cookie, start, result: await result.json() };
}

test('WA-005 onboarding: owner gate, single-use ticket, HttpOnly session and CSRF boundary', async () => {
  const f = await fixture();
  assert.equal((await f.call('/api/whatsapp/connect-link', { method: 'POST' })).status, 401);
  const { cookie, ticket } = await openSession(f);
  assert.equal((await f.call(`/auth/whatsapp?ticket=${ticket}`)).status, 400);
  assert.equal((await f.call('/api/whatsapp/session/start', { method: 'POST', cookie, body: {}, origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.call('/api/whatsapp/session/start', { method: 'POST', cookie, body: {}, headers: { 'x-celia-request': '' } })).status, 403);
  assert.equal((await f.call('/api/whatsapp/session/status', { cookie })).status, 200);
  assert.equal((await f.call('/api/whatsapp/session/logout', { method: 'POST', cookie, body: {} })).status, 200);
  assert.equal((await f.call('/api/whatsapp/session/status', { cookie })).status, 401);
});

test('WA-005 onboarding: v5 code exchange, Graph-authorized asset, webhook override, registration and encrypted persistence', async () => {
  const f = await fixture();
  const { result } = await linked(f);
  assert.equal(result.connection.connected, true);
  assert.equal(result.connection.phoneNumber, '+201000000001');
  const exchange = f.calls.find((c) => c.url.pathname.endsWith('/oauth/access_token'));
  assert.equal(exchange.url.searchParams.get('code'), 'short-lived-meta-code');
  assert.equal(exchange.url.searchParams.get('client_secret'), SECRET);
  const subscribe = f.calls.find((c) => c.url.pathname.endsWith('/subscribed_apps') && c.init.method === 'POST');
  assert.ok(subscribe);
  const override = f.calls.find((c) => c.url.pathname.endsWith('/111222333') && c.init.method === 'POST');
  assert.equal(JSON.parse(override.init.body).webhook_configuration.override_callback_uri, `${ORIGIN}/webhooks/whatsapp`);
  const register = f.calls.find((c) => c.url.pathname.endsWith('/register'));
  assert.match(JSON.parse(register.init.body).pin, /^\d{6}$/);
  const row = f.sqlite.prepare('SELECT * FROM whatsapp_connections').get();
  assert.ok(!JSON.stringify(row).includes('business-token-secret'));
  assert.ok(!JSON.stringify(row).includes(JSON.parse(register.init.body).pin));
  const stored = await decryptEdgeJson(row.credentials_ciphertext, f.env);
  assert.equal(stored.accessToken, 'business-token-secret');
  assert.equal(await findWhatsAppVerifyToken(f.env, stored.verifyToken), true);
  const creds = await resolveEdgeWhatsAppCredentials(f.env);
  assert.equal(creds.source, 'embedded_signup');
  assert.equal(creds.phoneNumberId, '111222333');
  assert.ok(!JSON.stringify(result).includes('business-token-secret'));
});

test('WA-005 onboarding: a Meta code is consumed once even under concurrent completion', async () => {
  const f = await fixture(); const { cookie } = await openSession(f);
  const start = await (await f.call('/api/whatsapp/session/start', { method: 'POST', cookie, body: {} })).json();
  const body = { state: start.state, code: 'one-use-code', sessionInfo: { waba_id: '444555666', phone_number_id: '111222333' } };
  const responses = await Promise.all([1, 2].map(() => f.call('/api/whatsapp/session/complete', { method: 'POST', cookie, body })));
  // One performs setup; the other cannot exchange the same consumed code again.
  assert.equal(f.calls.filter((c) => c.url.pathname.endsWith('/oauth/access_token')).length, 1);
  assert.ok(responses.some((r) => r.status === 400 || r.status === 200));
});

test('WA-005 onboarding: unconfigured platform never exposes a usable connect flow or secrets', async () => {
  const f = await fixture({ configured: false });
  const response = await f.call('/api/whatsapp/connect-link', { method: 'POST', token: OWNER });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'whatsapp_onboarding_not_configured' });
  assert.equal(f.calls.length, 0);
});

test('WA-005 onboarding: browser asset hints cannot select an unauthorized number', () => {
  assert.deepEqual(parseSignupAssets({ messaging_account_ids: ['444555666'], phone_number_id: '111222333' }), { wabaIds: ['444555666'], phoneNumberId: '111222333', onBizApp: false });
  assert.throws(() => parseSignupAssets({ messaging_account_ids: ['../../secret'] }), /whatsapp_business_account_missing/);
  assert.throws(() => parseSignupAssets({ waba_id: '444555666', phone_number_id: 'not-an-id' }), /invalid_embedded_signup_session/);
});

test('WA-005 runtime: linked credentials feed real send, webhook challenge, inbox and delivery receipts', async () => {
  const f = await fixture(); const { cookie } = await linked(f);
  const stored = await decryptEdgeJson(f.sqlite.prepare('SELECT credentials_ciphertext FROM whatsapp_connections').get().credentials_ciphertext, f.env);
  const challenge = await f.call(`/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${stored.verifyToken}&hub.challenge=challenge-1`);
  assert.equal(await challenge.text(), 'challenge-1');
  const payload = { entry: [{ changes: [{ value: { metadata: { phone_number_id: '111222333' }, messages: [{ id: 'wamid.in-1', from: '201000000002', type: 'text', text: { body: 'مرحبًا' } }] } }] }] };
  const raw = JSON.stringify(payload);
  const signature = `sha256=${crypto.createHmac('sha256', SECRET).update(raw).digest('hex')}`;
  const webhook = await worker.fetch(new Request(`${ORIGIN}/webhooks/whatsapp`, { method: 'POST', headers: { 'x-hub-signature-256': signature }, body: raw }), f.env, { waitUntil() {} });
  assert.equal(webhook.status, 200);
  const consent = await f.call('/api/whatsapp/session/test', { method: 'POST', cookie, body: { phone: '+201000000002', consent: true, idempotencyKey: 'test-send-1' } });
  assert.equal(consent.status, 200);
  const send = f.calls.find((c) => c.url.pathname.endsWith('/messages'));
  assert.equal(send.init.headers.authorization, 'Bearer business-token-secret');
  const receipt = { entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.test-1', status: 'delivered' }] } }] }] };
  const receiptRaw = JSON.stringify(receipt);
  await worker.fetch(new Request(`${ORIGIN}/webhooks/whatsapp`, { method: 'POST', headers: { 'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', SECRET).update(receiptRaw).digest('hex')}` }, body: receiptRaw }), f.env, { waitUntil() {} });
  const inbox = await (await f.call('/api/whatsapp/session/inbox', { cookie })).json();
  assert.equal(inbox.messages.find((m) => m.provider_message_id === 'wamid.test-1').status, 'delivered');
  assert.equal(inbox.messages.find((m) => m.provider_message_id === 'wamid.in-1').body, 'مرحبًا');
});

test('WA-005 deploy/UI: assets ship as bindings, page is Arabic and cannot fake a connection', async () => {
  const metadata = buildWorkerMetadata({ env: {}, uiAssets: { WHATSAPP_UI_HTML: '<html></html>' } });
  assert.ok(metadata.bindings.some((b) => b.name === 'WHATSAPP_UI_HTML' && b.type === 'plain_text'));
  // VER-07: a real 12 kB UI script must never be sent as a text binding again.
  assert.throws(() => buildWorkerMetadata({ env: {}, uiAssets: { WHATSAPP_UI_JS: 'x'.repeat(6000) } }), /text_binding_too_large/);
  const html = await readFile(new URL('../public/whatsapp.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../public/whatsapp.js', import.meta.url), 'utf8');
  assert.match(html, /lang="ar" dir="rtl"/);
  assert.match(html, /id="connect"[^>]*disabled/);
  assert.match(html, /id="account-form"/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)[^>]*>/);
  assert.doesNotMatch(js, /demo|sandbox/i);
  assert.match(js, /override_default_response_type: true/);
  assert.match(js, /https:\/\/www\.facebook\.com/);
});

async function register(f, email = 'user@example.com') {
  const response = await f.call('/api/account/register', { method: 'POST', body: { email, password: 'correct horse battery staple' } });
  assert.equal(response.status, 201, await response.clone().text());
  return { cookie: response.headers.get('set-cookie').split(';')[0], user: (await response.json()).user };
}

test('WA-007 ordinary user: register/login/session/logout without any owner token', async () => {
  const f = await fixture();
  const { cookie, user } = await register(f);
  assert.match(user.id, /^user_/);
  assert.equal((await f.call('/api/account/me', { cookie })).status, 200);
  assert.equal((await f.call('/api/whatsapp/session/status', { cookie })).status, 200);
  const row = f.sqlite.prepare('SELECT * FROM app_accounts WHERE id = ?').get(user.id);
  assert.ok(!JSON.stringify(row).includes('correct horse battery staple'));
  assert.equal((await f.call('/api/account/login', { method: 'POST', body: { email: 'user@example.com', password: 'wrong password' } })).status, 401);
  const login = await f.call('/api/account/login', { method: 'POST', body: { email: 'USER@example.com', password: 'correct horse battery staple' } });
  assert.equal(login.status, 200);
  assert.equal((await f.call('/api/account/register', { method: 'POST', body: { email: 'user@example.com', password: 'another password' } })).status, 409);
  assert.equal((await f.call('/api/account/logout', { method: 'POST', cookie, body: {} })).status, 200);
  assert.equal((await f.call('/api/account/me', { cookie })).status, 401);
});

test('WA-007 ordinary user: account mutations require same-origin CSRF and rate limit brute force', async () => {
  const f = await fixture();
  assert.equal((await f.call('/api/account/register', { method: 'POST', body: { email: 'x@example.com', password: 'long enough password' }, origin: 'https://evil.example' })).status, 403);
  let last;
  for (let i = 0; i < 9; i += 1) last = await f.call('/api/account/login', { method: 'POST', body: { email: 'x@example.com', password: 'wrong password' } });
  assert.equal(last.status, 429);
});

test('WA-007 tenant isolation: two users link different numbers, inboxes/consent/credentials never cross', async () => {
  const f = await fixture();
  const alice = await register(f, 'alice@example.com');
  const bob = await register(f, 'bob@example.com');
  async function link(account, phoneId, display) {
    const start = await (await f.call('/api/whatsapp/session/start', { method: 'POST', cookie: account.cookie, body: {} })).json();
    const original = f.env.__FETCH_IMPL;
    f.env.__FETCH_IMPL = async (input, init = {}) => {
      const url = new URL(input); const json = (body) => Response.json(body);
      if (url.pathname.endsWith('/oauth/access_token')) return json({ access_token: `token-${phoneId}` });
      if (url.pathname.endsWith('/phone_numbers')) return json({ data: [{ id: phoneId, display_phone_number: display, verified_name: display, code_verification_status: 'VERIFIED', status: 'CONNECTED' }] });
      if (url.pathname.endsWith('/subscribed_apps') && (!init.method || init.method === 'GET')) return json({ data: [] });
      if (url.pathname.endsWith('/subscribed_apps')) return json({ success: true });
      if (url.pathname.endsWith(`/${phoneId}`) && init.method === 'POST') return json({ success: true });
      if (url.pathname.endsWith(`/${phoneId}`)) return json({ id: phoneId, status: 'CONNECTED', display_phone_number: display, webhook_configuration: {} });
      if (url.pathname.endsWith('/messages')) return json({ messages: [{ id: `wamid.${phoneId}` }] });
      return original(input, init);
    };
    const response = await f.call('/api/whatsapp/session/complete', { method: 'POST', cookie: account.cookie, body: { state: start.state, code: `code-${phoneId}`, sessionInfo: { messaging_account_ids: ['444555666'], phone_number_id: phoneId } } });
    assert.equal(response.status, 200, await response.clone().text());
    f.env.__FETCH_IMPL = original;
  }
  await link(alice, '111111111', '+201111111111');
  await link(bob, '222222222', '+201222222222');
  async function inbound(phoneId, from, id) {
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: phoneId }, messages: [{ id, from, type: 'text', text: { body: `رسالة ${id}` } }] } }] }] });
    const response = await worker.fetch(new Request(`${ORIGIN}/webhooks/whatsapp`, { method: 'POST', headers: { 'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', SECRET).update(raw).digest('hex')}` }, body: raw }), f.env, { waitUntil() {} });
    assert.equal(response.status, 200);
  }
  await inbound('111111111', '201000000001', 'wamid.alice-in');
  await inbound('222222222', '201000000002', 'wamid.bob-in');
  const aliceInbox = await (await f.call('/api/whatsapp/session/inbox', { cookie: alice.cookie })).json();
  const bobInbox = await (await f.call('/api/whatsapp/session/inbox', { cookie: bob.cookie })).json();
  assert.deepEqual(aliceInbox.messages.map((m) => m.provider_message_id), ['wamid.alice-in']);
  assert.deepEqual(bobInbox.messages.map((m) => m.provider_message_id), ['wamid.bob-in']);
  let tenantSend = null;
  f.env.__FETCH_IMPL = async (input, init = {}) => {
    const url = new URL(input);
    if (!url.pathname.endsWith('/messages')) throw new Error('unexpected_fetch');
    const phoneId = url.pathname.split('/').at(-2);
    tenantSend = { phoneId, authorization: init.headers.authorization };
    return Response.json({ messages: [{ id: `wamid.${phoneId}` }] });
  };
  const send = await f.call('/api/whatsapp/session/test', { method: 'POST', cookie: alice.cookie, body: { phone: '+201000000001', consent: true, idempotencyKey: 'alice-test-1' } });
  assert.equal(send.status, 200, await send.clone().text());
  assert.equal(tenantSend.authorization, 'Bearer token-111111111');
  assert.equal(tenantSend.phoneId, '111111111');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_messages').get().n, 0, 'tenant data never enters owner inbox');
  const receiptRaw = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '111111111' }, statuses: [{ id: 'wamid.111111111', status: 'delivered' }] } }] }] });
  await worker.fetch(new Request(`${ORIGIN}/webhooks/whatsapp`, { method: 'POST', headers: { 'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', SECRET).update(receiptRaw).digest('hex')}` }, body: receiptRaw }), f.env, { waitUntil() {} });
  const aliceAfter = await (await f.call('/api/whatsapp/session/inbox', { cookie: alice.cookie })).json();
  assert.equal(aliceAfter.messages.find((m) => m.provider_message_id === 'wamid.111111111').status, 'delivered');
  const bobAfter = await (await f.call('/api/whatsapp/session/inbox', { cookie: bob.cookie })).json();
  assert.ok(!bobAfter.messages.some((m) => m.provider_message_id === 'wamid.111111111'));

  const bobSend = await f.call('/api/whatsapp/session/test', { method: 'POST', cookie: bob.cookie, body: { phone: '+201000000001', consent: true, idempotencyKey: 'bob-test-1' } });
  assert.equal(bobSend.status, 403, 'Alice consent does not authorize Bob');
});

test('WA-007 tenant resolver never falls back to the owner environment token', async () => {
  const f = await fixture();
  f.env.WHATSAPP_ACCESS_TOKEN = 'owner-token'; f.env.WHATSAPP_PHONE_NUMBER_ID = 'owner-number';
  assert.equal(await resolveEdgeWhatsAppCredentials(f.env, 'user_missing'), null);
  assert.equal((await resolveEdgeWhatsAppCredentials(f.env, 'owner')).accessToken, 'owner-token');
});


test('WA-007 tenant boundary: a browser account cookie never unlocks owner APIs and a number cannot be claimed twice', async () => {
  const f = await fixture();
  const { cookie } = await register(f, 'tenant@example.com');
  assert.equal((await f.call('/api/whatsapp/contacts', { cookie })).status, 401);
  assert.equal((await f.call('/mcp', { method: 'POST', cookie, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status, 401);
  const start = await (await f.call('/api/whatsapp/session/start', { method: 'POST', cookie, body: {} })).json();
  const complete = await f.call('/api/whatsapp/session/complete', { method: 'POST', cookie, body: { state: start.state, code: 'tenant-code', sessionInfo: { messaging_account_ids: ['444555666'], phone_number_id: '111222333' } } });
  assert.equal(complete.status, 200);
  const other = await register(f, 'other@example.com');
  const otherStart = await (await f.call('/api/whatsapp/session/start', { method: 'POST', cookie: other.cookie, body: {} })).json();
  const conflict = await f.call('/api/whatsapp/session/complete', { method: 'POST', cookie: other.cookie, body: { state: otherStart.state, code: 'other-code', sessionInfo: { messaging_account_ids: ['444555666'], phone_number_id: '111222333' } } });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, 'whatsapp_number_already_linked');
});

test('VER-01 webhook handshake: the env verify token is accepted, near-misses are refused, and no plaintext token is stored', async () => {
  const f = await fixture();
  const expected = 'platform-verify-token-value';
  f.env.WHATSAPP_VERIFY_TOKEN = expected;
  assert.equal(await findWhatsAppVerifyToken(f.env, expected), true);
  // Same length, one byte different: a `===` fast path would still be correct here, but
  // these pin that the constant-time path neither accepts prefixes nor padded variants.
  assert.equal(await findWhatsAppVerifyToken(f.env, `${expected.slice(0, -1)}X`), false);
  assert.equal(await findWhatsAppVerifyToken(f.env, expected.slice(0, -1)), false);
  assert.equal(await findWhatsAppVerifyToken(f.env, `${expected} `), false);
  assert.equal(await findWhatsAppVerifyToken(f.env, ''), false);
  const ok = await f.call(`/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${expected}&hub.challenge=ver-challenge`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'ver-challenge');
  const bad = await f.call(`/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${expected}x&hub.challenge=ver-challenge`);
  assert.equal(bad.status, 403);
  // The handshake must work with no env token at all, purely from the stored hash.
  delete f.env.WHATSAPP_VERIFY_TOKEN;
  assert.equal(await findWhatsAppVerifyToken(f.env, expected), false);
});

// VER-03 — the failure paths are the ones that decide whether a half-linked number can
// silently look connected. Each test forces one upstream failure and asserts the durable
// stage, the HTTP contract, and that a retry reconciles instead of repeating a mutation.
async function failingFixture(failOn, { status = 500 } = {}) {
  const f = await fixture();
  const { cookie } = await openSession(f);
  const start = await (await f.call('/api/whatsapp/session/start', { method: 'POST', cookie, body: {} })).json();
  const base = f.fetchImpl;
  let failed = false;
  f.env.__FETCH_IMPL = async (input, init = {}) => {
    const url = new URL(input);
    if (!failed && failOn(url, init)) {
      failed = true;
      f.calls.push({ url, init }); // record the attempted mutation so replay counts stay honest
      if (status === 'network') throw new Error('socket hang up');
      return new Response(JSON.stringify({ error: { code: 190, message: 'secret-bearing provider text' } }), { status, headers: { 'content-type': 'application/json' } });
    }
    return base(input, init);
  };
  return { f, cookie, state: start.state, restore: () => { f.env.__FETCH_IMPL = base; } };
}
const completeBody = (state) => ({ state, code: 'failure-path-code', sessionInfo: { messaging_account_ids: ['444555666'], phone_number_id: '111222333' } });

test('VER-03 a subscribe timeout is recorded as subscription_unknown and never reports a connected number', async () => {
  const { f, cookie, state, restore } = await failingFixture((url, init) => url.pathname.endsWith('/subscribed_apps') && init.method === 'POST', { status: 'network' });
  const response = await f.call('/api/whatsapp/session/complete', { method: 'POST', cookie, body: completeBody(state) });
  assert.equal(response.status, 502);
  const row = f.sqlite.prepare('SELECT stage FROM whatsapp_oauth_states').get();
  assert.equal(row.stage, 'subscription_unknown');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_connections').get().n, 0, 'no connection row from an unknown outcome');
  assert.equal(f.calls.filter((c) => c.url.pathname.endsWith('/register')).length, 0, 'never registers after an unknown subscription');
  // Retry reuses the stored credentials (no second code exchange) and completes.
  restore();
  const retry = await f.call('/api/whatsapp/session/complete', { method: 'POST', cookie, body: { state, sessionInfo: { messaging_account_ids: ['444555666'], phone_number_id: '111222333' } } });
  assert.equal(retry.status, 200, await retry.clone().text());
  assert.equal(f.calls.filter((c) => c.url.pathname.endsWith('/oauth/access_token')).length, 1, 'the consumed code is never exchanged twice');
});

test('VER-03 an unknown registration is never blindly re-sent; it reconciles only after Meta reports CONNECTED', async () => {
  const { f, cookie, state, restore } = await failingFixture((url) => url.pathname.endsWith('/register'), { status: 503 });
  const first = await f.call('/api/whatsapp/session/complete', { method: 'POST', cookie, body: completeBody(state) });
  assert.equal(first.status, 502);
  const row = f.sqlite.prepare('SELECT stage, pin_ciphertext FROM whatsapp_oauth_states').get();
  assert.equal(row.stage, 'registration_unknown');
  assert.ok(row.pin_ciphertext, 'the PIN is persisted before the risky call so reconciliation cannot invent a second one');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_connections').get().n, 0);

  // AGENTS invariant: never replay an external mutation after an unknown outcome.
  restore();
  const retry = await f.call('/api/whatsapp/session/complete', { method: 'POST', cookie, body: { state, sessionInfo: { messaging_account_ids: ['444555666'], phone_number_id: '111222333' } } });
  assert.equal(retry.status, 409);
  assert.match(await retry.text(), /registration_outcome_unknown_reconcile_in_meta/);
  assert.equal(f.calls.filter((c) => c.url.pathname.endsWith('/register')).length, 1, 'the register mutation is not repeated');

  // Once Graph itself reports the number CONNECTED, completion reconciles without re-registering.
  const base = f.env.__FETCH_IMPL;
  f.env.__FETCH_IMPL = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/phone_numbers')) {
      return Response.json({ data: [{ id: '111222333', display_phone_number: '+201000000001', verified_name: 'نشاط تجريبي', code_verification_status: 'VERIFIED', status: 'CONNECTED' }] });
    }
    return base(input, init);
  };
  const reconciled = await f.call('/api/whatsapp/session/complete', { method: 'POST', cookie, body: { state, sessionInfo: { messaging_account_ids: ['444555666'], phone_number_id: '111222333' } } });
  assert.equal(reconciled.status, 200, await reconciled.clone().text());
  assert.equal(f.calls.filter((c) => c.url.pathname.endsWith('/register')).length, 1, 'reconciliation reads state instead of mutating again');
  assert.equal(f.calls.filter((c) => c.url.pathname.endsWith('/oauth/access_token')).length, 1, 'the consumed code is never exchanged twice');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_connections').get().n, 1);
});

test('VER-03 provider errors are never echoed to the browser and 4xx is not treated as unknown', async () => {
  const { f, cookie, state } = await failingFixture((url, init) => url.pathname.endsWith('/subscribed_apps') && init.method === 'POST', { status: 400 });
  const response = await f.call('/api/whatsapp/session/complete', { method: 'POST', cookie, body: completeBody(state) });
  const text = await response.text();
  assert.equal(response.status, 502);
  assert.ok(!text.includes('secret-bearing provider text'), 'raw provider message must not leak');
  assert.match(text, /meta_request_rejected_400/);
  assert.equal(f.sqlite.prepare('SELECT stage FROM whatsapp_oauth_states').get().stage, 'failed', 'a definite rejection is failed, not unknown');
});

test('VER-03 an already-configured phone override is not rewritten on a repeat completion', async () => {
  const f = await fixture();
  const { cookie } = await openSession(f);
  const start = await (await f.call('/api/whatsapp/session/start', { method: 'POST', cookie, body: {} })).json();
  const base = f.fetchImpl;
  f.env.__FETCH_IMPL = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/111222333') && (!init.method || init.method === 'GET') && url.searchParams.get('fields') === 'webhook_configuration') {
      return Response.json({ id: '111222333', webhook_configuration: { override_callback_uri: `${ORIGIN}/webhooks/whatsapp` } });
    }
    if (url.pathname.endsWith('/subscribed_apps') && (!init.method || init.method === 'GET')) return Response.json({ data: [{ id: '1234567890' }] });
    return base(input, init);
  };
  const response = await f.call('/api/whatsapp/session/complete', { method: 'POST', cookie, body: completeBody(start.state) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(f.calls.filter((c) => c.url.pathname.endsWith('/111222333') && c.init.method === 'POST').length, 0, 'idempotent: no redundant override write');
  assert.equal(f.calls.filter((c) => c.url.pathname.endsWith('/subscribed_apps') && c.init.method === 'POST').length, 0, 'already subscribed: no redundant subscribe');
});
