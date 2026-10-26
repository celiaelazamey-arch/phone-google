import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createCeliaMcpApp, loadCeliaMcpConfig } from '../src/celia-mcp.js';
import { createMemoryPool } from '../src/memory-pool.js';

const token = crypto.randomBytes(32).toString('hex');
const VOICE_ENV = Object.freeze({
  CELIA_MCP_API_TOKEN: token,
  ELEVENLABS_API_KEY: 'eleven-secret-abcdef123456',
  CELIA_VOICE_ID: 'voice-secret-id-21bcd'
});

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function audioResponse() {
  return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4, 5]).buffer };
}

async function startApp(env = VOICE_ENV) {
  const config = loadCeliaMcpConfig(env);
  const server = createCeliaMcpApp({ pool: createMemoryPool(), config }).listen(0, '127.0.0.1');
  const port = await new Promise((resolve) => server.once('listening', () => resolve(server.address().port)));
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function withMockedFetch(handler, fn) {
  const previousFetch = globalThis.fetch;
  const externalCalls = [];
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target.includes('api.elevenlabs.io')) {
      externalCalls.push({ url: target, options });
      return handler(target, options);
    }
    return previousFetch(url, options);
  };
  try {
    return await fn(externalCalls);
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function rpc(baseUrl, id, name, args = {}) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
  });
  assert.equal(res.status, 200);
  return res.json();
}

test('T2-01 the two voice tools are registered (13 total) and /health reports safe voice status', async () => {
  const { server, baseUrl } = await startApp();
  try {
    const listRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    }).then((r) => r.json());
    assert.equal(listRes.result.tools.length, 15);
    for (const name of ['celia_voice_speak', 'celia_voice_quota']) {
      assert.ok(listRes.result.tools.some((tool) => tool.name === name));
    }

    const healthText = await fetch(`${baseUrl}/health`).then((r) => r.text());
    for (const secret of [token, VOICE_ENV.ELEVENLABS_API_KEY, VOICE_ENV.CELIA_VOICE_ID]) {
      assert.equal(healthText.includes(secret), false);
    }
    const health = JSON.parse(healthText);
    assert.equal(health.providers.voice.configured, true);
    assert.equal(health.providers.voice.model, 'eleven_flash_v2_5');
    assert.equal(health.providers.voice.dailyCharBudget, 600);

    const unauth = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'celia_voice_speak', arguments: { text: 'مرحبًا' } } })
    });
    assert.equal(unauth.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('T2-02 celia_voice_quota reports the remaining free percentage without consuming characters', async () => {
  const { server, baseUrl } = await startApp();
  try {
    await withMockedFetch(
      () => jsonResponse({ character_count: 2500, character_limit: 10000, tier: 'free', next_character_count_reset_unix: 1761955200 }),
      async (externalCalls) => {
        const result = await rpc(baseUrl, 3, 'celia_voice_quota');
        assert.equal(result.result.isError, false);
        const data = result.result.structuredContent;
        assert.equal(data.available, true);
        assert.equal(data.remainingPct, 75);
        assert.equal(data.remaining, 7500);
        assert.equal(externalCalls.length, 1);
        assert.equal(externalCalls[0].url, 'https://api.elevenlabs.io/v1/user/subscription');
        assert.equal(externalCalls[0].options.headers['xi-api-key'], VOICE_ENV.ELEVENLABS_API_KEY);
        assert.equal(externalCalls[0].url.includes(VOICE_ENV.ELEVENLABS_API_KEY), false);
        assert.equal(JSON.stringify(result).includes(VOICE_ENV.ELEVENLABS_API_KEY), false);
      }
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('T2-03 celia_voice_speak returns MP3 base64, and a repeated sentence is served from the cache at zero cost', async () => {
  const { server, baseUrl } = await startApp();
  try {
    await withMockedFetch(() => audioResponse(), async (externalCalls) => {
      const first = await rpc(baseUrl, 4, 'celia_voice_speak', { text: 'أهلًا بك في سيليا' });
      assert.equal(first.result.isError, false);
      const data = first.result.structuredContent;
      assert.equal(data.provider, 'elevenlabs');
      assert.equal(data.cached, false);
      assert.equal(data.mimeType, 'audio/mpeg');
      assert.equal(data.audioBase64, Buffer.from([1, 2, 3, 4, 5]).toString('base64'));
      assert.equal(externalCalls.length, 1);
      assert.equal(externalCalls[0].url.includes('/v1/text-to-speech/voice-secret-id-21bcd'), true);
      assert.equal(externalCalls[0].options.headers['xi-api-key'], VOICE_ENV.ELEVENLABS_API_KEY);
      const body = JSON.parse(externalCalls[0].options.body);
      assert.equal(body.model_id, 'eleven_flash_v2_5');
      assert.equal(JSON.stringify(first).includes(VOICE_ENV.ELEVENLABS_API_KEY), false);

      const second = await rpc(baseUrl, 5, 'celia_voice_speak', { text: 'أهلًا بك في سيليا' });
      const cached = second.result.structuredContent;
      assert.equal(cached.cached, true);
      assert.equal(cached.charsConsumed, 0);
      assert.equal(cached.audioBase64, data.audioBase64);
      assert.equal(externalCalls.length, 1, 'cache hit must not call ElevenLabs again');
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('T2-04 long text uses the free browser voice with the full text and no provider call', async () => {
  const { server, baseUrl } = await startApp();
  try {
    await withMockedFetch(() => audioResponse(), async (externalCalls) => {
      const longText = 'مرحبًا '.repeat(60);
      const result = await rpc(baseUrl, 6, 'celia_voice_speak', { text: longText });
      const data = result.result.structuredContent;
      assert.equal(data.provider, 'web-speech-ar-EG');
      // المحرك ينظّف المسافات الطرفية قبل النطق.
      assert.equal(data.text, longText.trim());
      assert.equal(data.charsConsumed, 0);
      assert.equal(data.reason, 'text_too_long');
      assert.equal(externalCalls.length, 0);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('T2-05 the public tool studio never burns ElevenLabs quota (sandbox-only simulation)', async () => {
  const { server, baseUrl } = await startApp();
  try {
    await withMockedFetch(() => audioResponse(), async (externalCalls) => {
      for (const [id, name, args] of [
        [7, 'celia_voice_speak', { text: 'مرحبًا' }],
        [8, 'celia_voice_quota', {}]
      ]) {
        const response = await fetch(`${baseUrl}/ui/workspace/rpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
        }).then((r) => r.json());
        assert.equal(response.sandbox, true);
        assert.equal(response.result.isError, false);
        assert.equal(response.result.structuredContent.sandboxOnly, true);
      }
      assert.equal(externalCalls.length, 0, 'public studio must never call ElevenLabs');
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('T2-06 without an ElevenLabs key the MCP tools degrade gracefully (no crash, no network)', async () => {
  const { server, baseUrl } = await startApp({ CELIA_MCP_API_TOKEN: token });
  try {
    await withMockedFetch(() => audioResponse(), async (externalCalls) => {
      const quota = await rpc(baseUrl, 9, 'celia_voice_quota');
      assert.equal(quota.result.structuredContent.reason, 'not_configured');
      const speech = await rpc(baseUrl, 10, 'celia_voice_speak', { text: 'مرحبًا' });
      assert.equal(speech.result.structuredContent.provider, 'web-speech-ar-EG');
      assert.equal(speech.result.structuredContent.reason, 'not_configured');
      assert.equal(externalCalls.length, 0);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
