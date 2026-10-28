/**
 * Owner-only Google commands over WhatsApp — "لخص آخر إيميل" / "هات جدولي".
 *
 * Pure parsing + formatting only (no network, no secrets) so every branch is testable offline.
 * The webhook proves the sender is APP_OWNER_PHONE_E164 before any of this runs; a customer
 * message can never read the owner's inbox or calendar.
 *
 * Deliberate choices:
 *  - "آخر إيميل" means the newest message in INBOX **whether or not it was read** — no `is:unread`
 *    filter, which is the usual cause of a misleading "no new emails" answer.
 *  - "الإيميلات الجديدة" means unread only; when there are none we still show the newest read
 *    message so the owner can tell "nothing unread" from "nothing at all".
 *  - The reply is built from Gmail metadata + Google's own snippet. No email body is sent to any
 *    LLM: on unpaid provider tiers the content could be used for training (see go-live-plan §0).
 */

const MAX_COMMAND_LENGTH = 80;
const DAY_WORDS = {
  today: ['اليوم', 'النهارده', 'النهاردة', 'النهاردا', 'today'],
  tomorrow: ['بكرة', 'بكره', 'غدًا', 'غدا', 'tomorrow'],
  week: ['الأسبوع', 'الاسبوع', 'الأسبوع ده', 'الاسبوع ده', 'this week', 'week']
};

function normalize(text) {
  return String(text || '')
    .trim()
    .replace(/[\u064B-\u0652\u0640]/g, '') // tashkeel + tatweel
    .replace(/[؟?!.،,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchDayWord(word) {
  if (!word) return 'today';
  const lower = word.toLowerCase();
  for (const [key, words] of Object.entries(DAY_WORDS)) {
    if (words.some((candidate) => candidate.toLowerCase() === lower)) return key;
  }
  return null;
}

/**
 * @returns {null | { kind: 'latest_email', unreadOnly: boolean } | { kind: 'agenda', range: 'today'|'tomorrow'|'week' }}
 */
export function parseOwnerGoogleCommand(body) {
  const text = normalize(body);
  if (!text || text.length > MAX_COMMAND_LENGTH) return null;

  // آخر إيميل (read or unread)
  if (/^(?:لخص|لخّص|هات|اقرا|اقرأ|اعرض|ورّيني|وريني)(?:\s+لي)?\s+(?:آخر|اخر)\s+(?:إيميل|ايميل|رسالة|بريد|email|mail)(?:\s+(?:وصلني|عندي|لي))?$/i.test(text)
    || /^(?:آخر|اخر)\s+(?:إيميل|ايميل|رسالة|بريد)$/i.test(text)
    || /^(?:summari[sz]e|read|show)\s+(?:me\s+)?(?:my\s+)?(?:last|latest)\s+(?:e-?mail|mail|message)$/i.test(text)
    || /^(?:last|latest)\s+(?:e-?mail|mail)$/i.test(text)) {
    return { kind: 'latest_email', unreadOnly: false };
  }

  // الإيميلات الجديدة / غير المقروءة
  if (/^(?:هات|اعرض|فيه|في|ورّيني|وريني)?\s*(?:لي\s+)?(?:الإيميلات|الايميلات|إيميلات|ايميلات|الرسائل|رسائل|البريد)\s+(?:الجديدة|جديدة|الجديده|جديده|غير المقروءة|غير المقروءه|اللي لسه ما قريتهاش)$/i.test(text)
    || /^(?:any\s+|show\s+)?(?:my\s+)?(?:new|unread)\s+(?:e-?mails?|mail|messages?)$/i.test(text)) {
    return { kind: 'latest_email', unreadOnly: true };
  }

  // جدولي / مواعيدي (+ اليوم | بكرة | الأسبوع)
  const agenda = /^(?:(?:هات|اعرض|ورّيني|وريني|ايه|إيه|ما هو|ماهو)\s+)?(?:لي\s+)?(?:جدولي|مواعيدي|اجندتي|أجندتي|جدول(?:\s+(?:اليوم|النهارده|النهاردة|النهاردا|بكرة|بكره|غدًا|غدا|الأسبوع|الاسبوع))|مواعيد(?:\s+(?:اليوم|النهارده|النهاردة|النهاردا|بكرة|بكره|غدًا|غدا|الأسبوع|الاسبوع)))(?:\s+(اليوم|النهارده|النهاردة|النهاردا|بكرة|بكره|غدًا|غدا|الأسبوع|الاسبوع))?(?:\s+ده)?$/i.exec(text);
  if (agenda) {
    const explicit = agenda[1] || /(?:جدول|مواعيد)\s+(\S+)$/.exec(text)?.[1];
    const range = matchDayWord(explicit);
    return range ? { kind: 'agenda', range } : null;
  }
  const english = /^(?:show\s+|what(?:'s| is)\s+(?:on\s+)?)?(?:my\s+)?(?:schedule|calendar|agenda)(?:\s+(?:for\s+)?(today|tomorrow|this week))?$/i.exec(text);
  if (english) {
    const range = matchDayWord(english[1]);
    return range ? { kind: 'agenda', range } : null;
  }
  return null;
}

/** Offset of `timeZone` at `date`, in minutes east of UTC (e.g. Africa/Cairo summer → 180). */
export function timeZoneOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(date);
  const name = parts.find((part) => part.type === 'timeZoneName')?.value || 'GMT';
  const match = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(name);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] || 0));
}

function civilDate(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const pick = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: pick('year'), month: pick('month'), day: pick('day') };
}

