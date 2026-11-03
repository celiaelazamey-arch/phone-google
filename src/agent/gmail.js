/**
 * Read-only Gmail connector for the agent Runtime.
 *
 * This is deliberately separate from the outbox connector registry: Gmail read
 * has no external effect, no approval-to-write path, and no send() method.
 * Credentials stay behind the injected transport; this module never sees them.
 */
import { scanForInjection } from './issue-triage/injection.js';

export const GMAIL_CONNECTOR = 'google.gmail';
export const GMAIL_TOOL = 'google.gmail_read';
export const GMAIL_MAX_RESULTS = 5;

const MAX_ID = 128;
const MAX_HEADER = 1000;
const MAX_SNIPPET = 500;

function coded(code, status = undefined) {
  const error = new Error(code);
  error.code = code;
  if (Number.isInteger(status)) error.status = status;
  return error;
}

function text(value, max) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max)
    : '';
}

/** Free-text fields are scanned before any cap: flattening control chars without truncating, so a
 * payload cannot hide behind the slice boundary nor ride inside control characters. */
function untrusted(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ') : '';
}

function limitOf(value) {
  if (value === undefined || value === null) return GMAIL_MAX_RESULTS;
  if (!Number.isInteger(value) || value < 1 || value > GMAIL_MAX_RESULTS) {
    throw coded('invalid_gmail_limit');
  }
  return value;
}

function unreadOf(value) {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw coded('invalid_gmail_unread_filter');
  return value;
}

function publicTransportError(error) {
  if (error?.code === 'cancelled' || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return coded('cancelled');
  }
  const status = Number(error?.status ?? error?.response?.status);
  if (status === 409) return coded('google_not_connected', 409);
  if (status === 503) return coded('google_not_configured', 503);
  if (status === 401 || status === 403) return coded('gmail_authorization_failed', status);
  return coded('gmail_read_failed', Number.isInteger(status) ? status : undefined);
}

function sanitizeMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const id = text(message.id, MAX_ID);
  if (!id) return null;
  // Mail text is data, not instructions (doctrine of AGENT-006 / DEC-060): the three free-text
  // fields are scanned whole, before any truncation. Benign rows stay byte-for-byte as before —
  // no extra key, no normalization — while tainted fields are replaced by their scrubbed form and
  // the row carries rule ids only, never the payload.
  const from = untrusted(message.from);
  const subject = untrusted(message.subject);
  const snippet = untrusted(message.snippet);
  const scan = scanForInjection(from, subject, snippet);
  const [fromClean, subjectClean, snippetClean] = scan.tainted
    ? scan.scrubbedParts
    : [from, subject, snippet];
  const row = {
    id,
    from: fromClean.slice(0, MAX_HEADER),
    subject: subjectClean.slice(0, MAX_HEADER),
    date: text(message.date, 100),
    snippet: snippetClean.slice(0, MAX_SNIPPET),
    unread: message.unread === true
  };
  if (scan.tainted) row.injectionRuleIds = scan.ruleIds;
  return row;
}

export function createGmailReadConnector({ transport } = {}) {
  if (!transport || typeof transport.listMessages !== 'function') {
    throw new Error('The Gmail read connector requires a listMessages transport');
  }
  return Object.freeze({
    name: GMAIL_CONNECTOR,
    readOnly: true,
    async read({ maxResults, unreadOnly, signal } = {}) {
      const limit = limitOf(maxResults);
      const unread = unreadOf(unreadOnly);
      let rows;
      try {
        rows = await transport.listMessages({ maxResults: limit, unreadOnly: unread, signal });
      } catch (error) {
        throw publicTransportError(error);
      }
      if (!Array.isArray(rows)) throw coded('gmail_invalid_transport_result');
      const messages = rows.slice(0, limit).map(sanitizeMessage).filter(Boolean);
      return {
        provider: GMAIL_CONNECTOR,
        readOnly: true,
        count: messages.length,
        messages
      };
    }
  });
}

/**
 * Tool definition is created only when the host explicitly wires the reader.
 * The generic tool registry performs the closed-argument and secret checks;
 * this custom validator adds the Gmail-specific bounds before any transport call.
 */
export function gmailToolDefinitions({ gmail } = {}) {
  if (!gmail) return [];
  if (typeof gmail.read !== 'function') throw new Error('Gmail tool requires a read connector');
  return [{
    name: GMAIL_TOOL,
    description: 'قراءة آخر رسائل Gmail (عناوين وmetadata ومقتطف محدود) بصلاحية قراءة فقط، بلا body أو مرفقات أو كتابة',
    risk: 'read',
    requiresApproval: false,
    connector: GMAIL_CONNECTOR,
    timeoutMs: 10_000,
    arguments: { maxResults: 'number', unreadOnly: 'boolean' },
    validate(args) {
      try {
        limitOf(args?.maxResults);
        unreadOf(args?.unreadOnly);
        return { ok: true };
      } catch (error) {
        return { ok: false, code: error.code, message: error.message };
      }
    },
    async execute(args, { signal } = {}) {
      return gmail.read({ maxResults: args?.maxResults, unreadOnly: args?.unreadOnly, signal });
    }
  }];
}
