import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createCeliaMcpApp, loadCeliaMcpConfig } from '../src/celia-mcp.js';
import { createMemoryPool } from '../src/memory-pool.js';

const token = crypto.randomBytes(32).toString('hex');
const FIGMA_TOKEN = 'figma-secret-abcdef123456';
const FILE_KEY = 'AbCdEfGhIjKlMnOpQrStUv';
const ENV = Object.freeze({ CELIA_MCP_API_TOKEN: token, FIGMA_ACCESS_TOKEN: FIGMA_TOKEN });

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function sampleFile() {
  return {
    name: 'Celia Design',
    lastModified: '2026-10-20T10:00:00Z',
    owner: { email: 'owner@private.example' },
    document: {
      id: '0:0',
      name: 'Page 1',
      type: 'CANVAS',
      fills: [{ type: 'SOLID', color: { r: 0.388, g: 0.4, b: 0.945 } }],
      children: [
        { id: '1:2', name: 'Hero <script>alert(1)</script>', type: 'FRAME', style: { fontFamily: 'Cairo' } },
        { id: '1:3', name: 'Primary Button', type: 'COMPONENT' }
      ]
    }
  };
}

async function startApp({ env = ENV, figmaFetchImpl = async () => jsonResponse(sampleFile()) } = {}) {
  const calls = [];
  const config = loadCeliaMcpConfig(env);
  const server = createCeliaMcpApp({
    pool: createMemoryPool(),
    config,
    figmaFetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return figmaFetchImpl(url, options);
    }
  }).listen(0, '127.0.0.1');
  const port = await new Promise((resolve) => server.once('listening', () => resolve(server.address().port)));
  return { server, calls, baseUrl: `http://127.0.0.1:${port}` };
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

test('T5-01 both Figma tools are registered (15 total) and /health never exposes the token', async () => {
  const { server, baseUrl } = await startApp();
  try {
    const list = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    }).then((r) => r.json());
    assert.equal(list.result.tools.length, 15);
    for (const name of ['figma_inspect_design', 'figma_to_live_artifact']) {
      assert.ok(list.result.tools.some((tool) => tool.name === name));
    }
    const healthText = await fetch(`${baseUrl}/health`).then((r) => r.text());
    assert.equal(healthText.includes(FIGMA_TOKEN), false);
    assert.equal(healthText.includes(token), false);
    assert.equal(JSON.parse(healthText).providers.figma.configured, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('T5-02 figma_inspect_design returns a sanitized summary with the token in a header only', async () => {
  const { server, baseUrl, calls } = await startApp();
  try {
    const result = await rpc(baseUrl, 2, 'figma_inspect_design', {
      url: `https://www.figma.com/file/${FILE_KEY}/CeliaDesign`
    });
    assert.equal(result.result.isError, false);
    const data = result.result.structuredContent;
    assert.equal(data.provider, 'figma');
    assert.equal(data.nodeCount, 3);
    assert.equal(data.name, 'Celia Design');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.includes(FIGMA_TOKEN), false);
    assert.equal(calls[0].options.headers['X-Figma-Token'], FIGMA_TOKEN);
    const dump = JSON.stringify(result);
    for (const secret of [FIGMA_TOKEN, 'owner@private.example']) assert.equal(dump.includes(secret), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('T5-03 figma_to_live_artifact returns script-free, escaped, standalone HTML', async () => {
  const { server, baseUrl } = await startApp();
  try {
    const result = await rpc(baseUrl, 3, 'figma_to_live_artifact', { fileKey: FILE_KEY, title: 'واجهة سيليا' });
    assert.equal(result.result.isError, false);
    const data = result.result.structuredContent;
    assert.equal(data.provider, 'figma-live-artifact');
    assert.equal(data.safe, true);
    assert.equal(data.scriptFree, true);
    assert.equal(data.title, 'واجهة سيليا');
    assert.equal(data.html.includes('<script'), false);
    assert.equal(data.html.includes('http://'), false);
    assert.equal(data.html.includes('https://'), false);
    assert.match(data.html, /&lt;script&gt;/);
    assert.equal(JSON.stringify(result).includes(FIGMA_TOKEN), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('T5-04 the public tool studio uses a local demo only — zero Figma API calls', async () => {
  const { server, baseUrl, calls } = await startApp();
  try {
    for (const [id, name] of [
      [4, 'figma_inspect_design'],
      [5, 'figma_to_live_artifact']
    ]) {
      const response = await fetch(`${baseUrl}/ui/workspace/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { fileKey: FILE_KEY } } })
      }).then((r) => r.json());
      assert.equal(response.sandbox, true);
      assert.equal(response.result.isError, false);
      assert.equal(response.result.structuredContent.sandboxOnly, true);
      if (response.result.structuredContent.html) {
        assert.equal(response.result.structuredContent.html.includes('<script'), false);
      }
    }
    assert.equal(calls.length, 0, 'sandbox must never call Figma');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('T5-05 a rejected or missing token produces a clean MCP error with no secret leakage', async () => {
  const { server, baseUrl } = await startApp({ figmaFetchImpl: async () => jsonResponse({ err: `bad ${FIGMA_TOKEN}` }, 401) });
  try {
    const result = await rpc(baseUrl, 6, 'figma_inspect_design', { fileKey: FILE_KEY });
    assert.equal(result.result.isError, true);
    assert.equal(JSON.stringify(result).includes(FIGMA_TOKEN), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const second = await startApp({ env: { CELIA_MCP_API_TOKEN: token } });
  try {
    const result = await rpc(second.baseUrl, 7, 'figma_inspect_design', { fileKey: FILE_KEY });
    assert.equal(result.result.isError, true);
    assert.equal(second.calls.length, 0);
    assert.match(JSON.stringify(result), /not configured/);
  } finally {
    await new Promise((resolve) => second.server.close(resolve));
  }
});
