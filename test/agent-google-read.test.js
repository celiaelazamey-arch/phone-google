import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CALENDAR_READ_TOOL,
  CONTACTS_READ_TOOL,
  DRIVE_READ_TOOL,
  DRIVE_READ_CONNECTOR,
  CALENDAR_READ_CONNECTOR,
  CONTACTS_READ_CONNECTOR,
  createCalendarReadConnector,
  createContactsReadConnector,
  createDriveReadConnector
} from '../src/agent/google-read.js';
import { GMAIL_TOOL, createGmailReadConnector } from '../src/agent/gmail.js';
import { createDefaultTools, validateToolInput } from '../src/agent/tools.js';
import { createAgentHost, readAgentConnectors } from '../src/agent/index.js';
import { createEmptyConnectorRegistry } from '../src/agent/connectors.js';
import { fetchDriveFiles, fetchGoogleContacts } from '../src/google.js';

const TIME_MIN = '2026-10-29T00:00:00.000Z';
const TIME_MAX = '2026-11-05T00:00:00.000Z';

function driveReader(transport) {
  return createDriveReadConnector({ transport });
}

function calendarReader(transport) {
  return createCalendarReadConnector({ transport });
}

function contactsReader(transport) {
  return createContactsReadConnector({ transport });
}

test('Google read connectors: Drive returns bounded metadata and never file content or credentials', async () => {
  const calls = [];
  const reader = driveReader({
    async listFiles(args) {
      calls.push(args);
      return Array.from({ length: 12 }, (_, index) => ({
        id: `file-${index + 1}`,
        name: `ملف ${index + 1}\n`,
        mimeType: 'text/plain',
        modifiedTime: '2026-10-29T10:00:00.000Z',
        content: 'must-not-cross-the-contract',
        accessToken: 'must-not-cross-the-contract'
      }));
    }
  });
  const signal = new AbortController().signal;
  const result = await reader.read({ maxResults: 2, signal });
  assert.equal(reader.readOnly, true);
  assert.deepEqual(calls, [{ maxResults: 2, signal }]);
  assert.equal(result.provider, 'google.drive');
  assert.equal(result.readOnly, true);
  assert.equal(result.count, 2);
  assert.deepEqual(Object.keys(result.files[0]), ['id', 'name', 'mimeType', 'modifiedTime']);
  assert.equal(result.files[0].content, undefined);
  assert.equal(result.files[0].accessToken, undefined);
  assert.equal(result.files[0].name.includes('\n'), false);

  await reader.read();
  assert.equal(calls[1].maxResults, 10);
  await assert.rejects(() => reader.read({ maxResults: 0 }), (error) => error.code === 'invalid_read_limit');
  await assert.rejects(() => reader.read({ maxResults: 11 }), (error) => error.code === 'invalid_read_limit');
  assert.equal(calls.length, 2, 'invalid limits must not reach the transport');
  assert.throws(() => driveReader({}), /listFiles/);
});

test('Google read connectors: Calendar requires a bounded window and projects only event read fields', async () => {
  const calls = [];
  const reader = calendarReader({
    async listEvents(args) {
      calls.push(args);
      return [{
        id: 'event-1',
        summary: 'اجتماع\nمراجعة',
        status: 'confirmed',
        location: 'Cairo',
        start: { dateTime: TIME_MIN, timeZone: 'Africa/Cairo', extra: 'drop' },
        end: { dateTime: '2026-10-29T01:00:00.000Z' },
        htmlLink: 'https://example.invalid/private',
        accessToken: 'drop'
      }, { id: 'event-2', summary: 'outside requested limit' }];
    }
  });
  const result = await reader.read({ timeMin: TIME_MIN, timeMax: TIME_MAX, maxResults: 1 });
  assert.deepEqual(calls, [{ timeMin: TIME_MIN, timeMax: TIME_MAX, maxResults: 1, signal: undefined }]);
  assert.equal(result.count, 1);
  assert.deepEqual(Object.keys(result.events[0]), ['id', 'summary', 'status', 'location', 'start', 'end']);
  assert.deepEqual(result.events[0].start, { dateTime: TIME_MIN, date: '', timeZone: 'Africa/Cairo' });
  assert.equal(result.events[0].htmlLink, undefined);
  assert.equal(result.events[0].accessToken, undefined);
  assert.equal(result.events[0].summary.includes('\n'), false);

  for (const args of [
    { timeMin: 'not-a-date', timeMax: TIME_MAX },
    { timeMin: TIME_MAX, timeMax: TIME_MIN },
    { timeMin: TIME_MIN, timeMax: '2027-01-01T00:00:00.000Z' },
    { timeMin: TIME_MIN, timeMax: TIME_MAX, maxResults: 21 }
  ]) {
    await assert.rejects(() => reader.read(args));
  }
  assert.equal(calls.length, 1, 'invalid windows and limits must not reach Calendar');
  assert.throws(() => calendarReader({}), /listEvents/);
});

