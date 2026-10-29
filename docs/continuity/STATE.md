# الحالة الحالية — ابدأ من هنا

> **حفظ التاريخ بلا حذف (`DEC-052` / `CONT-004`):** هذه نافذة الاستئناف النشطة؛ السجل التراكمي الكامل حتى ما بعد PR #84 (`main@738d832` / `9f6f8b2` — 983 سطرًا / 142,150 بايت) محفوظ حرفيًا في **[STATE-ARCHIVE-2026-10.md](STATE-ARCHIVE-2026-10.md)** وبصمته محروسة بـ`R0-02`. القراءة السريعة المشتقة: **[NOW.md](NOW.md)** (`npm run now`).

**آخر مراجعة:** 29 أكتوبر 2026 · **نوع الجلسة الحالية:** **MANUS-B4 — رفع artifact مبصوم إلى Drive المالك خلف الموافقة (S4/M-B)**: `google.drive_export_report` يقبل `{ artifactId }` بديلًا للنص حين يكون مخزن B2 موصولًا، والبايتات تُقرأ عبر `artifacts.readForUpload` الذي **يعيد حساب SHA-256 في كل قراءة**، والموصل يستلم `resolveArtifact` جسرًا يُركَّب بوجود المخزن فقط؛ كل رفض (معبوث/غائب/ضخم/ثنائي/نوع غير معلن/تعارض مصدرين) **مثبت قبل أي طلب** فيُسوَّى `failed` لا `unknown`؛ `text/html` أُضيف لأن قالب `static_page` من B3 ينتجه؛ **9/9** اختبارات، والحزمة **754 اختبارًا / 737 ناجحًا / 0 فشل حقيقي** وتغطية **91.01/75.98/87.10** (الفشل الوحيد N/N−1 بيئي: كائن Git مفقود في هذا الاستنساخ). **لا نطاق OAuth جديد** — الرفع الحي يحتاج منح كتابة `drive.file` وهو قرار مالك. سجل الجلسة: [2026-10-29-manus-b4-drive-artifact-upload](sessions/2026-10-29-manus-b4-drive-artifact-upload.md) · القرار: `DEC-058` · **دُمج بكلمة المالك في `main@acafa13` (PR #93)**.

**الجلسة السابقة:** **MANUS-B3 + إنقاذ A4 + الخيوط العنكبوتية** على `arena/a3caa0c8-phone-google` (PR #92، دُمج في `main@bdfbb6b`): (1) A4 أُنقذ من PR #90 المتعارض بإعادة تطبيقه فوق main (`model-router.js`، MR-01..10 = 10/10، و#90 أُغلق)؛ (2) B3 قوالب مخرجات حتمية (`output-templates.js` + أداة `template.render` + بوابة `eval:templates` **PASS 3/3** ببصمات مثبتة — بوابة مستقلة عن `eval:ai` المجمّد عمدًا) 6/6؛ (3) قارئ العنكبوت (`spider-reader.js` read-only صفر شبكة خلف `CELIA_AGENT_SPIDER=read`) 5/5. السجل: [2026-10-29-manus-b3-templates-a4-spider](sessions/2026-10-29-manus-b3-templates-a4-spider.md) · **قبلها:** B2 مخزن artifacts (9/9، [سجل](sessions/2026-10-29-manus-b2-artifact-store.md)) · B1 `sandbox.exec` (9/9، [سجل](sessions/2026-10-29-manus-b1-sandbox-exec.md)) · A3 `call_many` (12/12، [سجل](sessions/2026-10-29-manus-a3-call-many.md)) · A2 `plan.revised` (9/9، [سجل](sessions/2026-10-29-manus-a2-governed-replan.md)) · A1 مزوّد Gemini (24/24، [سجل](sessions/2026-10-29-manus-a1-gemini-planner.md)) · GOOG-005 قراءات Google (8/8، [سجل](sessions/2026-10-29-google-readonly-2026.md)) · WP-1.4 قياسات · WP-1.3 سمتان · WP-1.2 تتبع · WP-2.1 سياسة سياق · WP-2.3 ذاكرة · WP-2.4 بوابة AI-001 · R0 استمرارية: روابطها في [NOW.md](NOW.md) وفي سجلاتها داخل `docs/continuity/sessions/`.
**الأرشيف التاريخي الكامل:** [STATE-ARCHIVE-2026-10.md](STATE-ARCHIVE-2026-10.md) · **سجلات الجلسات السابقة كلها:** داخل `docs/continuity/sessions/` (مرتبطة أعلاه وفي NOW).

## 1. خط الأساس المتحقق (`bdfbb6b`)

- **بداية جلسة B4:** الفرع `arena/dcb565df-phone-google` من `main@bdfbb6b` (دمج PR #92) بشجرة نظيفة؛ لا PR مفتوح من هذا الفرع، ولا نشر أو ترحيل.
- **الإصدار:** `v0.2.1` · **مخطط القاعدة الأساسي:** `schema=1` (`destructiveMigration=false`) · **Node:** `>=22` · **قاعدة التوافق:** التغييرات إضافية فقط (ترحيل `0006` من B2 قائم؛ B4 لم يُضف ترحيلًا ولا جدولًا).
- **الجودة عند خط الأساس:** 745 اختبارًا / 729 ناجحًا / 0 فشل و56/56 تحت بيئة التكامل. بعده: **754 / 737 / 0 فشل حقيقي** (10 اختبارات جديدة: 9 لـB4 + 1 ملف جديد) وتغطية **91.01/75.98/87.10** فوق الأرضية (`89/71/82`).

## 2. السلّم: أين نقف بالضبط

- **S0** ✅ تثبيت القاعدة (PR #89) · **S1/A4** ✅ `model_router` منقذ على `main` · **S4 (M-B)** ✅ **مكتمل الآن**: B1 `sandbox.exec` ✅ → B2 artifacts مبصومة ✅ → B3 قوالب ✅ → **B4 Drive خلف الموافقة ✅**.
- **مفتوح بقرار مالك:** **S2/S3** (القياس الحي بمزود حقيقي) — `GOV-001` (مفتاح + ميزانية) ما زال معلّقًا؛ لذلك لم يُقَس شيء بنموذج حي ولا يُدّعى رقم C1.
- **التالي (لا يحجبها قرار):** **S5 — العينان (M-C)**: ابدأ بـ**egress proxy** المعتمد لكل run (أخطر مكوّن أمني في الخطة كلها) قبل أي `web.fetch`/`web.search`، ثم عامل المتصفح (`celia-google-spider`) ثم `/computer` حي ثم حوكمة حقن المحتوى (`DEC-020`).
- **لوحة النتيجة §4 من الخطة:** artifacts مبصومة مسلَّمة = 3 أنواع مخرجات + رفع Drive محلي/Mock؛ «مهمة بعزل end-to-end» تعمل (SBX-09)؛ ما زال **0** لمهام الويب ومهام WhatsApp الكاملة والتشغيل الدوري.

## 3. B4 — ما نُفِّذ فعليًا (بلا ادعاء حي)

- **المشكلة:** الموصل موجود منذ AGENT-002 لكن حمولته نصٌّ يكتبه المخطط؛ مخرجات B2/B3 ملفات مبصومة في المخزن، فكانت الفجوة **مصدر البايتات**.
- **الحل:** مسار `{ artifactId }` بديلًا للنص (وجود الاثنين = رفض)، قراءة داخلية `artifacts.readForUpload` تعيد البصمة في كل قراءة، و`resolveArtifact` جسرًا في الموصل يُركَّب بوجود المخزن فقط (`artifactBridge` في `index.js`). النتيجة تحمل `source: { artifactId, sha256, bytes }` في الأدلة.
- **ما لم يتغير:** تصنيف الأداة `external_effect` + موافقة + outbox + `post_approval_payload_tampered`؛ الحمولة المعتمدة تبقى `args` فلا يكسر الربط بالبصمة، وصف حي واحد لكل (run، أداة) يعني **تصديرًا واحدًا لكل تشغيل** كما في نص B4.
- **الحد الصريح:** `GOOGLE_SCOPES` لم يتغير. الرفع الحي يحتاج منح كتابة (`drive.file`) = **قرار مالك**؛ كل ما نُفِّذ ونُفِّذ اختباره محلي/Mock بناقل قابل للحقن، والمسار الحي على منح قراءة فقط يفشل بـ`drive_authorization_failed` بصدق.

## 4. الحدود والعوائق

1. **لا نموذج حي ولا Drive حي:** `GOV-001` (مفتاح Gemini + ميزانية) ومنح كتابة Drive قراران مالكيان؛ لا يُستنتجان من نجاح الاختبارات.
2. **MySQL/Chromium:** لا خدمة MySQL معزولة ولا Chromium مثبت في هذا الصندوق؛ بوابات `test:mysql` و`test:browser` لم تُشغَّل هنا، ولا يُدّعى نجاحهما.
3. **N/N−1 البيئي:** اختبار توافق MCP يحتاج الكائن `2508893…` غير الموجود في هذا الاستنساخ — فشل واحد معروف ومُثبت على خط أساس نظيف.
4. **قرارات مالك قائمة:** Branch protection/CodeQL (`SEC-006`)، ربط Google/Meta وRender/Aiven (`GOOG-001`/`WA-005`/`HOST-003`)، مزوّد التخطيط والميزانية (`GOV-001`/`AI-002`)، وترخيص/احتفاظ (`DATA-004`/`REL-001`).
5. **لا دمج ذاتي:** هذه الجلسة على فرعها فقط؛ الدمج بكلمة المالك وبعد الفحوص الثلاثة (`governed-pr-merge`).

## 5. الاستئناف والفحوص

1. ابقَ على `arena/dcb565df-phone-google`؛ اقرأ [سجل B4](sessions/2026-10-29-manus-b4-drive-artifact-upload.md) و`DEC-058` قبل أي تعديل على مسار الرفع.
2. لا تفعّل رفع Drive حيًا ولا تفتح نطاق OAuth ولا تنشر أو ترحّل بلا تفويض صريح.
3. أول فحص آمن قبل أي شيء: `node --test test/agent-drive-artifact-upload.test.js` ثم `npm run check:continuity`.

```sh
git branch --show-current && git status --short && git log -3 --oneline
node --test test/agent-drive-artifact-upload.test.js
node --test test/agent-connectors.test.js test/agent-artifact-store.test.js test/agent-tool-validation.test.js test/agent-output-templates.test.js
npm run test:coverage
npm run check && npm run now && npm run now:check && npm run check:continuity && npm run check:secrets
CELIA_SANDBOX_INTEGRATION=1 node --test test/agent-sandbox.test.js test/agent-sandbox-tool.test.js test/agent-artifact-store.test.js test/agent-output-templates.test.js test/agent-spider-reader.test.js test/agent-model-router.test.js
```
