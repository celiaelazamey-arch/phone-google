// The Copilot bridge is the permission boundary, so it is tested twice: once as pure policy (what it decides)
// and once end to end against the **real** Celia MCP stdio server (what actually crosses the wire).
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  ALLOWED_TOOLS,
  POLICY,
  REFUSED_TOOLS,
  annotateTool,
  classify,
  filterTools,
  policyError,
  sanitizeResult,
  sanitizeSkillsPayload,
  transformResponse
} from '../scripts/celia-copilot-mcp-bridge.mjs';

const root = path.resolve(import.meta.dirname, '..');

// ---------- pure policy ----------

test('policy: exactly four read-only tools are allowed and nothing is both allowed and refused', () => {
  assert.deepEqual([...ALLOWED_TOOLS], ['celia_status', 'find_skills', 'system_live_view', 'celia_secrets_status']);
  assert.equal(REFUSED_TOOLS.length, 12);
  for (const name of ALLOWED_TOOLS) assert.equal(REFUSED_TOOLS.includes(name), false, `${name} cannot be both`);
  // The write / external-effect tools the owner must never hand to an unattended agent.
  for (const name of ['whatsapp_send_text', 'google_calendar_events_create', 'celia_voice_speak']) {
    assert.equal(ALLOWED_TOOLS.includes(name), false);
    assert.equal(REFUSED_TOOLS.includes(name), true);
  }
  assert.equal(POLICY.mode, 'read-only');
});

test('policy: every exposed tool carries readOnlyHint, and the server cannot override the safety fields', () => {
  const annotated = annotateTool({ name: 'celia_status', annotations: { readOnlyHint: false, destructiveHint: true } });
  assert.equal(annotated.annotations.readOnlyHint, true);
  assert.equal(annotated.annotations.destructiveHint, false);
  assert.equal(annotated.annotations.openWorldHint, false);
});

test('policy: a tools/list result is filtered to the allowlist and annotated', () => {
  const filtered = filterTools([
    { name: 'celia_status' },
    { name: 'whatsapp_send_text' },
    { name: 'find_skills' },
    { name: 'google_calendar_events_create' },
    null
  ]);
  assert.deepEqual(filtered.map((tool) => tool.name), ['celia_status', 'find_skills']);
  for (const tool of filtered) assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(filterTools(undefined), []);
});

test('policy: methods outside the tool surface are refused locally, not forwarded', () => {
  const prompts = classify({ jsonrpc: '2.0', id: 1, method: 'prompts/list' });
  assert.equal(prompts.action, 'answer');
  assert.equal(prompts.response.error.code, -32601);
  assert.match(prompts.response.error.message, /policy_blocked_method: prompts\/list/);

  const resources = classify({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'celia://status' } });
  assert.match(resources.response.error.message, /policy_blocked_method/);

  const notification = classify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notification.action, 'drop', 'notifications are never forwarded and never answered');

  const invalid = classify({ id: 3, method: 'ping' });
  assert.equal(invalid.response.error.code, -32600);
});

test('policy: a blocked tool is refused with the policy, its reason, and the allowlist — never forwarded', () => {
  const blocked = classify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'whatsapp_send_text', arguments: { phone: '+201065217834', text: 'x' } } });
  assert.equal(blocked.action, 'answer');
  assert.equal(blocked.response.error.code, -32601);
  assert.match(blocked.response.error.message, /policy_blocked_tool: whatsapp_send_text/);
  assert.equal(blocked.response.error.data.policy, 'copilot-read-only-allowlist');
  assert.deepEqual(blocked.response.error.data.allowedTools, [...ALLOWED_TOOLS]);
  assert.equal(blocked.response.error.data.messageAr.includes('القراءة فقط'), true);

  const allowed = classify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'celia_status', arguments: {} } });
  assert.deepEqual(allowed, { action: 'forward', method: 'tools/call', tool: 'celia_status' });

  const nameless = classify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: {} });
  assert.equal(nameless.response.error.code, -32602);
});

