import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { connectPoolWithFallback, createCeliaMcpApp, loadCeliaMcpConfig } from '../src/celia-mcp.js';
import { createMemoryPool } from '../src/memory-pool.js';
import { normalizeOllamaBaseUrl } from '../src/ollama.js';

const validHexToken = crypto.randomBytes(32).toString('hex');

test('loadCeliaMcpConfig enforces 32+ char non-placeholder CELIA_MCP_API_TOKEN', () => {
  assert.throws(() => loadCeliaMcpConfig({}), /CELIA_MCP_API_TOKEN/);
  assert.throws(
    () => loadCeliaMcpConfig({ CELIA_MCP_API_TOKEN: 'replace-with-hex-token-from-openssl-rand-hex-32' }),
    /CELIA_MCP_API_TOKEN/
  );
  assert.throws(() => loadCeliaMcpConfig({ CELIA_MCP_API_TOKEN: 'too-short' }), /at least 32/);

  const cfg = loadCeliaMcpConfig({
    CELIA_MCP_API_TOKEN: validHexToken,
    GEMINI_API_KEY: 'gemini-secret-test-key'
  });
  assert.equal(cfg.celia.apiToken, validHexToken);
  assert.equal(cfg.ollama.model, 'qwen2.5:7b');
  assert.equal(cfg.gemini.apiKey, 'gemini-secret-test-key');
});

test('CELIA_MCP_DISABLE_MYSQL selects the in-memory store and still seeds the owner row', async () => {
  const config = loadCeliaMcpConfig({
    CELIA_MCP_API_TOKEN: validHexToken,
    CELIA_MCP_DISABLE_MYSQL: 'true',
    MYSQL_HOST: '203.0.113.10'
  });
  assert.equal(config.envDisableMysql, true);

  const pool = await connectPoolWithFallback(config);
  assert.equal(pool.isMemory, true);
  const [rows] = await pool.execute('SELECT 1');
  assert.deepEqual(rows, [{ 1: 1 }]);
  await pool.end();

  const mysqlConfig = loadCeliaMcpConfig({ CELIA_MCP_API_TOKEN: validHexToken });
  assert.equal(mysqlConfig.envDisableMysql, false);
});

