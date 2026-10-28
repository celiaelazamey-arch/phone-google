// The two outbound doors (WhatsApp send, Google calendar write) are guarded in the router, not only in the UI.
// These tests drive the real Express routers over HTTP with a stub provider, so the refusals are observed end to end.
import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import express from 'express';
import { loadConfig } from '../src/config.js';
import { createGoogleRouter } from '../src/google.js';
import { createMemoryPool } from '../src/memory-pool.js';
import { createWhatsAppApiRouter } from '../src/whatsapp.js';

const token = crypto.randomBytes(32).toString('hex');
const phone = '+201065217834';

function config(overrides = {}) {
  return loadConfig({
    APP_API_TOKEN: token,
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    CELIA_MCP_DISABLE_MYSQL: 'true',
    WHATSAPP_ACCESS_TOKEN: '',
    ...overrides
  });
}

async function serve(build) {
  const pool = createMemoryPool();
  const cfg = config();
  const app = express();
  app.use(express.json());
  app.use(build({ pool, config: cfg }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  return { pool, cfg, request, baseUrl, close: () => new Promise((resolve) => server.close(resolve)) };
}

const authorized = { authorization: `Bearer ${token}` };

test('whatsapp api: the owner token is required before any message can be attempted', async () => {
  const server = await serve(({ pool, config: cfg }) => createWhatsAppApiRouter({ pool, config: cfg }));
  try {
    const anonymous = await server.request('/api/whatsapp/messages', { method: 'POST', body: { phone, text: 'مرحبًا' } });
    assert.equal(anonymous.status, 401);

    const invalid = await server.request('/api/whatsapp/messages', { method: 'POST', headers: authorized, body: { phone: '123', text: '' } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, 'valid_phone_and_text_required');

    const noConsent = await server.request('/api/whatsapp/messages', { method: 'POST', headers: authorized, body: { phone, text: 'مرحبًا' } });
    assert.equal(noConsent.status, 403);
    assert.equal(noConsent.body.error, 'recipient_has_not_opted_in');
  } finally {
    await server.close();
  }
});

test('whatsapp api: a customer outside the 24-hour window is refused, and consent is recorded honestly', async () => {
  const server = await serve(({ pool, config: cfg }) => createWhatsAppApiRouter({ pool, config: cfg }));
  try {
    const badConsent = await server.request(`/api/whatsapp/contacts/${phone.slice(1)}/consent`, {
      method: 'POST', headers: authorized, body: { optedIn: true, aiOptedIn: true }
    });
    assert.equal(badConsent.status, 400);

    const consent = await server.request(`/api/whatsapp/contacts/${phone.slice(1)}/consent`, {
      method: 'POST', headers: authorized, body: { optedIn: true, aiOptedIn: true, source: 'نموذج موافقة' }
    });
    assert.equal(consent.status, 200);
    assert.equal(consent.body.optedIn, true);

    const outsideWindow = await server.request('/api/whatsapp/messages', { method: 'POST', headers: authorized, body: { phone, text: 'مرحبًا' } });
    assert.equal(outsideWindow.status, 403);
    assert.match(outsideWindow.body.error, /outside_customer_service_window/);
  } finally {
    await server.close();
  }
});

test('whatsapp api: inside the window a real send is accepted once and replayed on the same Idempotency-Key', async () => {
  let sends = 0;
  const services = {
    run: async (_name, action) => {
      sends += 1;
      return `wamid.${crypto.randomBytes(4).toString('hex')}`;
    }
  };
  const server = await serve(({ pool, config: cfg }) => createWhatsAppApiRouter({ pool, config: cfg, services }));
  try {
    await server.pool.execute(`INSERT INTO whatsapp_contacts (phone_e164, opted_in, ai_opted_in, consent_source, consented_at) VALUES (?, ?, ?, ?, IF(?, UTC_TIMESTAMP(), NULL))`, [phone, 1, 1, 'نموذج', 1]);
    await server.pool.execute('INSERT INTO whatsapp_contacts (phone_e164, last_inbound_at) VALUES (?, UTC_TIMESTAMP())', [phone]);

    const first = await server.request('/api/whatsapp/messages', {
      method: 'POST', headers: authorized, body: { phone, text: 'مرحبًا', idempotencyKey: 'order-42-abcdef' }
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.status, 'accepted');

    const replay = await server.request('/api/whatsapp/messages', {
      method: 'POST', headers: authorized, body: { phone, text: 'مرحبًا', idempotencyKey: 'order-42-abcdef' }
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body._idempotencyReplay, true);
    assert.equal(sends, 1, 'the provider is called exactly once for one idempotency key');
  } finally {
    await server.close();
  }
});

test('whatsapp api: a provider that is not configured is a 502, never a fake "sent"', async () => {
  const server = await serve(({ pool, config: cfg }) => createWhatsAppApiRouter({ pool, config: cfg }));
  try {
    await server.pool.execute(`INSERT INTO whatsapp_contacts (phone_e164, opted_in, ai_opted_in, consent_source, consented_at) VALUES (?, ?, ?, ?, IF(?, UTC_TIMESTAMP(), NULL))`, [phone, 1, 1, 'نموذج', 1]);
    await server.pool.execute('INSERT INTO whatsapp_contacts (phone_e164, last_inbound_at) VALUES (?, UTC_TIMESTAMP())', [phone]);
    const failed = await server.request('/api/whatsapp/messages', { method: 'POST', headers: authorized, body: { phone, text: 'مرحبًا' } });
    assert.equal(failed.status, 502);
    assert.equal(failed.body.error, 'whatsapp_send_failed');
  } finally {
    await server.close();
  }
});

test('google api: calendar writes and contact reads validate input before touching Google', async () => {
  const server = await serve(({ pool, config: cfg }) => createGoogleRouter({ pool, config: cfg }));
  try {
    const anonymous = await server.request('/api/google/calendar/events', { method: 'POST', body: {} });
    assert.equal(anonymous.status, 401, 'a calendar write needs the owner token');

    const missing = await server.request('/api/google/calendar/events', { method: 'POST', headers: authorized, body: {} });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, 'summary_start_end_required');

    const backwards = await server.request('/api/google/calendar/events', {
      method: 'POST', headers: authorized, body: { summary: 'اجتماع', start: '2026-11-01T10:00:00Z', end: '2026-11-01T09:00:00Z' }
    });
    assert.equal(backwards.status, 400);
    assert.equal(backwards.body.error, 'invalid_event_time_range');

    const noQuery = await server.request('/api/google/contacts/search', { headers: authorized });
    assert.equal(noQuery.status, 400);
    assert.equal(noQuery.body.error, 'query_required');

    // No Google account is linked in this environment: the read must fail loudly, not return an empty inbox.
    const unlinked = await server.request('/api/google/contacts/search?q=ahmed', { headers: authorized });
    assert.ok(unlinked.status >= 400, `expected a failure status, got ${unlinked.status}`);
  } finally {
    await server.close();
  }
});
