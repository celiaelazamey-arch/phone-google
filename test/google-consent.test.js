import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { mintConsentTicket, verifyConsentTicket } from '../src/consent-ticket.js';
import { isGoogleConnectCommand } from '../src/whatsapp.js';
import { hashOAuthState } from '../src/security.js';

const encryptionKey = Buffer.alloc(32, 9).toString('base64');
const config = {
  nodeEnv: 'test',
  baseUrl: 'http://localhost:3000',
  apiToken: 'test-token-with-at-least-32-characters',
  encryptionKey,
  userId: 'owner',
  features: { google: true, whatsapp: false },
  google: {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'http://localhost:3000/auth/google/callback',
    allowedEmail: ''
  },
  whatsapp: { verifyToken: '', appSecret: '', accessToken: '', phoneNumberId: '', apiVersion: '', autoReplyEnabled: false },
  resilience: { timeoutMs: 8000 }
};

function createStatePool() {
  const states = new Map();
  return {
    states,
    async execute(sql, params) {
      if (/^INSERT INTO oauth_states/.test(sql)) {
        states.set(params[0], { userId: params[1], expiresAt: new Date(params[2] * 1000), usedAt: null });
        return [{ affectedRows: 1 }];
      }
      if (/^SELECT user_id FROM oauth_states/.test(sql)) {
        const row = states.get(params[0]);
        if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) return [[], []];
        return [[{ user_id: row.userId }], []];
      }
      if (/^UPDATE oauth_states SET used_at/.test(sql)) {
        const row = states.get(params[0]);
        if (!row || row.usedAt) return [{ affectedRows: 0 }];
        row.usedAt = new Date();
        return [{ affectedRows: 1 }];
      }
      return [[], []];
    }
  };
}

