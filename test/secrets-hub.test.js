import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { normalizeHttpsApiUrl } from '../src/ai-providers.js';
import {
  MCP_TOOLS,
  connectPoolWithFallback,
  createCeliaMcpApp,
  getActiveMcpTools,
  loadCeliaMcpConfig
} from '../src/celia-mcp.js';
import { assertBackwardCompatibleMcpTools } from '../src/mcp-contract.js';

const exec = promisify(execFile);

const TEST_SECRETS = {
  AGENETROUTERAPI_KEY: 'sk-agentrouter-secret-value-991122',
  AI_GATEWAY_API_KEY: 'vck-ai-gateway-secret-value-883344',
  CELIA_MCP_API_TOKEN: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  CELIA_VOICE_ID: 'JBFqnCBsd6RMkjVDRZzb',
  DEEPSEEK_API_KEY: 'sk-deepseek-secret-value-774455',
  ELEVENLABS_API_KEY: 'xi-elevenlabs-secret-value-665544',
  FIGMA_ACCESS_TOKEN: 'figd_secret_token_value_554433',
  GEMINI_API_KEY: 'AIzaSyTestSecretValue44332211',
  YOUR_CODATA_API_KEY: 'codata_secret_key_value_332211'
};

async function startServer(envOverrides = {}) {
  const config = loadCeliaMcpConfig(
    {
      ...TEST_SECRETS,
      CELIA_MCP_DISABLE_MYSQL: 'true',
      CELIA_DISABLE_OLLAMA: 'true',
      ...envOverrides
    },
    { requireToken: true }
  );
  const pool = await connectPoolWithFallback(config);
  const app = createCeliaMcpApp({ pool, config });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    config,
    baseUrl,
    authHeaders: {
      authorization: `Bearer ${config.celia.apiToken}`,
      'content-type': 'application/json'
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
    }
  };
}

test('normalizeHttpsApiUrl enforces HTTPS and blocks SSRF/private/credentialed URLs', () => {
  const fb = 'https://api.deepseek.com';
  assert.equal(normalizeHttpsApiUrl('https://api.deepseek.com/v1/', fb, 'TEST'), 'https://api.deepseek.com/v1');
  assert.throws(() => normalizeHttpsApiUrl('http://api.deepseek.com/v1', fb, 'TEST'), /https/i);
  assert.throws(() => normalizeHttpsApiUrl('https://user:pass@api.deepseek.com', fb, 'TEST'), /credentials/i);
  assert.throws(() => normalizeHttpsApiUrl('https://localhost:8443/v1', fb, 'TEST'), /public HTTPS host/i);
  assert.throws(() => normalizeHttpsApiUrl('https://127.0.0.1/v1', fb, 'TEST'), /public HTTPS host/i);
  assert.throws(() => normalizeHttpsApiUrl('https://169.254.169.254/latest', fb, 'TEST'), /public HTTPS host/i);
  assert.throws(() => normalizeHttpsApiUrl('https://10.0.0.8/v1', fb, 'TEST'), /public HTTPS host/i);
  assert.throws(() => normalizeHttpsApiUrl('https://192.168.1.5/v1', fb, 'TEST'), /public HTTPS host/i);
  assert.throws(() => normalizeHttpsApiUrl('https://172.20.0.1/v1', fb, 'TEST'), /public HTTPS host/i);
  assert.throws(() => normalizeHttpsApiUrl('https://[::1]/v1', fb, 'TEST'), /public HTTPS host/i);
});

test('loadCeliaMcpConfig wires all 9 secrets, handles aliases, and validates CELIA_VOICE_ID non-fatally', () => {
  const cfg = loadCeliaMcpConfig({
    ...TEST_SECRETS,
    CELIA_VOICE_ID: '../bad-voice-id'
  });
  assert.equal(cfg.agentrouter.apiKey, TEST_SECRETS.AGENETROUTERAPI_KEY);
  assert.equal(cfg.aiGateway.apiKey, TEST_SECRETS.AI_GATEWAY_API_KEY);
  assert.equal(cfg.celia.apiToken, TEST_SECRETS.CELIA_MCP_API_TOKEN);
  assert.equal(cfg.deepseek.apiKey, TEST_SECRETS.DEEPSEEK_API_KEY);
  assert.equal(cfg.elevenlabs.apiKey, TEST_SECRETS.ELEVENLABS_API_KEY);
  assert.equal(cfg.elevenlabs.voiceId, '');
  assert.equal(cfg.elevenlabs.voiceIdFormatValid, false);
  assert.equal(cfg.figma.accessToken, TEST_SECRETS.FIGMA_ACCESS_TOKEN);
  assert.equal(cfg.gemini.apiKey, TEST_SECRETS.GEMINI_API_KEY);
  assert.equal(cfg.codata.apiKey, TEST_SECRETS.YOUR_CODATA_API_KEY);

  // loadConfig supports CELIA_MCP_API_TOKEN fallback when APP_API_TOKEN is unset
  const coreCfg = loadConfig({
    MYSQL_HOST: 'db.example.internal',
    MYSQL_USER: 'celia',
    MYSQL_PASSWORD: 'pw',
    MYSQL_DATABASE: 'celia',
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    CELIA_MCP_API_TOKEN: TEST_SECRETS.CELIA_MCP_API_TOKEN,
    AGENETROUTERAPI_KEY: TEST_SECRETS.AGENETROUTERAPI_KEY
  });
  assert.equal(coreCfg.apiToken, TEST_SECRETS.CELIA_MCP_API_TOKEN);
  assert.equal(coreCfg.agentrouter.apiKey, TEST_SECRETS.AGENETROUTERAPI_KEY);
});

