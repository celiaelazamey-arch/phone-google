# سجل جلسة 2026-10-27 — دورة «خطّط، اعرض، انتظر، ثم نفّذ» ومعمارية Agent Harness وتشخيص Chromium

- **التاريخ:** 2026-10-27 (مساءً).
- **الفرع النشط:** `arena/5fccc4e6-phone-google` (منطلق من `ba3e51fa45b02cfe21315bcd752a9ca2158a6249` على `main`).
- **المهام المرتبطة:** AGENT-001، AGENT-002، SEC-001، QA-003، DEC-019.

## 1. ملخص ما طُلب وما نُفِّذ

طُلب تثبيت ثلاث ركائز هندسية في CeliaOS:
1. **دورة العمل الحاكمة («خطّط، اعرض، انتظر، ثم نفّذ»):**
   - الانتقالات الصريحة: `PLAN_READY → WAITING_FOR_APPROVAL → APPROVED → EXECUTING`، مع مسار التعديل
     `PLAN_READY → WAITING_FOR_APPROVAL → EDITED → WAITING_FOR_APPROVAL` ومسار الرفض
     `PLAN_READY → WAITING_FOR_APPROVAL → REJECTED`.
   - عند التعديل (`editPlan` أو `decision: 'edited'`) يُحفظ التعديل، ويُعاد التحقق من السياسات ومخطط مدخلات الأداة
     (`validatePlanEditPolicy`)، ويُوسم طلب الموافقة السابق بـ`edited`، ويُنشأ طلب موافقة جديد `pending` مربوط ببصمة
     الحمولة المعدّلة، وتُحدَّث نية الـoutbox المعلّقة، ويُسجَّل مدخل `plan_edited` في سلسلة الأدلة، ويبقى التشغيل في
     `waiting_approval` دون أي استدعاء خارجي حتى يعتمد المالك النسخة المعدّلة.
   - منع أي تغيير صامت للخطوات الحساسة بعد الموافقة عبر `verifyApprovedEffectIntegrity` وفحص `outbox_approval` في
     المُتحقِّق المستقل (`src/agent/verifier.js`).
2. **معمارية Agent Harness (10 مراحل و10 مكونات):**
   - وحدة `src/agent/harness.js` ونقطة `GET /api/agent/harness` لفحص المكونات العشرة ودورة التنفيذ العشرية.
   - اختبارات قاعة العمليات (`test/agent-harness.test.js`) لكسر الحلقة (التلاعب بالحمولة بعد الموافقة، انتهاك السياسة
     عند التعديل، إعادة الإرسال بنفس مفتاح التفرد، والرفض).
3. **تشخيص Playwright Chromium الصريح (`e2e/diagnostics.js` و`e2e/agent.spec.js`):**
   - التقاط `pageerror` و`console` (`error`) و`requestfailed` و`response >= 400` و`crash` قبل `page.goto(...)` مع
     إرفاق `chromium-diagnostics.txt` ولقطة `failure.png` عند الفشل، وتفعيل `screenshot: 'only-on-failure'` في
     `playwright.config.js`.
   - إصلاح المسارات النسبية في `public/agent.html` و`public/kb.html` و`scripts/build-pages.mjs` واعتراض المسارات في
     `scripts/static/celia-static-shim.template.js` وتباين ألوان زر `.primary` (6.92:1) والتجاوب عند عرض `320px`.
4. **القدرة الأصيلة `document_data_automation` (DEC-020):**
   - تنفيذ المرحلة الأولى (الفحص وبناء الخطة) ثم المرحلة الثانية بعد موافقة المالك (`موافق على تنفيذdocument_data_automation`).
   - إضافة `src/agent/automation/{schema,reader,extractor,validator,index}.js` وتسجيل الأدوات `document.read` و`document.extract`
     و`data.validate` و`data.report` و`document.commit_purchase_ledger` في `Tool Registry`، وربط فحوص
     `documentAutomationChecks` في `src/agent/verifier.js`، وإنشاء الحزمة المرجعية الذهبية في `test/fixtures/documents/`
     واختبارات الحالات الثماني الإلزامية في `test/agent-document-automation.test.js`.

## 2. نتائج الفحوص الفعلية

- `npm run build:pages`: ناجح (8 صفحات ثابتة في `dist/`).
- `npm run check`: ناجح.
- `npm run release:check`: ناجح (`0.2.1` / `schema: 1`).
- `npm run check:continuity`: ناجح.
- `npm run check:secrets`: ناجح.
- `npm test`: **258/258** اختبارًا ناجحًا.
- **الحدود المعلنة:** لا يوجد ثنائي متصفح Chromium مثبت محليًا داخل حاوية الساندبوكس؛ تُشغَّل `npm run test:browser`
  و`integration/mysql.integration.mjs` في GitHub Actions CI على الفرع.