const pool = createStatePool();
const server = createApp({ pool, config }).listen(0);
const baseUrl = await new Promise((resolve) => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
test.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

/** The router builds links from config.baseUrl; the test server listens on a random port. */
function toServerUrl(url) {
  return url.replace(config.baseUrl, baseUrl);
}

async function requestConsentLink({ authorized = true } = {}) {
  return fetch(`${baseUrl}/api/google/consent-link`, {
    method: 'POST',
    headers: authorized ? { authorization: `Bearer ${config.apiToken}` } : {}
  });
}

test('consent tickets round-trip and bind to one owner for at most ten minutes', () => {
  const { ticket, expiresAt } = mintConsentTicket({ userId: 'owner', encryptionKey });
  const verified = verifyConsentTicket(ticket, { encryptionKey, userId: 'owner' });
  assert.equal(verified.ok, true);
  assert.equal(verified.userId, 'owner');
  assert.ok(expiresAt.getTime() - Date.now() <= 10 * 60 * 1000 + 1000);
});

test('consent tickets reject tampering, foreign owners, expired and malformed values', () => {
  const { ticket } = mintConsentTicket({ userId: 'owner', encryptionKey });
  const [payload, signature] = ticket.split('.');
  const tampered = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}.${signature}`;
  assert.equal(verifyConsentTicket(tampered, { encryptionKey, userId: 'owner' }).ok, false);
  assert.equal(verifyConsentTicket(`${payload}.${signature.slice(0, -2)}AA`, { encryptionKey, userId: 'owner' }).ok, false);
  assert.equal(verifyConsentTicket(ticket, { encryptionKey, userId: 'someone-else' }).reason, 'user');
  assert.equal(verifyConsentTicket(ticket, { encryptionKey, userId: 'owner', now: Date.now() + 11 * 60 * 1000 }).reason, 'expired');
  assert.equal(verifyConsentTicket('not-a-ticket', { encryptionKey, userId: 'owner' }).ok, false);
  assert.equal(verifyConsentTicket('', { encryptionKey, userId: 'owner' }).ok, false);
  assert.equal(verifyConsentTicket('x'.repeat(4000), { encryptionKey, userId: 'owner' }).ok, false);
});

test('a ticket signed with another key is rejected', () => {
  const otherKey = Buffer.alloc(32, 4).toString('base64');
  const { ticket } = mintConsentTicket({ userId: 'owner', encryptionKey: otherKey });
  assert.equal(verifyConsentTicket(ticket, { encryptionKey, userId: 'owner' }).reason, 'signature');
});

test('consent link requires the owner bearer token', async () => {
  const response = await requestConsentLink({ authorized: false });
  assert.equal(response.status, 401);
});

test('owner gets a single-use link, and the link redirects to Google without exposing the bearer', async () => {
  const response = await requestConsentLink();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.singleUse, true);
  assert.match(body.url, /\/auth\/google\?ticket=/);
  assert.ok(!body.url.includes(config.apiToken), 'the API token must never appear in a deliverable link');

  const start = await fetch(toServerUrl(body.url), { redirect: 'manual' });
  assert.equal(start.status, 302);
  assert.match(start.headers.get('location'), /^https:\/\/accounts\.google\.com\//);
  assert.match(start.headers.get('set-cookie') || '', /google_oauth_state=/);
});

test('a used or expired link is refused with a clear message', async () => {
  const created = await (await requestConsentLink()).json();
  const ticket = decodeURIComponent(created.url.split('ticket=')[1]);
  const stored = pool.states.get(hashOAuthState(ticket));
  stored.usedAt = new Date();
  const reused = await fetch(toServerUrl(created.url), { redirect: 'manual' });
  assert.equal(reused.status, 400);
  assert.match(await reused.text(), /already used or has expired/);

  const expired = await (await requestConsentLink()).json();
  const expiredTicket = decodeURIComponent(expired.url.split('ticket=')[1]);
  pool.states.get(hashOAuthState(expiredTicket)).expiresAt = new Date(Date.now() - 1000);
  const refused = await fetch(toServerUrl(expired.url), { redirect: 'manual' });
  assert.equal(refused.status, 400);
});

test('a forged ticket never reaches Google', async () => {
  const forged = await fetch(`${baseUrl}/auth/google?ticket=forged.signature`, { redirect: 'manual' });
  assert.equal(forged.status, 400);
  assert.match(await forged.text(), /invalid or has expired/);
});

test('only the narrow owner command is recognised', () => {
  for (const text of ['اربط جوجل', 'اربط حسابي جوجل', 'ربط جوجل', 'اربط جوجل الآن', 'connect google', 'Connect my Google account', 'link google']) {
    assert.equal(isGoogleConnectCommand(text), true, text);
  }
  for (const text of ['', 'جوجل', 'google', 'عايز اربط جوجل', 'اربط واتساب', 'اربط جوجل بليز', 'x'.repeat(200)]) {
    assert.equal(isGoogleConnectCommand(text), false, text);
  }
});

test('HIGH-07 Node (1/5): GET /auth/google?ticket=... consumes the consent ticket atomically in Promise.all ([302, 400]) and blocks replay before callback', async () => {
  const racePool = createStatePool();
  const origExec = racePool.execute.bind(racePool);
  racePool.execute = async (sql, params) => {
    const out = await origExec(sql, params);
    if (/^SELECT user_id FROM oauth_states/.test(sql)) {
      await new Promise((r) => setTimeout(r, 8));
    }
    return out;
  };
  const raceSrv = createApp({ pool: racePool, config }).listen(0);
  const raceBase = await new Promise((resolve) => raceSrv.once('listening', () => resolve(`http://127.0.0.1:${raceSrv.address().port}`)));
  try {
    const createdRes = await fetch(`${raceBase}/api/google/consent-link`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiToken}` }
    });
    const created = await createdRes.json();
    const targetUrl = created.url.replace(config.baseUrl, raceBase);

    const [r1, r2] = await Promise.all([
      fetch(targetUrl, { redirect: 'manual' }),
      fetch(targetUrl, { redirect: 'manual' })
    ]);
    assert.deepEqual([r1.status, r2.status].sort((a, b) => a - b), [302, 400]);

    const replay = await fetch(targetUrl, { redirect: 'manual' });
    assert.equal(replay.status, 400);
  } finally {
    await new Promise((resolve, reject) => raceSrv.close((err) => (err ? reject(err) : resolve())));
  }
});

test('HIGH-07 Node (2/5): GET /auth/google?ticket=... mints an independent OAuth state and never leaks the signed consent ticket to Google URL or cookie', async () => {
  const created = await (await requestConsentLink()).json();
  const ticket = decodeURIComponent(created.url.split('ticket=')[1]);
  const start = await fetch(toServerUrl(created.url), { redirect: 'manual' });
  assert.equal(start.status, 302);

  const location = start.headers.get('location') || '';
  const setCookie = start.headers.get('set-cookie') || '';
  const oauthState = new URL(location).searchParams.get('state') || '';

  assert.ok(oauthState.length >= 32, 'fresh OAuth state must be minted');
  assert.notEqual(oauthState, ticket, 'signed consent ticket must never be reused as Google OAuth state');
  assert.ok(!location.includes(encodeURIComponent(ticket)) && !location.includes(ticket), 'Google redirect URL must not contain the consent ticket');
  assert.ok(!setCookie.includes(encodeURIComponent(ticket)) && !setCookie.includes(ticket), 'cookie must hold the fresh OAuth state, not the ticket');
  assert.ok(pool.states.get(hashOAuthState(oauthState)), 'fresh OAuth state hash is recorded for callback consumption');
});

test('HIGH-07 Node (3/5): GET /auth/google/callback rejects malformed percent-encoded google_oauth_state cookie with 400 instead of throwing 500 URIError', async () => {
  const res = await fetch(`${baseUrl}/auth/google/callback?code=fake&state=abc`, {
    headers: { cookie: 'google_oauth_state=%E0%A4%A' }
  });
  assert.equal(res.status, 400);
});

test('HIGH-07 Node (4/5): GET /auth/google/callback refuses direct state/cookie replay of an unconsumed consent ticket without browser: prefix', async () => {
  let tokenExchanges = 0;
  const services = {
    run: async (name, fn) => {
      if (name === 'google.oauth') {
        tokenExchanges += 1;
        return {
          tokens: {
            access_token: 'ya29.attacker',
            refresh_token: '1//attacker-refresh',
            scope: 'openid email'
          }
        };
      }
      return fn();
    }
  };

  const localPool = createStatePool();
  const srv = createApp({ pool: localPool, config, services }).listen(0);
  const srvBase = await new Promise((resolve) => srv.once('listening', () => resolve(`http://127.0.0.1:${srv.address().port}`)));
  try {
    const linkRes = await fetch(`${srvBase}/api/google/consent-link`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiToken}` }
    });
    const { url } = await linkRes.json();
    const ticket = decodeURIComponent(url.split('ticket=')[1]);

    // Attacker supplies the raw consent ticket directly as callback `state` + matching cookie, skipping /auth/google:
    const forgedCallback = await fetch(
      `${srvBase}/auth/google/callback?code=attacker-code&state=${encodeURIComponent(ticket)}`,
      { headers: { cookie: `google_oauth_state=${encodeURIComponent(ticket)}` } }
    );
    assert.equal(forgedCallback.status, 400);
    assert.equal(tokenExchanges, 0, 'callback must never accept a consent ticket row as an OAuth browser state');
    assert.equal(localPool.states.get(hashOAuthState(ticket))?.usedAt, null, 'ticket row remains untouched by forged callback');
  } finally {
    await new Promise((resolve, reject) => srv.close((err) => (err ? reject(err) : resolve())));
  }
});

test('HIGH-07 Node (5/5): concurrent Promise.all requests on GET /auth/google/callback consume browser: oauth_states atomically ([200, 400]) and exchange Google token once', async () => {
  const raceStates = new Map();
  let tokenExchanges = 0;
  const racePool = {
    async execute(sql, params) {
      if (/^INSERT INTO oauth_states/.test(sql)) {
        const expMs = params[2] ? params[2] * 1000 : Date.now() + 600_000;
        raceStates.set(params[0], { userId: params[1], expiresAt: new Date(expMs), usedAt: null });
        return [{ affectedRows: 1 }];
      }
      if (/^SELECT user_id FROM oauth_states/.test(sql)) {
        const row = raceStates.get(params[0]);
        await new Promise((r) => setTimeout(r, 8));
        if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) return [[], []];
        return [[{ user_id: row.userId }], []];
      }
      if (/^UPDATE oauth_states SET used_at/.test(sql)) {
        const row = raceStates.get(params[0]);
        if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) return [{ affectedRows: 0 }];
        row.usedAt = new Date();
        return [{ affectedRows: 1 }];
      }
      if (/^SELECT encrypted_tokens FROM google_credentials/.test(sql)) return [[], []];
      if (/^INSERT INTO google_credentials/.test(sql)) return [{ affectedRows: 1 }];
      return [[], []];
    }
  };
  const services = {
    run: async (name, fn) => {
      if (name === 'google.oauth') {
        tokenExchanges += 1;
        return { tokens: { access_token: 'ya29.ok', refresh_token: '1//ok', scope: 'openid email' } };
      }
      return fn();
    }
  };
  const raceSrv = createApp({ pool: racePool, config, services }).listen(0);
  const raceBase = await new Promise((resolve) => raceSrv.once('listening', () => resolve(`http://127.0.0.1:${raceSrv.address().port}`)));
  try {
    const start = await fetch(`${raceBase}/auth/google`, {
      headers: { authorization: `Bearer ${config.apiToken}` },
      redirect: 'manual'
    });
    assert.equal(start.status, 302);
    const oauthState = new URL(start.headers.get('location')).searchParams.get('state');
    assert.match(oauthState, /^browser:[0-9a-f]{64}$/);
    const cookieHeader = `google_oauth_state=${encodeURIComponent(oauthState)}`;

    const [c1, c2] = await Promise.all([
      fetch(`${raceBase}/auth/google/callback?code=c-race&state=${encodeURIComponent(oauthState)}`, { headers: { cookie: cookieHeader } }),
      fetch(`${raceBase}/auth/google/callback?code=c-race&state=${encodeURIComponent(oauthState)}`, { headers: { cookie: cookieHeader } })
    ]);
    assert.deepEqual([c1.status, c2.status].sort((a, b) => a - b), [200, 400]);
    assert.equal(tokenExchanges, 1);
  } finally {
    await new Promise((resolve, reject) => raceSrv.close((err) => (err ? reject(err) : resolve())));
  }
});

