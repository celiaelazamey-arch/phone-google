import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUS_KIND,
  BUS_VERSION,
  BusRefusal,
  REFUSAL,
  PAYLOAD_MAX_BYTES,
  attestationOf,
  batchDigest,
  buildMessage,
  describeBus,
  hashPayload,
  messageIdOf,
  verifyMessage
} from '../src/agent/collaboration-bus.js';

/**
 * XB-01..10 from `docs/collaboration-bus-contract.md`, at the pure layer: identity, closed
 * vocabulary, refusal without a write, and the check a reader can run before acting on a message.
 * The durable half (restart, cursors, isolation) lives in `test/agent-bus-runtime.test.js`.
 */

const base = (extra = {}) => ({
  traceId: 'run-root-0001',
  from: 'run-child-0001',
  to: 'run:run-root-0001',
  kind: BUS_KIND.resultReady,
  payload: { summary: 'انتهى البحث', sources: 3 },
  seq: 1,
  ...extra
});

test('XB-10: identity is derived from content, so the same message twice is the same id', () => {
  const first = buildMessage(base());
  const second = buildMessage(base());
  assert.equal(first.messageId, second.messageId);
  assert.match(first.messageId, /^msg:[0-9a-f]{16}$/);
  assert.equal(first.version, BUS_VERSION);

  const laterSeq = buildMessage(base({ seq: 2 }));
  assert.notEqual(laterSeq.messageId, first.messageId, 'a different position is a different message');

  const otherPayload = buildMessage(base({ payload: { summary: 'انتهى البحث', sources: 4 } }));
  assert.notEqual(otherPayload.messageId, first.messageId);
});

test('XB-05: the vocabulary is closed — an unknown kind is refused by name', () => {
  assert.throws(() => buildMessage(base({ kind: 'chat.free' })), (error) => {
    assert.equal(error.code, 'unknown_kind');
    assert.match(error.detail, /chat\.free/);
    return true;
  });
  for (const kind of Object.values(BUS_KIND)) {
    assert.equal(buildMessage(base({ kind })).kind, kind, `${kind} must be accepted`);
  }
});

test('XB-06: a payload that carries a credential is refused, and the secret never lands in the object', () => {
  const secret = 'sk-9f2b7c41d8e35a60b1c2';
  assert.throws(() => buildMessage(base({ payload: { note: `المفتاح ${secret}` } })), (error) => {
    assert.equal(error.code, 'payload_carries_secret');
    assert.ok(!error.detail.includes(secret));
    return true;
  });
});

test('the envelope is validated before anything can be written', () => {
  const cases = [
    [{ traceId: '' }, 'empty_trace'],
    [{ from: '' }, 'empty_sender'],
    [{ to: 'nobody' }, 'bad_address'],
    [{ to: 'run:run-child-0001' }, 'self_addressed'],
    [{ seq: 0 }, 'bad_seq'],
    [{ seq: 1.5 }, 'bad_seq'],
    [{ payload: [1, 2] }, 'payload_not_object'],
    [{ payload: null }, 'payload_not_object']
  ];
  for (const [override, code] of cases) {
    assert.throws(() => buildMessage(base(override)), (error) => error.code === code, `${JSON.stringify(override)} must fail with ${code}`);
  }
  const big = { text: 'x'.repeat(PAYLOAD_MAX_BYTES + 10) };
  assert.throws(() => buildMessage(base({ payload: big })), (error) => error.code === 'payload_too_large');
});

test('every refusal has a written Arabic reason', () => {
  for (const [code, reason] of Object.entries(REFUSAL)) {
    assert.ok(reason && /[\u0600-\u06FF]/.test(reason), `${code} has no Arabic reason`);
  }
});

test('XB-09: an edited payload or forged identity is caught by recomputation', () => {
  const message = buildMessage(base());
  const row = { ...message, at: '2026-11-01T09:00:00.000Z', status: 'pending' };
  assert.equal(verifyMessage(row).ok, true);

  const editedPayload = { ...row, payload: { summary: 'شيء آخر', sources: 3 } };
  assert.equal(verifyMessage(editedPayload).code, 'payload_edited');

  const forgedId = { ...row, messageId: 'msg:ffffffffffffffff' };
  assert.equal(verifyMessage(forgedId).code, 'identity_forged');
  assert.equal(verifyMessage(null).code, 'message_missing');
});

test('the attestation covers exactly what the ledger hashes, and nothing a reader cannot verify', () => {
  const message = buildMessage(base());
  const attestation = attestationOf(message);
  assert.deepEqual(Object.keys(attestation).sort(), ['from', 'kind', 'messageId', 'payloadHash', 'seq', 'to', 'traceId']);
  assert.equal(attestation.payloadHash, message.payloadHash);
  assert.ok(!JSON.stringify(attestation).includes('انتهى البحث'), 'the attestation carries the hash, not the body');
});

test('hashing is stable across serializations of the same object', () => {
  const a = hashPayload({ b: 2, a: 1 });
  const b = hashPayload({ a: 1, b: 2 });
  assert.equal(a.payloadHash, b.payloadHash, 'key order must not change the payload hash');
  assert.equal(a.payloadHash.length, 64);
});

test('a batch digest is order-independent and changes with content', () => {
  const one = buildMessage(base({ seq: 1 }));
  const two = buildMessage(base({ seq: 2, payload: { summary: 'ثانٍ' } }));
  assert.equal(batchDigest([one, two]), batchDigest([two, one]));
  assert.notEqual(batchDigest([one]), batchDigest([two]));
});

test('the Arabic report names each message and says the pull creates no run', () => {
  const one = buildMessage(base({ seq: 1 }));
  const text = describeBus({ messages: [one], cursor: 0 });
  assert.match(text, /1 رسالة مستحقة/);
  assert.match(text, /result\.ready/);
  assert.match(text, /السحب لا يُنشئ تشغيلًا/);
  assert.match(describeBus({ messages: [], cursor: 7 }), /لا رسائل مستحقة — المؤشّر عند 7/);
});

test('the refusal carries a code and a readable detail, not a bare string', () => {
  const refusal = new BusRefusal('unknown_kind', 'نوع غير معروف: x');
  assert.equal(refusal.name, 'BusRefusal');
  assert.equal(refusal.code, 'unknown_kind');
  assert.equal(refusal.detail, 'نوع غير معروف: x');
  assert.match(String(refusal.message), /x/);
});

test('messageIdOf is a pure function of the six identifying fields', () => {
  const fields = { traceId: 't', from: 'f', to: 'run:r', kind: BUS_KIND.handoff, payloadHash: 'h', seq: 3 };
  assert.equal(messageIdOf(fields), messageIdOf({ ...fields }));
  assert.notEqual(messageIdOf(fields), messageIdOf({ ...fields, seq: 4 }));
});
