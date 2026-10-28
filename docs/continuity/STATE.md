# الحالة الحالية — ابدأ من هنا

**آخر مراجعة:** 28 أكتوبر 2026 · **نوع الجلسة الحالية:** **خطة المحافظة على `main@715060a` (DEC-031، OPS-005)** على الفرع
`arena/828764c2-phone-google` (متفرع من دمج PR #46) · سجل الجلسة:
[2026-10-28-preservation-plan](sessions/2026-10-28-preservation-plan.md) · السجل السابق:
[2026-10-28-service-reality-audit](sessions/2026-10-28-service-reality-audit.md) ·
الخطة: [docs/preservation-plan.md](../preservation-plan.md) · واقع الخدمات: [docs/service-reality.md](../service-reality.md) ·
المرجع التشغيلي: [deploy/free-always-on/README.md](../../deploy/free-always-on/README.md)

## الطلب الحالي (أعلى أولوية) — «خطط للمحافظة لما وصلنا له حتى الآن» (DEC-031، OPS-005)

- **ما وصلنا إليه (مدموج في `main@715060a`):** 324/324 اختبارًا (تغطية 85.8/72/84)، MySQL حقيقي 11/11، Pages ✅ `40650636259`،
  Worker ✅ `40650636104` (`liveReady`، 18/18 + مفاتيح التقاعد)، Release ✅ `40650636330`، 10 خدمات متحققة / 4 متقاعدة في Git /
  2 بانتظار سرّ مالك (83.3%).
- **ما نُفِّذ للمحافظة:** `docs/preservation-plan.md` (جرد بالدليل، مخاطر، ضوابط، أسرار، إعادة بناء، إيقاع، مؤشرات)؛
  `service-reality.yml` يعمل أسبوعيًا (اثنين 06:00 UTC) ويشغّل `scripts/reality-notify.mjs` على `main`: issue واحدة
  `service-reality` تُفتح/يُعلَّق عليها عند الفشل وتُغلق وحدها عند النجاح؛ CI يفرض أرضية تغطية `npm run test:coverage`
  (80/65/78) و`COVERAGE_FLOOR` في التدقيق؛ اختبارات `test/reality-notify.test.js` (2) + توسيع `test/service-reality.test.js`.
- **بنود المالك (لا تُنفَّذ من هنا — 403):** حماية `main` بأسماء الفحوص المذكورة في الخطة §د؛ Watch → Actions أو الاكتفاء
  بالـissue؛ `CELIA_VOICE_ID` وتوكن Figma؛ قرار PRs #34 (revert — لا يُدمج) و#38/#39؛ Dependabot security updates.
- **الخطوة التالية:** أول run مجدول (الاثنين القادم) يجب أن يفتح issue صحيحة (83.3%) أو يمرّ بعد السرّين؛ ثم تحديث OPS-005.

## الطلب السابق — «لا خدمة مجرد اسم أو موكب؛ خدمات حقيقية مختبرة ≥95%» (DEC-030، QA-005) — مدموج في PR #46

- **ما نُفِّذ:** `scripts/service-reality.mjs` (`npm run reality`) + `.github/workflows/service-reality.yml` (يعمل عند commit
  يحمل `[reality]` أو `workflow_dispatch` من `main`) + `test/service-reality.test.js` (10) + `test/ai-providers.test.js` (3).
  ست تشغيلات حقيقية بالأسرار الـ18 من داخل Actions؛ التشخيص الكامل في run `40646881277`؛ **الأخيرة run `40649403028`**:
  324/324 بلا شبكة (85.82% أسطر)، MySQL 8.4 حقيقي 11/11، مسابر حية: **10 متحققة · 2 فاشلة · 4 متقاعدة صراحةً · 1 غير مهيأة
  · 2 لا يمكن التحقق · 1 غير منشورة → 83.3% < 95%** (كانت 62.5%).
- **التقاعد الصريح (بعد «ابدأ كما ذكرت»):** لا صلاحية لمتغيرات/أسرار المستودع (403) → `docs/deployment-profile.json →
  serviceRetirements` لـAI Gateway (403 «بطاقة مطلوبة»)، R2 (TLS مرفوض/غير مفعّل)، DeepSeek (402)، AgentRouter (0 نماذج)؛
  يغذّي المدقق وbindings الـWorker و`render.yaml` معًا؛ التراجع = حذف السطر بعد إصلاح الحساب + commit `[reality]`.
- **ما بقي فاشلًا وسببه سرّ مالك:** ElevenLabs — **المفتاح يولّد صوتًا فعلًا** (17,597 بايت في الـrun) لكن `CELIA_VOICE_ID`
  ليس بين الأصوات المرئية (مرئية مثلًا `EXAVITQu4vr4xnSDxMaL` Sarah، `FGY2WhTYpPnrIDTdsKH5` Laura، `CwhRBWXzGAHq8TQ4Fs17` Roger)؛
  Figma — توكن 401. الجدول: [docs/service-reality.md](../service-reality.md).
- **ما أصلحه الدليل:** `/readyz` للـWorker لم يعد يدّعي `durable: true`؛ افتراضي DeepSeek `deepseek-flash`؛ رسائل رفض المزوّد
  تحمل سببها بلا مفتاح؛ `/api/secrets/status` على الحافة يعرض `retiredServices`.
- **الخطوة التالية (المالك، خطوتان):** (1) سرّ `CELIA_VOICE_ID` = صوت مرئي للمفتاح (أو إعادة إنشاء صوت سيليا في هذا
  الحساب)؛ (2) توكن Figma جديد **أو** سطر `figma` في `serviceRetirements`. ثم commit `[reality]` (أو dispatch من `main` بعد
  دمج PR #46) → 100% بدليل run، وتحديث QA-005 إلى «متحقق».

## الطلب السابق في الجلسة نفسها — «هنربط جوجل بالواتساب: لخص آخر إيميل / هات جدولي» (DEC-029، GOOG-003)

- **ما طلبه المالك (بلصق إرشاد من محادثة أخرى):** ربط Google بواتساب بمسار Python `InstalledAppFlow` + `credentials.json` +
  `token.json`، وإصلاح «مافيش إيميلات جديدة» بـ`q=""`. **الحكم:** لا يُنسخ (خادم بلا متصفح، عميل Desktop ≠ Web، توكن خام في ملف)؛
  الربط موجود في Node بعميل Web + تشفير، و`credentials.json` شأن السبّابة Python (Drive فقط). التفاصيل: `docs/google-connect.md` §6ب.
- **ما نُفِّذ:** `src/owner-google-commands.js` (تحليل/تنسيق نقي، منطقة زمنية `CELIA_TIMEZONE` افتراضي `Africa/Cairo` مع التوقيت
  الصيفي)، `fetchInboxMessages`/`listAgendaEvents` في `src/google.js` (`INBOX` بلا `is:unread` إلا عند طلب «الجديدة»؛ عميل محقون
  للاختبار)، التوصيل في `src/whatsapp.js` **للمالك فقط** بعد أمر «اربط جوجل»؛ `test/owner-google-commands.test.js` 8/8 (تحليل،
  مدى اليوم عبر تبديل DST المصري 29 أكتوبر، التنسيق، أخطاء بلا تسريب، 409 قبل الربط، webhook: المالك يحصل على الرد وعميل بنفس
  النص لا يحرّك Google ولا واتساب). لا نموذج لغوي، لا إرسال بريد، لا تعديل تقويم.
- **ما يبقى:** التشغيل الحي يحتاج الخادم الكامل منشورًا (HOST-003 → الخطوات الثلاث أدناه) ثم «اربط جوجل» من رقم المالك.
  `credentials.json` غير مطلوب للخادم.

## الطلب السابق في الجلسة نفسها — «الأسرار موجودة، استخدمها» → أتمتة النشر على Render والتحقق (DEC-028)

- **الواقع عند `main@a930383` (دمج PR #45، 2026-10-28 01:31 UTC):** Pages `https://celiaelazamey-arch.github.io/phone-google/`
  (deployment `7374774785`، 10/10 مسارات في `40615518798`)، Worker `https://celia-phone-google.celiaelazamey.workers.dev`
  (`liveReady:true`، 18/18 سرًا في `40615518722`)، الإصدار `v0.2.1` موثق (`40615518730`)، صورة GHCR عامة.
  **غير منشور:** الخادم الكامل Express + MySQL — لا خدمة Render ولا قاعدة Aiven ولا `verify:live` PASS.
- **أسرار Actions الثمانية عشر:** كلها مستخدمة (مزوّدو الذكاء ×4، cron-job.org، رمز المالك، الصوت ×2، Cloudflare ×2،
  R2 ×3، Figma، Google OAuth ×2، الهاتف، Coda) — ولا واحد منها مضيف Node أو قاعدة MySQL؛ هذان حسابان ينشئهما المالك فقط.
- **ما نُفِّذ:** `.github/workflows/deploy-render.yml` (بعد نجاح CI على `main` أو يدويًا؛ `contents: read`) +
  `scripts/deploy-render.mjs` (`npm run deploy:render`): `not-configured` أخضر مع تسمية الناقص → إطلاق نشر Render (API أو
  hook) وانتظار `live`/تطابق `/version` → `verify:live --expect-commit` بالرمز من البيئة → artifact → keep-alive
  cron-job.org `celia-keepalive:<host>` كل 10 دقائق بعد PASS فقط؛ `sanitize` لكل مخرجات. اختبارات
  `test/deploy-render.test.js` (8). الوثائق: `deploy/free-always-on/README.md` §4.2، README §روابط النشر،
  `docs/deployment-profile.json`.
- **ما يبقى على المالك (≈10 دقائق، بلا بطاقة):** (1) Aiven → MySQL Free فارغة؛ (2) Render → New → Blueprint → هذا
  المستودع (`render.yaml`) → لصق `MYSQL_*` الستة في Render فقط؛ (3) في GitHub: variable `CELIA_LIVE_URL` + secrets
  `RENDER_API_KEY`/`RENDER_SERVICE_ID` (أو `RENDER_DEPLOY_HOOK_URL`). بعدها أول دمج/تشغيل يدوي لـ`deploy-render.yml`
  يكتب `verified` أو سبب الفشل. البنود `manual` في §5 تبقى بسجل جلسة.
- **الخطوة التالية:** مراجعة/دمج PR هذا الفرع (قرار المالك)، ثم الخطوات الثلاث أعلاه؛ لا نشر من هذه الجلسة.

## الطلب السابق — التعلم المحكوم من المصادر الخارجية وروابط النشر (DEC-027)

- **روابط النشر الحية (دليل GitHub API عند `main@1a11810`، 2026-10-28 00:53 UTC):**
  - GitHub Pages: `https://celiaelazamey-arch.github.io/phone-google/` — deployment `7374226427` ناجح + فحص 10/10 مسارات
    (التشغيلة `40611588083`).
  - Cloudflare Worker: `https://celia-phone-google.celiaelazamey.workers.dev` — `deployed`، `liveReady:true`، 18/18 سرًا
    (التشغيلة `40611588035`).
  - الإصدار `v0.2.1` موثق OIDC (التشغيلة `40611588118`)؛ صورة `ghcr.io/celiaelazamey-arch/phone-google:v0.2.1` **عامة**.
  - **غير منشور:** الخادم الكامل (Express + MySQL): لا خدمة Render ولا قاعدة Aiven ولا `verify:live` PASS — يبقى
    `not-verified` حتى يأذن المالك بإنشاء الحسابات المجانية. الصندوق الرملي لا يفتح `github.io`/`workers.dev`؛ الدليل من
    حالات النشر وتعليقات التشغيلات.
- **ما نُفِّذ (التعلم):** سجل مصدر `data/learning/sources/yt-Cb3mBAH0IaY/source.json` (SHA-256 للنص و12 مقطعًا؛ النص
  نفسه خارج Git)، `scripts/learn-source.mjs`، عقود `video` + `reference-only` (مصادر فقط) في `validate.js`،
  `data/kb/learned_registry.csv` بـ9 وحدات `T1` موسومة `learn:yt-Cb3mBAH0IaY`، بطارية `LS-01..LS-10` (10/10)،
  `kb -- verify` 0 مرفوض و`unresolved: []`، `npm test` 295/295.
- **متجه حالة المصدر:** `SOURCE=VERIFIED · EXTRACTION=PARTIAL (بلا طوابع زمنية) · COMPREHENSION=PARTIAL ·
  KNOWLEDGE=CANDIDATE(9) · PROCEDURE=NONE · CAPABILITY=NONE · REGRESSION=PASS`. مواضيع NLP/CV/الروبوتات/AGI/ASI **UNKNOWN**.
- **الخطوة التالية:** (1) المالك يراجع PR هذا الفرع ويدمجه (= بوابة الموافقة؛ الدمج ينشر Pages/Worker/Release تلقائيًا)؛
  (2) إن أراد الاستخراج الكامل: لصق نص «إظهار النص» بصيغة `mm:ss نص` أو `.srt`؛ (3) HOST-003: إنشاء Render Free + Aiven
  Free من لوحتي المالك ثم `verify:live`.

## الطلب السابق — دورة الخطة والـAgent Harness وقدرة `document_data_automation` وبوابة `Comprehension Gate` (DEC-019، DEC-020، DEC-021)

- **ما نُفِّذ في هذه الجلسة (`arena/5fccc4e6-phone-google`):**
  - **آلة حالات الخطة (`src/agent/harness.js` + `src/agent/runtime.js`):** انتقالات صريحة
    `PLAN_READY → WAITING_FOR_APPROVAL → APPROVED → EXECUTING` مع مسار التعديل المحكوم
    `PLAN_READY → WAITING_FOR_APPROVAL → EDITED → WAITING_FOR_APPROVAL` ومسار الرفض `REJECTED`.
  - **تعديل الخطة وإعادة فحص السياسات (`POST /api/agent/runs/:id/plan` و`decision: 'edited'`):** يتحقق من
    الحمولة المعدّلة ضد `inputSchema` ويرفض تغيير الأداة أو الحقول غير المصرّح بها، ويسجل القرار السابق `edited`
    وينشئ طلب موافقة جديدًا مربوطًا ببصمة الحمولة الجديدة ويحدّث نية الـoutbox المعلّقة ويدوّن `plan_edited` في
    سلسلة SHA-256، ويبقي التشغيل في `waiting_approval` دون أي تنفيذ خارجي حتى موافقة المالك.
  - **حارس النزاهة بعد الموافقة (`verifyApprovedEffectIntegrity` + `verifier.js`):** يمنع أي تلاعب صامت بحمولة
    الـoutbox بعد صدور الموافقة قبل استدعاء أي موصل خارجي.
  - **القدرة الأصيلة `document_data_automation` (`src/agent/automation/{schema,reader,extractor,validator,index}.js`، DEC-020):**
    تعمل محليًا بالكامل (`NETWORK = DENY`، `EXTERNAL GATES = CLOSED` افتراضيًا) فوق بنية CeliaOS القائمة:
    قراءة مستندات محلية معروفة النوع (`CSV`/`JSON`/`TXT`) ببصمة `SHA-256` ومراجع الحقول/الأسطر (`document.read`)،
    واستخراج منظم وفق مخطط معلوم الإصدار `schema_version: "1.0"` مع عزل محتوى المستند كبيانات غير موثوقة وقياس الدقة
    على حزمة مرجعية ذهبية (`document.extract` + `measureExtractionAccuracy`)، وفحص حتمي للقيم والتواريخ والعملات
    ومطابقة الإجماليات والتكرارات ومؤشرات حقن التعليمات (`data.validate`)، وتوليد تقرير موحد مع ربط البصمات بسلسلة
    الأدلة (`data.report`)، وإدراج محكوم اختياري في سجل المشتريات بعد موافقة المالك عبر `agent_outbox`
    (`document.commit_purchase_ledger`) مع فحوص المُتحقِّق المستقل (`document_automation_schema`،
    `document_automation_policy`، `document_automation_commit_parity`).
  - **بوابة الفهم والشرح المبسّط المدعوم بالأدلة (`Comprehension Gate — Explain to Understand`، DEC-021):**
    إضافة القاعدة إلى `AGENTS.md`، وعقد الشرح المتوافق عكسيًا مع `schema_version: "1.0"` (`validateExplanationContract`)،
    وشرح الحقول بالرجوع إلى مواضعها (`explainExtractedFields`) مع فصل الحقائق المثبتة (`verified_facts`) عن الافتراضات
    (`assumptions`) والحقول الغائبة/غير المحسومة (`unknowns`)، وتفسير نتائج التحقق بلغة بسيطة (`explainValidationOutcome`)،
    وفاحص البوابة (`evaluateComprehensionGate`) وربطه في `src/agent/verifier.js` (`comprehension_gate_grounding`) و`src/agent/planner.js`،
    واختبارات `CL-01` إلى `CL-10` في `test/agent-comprehension-gate.test.js`.
  - **معمارية Agent Harness الـ10 مكونات (`GET /api/agent/harness`)** وواجهة تعديل الخطة في `/agent`، وتشخيص
    Playwright Chromium الصريح (`e2e/diagnostics.js`، `e2e/agent.spec.js`، `playwright.config.js`)، وإصلاح
    الروابط النسبية وتباين WCAG 2.2 AA وعرض 320px في `/agent` و`/kb`.
  - **إضافة المرحلة 1 من خارطة التوسعة (`AGENT-002` — موصلا WhatsApp وGoogle Drive عبر `agent_outbox`، [DEC-022](DECISIONS.md#dec-022--استكمال-موصلات-الأثر-الخارجي-في-agent_outbox-agent-002-whatsapp-cloud--google-drive-report-export)):**
    - إضافة موصل `whatsapp.cloud` (`whatsapp.send_text`) بفحص `E.164` و`opted_in` ونافذة 24 ساعة ومنع التكرار عبر `whatsapp_messages`، وموصل `google.drive` (`google.drive_export_report`) ببصمة `appProperties.celiaOutboxKey` وفحص `findByOutboxKey` قبل الإنشاء.
    - توسيع `CELIA_AGENT_CONNECTORS` ليقبل `none, calendar, whatsapp, drive` مع بقاء `none` هو الوضع الافتراضي الآمن.
    - نجاح جميع الاختبارات المحلية (**273/273** في `npm test` شاملة `WA-01..WA-04` و`DRV-01..DRV-04` في `test/agent-connectors.test.js`).
  - **إضافة محرك التطبيق والقياس ذي الخطوات الست (`6-Step AI Application & Evaluation Engine`، [DEC-023](DECISIONS.md#dec-023--محرك-التطبيق-والقياس-ذو-الخطوات-الست-6-step-ai-application--evaluation-engine--product-catalog-audit--6-stage-creative-workflow--3-way-truth-partition)):**
    - بناء [src/agent/evaluation.js](../../src/agent/evaluation.js) و[docs/ai-workflow-6-steps.md](../ai-workflow-6-steps.md) لتطبيق: توجيه المهام (`recommendTaskStrategy`)، معادلة التكلفة وحارس الخطط المجانية (`estimateTokenCost` و`evaluateProviderSafety`)، فاحص كتالوج المنتجات (`product.catalog_audit`)، سير العمل الإبداعي ذي الـ6 مراحل (`creative.workflow_plan`)، الفصل الثلاثي (`executed / verified / unverified` في `buildTruthPartition` وواجهة `/agent`)، ومؤشرات الأداء الستة (`computeAgentMetrics` ونقطة `GET /api/agent/metrics`).
    - نجاح جميع الاختبارات المحلية (**280/280** في `npm test`).
  - **إضافة حزمة التدقيق الموقّعة واستئناف وحذف الخيوط وضبط متغيرات البيئة ([DEC-024](DECISIONS.md#dec-024--حزمة-التدقيق-الموقعة-audit-bundle-واستئناف-وحذف-الخيوط-ux-001-وضبط-متغيرات-البيئة)):**
    - إضافة `GET /api/agent/runs/:id/audit-bundle` (`bundle_sha256`) و`DELETE /api/agent/threads/:id` وقائمة اختيار الخيوط السابقة في `/agent`، ودعم `PHONE_NUMBER` كبديل توافقي لـ`APP_OWNER_PHONE_E164`.
    - نجاح جميع الاختبارات المحلية (**280/280** في `npm test`) ونجاح تشغيلة GitHub Actions CI رقم **`40599659235`** (الـCommit `f0114b3bddca5605ea5d4c2c820b99c011aed400` على الفرع `arena/981ee27e-phone-google`) في جميع الوظائف الست: `MySQL 8.4` (`122524304770` في 43 ثانية)، `RTL dashboard · Playwright Chromium` (`122524304986` في 44 ثانية)، `Node 22` (`122524304995` في 25 ثانية)، `Node 24` (`122524305136` في 32 ثانية)، `Python 3.11 Spider` (`122524305019` في 20 ثانية)، و`Node 24 Container` (`122524305069` في 22 ثانية).
  - **توظيف الأسرار الـ18 جميعًا وبوابة Cloudflare Worker والنشر الآلي الموقّع ([DEC-025](DECISIONS.md#dec-025--توظيف-جميع-أسرار-المستودع-الـ18-وبوابة-cloudflare-worker-والنشر-الآلي-الموقع-1818-secrets-wiring--edge-release)):**
    - توسيع `buildSecretsReadiness` و`scripts/check-secrets-wiring.mjs` و`.github/workflows/celia-mcp.yml` لتتبع وفحص **18/18 سرًا** مع صفر تسريب، وإضافة `GET /api/cron/status` و`POST /api/cron/probe` و`GET /api/storage/r2/status`.
    - إضافة خادم الحافة `workers/celia-edge/worker.js` وسكربت `scripts/deploy-cloudflare-edge.mjs` وسير عمل `.github/workflows/cloudflare-deploy.yml` وتفعيل نشر الإصدار الموقّع `v0.2.1` في `.github/workflows/release.yml`.
  - **بروتوكول التفوق واكتساب المستخدمين وحزمة Benchmark الـ20 حالة وإنفوجرافيك `/protocol` ([DEC-026](DECISIONS.md#dec-026--بروتوكول-التفوق-واكتساب-المستخدمين-user-switch--product-superiority-protocol-benchmark-الـ20-حالة-وإنفوجرافيك-protocol)):**
    - إضافة [src/agent/automation/benchmark.js](../../src/agent/automation/benchmark.js) (`BM-01..BM-20` بـ20/20 PASS وصفر قبول/رفض خاطئ وثبات إعادة تشغيل 100%)، وصفحة الإنفوجرافيك المعماري العربي التفاعلي [public/protocol.html](../../public/protocol.html) (`/protocol`)، ووثيقة [docs/user-switch-protocol.md](../user-switch-protocol.md)، واختبارات [test/agent-benchmark-20.test.js](../../test/agent-benchmark-20.test.js).
    - التحقق الحي الآلي في `.github/workflows/pages.yml` لجميع المسارات العشرة على GitHub Pages، ومزامنة أصول الإصدار الموقّع `v0.2.1` في `.github/workflows/release.yml` مع أحدث التزام على `main`.
  - **الفحوص المحلية وفحوص GitHub Actions CI الفعلية (`Verification Closure`):**
    - محليًا: `npm test` **268/268** ناجحة (منها 7 اختبارات في `test/agent-document-automation.test.js` و10 اختبارات
      `CL-01..CL-10` في `test/agent-comprehension-gate.test.js`)، و`check` و`release:check` و`check:continuity`
      و`check:secrets` و`build:pages` كلها خضراء.
    - في GitHub Actions CI على الفرع `arena/5fccc4e6-phone-google`:
      - التشغيلة الأولى `40592598360` (`6bf47b3`) كشفت تجاوز طول مخرج `data.report` لسقف `VARCHAR(4000)` في
        `agent_tool_runs.outcome` تحت وضع `STRICT_TRANS_TABLES` في MySQL 8.4؛ عُولج بضبط حجم التقرير ليظل `< 4000`
        حرف وتثبيت الحد `4000` في `src/agent/store.js`.
      - التشغيلة الثانية **`40593284086`** (الـCommit `99b789582911043f6d1cd45aa9ca9f135cd380f0`) **نجحت بالكامل في جميع
        الوظائف الست**: `Node 22` (`122502699179`)، `Node 24` (`122502699163`)، `Python 3.11 Spider` (`122502699173`)،
        `Node 24 Container` (`122502699186`)، **`RTL dashboard · Playwright Chromium`** (`122502699198` في 48 ثانية)،
        و**`MySQL 8.4 · persistence / N−1 / backup restore`** (`122502699207` في 45 ثانية شاملة `DEC-019` و`DEC-020` و`DEC-021`).
    - **ما يظل مغلقًا (`not-verified`):** النشر الحي على Render وAiven MySQL وتشغيل `verify:live` على رابط عام.

## الطلب السابق — الخطوات التالية للتشغيل الحقيقي (DEC-018)

**الفرع `arena/0220ec0b-phone-google` بُني فوق فرع PR #36 (`daf815a` مدمج فيه)** لأن كل خطوة تعتمد على DEC-017
وقائمة §5. الترتيب الصحيح: دمج #36 ثم هذا الفرع (أو دمج هذا الفرع وحده فيحمل #36 معه).

- **حقائق جديدة بالدليل الحي (تُبطل ادعاءات الصباح):**
  - **Pages مفعّل:** `gh api repos/…/pages` يعيد موقعًا بـ`build_type: workflow`، `https_enforced: true` على
    `https://celiaelazamey-arch.github.io/phone-google/`. لكن **لم يُنشر شيء بعد**: آخر `pages.yml` على `main`
    (`4d4eb85`، 14:58) سبق التفعيل فكانت خطوة Configure Pages `outcome=failure` وتخطّى الرفع/النشر؛ ومحاولة
    `gh workflow run pages.yml --ref main` من هذه الجلسة ⇒ `403`. **أول دمج إلى `main` هو ما سينشر.**
  - **PR #34 خطر مفتوح:** Revert لـPR #33 (الـoutbox وموصل التقويم) أُنشئ بعد دمج #33 بـ24 ثانية،
    `mergeable: UNKNOWN`. دمجه يكسر #35 و#36. التوصية إغلاقه بلا دمج — **لم أغلقه** (قرار المالك).
  - PR #36: مفتوح، `mergeStateStatus: CLEAN`، الفحوص السبع خضراء. المستودع عام.
- **ما نُفِّذ هنا (كود + اختبارات، بلا نشر):**
  - **الاستعادة عند الإقلاع (DEC-018):** `runtime.recoverOnBoot()` = `outbox.recoverStale()` ثم `resumePending()`؛
    `agentHost.recoverOnBoot()` لا يرمي ويسجّل `status().bootRecovery`؛ `scheduleBootRecovery()` موصولة بعد
    `listen` في `src/celia-mcp.js` و`src/server.js`. **معطّلة افتراضيًا** (`CELIA_AGENT_RESUME_ON_BOOT=false`).
    `test/agent-boot-recovery.test.js` (5): نية `dispatching` مهجورة ⇒ `unknown` بلا استدعاء موصل؛ تشغيل
    `queued` يكتمل؛ استدعاء غير محسوم ⇒ `needs_reconciliation`؛ الإقلاع الثاني لا يغيّر شيئًا؛ قيمة خاطئة
    للمتغيّر خطأ معلن.
  - **القبول الحي أمر:** `scripts/verify-live.mjs` + `npm run verify:live -- --url https://…` (7 فحوص آلية +
    4 بنود `manual`؛ الرمز من البيئة فقط ولا يُكتب؛ المضيف فقط في التقرير؛ رمز خروج 1 عند أي إخفاق).
    `test/verify-live.test.js` (5): التطبيق الحقيقي على ذاكرة صريحة **يفشل**؛ خدمة مثالية تنجح؛ عدم تطابق
    commit إخفاق؛ https إلزامي؛ CLI يكتب تقريرًا منقّحًا.
  - **الوثائق:** `docs/go-live-plan.md` (الأركان السبعة، البوابات، تسلسل الأيام الأولى، أربعة قرارات للمالك)،
    تحديث `deploy/free-always-on/README.md` (حالة Pages، المتغيّر الجديد، §5 بالأمر) وعقده، `docs/agent-runtime.md`،
    `.env.example`، DEC-018، BACKLOG (AGENT-001، HOST-003، OPS-004)، CHANGELOG.
- **ما لم يُنفَّذ ويحتاج المالك:** دمج/إغلاق PRs، حسابات Aiven/Render، الأسرار، الترحيل على قاعدة حقيقية،
  النداء الدوري، تشغيل `verify:live` على رابط حقيقي. **الحالة ما زالت `not-verified`.**
- **قرارات مطلوبة الآن (§4 من الخطة):** دمج #36 وإغلاق #34؟ · العمودي الأول (تقويم عبر WhatsApp؟) · مزوّد
  المخطط اللغوي (Gemini غير المدفوع يستخدم المحتوى ويراجعه بشر — [الشروط](https://ai.google.dev/gemini-api/terms)) ·
  سياسة الاحتفاظ (DATA-004).

## الطلب السابق — تشغيل دائم مجاني بلا بطاقة (DEC-017، PR #36)

**الجواب الصريح: «دائم مضمون» غير موجود مجانًا وبلا بطاقة على أي مزوّد.** Render Free بلا بطاقة لكنها تنام
بعد 15 دقيقة خمول وتُوقَظ في ~دقيقة، وبحصة **750 ساعة/شهر** — أي أن خدمة واحدة تعمل بلا توقف تستهلك 744 ساعة
في شهر 31 يومًا، فلا مجال لخدمة ثانية. لذلك الخطة الحرة = خدمة `web` واحدة + نداء دوري كل 10 دقائق يمنع
النوم + Aiven Free MySQL + واجهة ثابتة لا تنام أصلًا.

- **ما أُنجز في هذه الجلسة (كود ووثائق واختبارات، بلا نشر):**
  - `deploy/free-always-on/README.md`: خطة تنفيذية بالحساب والأرقام والمصادر، وجدول المتغيّرات، وقائمة قبول
    قابلة للتأشير، وحدود صريحة (لا SLA، لا نسخ احتياطي، حصة حدّ صلب).
  - **ثغرة صدق أُغلقت في الواجهة الثابتة:** `public/agent.html` في نسخة Pages كانت تنادي `/api/agent/*`
    فلا يعترضها المحاكي فترتد 404/HTML بصمت. أُضيف اعتراض صريح لـ`GET /api/agent/status` يعيد
    `enabled:false, mode:off` ويحيل إلى الخدمة الحقيقية بحالة **`verified:false`**. ولا تُحاكى موافقة ولا
    مصالحة في المتصفح (اختبار يثبت أن مسارات الكتابة غير معترضة).
  - `GET /api/deployment/hosting` في الطبقة الثابتة: يقول «معاينة ثابتة» و`verification: not-verified`
    ويشير إلى الخطة، مع رفض البناء لأي `CELIA_REAL_SERVICE_URL` غير https.
  - تصحيح تعارض قديم في `docs/free-hosting.md` (كان يمنع النداء الدوري مطلقًا): النداء الدوري استهلاك
    مقصود داخل الحصة، لكنه ليس تشغيلًا مضمونًا.
  - اختبارات: `test/free-hosting-plan.test.js` (4) عقد مستند↔`render.yaml` في الاتجاهين، و3 اختبارات في
    `test/static-shim.test.js`. الإجمالي المحلي **236** اختبارًا.
- **ما لم يُنفَّذ ويحتاج المالك:** إنشاء حساب Aiven/Render، إدخال الأسرار، **تفعيل Pages** (صلاحية الرمز
  تعيد `403 Resource not accessible by integration` — أُعيد فحصها الآن)، تطبيق ترحيلات `agent_*` على قاعدة
  حقيقية، وتنفيذ قائمة القبول §5 بيده. حتى ذلك الحين لا يُقال «متحقق» ولا «24/7».

## الطلب السابق — سد فجوات وإغلاق ثغرات (DEC-016، مدموج في PR #35)

دُقّق الكود الفعلي على `0a0fa2f`، ثم نُفِّذ النطاق القابل للإثبات هنا (G1–G5 من الخطة) ولم يُدَّع ما لم يُختبر.

- **G1 — المصالحة مخرج، لا طريق مسدود:** كان تشغيل `needs_reconciliation` يُرفض فيه `approve()` بـ
  `409 reconciliation_required` ولا مسار يغيّر حالة الاستدعاء، فيبقى ميتًا. الآن
  `POST /api/agent/runs/:id/reconcile` (مالك فقط) يسجّل قرار `applied`/`not_applied` على `tool_run` أو `outbox`،
  **بلا أي استدعاء موصل**، ويستأنف التشغيل فقط إذا لم يبقَ صف غير محسوم.
- **حدود القرار:** لا يُصالح إلا `unknown`/`started` أو `dispatching` بlease منتهٍ (`409 target_not_reconcilable`
  لغير ذلك)، والهدف من تشغيل آخر `400 target_not_in_run` بلا كشف وجوده، ودخول مالك آخر `404` على كل سطح.
- **قرار واحد = حقيقة واحدة:** الاستدعاء والنية المتقارنان بنفس `idempotency_key` يُسوَّيان معًا، فلا تبقى
  نية `sent` مع استدعاء `unknown`.
- **G2 — إعادة محاولة `failed`:** النية الفاشلة تُقبل معها `not_applied` + `resume: true` فقط، وتُعاد بنفس الصف
  والمفتاح ثم تُرسل مرة واحدة بعد قرار مسجل. **ومفتاح الموافقة صار مربوطًا ببصمة الحمولة**
  (`approval:<run>:<tool>:<hash12>`) فلا تركب حمولة مختلفة على قرار سابق — ثغرة أُغلقت بالاختبار.
- **G4 — المُتحقِّق:** فحص `reconciliation_evidence` (نتيجة معلنة محسومة بلا مدخل في السلسلة ⇒ `BLOCK`) و
  `reconciliation_reference` (أثر مؤكد بلا مرجع ولا ملاحظة ⇒ `UNKNOWN`)، ومحاولة فاشلة عولجت بـ`not_applied`
  لم تعد تمنع تسليمًا لاحقًا ناجحًا.
- **G5 — السطح:** لوحة «المصالحة والإعادة» في `/agent` بأزرار صريحة وملاحظة/مرجع، وأحداث
  `reconciliation.recorded`/`run.reconciled` عبر SSE.
- **الفحوص:** `npm test` **229** اختبارًا، **228** ناجحًا محليًا، والإخفاق الوحيد هو `N/N−1` البيئي القائم
  (استنساخ ضحل بعمق commit واحد). `check` 87 ملفًا، `release:check` 0.2.1/schema 1، `check:continuity`،
  `check:secrets`، `build:pages` 8 صفحات، `audit` 0 ثغرات. **لم يُشغَّل** `test:mysql` ولا `test:browser`
  (لا MySQL ولا Chromium هنا).
- **الحدود المعلنة:** لا ترحيل SQL جديد ولا تغيير في `schema 1` أو الإصدار أو أدوات MCP؛ ولا موصلا
  WhatsApp/Drive، ولا تخطيط لغوي، ولا عزل AGENT-003، ولا استئناف تلقائي عند الإقلاع، ولا نشر.

## الطلب السابق — «ابدأ AGENT-002» (outbox + موصل، منفذ ومدموج)

المالك اختار صراحةً متابعة AGENT-002 بعد دمج PR #32. نُفِّذت الشريحة البرمجية كاملة على الفرع الحالي، إضافية فقط:

- **جدول `agent_outbox`** (`sql/migrations/0004_agent-outbox.sql`): نية واحدة لكل أثر، مفتاح `idempotency_key`
  فريد، حالات `pending/dispatching/sent/failed/unknown/cancelled`، lease، مرجع خارجي، وخطأ آمن بلا محتوى خام.
- **الترتيب: نية → قرار → إرسال.** البوابة تسجل النية `pending` قبل طلب الموافقة فيرى المالك الحمولة الدقيقة
  (بما فيها الوقت المقترح حتميًا) قبل أي قرار؛ والرفض يحوّلها `cancelled` فلا أثر خارجي إطلاقًا.
- **إرسال واحد مضمون:** ادعاء شرطي من `pending` فقط؛ صف `dispatching` لا يُدعى ثانية أبدًا — إن انتهت مهلته
  يُسوّى `unknown` للمصالحة، لأن الطلب قد يكون وصل (DEC-007). `recoverStale` يسوّي ولا يرسل.
- **تصنيف فشل صريح:** `failed` فقط عند إثبات عدم الوصول (تحقق/مصادقة/4xx عدا 408 و429)، وكل التباس `unknown`.
- **المُرسِل لا يعتمد على المخطط:** `drainApprovedIntents` تصرّف النوايا المعتمدة قبل سؤال المخطط، فلا تبقى
  موافقة معتمدة بلا تنفيذ.
- **موصل التقويم** (`src/agent/connectors.js`) فوق تفويض Google القائم نفسه: `iCalUID` حتمي من مفتاح الـoutbox،
  وتكرار المزوّد يُفسَّر مصالحة لا موعدًا ثانيًا. الافتراضي **بلا موصلات** (`CELIA_AGENT_CONNECTORS=none`)
  فتبقى `external_connector_unavailable` بدل ادعاء قدرة غير مهيأة.
- **المُتحقِّق** حصل على أربعة فحوص: `outbox_approval`، `outbox_outcome`، `outbox_evidence`، `outbox_tool_run_parity`.
- **الأسطح:** `GET /api/agent/runs/:id/outbox` ولوحة outbox في `/agent`.
- **الفحوص:** 211 اختبارًا، 210 ناجحة محليًا، والإخفاق الوحيد هو اختبار N/N−1 البيئي القائم (استنساخ ضحل).
  `npm run check` و`check:continuity` و`check:secrets` ناجحة. **لم يُشغَّل** `test:mysql` ولا `test:browser`
  محليًا (لا MySQL ولا Chromium في الساندبوكس).
- **CI (run `40517989595` على `77d5d50`):** MySQL 8.4 ✅ (37 ث؛ ترحيل `0004` و9 جداول ومسار إرسال حي على
  InnoDB)، Node 22/24 ✅، container ✅، Python ✅. وظيفة المتصفح أُلغيت عند حد 12 دقيقة لأن تثبيت Chromium
  استغرق 734 ثانية (13 ثانية فقط للاختبار) — حادثة بنية تحتية موثقة في سجل الجلسة، وأُعيد تحفيز التشغيل بدفعة
  توثيقية. لم تُخفَّف أي بوابة ولم يُحذف أي اختبار.
- **الحدود المعلنة:** لا موصل WhatsApp/Drive بعد، لا إعادة محاولة تلقائية لـ`unknown` (تصميمًا)، لا عزل AGENT-003،
  ولا ترحيل إنتاج من هذه البيئة.

## الطلب السابق — حوكمة الوكيل (DEC-014، مدموج في PR #32)

بعد تحليل فجوات خريطة الوكيل (بوابة موافقات مسدودة، غياب عقد هدف ومُتحقِّق وأدلة متسلسلة)، نُفذت الشريحتان 2 و3
من خارطة الطريق على فرع نظيف من أحدث main. كل تشغيل الآن يحمل عقد بيانات، وكل قرار موافقة يُحفظ ويُستأنف،
وكل حقيقة تُقيَّد في سلسلة بصمات، ولا تسليم بلا حكم مستقل.

- **عقد الهدف:** `src/agent/goal-contract.js` + جدول `agent_goal_contracts` — معايير نجاح وقيود وشروط توقف
  وميزانية وموعد نهائي، بناء حتمي من حدود التشغيل وتحقق بنيوي آلي.
- **بوابة الموافقات:** جدول `agent_approvals` + `POST /api/agent/runs/:id/approval` (و`GET .../approvals`) —
  قرار `approved`/`rejected` بمفتاح idempotency وممثل وملاحظة. **القاعدة الصارمة:** استدعاء `unknown`/`started`
  يمنع الاستئناف بـ`409 reconciliation_required`؛ الرفض يلغي بلا أثر؛ الموافقة بلا منفذ outbox تنتهي
  بـ`external_connector_unavailable` لا بنجاح وهمي.
- **سجل الأدلة:** `src/agent/evidence.js` + جدول `agent_evidence` — إضافي فقط، `prev_hash`/`hash` من SHA-256
  وجذر genesis لكل تشغيل؛ كشف العبث/الحذف بالرقم والسبب في الاختبارات؛ والاستدعاء المقطوع يُعاد بناؤه كمدخل
  `tool_call_reconciled` صادق.
- **المُتحقِّق المستقل:** `src/agent/verifier.js` بأحكام `PASS`/`BLOCK`/`UNKNOWN` وسبع فحوص، خطوة `verify`
  إلزامية قبل `deliver`؛ إعادة تنفيذ القراءات الحتمية المعلّمة صراحةً فقط، و`UNKNOWN` معلن للآثار غير القابلة
  للقراءة بدل التخمين.
- **الترحيل:** `sql/migrations/0003_agent-governance.sql` إضافي بثلاثة جداول (8 جداول `agent_*` الآن)؛ الجداول
  الخمسة الأساسية و`schema 1` والإصدار `0.2.1` بلا مساس. SQLite ينشئها عند الفتح، MySQL عبر سجل الترحيل.
- **الواجهة:** `/agent` تعرض العقد ولوحة الموافقات (قرار وملاحظة) وسجل الأدلة وشارة الحكم وسلامة السلسلة.
- **الفحوص:** 31 اختبارًا جديدًا (4 عقد + 9 موافقات + 6 أدلة + 8 تحقق + 4 مسارات HTTP)؛ الإجمالي 185، الأخضر
  المحلي 184 والإخفاق الوحيد عائق استنساخ git ضحل قائم قبل الجلسة (اختبار N/N−1 يحتاج عمق التاريخ الكامل).
  فحص حي على خادم كامل: تدفق انتظار→موافقة→استئناف→`succeeded` بحكم PASS وسلسلة 7 مداخل، والرفض→`cancelled`.
- **الحدود المعلنة (سياق تاريخي — تجاوزها DEC-015):** حينها لم يكن هناك outbox ولا اتصال خارجي فعلي (باقي
  AGENT-002)، ولا عزل sandbox (AGENT-003)، ولا مخطط لغوي، ولا ترحيل MySQL حي من تلك البيئة. الـoutbox نُفِّذ
  لاحقًا في جلسة 2026-10-27-agent-outbox.

## طلب أقدم — «نفذ بالكامل بشكل انتاجي» (شبكة المعرفة KB-01…KB-004، مدموج)


بعد تصميم شبكة المعرفة نصيًا، أمر المالك بتنفيذها إنتاجيًا. المنفَّذ الآن في `src/knowledge/` و`src/kb-routes.js`
و`public/kb.*` و`data/kb/` و`scripts/kb*.mjs`:

- **السجلات:** 5 ملفات CSV (56 صفًا) مولّدة من الكود، مع `manifest.json` ببصمات SHA-256؛ تعديل يدوي بلا `kb:manifest`
  يُفشل الاستيراد. كل صف يحمل ترخيصًا وثقة ومصدرًا، وأي سر أو خطر مخالف لـ`CANONICAL_TOOLS` يُرفض برمزه وسطره.
- **المخزن:** SQLite + FTS5 بمخطط إصدار 1 مستقل عن `schema: 1`؛ `UNIQUE(content_hash)`، `item_aliases`،
  `absent_since` بدل الحذف، وكل كيان/حافة لها `evidence_item_id` إلزامي.
- **الاسترجاع:** تطبيع عربي مع خريطة إزاحات، توسيع سوابق/لواحق عند الاستعلام فقط، و`score = 0.55 lexical + 0.20 trust
  + 0.15 freshness + 0.10 graph`، وحزمة أدلة بسقف `limit/maxChars` وإعلان `truncated/omitted`، وسبب صريح عند عدم المطابقة.
- **الأسطح:** `/api/kb` مالك فقط بلا كتابة، و`import` معطّل إلا ببوابة صريحة؛ `kb.search`/`kb.tool_profile`/
  `kb.project_context` أدوات وكيل قراءة فقط تُسجَّل فقط عند `CELIA_KB=sqlite`، والمخطط يسرد المراجع الفعلية في التسليم
  ويعمل بلا LLM. صفحة `/kb` عربية RTL ببناء DOM آمن.
- **الأدلة المقاسة:** `verify` 56 مضافًا/55 حافة/0 مرفوض · إعادة استيراد `unchanged 56` · «كيف أربط جوجل» → 3 نتائج ·
  «موعد تقويم» → كيان التقويم بخطره وموافقته · `npm test` **153/153** · `check` 78 ملفًا · `celia:mcp:verify` 12 أداة بلا تغيير.
- **الحدود المعلنة:** Drive غير مزامن، لا embeddings ولا بحث دلالي، تخطيط حتمي لا لغوي، فهرس محلي لا يُدَّعى دوامه
  (`status.durability.persistent=false`)، والنسخة البعيدة المشفرة غير منفذة (KB-004 باقٍ). Claude/Drive/NAS ليست بديلًا موثقًا.
- **CI حقيقي أخضر على `dc17493` (run `40502456740`):** الوظائف السبع ناجحة (Node 22/24، MySQL 8.4، الحاوية،
  المتصفح RTL، Python)، وخطوتا المعرفة — `verify/import/search/entity/stale` و«التصدير ثم الاستعادة» — ناجحتان
  داخل وظيفتي Node. هذا دليل CI لا دليل إنتاج.

## الطلب السابق — AGENT-001/M1 + COMP-003 (مكتمل جزئيًا ومدموج)

طلب المالك: **«بقدر ما تستطيع»** — تنفيذ فعلي لا خطوات، وتوقف صريح عند أي بطاقة/تكلفة. في هذه الجلسة نُفِّذ
المسار الوحيد القابل للإثبات بلا حساب خارجي: **حلقة الوكيل M1** ومعه **سجل الترحيل**.

- **منفذ ومختبر (AGENT-001 جزئيًا):** `src/agent/{drivers,store,runtime,tools,planner,index}.js` + `src/agent-routes.js`
  + `public/agent.{html,css,js}`: خيوط/رسائل/تشغيلات/خطوات/استدعاءات دائمة، قفل lease، استئناف من آخر خطوة مؤكدة،
  `needs_reconciliation` لأي استدعاء غير محسوم، إلغاء، ميزانيات خطوة/تكلفة/زمن، بوابة مخاطر، SSE، وملكية على كل صف.
  التخزين صريح: `CELIA_AGENT_RUNTIME=mysql|sqlite`، والافتراضي `off` — **لا ذاكرة ولا ارتداد صامت**.
- **منفذ ومختبر (COMP-003 جزئيًا):** `scripts/migrate.mjs` + `sql/migrations/0002_agent-runtime.sql` مع سجل
  `schema_migrations` وبصمات SHA-256 ورفض drift وdry-run افتراضي؛ الجداول الخمسة الأساسية و`schema 1` بلا مساس.
- **الفحوص المحلية:** `npm test` **124/124** (منها 25 اختبارًا جديدًا)، `npm run check` 69 ملفًا، `release:check`
  0.2.1/schema 1، `check:continuity` ناجح، `check:secrets` ناجح، `celia:mcp:verify` 12 أداة، `build:pages` 7 صفحات،
  `npm audit` 0 ثغرات.
- **CI حقيقي أخضر على `5cfa05d` (run `40499146250`):** Node 22/24 و**MySQL 8.4** — والوظيفة الأخيرة شغّلت اختبار
  الوكيل الجديد على MySQL حقيقي: الترحيل `0002_agent-runtime.sql` طُبق مرتين (idempotent)، وحلقة كاملة نُفذت
  ودُهست، وتكرار `client_message_id` لم يُنفّذ ثانيًا، واستدعاء منقطع أصبح `unknown` بلا إعادة. **هذا دليل MySQL
  الحقيقي الوحيد؛ لا يوجد اختبار على قاعدة إنتاج.**
- **لم يُنفَّذ محليًا ويُصرَّح به:** MySQL محلي (لا خدمة هنا؛ غطّاه CI)، اختبار متصفح محلي (لا Chromium؛ غطّاه CI)،
  مخطط لغوي/مزوّد AI (AI-002)، أثر خارجي (AGENT-002)، عزل (AGENT-003)، استئناف تلقائي عند الإقلاع، وأي نشر دائم.
- **النشر المجاني ما زال محجوبًا بصلاحية الحساب:** `gh api` يعيد `has_pages=false`، ومحاولة التفعيل من الجلسة ما زالت
  `403` — وأثبت تشغيل `Agent branch Pages preview` (`40497695505`) أن `configure-pages` مع `enablement: true`
  يفشل بالخطأ نفسه من داخل Actions. إذن نقرة المالك في Settings → Pages لا بديل عنها (HOST-003). لا Render/Aiven
  بلا بطاقة/تفويض.
- **الحد المعلن:** لا يُوصف النظام بأنه «مثل Manus». الحلقة حقيقية ودائمة، لكن التخطيط حتمي تجريبي والتنفيذ
  خارجيًا مرفوض بالتصميم حتى المراحل التالية.

## الطلب السابق — GOOG-002 (مكتمل ومدموج)

قال المالك: **«الغرض نظام متكامل مثل مانوس»** — أي أن الهدف المنتجي هو وكيل ينفّذ مهمة كاملة لا مساعد
يستدعي أداة واحدة. الاستجابة المنتجية الموثقة هي [خطة الوكيل](../agent-runtime-plan.md)
(تحليل قدرات Manus السبع، الفجوة الفعلية بالدليل من الكود، معمارية M1–M4، حدود مستحيلة على الطبقة المجانية)،
DEC-012، وأربعة صفوف AGENT. **جلسة تثبيت CLI الحالية لا تنفذ AGENT-001 ولا تضيف ادعاء قدرة** — النظام اليوم
مساعد موصول بأدوات، ووصفه بأنه «مثل Manus» ممنوع حتى إنجاز AGENT-001.

**منفذ (GOOG-001):** `src/consent-ticket.js` (تذكرة HMAC بعشرة دقائق ومفتاح مشتق بفصل نطاق) ·
`POST /api/google/consent-link` (مالك فقط) · `GET /auth/google?ticket=` عام يتحقق من التوقيع والصف غير المستخدم
قبل التحويل · أمر واتساب «اربط جوجل» يعمل فقط من `APP_OWNER_PHONE_E164`. **8/8 اختبارات** في
`test/google-consent.test.js` والمجموع **83/83**. **لم يُختبر ربط حي مع Google** (لا اعتماد ولا نطاق عام).

**منفذ (GOOG-002، مدموج في PR #28 عند `10b9b5d`):** `src/google-preflight.js` (10 فحوص بيئة بحالات
pass/warn/fail، بلا شبكة وبلا طباعة أي سر) · `npm run google:doctor` · `GET /api/google/preflight`
(مالك فقط) · قسم 6 في [دليل الربط](../google-connect.md). **تثبيت CLI في هذه الجلسة:** صار `--json`
يُخرج JSON وحده، مع الأمر الموثق `npm run --silent google:doctor -- --json` لمنع ترويسة npm؛ أُضيفت
3 اختبارات CLI للنجاح والفشل وعدم التسريب، فصارت فحوص GOOG-002 **15/15** والمجموع **98/98** و`npm run check`
على **62** ملفًا. **PR #27 وPR #28 مدموجان**، وتثبيت CLI محفوظ في [PR #29](https://github.com/celiaelazamey-arch/phone-google/pull/29) للمراجعة؛ لا يثبت الفحص قبول Google نفسه ولا يُغني عن `200` حي.

**سياق (جلسة جوجل):** المالك أرسل مقتطف ربط Google من محادثة أخرى ليُضاف إلى `src/server.js`. التدقيق بالكود أثبت أن
الربط **منفذ بالفعل** في `src/google.js` بشكل أقوى، وأن المقتطف غير صالح هنا: `require` في مشروع ESM، وملف
`server.js` لا يحوي مسارات، و`state: req.query.phone` ثغرة CSRF، وحفظ توكنات خامة في جدول غير موجود، ونطاق
`calendar` أوسع من الحاجة. لا يُنسخ. الفجوة الحقيقية = ملف اعتماد + نطاق HTTPS عام + رابط أحادي الاستخدام
(GOOG-001) للربط من واتساب بلا كشف Bearer.

**أربعة قرارات مطلوبة من المالك قبل M1:** مستوى الاستقلالية الافتراضي (موافقة لكل أثر خارجي أم تفويض مسبق
بنطاق) · العمودي الأول (Google Workspace أم WhatsApp أم ملفات) · الميزانية (مجاني حتى M2 أم عامل تنفيذ من
الآن) · تعدد المستخدمين (مالك واحد الآن أم عزل كامل من البداية).

## الطلب السابق (مكتمل/مستمر)

المستخدم وجّه في رسالة ثنائية الجزء: (1) التحقق من إنجاز «توظيف أسرار المستودع التسعة + إصلاح توافق MCP 0.2.0» — تحقّق: PR #24 مدموج بـ`017507b` وفحوصه كلها خضراء؛ و(2) بناء **Celia Google Spider v0.1.0** وفق مواصفة كاملة: حزمة `celia_spider/` (`google_drive.py` و`store.py` و`server.py` و`text_utils.py` و`config.py`)، فهرس محلي في `~/.celia_spider/knowledge.sqlite3` (يُعاد تحديده عبر `CELIA_SPIDER_DATA_DIR`)، ست أدوات MCP، حد 2000 ملف، أول ورقة Sheet فقط، **لا حذف تلقائي** لعناصر محلية غائبة عن Drive، **لا embeddings/بحث دلالي**، **ChatGPT خارج النطاق**، `.gitignore` لـ`credentials.json` و`token.json` وقاعدة البيانات، سكربتات Windows، README عربي بالمراجع، اختبارات unittest وpytest، ترخيص MIT، وتسليم مصدرًا + ZIP.

متطلبات ثابتة مستمرة: قواعد `AGENTS.md` (فرع البيئة فقط، لا تفويض تجاوز الفرع، استمرارية STATE + سجل الجلسة مع ملفات التنفيذ)، عدم كشف أي من أسرار المستودع التسعة ولا ملفات OAuth، عدم اختلاق محتوى (إن زوّد المالك `RULE.MD` يُحفظ حرفيًا وتُوثّق الفروق في `DECISIONS.md`)، وعدم إنشاء مستودع GitHub جديد أو دفع خارج الفرع المعطى دون تأكيد صريح.

## الواقع والهوية

- المستودع: `celiaelazamey-arch/phone-google`؛ خط الأساس لهذه الجلسة `10b9b5dd4ca81e7b53541819b795d369fd859120` (دمج PR #28 على `main`). طلبات PR #17 و#21 و#22 و#23 و#24 و#25 و#26 و#27 و#28 مدموجة.
- الفرع المعطى لهذه الجلسة: `arena/bc862105-phone-google` على خط أساس `c3c42e2` (دمج PR #29). تحقّق دائمًا من الفرع النشط ولا تنشئ أو تنتقل لفرع آخر. (`arena/69d96c03-…` و`arena/24d51c71-…` و`arena/051ed103-…` و`arena/20079390-…` و`arena/64505100-…` انتهت بعد الدمج ولا يُعدّل منها شيء.)
- الكود الحالي `0.2.1` / السابق `0.2.0` / `schema: 1` كما هي دون أي تعديل. جداول الوكيل `agent_*` إضافية عبر سجل ترحيل مستقل (DEC-013) ولا تغيّر مخطط الجداول الخمسة.
- كان المستودع مقتطاعًا (shallow) بعمق 1؛ نجح `git fetch --unshallow origin` في هذه الجلسة، فصار commit قاعدة 0.2.0 متاحًا وعمل اختبار N/N−1. أي استنساخ جديد يحتاج الخطوة نفسها قبل `npm test`.
- لا رابط Render/Aiven دائم منشأ (HOST-003 بانتظار تفويض المالك).

## سجل العمل السابق (مكتمل) — حزمة السبّابة SPDR-001

1. **حزمة `celia-google-spider/` (SPDR-001 / DEC-011) — مكتملة:**
   - 17 ملف مصدرًا: `pyproject.toml` (0.1.0، Python ≥3.11، MIT) و`LICENSE` و`.gitignore` معزول للاعتمادات والقوالب و`celia_spider/{__init__,config,text_utils,store,google_drive,auth,check,server}.py` و`tests/` (3 ملفات) و`install_windows.bat` و`run_server.bat` و`README.md` عربي، وأرشيف `dist/celia-google-spider-v0.1.0.zip` (متجاهل في Git، سلامته مختبرة).
   - الأدوات الست عبر stdio فقط: مزامنة (إدراج/تحديث بلا حذف)، بحث معجمي بمقتطف ومصدر، قراءة، استكشاف شبكة، مصادر، إحصاءات. خادم MCP يتوافق مع مخططتَي SDK (`MCPServer` مع ارتداد `FastMCP`) ومصافحة stdio حقيقية في الاختبارات تضبط الأدوات الست بالضبط.
   - الحدود مكتوبة في README الحزمة: قراءة فقط (`drive.readonly`)، Docs→نص وSheets→CSV للأولى فقط، بلا embeddings، بلا ChatGPT، بلا مزامنة حية قبل اعتماد المالك وملف اعتماده (SPDR-002).
2. **وظيفة CI اختيارية:** إضافة `spider` في `.github/workflows/celia-mcp.yml` (Python 3.11 بمفتاح SHA مثبت) لتشغيل `unittest` + `pytest` + `compileall` بلا أي بيانات اعتماد.
3. **الاستمرارية:** تحديث `STATE.md` وسجل جلسة جديد `sessions/2026-10-27-celia-google-spider.md`، صفّا SPDR-001/SPDR-002 في `BACKLOG.md`، DEC-011 في `DECISIONS.md`، ومؤشر الحزمة في `README.md` الجذري.

## تغيير سابق موثق (SPDR-003)

- `celia-google-spider/README.md` قسم «المراجع»: السطر المعنون «Python quickstart» كان يشير إلى
  `guides/manage-downloads` — صُحّح إلى `quickstart/python`، وأُضيف فهرس REST v3 ودليل التنزيلات
  كسطرين منفصلين، وبقي رابط الحصص. الروابط الثلاثة على المسار القانوني `/workspace/drive/…`.
- **تدقيق:** لا workflow يستخدم `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`؛ ذكر `pages.yml` لهما هو فحص
  تسرّب في `dist` فقط. إضافتهما إلى Repository secrets لا تفعّل مزامنة ولا أي خطوة بذاتها؛ وصولهما للتشغيل
  عبر `.env` المحلي أو متغيرات Render إلى `src/config.js` و`src/celia-mcp.js`.
- التفاصيل والفحوص في `sessions/2026-10-27-reference-link-fix.md`.

## التحقق الحالي

**جلسة حوكمة الوكيل (2026-10-27، الفرع `arena/9c083c60-phone-google`):** بيئة Node 22.22.3 بلا MySQL/Chromium.

- `npm test`: **185 اختبارًا، 184 خضراء**. الجديد 31 اختبار حوكمة (4 عقد هدف، 9 موافقات، 6 أدلة، 8 مُتحقِّق،
  4 مسارات HTTP). الإخفاق الوحيد سابق للجلسة: اختبار توافق N/N−1 يحتاج كائن commit الأساس في مستنسخ غير ضحل.
- `npm run check`: 83 ملف JS · `release:check`: `0.2.1`/schema 1 · `check:continuity`: ناجح ·
  `celia:mcp:verify`: 12 أداة · `build:pages`: 8 صفحات · `audit`: 0 ثغرات.
- فحص حي بخادم كامل (SQLite للوكيل، MySQL منحط معلن): انتظار موافقة → قرار → استئناف → `succeeded` بحكم PASS
  وسلسلة أدلة 7 مداخل سليمة؛ مسار الرفض → `cancelled` بلا أثر؛ رموز 400/401/409 مسلكها صحيح.
- ترحيل `0003_agent-governance.sql` **مطبَّق على MySQL 8.4 حي في CI ومتحقق منه**: وظيفة MySQL في run
  `40511042421` (PR #32) خضراء، واختبار التكامل يؤكد تطبيق الترحيلين معًا (`0002`+`0003`)، ووجود 8 جداول
  `agent_*`، واكتمال حلقة الوكيل على قاعدة حقيقية. لا تطبيق على قاعدة إنتاج — CI فقط على مخطط معزول مؤقت.
- **الحالة النهائية لـPR #32:** كل الفحوص السبع خضراء في run `40513964269` (آخر دفعة `b9d9529`): Node 22/24،
  MySQL 8.4، الحاوية، RTL للمتصفح (40 ثانية)، Python، الخارجي skipped. حادثة عابرة واحدة في run `40511560404`:
  إلغاء وظيفة المتصفح لمهلة 12 دقيقة **أثناء تنزيل Chromium قبل أي اختبار** (بنية تحتية، لا كود) — موثقة في سجل
  الجلسة، وإعادة تشغيل API محظورة (403) فحُفز المسار بدفعة توثيقية ونجح. المعاينة الحيّة على المنفذ 3000 لا تزال
  ترد 200 على `/healthz` و`/agent` و`/kb` و`/system`.

**الأرقام السابقة موثقة كما هي (جلسة شبكة المعرفة):** بيئة محلية Node 22.22.3 / npm 10.9.8، بلا MySQL أو Docker أو Chromium:

- `npm test`: **153/153** ناجحة بعد `git fetch --unshallow`. الجديد: `knowledge-normalize` 6، `knowledge-ingest` 9،
  `knowledge-store` 8، `kb-routes` 6، إضافة إلى اختبارات الوكيل 25.
- `npm run check`: ناجح — 78 ملف JavaScript.
- `npm run kb -- verify|import|search|export`: ناجحة على قاعدة نظيفة — 56 عنصرًا و55 حافة و0 مرفوض، والاستيراد الثاني متطابق.
- `npm run release:check`: ناجح — `0.2.1` / السابق `0.2.0` / `databaseSchema: 1`.
- `npm run check:continuity`: ناجح — 23 وثيقة و59 رابطًا و47 معرفًا بلا دورات.
- `npm run check:secrets`: ناجح · `npm run celia:mcp:verify`: ناجح — 12 أداة، `storage=memory` صريح.
- `npm run build:pages`: ناجح — 7 صفحات (`agent.html` و`kb.html` ضمنها) · `npm audit --omit=dev --audit-level=moderate`: 0 ثغرات.
- `npm run migrate` (dry-run) و`-- --apply` **لم يُنفَّذا**: لا MySQL في البيئة؛ الكود يرفض الذاكرة ويطلب قاعدة حقيقية.
- اختبارات المتصفح وMySQL 8.4 تُشغَّل في CI فقط. **لا نتيجة CI لهذه الجلسة بعد الدفع** — المرجع الحي هو PR الفرع.

## حدود لا يجوز نسيانها

- فرع الجلسة الحالية `arena/0220ec0b-phone-google` هو الوحيد للعمل والدفع (يحوي فرع PR #36 مدمجًا)؛ أسماء الفروع المذكورة في الأقسام التاريخية تخص جلسات منتهية بعد الدمج ولا يُعمل عليها.
- أسرار المستودع التسعة لا تُقرأ ولا تُطبع ولا تُضاف لملفات الحزمة؛ و`credentials.json` و`token.json` ممنوعان من Git مهما طُلب من التوثيق.
- الحزمة ليست موصلة ChatGPT (خارج النطاق صراحةً) ولا تدّعي بحثًا دلاليًا ولا حذفًا تلقائيًا، ولا يُعلن نشرها كمكوّن من النظام قبل قبول المالك (SPDR-002).
- لا مستودع GitHub جديد ولا دفع خارج فرع الجلسة الحالي؛ لا releases ولا دمج/إغلاق PR من هذه الجلسة دون طلب صريح (ينطبق على #34 و#36).
- شبكة المعرفة ليست «بحثًا دلاليًا» وليست مزامنة Drive، ولا يُعرض فهرس محلي كأنه مخزن دائم على مضيف بلا قرص.
- إن زوّد المالك `RULE.MD`: حفظ حرفي في الجذر وتوثيق الفروق في `DECISIONS.md` دون اختلاق.
- مهام الخطة الأخرى تبقى كما هي في `BACKLOG.md` (COMP-001/DATA-001/SEC-001… ) دون ادعاء إغلاقها.

## الخطوة التالية بالضبط

1. **المالك (الركن 0):** دمج PR #36 ثم هذا الفرع (أو هذا الفرع وحده)، وإغلاق PR #34 بلا دمج. بعد الدمج تأكد أن
   وظيفة `deploy` في `pages.yml` **لم تُتخطَّ** وأن `https://celiaelazamey-arch.github.io/phone-google/` يفتح.
2. **المالك (الركن 1 — HOST-003):** Aiven Free ← Render Blueprint ← أسرار ← `empty-only` ثم `false` ←
   `npm run migrate -- --apply` ← `CELIA_AGENT_RUNTIME=mysql` + `CELIA_AGENT_RESUME_ON_BOOT=true` ← cron-job.org
   كل 10 دقائق على `/readyz` ← `CELIA_MCP_API_TOKEN=… npm run verify:live -- --url … --expect-commit …` ⇒ PASS
   يُلصق في سجل جلسة جديد ويُحدَّث HOST-003 إلى «متحقق».
3. **بعدها من هنا (الركن 7):** `backup:verify` (DATA-001)، موصل WhatsApp في الـoutbox (AGENT-002)، ثم AI-001/AI-002
   بعد قرار المزوّد. التفاصيل والبوابات في [docs/go-live-plan.md](../go-live-plan.md).
4. **بقية الخطة** كما هي في BACKLOG دون ادعاء إغلاقها.
5. **واقع الخدمات (QA-005):** قبل أي ادعاء «يعمل»، شغّل `[reality]` واقرأ annotations الـrun؛ الست الفاشلة في
   [docs/service-reality.md](../service-reality.md) لا تُصلحها شيفرة — تجديد أو تقاعد صريح بـ`CELIA_DISABLE_*`.

## التحقق من الحفظ في الجلسة التالية

```sh
git branch --show-current
git status --short
git log -3 --oneline
gh pr list --state all --head "$(git branch --show-current)"
npm run check && npm run check:secrets && npm run check:continuity && npm test
cd celia-google-spider && python -m unittest discover -s tests -q
```
