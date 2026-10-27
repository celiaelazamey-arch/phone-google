import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCalendarConnector,
  createConnectorRegistry,
  createGoogleCalendarTransport,
  createWhatsAppConnector,
  createWhatsAppCloudTransport,
  createDriveExportConnector,
  createGoogleDriveTransport,
  CONNECTOR,
  ALLOWED_DRIVE_MIME_TYPES
} from '../src/agent/connectors.js';
import { classifyConnectorError, OUTBOX_STATUS } from '../src/agent/outbox.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createDefaultTools } from '../src/agent/tools.js';
import { createDemoPlanner } from '../src/agent/planner.js';
import { readAgentConnectors, verifyApprovedEffectIntegrity } from '../src/agent/index.js';
import { createFakeCalendar, createTempStore } from './support/agent-fixtures.js';

const PAYLOAD = {
  summary: 'اجتماع الفريق',
  start: '2026-11-01T10:00:00.000Z',
  end: '2026-11-01T10:30:00.000Z'
};

test('connectors: the registry refuses nameless, send-less and duplicate connectors', () => {
  assert.throws(() => createConnectorRegistry([{ description: 'x', send: async () => ({}) }]), /name is required/);
  assert.throws(() => createConnectorRegistry([{ name: 'a', description: 'x' }]), /needs a send function/);
  assert.throws(
    () =>
      createConnectorRegistry([
        { name: 'a', send: async () => ({}) },
        { name: 'a', send: async () => ({}) }
      ]),
    /Duplicate connector a/
  );
  const registry = createConnectorRegistry([
    { name: CONNECTOR.calendar, description: 'تقويم', tool: 'google.calendar_create_event', send: async () => ({}) }
  ]);
  assert.equal(registry.has(CONNECTOR.calendar), true);
  assert.equal(registry.get('nope'), null);
  assert.deepEqual(registry.list()[0].name, CONNECTOR.calendar);
});

test('connectors: the calendar connector requires a transport', () => {
  assert.throws(() => createCalendarConnector({}), /insertEvent transport/);
  assert.throws(() => createGoogleCalendarTransport({}), /getCalendar function/);
});

test('connectors: an incomplete event is a definitive failure and never reaches the provider', async () => {
  const fake = createFakeCalendar();
  const connector = createCalendarConnector({ transport: fake.transport });

  await assert.rejects(
    () => connector.send({ start: PAYLOAD.start, end: PAYLOAD.end }, { idempotencyKey: 'k1' }),
    (error) => error.code === 'invalid_summary' && error.definitive === true
  );
  await assert.rejects(
    () => connector.send({ summary: 'بلا وقت' }, { idempotencyKey: 'k2' }),
    (error) => error.code === 'event_time_required' && error.definitive === true
  );
  await assert.rejects(
    () => connector.send({ summary: 'مقلوب', start: PAYLOAD.end, end: PAYLOAD.start }, { idempotencyKey: 'k3' }),
    (error) => error.code === 'invalid_event_time_range' && error.definitive === true
  );
  assert.equal(fake.sends.length, 0, 'a rejected payload must not hit the network');
  assert.equal(classifyConnectorError(Object.assign(new Error('x'), { code: 'event_time_required', definitive: true })), OUTBOX_STATUS.failed);
});

test('connectors: a successful send returns the provider reference and a deterministic iCalUID', async () => {
  const fake = createFakeCalendar();
  const connector = createCalendarConnector({ transport: fake.transport });
  const first = await connector.send(PAYLOAD, { idempotencyKey: 'outbox:run:abc' });
  assert.equal(first.provider, 'google.calendar');
  assert.ok(first.externalRef);
  assert.match(first.iCalUID, /@celia\.outbox$/);
  assert.equal(first.deduplicated, false);

  const again = await connector.send(PAYLOAD, { idempotencyKey: 'outbox:run:abc' });
  assert.notEqual(again.externalRef, first.externalRef, 'the fake issues a new id per request');
  assert.equal(fake.sends[0].event.iCalUID, fake.sends[1].event.iCalUID, 'same intent → same provider-side UID');
  assert.equal(fake.sends[0].calendarId, 'primary');
  assert.equal(fake.sends[0].event.start.dateTime, PAYLOAD.start);
});

test('connectors: a duplicate iCalUID at the provider is reconciliation, not a second event', async () => {
  const fake = createFakeCalendar({ duplicate: true });
  const connector = createCalendarConnector({ transport: fake.transport });
  const result = await connector.send(PAYLOAD, { idempotencyKey: 'dup-key' });
  assert.equal(result.deduplicated, true);
  assert.equal(result.reconciledBy, 'ical_uid');
  assert.equal(result.externalRef, null);
});

