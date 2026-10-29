import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createGmailReadConnector,
  GMAIL_CONNECTOR,
  GMAIL_MAX_RESULTS,
  GMAIL_TOOL
} from '../src/agent/gmail.js';
import { createDefaultTools, validateToolInput } from '../src/agent/tools.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createScriptedPlanner } from '../src/agent/planner.js';
import { createAgentHost, readAgentConnectors } from '../src/agent/index.js';
import { createEmptyConnectorRegistry } from '../src/agent/connectors.js';
import { RUN_STATUS } from '../src/agent/store.js';
import { createTempStore } from './support/agent-fixtures.js';

function message(id, extra = {}) {
  return {
    id,
    from: 'Ahmed <ahmed@example.com>',
    subject: `رسالة ${id}`,
    date: '2026-10-29T08:00:00.000Z',
    unread: true,
    ...extra
  };
}

test('Gmail reader: latest five are metadata-only and the transport receives no credentials', async () => {
  const calls = [];
  const reader = createGmailReadConnector({
    transport: {
      async listMessages(args) {
        calls.push(args);
        return Array.from({ length: 7 }, (_, index) => message(`m${index + 1}`, {
          snippet: 'م'.repeat(900),
          body: 'secret body',
          accessToken: 'must-not-cross-the-contract'
        }));
      }
    }
  });

  const result = await reader.read({ unreadOnly: true });
  assert.equal(reader.name, GMAIL_CONNECTOR);
  assert.equal(reader.readOnly, true);
  assert.deepEqual(calls, [{ maxResults: GMAIL_MAX_RESULTS, unreadOnly: true, signal: undefined }]);
  assert.equal(result.provider, GMAIL_CONNECTOR);
  assert.equal(result.readOnly, true);
  assert.equal(result.count, 5);
  assert.equal(result.messages.length, 5);
  assert.deepEqual(Object.keys(result.messages[0]), ['id', 'from', 'subject', 'date', 'snippet', 'unread']);
  assert.equal(result.messages[0].body, undefined);
  assert.equal(result.messages[0].snippet, 'م'.repeat(500));
  assert.equal(result.messages[0].accessToken, undefined);
});

test('Gmail reader: malformed limits and filters fail before transport', async () => {
  let calls = 0;
  const reader = createGmailReadConnector({
    transport: { async listMessages() { calls += 1; return []; } }
  });
  for (const [args, code] of [
    [{ maxResults: 0 }, 'invalid_gmail_limit'],
    [{ maxResults: 6 }, 'invalid_gmail_limit'],
    [{ maxResults: 1.5 }, 'invalid_gmail_limit'],
    [{ maxResults: '5' }, 'invalid_gmail_limit'],
    [{ unreadOnly: 'true' }, 'invalid_gmail_unread_filter']
  ]) {
    await assert.rejects(() => reader.read(args), (error) => error.code === code);
  }
  assert.equal(calls, 0, 'invalid input must not reach Google or a mock transport');
  assert.throws(() => createGmailReadConnector({ transport: {} }), /listMessages/);
});

test('Gmail reader: provider errors are safe codes, never token-bearing messages', async () => {
  const reader = createGmailReadConnector({
    transport: {
      async listMessages() {
        throw Object.assign(new Error('401 ya29.secret-token'), { status: 401 });
      }
    }
  });
  await assert.rejects(
    () => reader.read(),
    (error) => error.code === 'gmail_authorization_failed'
      && error.message === 'gmail_authorization_failed'
      && !/ya29|secret-token/.test(error.message)
  );

  const disconnected = createGmailReadConnector({
    transport: { async listMessages() { throw Object.assign(new Error('no stored grant'), { status: 409 }); } }
  });
  await assert.rejects(() => disconnected.read(), (error) => error.code === 'google_not_connected');
});

test('Gmail tool: closed arguments, read risk, and no registration without a reader', async () => {
  const calls = [];
  const reader = createGmailReadConnector({
    transport: { async listMessages(args) { calls.push(args); return [message('m1'), message('m2')]; } }
  });
  const tools = createDefaultTools({ gmail: reader, documentAutomation: false });
  const tool = tools.get(GMAIL_TOOL);
  assert.ok(tool);
  assert.equal(tool.risk, 'read');
  assert.equal(tool.requiresApproval, false);
  assert.equal(tool.connector, GMAIL_CONNECTOR);
  assert.equal(validateToolInput(tool, { maxResults: 2, unreadOnly: false }).ok, true);
  assert.equal(validateToolInput(tool, { maxResults: 6 }).code, 'invalid_gmail_limit');
  assert.equal(validateToolInput(tool, { q: 'from:someone' }).code, 'policy_violation_unknown_argument');
  assert.equal(validateToolInput(tool, { accessToken: 'do-not-pass' }).code, 'policy_violation_secret_in_args');
  assert.equal(calls.length, 0);

  const result = await tool.execute({ maxResults: 2, unreadOnly: false }, {});
  assert.equal(result.count, 2);
  assert.deepEqual(calls, [{ maxResults: 2, unreadOnly: false, signal: undefined }]);
  assert.equal(createDefaultTools({ documentAutomation: false }).has(GMAIL_TOOL), false);
});

