/**
 * CeliaOS · مرحّل حالة Google — Google Apps Script
 * ─────────────────────────────────────────────────────────────────────────────
 * لماذا هذا الملف: خدمات النظام تعتمد على Google (OAuth · Calendar · Drive). عندما تتعطّل
 * خدمة Google، يفشل نظامنا ويبدو **عطلًا في كودنا**، فيضيع وقت في تشخيص ليس عندنا.
 * هذا المرحّل يقرأ **لوحة حالة Google الرسمية** نفسها التي تُلصق يدويًا في المحادثات، ويحوّلها
 * إلى فحص آلي يُنبّه عند تدهور خدمة نعتمد عليها.
 *
 * **ما يقرأه:** ‏`incidents.json` الرسمي (مذكور في تذييل اللوحة نفسها) — فلا تفسير نثري ولا
 * استخراج هشّ من HTML.
 *
 * **قرار مهم:** لا يُبلَّغ عن عطل في خدمة لا نستخدمها. القائمة أدناه هي ما يعتمد عليه الكود
 * فعلًا (OAuth/Calendar/Drive/Sheets/Gmail)، وتُضبط في `RELAY_SERVICES`.
 *
 * **ما لا يقوله:** «Google سليمة» لا تعني «نظامنا سليم». هذا فحص اعتماد خارجي فقط، ويُسجَّل
 * بهذا الاسم في التقرير.
 *
 * **إعداد:** افتح <https://script.google.com/home/all> ← New project ← الصق ← اضبط
 * `ALERT_EMAIL` ثم شغّل `setupRelay()`.
 */

var PROPS = PropertiesService.getScriptProperties();
var STATUS_URL = 'https://www.google.com/appsstatus/dashboard/incidents.json';

/** الخدمات التي نعتمد عليها فعلًا — تُطابَق بحقل `service_name` في الرد. */
var DEFAULT_SERVICES = ['Google Calendar', 'Google Drive', 'Gmail', 'Google Sheets', 'Google OAuth 2.0 / OpenID Connect'];

function services_() {
  var configured = (PROPS.getProperty('RELAY_SERVICES') || '').trim();
  if (!configured) return DEFAULT_SERVICES;
  return configured.split(',').map(function (name) { return name.trim(); }).filter(Boolean);
}

/**
 * المفتاح هو `service_name` + الحالة. لا تعتمد على ترتيب غير مضمون في مصدر خارجي.
 */
function fetchIncidents_() {
  var response = UrlFetchApp.fetch(STATUS_URL, { method: 'get', muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    // لا حكم عند فشل القراءة نفسه: «غير مقيس» ليست «سليم».
    return { ok: false, reason: 'HTTP ' + response.getResponseCode(), incidents: [] };
  }
  var parsed;
  try {
    parsed = JSON.parse(response.getContentText());
  } catch (error) {
    return { ok: false, reason: 'رد غير صالح كـJSON', incidents: [] };
  }
  // الشكل العام مصفوفة من الكيانات، كل كيان فيه incidents. ندعم الشكلين بلا افتراض.
  var list = Array.isArray(parsed) ? parsed : (parsed.incidents || []);
  var flat = [];
  list.forEach(function (entry) {
    var incidents = entry.incidents || [entry];
    incidents.forEach(function (incident) {
      var name = incident.service_name || entry.service_name || null;
      if (!name) return;
      flat.push({
        service: String(name),
        status: String(incident.status_impact || incident.status || 'unknown'),
        begin: incident.begin || null,
        end: incident.end || null,
        // incident_id غير مضمون؛ نستخدمه إن وُجد فقط لتفادي تكرار نفس التنبيه.
        id: incident.incident_id || null
      });
    });
  });
  return { ok: true, incidents: flat };
}

function watchedState_(incidents) {
  var services = services_();
  var active = incidents.filter(function (incident) {
    var matches = services.some(function (name) { return incident.service.indexOf(name) !== -1; });
    var open = !incident.end || incident.status === 'SERVICE_DISRUPTION' || incident.status === 'SERVICE_OUTAGE';
    return matches && open;
  });
  return {
    active: active,
    // بصمة تُغيّر التنبيه فقط عند تغيّر الخدمات المتأثرة أو نوع الأثر.
    fingerprint: active.map(function (i) { return i.service + ':' + i.status; }).sort().join('|') || 'clear'
  };
}

/** يُستدعى من المُشغّل. يقرأ، يقارن، ينبّه عند التغيّر، ويسجّل. */
function relayCheck() {
  var email = (PROPS.getProperty('ALERT_EMAIL') || '').trim();
  var fetched = fetchIncidents_();
  if (!fetched.ok) {
    Logger.log('تعذّرت قراءة لوحة الحالة: ' + fetched.reason + ' — لا حكم، ولا تنبيه كاذب');
    return { measured: false, reason: fetched.reason };
  }
  var state = watchedState_(fetched.incidents);
  var previous = PROPS.getProperty('RELAY_LAST') || '';
  var changed = previous !== state.fingerprint;
  PROPS.setProperty('RELAY_LAST', state.fingerprint);

  if (changed && email) {
    var subject = state.fingerprint === 'clear'
      ? 'Google: لا عطل نشط في الخدمات التي نعتمد عليها'
      : 'Google: تدهور في ' + state.active.length + ' خدمة نعتمد عليها';
    var body = state.active.length
      ? state.active.map(function (i) { return '- ' + i.service + ' · ' + i.status + ' · بدأ ' + (i.begin || '—'); }).join('\n')
      : 'زالت الأعطال النشطة عن الخدمات المرصودة.';
    MailApp.sendEmail(email, subject, body + '\n\nالمصدر: ' + STATUS_URL + '\nالوقت (UTC): ' + new Date().toISOString() + '\n\n— هذه حالة مزوّد خارجي، وليست حكمًا على نظامنا.');
  }
  var summary = 'relay: ' + state.fingerprint + (changed ? ' · تغيّرت الحالة' : ' · بلا تغيير');
  Logger.log(summary);
  return { measured: true, changed: changed, state: state, summary: summary };
}

function setupRelay() {
  var url = (PROPS.getProperty('SERVICE_URL') || '').trim();
  if (!url) Logger.log('تنبيه: SERVICE_URL غير مضبوط — هذا المرحّل لا يحتاجه، لكن بقية السكربتات تحتاجه');
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'relayCheck') ScriptApp.deleteTrigger(trigger);
  });
  // كل ساعة: الأعطال تُقاس بالدقائق، ولا داعي لنداء كل 10 دقائق يستهلك الحصة.
  ScriptApp.newTrigger('relayCheck').timeBased().everyHours(1).create();
  Logger.log('مُشغّل مرحّل الحالة أُنشئ: relayCheck كل ساعة');
}