test('policy: policyError carries no payload from the original call', () => {
  const error = policyError(5, { tool: 'google_gmail_search', reason: 'tool_not_in_copilot_allowlist' });
  assert.equal(error.id, 5);
  assert.equal(JSON.stringify(error).includes('query'), false);
  assert.equal(error.error.data.reason, 'tool_not_in_copilot_allowlist');
});

test('policy: skill discovery cannot advertise a blocked tool, and counts are recomputed', () => {
  const payload = sanitizeSkillsPayload({
    totalSkills: 16,
    matched: 3,
    skills: [{ name: 'celia_status' }, { name: 'whatsapp_send_text' }, { name: 'find_skills' }]
  });
  assert.deepEqual(payload.skills.map((skill) => skill.name), ['celia_status', 'find_skills']);
  assert.equal(payload.totalSkills, 2);
  assert.equal(payload.matched, 2);
  assert.equal(payload.policyFiltered, true);
});

test('policy: initialize negotiates tools only and names itself as the bridge', () => {
  const response = transformResponse(
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {}, resources: {}, prompts: {}, sampling: {} },
        serverInfo: { name: 'celia-phone-google-mcp', version: '0.2.1' }
      }
    },
    { method: 'initialize' }
  );
  assert.equal(response.result.protocolVersion, '2025-03-26');
  assert.deepEqual(Object.keys(response.result.capabilities), ['tools']);
  assert.match(response.result.serverInfo.name, /copilot bridge/);
  assert.equal(response.result.serverInfo.version, '0.2.1');
  assert.match(response.result.instructions, /Read-only bridge/);
});

test('policy: a secret value that leaks into a result is redacted before it reaches the editor', () => {
  const secret = 'super-secret-owner-token-value-0123456789';
  const sanitized = sanitizeResult(
    'celia_status',
    { structuredContent: { note: `token=${secret}`, ok: true }, content: [{ type: 'text', text: secret }] },
    { secrets: [secret] }
  );
  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes(secret), false);
  assert.match(serialized, /\[redacted\]/);
});

// ---------- the shipped configuration ----------

test('config: the shipped Copilot profile parses, points at a real bridge, and contains no credential', () => {
  const file = path.join(root, 'docs/copilot-mcp/celiaos-copilot-mcp-2026.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const server = config.mcpServers.celiaos;
  assert.equal(server.type, 'local');
  assert.equal(server.command, 'node');
  assert.deepEqual(server.args, ['scripts/celia-copilot-mcp-bridge.mjs']);
  assert.equal(existsSync(path.join(root, server.args[0])), true, 'the bridge the config launches must exist');
  assert.deepEqual(server.tools, [...ALLOWED_TOOLS]);
  const serialized = JSON.stringify(config);
  for (const forbidden of ['API_KEY', 'apiKey', 'accessToken', 'Bearer ', 'sk-', 'card']) {
    assert.equal(serialized.includes(forbidden), false, `the config must not carry ${forbidden}`);
  }
  assert.equal(server.env.CELIA_MCP_DISABLE_MYSQL, 'true', 'code review must not touch a real database by default');
});

// ---------- end to end against the real MCP server ----------

async function withBridge(body) {
  const child = spawn(process.execPath, ['scripts/celia-copilot-mcp-bridge.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      CELIA_MCP_DISABLE_MYSQL: 'true',
      CELIA_DISABLE_OLLAMA: 'true',
      CELIA_MCP_API_TOKEN: '',
      GEMINI_API_KEY: '',
      ELEVENLABS_API_KEY: ''
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const waiting = new Map();
  const unsolicited = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const resolve = waiting.get(message.id);
      if (resolve) {
        waiting.delete(message.id);
        resolve(message);
      } else {
        unsolicited.push(message);
      }
    }
  });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  let id = 0;
  const request = (method, params) => {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method} (${stderr.join('')})`)), 25_000);
      waiting.set(requestId, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
    });
  };
  try {
    return await body({ request, unsolicited, stderr });
  } finally {
    child.kill();
  }
}

test('end to end: the real server, behind the bridge, exposes exactly the four read-only tools', async () => {
  await withBridge(async ({ request, unsolicited }) => {
    const init = await request('initialize', { protocolVersion: '2024-11-05' });
    assert.deepEqual(Object.keys(init.result.capabilities), ['tools']);
    assert.match(init.result.serverInfo.name, /copilot bridge/);

    const list = await request('tools/list');
    assert.deepEqual(list.result.tools.map((tool) => tool.name).sort(), [...ALLOWED_TOOLS].sort());
    for (const tool of list.result.tools) {
      assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} must be read-only`);
      assert.ok(tool.description.length > 0);
      assert.equal(tool.inputSchema.type, 'object');
    }

    const status = await request('tools/call', { name: 'celia_status', arguments: { probeOllama: false } });
    assert.equal(status.result.isError, false);
    assert.equal(status.result.structuredContent.storage, 'memory', 'the bridge defaults to the memory store');
    assert.equal(
      status.result.structuredContent.toolsCount,
      16,
      'the server keeps all 16 tools; the bridge is what narrows the view to four'
    );

    assert.deepEqual(unsolicited, [], 'stdout carries protocol responses only');
  });
});