test('Gmail Runtime: a read produces evidence and no outbox entry or approval', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const calls = [];
  const reader = createGmailReadConnector({
    transport: {
      async listMessages(args) {
        calls.push(args);
        return [message('m1'), message('m2', { unread: false })];
      }
    }
  });
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: createDefaultTools({ gmail: reader, documentAutomation: false }),
    planner: createScriptedPlanner([
      { action: 'call', tool: GMAIL_TOOL, args: { maxResults: 2, unreadOnly: true } }
    ]),
    workerId: 'gmail-test-worker',
    logger: { error() {} }
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'قراءة الوارد' });
  const { run } = await runtime.submit({ threadId: thread.id, message: 'اقرأ آخر رسالتين' });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.succeeded);

  const detail = await runtime.detail(run.id);
  const toolRun = detail.toolRuns.find((entry) => entry.toolName === GMAIL_TOOL);
  assert.equal(toolRun.status, 'succeeded');
  assert.equal(toolRun.outcome.count, 2);
  assert.equal(toolRun.outcome.messages[1].unread, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(detail.outbox, []);
  assert.deepEqual(detail.approvals, []);
  assert.equal(detail.evidenceChain.ok, true);
  assert.ok(detail.evidence.some((entry) => entry.kind === 'tool_call' && entry.outputHash), 'the read result is hash-chained, not raw evidence content');
});

test('Gmail host: CELIA_AGENT_CONNECTORS=gmail wires the reader without a Google call', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-gmail-host-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const host = createAgentHost({
    config: {
      nodeEnv: 'test',
      userId: 'owner',
      google: { clientId: 'configured-id', clientSecret: 'configured-secret' }
    },
    pool: { isMemory: false },
    env: {
      NODE_ENV: 'test',
      CELIA_AGENT_RUNTIME: 'sqlite',
      CELIA_AGENT_SQLITE_PATH: path.join(directory, 'agent.sqlite3'),
      CELIA_AGENT_CONNECTORS: 'gmail'
    },
    logger: { info() {}, error() {} }
  });
  const runtime = await host.ready;
  t.after(() => runtime.shutdown());
  assert.ok(runtime.status().tools.some((tool) => tool.name === GMAIL_TOOL));
  assert.deepEqual(runtime.status().connectors, [], 'read-only Gmail is not an outbox connector');
  assert.deepEqual(readAgentConnectors({ CELIA_AGENT_CONNECTORS: 'gmail, gmail' }), ['gmail']);
});

test('Gmail host: the explicit demo intent reaches the reader and renders subjects without an external-effect connector', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-gmail-injected-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const reader = createGmailReadConnector({
    transport: { async listMessages(args) { calls.push(args); return [message('m1')]; } }
  });
  const host = createAgentHost({
    config: { nodeEnv: 'test' },
    env: {
      NODE_ENV: 'test',
      CELIA_AGENT_RUNTIME: 'sqlite',
      CELIA_AGENT_SQLITE_PATH: path.join(directory, 'agent.sqlite3'),
      CELIA_AGENT_CONNECTORS: 'none'
    },
    connectors: createEmptyConnectorRegistry(),
    gmail: reader,
    logger: { info() {}, error() {} }
  });
  const runtime = await host.ready;
  t.after(() => runtime.shutdown());
  assert.equal(runtime.status().tools.some((tool) => tool.name === GMAIL_TOOL), true);

  const thread = await runtime.store.createThread({ ownerId: 'owner', title: 'Gmail' });
  const { run } = await runtime.submit({ threadId: thread.id, message: 'اقرأ آخر خمس رسائل في Gmail' });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.succeeded);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxResults, 5);
  assert.equal(calls[0].unreadOnly, false);
  assert.equal(typeof calls[0].signal?.aborted, 'boolean');
  const detail = await runtime.detail(run.id);
  assert.match(detail.steps.at(-1).summary, /رسالة m1/);
  assert.deepEqual(detail.outbox, []);
});
