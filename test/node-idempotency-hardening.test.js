import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createIdempotencyStore } from '../src/idempotency.js';
import { createWhatsAppApiRouter } from '../src/whatsapp.js';
import { createCeliaMcpApp, createCeliaMcpHandler } from '../src/celia-mcp.js';
import { createSecretsHubRouter } from '../src/secrets-hub.js';
import { createGoogleRouter } from '../src/google.js';

const API_TOKEN = 'node-high05-test-token-with-at-least-32-chars';
const ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');
const PHONE = '+201065217834';

function baseConfig(overrides = {}) {
  return {
    nodeEnv: 'test',
    port: 0,
    baseUrl: 'http://127.0.0.1:3000',
    apiToken: API_TOKEN,
    encryptionKey: ENCRYPTION_KEY,
    userId: 'owner',
    timezone: 'Africa/Cairo',
    celia: { apiToken: API_TOKEN, aiProvider: 'local' },
    features: {
      google: true,
      whatsapp: true,
      elevenlabs: true,
      gemini: false,
      ollama: false
    },
    google: {
      clientId: 'cid',
      clientSecret: 'csecret',
      redirectUri: 'http://127.0.0.1:3000/auth/google/callback',
      allowedEmail: ''
    },
    whatsapp: {
      verifyToken: 'verify-tok',
      appSecret: 'app-secret',
      accessToken: 'wa-access-token',
      phoneNumberId: '1234567890',
      apiVersion: 'v22.0',
      autoReplyEnabled: false
    },
    elevenlabs: {
      apiKey: 'el-key',
      voiceId: 'EXAVITQu4vr4xnSDxMaL',
      voiceIdFormatValid: true,
      baseUrl: 'https://api.elevenlabs.io/v1',
      model: 'eleven_multilingual_v2'
    },
    gemini: { apiKey: '', model: 'gemini-2.5-flash', businessContext: '' },
    hosting: { integrationsEnabled: true, integrationConfig: null, sourceRef: 'main', publicUrl: null },
    resilience: { timeoutMs: 8000 },
    ...overrides
  };
}

async function listenExpress(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  };
}

test('HIGH-05 Node (1/5): POST /api/whatsapp/messages records idempotency completion immediately after upstream send and never re-sends when local DB INSERT fails', async () => {
  let upstreamSends = 0;
  const services = {
    run: async (_name, _fn) => {
      upstreamSends += 1;
      return `wamid.UPSTREAM_${upstreamSends}`;
    }
  };
  const pool = {
    async execute(sql) {
      if (sql.includes('SELECT opted_in, last_inbound_at FROM whatsapp_contacts')) {
        return [[{ opted_in: 1, last_inbound_at: new Date() }]];
      }
      if (sql.includes('INSERT IGNORE INTO whatsapp_messages')) {
        throw Object.assign(new Error('local_db_write_failed'), { code: 'ER_LOCK_DEADLOCK' });
      }
      return [[]];
    }
  };

  const app = express();
  app.use(express.json());
  app.use(createWhatsAppApiRouter({ pool, config: baseConfig(), services }));
  const srv = await listenExpress(app);
  try {
    const headers = {
      authorization: `Bearer ${API_TOKEN}`,
      'content-type': 'application/json',
      'Idempotency-Key': 'wa-post-upstream-0001'
    };
    const first = await fetch(`${srv.baseUrl}/api/whatsapp/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ phone: PHONE, text: 'تأكيد الموعد' })
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.providerMessageId, 'wamid.UPSTREAM_1');

    const retry = await fetch(`${srv.baseUrl}/api/whatsapp/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ phone: PHONE, text: 'تأكيد الموعد' })
    });
    assert.equal(retry.status, 200);
    const retryBody = await retry.json();
    assert.equal(retryBody._idempotencyReplay, true);
    assert.equal(retryBody.providerMessageId, 'wamid.UPSTREAM_1');
    assert.equal(upstreamSends, 1, 'upstream WhatsApp must never be called twice after local INSERT failure');
  } finally {
    await srv.close();
  }
});

