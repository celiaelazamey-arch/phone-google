import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import worker from '../workers/celia-edge/worker.js';
import {
  decryptEdgeJson,
  encryptEdgeJson,
  mintEdgeConsentTicket,
  verifyEdgeConsentTicket,
  verifyWhatsAppSignatureWeb
} from '../workers/celia-edge/crypto.js';
import { loadAllMigrationsSql, splitSqlStatements } from '../scripts/deploy-cloudflare-edge.mjs';
import { verifyLive } from '../scripts/verify-live.mjs';
import { MCP_TOOLS } from '../src/celia-mcp.js';
import { encryptJson } from '../src/security.js';

const OWNER_TOKEN = 'edge-owner-token-'.padEnd(48, 'z');
const WA_SECRET = 'meta-webhook-secret-2026';
const WA_VERIFY = 'meta-verify-token-2026';

async function createSqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  const sql = await loadAllMigrationsSql();
  for (const statement of splitSqlStatements(sql)) {
    sqlite.exec(statement);
  }
  return {
    sqlite,
    prepare(query) {
      let boundParams = [];
      return {
        bind(...args) {
          boundParams = args.map((v) => (v === undefined ? null : v));
          return this;
        },
        async run() {
          const stmt = sqlite.prepare(query);
          const info = stmt.run(...boundParams);
          return { success: true, meta: { changes: info.changes } };
        },
        async first() {
          const stmt = sqlite.prepare(query);
          return stmt.get(...boundParams) ?? null;
        },
        async all() {
          const stmt = sqlite.prepare(query);
          return { results: stmt.all(...boundParams) };
        }
      };
    }
  };
}

function signMetaBody(rawText, secret = WA_SECRET) {
  return `sha256=${crypto.createHmac('sha256', secret).update(rawText, 'utf8').digest('hex')}`;
}

test('card-free Edge Crypto: HKDF derived key + explicit v2 key + v1 compatibility + consent ticket + raw HMAC', async () => {
  const envHkdf = { CELIA_MCP_API_TOKEN: OWNER_TOKEN };
  const sealed = await encryptEdgeJson({ access_token: 'ya29.test', refresh_token: '1//ref' }, envHkdf);
  assert.match(sealed, /^v2\.hkdf-mcp\./);
  const opened = await decryptEdgeJson(sealed, envHkdf);
  assert.equal(opened.refresh_token, '1//ref');

  // Explicit 32-byte key with custom keyId
  const explicitRaw = crypto.randomBytes(32).toString('base64');
  const envExplicit = {
    CELIA_MCP_API_TOKEN: OWNER_TOKEN,
    TOKEN_ENCRYPTION_KEY: explicitRaw,
    TOKEN_ENCRYPTION_KEY_ID: 'k2026'
  };
  const sealedK = await encryptEdgeJson({ scope: 'gmail.readonly' }, envExplicit);
  assert.match(sealedK, /^v2\.k2026\./);
  assert.deepEqual(await decryptEdgeJson(sealedK, envExplicit), { scope: 'gmail.readonly' });
  // HKDF tokens created earlier still decrypt when explicit key is added later!
  assert.equal((await decryptEdgeJson(sealed, envExplicit)).refresh_token, '1//ref');

  // Tampered keyId in v2 envelope is rejected by AAD
  const parts = sealedK.split('.');
  parts[1] = 'hkdf-mcp';
  await assert.rejects(() => decryptEdgeJson(parts.join('.'), envExplicit));

  // Missing secrets fail closed (503)
  await assert.rejects(() => encryptEdgeJson({ a: 1 }, {}), /encryption_key_unavailable/);

  // Short-lived browser consent ticket
  const ticket = await mintEdgeConsentTicket(envHkdf, { userId: 'owner', ttlSeconds: 300, nowMs: 1_000_000 });
  const okTicket = await verifyEdgeConsentTicket(envHkdf, ticket, { nowMs: 1_100_000 });
  assert.deepEqual(okTicket, { ok: true, userId: 'owner' });
  const expired = await verifyEdgeConsentTicket(envHkdf, ticket, { nowMs: 2_000_000 });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, 'expired_ticket');
  const forged = await verifyEdgeConsentTicket(envHkdf, `${ticket}x`, { nowMs: 1_100_000 });
  assert.equal(forged.ok, false);

  // Raw bytes Meta HMAC-SHA256
  const body = '{"object":"whatsapp_business_account"}';
  const sig = signMetaBody(body);
  assert.equal(await verifyWhatsAppSignatureWeb(new TextEncoder().encode(body), sig, WA_SECRET), true);
  assert.equal(await verifyWhatsAppSignatureWeb(new TextEncoder().encode(`${body} `), sig, WA_SECRET), false);
});

