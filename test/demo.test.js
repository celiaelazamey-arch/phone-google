import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createDemoApp, demoReply } from '../src/demo-app.js';

const demo = await createDemoApp({ env: { PORT: '0' } });
const server = demo.app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
demo.setLocalOrigin(base);

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await demo.pool.end();
});

const auth = { authorization: `Bearer ${demo.config.apiToken}`, 'content-type': 'application/json' };
const get = (path, headers = auth) => fetch(`${base}${path}`, { headers });
const post = (path, body, headers = auth) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
const phonePath = '/api/whatsapp/contacts/14155552671/consent';

test('demo boots the real production routers with mode=demo and no secrets on disk', async () => {
  const health = await get('/health', {});
  assert.equal(health.status, 200);
  assert.deepEqual((await health.json()).mode, 'demo');

  const html = await get('/', {});
  assert.equal(html.status, 200);
  assert.match(await html.text(), /demo-token/);
  const css = await get('/demo/static/demo.css', {});
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /css/);

  const blocked = await get('/api/google/gmail/search?q=report', {});
  assert.equal(blocked.status, 401);
});

test('Google endpoints stay disconnected until an encrypted credential is stored', async () => {
  assert.equal((await get('/api/google/gmail/search?q=report')).status, 409);
  const connect = await post('/demo/google/connect', {});
  assert.equal(connect.status, 200);
  assert.equal((await connect.json()).encrypted, true);
  assert.equal(demo.pool.credentials.size, 1);
  assert.match(demo.pool.credentials.get('owner').encrypted, /^v1\./);

  const gmail = await get('/api/google/gmail/search?q=report');
  assert.equal(gmail.status, 200);
  assert.equal((await gmail.json()).messages.length, 2);
  assert.equal((await get('/api/google/drive/search?q=x')).status, 200);
  assert.equal((await get('/api/google/calendar/events?days=7')).status, 200);
  assert.equal((await get('/api/google/contacts/search?q=%D8%A3%D8%AD%D9%85%D8%AF')).status, 200);

  const start = new Date(Date.now() + 3600_000).toISOString();
  const end = new Date(Date.now() + 5400_000).toISOString();
  const created = await post('/api/google/calendar/events', { summary: 'موعد', start, end });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).event.summary, 'موعد');
});

test('signed inbound webhook triggers one Gemini-style reply only after both consents', async () => {
  const inboundWithoutConsent = await post('/demo/webhook/inbound', { text: 'مرحبا' });
  assert.equal(inboundWithoutConsent.status, 200);
  assert.equal((await inboundWithoutConsent.json()).status, 200);
  assert.equal(demo.outbox.length, 0, 'no reply without documented consent');

  assert.equal((await post(phonePath, { optedIn: true, aiOptedIn: true, source: 'نموذج موافقة موثق' })).status, 200);
  const inbound = await post('/demo/webhook/inbound', { text: 'ما هي مواعيد العمل؟' });
  const result = await inbound.json();
  assert.equal(result.status, 200);
  assert.equal(result.accepted, true);
  assert.equal(demo.outbox.length, 1);
  assert.match(demo.outbox[0].text, /أهلًا|شكرًا/);

  const state = await (await get('/demo/state')).json();
  assert.ok(state.messages.some((row) => row.direction === 'outbound' && row.status === 'sent'));
  assert.equal(state.googleConnected, true);

  // Replaying the exact same provider message id must not create a second reply.
  const replay = await post('/demo/webhook/inbound', { text: 'ما هي مواعيد العمل؟', messageId: result.messageId });
  assert.equal((await replay.json()).status, 200);
  assert.equal(demo.outbox.length, 1, 'duplicate webhook delivery ignored');
});

test('forged HMAC signature is rejected by the real webhook route', async () => {
  const forged = await post('/demo/webhook/inbound', { text: 'محاولة تزوير', badSignature: true });
  const result = await forged.json();
  assert.equal(result.status, 401);
  assert.equal(result.accepted, false);
  assert.equal(demo.outbox.length, 1);
});

test('withdrawing consent stops auto-replies, and direct sends need consent + 24h window', async () => {
  assert.equal((await post(phonePath, { optedIn: false })).status, 200);
  const inbound = await post('/demo/webhook/inbound', { text: 'رسالة بعد سحب الموافقة' });
  assert.equal((await inbound.json()).status, 200);
  assert.equal(demo.outbox.length, 1, 'no AI reply after withdrawal');

  const denied = await post('/api/whatsapp/messages', { phone: '+14155552671', text: 'مرحبًا' });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, 'recipient_has_not_opted_in');

  assert.equal((await post(phonePath, { optedIn: true, aiOptedIn: false, source: 'نموذج موافقة موثق' })).status, 200);
  const accepted = await post('/api/whatsapp/messages', { phone: '+14155552671', text: 'مرحبًا' });
  assert.equal(accepted.status, 202);
  assert.equal(demo.outbox.length, 2);
});

test('demo provider is offline-only and refuses production or unknown URLs', async () => {
  await assert.rejects(createDemoApp({ env: { NODE_ENV: 'production' } }), /DEMO_MODE_REFUSED/);
  await assert.rejects(demo.config.demo.fetchImpl('https://example.com/steal', {}), /unexpected outbound URL/);
  assert.match(demoReply('كم السعر؟'), /الفريق/);
  assert.match(demoReply('مرحبًا'), /أهلًا/);
});

test('reset clears all in-memory state', async () => {
  assert.equal((await post('/demo/reset', {})).status, 200);
  const state = await (await get('/demo/state')).json();
  assert.equal(state.googleConnected, false);
  assert.equal(state.contacts.length, 0);
  assert.equal(state.outbox.length, 0);
  assert.equal(demo.outbox.length, 0);
});