/** UTC instant of local midnight for the civil day `dayOffset` days after `now` in `timeZone` (DST-safe). */
function localMidnightUtc(now, timeZone, dayOffset) {
  const { year, month, day } = civilDate(now, timeZone);
  const guess = Date.UTC(year, month - 1, day + dayOffset);
  let instant = guess - timeZoneOffsetMinutes(new Date(guess), timeZone) * 60_000;
  // Second pass corrects a guess that landed on the other side of a DST switch.
  instant = guess - timeZoneOffsetMinutes(new Date(instant), timeZone) * 60_000;
  return new Date(instant);
}

/** @returns {{ timeMin: Date, timeMax: Date, label: string }} */
export function agendaRange(range, { now = new Date(), timeZone = 'Africa/Cairo' } = {}) {
  const dayLabel = (date) => new Intl.DateTimeFormat('ar-EG-u-nu-latn', { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).format(date);
  if (range === 'tomorrow') {
    const timeMin = localMidnightUtc(now, timeZone, 1);
    const timeMax = localMidnightUtc(now, timeZone, 2);
    return { timeMin, timeMax, label: `بكرة (${dayLabel(timeMin)})` };
  }
  if (range === 'week') {
    const timeMin = now;
    const timeMax = localMidnightUtc(now, timeZone, 7);
    return { timeMin, timeMax, label: `الأيام السبعة القادمة من ${dayLabel(now)}` };
  }
  const timeMin = now;
  const timeMax = localMidnightUtc(now, timeZone, 1);
  return { timeMin, timeMax, label: `اليوم (${dayLabel(now)})` };
}

/** Arabic count phrase: 1 → "موعد واحد", 2 → "موعدان", 3–10 → "N مواعيد", 11+ → "N موعدًا". */
export function arabicCount(count, { one, two, few, many }) {
  if (count === 1) return one;
  if (count === 2) return two;
  if (count >= 3 && count <= 10) return `${count} ${few}`;
  return `${count} ${many}`;
}

function clip(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function formatInboxLine(message, timeZone) {
  const when = message.date ? formatDateTime(message.date, timeZone) : '';
  return [
    `من: ${clip(message.from, 120) || '—'}`,
    `الموضوع: ${clip(message.subject, 160) || '(بلا موضوع)'}`,
    when ? `التاريخ: ${when}` : null,
    `الحالة: ${message.unread ? 'غير مقروء' : 'مقروء'}`,
    `المقتطف: ${clip(message.snippet, 400) || '—'}`
  ].filter(Boolean).join('\n');
}

function formatDateTime(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return clip(String(value), 60);
  return new Intl.DateTimeFormat('ar-EG-u-nu-latn', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }).format(date);
}

/**
 * @param {{ unreadOnly: boolean, messages: Array, fallback?: object|null, timeZone?: string }} input
 *   `messages` are the matches (newest first); `fallback` is the newest message when an unread
 *   request matched nothing, so "no unread" never reads as "no email".
 */
export function formatInboxReply({ unreadOnly, messages, fallback = null, timeZone = 'Africa/Cairo' }) {
  if (!unreadOnly) {
    if (!messages.length) return '📭 صندوق الوارد فارغ — لا توجد أي رسالة في Inbox (ولا حتى مقروءة).';
    return `📧 آخر إيميل في الوارد:\n${formatInboxLine(messages[0], timeZone)}`;
  }
  if (!messages.length) {
    if (!fallback) return '📭 لا توجد رسائل غير مقروءة، وصندوق الوارد فارغ أصلًا.';
    return `✅ لا توجد رسائل غير مقروءة الآن.\nآخر رسالة وصلت (مقروءة):\n${formatInboxLine(fallback, timeZone)}`;
  }
  const count = arabicCount(messages.length, { one: 'رسالة واحدة', two: 'رسالتان', few: 'رسائل', many: 'رسالة' });
  const header = messages.length === 1 ? `📬 ${count} غير مقروءة:` : `📬 ${count} غير مقروءة (الأحدث أولًا):`;
  return `${header}\n\n${messages.map((message, index) => `${index + 1}) ${formatInboxLine(message, timeZone)}`).join('\n\n')}`;
}

