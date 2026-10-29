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
  calendar: 'google.calendar',
  whatsapp: 'whatsapp.cloud',
  drive: 'google.drive'
});

// B4 أضاف `text/html` وحده: قالب `static_page` في B3 يُنتج صفحة HTML حتمية،
// ورفضها كان سيجعل نوعًا كاملًا من مخرجاتنا غير قابل للتسليم. لا نوع تنفيذي آخر.
export const ALLOWED_DRIVE_MIME_TYPES = Object.freeze([
  'application/json',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html'
]);

// امتداد الملف يحسم نوعه عند رفع artifact: لا تخمين صامت لنوع غير معروف.
const MIME_BY_EXTENSION = Object.freeze({
  json: 'application/json',
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html'
});

/** النوع المشتق من الامتداد، أو null إن لم يكن الامتداد معلنًا. */
export function driveMimeForName(name) {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || '').trim());
  return match ? MIME_BY_EXTENSION[match[1].toLowerCase()] || null : null;
}

const E164_RE = /^\+[1-9]\d{6,14}$/;
const MAX_WHATSAPP_TEXT = 4096;
const MAX_DRIVE_TITLE = 200;
const MAX_DRIVE_CONTENT = 200_000;
// نفس شكل معرفات مخزن B2: الحماية الفعلية في البصمة والموافقة، والشكل يمنع
// تمرير مسار أو معرّف غريب إلى طبقة القراءة.
const DRIVE_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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

/**
 * WhatsApp Cloud connector (AGENT-002).
 *
 * Enforces E.164 recipient format, message length bounds (1..4096), and either
 * owner-phone identity or explicit customer opt-in + 24-hour customer window
 * before any network request is attempted. Ambiguous transport errors (408, 429,
 * 5xx, network resets) propagate without `definitive: true` so the outbox settles
 * them as `unknown` and parks the run in `needs_reconciliation`.
 */
export function createWhatsAppConnector({
  transport,
  checkContactWindow = null,
  ownerPhone = null
} = {}) {
  if (!transport || typeof transport.sendMessage !== 'function') {
    throw new Error('The WhatsApp connector requires a sendMessage transport');
  }
  return {
    name: CONNECTOR.whatsapp,
    description: 'إرسال رسالة واتساب نصية عبر outbox بعد موافقة المالك والتحقق من نافذة 24 ساعة',
    tool: 'whatsapp.send_text',
    requires: 'configured WhatsApp Cloud API credentials and valid 24h window or owner phone',
    async send(payload, { idempotencyKey, signal } = {}) {
      const phone = typeof payload?.phone === 'string' ? payload.phone.trim() : '';
      if (!E164_RE.test(phone)) {
        throw definitiveError('invalid_phone_e164');
      }
      const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
      if (!text || text.length > MAX_WHATSAPP_TEXT) {
        throw definitiveError('invalid_message_text');
      }

      const isOwnerRecipient = Boolean(ownerPhone && phone === String(ownerPhone).trim());
      if (!isOwnerRecipient && typeof checkContactWindow === 'function') {
        const policy = await checkContactWindow({ phone, signal });
        if (!policy?.optedIn) {
          throw definitiveError('whatsapp_not_opted_in');
        }
        if (!policy?.withinWindow) {
          throw definitiveError('whatsapp_outside_24h_window');
        }
      }

      const messageDigest = sha256Text(`whatsapp:${idempotencyKey}`).slice(0, 32);
      try {
        const data = await transport.sendMessage({
          phone,
          text,
          idempotencyKey,
          messageDigest,
          signal
        });
        if (data?.deduplicated) {
          return {
            provider: 'whatsapp.cloud',
            externalRef: data?.id ?? data?.messageId ?? null,
            phone,
            messageDigest,
            deduplicated: true,
            reconciledBy: data.reconciledBy || 'idempotency_key'
          };
        }
        return {
          provider: 'whatsapp.cloud',
          externalRef: data?.id ?? data?.messageId ?? null,
          phone,
          messageDigest,
          deduplicated: false
        };
      } catch (error) {
        if (error?.definitive === true) throw error;
        const message = String(error?.message || '');
        const status = Number(error?.response?.status ?? error?.status);
        const looksLikeDuplicate = /duplicate|already_sent|idempotency/i.test(message);
        if (looksLikeDuplicate && (status === 409 || error?.code === 'duplicate')) {
          return {
            provider: 'whatsapp.cloud',
            externalRef: null,
            phone,
            messageDigest,
            deduplicated: true,
            reconciledBy: 'idempotency_key'
          };
        }
        throw Object.assign(error instanceof Error ? error : new Error('whatsapp_failed'), {
          code: safeConnectorCode(error)
        });
      }
    }
  };
}