test('Google read connectors: Contacts projects bounded names/phones/emails and preserves the query contract', async () => {
  const calls = [];
  const reader = contactsReader({
    async listContacts(args) {
      calls.push(args);
      return [{
        resourceName: 'people/1',
        name: 'أحمد\nعلي',
        phones: ['+201000000001', '+201000000002', '+201000000003', '+201000000004'],
        emails: ['ahmed@example.com'],
        notes: 'private notes',
        accessToken: 'drop'
      }, { resourceName: 'people/2', name: 'منى', phones: [], emails: [] }];
    }
  });
  const result = await reader.read({ query: 'أحمد', maxResults: 1 });
  assert.deepEqual(calls, [{ query: 'أحمد', maxResults: 1, signal: undefined }]);
  assert.equal(result.provider, 'google.contacts');
  assert.equal(result.count, 1);
  assert.deepEqual(Object.keys(result.contacts[0]), ['resourceName', 'name', 'phones', 'emails']);
  assert.equal(result.contacts[0].phones.length, 3);
  assert.equal(result.contacts[0].notes, undefined);
  assert.equal(result.contacts[0].accessToken, undefined);
  assert.equal(result.contacts[0].name.includes('\n'), false);
  await assert.rejects(() => reader.read({ maxResults: 0 }), (error) => error.code === 'invalid_read_limit');
  assert.equal(calls.length, 1);
  assert.throws(() => contactsReader({}), /listContacts/);
});

test('Google read connectors: provider errors become safe codes without token-bearing messages', async () => {
  const cases = [
    ['drive', driveReader, {}, 'drive_authorization_failed', 401],
    ['calendar', calendarReader, { timeMin: TIME_MIN, timeMax: TIME_MAX }, 'google_not_connected', 409],
    ['contacts', contactsReader, {}, 'google_not_configured', 503]
  ];
  for (const [service, factory, args, expected, status] of cases) {
    const method = service === 'drive' ? 'listFiles' : service === 'calendar' ? 'listEvents' : 'listContacts';
    const reader = factory({
      async [method]() {
        throw Object.assign(new Error(`provider secret-${service}`), { status });
      }
    });
    await assert.rejects(() => reader.read(args), (error) => {
      assert.equal(error.code, expected);
      assert.equal(error.message, expected);
      assert.equal(error.message.includes(`secret-${service}`), false);
      return true;
    });
  }
  const aborted = driveReader({
    async listFiles() { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); }
  });
  await assert.rejects(() => aborted.read(), (error) => error.code === 'cancelled');
});

