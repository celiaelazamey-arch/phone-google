/**
 * SEC-007 — حدّ دخل حتمي على سطح Express.
 *
 * محدّد الحافة موجود في `workers/celia-edge/accounts.js` (8 محاولات / 15 دقيقة) ويحمي مسارات
 * الحساب هناك فقط. هذا الملف يغطي الأسطح التي بقيت بلا حدّ: بدء/عودة OAuth، وwebhook واتساب،
 * ومحاولات الرمز الفاشلة على `/api` و`/mcp`.
 *
 * ثلاث خصائص تجعله بوابة لا زينة:
 *   1. **حتمي:** ساعة واحدة تُحقن، نوافذ ثابتة، بلا مؤقّتات ولا قراءة لساعة الحائط في الاختبار.
 *   2. **محدود الذاكرة:** خريطة المفاتيح لا تتجاوز `maxKeys`؛ تُنظَّف الدلاء المنتهية أولًا ثم
 *      يُحذف الأقدم بترتيب الإدراج — سلوك ثابت قابل للتكرار.
 *   3. **بلا أثر:** الطلب المرفوض يعود `429` قبل أي معالج، فلا تُنفَّذ كتابة ولا استدعاء خارجي.
 *
 * لا تبعية جديدة، ولا دوام، ولا مصدر حقيقة ثانٍ: العدّادات في ذاكرة العملية. إعادة التشغيل تنسى
 * العدّاد، وتعدّد النسخ يعدّ لكل نسخة — وهذا معلن هنا وفي `docs/security-posture.md` بدل ادعاء العكس.
 */
import crypto from 'node:crypto';

export const RATE_LIMIT_DEFAULTS = Object.freeze({
  enabled: true,
  windowMs: 60_000,
  apiFailures: 20,
  auth: 20,
  webhook: 300,
  mcpFailures: 20,
  maxKeys: 5_000
});

const ON = new Set(['on', 'true', '1', 'yes', 'enabled']);
const OFF = new Set(['off', 'false', '0', 'no', 'disabled']);

/**
 * يقرأ `CELIA_RATE_LIMIT*` من البيئة. القيمة غير الصالحة **ترفض الإقلاع** بدل الارتداد الصامت
 * إلى الافتراضي: إعداد أمان مكتوب خطأً يجب أن يُرى لا أن يُتجاهل.
 */
export function loadRateLimitConfig(env = process.env) {
  const toggle = String(env?.CELIA_RATE_LIMIT ?? '').trim().toLowerCase();
  let enabled = RATE_LIMIT_DEFAULTS.enabled;
  if (toggle) {
    if (ON.has(toggle)) enabled = true;
    else if (OFF.has(toggle)) enabled = false;
    else throw new Error('CELIA_RATE_LIMIT must be on or off');
  }
  const integer = (name, fallback) => {
    const raw = String(env?.[name] ?? '').trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const windowMs = integer('CELIA_RATE_LIMIT_WINDOW_MS', RATE_LIMIT_DEFAULTS.windowMs);
  if (windowMs < 1_000) throw new Error('CELIA_RATE_LIMIT_WINDOW_MS must be at least 1000');
  return Object.freeze({
    enabled,
    windowMs,
    apiFailures: integer('CELIA_RATE_LIMIT_API_FAILURES', RATE_LIMIT_DEFAULTS.apiFailures),
    auth: integer('CELIA_RATE_LIMIT_AUTH', RATE_LIMIT_DEFAULTS.auth),
    webhook: integer('CELIA_RATE_LIMIT_WEBHOOK', RATE_LIMIT_DEFAULTS.webhook),
    mcpFailures: integer('CELIA_RATE_LIMIT_MCP_FAILURES', RATE_LIMIT_DEFAULTS.mcpFailures),
    maxKeys: integer('CELIA_RATE_LIMIT_MAX_KEYS', RATE_LIMIT_DEFAULTS.maxKeys)
  });
}

/**
 * عدّاد نوافذ ثابتة. `take` يستهلك، و`peek` يقرأ بلا استهلاك (كي يُرفض الطلب الزائد قبل أن
 * يُحتسب، فلا تطول النافذة باستمرار المحاولات).
 */
export function createRateLimiter({ limit, windowMs, now = Date.now, maxKeys = RATE_LIMIT_DEFAULTS.maxKeys } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  if (!Number.isInteger(windowMs) || windowMs < 1) throw new Error('windowMs must be a positive integer');
  if (!Number.isInteger(maxKeys) || maxKeys < 1) throw new Error('maxKeys must be a positive integer');
  const buckets = new Map();

  const pruneExpired = (at) => {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= at) buckets.delete(key);
    }
  };

  const makeRoom = (at) => {
    if (buckets.size < maxKeys) return;
    pruneExpired(at);
    while (buckets.size >= maxKeys) {
      const oldest = buckets.keys().next();
      if (oldest.done) return;
      buckets.delete(oldest.value);
    }
  };

  const peek = (key) => {
    const bucket = buckets.get(key);
    if (!bucket) return { count: 0, resetAt: null, retryAfterMs: 0 };
    const at = now();
    if (bucket.resetAt <= at) return { count: 0, resetAt: null, retryAfterMs: 0 };
    return { count: bucket.count, resetAt: bucket.resetAt, retryAfterMs: Math.max(0, bucket.resetAt - at) };
  };

  const take = (key, cost = 1) => {
    const at = now();
    if (!buckets.has(key)) makeRoom(at);
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= at) {
      const fresh = { count: cost, resetAt: at + windowMs };
      buckets.set(key, fresh);
      return {
        allowed: cost <= limit,
        count: fresh.count,
        remaining: Math.max(0, limit - cost),
        resetAt: fresh.resetAt,
        retryAfterMs: cost <= limit ? 0 : windowMs
      };
    }
    if (bucket.count + cost > limit) {
      return {
        allowed: false,
        count: bucket.count,
        remaining: 0,
        resetAt: bucket.resetAt,
        retryAfterMs: Math.max(0, bucket.resetAt - at)
      };
    }
    bucket.count += cost;
    return {
      allowed: true,
      count: bucket.count,
      remaining: limit - bucket.count,
      resetAt: bucket.resetAt,
      retryAfterMs: Math.max(0, bucket.resetAt - at)
    };
  };

  return {
    limit,
    windowMs,
    maxKeys,
    now,
    peek,
    take,
    reset: (key) => buckets.delete(key),
    clear: () => buckets.clear(),
    size: () => buckets.size
  };
}

