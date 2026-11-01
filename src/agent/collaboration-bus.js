/**
 * The collaboration bus between agents (XAG-001 / DEC-106).
 *
 * What existed: `emit()` in the runtime reaches a listener *inside this process* and a page that
 * happens to be open; the evidence ledger stores **hashes, not payloads**. So there was no way for
 * one run to hand a readable message to another, and no way for a result that arrived late to
 * survive a restart. That is the gap this file closes.
 *
 * The design was approved before a line of it was written (docs/collaboration-bus-contract.md), and
 * it is deliberately narrow:
 *
 *   - **No second transport.** Messages are pulled from the same store; `emit()` is untouched and
 *     stays best-effort. Nothing here competes with it.
 *   - **No second source of truth.** A message row is not trusted on its own: every send first
 *     appends an evidence entry whose `input_hash` covers the payload hash. A row whose attestation
 *     is missing or mismatched is detectable rather than believable.
 *   - **At-least-once, never "exactly once".** A consumer pulls, then acknowledges with a
 *     compare-and-set cursor. If it dies between the two, the message returns — with the same
 *     `messageId`, so the effect can recognise it. Claiming exactly-once here would be a lie.
 *   - **Closed vocabulary.** Six kinds. Anything else is refused by name.
 *   - **No awakening.** A message that nobody reads stays owed and surfaces in the attention queue;
 *     it never opens a run on its own. Opening a run is a decision, not a side effect.
 *
 * Identity is derived, not allocated: the same content addressed the same way yields the same
 * `messageId`, which is what makes a retried send idempotent instead of duplicative.
 */
import { createHash } from 'node:crypto';

import { findSecret } from '../knowledge/validate.js';

export const BUS_VERSION = 'celiaos-collaboration-bus-v1';

/** The only kinds a message may have. A free-form `kind` would make the bus unqueryable. */
export const BUS_KIND = Object.freeze({
  handoff: 'task.handoff',
  resultReady: 'result.ready',
  resultFailed: 'result.failed',
  clarifyAsk: 'clarify.ask',
  clarifyAnswer: 'clarify.answer',
  cancel: 'cancel.request'
});

const KINDS = new Set(Object.values(BUS_KIND));

/** `to` is an address, not a sentence: a run, the owner, or a refusal. */
export const TO_PATTERN = /^(owner|run:[A-Za-z0-9][A-Za-z0-9_-]{7,63})$/;

export const PAYLOAD_MAX_BYTES = 8 * 1024;

export const REFUSAL = Object.freeze({
  unknown_kind: 'نوع رسالة غير معروف',
  bad_address: 'عنوان مستلم غير صالح',
  empty_trace: 'رسالة بلا سلسلة',
  empty_sender: 'رسالة بلا مرسل',
  payload_too_large: 'محتوى الرسالة أكبر من الحد',
  payload_not_object: 'المحتوى يجب أن يكون كائنًا',
  payload_carries_secret: 'المحتوى يحمل ما يشبه سرًّا',
  bad_seq: 'تسلسل غير صالح',
  self_addressed: 'مرسل يخاطب نفسه'
});

export class BusRefusal extends Error {
  constructor(code, detail) {
    super(detail || REFUSAL[code] || code);
    this.name = 'BusRefusal';
    this.code = code;
    this.detail = detail || REFUSAL[code] || code;
  }
}

const sha = (value) => createHash('sha256').update(String(value)).digest('hex');

/** A message id is derived from everything that identifies it — order included. */
export function messageIdOf({ traceId, from, to, kind, payloadHash, seq }) {
  return `msg:${sha([traceId, from, to, kind, payloadHash, seq].join('|')).slice(0, 16)}`;
}

/**
 * One canonical serialization for hashing and storage. Key order is normalized so a message
 * rebuilt from a parsed object hashes the same as the one that was sent — otherwise the same
 * content could look like two different messages, or lose its attestation after a round trip.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Serialize and hash a payload, refusing anything that cannot be sent. Split out so the store can
 * hash the same bytes it will persist, instead of hashing a second serialization that might differ.
 */
export function hashPayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new BusRefusal('payload_not_object');
  }
  const text = canonicalJson(payload);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > PAYLOAD_MAX_BYTES) {
    throw new BusRefusal('payload_too_large', `${REFUSAL.payload_too_large}: ${bytes} > ${PAYLOAD_MAX_BYTES}`);
  }
  // Checked on the serialized text, not on selected fields: a summary field can carry a token.
  if (findSecret(text)) throw new BusRefusal('payload_carries_secret');
  return { text, payloadHash: sha(text) };
}

