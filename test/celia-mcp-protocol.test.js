// MCP protocol surface: a client must be able to negotiate, list, read and fail predictably. These are the
// methods a real MCP client (Claude Desktop, Codex, any SDK) calls before it ever runs a tool.
import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { createCeliaMcpApp, loadCeliaMcpConfig } from '../src/celia-mcp.js';
import { createMemoryPool } from '../src/memory-pool.js';

const token = crypto.randomBytes(32).toString('hex');

async function withServer(body) {
  const pool = createMemoryPool();
  const config = loadCeliaMcpConfig({ CELIA_MCP_API_TOKEN: token, CELIA_MCP_DISABLE_MYSQL: 'true', CELIA_DISABLE_OLLAMA: 'true' });
  const server = createCeliaMcpApp({ pool, config }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let id = 0;
  const rpc = async (method, params) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    return await body({ rpc, baseUrl });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
}

test('protocol: negotiation, ping and unknown-version fallback', async () => {
  await withServer(async ({ rpc }) => {
    const supported = await rpc('initialize', { protocolVersion: '2025-03-26' });
    assert.equal(supported.body.result.protocolVersion, '2025-03-26');
    assert.equal(supported.body.result.capabilities.resources.subscribe, false);

    const fallback = await rpc('initialize', { protocolVersion: '1999-01-01' });
    assert.notEqual(fallback.body.result.protocolVersion, '1999-01-01');
    assert.ok(['2024-11-05', '2025-03-26'].includes(fallback.body.result.protocolVersion));

    const ping = await rpc('ping');
    assert.deepEqual(ping.body.result, {});
  });
});

test('protocol: resources are listed and readable — status, sanitized secrets, and the customer-reply policy', async () => {
  await withServer(async ({ rpc }) => {
    const list = await rpc('resources/list');
    const uris = list.body.result.resources.map((resource) => resource.uri);
    assert.deepEqual(uris, ['celia://status', 'celia://secrets/readiness', 'celia://policy/customer-reply']);

    const status = await rpc('resources/read', { uri: 'celia://status' });
    assert.match(status.body.result.contents[0].text, /storage/);
    assert.ok(!status.body.result.contents[0].text.includes(token), 'the server token is never a resource');

    const secrets = await rpc('resources/read', { uri: 'celia://secrets/readiness' });
    const readiness = JSON.parse(secrets.body.result.contents[0].text);
    assert.ok(Number.isInteger(readiness.totalSecretsTracked));
    assert.ok(!("values" in readiness));

    const policy = await rpc('resources/read', { uri: 'celia://policy/customer-reply' });
    assert.equal(policy.body.result.contents[0].mimeType, 'text/plain');
    assert.ok(policy.body.result.contents[0].text.length > 10);

    const unknown = await rpc('resources/read', { uri: 'celia://nope' });
    assert.match(unknown.body.error.message, /Unknown resource URI/);
  });
});

test('protocol: the customer-reply prompt is served and unknown prompts are refused', async () => {
  await withServer(async ({ rpc }) => {
    const list = await rpc('prompts/list');
    assert.equal(list.body.result.prompts[0].name, 'whatsapp_customer_reply');

    const prompt = await rpc('prompts/get', {
      name: 'whatsapp_customer_reply',
      arguments: { customerMessage: 'كم السعر؟', businessContext: 'متجر صغير' }
    });
    const text = prompt.body.result.messages[0].content.text;
    assert.match(text, /كم السعر؟/);
    assert.match(text, /متجر صغير/);

    const withDefaultContext = await rpc('prompts/get', { name: 'whatsapp_customer_reply', arguments: {} });
    assert.match(withDefaultContext.body.result.messages[0].content.text, /رسالة العميل/);

    const unknown = await rpc('prompts/get', { name: 'other_prompt' });
    assert.match(unknown.body.error.message, /Unknown prompt/);
  });
});

test('protocol: malformed requests and unknown methods fail with the standard codes', async () => {
  await withServer(async ({ rpc, baseUrl }) => {
    const missingToolName = await rpc('tools/call', { arguments: {} });
    assert.match(missingToolName.body.error.message, /Tool name is required/);

    const unknownMethod = await rpc('tools/teleport');
    assert.equal(unknownMethod.body.error.code, -32601);

    const invalid = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: 9, method: 'ping' })
    });
    const invalidBody = await invalid.json();
    assert.equal(invalidBody.error.code, -32600);
    assert.equal(invalidBody.id, 9);

    const notJson = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{not json'
    });
    assert.equal(notJson.status, 400);
  });
});

test('protocol: a notification needs no id and returns 202, and a wrong token stays 401', async () => {
  await withServer(async ({ baseUrl }) => {
    const notification = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    });
    assert.equal(notification.status, 202);

    const wrongToken = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token-wrong-token-wrong-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    });
    assert.equal(wrongToken.status, 401);
  });
});
