import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCalendarConnector,
  createConnectorRegistry,
  createGoogleCalendarTransport,
  CONNECTOR
} from '../src/agent/connectors.js';
import { classifyConnectorError, OUTBOX_STATUS } from '../src/agent/outbox.js';
import { createFakeCalendar } from './support/agent-fixtures.js';

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
