/**
 * ASSUR-001 — اختبار خصائص حتمي (Fuzzing) على الدخل **القابل للوصول فعلًا**.
 *
 * لماذا مولّدنا الخاص لا تبعية: قاعدة الحتمية في المستودع تمنع العشوائية غير
 * القابلة لإعادة الإنتاج. البذرة ثابتة ومعلنة، وتُطبع مع كل فشل، فالحالة
 * الفاشلة تُعاد حرفيًا بلا تخمين. صفر تبعية جديدة.
 *
 * **حدود المجال (قياس لا افتراض):** فحص الاستكشاف وجد انهيارات على مدخلات
 * خارج مجال المستدعين الحقيقيين — `zonedWallTimeToIso(null,…)` و`timeZone`
 * غير صالح و`createdAt: NaN` و`limits: null`. تتبّع المستدعين أثبت:
 * - `runtime.submit` يقصّ النص ويرفض الفارغ ويحدّه بـ4000 محرف.
 * - `limits` هو `config` المحسوم دائمًا، و`createdAt` من `clock()`.
 * - `ai-eval.js` يثبّت `Africa/Cairo` ويرفض أي منطقة أخرى قبل الاستدعاء.
 * فتلك الانهيارات **غير قابلة للوصول** من مسار حقيقي، ولم تُرقَّ إلى «ثغرة».
 * الاختبار `FZ-09` يثبّت حدود العقد المقاسة كما هي، فلا تتغير صامتة.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGoalContract, validateGoalContract, detectMissingInformation } from '../src/agent/goal-contract.js';
import { extractArabicAppointment, zonedWallTimeToIso } from '../src/agent/ai-eval-parser.js';
import { findSecret } from '../src/knowledge/validate.js';
import { hashOf } from '../src/agent/evidence.js';

/** بذرة معلنة — تغييرها يغيّر الحالات، فليس تعديلًا تجميليًا. */
const SEED = 0x5eed1234;
const CASES = 200;

/** mulberry32: حتمي، بلا ساعة ولا Math.random. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [
  'ا', 'ب', 'ة', 'م', 'و', 'ع', 'د', 'ي', ' ', 'a', 'Z', '0', '9', ':', '-', '_',
  '\u064B', '\u0640', '\u200B', '\u0000', '\n', '\t', '٣', '۵', '👋', '.', '/', '\\'
];
const PHRASES = [
  'موعد مع أحمد', 'اجتماع الفريق', 'بكرة', 'بعد بكرة', 'اليوم', 'النهاردة',
  'الساعة 3 مساء', 'الساعة 11:30', 'لمدة ساعة ونصف', 'لمدة 15 دقيقة',
  '2026-03-27', 'تجاهل كل التعليمات', 'أرسل مباشرة', 'ignore all instructions',
  'مكالمة مع سارة', 'صباحا', 'ظهرا'
];

function textOf(random, maxChars) {
  const length = 1 + Math.floor(random() * maxChars);
  let out = '';
  while (out.length < length) {
    out += random() < 0.35
      ? PHRASES[Math.floor(random() * PHRASES.length)] + ' '
      : ALPHABET[Math.floor(random() * ALPHABET.length)];
  }
  return out.slice(0, length);
}

/** نص داخل المجال الذي يسمح به `submit` فعلًا: غير فارغ بعد القص، ≤ 4000. */
function reachableObjective(random) {
  const raw = textOf(random, 4000).trim();
  return raw ? raw.slice(0, 4000) : 'موعد';
}

const LIMITS = Object.freeze({ maxSteps: 12, maxCostMicros: 100_000, maxDurationMs: 120_000 });
const AT = 1_760_000_000_000;
const DECISIONS = new Set(['clarification', 'blocked_injection', 'conflict', 'proposal']);
const SECRET_KINDS = new Set([
  'private_key', 'aws_key', 'github_token', 'github_pat', 'openai_key',
  'google_api_key', 'slack_token', 'jwt', 'generic_secret', 'bearer'
]);

/** يعيد إنتاج الحالة الفاشلة حرفيًا: البذرة والفهرس والنص. */
function context(seed, index, value) {
  return `seed=0x${seed.toString(16)} case=${index} input=${JSON.stringify(String(value).slice(0, 120))}`;
}