test('connectors: a provider rejection propagates as a classified error', async () => {
  const fake = createFakeCalendar({ failWith: 'definitive' });
  const connector = createCalendarConnector({ transport: fake.transport });
  await assert.rejects(
    () => connector.send(PAYLOAD, { idempotencyKey: 'bad' }),
    (error) => classifyConnectorError(error) === OUTBOX_STATUS.failed
  );

  const ambiguous = createFakeCalendar({ failWith: 'ambiguous' });
  const connector2 = createCalendarConnector({ transport: ambiguous.transport });
  await assert.rejects(
    () => connector2.send(PAYLOAD, { idempotencyKey: 'ambiguous' }),
    (error) => classifyConnectorError(error) === OUTBOX_STATUS.unknown
  );
});

test('connectors: a not-connected Google account is a definitive failure, not an unknown', async () => {
  const fake = createFakeCalendar({ failWith: 'unauthorized' });
  const connector = createCalendarConnector({ transport: fake.transport });
  await assert.rejects(
    () => connector.send(PAYLOAD, { idempotencyKey: 'no-grant' }),
    (error) => {
      assert.equal(classifyConnectorError(error), OUTBOX_STATUS.failed);
      assert.equal(error.status, 409);
      return true;
    }
  );
});

test('connectors: the calendar connector names the tool it serves so the outbox can route it', () => {
  const fake = createFakeCalendar();
  const connector = createCalendarConnector({ transport: fake.transport, timeZone: 'Africa/Cairo' });
  assert.equal(connector.name, 'google.calendar');
  assert.equal(connector.tool, 'google.calendar_create_event');
  assert.ok(connector.requires.includes('calendar.events'));
});

test('WA-01: whatsapp.send_text parks in WAITING_FOR_APPROVAL and rejection leaves zero external trace', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const sends = [];
  const waConnector = createWhatsAppConnector({
    ownerPhone: '+201012345678',
    transport: {
      async sendMessage(req) {
        sends.push(req);
        return { id: `wamid.${sends.length}` };
      }
    }
  });
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: createDefaultTools({ statusProvider: () => ({ version: '0.2.1', storage: 'sqlite' }) }),
    planner: createDemoPlanner(),
    connectors: createConnectorRegistry([waConnector]),
    ownerId: 'owner',
    logger: { error() {} }
  });
  t.after(() => runtime.shutdown().catch(() => {}));
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'اختبار واتساب' });

  const submitted = await runtime.submit({
    threadId: thread.id,
    message: 'أرسل رسالة واتساب إلى +201012345678 لتأكيد استلام المستندات',
    clientMessageId: 'wa-msg-01'
  });
  const parked = await runtime.runToCompletion(submitted.run.id);
  assert.equal(parked.status, 'waiting_approval');
  assert.equal(sends.length, 0, 'Nothing is sent before owner approval');

  const detailBefore = await runtime.detail(submitted.run.id);
  assert.equal(detailBefore.plan.state, 'WAITING_FOR_APPROVAL');
  assert.equal(detailBefore.plan.proposedEffect.toolName, 'whatsapp.send_text');

  const rejected = await runtime.approve(submitted.run.id, {
    decision: 'rejected',
    idempotencyKey: 'reject-wa-01',
    note: 'لا ترسل الآن'
  });
  assert.equal(rejected.run.status, 'cancelled');
  assert.equal(sends.length, 0, 'Rejection never invokes WhatsApp transport');
});

test('WA-02: WhatsApp connector enforces E.164, text bounds, opt-in, and 24-hour customer window before transport', async () => {
  const sends = [];
  let contactState = { optedIn: false, withinWindow: false };
  const connector = createWhatsAppConnector({
    ownerPhone: '+201000000001',
    checkContactWindow: async () => contactState,
    transport: {
      async sendMessage(req) {
        sends.push(req);
        return { id: 'wamid.ok' };
      }
    }
  });

  await assert.rejects(
    () => connector.send({ phone: '01012345678', text: 'مرحبًا' }, { idempotencyKey: 'wa-k1' }),
    (err) => err.code === 'invalid_phone_e164' && err.definitive === true
  );
  await assert.rejects(
    () => connector.send({ phone: '+201099999999', text: '   ' }, { idempotencyKey: 'wa-k2' }),
    (err) => err.code === 'invalid_message_text' && err.definitive === true
  );
  await assert.rejects(
    () => connector.send({ phone: '+201099999999', text: 'مرحبًا' }, { idempotencyKey: 'wa-k3' }),
    (err) => err.code === 'whatsapp_not_opted_in' && err.definitive === true
  );

  contactState = { optedIn: true, withinWindow: false };
  await assert.rejects(
    () => connector.send({ phone: '+201099999999', text: 'مرحبًا' }, { idempotencyKey: 'wa-k4' }),
    (err) => err.code === 'whatsapp_outside_24h_window' && err.definitive === true
  );
  assert.equal(sends.length, 0, 'Definitive policy blocks never hit the transport');

  // Owner phone bypasses customer window check; opted-in + within-window customer also succeeds.
  const ownerRes = await connector.send({ phone: '+201000000001', text: 'إشعار للمالك' }, { idempotencyKey: 'wa-k5' });
  assert.equal(ownerRes.provider, 'whatsapp.cloud');
  assert.equal(ownerRes.deduplicated, false);

  contactState = { optedIn: true, withinWindow: true };
  const customerRes = await connector.send({ phone: '+201099999999', text: 'رد ضمن نافذة 24 ساعة' }, { idempotencyKey: 'wa-k6' });
  assert.equal(customerRes.externalRef, 'wamid.ok');
  assert.equal(sends.length, 2);
});