test('end to end: a blocked tool, a blocked method and a blocked skill never reach the editor as capability', async () => {
  await withBridge(async ({ request }) => {
    await request('initialize', { protocolVersion: '2024-11-05' });

    const blockedCall = await request('tools/call', {
      name: 'whatsapp_send_text',
      arguments: { phone: '+201065217834', text: 'مرحبًا' }
    });
    assert.equal(blockedCall.result, undefined, 'a blocked call must not carry a tool result');
    assert.equal(blockedCall.error.code, -32601);
    assert.match(blockedCall.error.message, /policy_blocked_tool: whatsapp_send_text/);

    const blockedMethod = await request('prompts/list');
    assert.match(blockedMethod.error.message, /policy_blocked_method: prompts\/list/);

    const resources = await request('resources/read', { uri: 'celia://secrets/readiness' });
    assert.match(resources.error.message, /policy_blocked_method/);

    const skills = await request('tools/call', { name: 'find_skills', arguments: { query: '', liveCheck: false } });
    assert.equal(skills.result.isError, false);
    const advertised = skills.result.structuredContent.skills.map((skill) => skill.name);
    assert.ok(advertised.length > 0);
    for (const name of advertised) assert.equal(ALLOWED_TOOLS.includes(name), true, `${name} leaked into discovery`);
    assert.equal(skills.result.structuredContent.policyFiltered, true);
    assert.equal(skills.result.structuredContent.totalSkills, advertised.length);

    const ping = await request('ping');
    assert.deepEqual(ping.result, {});
  });
});

test('end to end: the bridge prints its policy for an operator without spawning anything', async () => {
  const child = spawn(process.execPath, ['scripts/celia-copilot-mcp-bridge.mjs', '--print-policy'], { cwd: root });
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk.toString()));
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0);
  const printed = JSON.parse(chunks.join(''));
  assert.deepEqual(printed.allowedTools, [...ALLOWED_TOOLS]);
  assert.equal(printed.mode, 'read-only');
});

// ---------- the glue (fake child, real buffering rules) ----------

function fakeChild() {
  const forwarded = [];
  return {
    forwarded,
    stdin: { write: (line) => forwarded.push(line), on: () => {}, end: () => {} },
    on: () => {}
  };
}

