import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import {
  agendaRange,
  arabicCount,
  formatAgendaReply,
  formatInboxReply,
  ownerGoogleErrorReply,
  parseOwnerGoogleCommand,
  timeZoneOffsetMinutes
} from '../src/owner-google-commands.js';
import { createWhatsAppWebhookRouter, runOwnerGoogleCommand } from '../src/whatsapp.js';
import { fetchInboxMessages, listAgendaEvents } from '../src/google.js';

const OWNER = '+201012345678';
const config = {
  ownerPhone: OWNER,
  userId: 'owner',
  timezone: 'Africa/Cairo',
  google: { clientId: '', clientSecret: '', allowedEmail: '', redirectUri: 'http://localhost:3000/auth/google/callback' },
  whatsapp: { verifyToken: '', appSecret: 'test-app-secret', accessToken: 'wa-token', phoneNumberId: '1234567890', apiVersion: 'v20.0', autoReplyEnabled: false },
  resilience: { timeoutMs: 8000 }
};

test('owner commands: the narrow Arabic/English phrasings parse, anything else does not', () => {
  const latest = ['لخص آخر إيميل', 'لخص اخر ايميل', 'هات آخر إيميل', 'اقرا اخر ايميل', 'آخر إيميل', 'لخّص لي آخر رسالة', 'summarize my last email', 'last email', 'read latest mail'];
  for (const text of latest) assert.deepEqual(parseOwnerGoogleCommand(text), { kind: 'latest_email', unreadOnly: false }, text);
  const unread = ['هات الإيميلات الجديدة', 'فيه ايميلات جديدة؟', 'الرسائل غير المقروءة', 'any new emails?', 'unread mail'];
  for (const text of unread) assert.deepEqual(parseOwnerGoogleCommand(text), { kind: 'latest_email', unreadOnly: true }, text);
  assert.deepEqual(parseOwnerGoogleCommand('جدولي'), { kind: 'agenda', range: 'today' });
  assert.deepEqual(parseOwnerGoogleCommand('هات جدولي'), { kind: 'agenda', range: 'today' });
  assert.deepEqual(parseOwnerGoogleCommand('إيه مواعيدي اليوم'), { kind: 'agenda', range: 'today' });
  assert.deepEqual(parseOwnerGoogleCommand('جدول النهارده'), { kind: 'agenda', range: 'today' });
  assert.deepEqual(parseOwnerGoogleCommand('جدولي بكرة'), { kind: 'agenda', range: 'tomorrow' });
  assert.deepEqual(parseOwnerGoogleCommand('مواعيد الأسبوع'), { kind: 'agenda', range: 'week' });
  assert.deepEqual(parseOwnerGoogleCommand('جدولي الأسبوع ده'), { kind: 'agenda', range: 'week' });
  assert.deepEqual(parseOwnerGoogleCommand('show my calendar tomorrow'), { kind: 'agenda', range: 'tomorrow' });
  assert.deepEqual(parseOwnerGoogleCommand('agenda this week'), { kind: 'agenda', range: 'week' });
  for (const text of ['', 'جوجل', 'ايميل', 'لخص', 'عايز اعرف اخر ايميل بليز', 'لخص آخر إيميل من أحمد', 'اربط جوجل', 'جدول', 'جدول الضرب', 'send my last email to ali', 'x'.repeat(100)]) {
    assert.equal(parseOwnerGoogleCommand(text), null, text);
  }
});

test('agenda ranges follow the owner time zone across the Egyptian DST switch', () => {
  const now = new Date('2026-10-28T10:00:00Z'); // Cairo is UTC+3 until the last Thursday of October (29 Oct 2026)
  assert.equal(timeZoneOffsetMinutes(now, 'Africa/Cairo'), 180);
  assert.equal(timeZoneOffsetMinutes(new Date('2026-11-05T10:00:00Z'), 'Africa/Cairo'), 120);
  assert.equal(timeZoneOffsetMinutes(now, 'UTC'), 0);
  const today = agendaRange('today', { now, timeZone: 'Africa/Cairo' });
  assert.equal(today.timeMin.toISOString(), '2026-10-28T10:00:00.000Z');
  assert.equal(today.timeMax.toISOString(), '2026-10-28T21:00:00.000Z'); // local midnight at +3
  assert.match(today.label, /اليوم/);
  const tomorrow = agendaRange('tomorrow', { now, timeZone: 'Africa/Cairo' });
  assert.equal(tomorrow.timeMin.toISOString(), '2026-10-28T21:00:00.000Z');
  assert.equal(tomorrow.timeMax.toISOString(), '2026-10-29T22:00:00.000Z'); // clocks fall back that night → midnight at +2
  const week = agendaRange('week', { now, timeZone: 'Africa/Cairo' });
  assert.equal(week.timeMin, now);
  assert.equal(week.timeMax.toISOString(), '2026-11-03T22:00:00.000Z');
});