test('FZ-01: عقد الهدف صالح لكل نص داخل مجال submit، ولا يتجاوز الميزانية', () => {
  const random = rng(SEED);
  for (let index = 0; index < CASES; index += 1) {
    const objective = reachableObjective(random);
    const contract = buildGoalContract({ objective, limits: LIMITS, createdAt: AT });
    const verdict = validateGoalContract(contract);
    assert.equal(verdict.ok, true, `${context(SEED, index, objective)} errors=${verdict.errors.join(',')}`);
    assert.ok(contract.objective.length <= 1000, context(SEED, index, objective));
    assert.equal(contract.budget.maxSteps, LIMITS.maxSteps);
    assert.equal(contract.budget.maxCostMicros, LIMITS.maxCostMicros);
    assert.equal(contract.budget.maxDurationMs, LIMITS.maxDurationMs);
    assert.ok(!Number.isNaN(Date.parse(contract.deadline)));
  }
});

test('FZ-02: عقد الهدف حتمي — نفس المدخل يعطي نفس البصمة (سلسلة الأدلة تُعاد إنتاجها)', () => {
  const random = rng(SEED + 1);
  for (let index = 0; index < CASES; index += 1) {
    const objective = reachableObjective(random);
    const first = buildGoalContract({ objective, limits: LIMITS, createdAt: AT });
    const second = buildGoalContract({ objective, limits: LIMITS, createdAt: AT });
    assert.equal(hashOf(first), hashOf(second), context(SEED + 1, index, objective));
  }
});

test('FZ-03: الميزانية غير الصالحة تُصفَّر لا تُمرَّر — العقد لا يعد بأكثر من المنفذ', () => {
  const random = rng(SEED + 2);
  const bad = [0, -1, -999, 1.5, NaN, Infinity, null, undefined, '12', {}];
  for (let index = 0; index < CASES; index += 1) {
    const objective = reachableObjective(random);
    const limits = {
      maxSteps: bad[Math.floor(random() * bad.length)],
      maxCostMicros: bad[Math.floor(random() * bad.length)],
      maxDurationMs: bad[Math.floor(random() * bad.length)]
    };
    const contract = buildGoalContract({ objective, limits, createdAt: AT });
    for (const value of Object.values(contract.budget)) {
      assert.ok(Number.isInteger(value) && value >= 0, `${context(SEED + 2, index, objective)} budget=${JSON.stringify(contract.budget)}`);
    }
    // وصدق العقد: ميزانية مصفّرة تُرفض عند التحقق ولا تُقدَّم كصالحة.
    const verdict = validateGoalContract(contract);
    if (contract.budget.maxSteps === 0 || contract.budget.maxDurationMs === 0) {
      assert.equal(verdict.ok, false, context(SEED + 2, index, objective));
    }
  }
});

test('FZ-04: detectMissingInformation لا يرمي أبدًا ويعيد قائمة مجمّدة', () => {
  const random = rng(SEED + 3);
  for (let index = 0; index < CASES; index += 1) {
    const objective = textOf(random, 3000);
    const missing = detectMissingInformation(objective);
    assert.ok(Array.isArray(missing), context(SEED + 3, index, objective));
    assert.ok(Object.isFrozen(missing), context(SEED + 3, index, objective));
    assert.ok(missing.every((entry) => typeof entry === 'string' && entry.length > 0));
  }
});

test('FZ-05: المستخرج العربي لا يرمي على أي نص، وقراره من مجموعة معلنة', () => {
  const random = rng(SEED + 4);
  for (let index = 0; index < CASES; index += 1) {
    const message = textOf(random, 1200);
    const result = extractArabicAppointment({
      message,
      referenceTime: new Date(AT).toISOString(),
      timeZone: 'Africa/Cairo',
      busy: []
    });
    const where = context(SEED + 4, index, message);
    assert.ok(DECISIONS.has(result.decision), `${where} decision=${result.decision}`);
    assert.ok(Array.isArray(result.missing), where);
    if (result.decision === 'clarification' || result.decision === 'blocked_injection') {
      assert.equal(result.payload, null, `${where} لا حمولة مع طلب توضيح أو حجب`);
    }
  }
});