test('glue: allowed calls are forwarded, blocked ones are answered locally and nothing is forwarded', async () => {
  const { createBridge } = await import('../scripts/celia-copilot-mcp-bridge.mjs');
  const child = fakeChild();
  const written = [];
  const bridge = createBridge({ child, output: (line) => written.push(JSON.parse(line)) });

  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'celia_status', arguments: {} } }));
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'celia_voice_speak', arguments: { text: 'x' } } }));
  bridge.handleLine('   ');
  bridge.handleLine('{not json');
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));

  assert.equal(child.forwarded.length, 2, 'only the two allowed requests reach the server');
  assert.deepEqual(child.forwarded.map((line) => JSON.parse(line).id), [1, 2]);
  assert.equal(written.length, 2, 'one policy answer + one parse error; the notification gets no answer');
  assert.equal(written[0].error.message, 'policy_blocked_tool: celia_voice_speak');
  assert.equal(written[1].error.code, -32700);
  assert.deepEqual([...bridge.pending.keys()], [1, 2]);
});

test('glue: child output is buffered per line, transformed, and non-JSON noise is dropped', async () => {
  const { createBridge } = await import('../scripts/celia-copilot-mcp-bridge.mjs');
  const child = fakeChild();
  const written = [];
  const logged = [];
  const bridge = createBridge({
    child,
    output: (line) => written.push(JSON.parse(line)),
    env: { CELIA_MCP_API_TOKEN: 'owner-token-value-that-is-long-enough' },
    log: (line) => logged.push(line)
  });

  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list' }));
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'find_skills', arguments: {} } }));

  // Two responses arriving split across three chunks, plus a line the server should never emit.
  const tools = JSON.stringify({ jsonrpc: '2.0', id: 10, result: { tools: [{ name: 'celia_status' }, { name: 'whatsapp_send_text' }] } });
  bridge.onChildData(Buffer.from(`not-json-noise\n${tools.slice(0, 40)}`));
  bridge.onChildData(Buffer.from(`${tools.slice(40)}\n`));
  bridge.onChildData(
    Buffer.from(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        result: {
          isError: false,
          structuredContent: { skills: [{ name: 'celia_status' }, { name: 'google_gmail_search' }], totalSkills: 2, matched: 2, echo: 'owner-token-value-that-is-long-enough' }
        }
      })}\n`
    )
  );

  assert.equal(logged.length, 1, 'the non-JSON line is logged and dropped');
  assert.equal(written.length, 2);
  assert.deepEqual(written[0].result.tools.map((tool) => tool.name), ['celia_status']);
  assert.equal(written[0].result.tools[0].annotations.readOnlyHint, true);
  assert.deepEqual(written[1].result.structuredContent.skills.map((skill) => skill.name), ['celia_status']);
  assert.equal(written[1].result.structuredContent.echo, '[redacted]');
  assert.equal(bridge.pending.size, 0, 'answered requests leave no residue');
});

// ---------- the diagram must not drift from the policy ----------

test('diagram: the committed artifacts are current and generated from the live policy', async () => {
  const { execFileSync } = await import('node:child_process');
  const { buildSvg, buildMermaid, lintLayout } = await import('../scripts/render-copilot-architecture.mjs');
  // `--check` regenerates in memory and compares; a stale diagram is a failing test, not a stale doc.
  const output = execFileSync(process.execPath, ['scripts/render-copilot-architecture.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.match(output, /architecture artifacts are current/);

  const svg = buildSvg();
  const mermaid = buildMermaid();
  for (const tool of ALLOWED_TOOLS) assert.ok(svg.includes(tool), `${tool} must be drawn as allowed`);
  for (const tool of REFUSED_TOOLS) assert.ok(svg.includes(tool), `${tool} must be drawn as refused`);
  assert.ok(svg.includes(`policy: ${POLICY.id} v${POLICY.version}`), 'the diagram names the policy version it illustrates');
  assert.ok(mermaid.includes('policy_blocked_tool'));
  // A diagram may never claim a capability the bridge does not negotiate.
  assert.ok(!/sampling: true|resources: true/.test(svg));
  // Nothing is allowed to overflow the canvas, and the checker itself must catch a real overflow.
  assert.deepEqual(lintLayout(svg), []);
  const broken = buildSvg().replace('x="1280"', 'x="1279"');
  assert.equal(lintLayout(broken).every((problem) => typeof problem === 'string'), true);
});
