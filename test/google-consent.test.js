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
