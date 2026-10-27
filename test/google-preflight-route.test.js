import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createGoogleRouter } from '../src/google.js';

const encryptionKey = Buffer.alloc(32, 3).toString('base64');
const config = {
  nodeEnv: 'test',
  baseUrl: 'https://assistant.example.com',
  apiToken: 'api-token-with-at-least-32-characters-ok',
  encryptionKey,
  userId: 'owner',
  features: { google: true },
  google: {
    clientId: '123456789012-abcdefghijklmnop.apps.googleusercontent.com',
    clientSecret: 'GOCSPX-abcdefghijklmnopqrstuvwx',
    redirectUri: 'https://assistant.example.com/auth/google/callback',
    allowedEmail: 'owner@example.com'
  },
  resilience: { timeoutMs: 8000 }
};

const pool = { execute: async () => [[], []] };
const env = {
  APP_BASE_URL: config.baseUrl,
  APP_API_TOKEN: config.apiToken,
  TOKEN_ENCRYPTION_KEY: encryptionKey,
  APP_OWNER_EMAIL: 'owner@example.com',
  APP_OWNER_PHONE_E164: '+201234567890',
  GOOGLE_CLIENT_ID: config.google.clientId,
  GOOGLE_CLIENT_SECRET: config.google.clientSecret,
  GOOGLE_REDIRECT_URI: config.google.redirectUri
};

const app = express();
app.use(createGoogleRouter({ pool, config, env }));
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((resolve) => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
test.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));

test('GOOG-002: the preflight route is owner-only', async () => {
  const response = await fetch(`${baseUrl}/api/google/preflight`);
  assert.equal(response.status, 401);
});

test('GOOG-002: the preflight route reports readiness for a complete environment without leaking secrets', async () => {
  const response = await fetch(`${baseUrl}/api/google/preflight`, { headers: { authorization: `Bearer ${config.apiToken}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.redirectUri, 'https://assistant.example.com/auth/google/callback');
  const text = JSON.stringify(body);
  assert.equal(text.includes(env.GOOGLE_CLIENT_SECRET), false);
  assert.equal(text.includes(env.APP_API_TOKEN), false);
  assert.equal(text.includes(env.TOKEN_ENCRYPTION_KEY), false);
});
