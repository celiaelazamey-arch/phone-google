/**
 * CeliaOS · مُبدِّل ومُراقب — Google Apps Script
 * ─────────────────────────────────────────────────────────────────────────────
 * يُغلِق ثلاثة أشياء كان النظام يدفعها أو يتذكّرها يدويًا:
 *
 *   1. **منع النوم** — نداء `GET <SERVICE_URL>/readyz` كل 10 دقائق، بديلًا عن cron-job.org
 *      (اعتماد خارجي بمفتاح API). الاعتماد هنا على حساب Google فقط.
 *   2. **مراقبة حقيقية** — ليس «نداء نجح/فشل» بل قراءة `ready` و`status` و`storage`؛ 503 يعني
 *      أن الخدمة حية لكنها **غير جاهزة**، وهذا يختلف عن انقطاعها.
 *   3. **تنبيه بلا مزوّد** — بريد إلى المالك عند تغيّر الحالة فقط، مع `PropertiesService` يمنع
 *      تكرار الرسالة كل 10 دقائق.
 *
 * لماذا Apps Script هنا ولا GitHub Actions: مهام Actions المجدولة **تتوقف في مستودع خامل
 * 60 يومًا** (موثّق في `deploy/free-always-on/README.md`)، وتحتاج دفعًا في الريبو. هذا الملف
 * لا يحتاج شيئًا من المستودع وقت التشغيل.
 *
 * **إعداد (خمس دقائق، مرة واحدة):**
 *   1. افتح <https://script.google.com/home/all> ← **New project** ← الصق هذا الملف.
 *   2. **Project Settings → Script properties** وأضف:
 *        SERVICE_URL  = https://<service>.onrender.com   (بلا / في النهاية)
 *        ALERT_EMAIL  =بريدك
 *        (اختياري) SECRET_TOKEN = نفس CELIA_MCP_API_TOKEN إن كانت الخدمة تتطلبه على /readyz
 *   3. شغّل `setup()` مرة واحدة ← يقبل الأذونات وينشئ المُشغّل كل 10 دقائق.
 *   4. شغّل `checkOnce()` ← سترى سجلًّا في **Executions** ونتيجة في `LAST_STATE`.
 *
 * **حدود يجب أن تُعرف (لا تُخفى):**
 *   - تنفيذ واحد ≤ 6 دقائق (لا يُبلَغ هنا؛ كل دورة ثوانٍ).
 *   - حساب مجاني: 90 دقيقة تشغيل/يوم · 20 000 نداء UrlFetch/يوم · **100 مستلم بريد/يوم**.
 *     دورتنا: 144 نداء/يوم ≈ 0.7% من الحد. ولا يُرسل بريد إلا عند تغيّر الحالة.
 *   - 20 مُشغّلًا كحد أقصى للمشروع؛ نستخدم واحدًا.
 *   - **الحد الذي يُبطل الثقة:** لو توقف حساب Google نفسه فلن يحدث النداء. لذلك يبقى هذا
 *     «منع نوم» لا «ضمان توفّر»، ولا يُستخدم في أي ادّعاء uptime.
 */

var PROPS = PropertiesService.getScriptProperties();
var STATE_KEY = 'LAST_STATE';
var FAIL_KEY = 'CONSECUTIVE_FAILURES';
var LAST_ALERT_KEY = 'LAST_ALERT_AT';