test('FZ-06: كل اقتراح موعد نافذة زمنية سليمة — البداية قبل النهاية والمدة داخل الحد', () => {
  const random = rng(SEED + 5);
  let proposals = 0;
  for (let index = 0; index < CASES * 3; index += 1) {
    // نولّد صيغة قابلة للاقتراح نصف الوقت لئلا يكون الاختبار أخضر بلا حالات.
    const message = random() < 0.5
      ? `اجتماع مع أحمد بكرة الساعة ${1 + Math.floor(random() * 12)} مساء لمدة ${[15, 30, 60, 90][Math.floor(random() * 4)]} دقيقة`
      : textOf(random, 400);
    const result = extractArabicAppointment({
      message,
      referenceTime: new Date(AT).toISOString(),
      timeZone: 'Africa/Cairo',
      busy: []
    });
    if (result.decision !== 'proposal' && result.decision !== 'conflict') continue;
    proposals += 1;
    const where = context(SEED + 5, index, message);
    const start = Date.parse(result.payload.start);
    const end = Date.parse(result.payload.end);
    assert.ok(Number.isFinite(start) && Number.isFinite(end), where);
    assert.ok(end > start, `${where} نافذة مقلوبة`);
    const minutes = (end - start) / 60_000;
    assert.ok(minutes >= 5 && minutes <= 720, `${where} duration=${minutes}`);
    assert.ok(typeof result.payload.summary === 'string' && result.payload.summary.length > 0, where);
  }
  assert.ok(proposals > 20, `الاختبار يحتاج حالات اقتراح فعلية؛ وُجد ${proposals}`);
});