test('normalizeOllamaBaseUrl blocks remote SSRF hosts unless explicitly allowed', () => {
  assert.equal(normalizeOllamaBaseUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
  assert.equal(normalizeOllamaBaseUrl('http://localhost:11434/api'), 'http://localhost:11434');
  assert.throws(() => normalizeOllamaBaseUrl('http://169.254.169.254:80'), /localhost\/127\.0\.0\.1/);
  assert.equal(normalizeOllamaBaseUrl('https://ollama.example.internal:11434', true), 'https://ollama.example.internal:11434');
});

test('Celia MCP HTTP server enforces Bearer token, supports MCP methods, and never leaks secrets', async () => {
  const pool = createMemoryPool();
  const config = loadCeliaMcpConfig({
    CELIA_MCP_API_TOKEN: validHexToken,
    GEMINI_API_KEY: 'super-secret-gemini-key-do-not-expose',
    OLLAMA_BASE_URL: 'http://127.0.0.1:59999',
    OLLAMA_MODEL: 'qwen2.5:7b'
  });
  const server = createCeliaMcpApp({ pool, config }).listen(0, '127.0.0.1');
  const baseUrl = await new Promise((resolve) =>
    server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`))
  );

  try {
    const pageRes = await fetch(`${baseUrl}/`);
    assert.equal(pageRes.status, 200);
    assert.equal(pageRes.headers.get('x-frame-options'), null);
    assert.match(pageRes.headers.get('content-security-policy') || '', /frame-ancestors \*/);
    const pageHtml = await pageRes.text();
    assert.equal(pageHtml.includes(validHexToken), false);
    assert.equal(pageHtml.includes('super-secret-gemini-key-do-not-expose'), false);
    assert.match(pageHtml, /سيليا/);

    const cssRes = await fetch(`${baseUrl}/styles.css`);
    assert.equal(cssRes.status, 200);
    const jsRes = await fetch(`${baseUrl}/app.js`);
    assert.equal(jsRes.status, 200);

    const sandboxRpc = await fetch(`${baseUrl}/ui/workspace/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 77,
        method: 'tools/call',
        params: { name: 'celia_ai_reply', arguments: { customerMessage: 'كم الأسعار؟', provider: 'local' } }
      })
    }).then((r) => r.json());
    assert.equal(sandboxRpc.sandbox, true);
    assert.equal(sandboxRpc.result.isError, false);
    assert.match(sandboxRpc.result.structuredContent.reply, /خدمة العملاء/);

    const cryptoLab = await fetch(`${baseUrl}/ui/workspace/crypto-lab`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'simulate_inbound_whatsapp', phone: '+201065217834', text: 'مرحبًا' })
    }).then((r) => r.json());
    assert.equal(cryptoLab.ok, true);
    assert.equal(cryptoLab.hmacVerified, true);
    assert.equal(cryptoLab.customerWindow24hOpen, true);

    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const healthText = await healthRes.text();
    assert.equal(healthText.includes(validHexToken), false);
    assert.equal(healthText.includes('super-secret-gemini-key-do-not-expose'), false);

    const unauth = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    assert.equal(unauth.status, 401);

    const rpc = async (id, method, params = {}) => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${validHexToken}`
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
      });
      assert.equal(res.status, 200);
      return res.json();
    };

    const init = await rpc(1, 'initialize', { protocolVersion: '2024-11-05' });
    assert.equal(init.result.serverInfo.name, 'celia-phone-google-mcp');

    const notif = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${validHexToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    });
    assert.equal(notif.status, 202);

    const tools = await rpc(2, 'tools/list');
    assert.equal(tools.result.tools.length, 12);

    const consent = await rpc(3, 'tools/call', {
      name: 'whatsapp_consent_upsert',
      arguments: { phone: '+201065217834', optedIn: true, aiOptedIn: true, source: 'نموذج موافقة موثق' }
    });
    assert.equal(consent.result.isError, false);
    assert.equal(consent.result.structuredContent.aiOptedIn, true);

    const sendOutsideWindow = await rpc(4, 'tools/call', {
      name: 'whatsapp_send_text',
      arguments: { phone: '+201065217834', text: 'مرحبًا' }
    });
    assert.equal(sendOutsideWindow.result.isError, true);
    assert.match(sendOutsideWindow.result.content[0].text, /outside_customer_service_window/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('celia_ai_reply routes to Gemini when GEMINI_API_KEY is present and Ollama qwen2.5:7b otherwise', async () => {
  const pool = createMemoryPool();
  const previousFetch = globalThis.fetch;

  const geminiCfg = loadCeliaMcpConfig({
    CELIA_MCP_API_TOKEN: validHexToken,
    GEMINI_API_KEY: 'actions-gemini-key',
    GEMINI_MODEL: 'gemini-2.5-flash'
  });
  const ollamaCfg = loadCeliaMcpConfig({
    CELIA_MCP_API_TOKEN: validHexToken,
    GEMINI_API_KEY: '',
    OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
    OLLAMA_MODEL: 'qwen2.5:7b'
  });

  const geminiServer = createCeliaMcpApp({ pool, config: geminiCfg }).listen(0, '127.0.0.1');
  const ollamaServer = createCeliaMcpApp({ pool, config: ollamaCfg }).listen(0, '127.0.0.1');
  const [geminiPort, ollamaPort] = await Promise.all([
    new Promise((r) => geminiServer.once('listening', () => r(geminiServer.address().port))),
    new Promise((r) => ollamaServer.once('listening', () => r(ollamaServer.address().port)))
  ]);

  globalThis.fetch = async (url, options) => {
    const strUrl = String(url);
    if (strUrl.startsWith('https://generativelanguage.googleapis.com/')) {
      assert.equal(options.headers['x-goog-api-key'], 'actions-gemini-key');
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: 'مرحبًا! يسعدنا خدمتك عبر Gemini.' }] } }] })
      };
    }
    if (strUrl === 'http://127.0.0.1:11434/api/chat') {
      const parsedBody = JSON.parse(options.body);
      assert.equal(parsedBody.model, 'qwen2.5:7b');
      return {
        ok: true,
        json: async () => ({ message: { content: 'مرحبًا! يسعدنا خدمتك عبر Qwen المحلي.' } })
      };
    }
    return previousFetch(url, options);
  };

  try {
    const geminiRpc = await previousFetch(`http://127.0.0.1:${geminiPort}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${validHexToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'celia_ai_reply', arguments: { customerMessage: 'ما هي الخدمات؟' } }
      })
    }).then((r) => r.json());

    assert.equal(geminiRpc.result.isError, false);
    assert.equal(geminiRpc.result.structuredContent.provider, 'gemini');
    assert.equal(geminiRpc.result.structuredContent.reply, 'مرحبًا! يسعدنا خدمتك عبر Gemini.');

    const ollamaRpc = await previousFetch(`http://127.0.0.1:${ollamaPort}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${validHexToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'celia_ai_reply', arguments: { customerMessage: 'ما هي الخدمات؟' } }
      })
    }).then((r) => r.json());

    assert.equal(ollamaRpc.result.isError, false);
    assert.equal(ollamaRpc.result.structuredContent.provider, 'ollama');
    assert.equal(ollamaRpc.result.structuredContent.model, 'qwen2.5:7b');
    assert.equal(ollamaRpc.result.structuredContent.reply, 'مرحبًا! يسعدنا خدمتك عبر Qwen المحلي.');
  } finally {
    globalThis.fetch = previousFetch;
    await Promise.all([
      new Promise((r) => geminiServer.close(r)),
      new Promise((r) => ollamaServer.close(r))
    ]);
  }
});

test('UI routes serve HTML on /live, /skills, /studio, /landing and JSON on /api/live (including CELIA_LANDING_ROOT=true)', async () => {
  const pool = createMemoryPool();
  const config = loadCeliaMcpConfig({
    CELIA_MCP_API_TOKEN: validHexToken,
    CELIA_LANDING_ROOT: 'true'
  });
  const server = createCeliaMcpApp({ pool, config }).listen(0, '127.0.0.1');
  const baseUrl = await new Promise((resolve) =>
    server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`))
  );

  try {
    const rootRes = await fetch(`${baseUrl}/`);
    assert.equal(rootRes.status, 200);
    assert.match(rootRes.headers.get('content-type') || '', /text\/html/);
    const rootHtml = await rootRes.text();
    assert.match(rootHtml, /id="features"/);

    const studioRes = await fetch(`${baseUrl}/studio`);
    assert.equal(studioRes.status, 200);
    assert.match(studioRes.headers.get('content-type') || '', /text\/html/);
    const studioHtml = await studioRes.text();
    assert.match(studioHtml, /id="view-tools"/);
    assert.match(studioHtml, /استوديو أدوات بروتوكول MCP الاثنتي عشرة/);

    for (const htmlRoute of ['/live', '/live.html', '/skills', '/skills.html', '/landing', '/landing.html']) {
      const res = await fetch(`${baseUrl}${htmlRoute}`);
      assert.equal(res.status, 200, `${htmlRoute} should return 200`);
      assert.match(res.headers.get('content-type') || '', /text\/html/, `${htmlRoute} should serve HTML, not JSON`);
    }

    const apiLiveRes = await fetch(`${baseUrl}/api/live`);
    assert.equal(apiLiveRes.status, 200);
    assert.match(apiLiveRes.headers.get('content-type') || '', /application\/json/);
    const apiLive = await apiLiveRes.json();
    assert.equal(apiLive.live, true);
    assert.equal(apiLive.tools, 12);
    assert.equal(typeof apiLive.uptime, 'number');

    for (const arabicQuery of ['تقويم', 'تشفير', 'بريد', 'ملفات', 'إرسال']) {
      const skillsRes = await fetch(`${baseUrl}/api/skills?q=${encodeURIComponent(arabicQuery)}`).then((r) => r.json());
      assert.ok(skillsRes.matched >= 1, `find_skills should match Arabic query "${arabicQuery}"`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