test('Google read tools: closed arguments, read risk, bounds, and no registration by default', async () => {
  const readers = {
    drive: driveReader({ async listFiles() { return [{ id: 'f1', name: 'file' }]; } }),
    calendar: calendarReader({ async listEvents() { return [{ id: 'e1', summary: 'event', start: {}, end: {} }]; } }),
    contacts: contactsReader({ async listContacts() { return [{ resourceName: 'people/1', name: 'Ahmed' }]; } })
  };
  const tools = createDefaultTools({ googleReaders: readers, documentAutomation: false });
  for (const name of [DRIVE_READ_TOOL, CALENDAR_READ_TOOL, CONTACTS_READ_TOOL]) {
    const tool = tools.get(name);
    assert.ok(tool, name);
    assert.equal(tool.risk, 'read');
    assert.equal(tool.requiresApproval, false);
    assert.equal(typeof tool.execute, 'function');
    assert.equal(validateToolInput(tool, { accessToken: 'do-not-pass' }).code, 'policy_violation_secret_in_args');
    assert.equal(validateToolInput(tool, { unknown: true }).code, 'policy_violation_unknown_argument');
  }
  assert.equal(tools.get(DRIVE_READ_TOOL).connector, DRIVE_READ_CONNECTOR);
  assert.equal(tools.get(CALENDAR_READ_TOOL).connector, CALENDAR_READ_CONNECTOR);
  assert.equal(tools.get(CONTACTS_READ_TOOL).connector, CONTACTS_READ_CONNECTOR);
  assert.equal(validateToolInput(tools.get(DRIVE_READ_TOOL), { maxResults: 11 }).code, 'invalid_read_limit');
  assert.equal(validateToolInput(tools.get(CALENDAR_READ_TOOL), { timeMin: TIME_MIN, timeMax: TIME_MAX, maxResults: 21 }).code, 'invalid_read_limit');
  assert.equal(validateToolInput(tools.get(CALENDAR_READ_TOOL), { timeMin: 'bad', timeMax: TIME_MAX }).code, 'invalid_calendar_read_window');
  assert.equal(validateToolInput(tools.get(CONTACTS_READ_TOOL), { query: 'x'.repeat(101) }).code, 'invalid_contacts_query');
  assert.equal(validateToolInput(tools.get(DRIVE_READ_TOOL), { maxResults: 2 }).ok, true);
  assert.equal(validateToolInput(tools.get(CALENDAR_READ_TOOL), { timeMin: TIME_MIN, timeMax: TIME_MAX }).ok, true);
  assert.equal(validateToolInput(tools.get(CONTACTS_READ_TOOL), { query: 'Ahmed', maxResults: 2 }).ok, true);

  assert.equal((await tools.get(DRIVE_READ_TOOL).execute({ maxResults: 1 }, {})).count, 1);
  assert.equal((await tools.get(CALENDAR_READ_TOOL).execute({ timeMin: TIME_MIN, timeMax: TIME_MAX }, {})).count, 1);
  assert.equal((await tools.get(CONTACTS_READ_TOOL).execute({}, {})).count, 1);
  const disabled = createDefaultTools({ documentAutomation: false });
  for (const name of [DRIVE_READ_TOOL, CALENDAR_READ_TOOL, CONTACTS_READ_TOOL]) assert.equal(disabled.has(name), false);
});

test('Google fetchers: injected Drive and People clients use read-only list methods and bounded parameters', async () => {
  const config = { userId: 'owner', resilience: { timeoutMs: 1234 } };
  const signal = new AbortController().signal;
  const driveCalls = [];
  const files = await fetchDriveFiles({
    config,
    signal,
    maxResults: 99,
    driveClient: {
      files: {
        async list(params, options) {
          driveCalls.push({ params, options });
          return { data: { files: [{ id: 'f1', name: 'File', mimeType: 'text/plain', modifiedTime: TIME_MIN, webViewLink: 'drop' }] } };
        }
      }
    }
  });
  assert.equal(driveCalls[0].params.q, 'trashed = false');
  assert.equal(driveCalls[0].params.pageSize, 10);
  assert.equal(driveCalls[0].params.orderBy, 'modifiedTime desc');
  assert.equal(driveCalls[0].params.fields, 'files(id,name,mimeType,modifiedTime)');
  assert.equal(driveCalls[0].options.signal, signal);
  assert.equal(driveCalls[0].options.retry, false);
  assert.equal(driveCalls[0].options.timeout, 1234);
  assert.deepEqual(files, [{ id: 'f1', name: 'File', mimeType: 'text/plain', modifiedTime: TIME_MIN }]);

  const peopleCalls = [];
  const contacts = await fetchGoogleContacts({
    config,
    query: 'ahmed',
    maxResults: 1,
    peopleClient: {
      people: {
        connections: {
          async list(params, options) {
            peopleCalls.push({ params, options });
            return {
              data: {
                connections: [
                  { resourceName: 'people/1', names: [{ displayName: 'Ahmed Ali' }], phoneNumbers: [{ value: '+201' }], emailAddresses: [{ value: 'ahmed@example.com' }] },
                  { resourceName: 'people/2', names: [{ displayName: 'Mona' }], phoneNumbers: [], emailAddresses: [] }
                ]
              }
            };
          }
        }
      }
    }
  });
  assert.equal(peopleCalls[0].params.resourceName, 'people/me');
  assert.equal(peopleCalls[0].params.pageSize, 100);
  assert.equal(peopleCalls[0].params.personFields, 'names,phoneNumbers,emailAddresses');
  assert.equal(peopleCalls[0].options.retry, false);
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].name, 'Ahmed Ali');
  assert.equal(contacts[0].phones[0], '+201');
});

