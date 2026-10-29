export const DRIVE_READ_TOOL = 'google.drive_read';
export const CALENDAR_READ_TOOL = 'google.calendar_read';
export const CONTACTS_READ_TOOL = 'google.contacts_read';
export const DRIVE_READ_CONNECTOR = 'google.drive.read';
export const CALENDAR_READ_CONNECTOR = 'google.calendar.read';
export const CONTACTS_READ_CONNECTOR = 'google.contacts.read';

const MAX_DRIVE_RESULTS = 10;
const MAX_READ_RESULTS = 20;
const MAX_CALENDAR_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

function text(value, max = 500) {
  return value === undefined || value === null
    ? ''
    : String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
}

function boundedValues(value, maxItems = 3, maxLength = 200) {
  return (Array.isArray(value) ? value : [])
    .slice(0, maxItems)
    .map((item) => text(item, maxLength))
    .filter(Boolean);
}

function coded(code, status = undefined) {
  const error = new Error(code);
  error.code = code;
  if (Number.isInteger(status)) error.status = status;
  return error;
}

function publicReadError(service, error) {
  const prefix = service.toLowerCase();
  const status = Number(error?.status ?? error?.response?.status ?? error?.code);
  if (error?.code === 'cancelled' || error?.code === 'ABORT_ERR' || error?.code === 20 || error?.name === 'AbortError') {
    return coded('cancelled');
  }
  if (error?.code === 'google_not_connected' || status === 409) return coded('google_not_connected', 409);
  if (error?.code === 'google_not_configured' || status === 503) return coded('google_not_configured', 503);
  if (status === 401 || status === 403) return coded(`${prefix}_authorization_failed`, status);
  return coded(`${prefix}_read_failed`, Number.isInteger(status) ? status : undefined);
}

function limit(value, fallback, maximum) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    const error = new Error(`maxResults must be an integer from 1 to ${maximum}.`);
    error.code = 'invalid_read_limit';
    throw error;
  }
  return value;
}

function validLimit(value, maximum) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 1 || value > maximum) return `maxResults must be an integer from 1 to ${maximum}.`;
  return null;
}

function validWindow(timeMin, timeMax) {
  const start = Date.parse(timeMin);
  const end = Date.parse(timeMax);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'timeMin and timeMax must be valid ISO dates.';
  if (start >= end) return 'timeMin must be before timeMax.';
  if (end - start > MAX_CALENDAR_WINDOW_MS) return 'The Calendar read window cannot exceed 31 days.';
  return null;
}

function eventTime(value) {
  if (!value || typeof value !== 'object') return {};
  return {
    dateTime: text(value.dateTime, 100),
    date: text(value.date, 100),
    timeZone: text(value.timeZone, 100)
  };
}

/** Read-only Drive metadata. No file content, download, upload, or export method exists. */
export function createDriveReadConnector({ transport } = {}) {
  if (typeof transport?.listFiles !== 'function') throw new TypeError('Drive listFiles transport is required.');
  return Object.freeze({
    name: DRIVE_READ_CONNECTOR,
    readOnly: true,
    async read({ maxResults = MAX_DRIVE_RESULTS, signal } = {}) {
      const resultLimit = limit(maxResults, MAX_DRIVE_RESULTS, MAX_DRIVE_RESULTS);
      try {
        const files = await transport.listFiles({ maxResults: resultLimit, signal });
        const views = (Array.isArray(files) ? files : []).map((file) => ({
          id: text(file?.id, 128),
          name: text(file?.name, 500),
          mimeType: text(file?.mimeType, 200),
          modifiedTime: text(file?.modifiedTime, 100)
        })).filter((file) => file.id).slice(0, resultLimit);
        return Object.freeze({ provider: 'google.drive', readOnly: true, count: views.length, files: views });
      } catch (error) {
        throw publicReadError('Drive', error);
      }
    }
  });
}

/** Read-only Calendar event projection over the existing bounded agenda transport. */
export function createCalendarReadConnector({ transport } = {}) {
  if (typeof transport?.listEvents !== 'function') throw new TypeError('Calendar listEvents transport is required.');
  return Object.freeze({
    name: CALENDAR_READ_CONNECTOR,
    readOnly: true,
    async read({ timeMin, timeMax, maxResults = MAX_READ_RESULTS, signal } = {}) {
      const windowError = validWindow(timeMin, timeMax);
      if (windowError) throw new Error(windowError);
      const resultLimit = limit(maxResults, MAX_READ_RESULTS, MAX_READ_RESULTS);
      try {
        const events = await transport.listEvents({
          timeMin,
          timeMax,
          maxResults: resultLimit,
          signal
        });
        const views = (Array.isArray(events) ? events : []).map((event) => ({
          id: text(event?.id, 128),
          summary: text(event?.summary || '(بدون عنوان)', 500),
          status: text(event?.status, 50),
          location: text(event?.location, 500),
          start: eventTime(event?.start),
          end: eventTime(event?.end)
        })).filter((event) => event.id).slice(0, resultLimit);
        return Object.freeze({ provider: 'google.calendar', readOnly: true, count: views.length, events: views });
      } catch (error) {
        throw publicReadError('Calendar', error);
      }
    }
  });
}