/**
 * Transport wrapper over `sendWhatsAppText` + optional durable `whatsapp_messages`
 * idempotency check so a retried outbox dispatch never sends a second message.
 */
export function createWhatsAppCloudTransport({ sendText, pool = null } = {}) {
  if (typeof sendText !== 'function') {
    throw new Error('WhatsApp Cloud transport requires a sendText function');
  }
  return {
    async sendMessage({ phone, text, messageDigest, signal }) {
      const syntheticId = `outbox_${messageDigest}`;
      if (pool && typeof pool.execute === 'function') {
        const [existing] = await pool.execute(
          'SELECT provider_message_id FROM whatsapp_messages WHERE provider_message_id = ? LIMIT 1',
          [syntheticId]
        );
        if (Array.isArray(existing) && existing.length > 0) {
          return {
            id: existing[0].provider_message_id,
            deduplicated: true,
            reconciledBy: 'whatsapp_messages_ledger'
          };
        }
      }
      const providerId = await sendText({ phone, text, signal });
      const recordedId = providerId || syntheticId;
      if (pool && typeof pool.execute === 'function') {
        await pool.execute(
          'INSERT IGNORE INTO whatsapp_messages (provider_message_id, phone_e164, direction, message_type, body, status) VALUES (?, ?, ?, ?, ?, ?)',
          [recordedId, phone, 'outbound', 'text', text.slice(0, 4000), 'sent']
        );
      }
      return { id: recordedId, deduplicated: false };
    }
  };
}

/**
 * Google Drive Report Export connector (AGENT-002, extended by M-B/B4).
 *
 * Exports a verified report or artifact to Google Drive only after explicit owner
 * approval. Uses a deterministic `appProperties.celiaOutboxKey` derived from the
 * outbox idempotency key and queries Drive before creation so a retry or manual
 * reconciliation reconciles against the existing file instead of creating a duplicate.
 *
 * B4 payload shapes (exactly one, never both):
 *   { title, content, mimeType }                 inline text (AGENT-002, unchanged)
 *   { artifactId, title?, mimeType? }            an artifact from the B2 store
 *
 * The artifact shape is what makes "the file that lands in Drive is the file the
 * owner was shown" true: the bytes are re-read and re-hashed by `resolveArtifact`
 * *before* the provider is contacted, so a tampered or vanished artifact becomes a
 * definitive `failed` with zero network effect — never an upload of other bytes.
 */
