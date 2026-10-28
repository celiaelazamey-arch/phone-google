#!/usr/bin/env node
/**
 * CeliaOS Copilot MCP bridge — the policy layer between GitHub Copilot and the Celia MCP server.
 *
 * GitHub Copilot can call the MCP tools enabled for it without asking the owner for each call, so the
 * permission boundary cannot live in the client's conscience. It lives here, in code that runs in front of
 * the server:
 *
 *   1. an explicit allowlist of four read-only tools (`celia_status`, `find_skills`, `system_live_view`,
 *      `celia_secrets_status`) — everything else is refused locally, never forwarded;
 *   2. `annotations.readOnlyHint: true` (plus destructive/openWorld = false) stamped on every tool it
 *      exposes, which is what Copilot's code review requires before it will use a tool;
 *   3. a restricted `initialize` handshake: tools only — no prompts, no resources, no sampling — so a client
 *      cannot reach a surface the policy did not review;
 *   4. result sanitization: skill discovery is cut down to the allowed tools and any secret value that
 *      leaked into a result is replaced with `[redacted]` before it reaches the editor.
 *
 * Transport: the bridge is a stdio MCP server itself. It speaks JSON-RPC 2.0 on stdin/stdout (one message
 * per line, exactly like the server it fronts) and proxies the allowed calls to
 * `node src/celia-mcp.js --stdio`. Logs go to stderr only; stdout carries protocol lines and nothing else.
 *
 *   node scripts/celia-copilot-mcp-bridge.mjs                 # run as an MCP server (what Copilot launches)
 *   node scripts/celia-copilot-mcp-bridge.mjs --print-policy  # print the machine-readable policy and exit
 *
 * No API key, no database and no card are required: by default the child runs on the in-memory store
 * (`CELIA_MCP_DISABLE_MYSQL=true` unless the operator sets it), so a code review can never write to the
 * owner's production database.
 */
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHILD_ENTRY = path.join(ROOT, 'src/celia-mcp.js');

/** The only tools Copilot may see or call. Read-only by contract, not by promise. */
export const ALLOWED_TOOLS = Object.freeze([
  'celia_status',
  'find_skills',
  'system_live_view',
  'celia_secrets_status'
]);

/** Tools that exist on the server and are deliberately refused here (kept for auditing and docs). */
export const REFUSED_TOOLS = Object.freeze([
  'celia_ai_reply',
  'google_gmail_search',
  'google_drive_search',
  'google_calendar_events_list',
  'google_calendar_events_create',
  'google_contacts_search',
  'whatsapp_consent_upsert',
  'whatsapp_contacts_list',
  'whatsapp_send_text',
  'celia_voice_speak',
  'figma_file_inspect',
  'codata_status'
]);

/** Only these JSON-RPC methods cross the bridge; everything else is answered locally with a policy error. */
export const ALLOWED_METHODS = Object.freeze(['initialize', 'ping', 'tools/list', 'tools/call']);

/** Which capability groups the bridge negotiates. Prompts, resources and sampling are intentionally absent. */
export const NEGOTIATED_CAPABILITIES = Object.freeze({ tools: { listChanged: false } });

export const POLICY = Object.freeze({
  id: 'copilot-read-only-allowlist',
  version: 1,
  mode: 'read-only',
  allowedTools: ALLOWED_TOOLS,
  refusedTools: REFUSED_TOOLS,
  allowedMethods: ALLOWED_METHODS,
  capabilities: NEGOTIATED_CAPABILITIES,
  annotations: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
  reason: 'GitHub Copilot may call enabled MCP tools without a per-call approval, so the read-only allowlist is enforced in code in front of the server, not in the client configuration alone.'
});

