(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const button = $('run-checks');
  const exporter = $('export-report');
  let report = null;
  let running = false;
  let stale = false;
  const text = (tag, value, className) => {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    return node;
  };
  function card(title, state, detail, level = 'unknown') {
    const item = document.createElement('article');
    item.className = 'check-card';
    const header = document.createElement('div');
    header.className = 'check-top';
    header.append(text('h3', title), text('span', state, `check-state ${level}`));
    item.append(header, text('p', detail));
    return item;
  }
  function setLinks(ref = 'main') {
    const safe = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref) && !ref.includes('..') ? ref : 'main';
    const repo = 'https://github.com/celiaelazamey-arch/phone-google';
    const tree = safe === 'main' ? repo : `${repo}/tree/${safe}`;
    const deploy = `https://render.com/deploy?repo=${encodeURIComponent(tree)}`;
    $('deploy-link').href = deploy;
    $('steps-deploy-link').href = deploy;
    $('runbook-link').href = `${repo}/blob/${safe}/docs/free-hosting.md`;
  }
  function render(data) {
    const isServer = data.scope === 'server';
    const storage = data.storage || {};
    const durable = isServer && storage.durable && storage.available;
    const providers = data.providers || [];
    const connected = (id) => providers.some((p) => p.id === id && p.connected);
    $('version').textContent = data.release?.version ? `v${data.release.version}` : 'إصدار غير متحقق';
    $('commit').textContent = data.release?.commit?.slice(0, 12) || 'لم يقدّم المصدر commit';
    $('environment-label').textContent = !isServer ? 'واجهة ثابتة / تجربة متصفح، لا خادم إنتاج.' : data.publicUrl ? 'رابط مقدّم من المضيف؛ لم يُفحص خارجيًا بعد.' : 'معاينة تشغيل فقط — النشر الدائم غير متحقق.';
    setLinks(data.sourceRef);
    const grid = $('checks-grid');
    grid.replaceChildren(
      card('نواة التشغيل', isServer && data.coreReady ? 'تستجيب' : isServer ? 'غير جاهزة' : 'متصفح فقط', isServer ? 'تمت قراءة الحالة من الخادم الحالي، لا من تقرير محفوظ.' : 'الواجهة تعمل، لكن لا يُثبت هذا وجود خادم أو Webhook.', isServer && data.coreReady ? '' : 'warning'),
      card('حفظ البيانات', durable ? 'MySQL متاحة' : 'غير دائم / غير متاح', durable ? 'الاتصال متاح وفق فحص الخادم. النسخ والاستعادة تحتاج اختبارًا مستقلًا.' : 'لا تعتمد هذه البيئة لحفظ بيانات العملاء. لا نبدل MySQL بذاكرة فارغة.', durable ? '' : 'warning'),
      card('واجهات Google وWhatsApp', data.fullApiMounted ? 'المسارات مفعلة' : 'غير مفعلة', 'تفعيل المسارات لا يعني ربط الحسابات أو نجاح إرسال حقيقي.', data.fullApiMounted ? '' : 'unknown'),
      card('Google', connected('google') ? 'نجح استخدام فعلي' : 'غير متحقق', 'OAuth يحتاج حسابك وموافقته. لا نختبر الحساب أو نقرأ ملفاتك بهذا الزر.', connected('google') ? '' : 'unknown'),
      card('WhatsApp', connected('whatsapp') ? 'نجح استخدام فعلي' : 'غير متحقق', 'يلزم إعداد Meta والتحقق والموافقة ونافذة الخدمة؛ لا إرسال تجريبي إلى أشخاص.', connected('whatsapp') ? '' : 'unknown'),
      card('عقد قاعدة البيانات', 'معلن، لا مُدقّق هنا', `schema=${data.release?.database?.schema ?? 'غير متحقق'}؛ هذا التقرير لا يكشف تركيب قاعدة عُدلت يدويًا ولا يثبت نجاح restore.`, 'unknown')
    );
    $('readiness-notice').textContent = data.allCapabilitiesVerified
      ? 'توجد دلائل استخدام في هذه العملية، لكن النشر الخارجي ونسخ البيانات والاستعادة تحتاج قبولًا مستقلًا؛ ليست شهادة جاهزية إنتاج.'
      : 'لا يمكن اعتماد «التشغيل بكامل القدرات» بعد. البنود غير المتحققة أعلاه تبقى مفتوحة، حتى لو عملت الواجهة بنجاح.';
    $('checked-at').textContent = `آخر فحص: ${new Date().toLocaleTimeString('ar-EG')} — للقراءة فقط`;
  }
  async function check() {
    if (running) return;
    running = true;
    button.disabled = true;
    button.textContent = 'جارٍ الفحص…';
    try {
      const response = await fetch('./api/deployment', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error('status_unavailable');
      const data = await response.json();
      if (!['server', 'browser'].includes(data.scope)) throw new Error('invalid_report');
      report = data;
      stale = false;
      render(data);
      exporter.disabled = false;
    } catch {
      stale = Boolean(report);
      $('environment-label').textContent = 'تعذر التحقق من الخادم؛ لا نفترض نجاح التشغيل.';
      $('readiness-notice').textContent = report ? 'تعذر تحديث الفحص. آخر تقرير أدناه قديم، وليس نتيجة حية؛ لا تعتمد عليه للنشر.' : 'تعذر تحميل التقرير. لم يُسجل نجاح ولم تُنفذ أي عملية خارجية.';
      $('checked-at').textContent = report ? 'النتائج المعروضة قديمة — أعد المحاولة' : 'الفحص غير مكتمل';
    } finally {
      running = false;
      button.disabled = false;
      button.textContent = 'أعد الفحص الآمن';
    }
  }
  button.addEventListener('click', check);
  exporter.addEventListener('click', () => {
    if (!report) return;
    const blob = new Blob([JSON.stringify({ ...report, exportedAt: new Date().toISOString(), stale, purpose: 'sanitized-read-only-report-not-production-approval' }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `celia-deployment-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  check();
})();