test('inbox replies: latest email ignores read state, "nothing unread" still shows the newest read mail', () => {
  const read = { from: 'Ahmed <a@example.com>', subject: 'عرض سعر', date: '2026-10-28T08:30:00Z', snippet: 'مرفق عرض السعر', unread: false };
  const latest = formatInboxReply({ unreadOnly: false, messages: [read] });
  assert.match(latest, /آخر إيميل في الوارد/);
  assert.match(latest, /الموضوع: عرض سعر/);
  assert.match(latest, /الحالة: مقروء/);
  assert.match(latest, /11:30 ص/); // 08:30Z rendered in Africa/Cairo (+3)
  assert.match(formatInboxReply({ unreadOnly: false, messages: [] }), /صندوق الوارد فارغ/);
  const noneUnread = formatInboxReply({ unreadOnly: true, messages: [], fallback: read });
  assert.match(noneUnread, /لا توجد رسائل غير مقروءة/);
  assert.match(noneUnread, /آخر رسالة وصلت \(مقروءة\)/);
  assert.match(noneUnread, /عرض سعر/);
  const two = formatInboxReply({ unreadOnly: true, messages: [{ ...read, unread: true }, { ...read, subject: 'فاتورة', unread: true }] });
  assert.match(two, /رسالتان غير مقروءة/);
  assert.match(two, /1\) من:/);
  assert.match(two, /2\) من:/);
  assert.equal(arabicCount(5, { one: 'موعد واحد', two: 'موعدان', few: 'مواعيد', many: 'موعدًا' }), '5 مواعيد');
  assert.equal(arabicCount(11, { one: 'موعد واحد', two: 'موعدان', few: 'مواعيد', many: 'موعدًا' }), '11 موعدًا');
});

test('agenda replies: cancelled events are dropped, all-day and timed events are labelled in the owner zone', () => {
  const reply = formatAgendaReply({
    range: 'today',
    label: 'اليوم',
    events: [
      { summary: 'اجتماع', start: { dateTime: '2026-10-28T11:00:00+03:00' }, end: { dateTime: '2026-10-28T12:00:00+03:00' }, location: 'Zoom' },
      { summary: 'إجازة', start: { date: '2026-10-28' }, end: { date: '2026-10-29' } },
      { summary: 'ملغي', status: 'cancelled', start: { dateTime: '2026-10-28T13:00:00+03:00' } }
    ]
  });
  assert.match(reply, /موعدان/);
  assert.match(reply, /11:00 ص – 12:00 م: اجتماع — Zoom/);
  assert.match(reply, /طوال اليوم: إجازة/);
  assert.doesNotMatch(reply, /ملغي/);
  assert.match(formatAgendaReply({ range: 'today', label: 'اليوم', events: [] }), /لا مواعيد اليوم/);
});

test('error replies name the next step and never leak provider details', () => {
  assert.match(ownerGoogleErrorReply({ status: 409 }), /اربط جوجل/);
  assert.match(ownerGoogleErrorReply({ status: 503 }), /GOOGLE_CLIENT_ID/);
  assert.match(ownerGoogleErrorReply({ status: 403, message: 'insufficientPermissions ya29.secret' }), /أعد|من جديد/);
  assert.doesNotMatch(ownerGoogleErrorReply({ status: 403, message: 'ya29.secret' }), /ya29/);
  assert.match(ownerGoogleErrorReply({ name: 'AbortError' }), /الوقت المحدد/);
  assert.match(ownerGoogleErrorReply(new Error('boom')), /تعذر الوصول/);
});

test('runOwnerGoogleCommand: a never-connected account yields the "connect first" reply (409 from the real fetcher)', async () => {
  const pool = { async execute() { return [[], []]; } };
  await assert.rejects(fetchInboxMessages({ pool, config }), (error) => error.status === 409);
  await assert.rejects(listAgendaEvents({ pool, config, timeMin: new Date(), timeMax: new Date() }), (error) => error.status === 409);
  const reply = await runOwnerGoogleCommand({ pool, config, command: { kind: 'latest_email', unreadOnly: false } });
  assert.match(reply, /غير مربوط بعد/);
});

