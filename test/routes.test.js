import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

const config = {
  nodeEnv: 'test',
  apiToken: 'test-token-with-at-least-32-characters',
  encryptionKey: Buffer.alloc(32, 7).toString('base64'),
  userId: 'owner',
  google: { clientId: '', clientSecret: '', redirectUri: 'http://localhost:3000/auth/google/callback' },
  whatsapp: { verifyToken: '', appSecret: '', accessToken: '', phoneNumberId: '', apiVersion: '', autoReplyEnabled: false, autoReplyText: '' }
};
const pool = { execute: async () => [[]] };
const server = createApp({ pool, config }).listen(0);
const baseUrl = await new Promise((resolve) => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
test.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

test('health endpoint is public, while management APIs require the bearer token', async () => {
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  const api = await fetch(`${baseUrl}/api/google/gmail/search?q=invoice`);
  assert.equal(api.status, 401);
  const wa = await fetch(`${baseUrl}/api/whatsapp/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '+14155552671', text: 'hello' }) });
  assert.equal(wa.status, 401);
});

test('Google connect start requires owner token; callback rejects missing state cookie', async () => {
  const blocked = await fetch(`${baseUrl}/auth/google`, { redirect: 'manual' });
  assert.equal(blocked.status, 401);
  const authorized = await fetch(`${baseUrl}/auth/google`, { headers: { authorization: `Bearer ${config.apiToken}` }, redirect: 'manual' });
  assert.equal(authorized.status, 503);
  const callback = await fetch(`${baseUrl}/auth/google/callback?code=irrelevant&state=fake`);
  assert.equal(callback.status, 400);
});

test('WhatsApp webhook refuses verification when its verify token is not configured', async () => {
  const response = await fetch(`${baseUrl}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=&hub.challenge=123`);
  assert.equal(response.status, 403);
});