test('HIGH-05 Node (2/5): MCP whatsapp_send_text records idempotency completion immediately after upstream send and never re-sends when local DB INSERT fails', async (t) => {
  let upstreamSends = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('graph.facebook.com')) {
      upstreamSends += 1;
      return new Response(JSON.stringify({ messages: [{ id: `wamid.MCP_${upstreamSends}` }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    return origFetch(url, init);
  };
  t.after(() => {
    globalThis.fetch = origFetch;
  });

  const pool = {
    async execute(sql) {
      if (sql.includes('SELECT opted_in, last_inbound_at FROM whatsapp_contacts')) {
        return [[{ opted_in: 1, last_inbound_at: new Date() }]];
      }
      if (sql.includes('INSERT IGNORE INTO whatsapp_messages')) {
        throw Object.assign(new Error('local_db_write_failed'), { code: 'ER_LOCK_WAIT_TIMEOUT' });
      }
      return [[]];
    }
  };

  const handler = createCeliaMcpHandler({ pool, config: baseConfig() });
  const first = await handler.callTool('whatsapp_send_text', {
    phone: PHONE,
    text: 'تأكيد عبر MCP',
    idempotencyKey: 'mcp-wa-post-upstream-0001'
  });
  assert.equal(first.providerMessageId, 'wamid.MCP_1');

  const replay = await handler.callTool('whatsapp_send_text', {
    phone: PHONE,
    text: 'تأكيد عبر MCP',
    idempotencyKey: 'mcp-wa-post-upstream-0001'
  });
  assert.equal(replay._idempotencyReplay, true);
  assert.equal(replay.providerMessageId, 'wamid.MCP_1');
  assert.equal(upstreamSends, 1, 'MCP whatsapp_send_text must never call Meta twice after local INSERT failure');
});

test('HIGH-05 Node (3/5): shared idempotencyStore isolates scopes across voice/calendar/whatsapp while deduplicating HTTP + MCP whatsapp.send', async (t) => {
  let waSends = 0;
  let ttsSends = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes('graph.facebook.com')) {
      waSends += 1;
      return new Response(JSON.stringify({ messages: [{ id: `wamid.SHARED_${waSends}` }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (target.includes('api.elevenlabs.io')) {
      ttsSends += 1;
      return new Response(new Uint8Array([0x49, 0x44, 0x33, ttsSends]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' }
      });
    }
    return origFetch(url, init);
  };
  t.after(() => {
    globalThis.fetch = origFetch;
  });

  const cfg = baseConfig();
  cfg.hosting.integrationConfig = baseConfig({ hosting: undefined });
  const pool = {
    isMemory: false,
    async execute(sql) {
      if (sql.includes('SELECT opted_in, last_inbound_at FROM whatsapp_contacts')) {
        return [[{ opted_in: 1, last_inbound_at: new Date() }]];
      }
      if (sql.includes('INSERT IGNORE INTO whatsapp_messages')) {
        return [{ affectedRows: 1 }];
      }
      return [[]];
    }
  };

  const app = createCeliaMcpApp({
    pool,
    config: cfg,
    agentHost: { status: async () => ({ enabled: false, mode: 'off' }) },
    kbHost: { status: async () => ({ enabled: false, mode: 'off' }) }
  });
  const srv = await listenExpress(app);
  try {
    const sharedKey = 'shared-cross-scope-key-0001';
    const authHeaders = {
      authorization: `Bearer ${API_TOKEN}`,
      'content-type': 'application/json',
      'Idempotency-Key': sharedKey
    };

    // 1) ElevenLabs TTS with sharedKey
    const ttsRes = await fetch(`${srv.baseUrl}/api/voice/speak`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ text: 'مرحبًا بك' })
    });
    assert.equal(ttsRes.status, 200);
    const ttsBody = await ttsRes.json();
    assert.equal(ttsBody.provider, 'elevenlabs');

    // 2) HTTP WhatsApp send with the SAME sharedKey must NOT replay ElevenLabs audio!
    const waHttpRes = await fetch(`${srv.baseUrl}/api/whatsapp/messages`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ phone: PHONE, text: 'رسالة مستقلة' })
    });
    assert.equal(waHttpRes.status, 200);
    const waHttpBody = await waHttpRes.json();
    assert.equal(waHttpBody.providerMessageId, 'wamid.SHARED_1');
    assert.equal(waHttpBody.provider, undefined);

    // 3) MCP whatsapp_send_text on the SAME server with the SAME sharedKey MUST deduplicate against HTTP whatsapp.send!
    const mcpRes = await fetch(`${srv.baseUrl}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'whatsapp_send_text',
          arguments: { phone: PHONE, text: 'رسالة مستقلة', idempotencyKey: sharedKey }
        }
      })
    });
    assert.equal(mcpRes.status, 200);
    const mcpJson = await mcpRes.json();
    assert.equal(mcpJson.result.isError, false);
    assert.equal(mcpJson.result.structuredContent._idempotencyReplay, true);
    assert.equal(mcpJson.result.structuredContent.providerMessageId, 'wamid.SHARED_1');
    assert.equal(waSends, 1, 'HTTP and MCP whatsapp.send share the whatsapp.send idempotency scope');
    assert.equal(ttsSends, 1);
  } finally {
    await srv.close();
  }
});

test('HIGH-05 Node (4/5): concurrent Promise.all requests on POST /api/whatsapp/messages with identical Idempotency-Key return [200, 409] and call upstream once', async () => {
  let upstreamSends = 0;
  const services = {
    run: async () => {
      upstreamSends += 1;
      await new Promise((r) => setTimeout(r, 25));
      return 'wamid.CONCURRENT_1';
    }
  };
  const pool = {
    async execute(sql) {
      if (sql.includes('SELECT opted_in, last_inbound_at FROM whatsapp_contacts')) {
        return [[{ opted_in: 1, last_inbound_at: new Date() }]];
      }
      return [{ affectedRows: 1 }];
    }
  };

  const app = express();
  app.use(express.json());
  app.use(createWhatsAppApiRouter({ pool, config: baseConfig(), services }));
  const srv = await listenExpress(app);
  try {
    const reqInit = {
      method: 'POST',
      headers: {
        authorization: `Bearer ${API_TOKEN}`,
        'content-type': 'application/json',
        'Idempotency-Key': 'wa-concurrent-race-0001'
      },
      body: JSON.stringify({ phone: PHONE, text: 'رسالة متزامنة' })
    };
    const [r1, r2] = await Promise.all([
      fetch(`${srv.baseUrl}/api/whatsapp/messages`, reqInit),
      fetch(`${srv.baseUrl}/api/whatsapp/messages`, reqInit)
    ]);
    assert.deepEqual([r1.status, r2.status].sort((a, b) => a - b), [200, 409]);
    assert.equal(upstreamSends, 1);
  } finally {
    await srv.close();
  }
});

test('HIGH-05 Node (5/5): createIdempotencyStore protects active in_progress claims from maxEntries key-flood eviction and allows stale takeover after inProgressTtlMs', () => {
  let nowMs = 1_000_000;
  const store = createIdempotencyStore({
    ttlMs: 86_400_000,
    inProgressTtlMs: 18_000,
    maxEntries: 3,
    now: () => nowMs
  });

  const activeToken = store.claim('inflight-key-0001', 'whatsapp.send');
  assert.ok(activeToken, 'initial claim succeeds');

  // Flood maxEntries with completed keys in another scope: active in_progress claim must survive!
  for (let i = 1; i <= 5; i += 1) {
    const fk = `flood-completed-000${i}`;
    assert.ok(store.claim(fk, 'elevenlabs.tts'));
    store.complete(fk, { idx: i }, 'elevenlabs.tts');
  }

  const stillInFlight = store.get('inflight-key-0001', 'whatsapp.send');
  assert.equal(stillInFlight?._idempotencyStatus, 'in_progress', 'completed-key flood must never evict active in_progress claim');
  assert.equal(store.claim('inflight-key-0001', 'whatsapp.send'), false, 'duplicate claim before inProgressTtlMs is rejected');

  // Advance past inProgressTtlMs (18s) without reaching 24h ttlMs: stale claim becomes takeover-eligible,
  // and late fail() from the stale holder cannot delete the new holder's claim!
  nowMs += 18_500;
  const takeoverToken = store.claim('inflight-key-0001', 'whatsapp.send');
  assert.ok(takeoverToken, 'stale in_progress claim is re-claimable after inProgressTtlMs');
  store.fail('inflight-key-0001', 'whatsapp.send', activeToken);
  assert.equal(
    store.get('inflight-key-0001', 'whatsapp.send')?._idempotencyStatus,
    'in_progress',
    'stale holder fail(oldToken) must not delete the new holder active claim'
  );
});