test('google_read host wiring registers four readers but no outbox connector', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-google-read-host-'));
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
      CELIA_AGENT_CONNECTORS: 'google_read'
    },
    logger: { info() {}, error() {} }
  });
  const runtime = await host.ready;
  t.after(() => runtime.shutdown());
  const names = runtime.status().tools.map((tool) => tool.name);
  for (const name of [GMAIL_TOOL, DRIVE_READ_TOOL, CALENDAR_READ_TOOL, CONTACTS_READ_TOOL]) assert.equal(names.includes(name), true, name);
  assert.deepEqual(runtime.status().connectors, []);
  assert.deepEqual(readAgentConnectors({ CELIA_AGENT_CONNECTORS: 'google_read, google_read' }), ['google_read']);
});

test('google_read demo planner reaches Drive, Calendar, and Contacts without approvals or outbox writes', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-google-read-demo-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = { drive: [], calendar: [], contacts: [] };
  const readers = {
    gmail: createGmailReadConnector({ transport: { async listMessages() { return []; } } }),
    drive: driveReader({ async listFiles(args) { calls.drive.push(args); return [{ id: 'f1', name: 'خطة 2026', mimeType: 'text/plain' }]; } }),
    calendar: calendarReader({ async listEvents(args) { calls.calendar.push(args); return [{ id: 'e1', summary: 'مراجعة الخطة', start: { dateTime: TIME_MIN }, end: {} }]; } }),
    contacts: contactsReader({ async listContacts(args) { calls.contacts.push(args); return [{ resourceName: 'people/1', name: 'أحمد', phones: ['+201'] }]; } })
  };
  const host = createAgentHost({
    config: { nodeEnv: 'test' },
    env: {
      NODE_ENV: 'test',
      CELIA_AGENT_RUNTIME: 'sqlite',
      CELIA_AGENT_SQLITE_PATH: path.join(directory, 'agent.sqlite3'),
      CELIA_AGENT_CONNECTORS: 'google_read'
    },
    connectors: createEmptyConnectorRegistry(),
    googleReaders: readers,
    logger: { info() {}, error() {} }
  });
  const runtime = await host.ready;
  t.after(() => runtime.shutdown());
  const requests = [
    ['هات آخر 10 ملفات من درايف', 'خطة 2026'],
    ['اعرض مواعيدي في Calendar', 'مراجعة الخطة'],
    ['اعرض جهات الاتصال', 'أحمد']
  ];
  for (const [message, expected] of requests) {
    const thread = await runtime.store.createThread({ ownerId: 'owner', title: message });
    const { run } = await runtime.submit({ threadId: thread.id, message });
    const finished = await runtime.runToCompletion(run.id);
    assert.equal(finished.status, 'succeeded', message);
    const detail = await runtime.detail(run.id);
    assert.match(detail.steps.at(-1).summary, new RegExp(expected));
    assert.deepEqual(detail.outbox, []);
    assert.deepEqual(detail.approvals, []);
    assert.equal(detail.evidenceChain.ok, true);
  }
  assert.equal(calls.drive.length, 1);
  assert.equal(calls.drive[0].maxResults, 10);
  assert.equal(calls.calendar.length, 1);
  assert.equal(calls.calendar[0].maxResults, 20);
  assert.equal(Date.parse(calls.calendar[0].timeMax) - Date.parse(calls.calendar[0].timeMin), 7 * 24 * 60 * 60 * 1000);
  assert.equal(calls.contacts.length, 1);
  assert.equal(calls.contacts[0].maxResults, 20);

  for (const [message, toolName] of [
    ['أنشئ موعد في Calendar', 'google.calendar_create_event'],
    ['صدّر ملف إلى Google Drive', 'google.drive_export_report']
  ]) {
    const thread = await runtime.store.createThread({ ownerId: 'owner', title: message });
    const { run } = await runtime.submit({ threadId: thread.id, message });
    const waiting = await runtime.runToCompletion(run.id);
    assert.equal(waiting.status, 'waiting_approval', message);
    const detail = await runtime.detail(run.id);
    assert.equal(detail.plan.proposedEffect.toolName, toolName);
    assert.equal(detail.outbox.length, 1);
    assert.equal(detail.outbox[0].status, 'pending');
  }
  assert.equal(calls.calendar.length, 1, 'write intents must not invoke the Calendar reader');
  assert.equal(calls.drive.length, 1, 'write intents must not invoke the Drive reader');
});
