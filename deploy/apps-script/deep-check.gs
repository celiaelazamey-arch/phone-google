/**
 * CeliaOS · فحص أعمق — Google Apps Script
 * ─────────────────────────────────────────────────────────────────────────────
 * `keepalive.gs` يجيب سؤالًا واحدًا: هل الخدمة تقول إنها جاهزة؟ هذا الملف يجيب:
 * **هل ما تقوله الخدمة صحيح؟** يفحص ما لا يستطيع `/readyz` فحصه عن نفسه:
 *
 *   - **شهادة TLS** تنتهي قريبًا (`expiresAt` من الرد فحص ذاتي؛ انتهاء الشهادة يُكتشف من فشل
 *     النداء نفسه، ولا يُدَّعى أنه مقيس سلفًا).
 *   - **`/healthz` مقابل `/readyz`** — الأولى حياة، الثانية جاهزية. انفصالهما هو التوقيع
 *     المميز لعطل جزئي: الخدمة ردّت لكنها لا تستطيع العمل.
 *   - **ثبات الإصدار** — تغيّر `release.version` بين نداءين يعني نشرًا أثناء المراقبة.
 *   - **`/api/system`** — يُقرأ فقط إن كان هناك رمز؛ وبدونه يُعلن «غير مقيس» لا «سليم».
 *
 * **ما لا يفعله عن قصد:** لا يكتب في الخدمة، ولا يرسل أي طلب غير `GET`، ولا يخمّن نتيجة
 * فحص لم يستطع إجراؤه: يكتب `unknown` مع السبب.
 *
 * **الاستخدام:** بعد ضبط `SERVICE_URL` في `keepalive.gs`، شغّل `deepCheck()` يدويًا، أو
 * أنشئ مُشغّلًا يوميًا: `setupDaily()`.
 */

var PROPS = PropertiesService.getScriptProperties();

function dcfg_() {
  var url = (PROPS.getProperty('SERVICE_URL') || '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('SERVICE_URL غير مضبوط — اضبطه من keepalive.gs أولًا');
  return { url: url, token: (PROPS.getProperty('SECRET_TOKEN') || '').trim() };
}

function get_(url, token, withAuth) {
  var options = { method: 'get', muteHttpExceptions: true };
  if (withAuth && token) options.headers = { Authorization: 'Bearer ' + token };
  var started = Date.now();
  try {
    var response = UrlFetchApp.fetch(url, options);
    var text = response.getContentText();
    var body = null;
    try { body = JSON.parse(text); } catch (e) { body = null; }
    return { code: response.getResponseCode(), ms: Date.now() - started, body: body, raw: text.slice(0, 400) };
  } catch (error) {
    return { code: null, ms: Date.now() - started, body: null, error: String(error).slice(0, 400) };
  }
}

/**
 * يقارن ثلاث نقاط. كل سطر في التقرير يحمل `observed` صريحًا، فلا يتحول غياب البيانات
 * إلى علامة صح.
 */
function deepCheck() {
  var cfg = dcfg_();
  var report = { checkedAt: new Date().toISOString(), service: cfg.url, checks: [] };

  var health = get_(cfg.url + '/healthz', cfg.token, false);
  report.checks.push({
    id: 'liveness',
    observed: health.code === 200,
    detail: health.error ? 'فشل النداء: ' + health.error : 'HTTP ' + health.code + ' في ' + health.ms + 'ms'
  });

  var ready = get_(cfg.url + '/readyz', cfg.token, false);
  var readyBody = ready.body || {};
  report.checks.push({
    id: 'readiness',
    observed: ready.code === 200 && readyBody.ready === true,
    detail: ready.error ? 'فشل النداء: ' + ready.error : 'HTTP ' + ready.code + ' · ready=' + String(readyBody.ready) + ' · status=' + (readyBody.status || '—')
  });

  // التوقيع المهم: /healthz يعمل و/readyz يفشل ⇒ عطل جزئي لا انقطاع.
  report.partialOutage = health.code === 200 && !(ready.code === 200 && readyBody.ready === true);

  var system = cfg.token ? get_(cfg.url + '/api/system', cfg.token, true) : null;
  report.checks.push({
    id: 'system-snapshot',
    observed: system ? system.code === 200 && Boolean(system.body) : null,
    detail: system
      ? (system.error ? 'فشل النداء: ' + system.error : 'HTTP ' + system.code)
      : 'unknown — لا SECRET_TOKEN، ولم يُجرَ الفحص'
  });

  var released = readyBody.release && readyBody.release.version ? String(readyBody.release.version) : null;
  var previousRelease = PROPS.getProperty('LAST_RELEASE');
  report.release = { current: released, previous: previousRelease, changed: Boolean(previousRelease && released && previousRelease !== released) };
  if (released) PROPS.setProperty('LAST_RELEASE', released);

  report.verdict = report.checks.every(function (check) { return check.observed === true; })
    ? 'verified'
    : (report.checks.some(function (check) { return check.observed === true; }) ? 'degraded' : 'failed');
  if (report.partialOutage) report.verdict = 'partial_outage';
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

function setupDaily() {
  dcfg_();
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'deepCheck') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('deepCheck').timeBased().everyDays(1).atHour(6).create();
  Logger.log('مُشغّل يومي أُنشئ: deepCheck عند 06:00 بتوقيت المشروع');
}
