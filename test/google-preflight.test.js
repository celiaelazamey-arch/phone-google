import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPreflightReport, preflightGoogleConfig } from '../src/google-preflight.js';

const encryptionKey = Buffer.alloc(32, 7).toString('base64');

function completeEnv(overrides = {}) {
  return {
    PORT: '3000',
    APP_BASE_URL: 'https://assistant.example.com',
    APP_API_TOKEN: 'api-token-with-at-least-32-characters-ok',
    TOKEN_ENCRYPTION_KEY: encryptionKey,
    APP_OWNER_EMAIL: 'owner@example.com',
    APP_OWNER_PHONE_E164: '+201234567890',
    GOOGLE_CLIENT_ID: '123456789012-abcdefghijklmnop.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'GOCSPX-abcdefghijklmnopqrstuvwx',
    GOOGLE_REDIRECT_URI: 'https://assistant.example.com/auth/google/callback',
    ...overrides
  };
}

const byId = (report, id) => report.checks.find((item) => item.id === id);
const statuses = (report) => Object.fromEntries(report.checks.map((item) => [item.id, item.status]));

test('GOOG-002: a complete public HTTPS environment passes with no blocking check', () => {
  const report = preflightGoogleConfig(completeEnv());
  assert.equal(report.ok, true);
  assert.equal(report.summary.fail, 0);
  assert.equal(report.summary.warn, 0);
  assert.equal(statuses(report).redirect_uri, 'pass');
  assert.equal(statuses(report).owner_email, 'pass');
});

test('GOOG-002: missing credentials block and point at the OAuth client, not at code', () => {
  const report = preflightGoogleConfig(completeEnv({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: 'replace-with-me' }));
  assert.equal(report.ok, false);
  assert.equal(statuses(report).client_id, 'fail');
  assert.equal(statuses(report).client_secret, 'fail');
  assert.match(byId(report, 'client_id').fix, /OAuth client ID/);
  assert.match(byId(report, 'client_secret').fix, /never a chat/);
});

test('GOOG-002: a non-Web client ID is flagged as a warning instead of silently failing later', () => {
  const report = preflightGoogleConfig(completeEnv({ GOOGLE_CLIENT_ID: 'AIzaSyNotAnOAuthClientId' }));
  assert.equal(statuses(report).client_id, 'warn');
  assert.equal(report.ok, true);
});

test('GOOG-002: the classic redirect_uri_mismatch is caught before Google is contacted', () => {
  const wrongPath = preflightGoogleConfig(completeEnv({ GOOGLE_REDIRECT_URI: 'https://assistant.example.com/auth/google' }));
  assert.equal(statuses(wrongPath).redirect_uri, 'fail');
  assert.match(byId(wrongPath, 'redirect_uri').detail, /only serves/);

  const trailingSlash = preflightGoogleConfig(completeEnv({ GOOGLE_REDIRECT_URI: 'https://assistant.example.com/auth/google/callback/' }));
  assert.equal(statuses(trailingSlash).redirect_uri, 'fail');
  assert.match(byId(trailingSlash, 'redirect_uri').fix, /no trailing slash/);

  const plainHttp = preflightGoogleConfig(completeEnv({
    GOOGLE_REDIRECT_URI: 'http://assistant.example.com/auth/google/callback'
  }));
  assert.equal(statuses(plainHttp).redirect_uri, 'fail');
  assert.match(byId(plainHttp, 'redirect_uri').detail, /requires https/);
});

test('GOOG-002: localhost is allowed but reported as a warn tied to the missing public host', () => {
  const report = preflightGoogleConfig({
    ...completeEnv({ APP_BASE_URL: 'http://localhost:3000', GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback' })
  });
  assert.equal(report.ok, true);
  assert.equal(statuses(report).redirect_uri, 'pass');
  assert.equal(statuses(report).public_base_url, 'warn');
  assert.match(byId(report, 'public_base_url').detail, /HOST-003/);
});

test('GOOG-002: a host split between APP_BASE_URL and the redirect URI is surfaced', () => {
  const report = preflightGoogleConfig(completeEnv({
    APP_BASE_URL: 'https://assistant.example.com',
    GOOGLE_REDIRECT_URI: 'https://other.example.org/auth/google/callback'
  }));
  assert.equal(statuses(report).base_url_alignment, 'warn');
  assert.match(byId(report, 'base_url_alignment').detail, /different hosts/);
});

test('GOOG-002: a missing owner email is blocking, because it disables the identity check', () => {
  const report = preflightGoogleConfig(completeEnv({ APP_OWNER_EMAIL: '' }));
  assert.equal(report.ok, false);
  assert.equal(statuses(report).owner_email, 'fail');
  assert.match(byId(report, 'owner_email').detail, /ANY Google account/);
});

test('GOOG-002: the WhatsApp owner command needs an E.164 number to fire', () => {
  const missing = preflightGoogleConfig(completeEnv({ APP_OWNER_PHONE_E164: '' }));
  assert.equal(missing.ok, true);
  assert.equal(statuses(missing).owner_phone, 'warn');

  const malformed = preflightGoogleConfig(completeEnv({ APP_OWNER_PHONE_E164: '0020 123 456 7890' }));
  assert.equal(statuses(malformed).owner_phone, 'warn');
  assert.match(byId(malformed, 'owner_phone').fix, /no spaces/);
});

test('GOOG-002: local secrets and the feature switch are blocking when broken', () => {
  const report = preflightGoogleConfig(completeEnv({
    TOKEN_ENCRYPTION_KEY: 'too-short',
    APP_API_TOKEN: 'short',
    CELIA_DISABLE_GOOGLE: 'true'
  }));
  assert.equal(report.ok, false);
  assert.equal(statuses(report).encryption_key, 'fail');
  assert.equal(statuses(report).api_token, 'fail');
  assert.equal(statuses(report).feature_switch, 'fail');
});

test('GOOG-002: the rendered report never contains a secret, even on failure', () => {
  const env = completeEnv({ GOOGLE_CLIENT_ID: '123456789012-abcdefghijklmnop.apps.googleusercontent.com' });
  const report = preflightGoogleConfig(env);
  const rendered = formatPreflightReport(report) + JSON.stringify(report);
  for (const name of ['GOOGLE_CLIENT_SECRET', 'APP_API_TOKEN', 'TOKEN_ENCRYPTION_KEY']) {
    assert.equal(rendered.includes(env[name]), false, `${name} leaked into the preflight output`);
  }
  assert.equal(rendered.includes(encryptionKey), false);
  assert.equal(rendered.includes('GOCSPX-'), false);
});