test('fetchInboxMessages: no is:unread filter by default, INBOX only, metadata + snippet, unread flag from labels', async () => {
  const calls = [];
  const gmailClient = {
    users: {
      messages: {
        async list(params) { calls.push(['list', params]); return { data: { messages: [{ id: 'm1' }] } }; },
        async get(params) {
          calls.push(['get', params]);
          return { data: { snippet: 'مرحبًا، مرفق العرض', internalDate: '1793529000000', labelIds: ['INBOX'], payload: { headers: [{ name: 'From', value: 'Ahmed <a@example.com>' }, { name: 'Subject', value: 'عرض سعر' }, { name: 'Date', value: 'Wed, 28 Oct 2026 10:30:00 +0300' }] } } };
        }
      }
    }
  };
  const messages = await fetchInboxMessages({ pool: null, config, gmailClient });
  assert.equal(calls[0][1].q, undefined);
  assert.deepEqual(calls[0][1].labelIds, ['INBOX']);
  assert.equal(calls[0][1].maxResults, 1);
  assert.equal(calls[1][1].format, 'metadata');
  assert.deepEqual(messages, [{ id: 'm1', from: 'Ahmed <a@example.com>', subject: 'عرض سعر', date: new Date(1793529000000).toISOString(), snippet: 'مرحبًا، مرفق العرض', unread: false }]);
  await fetchInboxMessages({ pool: null, config, gmailClient, unreadOnly: true, maxResults: 5 });
  assert.equal(calls.at(-2)[1].q, 'is:unread');
  assert.equal(calls.at(-2)[1].maxResults, 5);
});

function sign(body) {
  return `sha256=${crypto.createHmac('sha256', config.whatsapp.appSecret).update(body).digest('hex')}`;
}

function inboundPayload({ from, text, id }) {
  return JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id, from: from.replace('+', ''), type: 'text', text: { body: text } }] } }] }] });
}

test('webhook: the owner gets the Gmail/Calendar reply; the same text from a customer touches neither Google nor WhatsApp', async () => {
  const seen = new Set();
  const pool = {
    async execute(sql, params) {
      if (/^INSERT IGNORE INTO whatsapp_messages/.test(sql)) {
        if (seen.has(params[0])) return [{ affectedRows: 0 }];
        seen.add(params[0]);
        return [{ affectedRows: 1 }];
      }
      return [[], []];
    }
  };
  const googleCalls = [];
  const googleOps = {
    async fetchInboxMessages({ unreadOnly, maxResults }) {
      googleCalls.push(['inbox', unreadOnly, maxResults]);
      return [{ id: 'm1', from: 'Sara <s@example.com>', subject: 'موعد التسليم', date: '2026-10-28T07:00:00Z', snippet: 'التسليم يوم الخميس', unread: false }];
    },
    async listAgendaEvents({ timeMin, timeMax }) {
      googleCalls.push(['agenda', timeMin.toISOString(), timeMax.toISOString()]);
      return [{ id: 'e1', summary: 'اجتماع الفريق', status: 'confirmed', location: '', start: { dateTime: '2026-10-28T15:00:00+03:00' }, end: { dateTime: '2026-10-28T16:00:00+03:00' } }];
    }
  };
  const sent = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://graph.facebook.com/')) {
      sent.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ messages: [{ id: `wamid.${sent.length}` }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const app = express();
  app.use('/webhooks/whatsapp', createWhatsAppWebhookRouter({ pool, config, googleOps }));
  const server = app.listen(0);
  const baseUrl = await new Promise((resolve) => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  try {
    const post = async (payload) => previousFetch(`${baseUrl}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(payload) }, body: payload });

    let response = await post(inboundPayload({ from: OWNER, text: 'لخص آخر إيميل', id: 'wamid.in1' }));
    assert.equal(response.status, 200);
    assert.deepEqual(googleCalls, [['inbox', false, 1]]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, OWNER.slice(1));
    assert.match(sent[0].text.body, /موعد التسليم/);
    assert.match(sent[0].text.body, /الحالة: مقروء/);

    response = await post(inboundPayload({ from: OWNER, text: 'هات جدولي', id: 'wamid.in2' }));
    assert.equal(response.status, 200);
    assert.equal(googleCalls[1][0], 'agenda');
    assert.match(sent[1].text.body, /اجتماع الفريق/);
    assert.match(sent[1].text.body, /03:00 م – 04:00 م/);

    // Meta retries the same provider message id → processed once only.
    response = await post(inboundPayload({ from: OWNER, text: 'هات جدولي', id: 'wamid.in2' }));
    assert.equal(response.status, 200);
    assert.equal(sent.length, 2);

    // A customer sending the exact owner phrasing gets nothing and Google is never consulted.
    response = await post(inboundPayload({ from: '+201000000009', text: 'لخص آخر إيميل', id: 'wamid.in3' }));
    assert.equal(response.status, 200);
    assert.equal(googleCalls.length, 2);
    assert.equal(sent.length, 2);
  } finally {
    globalThis.fetch = previousFetch;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