/** Mark a tool as read-only for the client, without letting the server override the safety fields. */
export function annotateTool(tool) {
  return {
    ...tool,
    annotations: {
      ...(tool?.annotations || {}),
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  };
}

/** Filter a tools/list result down to the allowlist and stamp annotations on what survives. */
export function filterTools(tools) {
  const list = Array.isArray(tools) ? tools : [];
  return list.filter((tool) => Boolean(tool) && ALLOWED_TOOLS.includes(tool.name)).map(annotateTool);
}

/** A refusal that never reaches the server: the caller learns the policy, not the tool. */
export function policyError(id, { tool = null, method = null, reason = 'policy_blocked' } = {}) {
  const target = tool || method || 'request';
  const code = tool ? `policy_blocked_tool: ${tool}` : `policy_blocked_method: ${method}`;
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code: -32601,
      message: code,
      data: {
        policy: POLICY.id,
        reason,
        allowedTools: ALLOWED_TOOLS,
        messageAr: tool
          ? 'هذه الأداة محظورة على Copilot: الطبقة الوسيطة تسمح بأدوات القراءة فقط.'
          : 'هذا النوع من الطلبات غير مفعّل لهذا العميل: الأدوات فقط، بلا prompts أو resources.'
      }
    }
  };
}

/** Decide what happens to one inbound JSON-RPC message, before anything is spawned or forwarded. */
export function classify(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { action: 'answer', response: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request' } } };
  }
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return { action: 'answer', response: { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request' } } };
  }
  const { id, method, params } = message;
  if (method.startsWith('notifications/')) return { action: 'drop' };
  if (!ALLOWED_METHODS.includes(method)) {
    return { action: 'answer', response: policyError(id, { method, reason: 'method_not_enabled_for_copilot' }) };
  }
  if (method !== 'tools/call') return { action: 'forward', method };
  const name = String(params?.name || '');
  if (!name) {
    return { action: 'answer', response: { jsonrpc: '2.0', id: id ?? null, error: { code: -32602, message: 'Tool name is required' } } };
  }
  if (!ALLOWED_TOOLS.includes(name)) {
    return { action: 'answer', response: policyError(id, { tool: name, reason: 'tool_not_in_copilot_allowlist' }) };
  }
  return { action: 'forward', method, tool: name };
}

/** Skills discovery must not advertise what the policy forbids. */
export function sanitizeSkillsPayload(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.skills)) return payload;
  const skills = payload.skills.filter((skill) => skill && ALLOWED_TOOLS.includes(skill.name));
  return { ...payload, skills, totalSkills: skills.length, matched: skills.length, policyFiltered: true };
}

const SECRET_ENV_NAMES = Object.freeze([
  'CELIA_MCP_API_TOKEN', 'APP_API_TOKEN', 'ELEVENLABS_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_CLIENT_SECRET',
  'FIGMA_ACCESS_TOKEN', 'YOUR_CODATA_API_KEY', 'CODATA_API_KEY', 'DEEPSEEK_API_KEY', 'AI_GATEWAY_API_KEY',
  'AGENETROUTERAPI_KEY', 'AGENTROUTER_API_KEY', 'CLOUDFLARE_API_TOKEN', 'TOKEN_ENCRYPTION_KEY',
  'CELIAOS_CRONJOB_ORG_API_KEY', 'RENDER_API_KEY', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_APP_SECRET'
]);

/** Every configured secret value long enough to be a real credential (short ids are not redacted blindly). */
export function secretValues(env = process.env) {
  const values = [];
  for (const name of SECRET_ENV_NAMES) {
    const value = String(env[name] || '').trim();
    if (value.length >= 16 && !/^replace-with-/i.test(value)) values.push(value);
  }
  return values;
}

/** Deep redaction of secret values, plus the tool allowlist applied to skill discovery results. */
export function sanitizeResult(tool, result, { secrets = [] } = {}) {
  if (tool === 'find_skills' && result?.structuredContent) {
    result = { ...result, structuredContent: sanitizeSkillsPayload(result.structuredContent) };
  }
  let serialized = JSON.stringify(result ?? null);
  for (const secret of secrets) {
    if (secret && serialized.includes(secret)) serialized = serialized.split(secret).join('[redacted]');
  }
  try {
    return JSON.parse(serialized);
  } catch {
    return result;
  }
}

