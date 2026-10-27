import { definitiveError, safeConnectorCode } from './outbox.js';
import { sha256Text } from './evidence.js';

/**
 * Connector registry for external effects (AGENT-002).
 *
 * A connector is the only code allowed to touch a third party, and it is only ever
 * invoked by the outbox dispatcher. The contract is deliberately small:
 *
 *   send(payload, { idempotencyKey, signal }) → { externalRef, ... }
 *
 * `send` must throw `definitiveError(...)` when it can prove nothing reached the
 * provider. Any other throw is treated as `unknown` and never retried.
 *
 * Shipping a connector is a statement about wiring, not about credentials: without
 * a connected Google account the calendar connector throws a definitive error and
 * the run reports it instead of inventing an event.
 */

export const CONNECTOR = Object.freeze({
  calendar: 'google.calendar'
});

export function createConnectorRegistry(definitions = []) {
  const map = new Map();
  for (const definition of definitions) {
    if (!definition?.name || typeof definition.name !== 'string') {
      throw new Error('Connector name is required');
    }
    if (typeof definition.send !== 'function') {
      throw new Error(`Connector ${definition.name} needs a send function`);
    }
    if (map.has(definition.name)) throw new Error(`Duplicate connector ${definition.name}`);
    map.set(definition.name, Object.freeze({ ...definition }));
  }
  return {
    get(name) {
      return map.get(name) || null;
    },
    has(name) {
      return map.has(name);
    },
    list() {
      return [...map.values()].map(({ name, description, tool, requires }) => ({
        name,
        description,
        tool: tool ?? null,
        requires: requires ?? null
      }));
    },
    size: map.size
  };
}

export function createEmptyConnectorRegistry() {
  return createConnectorRegistry([]);
}

const MAX_SUMMARY = 200;

function parseInstant(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Google Calendar connector.
 *
 * The event carries a deterministic `iCalUID` derived from the outbox idempotency
 * key. That makes the provider itself the last line of defence against a duplicate:
 * a second insert of the same UID is rejected by Google, and this connector reports
 * it as `deduplicated: true` instead of claiming a second event.
 */
export function createCalendarConnector({ transport, calendarId = 'primary', timeZone = null } = {}) {
  if (!transport || typeof transport.insertEvent !== 'function') {
    throw new Error('The calendar connector requires an insertEvent transport');
  }
  return {
    name: CONNECTOR.calendar,
    description: 'إنشاء موعد في Google Calendar عبر outbox بعد موافقة مسجلة',
    tool: 'google.calendar_create_event',
    requires: 'connected Google account with calendar.events scope',
    async send(payload, { idempotencyKey, signal } = {}) {
      const summary = typeof payload?.summary === 'string' ? payload.summary.trim() : '';
      if (!summary) throw definitiveError('invalid_summary');
      const start = parseInstant(payload?.start);
      const end = parseInstant(payload?.end);
      // An event without a real time window is not a safe default to invent.
      if (!start || !end) throw definitiveError('event_time_required');
      if (end <= start) throw definitiveError('invalid_event_time_range');

      const iCalUID = `${sha256Text(`calendar:${idempotencyKey}`).slice(0, 32)}@celia.outbox`;
      const event = {
        summary: summary.slice(0, MAX_SUMMARY),
        start: { dateTime: start.toISOString(), ...(timeZone ? { timeZone } : {}) },
        end: { dateTime: end.toISOString(), ...(timeZone ? { timeZone } : {}) },
        iCalUID
      };
      try {
        const data = await transport.insertEvent({ calendarId, event, signal });
        return {
          provider: 'google.calendar',
          externalRef: data?.id ?? null,
          htmlLink: data?.htmlLink ?? null,
          iCalUID,
          deduplicated: false
        };
      } catch (error) {
        // Duplicate iCalUID means the effect already exists: reconcile, do not resend.
        // A bare 409 is NOT enough — "Google account has not been connected" is also 409
        // here, and treating that as a duplicate would fake a reconciliation.
        const message = String(error?.message || '');
        const status = Number(error?.response?.status ?? error?.status);
        const looksLikeDuplicate = /duplicate|already exists|icaluid/i.test(message);
        const duplicate = looksLikeDuplicate && (status === 409 || error?.code === 'duplicate');
        if (duplicate) {
          return {
            provider: 'google.calendar',
            externalRef: null,
            htmlLink: null,
            iCalUID,
            deduplicated: true,
            reconciledBy: 'ical_uid'
          };
        }
        throw Object.assign(error instanceof Error ? error : new Error('calendar_failed'), {
          code: safeConnectorCode(error)
        });
      }
    }
  };
}

/**
 * Transport over the existing authenticated Google client. `getCalendar` is injected
 * so the agent host owns credentials and this module owns no secrets at all.
 */
export function createGoogleCalendarTransport({ getCalendar } = {}) {
  if (typeof getCalendar !== 'function') {
    throw new Error('Google calendar transport requires a getCalendar function');
  }
  return {
    async insertEvent({ calendarId, event, signal }) {
      const calendar = await getCalendar({ signal });
      const options = { fields: 'id,summary,start,end,htmlLink,status,iCalUID' };
      if (signal) options.signal = signal;
      const response = await calendar.events.insert(
        { calendarId, requestBody: event },
        options
      );
      return response?.data ?? response;
    }
  };
}