test('card-free Edge MCP Server: exact 12 official Celia tools parity, 401 gate, initialize, AI reply, and skills', async () => {
  const DB = await createSqliteD1();
  const upstreamCalls = [];
  const env = {
    DB,
    CELIA_MCP_API_TOKEN: OWNER_TOKEN,
    GEMINI_API_KEY: 'AIzaSyCardFreeEdgeTest',
    GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'GOCSPX-secret',
    PHONE_NUMBER: '+201011122233',
    __FETCH_IMPL: async (url) => {
      upstreamCalls.push(String(url));
      if (String(url).includes('generativelanguage.googleapis.com')) {
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'أهلًا بك! يسعدنا خدمتك عبر خادم سيليا المجاني.' }] } }]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }
  };

  // Anonymous /mcp is rejected with 401
  const anon = await worker.fetch(new Request('https://celia.workers.dev/mcp', { method: 'POST', body: '{}' }), env);
  assert.equal(anon.status, 401);

  const callRpc = async (body) => {
    const res = await worker.fetch(
      new Request('https://celia.workers.dev/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${OWNER_TOKEN}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      }),
      env
    );
    return { status: res.status, json: res.status === 202 ? null : await res.json() };
  };

  const init = await callRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(init.status, 200);
  assert.equal(init.json.result.protocolVersion, '2025-03-26');

  const notif = await callRpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notif.status, 202);

  const list = await callRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const edgeToolNames = list.json.result.tools.map((t) => t.name).sort();
  const nodeToolNames = MCP_TOOLS.map((t) => t.name).sort();
  assert.deepEqual(edgeToolNames, nodeToolNames, 'Edge Worker MCP tools must match the 12 official Celia MCP tools');

  // Call celia_ai_reply -> hits Gemini
  const aiCall = await callRpc({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'celia_ai_reply', arguments: { customerMessage: 'مرحبًا، ما مواعيد العمل؟' } }
  });
  assert.equal(aiCall.json.result.isError, false);
  const aiPayload = JSON.parse(aiCall.json.result.content[0].text);
  assert.equal(aiPayload.provider, 'gemini');
  assert.match(aiPayload.reply, /أهلًا بك/);

  // Call celia_status & find_skills
  const statusCall = await callRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'celia_status', arguments: {} } });
  const statusPayload = JSON.parse(statusCall.json.result.content[0].text);
  assert.equal(statusPayload.cardFreeHosting, true);
  assert.equal(statusPayload.storage.mode, 'd1');

  const skillsRes = await worker.fetch(new Request('https://celia.workers.dev/api/skills?category=google'), env);
  assert.equal(skillsRes.status, 200);
  const skillsBody = await skillsRes.json();
  assert.equal(skillsBody.total, 5);
});