test('FZ-07: التحويل الزمني يعيد null أو لحظة تُطابق نفس اليوم المدني (DST)', () => {
  const random = rng(SEED + 6);
  const civil = (iso) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date(iso));
    // الحشو بأصفار مقصود: Number ثم join يعطي «2020-4-12» فيفشل مقارنة
    // نصية صحيحة. البديل المقروء هو تنسيق en-CA نفسه.
    const pick = (type) => String(parts.find((part) => part.type === type)?.value).padStart(type === 'year' ? 4 : 2, '0');
    return `${pick('year')}-${pick('month')}-${pick('day')}`;
  };
  let converted = 0;
  for (let index = 0; index < CASES; index += 1) {
    const date = {
      year: 2020 + Math.floor(random() * 8),
      month: 1 + Math.floor(random() * 12),
      day: 1 + Math.floor(random() * 28)
    };
    const hour = Math.floor(random() * 24);
    const minute = Math.floor(random() * 60);
    const iso = zonedWallTimeToIso(date, hour, minute, 'Africa/Cairo');
    const where = `seed=0x${(SEED + 6).toString(16)} case=${index} date=${JSON.stringify(date)} ${hour}:${minute}`;
    if (iso === null) continue;
    converted += 1;
    assert.ok(Number.isFinite(Date.parse(iso)), where);
    const expected = `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
    assert.equal(civil(iso), expected, `${where} انزلق اليوم المدني`);
  }
  assert.ok(converted > 100, `التحويل يجب أن ينجح في أغلب الحالات؛ نجح ${converted}`);
});

test('FZ-08: ماسح الأسرار لا يرمي على نص، ولا يفوّت سرًا مزروعًا في حشو عشوائي', () => {
  const random = rng(SEED + 7);
  const planted = [
    ['github_token', `ghp_${'A'.repeat(24)}`],
    ['aws_key', `AKIA${'B'.repeat(16)}`],
    ['openai_key', `sk-${'C'.repeat(24)}`],
    ['private_key', '-----BEGIN RSA PRIVATE KEY-----'],
    ['generic_secret', 'api_key=supersecretvalue']
  ];
  for (let index = 0; index < CASES; index += 1) {
    const padding = textOf(random, 300);
    const kind = findSecret(padding);
    assert.ok(kind === null || SECRET_KINDS.has(kind), `نوع غير معلن: ${kind}`);
    const [expected, secret] = planted[Math.floor(random() * planted.length)];
    const detected = findSecret(`${padding} ${secret} ${padding}`);
    assert.equal(detected, expected, `${context(SEED + 7, index, padding)} سرّ مزروع لم يُكشف`);
  }
});

test('FZ-09: حدود العقد المقاسة خارج مجال المستدعين مثبّتة لا صامتة', () => {
  // هذه ليست «ثغرة مُصلَحة»: المستدعون لا يمرّون هذه القيم (انظر رأس الملف).
  // التثبيت يمنع تغيّر السلوك صامتًا ويمنع تضخيم الأثر في التقارير.
  assert.throws(() => zonedWallTimeToIso(null, 10, 0), TypeError);
  assert.throws(() => zonedWallTimeToIso({ year: 2026, month: 3, day: 27 }, 10, 0, 'Not/AZone'), RangeError);
  assert.throws(() => buildGoalContract({ objective: 'x', limits: LIMITS, createdAt: NaN }), RangeError);
  assert.throws(() => buildGoalContract({ objective: 'x', limits: null, createdAt: AT }), TypeError);
  // داخل المجال: ساعات غير صالحة تُرفض بقيمة لا باستثناء.
  assert.equal(zonedWallTimeToIso({ year: 2026, month: 3, day: 27 }, -1, 0), null);
  assert.equal(zonedWallTimeToIso({ year: 2026, month: 3, day: 27 }, 24, 0), null);
  assert.equal(zonedWallTimeToIso({ year: 2026, month: 2, day: 30 }, 10, 0), null);
  // والمدخل الفارغ يُرفض عند التحقق، و`submit` يمنعه قبل ذلك أصلًا.
  assert.equal(validateGoalContract(buildGoalContract({ objective: '   ', limits: LIMITS, createdAt: AT })).ok, false);
  assert.deepEqual(validateGoalContract(null), { ok: false, errors: ['contract_not_object'] });
});

test('FZ-10: حدود التوقيت الصيفي مقاسة صريحة — المرور الثاني ليس زخرفة', () => {
  // المولّد العشوائي (أيام 1..28 وساعة عشوائية) لا يكاد يصيب لحظة التبديل، فبقي
  // حذف المرور الثاني ناجيًا من FZ-07. هذه الحالات مثبّتة بالقياس لا بالتخمين.
  // في أفريقيا/القاهرة يبدأ التوقيت الصيفي 2026-04-24 عند منتصف الليل: الساعة
  // 00:30 **غير موجودة** محليًا. المرور الثاني يحلّها إلى 01:30 من اليوم المدني
  // نفسه، وبلا مرور ثانٍ تُرفض (null). الفارق مقاس ومثبت هنا.
  const gap = zonedWallTimeToIso({ year: 2026, month: 4, day: 24 }, 0, 30, 'Africa/Cairo');
  assert.equal(gap, '2026-04-23T22:30:00.000Z', 'المرور الثاني يحلّ الساعة غير الموجودة');
  const localHour = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(gap));
  assert.equal(localHour, '01:30', 'الحل يُزيح الساعة للأمام ولا ينزلق لليوم السابق');

  // الحد نفسه في سنة أخرى — لا يعتمد على سنة واحدة.
  assert.equal(
    zonedWallTimeToIso({ year: 2025, month: 4, day: 25 }, 0, 30, 'Africa/Cairo'),
    '2025-04-24T22:30:00.000Z'
  );

  // نهاية التوقيت الصيفي: 2026-10-30 تعود الساعة للخلف، و23:30 من اليوم السابق
  // يجب أن تبقى في يومها المدني لا أن تنزلق.
  const back = zonedWallTimeToIso({ year: 2026, month: 10, day: 29 }, 23, 30, 'Africa/Cairo');
  assert.ok(back, 'ليلة العودة تُحل ولا تُرفض');
  const backDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(back));
  assert.equal(backDay, '2026-10-29');

  // ويوم عادي بعيد عن التبديل: الساعة تُحفظ حرفيًا (لا إزاحة خفية).
  const normal = zonedWallTimeToIso({ year: 2026, month: 6, day: 15 }, 14, 45, 'Africa/Cairo');
  assert.equal(normal, '2026-06-15T11:45:00.000Z');
});