function eventTimes(event, timeZone) {
  if (event.start?.date && !event.start?.dateTime) return 'طوال اليوم';
  const fmt = new Intl.DateTimeFormat('ar-EG-u-nu-latn', { timeZone, hour: '2-digit', minute: '2-digit', hour12: true });
  const start = new Date(event.start?.dateTime);
  const end = event.end?.dateTime ? new Date(event.end.dateTime) : null;
  if (Number.isNaN(start.getTime())) return '—';
  return end && !Number.isNaN(end.getTime()) ? `${fmt.format(start)} – ${fmt.format(end)}` : fmt.format(start);
}

/** @param {{ range: string, events: Array, label: string, timeZone?: string }} input */
export function formatAgendaReply({ events, label, timeZone = 'Africa/Cairo' }) {
  const kept = (events || []).filter((event) => event && event.status !== 'cancelled');
  if (!kept.length) return `🗓️ لا مواعيد ${label} في التقويم الأساسي.`;
  const lines = kept.slice(0, 20).map((event) => {
    const where = event.location ? ` — ${clip(event.location, 80)}` : '';
    return `• ${eventTimes(event, timeZone)}: ${clip(event.summary, 120) || '(بلا عنوان)'}${where}`;
  });
  const more = kept.length > 20 ? `\n… و${kept.length - 20} مواعيد أخرى.` : '';
  const count = arabicCount(kept.length, { one: 'موعد واحد', two: 'موعدان', few: 'مواعيد', many: 'موعدًا' });
  return `🗓️ جدولك ${label} — ${count} (${timeZone}):\n${lines.join('\n')}${more}`;
}

/** Owner-facing failure text — never includes provider messages, tokens or stack details. */
export function ownerGoogleErrorReply(error) {
  const status = Number.isInteger(error?.status) ? error.status : Number(error?.code) || 0;
  if (status === 409) return '🔗 حساب Google غير مربوط بعد على هذا الخادم. ابعت «اربط جوجل» ليصلك رابط ربط يعمل مرة واحدة.';
  if (status === 503) return '⚙️ ربط Google غير مهيأ على الخادم (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET غير مقروءين في هذه العملية).';
  if (status === 401 || status === 403) return '🔐 Google رفض الطلب: الصلاحية منتهية أو غير ممنوحة لهذا النطاق. اسحب الصلاحية من myaccount.google.com/permissions ثم ابعت «اربط جوجل» من جديد.';
  if (error?.name === 'AbortError' || error?.code === 'ETIMEDOUT' || status === 504) return '⏳ Google لم يرد في الوقت المحدد. حاول مرة أخرى بعد قليل.';
  return '⚠️ تعذر الوصول إلى Google الآن. حاول لاحقًا؛ إن تكرر الخطأ راجع سجل الخادم.';
}
