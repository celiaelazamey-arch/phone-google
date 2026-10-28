// Every advertised MCP tool must answer — and must fail closed with a reason that names the missing
// capability — before any credential exists. A tool that silently succeeds without its provider would be
// exactly the "name, not a service" this repository refuses.
import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { createCeliaMcpApp, getActiveMcpTools, loadCeliaMcpConfig } from '../src/celia-mcp.js';
import { createMemoryPool } from '../src/memory-pool.js';

const token = crypto.randomBytes(32).toString('hex');

async function withMcp(body, env = {}) {
  const pool = createMemoryPool();
  const config = loadCeliaMcpConfig({ CELIA_MCP_API_TOKEN: token, CELIA_MCP_DISABLE_MYSQL: 'true', CELIA_DISABLE_OLLAMA: 'true', CELIA_EXTENDED_MCP_TOOLS: 'true', ...env });
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
    return response.json();
  };
  const call = (name, args) => rpc('tools/call', { name, arguments: args }).then((payload) => payload.result);
  try {
    return await body({ rpc, call, config, pool, baseUrl });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
}

test('tool sweep: every advertised tool is callable and refuses to invent an answer without its provider', async () => {
  await withMcp(async ({ call, rpc }) => {
    const defaultTools = getActiveMcpTools(loadCeliaMcpConfig({ CELIA_MCP_API_TOKEN: token })).map((tool) => tool.name);
    const extendedTools = getActiveMcpTools(loadCeliaMcpConfig({ CELIA_MCP_API_TOKEN: token, CELIA_EXTENDED_MCP_TOOLS: 'true' })).map((tool) => tool.name);
    assert.equal(defaultTools.length, 12, 'the twelve core tools are always on');
    assert.equal(extendedTools.length, defaultTools.length + 4, 'the four extended tools are opt-in');
    assert.equal(defaultTools.includes('celia_voice_speak'), false);

    // Input validation happens before any provider is touched.
    assert.match((await call('celia_ai_reply', {})).content[0].text, /customerMessage is required/);
    assert.match((await call('google_gmail_search', {})).content[0].text, /q is required/);
    assert.match((await call('google_drive_search', { q: '   ' })).content[0].text, /q is required/);
    assert.match((await call('google_contacts_search', {})).content[0].text, /q is required/);
    assert.match((await call('google_calendar_events_create', {})).content[0].text, /summary, start, and end are required/);
    assert.match(
      (await call('google_calendar_events_create', { summary: 'اجتماع', start: 'not-a-date', end: 'still-not' })).content[0].text,
      /invalid_event_time_range/
    );
    assert.match(
      (await call('google_calendar_events_create', { summary: 'اجتماع', start: '2026-11-01T09:00:00Z', end: '2026-11-01T08:00:00Z' })).content[0].text,
      /invalid_event_time_range/
    );
    assert.match((await call('whatsapp_send_text', { phone: '+201065217834' })).content[0].text, /valid_phone_and_text_required/);
    assert.match((await call('whatsapp_consent_upsert', { phone: '12345' })).content[0].text, /valid_phone_optedIn_and_consent_source_required/);

    // With no Google account linked and no provider keys, the provider-dependent tools fail closed.
    for (const [name, args] of [
      ['google_gmail_search', { q: 'from:me' }],
      ['google_drive_search', { q: 'تقرير' }],
      ['google_calendar_events_list', { days: 7 }],
      ['google_contacts_search', { q: 'أحمد' }],
      ['celia_voice_speak', { text: 'مرحبًا' }],
      ['figma_file_inspect', { fileKey: '' }]
    ]) {
      const result = await call(name, args);
      assert.ok(result, `${name} answered with a JSON-RPC error instead of a tool result`);
      assert.equal(result.isError, true, `${name} must not claim success without its provider`);
      assert.ok(String(result.content[0].text).length > 0, `${name} must explain itself`);
      assert.ok(!JSON.stringify(result).includes(token), `${name} must never echo the server token`);
    }

    // Local, provider-free tools answer from real state.
    const contacts = await call('whatsapp_contacts_list', {});
    assert.equal(contacts.isError, false);
    assert.deepEqual(contacts.structuredContent.contacts, []);

    const secrets = await call('celia_secrets_status', {});
    assert.equal(secrets.isError, false);
    assert.ok(secrets.structuredContent.totalSecretsTracked >= 9);

    const codata = await call('codata_status', { probe: false });
    assert.equal(codata.isError, false);

    const skills = await call('find_skills', { query: 'gmail', liveCheck: false });
    assert.equal(skills.isError, false);
    assert.ok(Array.isArray(skills.structuredContent.skills));

    const live = await call('system_live_view', { includeTelemetry: false, probeOllama: false });
    assert.equal(live.isError, false);

    const status = await call('celia_status', { probeOllama: false });
    assert.equal(status.isError, false);

    // An unknown tool is a protocol-level error, never a quiet empty success.
    const unknown = await rpc('tools/call', { name: 'not_a_real_tool', arguments: {} });
    assert.match(String(unknown.error?.message), /Unknown tool/);
  });
});

test('tool sweep: an unlinked Google account is reported as unlinked, not as an empty inbox', async () => {
  await withMcp(async ({ call }) => {
    const gmail = await call('google_gmail_search', { q: 'in:inbox' });
    assert.equal(gmail.isError, true);
    assert.match(String(gmail.content[0].text), /google|connect|token|refresh/i);
  });
});