test('WA-03 & WA-04: WhatsApp outbox sends once after approval, deduplicates via ledger, and parks ambiguous failures in needs_reconciliation', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());

  const ledgerRows = new Map();
  let apiCalls = 0;
  let shouldFailAmbiguous = false;
  const mockPool = {
    async execute(sql, params) {
      if (sql.startsWith('SELECT provider_message_id')) {
        const row = ledgerRows.get(params[0]);
        return [row ? [row] : []];
      }
      if (sql.startsWith('INSERT IGNORE INTO whatsapp_messages')) {
        ledgerRows.set(params[0], { provider_message_id: params[0], phone_e164: params[1] });
        return [{ affectedRows: 1 }];
      }
      return [[]];
    }
  };

  const transport = createWhatsAppCloudTransport({
    pool: mockPool,
    sendText: async () => {
      apiCalls += 1;
      if (shouldFailAmbiguous) {
        throw Object.assign(new Error('rate limited'), { status: 429 });
      }
      return '';
    }
  });
  const waConnector = createWhatsAppConnector({
    transport,
    ownerPhone: '+201012345678'
  });

  // Direct deduplication proof on transport + connector:
  const firstSend = await waConnector.send(
    { phone: '+201012345678', text: 'تنبيه 1' },
    { idempotencyKey: 'outbox:run-wa:111' }
  );
  assert.equal(firstSend.deduplicated, false);
  assert.equal(apiCalls, 1);

  const duplicateSend = await waConnector.send(
    { phone: '+201012345678', text: 'تنبيه 1' },
    { idempotencyKey: 'outbox:run-wa:111' }
  );
  assert.equal(duplicateSend.deduplicated, true);
  assert.equal(duplicateSend.reconciledBy, 'whatsapp_messages_ledger');
  assert.equal(apiCalls, 1, 'Second send with same idempotencyKey does not call Graph API again');

  // Ambiguous 429 failure through full runtime parks in needs_reconciliation:
  shouldFailAmbiguous = true;
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: createDefaultTools({ statusProvider: () => ({ version: '0.2.1', storage: 'sqlite' }) }),
    planner: createDemoPlanner(),
    connectors: createConnectorRegistry([waConnector]),
    ownerId: 'owner',
    logger: { error() {} }
  });
  t.after(() => runtime.shutdown().catch(() => {}));
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'اختبار مصالحة واتساب' });

  const submitted = await runtime.submit({
    threadId: thread.id,
    message: 'أرسل رسالة واتساب إلى +201012345678 بملخص المراجعة',
    clientMessageId: 'wa-msg-ambiguous'
  });
  await runtime.runToCompletion(submitted.run.id);

  await runtime.approve(submitted.run.id, {
    decision: 'approved',
    idempotencyKey: 'approve-wa-ambiguous'
  });
  const afterApprove = await runtime.runToCompletion(submitted.run.id);
  assert.equal(afterApprove.status, 'needs_reconciliation');

  // Owner reconciles the outbox row as applied + resume:
  const detailReconcile = await runtime.detail(submitted.run.id);
  const outboxEntry = detailReconcile.outbox[0];
  const reconciled = await runtime.reconcile(submitted.run.id, {
    target: 'outbox',
    targetId: outboxEntry.id,
    outcome: 'applied',
    externalRef: 'wamid.reconciled.1',
    idempotencyKey: 'rec-wa-01',
    resume: true,
    note: 'تم التأكد من وصول الرسالة لدى المزود'
  });
  assert.equal(reconciled.reconciliation.resumed, true);
  const finished = await runtime.runToCompletion(submitted.run.id);
  assert.equal(finished.status, 'succeeded');
  const finalDetail = await runtime.detail(submitted.run.id);
  assert.equal(finalDetail.verification.verdict, 'PASS');
});

