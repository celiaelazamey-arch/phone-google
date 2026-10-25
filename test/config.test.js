import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const token = 't'.repeat(40);
const key = Buffer.alloc(32, 9).toString('base64');
const base = { APP_API_TOKEN: token, TOKEN_ENCRYPTION_KEY: key };

test('requires a bearer token of at least 32 characters', () => {
  assert.throws(() => loadConfig({ TOKEN_ENCRYPTION_KEY: key }), /Missing required environment variable: APP_API_TOKEN/);
  assert.throws(() => loadConfig({ ...base, APP_API_TOKEN: 'short' }), /at least 32 characters/);
});

test('requires a base64 encryption key that decodes to exactly 32 bytes', () => {
  assert.throws(() => loadConfig({ APP_API_TOKEN: token }), /Missing required environment variable: TOKEN_ENCRYPTION_KEY/);
  assert.throws(() => loadConfig({ ...base, TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }), /exactly 32 bytes/);
});

test('validates PORT and freezes the resulting configuration', () => {
  assert.throws(() => loadConfig({ ...base, PORT: '70000' }), /valid TCP port/);
  const config = loadConfig({ ...base, PORT: '3100', APP_OWNER_EMAIL: '  OWNER@Example.COM ' });
  assert.equal(config.port, 3100);
  assert.equal(config.google.allowedEmail, 'owner@example.com');
  assert.equal(config.baseUrl, 'http://localhost:3100');
  assert.equal(config.whatsapp.apiVersion, 'v23.0');
  assert.equal(config.whatsapp.autoReplyEnabled, false);
  assert.equal(Object.isFrozen(config), true);
});

test('only an explicit true enables automatic AI replies', () => {
  assert.equal(loadConfig({ ...base, WHATSAPP_AUTO_REPLY_ENABLED: 'true' }).whatsapp.autoReplyEnabled, true);
  assert.equal(loadConfig({ ...base, WHATSAPP_AUTO_REPLY_ENABLED: 'TRUE' }).whatsapp.autoReplyEnabled, false);
});
