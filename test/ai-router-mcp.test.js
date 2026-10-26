import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createCeliaMcpApp, loadCeliaMcpConfig } from '../src/celia-mcp.js';
import { createMemoryPool } from '../src/memory-pool.js';

const token = crypto.randomBytes(32).toString('hex');
const KEYS = Object.freeze({
  gemini: 'gem-secret-abcdef123456',
  agent: 'agent-secret-abcdef123456',
  deep: 'deep-secret-abcdef123456'
});

function fullEnv(overrides = {}) {
  return {
    CELIA_MCP_API_TOKEN: token,
    GEMINI_API_KEY: KEYS.gemini,
    AGENETROUTERAPI_KEY: KEYS.agent,
    DEEPSEEK_API_KEY: KEYS.deep,
    ...overrides
  };
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: () => null },
    json: async () => body
  };
}

const geminiOk = (text) => ({ candidates: [{ content: { parts: [{ text }] } }] });
const openAiOk = (text) => ({ choices: [{ message: { content: text } }] });

async function startApp(env) {
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
    if (/^https:\/\/(generativelanguage\.googleapis\.com|agentrouter\.org|api\.deepseek\.com)/.test(target)) {
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

async function rpc(baseUrl, id, method, params = {}, authorization = `Bearer ${token}`) {
  const response = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('MCP exposes 11 tools including celia_smart_router, and /health reports the router without leaking keys', async () => {
  const { server, baseUrl } = await startApp(fullEnv());
  try {
    const tools = await rpc(baseUrl, 1, 'tools/list');
    assert.equal(tools.result.tools.length, 15);
    const routerTool = tools.result.tools.find((tool) => tool.name === 'celia_smart_router');
    assert.ok(routerTool);
    assert.deepEqual(routerTool.inputSchema.properties.task.enum, ['auto', 'fast', 'deep']);

    const healthRes = await fetch(`${baseUrl}/health`);
    const healthText = await healthRes.text();
    for (const secret of [...Object.values(KEYS), token]) assert.equal(healthText.includes(secret), false);
    const health = JSON.parse(healthText);
    assert.equal(health.providers.effectiveDefault, 'smart-router');
    assert.equal(health.providers.smartRouter.providers.agentRouter.configured, true);
    assert.equal(health.providers.smartRouter.providers.deepseek.configured, true);
    assert.equal(health.providers.smartRouter.providers.agentRouter.apiKeySource, 'AGENETROUTERAPI_KEY');
    assert.deepEqual(health.providers.smartRouter.chains.deep, ['deepseek', 'agentrouter', 'gemini', 'ollama']);

    const unauth = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    assert.equal(unauth.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('celia_smart_router sends a deep task to DeepSeek first with a Bearer key outside the URL', async () => {
  const { server, baseUrl } = await startApp(fullEnv({ DEEPSEEK_MODEL: 'deepseek-reasoner' }));
  try {
    await withMockedFetch(
      () => jsonResponse(openAiOk('خطة من DeepSeek')),
      async (externalCalls) => {
        const result = await rpc(baseUrl, 2, 'tools/call', {
          name: 'celia_smart_router',
          arguments: { prompt: 'اكتب كود واجهة حجوزات', task: 'deep' }
        });
        assert.equal(result.result.isError, false);
        const data = result.result.structuredContent;
        assert.equal(data.provider, 'deepseek');
        assert.equal(data.model, 'deepseek-reasoner');
        assert.equal(data.task, 'deep');
        assert.equal(data.reply, 'خطة من DeepSeek');
        assert.equal(externalCalls.length, 1);
        assert.equal(externalCalls[0].url, 'https://api.deepseek.com/v1/chat/completions');
        assert.equal(externalCalls[0].options.headers.authorization, `Bearer ${KEYS.deep}`);
        assert.equal(externalCalls[0].url.includes(KEYS.deep), false);
      }
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('celia_ai_reply auto fails over from a rate-limited Gemini to AgentRouter without exposing secrets', async () => {
  const { server, baseUrl } = await startApp(fullEnv());
  try {
    await withMockedFetch(
      (target, options) => {
        if (target.includes('generativelanguage.googleapis.com')) {
          assert.equal(options.headers['x-goog-api-key'], KEYS.gemini);
          return jsonResponse({ error: { message: `quota ${KEYS.gemini}` } }, { ok: false, status: 429 });
        }
        assert.equal(options.headers.authorization, `Bearer ${KEYS.agent}`);
        return jsonResponse(openAiOk('رد بديل من AgentRouter'));
      },
      async (externalCalls) => {
        const result = await rpc(baseUrl, 3, 'tools/call', {
          name: 'celia_ai_reply',
          arguments: { customerMessage: 'ما هي الخدمات المتاحة؟', provider: 'auto' }
        });
        assert.equal(result.result.isError, false);
        const data = result.result.structuredContent;
        assert.equal(data.provider, 'agentrouter');
        assert.equal(data.reply, 'رد بديل من AgentRouter');
        assert.equal(data.task, 'fast');
        assert.equal(data.attempts[0].status, 429);
        assert.equal(JSON.stringify(result).includes(KEYS.gemini), false);
        assert.equal(JSON.stringify(result).includes(KEYS.agent), false);
        assert.deepEqual(
          externalCalls.map((call) => call.url),
          [
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
            'https://agentrouter.org/v1/chat/completions'
          ]
        );
      }
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('public tool studio simulates the smart router locally and never calls a paid provider', async () => {
  const { server, baseUrl } = await startApp(fullEnv());
  try {
    await withMockedFetch(
      () => jsonResponse(openAiOk('should never be called')),
      async (externalCalls) => {
        const response = await fetch(`${baseUrl}/ui/workspace/rpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 9,
            method: 'tools/call',
            params: { name: 'celia_smart_router', arguments: { prompt: 'كم سعر الاشتراك؟', task: 'deep' } }
          })
        }).then((r) => r.json());
        assert.equal(response.sandbox, true);
        assert.equal(response.result.isError, false);
        assert.equal(response.result.structuredContent.provider, 'celia-local-policy-engine');
        assert.equal(response.result.structuredContent.sandboxOnly, true);
        assert.match(response.result.structuredContent.reply, /خدمة العملاء/);
        assert.equal(externalCalls.length, 0);
      }
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('without extra keys the legacy celia_ai_reply path is unchanged (Gemini first, no router)', async () => {
  const { server, baseUrl } = await startApp({
    CELIA_MCP_API_TOKEN: token,
    GEMINI_API_KEY: KEYS.gemini
  });
  try {
    await withMockedFetch(
      () => jsonResponse(geminiOk('رد Gemini الكلاسيكي')),
      async (externalCalls) => {
        const result = await rpc(baseUrl, 4, 'tools/call', {
          name: 'celia_ai_reply',
          arguments: { customerMessage: 'مرحبًا' }
        });
        assert.equal(result.result.structuredContent.provider, 'gemini');
        assert.equal(result.result.structuredContent.reply, 'رد Gemini الكلاسيكي');
        assert.equal(result.result.structuredContent.routerVersion, undefined);
        assert.equal(externalCalls.length, 1);
      }
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
