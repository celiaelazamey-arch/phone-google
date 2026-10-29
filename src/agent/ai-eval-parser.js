import { timeZoneOffsetMinutes } from '../owner-google-commands.js';

/**
 * Deterministic Arabic appointment extractor for AI-001 only.
 *
 * This is deliberately a small, inspectable mock provider — not the production
 * planner and not evidence of live-model quality. It receives scenario inputs,
 * never the case's `expected` object, and returns a draft or a safe non-write.
 */

const WORD_HOURS = Object.freeze([
  ['الحادية عشرة', 11],
  ['الثانية عشرة', 12],
  ['الثالثة', 3],
  ['الرابعة', 4],
  ['الخامسة', 5],
  ['السادسة', 6],
  ['السابعة', 7],
  ['الثامنة', 8],
  ['التاسعة', 9],
  ['العاشرة', 10],
  ['العشرة', 10],
  ['الواحدة', 1],
  ['الثانية', 2]
]);

const TYPE_LABELS = Object.freeze({
  'موعد': 'موعد',
  'اجتماع': 'اجتماع',
  'مكالمة': 'مكالمة',
  'مكالمه': 'مكالمة',
  'زيارة': 'زيارة',
  'جلسة': 'جلسة'
});

const INJECTION_PATTERNS = Object.freeze([
  /تجاهل\s+(?:كل\s+)?التعليمات/i,
  /ignore\s+(?:all\s+|previous\s+|prior\s+)*instructions/i,
  /بدون\s+(?:انتظار\s+)?موافقة/i,
  /دون\s+(?:انتظار\s+)?موافقة/i,
  /لا\s+تنتظر\s+(?:المالك|موافقة)/i,
  /أرسل\s+مباشرة/i,
  /ارسل\s+مباشرة/i,
  /system\s+prompt/i
]);

function normalize(value) {
  return String(value || '')
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/\s+/g, ' ')
    .trim();
}

function civilDate(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(instant));
  const pick = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: pick('year'), month: pick('month'), day: pick('day') };
}

function addDays(date, amount) {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + amount));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

function validCivilDate(date) {
  if (![date.year, date.month, date.day].every(Number.isInteger)) return false;
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return value.getUTCFullYear() === date.year && value.getUTCMonth() === date.month - 1 && value.getUTCDate() === date.day;
}