test('card-free Edge Google OAuth2 + Gmail + Drive + Idempotent Calendar + Contacts over real SQLite D1', async () => {
  const DB = await createSqliteD1();
  let calendarPostCount = 0;
  const env = {
    DB,
    CELIA_MCP_API_TOKEN: OWNER_TOKEN,
    GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'GOCSPX-secret',
    APP_OWNER_EMAIL: 'celiaelazamey@gmail.com',
    __FETCH_IMPL: async (url, init = {}) => {
      const target = String(url);
      if (target === 'https://oauth2.googleapis.com/token') {
        const params = new URLSearchParams(String(init.body));
        if (params.get('grant_type') === 'authorization_code') {
          return new Response(
            JSON.stringify({
              access_token: 'expired-initial-token',
              refresh_token: '1//edge-durable-refresh',
              expires_in: -10,
              scope: 'openid email https://www.googleapis.com/auth/gmail.readonly'
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (params.get('grant_type') === 'refresh_token') {
          assert.equal(params.get('refresh_token'), '1//edge-durable-refresh');
          return new Response(
            JSON.stringify({ access_token: 'fresh-access-token', expires_in: 3600 }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
      }
      if (target === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return new Response(
          JSON.stringify({ email: 'celiaelazamey@gmail.com', email_verified: true }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (target.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages?')) {
        return new Response(JSON.stringify({ messages: [{ id: 'm1' }] }), { status: 200 });
      }
      if (target.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages/m1')) {
        return new Response(
          JSON.stringify({
            id: 'm1',
            snippet: 'تفاصيل الاجتماع القادم',
            labelIds: ['INBOX', 'UNREAD'],
            internalDate: '1761650000000',
            payload: {
              headers: [
                { name: 'From', value: 'team@example.com' },
                { name: 'Subject', value: 'موعد المراجعة' }
              ]
            }
          }),
          { status: 200 }
        );
      }
      if (target.startsWith('https://www.googleapis.com/drive/v3/files')) {
        return new Response(JSON.stringify({ files: [{ id: 'f1', name: 'Celia Plan.pdf' }] }), { status: 200 });
      }
      if (target.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events')) {
        if (init.method === 'POST') {
          calendarPostCount += 1;
          return new Response(JSON.stringify({ id: 'ev-1', summary: 'اجتماع سيليا', htmlLink: 'https://cal.example/1' }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ items: [{ id: 'ev-1', summary: 'اجتماع سيليا', start: { dateTime: '2026-10-29T10:00:00Z' } }] }),
          { status: 200 }
        );
      }
      if (target.startsWith('https://people.googleapis.com/v1/people:searchContacts')) {
        return new Response(
          JSON.stringify({
            results: [{ person: { resourceName: 'people/c1', names: [{ displayName: 'Celia' }], emailAddresses: [{ value: 'c@example.com' }] } }]
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected google url: ${target}`);
    }
  };

  // 1. Start OAuth via /auth/google/link
  const linkRes = await worker.fetch(
    new Request('https://celia.workers.dev/auth/google/link', {
      method: 'POST',
      headers: { authorization: `Bearer ${OWNER_TOKEN}` }
    }),
    env
  );
  assert.equal(linkRes.status, 200);
  const linkBody = await linkRes.json();
  const state = new URL(linkBody.url).searchParams.get('state');
  assert.ok(state.length >= 32);

  // 2. Complete OAuth callback -> stores encrypted refresh_token in D1 and writes audit hash chain
  const cbRes = await worker.fetch(
    new Request(`https://celia.workers.dev/auth/google/callback?code=auth-code-1&state=${state}`),
    env
  );
  assert.equal(cbRes.status, 200);
  assert.match(await cbRes.text(), /تم ربط حساب Google بنجاح/);

  // Replaying the same state is rejected (single-use state)
  const replayRes = await worker.fetch(
    new Request(`https://celia.workers.dev/auth/google/callback?code=auth-code-1&state=${state}`),
    env
  );
  assert.equal(replayRes.status, 400);

  // Verify raw D1 row is encrypted (never plaintext refresh_token)
  const rawRow = DB.sqlite.prepare('SELECT encrypted_tokens FROM google_credentials WHERE user_id = ?').get('owner');
  assert.match(rawRow.encrypted_tokens, /^v2\./);
  assert.equal(rawRow.encrypted_tokens.includes('1//edge-durable-refresh'), false);

  // 3. Exercise Gmail (also triggers automatic refresh_token -> fresh-access-token exchange!), Drive, Calendar, Contacts
  const authHeader = { authorization: `Bearer ${OWNER_TOKEN}` };
  const gmailRes = await worker.fetch(new Request('https://celia.workers.dev/api/google/gmail/search?q=موعد', { headers: authHeader }), env);
  assert.equal(gmailRes.status, 200);
  const gmailBody = await gmailRes.json();
  assert.equal(gmailBody.messages[0].subject, 'موعد المراجعة');

  const driveRes = await worker.fetch(new Request('https://celia.workers.dev/api/google/drive/search?q=Celia', { headers: authHeader }), env);
  assert.equal((await driveRes.json()).files[0].name, 'Celia Plan.pdf');

  const contactsRes = await worker.fetch(new Request('https://celia.workers.dev/api/google/contacts/search?q=Celia', { headers: authHeader }), env);
  assert.equal((await contactsRes.json()).contacts[0].name, 'Celia');

  // Idempotent Calendar event creation: sending twice with the same Idempotency-Key calls Google API only once!
  const eventPayload = JSON.stringify({
    summary: 'اجتماع سيليا',
    start: '2026-10-29T10:00:00Z',
    end: '2026-10-29T11:00:00Z'
  });
  const create1 = await worker.fetch(
    new Request('https://celia.workers.dev/api/google/calendar/events', {
      method: 'POST',
      headers: { ...authHeader, 'content-type': 'application/json', 'idempotency-key': 'cal-key-0001' },
      body: eventPayload
    }),
    env
  );
  assert.equal(create1.status, 201);
  const create2 = await worker.fetch(
    new Request('https://celia.workers.dev/api/google/calendar/events', {
      method: 'POST',
      headers: { ...authHeader, 'content-type': 'application/json', 'idempotency-key': 'cal-key-0001' },
      body: eventPayload
    }),
    env
  );
  assert.equal(create2.status, 201);
  assert.equal((await create2.json()).deduplicated, true);
  assert.equal(calendarPostCount, 1);

  // Disconnect clears D1 credentials
  const discRes = await worker.fetch(new Request('https://celia.workers.dev/api/google/disconnect', { method: 'POST', headers: authHeader }), env);
  assert.equal((await discRes.json()).connected, false);
});

test('card-free Edge WhatsApp Webhook (challenge + raw HMAC + D1 dedup + owner «اربط جوجل» + 24h consent gate)', async () => {
  const DB = await createSqliteD1();
  const sentMessages = [];
  const env = {
    DB,
    CELIA_MCP_API_TOKEN: OWNER_TOKEN,
    GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'GOCSPX-secret',
    PHONE_NUMBER: '+201099887766',
    WHATSAPP_VERIFY_TOKEN: WA_VERIFY,
    WHATSAPP_APP_SECRET: WA_SECRET,
    WHATSAPP_ACCESS_TOKEN: 'meta-access-tok',
    WHATSAPP_PHONE_NUMBER_ID: '123456789012',
    __FETCH_IMPL: async (url, init = {}) => {
      if (String(url).includes('graph.facebook.com')) {
        const parsed = JSON.parse(init.body);
        sentMessages.push(parsed);
        return new Response(JSON.stringify({ messages: [{ id: `wamid.out.${sentMessages.length}` }] }), { status: 200 });
      }
      throw new Error(`unexpected url: ${url}`);
    }
  };

  // 1. GET challenge verification
  const challengeOk = await worker.fetch(
    new Request(`https://celia.workers.dev/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${WA_VERIFY}&hub.challenge=987654`),
    env
  );
  assert.equal(challengeOk.status, 200);
  assert.equal(await challengeOk.text(), '987654');

  const challengeBad = await worker.fetch(
    new Request('https://celia.workers.dev/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=987654'),
    env
  );
  assert.equal(challengeBad.status, 403);

  // 2. POST owner «اربط جوجل» signed with raw HMAC -> sends single-use /auth/google?ticket=... link, and deduplicates retries
  const webhookPayload = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              messages: [{ id: 'wamid.in.1', from: '201099887766', type: 'text', text: { body: 'اربط جوجل' } }]
            }
          }
        ]
      }
    ]
  });
  const sig = signMetaBody(webhookPayload);

  // Tampered body fails 401
  const tampered = await worker.fetch(
    new Request('https://celia.workers.dev/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sig },
      body: `${webhookPayload} `
    }),
    env
  );
  assert.equal(tampered.status, 401);

  // Authentic webhook processes once
  const wh1 = await worker.fetch(
    new Request('https://celia.workers.dev/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sig },
      body: webhookPayload
    }),
    env
  );
  assert.equal(wh1.status, 200);
  assert.deepEqual(await wh1.json(), { ok: true, processed: 1, duplicates: 0 });
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text.body, /https:\/\/celia\.workers\.dev\/auth\/google\?ticket=/);

  // Duplicate retry from Meta does NOT send a second message!
  const wh2 = await worker.fetch(
    new Request('https://celia.workers.dev/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sig },
      body: webhookPayload
    }),
    env
  );
  assert.deepEqual(await wh2.json(), { ok: true, processed: 0, duplicates: 1 });
  assert.equal(sentMessages.length, 1);

  // Follow the minted ticket URL in browser -> 302 redirect to Google OAuth!
  const ticketUrl = sentMessages[0].text.body.match(/https:\/\/[^\s]+/)[0];
  const browserRedirect = await worker.fetch(new Request(ticketUrl), env);
  assert.equal(browserRedirect.status, 302);
  assert.match(browserRedirect.headers.get('location') || '', /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);

  // 3. Outbound send enforces explicit opt-in AND 24-hour customer care window
  const authHeaders = { authorization: `Bearer ${OWNER_TOKEN}`, 'content-type': 'application/json' };
  const blockedNoOptIn = await worker.fetch(
    new Request('https://celia.workers.dev/api/whatsapp/messages', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ phone: '+201099887766', text: 'رسالة اختبار' })
    }),
    env
  );
  assert.equal(blockedNoOptIn.status, 403);

  await worker.fetch(
    new Request('https://celia.workers.dev/api/whatsapp/consent', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ phone: '+201099887766', optedIn: true, aiOptedIn: true, source: 'owner-test' })
    }),
    env
  );

  const allowed = await worker.fetch(
    new Request('https://celia.workers.dev/api/whatsapp/messages', {
      method: 'POST',
      headers: { ...authHeaders, 'idempotency-key': 'wa-send-0001' },
      body: JSON.stringify({ phone: '+201099887766', text: 'تم التفعيل بنجاح' })
    }),
    env
  );
  assert.equal(allowed.status, 200);
  assert.equal(sentMessages.length, 2);
});