test('all 9 secrets report sanitized readiness and never leak values or spend credits in public sandbox', async () => {
  const srv = await startServer();
  try {
    const unauth = await fetch(`${srv.baseUrl}/api/secrets/status`);
    assert.equal(unauth.status, 401);

    const [health, live, system, deploy, secretsRes, sandboxRes] = await Promise.all([
      fetch(`${srv.baseUrl}/health`).then((r) => r.text()),
      fetch(`${srv.baseUrl}/api/live`).then((r) => r.text()),
      fetch(`${srv.baseUrl}/api/system`).then((r) => r.text()),
      fetch(`${srv.baseUrl}/api/deployment`).then((r) => r.text()),
      fetch(`${srv.baseUrl}/api/secrets/status`, { headers: srv.authHeaders }),
      fetch(`${srv.baseUrl}/ui/workspace/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'resources/read',
          params: { uri: 'celia://secrets/readiness' }
        })
      }).then((r) => r.json())
    ]);

    assert.equal(secretsRes.status, 200);
    const secretsJson = await secretsRes.json();
    assert.equal(secretsJson.totalSecretsTracked, 9);
    assert.equal(secretsJson.configuredCount, 9);

    // Public sandbox must report 0 secrets configured so visitors cannot probe or spend owner keys
    const sandboxReport = JSON.parse(sandboxRes.result.contents[0].text);
    assert.equal(sandboxReport.configuredCount, 0);

    const allBodies = [health, live, system, deploy, JSON.stringify(secretsJson), JSON.stringify(sandboxRes)].join('\n');
    for (const secretValue of Object.values(TEST_SECRETS)) {
      assert.equal(allBodies.includes(secretValue), false, `Secret leaked in HTTP response`);
    }
  } finally {
    await srv.close();
  }
});

test('governed cloud AI providers (AI Gateway, DeepSeek, AgentRouter) and single-cloud auto boundary', async () => {
  const originalFetch = globalThis.fetch;
  const upstreamCalls = [];

  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith('http://127.0.0.1:')) {
      return originalFetch(url, init);
    }
    upstreamCalls.push({ url: target, auth: init.headers?.Authorization || init.headers?.authorization });
    if (target.includes('ai-gateway.vercel.sh') && upstreamCalls.some((c) => c.url.includes('fail-gateway'))) {
      return new Response('upstream error', { status: 503 });
    }
    if (target.includes('fail.example.com')) {
      return new Response('gateway unavailable', { status: 503 });
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'أهلاً بك، سأساعدك فورًا في طلبك.' } }]
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  const srv = await startServer({ GEMINI_API_KEY: '' });
  try {
    for (const [provider, expectedAuth] of [
      ['ai_gateway', `Bearer ${TEST_SECRETS.AI_GATEWAY_API_KEY}`],
      ['deepseek', `Bearer ${TEST_SECRETS.DEEPSEEK_API_KEY}`],
      ['agentrouter', `Bearer ${TEST_SECRETS.AGENETROUTERAPI_KEY}`]
    ]) {
      const res = await originalFetch(`${srv.baseUrl}/api/ai/reply`, {
        method: 'POST',
        headers: srv.authHeaders,
        body: JSON.stringify({ customerMessage: 'ما مواعيد العمل؟', provider })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.provider, provider);
      assert.equal(data.degraded, false);
      assert.equal(upstreamCalls.at(-1).auth, expectedAuth);
    }

    // Verify auto mode calls at most ONE cloud provider by default (no cross-vendor fan-out)
    upstreamCalls.length = 0;
    const strictAutoSrv = await startServer({
      GEMINI_API_KEY: '',
      AI_GATEWAY_BASE_URL: 'https://fail.example.com/v1',
      CELIA_AI_ALLOW_CLOUD_FAILOVER: 'false'
    });
    try {
      const autoRes = await originalFetch(`${strictAutoSrv.baseUrl}/api/ai/reply`, {
        method: 'POST',
        headers: strictAutoSrv.authHeaders,
        body: JSON.stringify({ customerMessage: 'ما مواعيد العمل؟', provider: 'auto' })
      });
      const autoData = await autoRes.json();
      assert.equal(autoData.provider, 'celia-local-policy-engine');
      assert.equal(autoData.degraded, true);
      // DEFAULT_POLICY retries once (maxAttempts: 2) on the single selected cloud provider, zero calls to DeepSeek/AgentRouter
      assert.equal(upstreamCalls.every((c) => c.url.includes('fail.example.com')), true);
    } finally {
      await strictAutoSrv.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
    await srv.close();
  }
});

test('ElevenLabs TTS with Idempotency-Key, Figma read-only client, Codata read-only status, and opt-in extended MCP tools', async () => {
  const originalFetch = globalThis.fetch;
  let elevenLabsCalls = 0;

  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith('http://127.0.0.1:')) {
      return originalFetch(url, init);
    }
    if (target.includes('api.elevenlabs.io/v1/text-to-speech/')) {
      elevenLabsCalls += 1;
      assert.equal(init.headers['xi-api-key'], TEST_SECRETS.ELEVENLABS_API_KEY);
      assert.equal(target.endsWith(`/${TEST_SECRETS.CELIA_VOICE_ID}`), true);
      return new Response(Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0x00]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' }
      });
    }
    if (target.includes('api.figma.com/v1/files/AbCdEf123')) {
      assert.equal(init.headers['X-Figma-Token'], TEST_SECRETS.FIGMA_ACCESS_TOKEN);
      return new Response(
        JSON.stringify({
          name: 'Celia Design System',
          lastModified: '2026-10-27T00:00:00Z',
          version: '42',
          document: { children: [{ name: 'Home', type: 'CANVAS' }] },
          components: { c1: {}, c2: {} }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (target.includes('codata.example.com/workspaces/')) {
      assert.equal(init.headers.authorization || init.headers.Authorization, `Bearer ${TEST_SECRETS.YOUR_CODATA_API_KEY}`);
      return new Response(JSON.stringify({ name: 'Celia Workspace' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    throw new Error(`Unexpected upstream URL: ${target}`);
  };

  const srv = await startServer({
    CELIA_EXTENDED_MCP_TOOLS: 'true',
    CODATA_BASE_URL: 'https://codata.example.com'
  });
  try {
    assert.equal(MCP_TOOLS.length, 12);
    assert.equal(getActiveMcpTools(srv.config).length, 16);

    const idemHeaders = { ...srv.authHeaders, 'Idempotency-Key': 'voice-idem-key-0001' };
    const speak1 = await originalFetch(`${srv.baseUrl}/api/voice/speak`, {
      method: 'POST',
      headers: idemHeaders,
      body: JSON.stringify({ text: 'مرحبًا بك في نظام سيليا.' })
    }).then((r) => r.json());
    const speak2 = await originalFetch(`${srv.baseUrl}/api/voice/speak`, {
      method: 'POST',
      headers: idemHeaders,
      body: JSON.stringify({ text: 'مرحبًا بك في نظام سيليا.' })
    }).then((r) => r.json());

    assert.equal(Boolean(speak1._idempotencyReplay), false);
    assert.equal(speak2._idempotencyReplay, true);
    assert.equal(speak1.audioBase64, speak2.audioBase64);
    assert.equal(elevenLabsCalls, 1);

    const figmaRes = await originalFetch(`${srv.baseUrl}/api/figma/files/AbCdEf123`, {
      headers: srv.authHeaders
    }).then((r) => r.json());
    assert.equal(figmaRes.name, 'Celia Design System');
    assert.equal(figmaRes.componentsCount, 2);

    const codataRes = await originalFetch(`${srv.baseUrl}/api/codata/status?probe=true`, {
      headers: srv.authHeaders
    }).then((r) => r.json());
    assert.equal(codataRes.configured, true);
    assert.equal(codataRes.mode, 'read-only');
    assert.equal(codataRes.primaryTransactionalStore, false);
    assert.equal(codataRes.automaticMigrationAllowed, false);
    assert.equal(codataRes.reachable, true);
    assert.equal(codataRes.workspaceName, 'Celia Workspace');
  } finally {
    globalThis.fetch = originalFetch;
    await srv.close();
  }
});

test('MCP_TOOLS preserves strict N/N-1 backward compatibility with 0.2.0 baseline', async () => {
  const baseline = '2508893bd7e6d447b2e19374933556322cc9cdb7';
  const root = path.resolve(import.meta.dirname, '..');
  let tmpDir = null;
  try {
    await exec('git', ['cat-file', '-e', `${baseline}^{commit}`], { cwd: root });
    await mkdir(path.join(root, '.validation-artifacts'), { recursive: true });
    tmpDir = await mkdtemp(path.join(root, '.validation-artifacts', 'mcp-contract-'));
    const archive = await exec('git', ['archive', baseline], { cwd: root, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
    const tarFile = path.join(tmpDir, 'base.tar');
    await writeFile(tarFile, archive.stdout);
    await exec('tar', ['-xf', tarFile, '-C', tmpDir]);
    const previous = await import(pathToFileURL(path.join(tmpDir, 'src/celia-mcp.js')).href);
    assertBackwardCompatibleMcpTools(previous.MCP_TOOLS, MCP_TOOLS);
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  }
});