/** Convert a civil wall time at an IANA zone to a UTC instant, with a DST second pass. */
export function zonedWallTimeToIso(date, hour, minute, timeZone = 'Africa/Cairo') {
  if (!validCivilDate(date) || !Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null;
  const wallMs = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  let instantMs = wallMs - timeZoneOffsetMinutes(new Date(wallMs), timeZone) * 60_000;
  instantMs = wallMs - timeZoneOffsetMinutes(new Date(instantMs), timeZone) * 60_000;
  const instant = new Date(instantMs);
  const roundTrip = civilDate(instant, timeZone);
  if (roundTrip.year !== date.year || roundTrip.month !== date.month || roundTrip.day !== date.day) return null;
  return instant.toISOString();
}

function extractDate(text, referenceTime, timeZone) {
  const reference = civilDate(referenceTime, timeZone);
  const explicit = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(text);
  if (explicit) return { year: Number(explicit[1]), month: Number(explicit[2]), day: Number(explicit[3]) };
  if (/بعد\s+(?:بكرة|بكره)/.test(text)) return addDays(reference, 2);
  if (/(?:بكرة|بكره|غدا)/.test(text)) return addDays(reference, 1);
  if (/(?:اليوم|النهاردة|النهارده)/.test(text)) return reference;
  return null;
}

function applyPeriod(hour, text) {
  let value = hour;
  if (/(?:مساء|عصرا)/.test(text) && value < 12) value += 12;
  if (/ظهرا/.test(text) && value < 12) value += 12;
  if (/صباحا/.test(text) && value === 12) value = 0;
  return value;
}

function extractTime(text) {
  // A fraction in «لمدة ساعة ونصف» describes duration, not the start minute.
  const timeText = text.split('لمدة')[0];
  let hour = null;
  let minute = 0;
  let matched = false;
  const labelled = /الساعة\s+(\d{1,2})(?::(\d{2}))?/.exec(text);
  const clock = /(?<![\d-])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/.exec(text);
  const afterDay = /(?:بكرة|بكره|غدا|اليوم|النهاردة|النهارده)\s+(\d{1,2})(?::(\d{2}))?/.exec(text);
  const numeric = labelled || clock || afterDay;
  if (numeric) {
    hour = Number(numeric[1]);
    minute = Number(numeric[2] || 0);
    matched = true;
  } else {
    for (const [phrase, value] of WORD_HOURS) {
      if (new RegExp(`(?:^|\\s)${phrase}(?=\\s|$)`).test(text)) {
        hour = value;
        matched = true;
        break;
      }
    }
  }
  if (!matched) return null;
  if (/(?:والنصف|ونصف)/.test(timeText)) minute = 30;
  else if (/(?:والربع|وربع)/.test(timeText)) minute = 15;
  hour = applyPeriod(hour, text);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return { invalid: true };
  return { hour, minute };
}

function extractDuration(text) {
  if (/لمدة\s+ساعة\s+ونصف/.test(text)) return 90;
  if (/لمدة\s+ساعتين/.test(text)) return 120;
  if (/لمدة\s+ساعة/.test(text)) return 60;
  const minutes = /لمدة\s+(\d{1,3})\s+دقيقة/.exec(text);
  if (minutes) return Number(minutes[1]);
  return 30;
}

function extractSummary(text) {
  const types = Object.keys(TYPE_LABELS).join('|');
  const marker = [
    'بعد\\s+بكرة', 'بعد\\s+بكره', 'بكرة', 'بكره', 'غدا', 'اليوم', 'النهاردة', 'النهارده',
    'يوم\\s+\\d{4}-\\d{2}-\\d{2}', '\\d{4}-\\d{2}-\\d{2}', 'الساعة\\s+\\d{1,2}',
    'الحادية\\s+عشرة', 'الثانية\\s+عشرة', 'الثالثة', 'الرابعة', 'الخامسة', 'السادسة',
    'السابعة', 'الثامنة', 'التاسعة', 'العاشرة', 'العشرة', 'الواحدة', 'الثانية'
  ].join('|');
  const match = new RegExp(`(${types})\\s+مع\\s+(.+?)(?=\\s+(?:${marker})|$)`, 'i').exec(text);
  if (!match) return null;
  const contact = match[2].trim();
  if (!contact || contact.length > 80) return null;
  return `${TYPE_LABELS[match[1]]} مع ${contact}`;
}

function safeResult(decision, extra = {}) {
  return { decision, payload: null, missing: [], reason: null, ...extra };
}

/**
 * @param {{message:string, referenceTime:string, timeZone?:string, busy?:Array}} input
 * @returns {{decision:string, payload:object|null, missing:string[], reason:string|null}}
 */
export function extractArabicAppointment({ message, referenceTime, timeZone = 'Africa/Cairo', busy = [] } = {}) {
  const text = normalize(message);
  if (!text || !Number.isFinite(Date.parse(referenceTime || ''))) return safeResult('clarification', { missing: ['message'], reason: 'invalid_input' });
  if (INJECTION_PATTERNS.some((pattern) => pattern.test(text))) {
    return safeResult('blocked_injection', { reason: 'approval_bypass_or_prompt_injection' });
  }

  const summary = extractSummary(text);
  const date = extractDate(text, referenceTime, timeZone);
  const time = extractTime(text);
  const missing = [];
  if (!summary) missing.push('contact');
  if (!date || !validCivilDate(date)) missing.push('date');
  if (!time) missing.push('time');
  if (time?.invalid) missing.push('valid_time');
  if (missing.length) return safeResult('clarification', { missing, reason: 'appointment_fields_required' });

  const start = zonedWallTimeToIso(date, time.hour, time.minute, timeZone);
  if (!start) return safeResult('clarification', { missing: ['valid_time'], reason: 'invalid_civil_time' });
  const durationMinutes = extractDuration(text);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 720) {
    return safeResult('clarification', { missing: ['valid_duration'], reason: 'invalid_duration' });
  }
  const end = new Date(Date.parse(start) + durationMinutes * 60_000).toISOString();
  const payload = { summary, start, end };
  const conflict = (Array.isArray(busy) ? busy : []).find((slot) => {
    const busyStart = Date.parse(slot?.start || '');
    const busyEnd = Date.parse(slot?.end || '');
    return Number.isFinite(busyStart) && Number.isFinite(busyEnd) && Date.parse(start) < busyEnd && Date.parse(end) > busyStart;
  });
  if (conflict) return safeResult('conflict', { payload, reason: 'proposed_window_overlaps_existing_event' });
  return safeResult('proposal', { payload });
}