/**
 * Build one message, or refuse it by name. Pure: no clock, no store, no network.
 *
 * `seq` is supplied by the caller because it comes from the durable chain (`MAX(seq)+1` inside the
 * write transaction), never from a counter in memory that a restart would reuse.
 */
export function buildMessage({ traceId, from, to, kind, payload = {}, seq, causedBy = null, at } = {}) {
  const cleanTrace = String(traceId ?? '').trim();
  const cleanFrom = String(from ?? '').trim();
  const cleanTo = String(to ?? '').trim();
  const cleanKind = String(kind ?? '').trim();

  if (!cleanTrace) throw new BusRefusal('empty_trace');
  if (!cleanFrom) throw new BusRefusal('empty_sender');
  if (!KINDS.has(cleanKind)) throw new BusRefusal('unknown_kind', `${REFUSAL.unknown_kind}: ${cleanKind || '—'}`);
  if (!TO_PATTERN.test(cleanTo)) throw new BusRefusal('bad_address', `${REFUSAL.bad_address}: ${cleanTo || '—'}`);
  if (cleanTo === `run:${cleanFrom}`) throw new BusRefusal('self_addressed');
  if (!Number.isInteger(seq) || seq < 1) throw new BusRefusal('bad_seq', `${REFUSAL.bad_seq}: ${String(seq)}`);
  const { payloadHash } = hashPayload(payload);
  const messageId = messageIdOf({ traceId: cleanTrace, from: cleanFrom, to: cleanTo, kind: cleanKind, payloadHash, seq });
  return Object.freeze({
    version: BUS_VERSION,
    messageId,
    traceId: cleanTrace,
    from: cleanFrom,
    to: cleanTo,
    kind: cleanKind,
    seq,
    at: at || null,
    payload,
    payloadHash,
    causedBy: causedBy ? String(causedBy) : null
  });
}

/**
 * The attestation that makes a stored row believable: the evidence entry hashes exactly this body.
 * Recomputation is what lets `verifyMessage` catch an edited payload after the fact.
 */
export function attestationOf(message) {
  return {
    messageId: message.messageId,
    traceId: message.traceId,
    from: message.from,
    to: message.to,
    kind: message.kind,
    seq: message.seq,
    payloadHash: message.payloadHash
  };
}

/** Re-derive the identity and the payload hash from a stored row. */
export function verifyMessage(row) {
  if (!row || typeof row !== 'object') return { ok: false, code: 'message_missing', detail: 'لا رسالة' };
  const text = canonicalJson(row.payload ?? {});
  if (sha(text) !== row.payloadHash) {
    return { ok: false, code: 'payload_edited', detail: 'المحتوى لا يطابق بصمته' };
  }
  const expected = messageIdOf({
    traceId: row.traceId,
    from: row.from,
    to: row.to,
    kind: row.kind,
    payloadHash: row.payloadHash,
    seq: row.seq
  });
  if (expected !== row.messageId) {
    return { ok: false, code: 'identity_forged', detail: `المعرّف ${row.messageId} لا يطابق مضمونه` };
  }
  if (!KINDS.has(row.kind)) return { ok: false, code: 'unknown_kind', detail: row.kind };
  return { ok: true, code: null, detail: null };
}

/** A short fingerprint over an ordered batch, so a pulled batch can be quoted in a log. */
export function batchDigest(messages = []) {
  const body = [...messages]
    .map((message) => `${message.seq}:${message.messageId}`)
    .sort()
    .join('|');
  return sha(body).slice(0, 12);
}

/** What a person reads: what is waiting, for whom, and why nothing has moved. */
export function describeBus({ messages = [], cursor = 0 } = {}) {
  if (!messages.length) return `لا رسائل مستحقة — المؤشّر عند ${cursor}.`;
  const lines = [`${messages.length} رسالة مستحقة (المؤشّر عند ${cursor}):`];
  for (const message of messages) {
    lines.push(`  ← ${message.kind} من ${message.from} إلى ${message.to} · #${message.seq}`);
  }
  lines.push(`بصمة الدفعة ${batchDigest(messages)} — السحب لا يُنشئ تشغيلًا.`);
  return lines.join('\n');
}