/** يُقرأ كل مرة: تغيير الرابط أو البريد لا يحتاج تعديل كود. */
function config_() {
  var url = (PROPS.getProperty('SERVICE_URL') || '').trim().replace(/\/+$/, '');
  var email = (PROPS.getProperty('ALERT_EMAIL') || '').trim();
  if (!url) throw new Error('SERVICE_URL غير مضبوط في Script properties');
  if (!/^https:\/\//.test(url)) throw new Error('SERVICE_URL يجب أن يبدأ بـhttps://');
  return { url: url, email: email, token: (PROPS.getProperty('SECRET_TOKEN') || '').trim() };
}

/**
 * نداء واحد. لا يرمي عند فشل الشبكة: يُعيد نتيجة مسمّاة، لأن المُشغّل يحتاج أن يقرّر
 * التنبيه بدل أن يُسجّل استثناءً غير مفهوم في سجل التنفيذ.
 */
function probe_(cfg) {
  var started = Date.now();
  try {
    var options = { method: 'get', muteHttpExceptions: true, followRedirects: true };
    if (cfg.token) options.headers = { Authorization: 'Bearer ' + cfg.token };
    var response = UrlFetchApp.fetch(cfg.url + '/readyz', options);
    var code = response.getResponseCode();
    var payload = null;
    try { payload = JSON.parse(response.getContentText()); } catch (e) { payload = null; }
    return {
      ok: code === 200 && payload && payload.ready === true,
      code: code,
      ms: Date.now() - started,
      ready: payload ? payload.ready === true : null,
      status: payload && payload.status ? String(payload.status) : null,
      storage: payload && payload.storage ? String(payload.storage) : null,
      release: payload && payload.release && payload.release.version ? String(payload.release.version) : null,
      // 503 هنا ليس عطلًا شبكيًا: الخدمة أجابت وقالت إنها غير جاهزة. التفريق مقصود.
      kind: code === 200 ? (payload && payload.ready === true ? 'ready' : 'not_ready') : (code === 503 ? 'not_ready' : 'http_' + code)
    };
  } catch (error) {
    return {
      ok: false, code: null, ms: Date.now() - started, ready: null,
      status: null, storage: null, release: null,
      kind: /timeout|timed out/i.test(String(error)) ? 'timeout' : 'network_error'
    };
  }
}

function fingerprint_(result) {
  return [result.kind, result.code, result.status, result.storage].join('|');
}

/** التنبيه فقط عند تغيّر الحالة أو عند تجاوز عتبة فشل متتالٍ. لا بريد كل 10 دقائق. */
function shouldAlert_(previous, current, failures) {
  if (!previous) return !current.ok;
  if (fingerprint_(previous) !== fingerprint_(current)) return true;
  return !current.ok && failures === 3;
}

function alert_(cfg, current, previous, failures) {
  if (!cfg.email) return false;
  var subject = current.ok
    ? 'CeliaOS عادت جاهزة'
    : 'CeliaOS ' + (current.kind === 'not_ready' ? 'غير جاهزة' : 'لا تستجيب') + ' (' + (current.code || current.kind) + ')';
  var lines = [
    'الحالة: ' + current.kind,
    'HTTP: ' + (current.code === null ? 'لا رد' : current.code),
    'ready: ' + String(current.ready),
    'status: ' + (current.status || '—'),
    'storage: ' + (current.storage || '—'),
    'release: ' + (current.release || '—'),
    'زمن الرد: ' + current.ms + 'ms',
    'فشل متتالٍ: ' + failures,
    'السابق: ' + (previous ? fingerprint_(previous) : '—'),
    '',
    'الخدمة: ' + cfg.url,
    'الوقت (UTC): ' + new Date().toISOString(),
    '',
    '— أُرسل من Apps Script. هذا تنبيه حالة، وليس ادّعاء توفّر.'
  ];
  MailApp.sendEmail(cfg.email, subject, lines.join('\n'));
  PROPS.setProperty(LAST_ALERT_KEY, new Date().toISOString());
  return true;
}

/** الدورة الكاملة: قياس ← قرار ← تنبيه ← حفظ. تُستدعى من المُشغّل ومن الزر اليدوي. */
function checkOnce() {
  var cfg = config_();
  var current = probe_(cfg);
  var previousRaw = PROPS.getProperty(STATE_KEY);
  var previous = previousRaw ? JSON.parse(previousRaw) : null;
  var failures = Number(PROPS.getProperty(FAIL_KEY) || 0);
  failures = current.ok ? 0 : failures + 1;

  var alertEnabled = (PROPS.getProperty('ALERTS_ENABLED') || 'true') === 'true';
  var sent = (alertEnabled && shouldAlert_(previous, current, failures)) ? alert_(cfg, current, previous, failures) : false;

  PROPS.setProperty(STATE_KEY, JSON.stringify(current));
  PROPS.setProperty(FAIL_KEY, String(failures));
  var summary = current.kind + ' · ' + current.ms + 'ms' + (sent ? ' · أُرسل تنبيه' : '');
  Logger.log(summary);
  return { current: current, failures: failures, alerted: sent, summary: summary };
}

/** إنشاء المُشغّل. التشغيل المتكرر آمن: يحذف مُشغّلات هذا الدالة ثم ينشئ واحدًا. */
function setup() {
  config_(); // يفشل مبكرًا إن كانت الخاصيات ناقصة
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'checkOnce') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('checkOnce').timeBased().everyMinutes(10).create();
  Logger.log('المُشغّل أُنشئ: checkOnce كل 10 دقائق');
}

/** إزالة كل شيء — لا يبقى مُشغّل يستهلك حصة بعد التوقف عن استخدام النظام. */
function teardown() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
  Logger.log('حُذفت كل المُشغّلات');
}

/** تشخيص سريع: ما هو المضبوط فعلًا (بلا طباعة الرمز). */
function diagnose() {
  var cfg = config_();
  var current = probe_(cfg);
  var report = {
    url: cfg.url,
    emailConfigured: Boolean(cfg.email),
    tokenConfigured: Boolean(cfg.token),
    alertsEnabled: (PROPS.getProperty('ALERTS_ENABLED') || 'true') === 'true',
    triggers: ScriptApp.getProjectTriggers().length,
    lastState: PROPS.getProperty(STATE_KEY),
    consecutiveFailures: Number(PROPS.getProperty(FAIL_KEY) || 0),
    lastAlertAt: PROPS.getProperty(LAST_ALERT_KEY),
    current: current,
    // الحصة تُترك لـGoogle: لا نخمّن رقمًا لم نقسه.
    quotaNote: 'راجع Trigger runtime (90 دقيقة/يوم) وEmail recipients (100/يوم) على حسابك المجاني'
  };
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}