test('DRV-01 & DRV-02: Google Drive export connector validates inputs, exports after approval, and deduplicates existing files by celiaOutboxKey', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());

  assert.throws(() => createDriveExportConnector({}), /createFile transport/);
  assert.throws(() => createGoogleDriveTransport({}), /getDrive function/);
  assert.ok(ALLOWED_DRIVE_MIME_TYPES.includes('application/json'));

  const driveFiles = new Map();
  let createCalls = 0;
  const transport = createGoogleDriveTransport({
    getDrive: async () => ({
      files: {
        async list({ q }) {
          for (const file of driveFiles.values()) {
            if (q.includes(file.appProperties?.celiaOutboxKey)) {
              return { data: { files: [file] } };
            }
          }
          return { data: { files: [] } };
        },
        async create({ requestBody, media }) {
          createCalls += 1;
          const created = {
            id: `drv-file-${createCalls}`,
            name: requestBody.name,
            mimeType: media.mimeType,
            webViewLink: `https://drive.example/file/${createCalls}`,
            appProperties: requestBody.appProperties
          };
          driveFiles.set(created.id, created);
          return { data: created };
        }
      }
    })
  });

  const driveConnector = createDriveExportConnector({ transport, folderId: 'folder-root-1' });

  // Input validation (definitive errors before touching Drive):
  await assert.rejects(
    () => driveConnector.send({ title: '', content: '{}' }, { idempotencyKey: 'drv-k1' }),
    (err) => err.code === 'invalid_drive_title' && err.definitive === true
  );
  await assert.rejects(
    () => driveConnector.send({ title: 'تقرير', content: '   ' }, { idempotencyKey: 'drv-k2' }),
    (err) => err.code === 'invalid_drive_content' && err.definitive === true
  );
  await assert.rejects(
    () =>
      driveConnector.send(
        { title: 'تقرير', content: '{}', mimeType: 'application/x-msdownload' },
        { idempotencyKey: 'drv-k3' }
      ),
    (err) => err.code === 'unsupported_drive_mime_type' && err.definitive === true
  );
  assert.equal(createCalls, 0);

  // Full runtime flow with WAITING_FOR_APPROVAL -> approve -> single export -> PASS verifier:
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: createDefaultTools({ statusProvider: () => ({ version: '0.2.1', storage: 'sqlite' }) }),
    planner: createDemoPlanner(),
    connectors: createConnectorRegistry([driveConnector]),
    ownerId: 'owner',
    logger: { error() {} }
  });
  t.after(() => runtime.shutdown().catch(() => {}));
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'اختبار تصدير Drive' });

  const submitted = await runtime.submit({
    threadId: thread.id,
    message: 'صدّر التقرير إلى Google Drive للمراجعة المالية',
    clientMessageId: 'drv-msg-01'
  });
  const parked = await runtime.runToCompletion(submitted.run.id);
  assert.equal(parked.status, 'waiting_approval');
  assert.equal(createCalls, 0);

  const detailBefore = await runtime.detail(submitted.run.id);
  assert.equal(detailBefore.plan.proposedEffect.toolName, 'google.drive_export_report');

  await runtime.approve(submitted.run.id, {
    decision: 'approved',
    idempotencyKey: 'approve-drv-01'
  });
  const finished = await runtime.runToCompletion(submitted.run.id);
  assert.equal(finished.status, 'succeeded');
  const completed = await runtime.detail(submitted.run.id);
  assert.equal(completed.verification.verdict, 'PASS');
  assert.equal(createCalls, 1);

  // Calling connector again with the same idempotencyKey reconciles against existing Drive file:
  const outboxEntry = completed.outbox[0];
  const replay = await driveConnector.send(outboxEntry.payload, {
    idempotencyKey: outboxEntry.idempotencyKey
  });
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.reconciledBy, 'outbox_key');
  assert.equal(replay.externalRef, 'drv-file-1');
  assert.equal(createCalls, 1, 'No second file is created when celiaOutboxKey already exists in Drive');
});

test('DRV-03 & DRV-04: post-approval payload integrity and readAgentConnectors support calendar, whatsapp, and drive', () => {
  assert.deepEqual(readAgentConnectors({ CELIA_AGENT_CONNECTORS: 'none' }), []);
  assert.deepEqual(
    readAgentConnectors({ CELIA_AGENT_CONNECTORS: 'calendar, whatsapp, drive, calendar' }),
    ['calendar', 'whatsapp', 'drive']
  );
  assert.throws(
    () => readAgentConnectors({ CELIA_AGENT_CONNECTORS: 'unknown_connector' }),
    /CELIA_AGENT_CONNECTORS must be one of/
  );

  const integrityBroken = verifyApprovedEffectIntegrity({
    approval: {
      decision: 'approved',
      toolName: 'google.drive_export_report',
      payloadHash: 'sha256-approved-original'
    },
    entry: {
      toolName: 'google.drive_export_report',
      payload: { title: 'تقرير معدل خلسة', content: '{}', mimeType: 'application/json' }
    }
  });
  assert.equal(integrityBroken.ok, false);
  assert.equal(integrityBroken.code, 'post_approval_payload_tampered');
});