/** Read-only Contacts projection. Query filtering is performed by the bounded transport. */
export function createContactsReadConnector({ transport } = {}) {
  if (typeof transport?.listContacts !== 'function') throw new TypeError('Contacts listContacts transport is required.');
  return Object.freeze({
    name: CONTACTS_READ_CONNECTOR,
    readOnly: true,
    async read({ query = '', maxResults = MAX_READ_RESULTS, signal } = {}) {
      const resultLimit = limit(maxResults, MAX_READ_RESULTS, MAX_READ_RESULTS);
      try {
        const contacts = await transport.listContacts({
          query: text(query, 100).trim(),
          maxResults: resultLimit,
          signal
        });
        const views = (Array.isArray(contacts) ? contacts : []).map((person) => ({
          resourceName: text(person?.resourceName, 128),
          name: text(person?.name, 300),
          phones: boundedValues(person?.phones),
          emails: boundedValues(person?.emails)
        })).filter((person) => person.name || person.phones.length || person.emails.length).slice(0, resultLimit);
        return Object.freeze({ provider: 'google.contacts', readOnly: true, count: views.length, contacts: views });
      } catch (error) {
        throw publicReadError('Contacts', error);
      }
    }
  });
}

function invalid(code, message) {
  return { ok: false, code, message };
}

function validToolLimit(value, maximum) {
  const message = validLimit(value, maximum);
  return message ? invalid('invalid_read_limit', message) : { ok: true };
}

export function driveReadToolDefinitions({ drive } = {}) {
  if (!drive) return [];
  if (typeof drive.read !== 'function') throw new TypeError('Drive tool requires a read connector.');
  return [{
    name: DRIVE_READ_TOOL,
    risk: 'read',
    requiresApproval: false,
    connector: DRIVE_READ_CONNECTOR,
    timeoutMs: 10_000,
    description: 'Read the latest 1–10 non-trashed Drive file IDs, names, MIME types, and modification times. Never reads file contents or writes.',
    arguments: { maxResults: 'number' },
    validate: (args) => validToolLimit(args?.maxResults, MAX_DRIVE_RESULTS),
    execute: (args, { signal } = {}) => drive.read({ maxResults: args?.maxResults, signal })
  }];
}

export function calendarReadToolDefinitions({ calendar } = {}) {
  if (!calendar) return [];
  if (typeof calendar.read !== 'function') throw new TypeError('Calendar tool requires a read connector.');
  return [{
    name: CALENDAR_READ_TOOL,
    risk: 'read',
    requiresApproval: false,
    connector: CALENDAR_READ_CONNECTOR,
    timeoutMs: 10_000,
    description: 'Read up to 20 Calendar events in an explicit ISO time window of at most 31 days. Never creates or changes events.',
    arguments: { timeMin: 'string', timeMax: 'string', maxResults: 'number' },
    validate: (args) => {
      const limitResult = validToolLimit(args?.maxResults, MAX_READ_RESULTS);
      if (!limitResult.ok) return limitResult;
      const message = validWindow(args?.timeMin, args?.timeMax);
      return message ? invalid('invalid_calendar_read_window', message) : { ok: true };
    },
    execute: (args, { signal } = {}) => calendar.read({ ...args, signal })
  }];
}

export function contactsReadToolDefinitions({ contacts } = {}) {
  if (!contacts) return [];
  if (typeof contacts.read !== 'function') throw new TypeError('Contacts tool requires a read connector.');
  return [{
    name: CONTACTS_READ_TOOL,
    risk: 'read',
    requiresApproval: false,
    connector: CONTACTS_READ_CONNECTOR,
    timeoutMs: 10_000,
    description: 'Read up to 20 Contacts names and at most three phone/email values each, optionally filtered by a bounded query. Never changes Contacts.',
    arguments: { query: 'string', maxResults: 'number' },
    validate: (args) => {
      if (args?.query !== undefined && args?.query !== null && (typeof args.query !== 'string' || args.query.length > 100)) {
        return invalid('invalid_contacts_query', 'query must be a string of at most 100 characters.');
      }
      return validToolLimit(args?.maxResults, MAX_READ_RESULTS);
    },
    execute: (args, { signal } = {}) => contacts.read({ ...args, signal })
  }];
}

export function googleReadToolDefinitions(readers = {}) {
  return [
    ...driveReadToolDefinitions({ drive: readers.drive }),
    ...calendarReadToolDefinitions({ calendar: readers.calendar }),
    ...contactsReadToolDefinitions({ contacts: readers.contacts })
  ];
}