/** Rewrite one server response before it reaches Copilot. Responses we never solicited are dropped. */
export function transformResponse(response, context = {}, { secrets = [] } = {}) {
  if (!response || typeof response !== 'object') return null;
  if (!('result' in response)) {
    // Errors are forwarded as-is: they carry a code and a sanitized message, never a payload.
    return response.error ? { ...response, error: sanitizeResult(context.tool, response.error, { secrets }) } : null;
  }
  if (context.method === 'initialize') {
    const serverInfo = response.result?.serverInfo || {};
    return {
      jsonrpc: '2.0',
      id: response.id ?? null,
      result: {
        protocolVersion: response.result?.protocolVersion || '2024-11-05',
        capabilities: NEGOTIATED_CAPABILITIES,
        serverInfo: { ...serverInfo, name: `${serverInfo.name || 'celia-mcp'} (copilot bridge)` },
        instructions: 'Read-only bridge: only four status/discovery tools are exposed; write and external-effect tools are refused before they reach the server.'
      }
    };
  }
  if (context.method === 'tools/list') {
    return { jsonrpc: '2.0', id: response.id ?? null, result: { tools: filterTools(response.result?.tools) } };
  }
  if (context.method === 'tools/call') {
    return { jsonrpc: '2.0', id: response.id ?? null, result: sanitizeResult(context.tool, response.result, { secrets }) };
  }
  return response;
}

/**
 * Glue between stdin, the child server and stdout. `child` is anything with
 * `stdin.write`, `stdout.on('data')`, `on('exit')` — the real process, or a fake in tests.
 */
export function createBridge({ child, output, env = process.env, log = (line) => process.stderr.write(`${line}\n`) }) {
  const secrets = secretValues(env);
  const pending = new Map();
  let buffered = '';

  const write = (message) => output(`${JSON.stringify(message)}\n`);

  const onChildData = (chunk) => {
    buffered += chunk.toString();
    let index;
    while ((index = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, index).trim();
      buffered = buffered.slice(index + 1);
      if (!line) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        log('bridge: the server emitted a non-JSON line on stdout; dropped');
        continue;
      }
      const context = pending.get(parsed?.id) || {};
      pending.delete(parsed?.id);
      const transformed = transformResponse(parsed, context, { secrets });
      if (transformed) write(transformed);
    }
  };

  const handleLine = (line) => {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const decision = classify(message);
    if (decision.action === 'drop') return;
    if (decision.action === 'answer') {
      write(decision.response);
      return;
    }
    if (message.id !== undefined) pending.set(message.id, { method: decision.method, tool: decision.tool });
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  return { handleLine, onChildData, pending };
}

function spawnServer(env) {
  const child = spawn(process.execPath, [CHILD_ENTRY, '--stdio'], {
    cwd: ROOT,
    env: {
      ...env,
      // Memory by default: code review must never reach the owner's production database.
      CELIA_MCP_DISABLE_MYSQL: env.CELIA_MCP_DISABLE_MYSQL || 'true',
      // The server hides `celia_secrets_status` unless extended tools are on; the bridge re-filters anyway,
      // so enabling them lets the allowlist decide instead of the server's default.
      CELIA_EXTENDED_MCP_TOOLS: env.CELIA_EXTENDED_MCP_TOOLS || 'true'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return child;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--print-policy')) {
    process.stdout.write(`${JSON.stringify(POLICY, null, 2)}\n`);
    return 0;
  }
  const child = spawnServer(process.env);
  const bridge = createBridge({ child, output: (line) => process.stdout.write(line) });
  child.stdout.on('data', bridge.onChildData);
  child.on('exit', (code) => {
    process.stderr.write(`bridge: server exited (${code ?? 0})\n`);
    process.exitCode = code ?? 0;
  });
  child.stdin.on('error', () => {});
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', bridge.handleLine);
  rl.on('close', () => child.stdin.end());
  return new Promise(() => {});
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  process.exitCode = await main();
}