export function createDriveExportConnector({ transport, folderId = null, resolveArtifact = null } = {}) {
  if (!transport || typeof transport.createFile !== 'function') {
    throw new Error('The Drive export connector requires a createFile transport');
  }
  return {
    name: CONNECTOR.drive,
    description: 'تصدير تقرير موثّق أو artifact مبصوم إلى Google Drive عبر outbox بعد موافقة صريحة ومنع تكرار الملف',
    tool: 'google.drive_export_report',
    requires: 'connected Google account with Drive file creation permission',
    /** هل الرفع من مخزن artifacts مُوصَّل؟ يُعلن للمفتش بلا كشف مسار التخزين. */
    artifactUploads: typeof resolveArtifact === 'function',
    async send(payload, { idempotencyKey, signal } = {}) {
      const artifactId =
        payload?.artifactId === undefined || payload?.artifactId === null || payload?.artifactId === ''
          ? null
          : String(payload.artifactId).trim();
      let source = null;
      let title;
      let content;
      let mimeType;

      if (artifactId) {
        if (typeof resolveArtifact !== 'function') throw definitiveError('drive_artifact_export_unavailable');
        if (payload?.content !== undefined && payload?.content !== null && payload?.content !== '') {
          // Two sources for one file is an ambiguity an approval cannot resolve.
          throw definitiveError('drive_artifact_content_conflict');
        }
        if (!DRIVE_ARTIFACT_ID.test(artifactId)) throw definitiveError('invalid_drive_artifact_id');
        let artifact;
        try {
          artifact = await resolveArtifact({ id: artifactId });
        } catch (error) {
          // لم يُلمس المزوّد بعد: كل رفض هنا «فشل مثبت» لا `unknown`.
          throw definitiveError(error?.code || 'drive_artifact_unavailable');
        }
        if (!artifact || !Buffer.isBuffer(artifact.content)) throw definitiveError('drive_artifact_unavailable');
        if (artifact.content.length > MAX_DRIVE_CONTENT) throw definitiveError('drive_artifact_too_large');
        const text = artifact.content.toString('utf8');
        if (Buffer.byteLength(text, 'utf8') !== artifact.content.length) {
          // البايتات ليست نصًا صالحًا؛ رفعها كملف نصي سيكون تحريفًا صامتًا.
          throw definitiveError('drive_artifact_not_text');
        }
        content = text;
        title =
          typeof payload?.title === 'string' && payload.title.trim() ? payload.title.trim() : String(artifact.name || '');
        const explicitMime =
          payload?.mimeType === undefined || payload?.mimeType === null || payload?.mimeType === ''
            ? null
            : String(payload.mimeType).trim().toLowerCase();
        mimeType = explicitMime || driveMimeForName(artifact.name) || '';
        source = {
          artifactId: artifact.id ?? artifactId,
          sha256: artifact.sha256 ?? null,
          bytes: artifact.content.length
        };
      } else {
        title = typeof payload?.title === 'string' ? payload.title.trim() : '';
        content = typeof payload?.content === 'string' ? payload.content : '';
        mimeType =
          payload?.mimeType === undefined || payload?.mimeType === null || payload?.mimeType === ''
            ? 'application/json'
            : String(payload.mimeType).trim().toLowerCase();
      }

      if (!title || title.length > MAX_DRIVE_TITLE) {
        throw definitiveError('invalid_drive_title');
      }
      if (!content.trim() || content.length > MAX_DRIVE_CONTENT) {
        throw definitiveError('invalid_drive_content');
      }
      if (!ALLOWED_DRIVE_MIME_TYPES.includes(mimeType)) {
        throw definitiveError('unsupported_drive_mime_type');
      }

      const outboxDigest = sha256Text(`drive:${idempotencyKey}`).slice(0, 32);
      try {
        if (typeof transport.findByOutboxKey === 'function') {
          const existing = await transport.findByOutboxKey({ outboxDigest, signal });
          if (existing?.id) {
            return {
              provider: 'google.drive',
              externalRef: existing.id,
              webViewLink: existing.webViewLink ?? null,
              outboxDigest,
              ...(source ? { source } : {}),
              deduplicated: true,
              reconciledBy: 'outbox_key'
            };
          }
        }
        const file = await transport.createFile({
          name: title,
          mimeType,
          content,
          parents: folderId ? [folderId] : undefined,
          appProperties: { celiaOutboxKey: outboxDigest },
          signal
        });
        return {
          provider: 'google.drive',
          externalRef: file?.id ?? null,
          webViewLink: file?.webViewLink ?? null,
          outboxDigest,
          ...(source ? { source } : {}),
          deduplicated: false
        };
      } catch (error) {
        if (error?.definitive === true) throw error;
        const message = String(error?.message || '');
        const status = Number(error?.response?.status ?? error?.status);
        const looksLikeDuplicate = /duplicate|already exists|outboxkey/i.test(message);
        if (looksLikeDuplicate && (status === 409 || error?.code === 'duplicate')) {
          return {
            provider: 'google.drive',
            externalRef: null,
            webViewLink: null,
            outboxDigest,
            ...(source ? { source } : {}),
            deduplicated: true,
            reconciledBy: 'outbox_key'
          };
        }
        throw Object.assign(error instanceof Error ? error : new Error('drive_export_failed'), {
          code: safeConnectorCode(error)
        });
      }
    }
  };
}

/**
 * Transport over the authenticated Google Drive v3 client.
 */
export function createGoogleDriveTransport({ getDrive } = {}) {
  if (typeof getDrive !== 'function') {
    throw new Error('Google Drive transport requires a getDrive function');
  }
  return {
    async findByOutboxKey({ outboxDigest, signal }) {
      const drive = await getDrive({ signal });
      const q = `appProperties has { key='celiaOutboxKey' and value='${String(outboxDigest).replace(/'/g, '')}' } and trashed = false`;
      const options = signal ? { signal } : {};
      const response = await drive.files.list(
        {
          q,
          pageSize: 1,
          fields: 'files(id,name,webViewLink,appProperties)'
        },
        options
      );
      const files = response?.data?.files ?? response?.files ?? [];
      return files[0] || null;
    },
    async createFile({ name, mimeType, content, parents, appProperties, signal }) {
      const drive = await getDrive({ signal });
      const options = signal ? { signal } : {};
      const requestBody = {
        name,
        mimeType,
        appProperties: appProperties || {},
        ...(Array.isArray(parents) && parents.length ? { parents } : {})
      };
      const media = {
        mimeType,
        body: content
      };
      const response = await drive.files.create(
        {
          requestBody,
          media,
          fields: 'id,name,webViewLink,appProperties'
        },
        options
      );
      return response?.data ?? response;
    }
  };
}