/**
 * مفتاح العميل: بصمة SHA-256 مقتطعة لعنوان الشبكة، فلا يُحتَفظ بالعنوان الخام في الذاكرة ولا في
 * أي سجل. العنوان نفسه يأتي من `req.ip` الذي يحترم ضبط `trust proxy` في التطبيق.
 */
export function clientKey(req) {
  const address = String(req?.ip || req?.socket?.remoteAddress || 'unknown');
  return crypto.createHash('sha256').update(address).digest('hex').slice(0, 16);
}

/**
 * وسيط Express. وضعان:
 *   - `countFailuresOnly: false` (الافتراضي): كل طلب يستهلك وحدة، ويُرفض الزائد بـ429 فورًا.
 *   - `countFailuresOnly: true`: الطلبات الناجحة لا تستهلك شيئًا؛ تُحتسب الردود الفاشلة فقط
 *     (افتراضيًا `401`) بعد انتهاء الاستجابة، ويُرفض الطلب التالي بـ429 قبل أن يصل إلى أي معالج.
 */
export function createRateLimit({
  limiter,
  scope = 'default',
  keyOf = clientKey,
  countFailuresOnly = false,
  failureStatuses = [401]
} = {}) {
  if (!limiter || typeof limiter.peek !== 'function' || typeof limiter.take !== 'function') {
    throw new Error('createRateLimit requires a limiter');
  }
  const failures = new Set(failureStatuses);

  const decorate = (res, decision) => {
    const retryAfterSeconds = Math.max(1, Math.ceil((decision.retryAfterMs || 0) / 1000));
    res.set('RateLimit-Limit', String(limiter.limit));
    res.set('RateLimit-Remaining', String(decision.remaining ?? 0));
    res.set('RateLimit-Reset', String(retryAfterSeconds));
    return retryAfterSeconds;
  };

  const reject = (res, decision) => {
    const retryAfterSeconds = decorate(res, decision);
    res.set('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'rate_limited', retryAfterSeconds });
  };

  return function rateLimit(req, res, next) {
    const key = `${scope}:${keyOf(req)}`;
    const current = limiter.peek(key);
    if (current.count >= limiter.limit) return reject(res, current);

    if (countFailuresOnly) {
      res.on('finish', () => {
        if (failures.has(res.statusCode)) limiter.take(key);
      });
      return next();
    }

    const decision = limiter.take(key);
    if (!decision.allowed) return reject(res, decision);
    decorate(res, decision);
    return next();
  };
}

/**
 * يركّب الحدود القياسية على تطبيق: حدود صارمة على أسطح المصادقة العامة، وسقف فشل على واجهات
 * الرمز. المسارات الصحية (`/health`، `/healthz`، `/readyz`، `/version`) لا تُحدّ: مراقب الحيوية
 * ليس مهاجمًا، وحجبه يجعل النظام يبدو معطّلًا للمراقبة.
 */
export function mountRateLimits(app, config = {}, { apiPrefixes = ['/api'], authPrefixes = ['/auth'], webhookPrefixes = ['/webhooks/whatsapp'] } = {}) {
  const limits = config.rateLimit || loadRateLimitConfig({});
  if (!limits.enabled) return { enabled: false, limiters: {} };
  const limiters = {
    api: createRateLimiter({ limit: limits.apiFailures, windowMs: limits.windowMs, maxKeys: limits.maxKeys }),
    auth: createRateLimiter({ limit: limits.auth, windowMs: limits.windowMs, maxKeys: limits.maxKeys }),
    webhook: createRateLimiter({ limit: limits.webhook, windowMs: limits.windowMs, maxKeys: limits.maxKeys })
  };
  for (const prefix of apiPrefixes) {
    app.use(prefix, createRateLimit({ limiter: limiters.api, scope: 'api', countFailuresOnly: true, failureStatuses: [401] }));
  }
  for (const prefix of authPrefixes) {
    app.use(prefix, createRateLimit({ limiter: limiters.auth, scope: 'auth' }));
  }
  for (const prefix of webhookPrefixes) {
    app.use(prefix, createRateLimit({ limiter: limiters.webhook, scope: 'webhook' }));
  }
  app.locals.rateLimiters = limiters;
  return { enabled: true, limiters };
}