test('verify:live --mode edge passes against the Cloudflare Edge + D1 runtime and never leaks the token', async (t) => {
  const DB = await createSqliteD1();
  const env = {
    DB,
    CELIA_VERSION: '0.2.1',
    CELIA_BUILD_SHA: 'e'.repeat(40),
    CELIA_MCP_API_TOKEN: OWNER_TOKEN
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const webReq = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method,
      headers: req.headers,
      ...(body && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {})
    });
    const webRes = await worker.fetch(webReq, env);
    res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
    res.end(Buffer.from(await webRes.arrayBuffer()));
  });

  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const report = await verifyLive({
    url: baseUrl,
    mode: 'edge',
    token: OWNER_TOKEN,
    allowHttp: true,
    expectVersion: '0.2.1',
    expectCommit: 'e'.repeat(40),
    samples: 2
  });

  assert.equal(report.verdict, 'pass', JSON.stringify(report.checks));
  const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  assert.equal(byId.ready_durable.status, 'pass');
  assert.equal(byId.edge_auth_gate.status, 'pass');
  assert.equal(byId.edge_mcp_tools.status, 'pass');
  assert.equal(byId.edge_mcp_tools.detail.toolsCount, 12);
  assert.equal(byId.edge_cron_governed.status, 'pass', JSON.stringify(byId.edge_cron_governed));
  assert.equal(byId.edge_cron_governed.detail.writes, 'outbox-approval-only');
  assert.equal(byId.edge_cron_governed.detail.durable, true);
  assert.equal(byId.edge_cron_governed.detail.decision, 'DEC-042');
  assert.equal(byId.edge_cron_governed.detail.outbox.error, undefined, 'the 0003 outbox table answers the count query');
  assert.equal(JSON.stringify(report).includes(OWNER_TOKEN), false);
});

test('card-free Edge full integration: Node v1 envelope compat + all 12 MCP tools/call + owner Gmail/Calendar WhatsApp commands + /api/live', async () => {
  // 1. Node src/security.js v1.* envelope decrypts cleanly inside Edge WebCrypto
  const rawKeyB64 = crypto.randomBytes(32).toString('base64');
  const v1Envelope = encryptJson({ refresh_token: 'node-v1-refresh' }, rawKeyB64);
  assert.match(v1Envelope, /^v1\./);
  const openedV1 = await decryptEdgeJson(v1Envelope, { TOKEN_ENCRYPTION_KEY: rawKeyB64 });
  assert.equal(openedV1.refresh_token, 'node-v1-refresh');

  // 2. Seed D1 with connected Google credentials + WhatsApp contact
  const DB = await createSqliteD1();
  const outboundTexts = [];
  const env = {
    DB,
    CELIA_MCP_API_TOKEN: OWNER_TOKEN,
    GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'GOCSPX-secret',
    GEMINI_API_KEY: 'AIzaSyTest',
    PHONE_NUMBER: '+201055566677',
    WHATSAPP_VERIFY_TOKEN: WA_VERIFY,
    WHATSAPP_APP_SECRET: WA_SECRET,
    WHATSAPP_ACCESS_TOKEN: 'meta-tok',
    WHATSAPP_PHONE_NUMBER_ID: '99887766',
    WHATSAPP_AUTO_REPLY_ENABLED: 'true',
    __FETCH_IMPL: async (url, init = {}) => {
      const target = String(url);
      if (target === 'https://oauth2.googleapis.com/token') {
        return new Response(
          JSON.stringify({ access_token: 'tok-live', refresh_token: 'ref-live', expires_in: 3600, scope: 'email calendar gmail' }),
          { status: 200 }
        );
      }
      if (target === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return new Response(JSON.stringify({ email: 'owner@example.com', email_verified: true }), { status: 200 });
      }
      if (target.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages?')) {
        return new Response(JSON.stringify({ messages: [{ id: 'gm-9' }] }), { status: 200 });
      }
      if (target.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages/gm-9')) {
        return new Response(
          JSON.stringify({
            id: 'gm-9',
            snippet: 'ملخص التقرير المالي للربع الرابع جاهز للاعتماد',
            labelIds: ['INBOX'],
            payload: { headers: [{ name: 'From', value: 'CFO <cfo@example.com>' }, { name: 'Subject', value: 'التقرير المالي' }] }
          }),
          { status: 200 }
        );
      }
      if (target.startsWith('https://www.googleapis.com/drive/v3/files')) {
        return new Response(JSON.stringify({ files: [{ id: 'dr-1', name: 'Budget.xlsx' }] }), { status: 200 });
      }
      if (target.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events')) {
        if (init.method === 'POST') {
          return new Response(JSON.stringify({ id: 'ev-99', summary: 'متابعة', htmlLink: 'https://cal.example/99' }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            items: [{ id: 'ev-99', summary: 'اجتماع مجلس الإدارة', start: { dateTime: '2026-10-28T14:00:00Z' }, location: 'القاهرة' }]
          }),
          { status: 200 }
        );
      }
      if (target.startsWith('https://people.googleapis.com/v1/people:searchContacts')) {
        return new Response(JSON.stringify({ results: [{ person: { resourceName: 'people/1', names: [{ displayName: 'أحمد' }] } }] }), { status: 200 });
      }
      if (target.includes('graph.facebook.com')) {
        outboundTexts.push(JSON.parse(init.body).text.body);
        return new Response(JSON.stringify({ messages: [{ id: `wamid.${outboundTexts.length}` }] }), { status: 200 });
      }
      if (target.includes('generativelanguage.googleapis.com')) {
        // Simulate Gemini upstream failure once when asked for fallback test
        if (String(init.body).includes('FALLBACK_TRIGGER')) {
          return new Response('upstream error', { status: 502 });
        }
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: 'رد ذكي تلقائي للعميل' }] } }] }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected url: ${target}`);
    }
  };

  const authHeaders = { authorization: `Bearer ${OWNER_TOKEN}`, 'content-type': 'application/json' };
  const mcpCall = async (name, args = {}) => {
    const res = await worker.fetch(
      new Request('https://celia.workers.dev/mcp', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name, arguments: args } })
      }),
      env
    );
    const json = await res.json();
    assert.equal(json.result.isError, false, `${name} failed: ${JSON.stringify(json)}`);
    return JSON.parse(json.result.content[0].text);
  };

  // Connect Google via POST /auth/google/link + callback
  const linkResp = await worker.fetch(
    new Request('https://celia.workers.dev/auth/google/link', { method: 'POST', headers: authHeaders }),
    env
  );
  const linkData = await linkResp.json();
  const state = new URL(linkData.url).searchParams.get('state');
  await worker.fetch(new Request(`https://celia.workers.dev/auth/google/callback?code=c1&state=${state}`), env);

  // Exercise all official Celia MCP tools via tools/call
  assert.equal((await mcpCall('system_live_view')).google.connected, true);
  assert.equal((await mcpCall('google_gmail_search', { q: 'تقرير' })).messages.length, 1);
  assert.equal((await mcpCall('google_drive_search', { q: 'Budget' })).files.length, 1);
  assert.equal((await mcpCall('google_calendar_events_list', { days: 7 })).events.length, 1);
  assert.equal(
    (await mcpCall('google_calendar_events_create', { summary: 'متابعة', start: '2026-10-29T09:00:00Z', end: '2026-10-29T09:30:00Z' })).id,
    'ev-99'
  );
  assert.equal((await mcpCall('google_contacts_search', { q: 'أحمد' })).contacts.length, 1);
  assert.equal((await mcpCall('find_skills', { query: 'gmail' })).total >= 1, true);

  // Seed inbound WhatsApp message from owner («لخص آخر إيميل») + («هات جدولي») + opted-in customer message
  const sendWebhook = async (id, from, bodyText) => {
    const raw = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [{ id, from, type: 'text', text: { body: bodyText } }] } }] }]
    });
    const res = await worker.fetch(
      new Request('https://celia.workers.dev/webhooks/whatsapp', {
        method: 'POST',
        headers: { 'x-hub-signature-256': signMetaBody(raw) },
        body: raw
      }),
      env
    );
    assert.equal(res.status, 200);
  };

  await sendWebhook('wamid.owner.email', '201055566677', 'لخص آخر إيميل');
  assert.match(outboundTexts.at(-1), /التقرير المالي/);

  await sendWebhook('wamid.owner.cal', '201055566677', 'هات جدولي');
  assert.match(outboundTexts.at(-1), /اجتماع مجلس الإدارة/);

  // Opt-in a customer via MCP and verify AI auto-reply on inbound message + MCP send + contacts list
  await mcpCall('whatsapp_consent_upsert', { phone: '+201012345678', optedIn: true, aiOptedIn: true, source: 'mcp-test' });
  await sendWebhook('wamid.cust.1', '201012345678', 'عايز أعرف التفاصيل');
  assert.match(outboundTexts.at(-1), /رد ذكي تلقائي للعميل/);
  assert.equal((await mcpCall('whatsapp_contacts_list')).contacts.length, 2);
  assert.equal((await mcpCall('whatsapp_send_text', { phone: '+201012345678', text: 'تأكيد الحجز' })).ok, true);

  // Exercise GET /mcp, GET /api/live, GET /api/google/status, GET /api/google/calendar/events, GET /api/whatsapp/contacts, and POST /api/ai/reply fallback
  assert.equal((await worker.fetch(new Request('https://celia.workers.dev/mcp', { headers: authHeaders }), env)).status, 200);
  const liveBody = await (await worker.fetch(new Request('https://celia.workers.dev/api/live', { headers: authHeaders }), env)).json();
  assert.equal(liveBody.cardFreeHosting, true);
  assert.equal(liveBody.google.connected, true);
  assert.equal((await worker.fetch(new Request('https://celia.workers.dev/api/google/status', { headers: authHeaders }), env)).status, 200);
  assert.equal((await worker.fetch(new Request('https://celia.workers.dev/api/google/calendar/events', { headers: authHeaders }), env)).status, 200);
  assert.equal((await worker.fetch(new Request('https://celia.workers.dev/api/whatsapp/contacts', { headers: authHeaders }), env)).status, 200);

  const fallbackAi = await (
    await worker.fetch(
      new Request('https://celia.workers.dev/api/ai/reply', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ customerMessage: 'FALLBACK_TRIGGER' })
      }),
      env
    )
  ).json();
  assert.equal(fallbackAi.provider, 'local');
  assert.equal(fallbackAi.fallbackReason, 'gemini_http_502');
});

