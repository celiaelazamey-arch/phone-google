# الحالة الحالية — ابدأ من هنا

**آخر مراجعة:** 27 أكتوبر 2026 · **نوع الجلسة الحالية:** تنفيذ **AGENT-001/M1 + COMP-003** — حلقة وكيل دائمة وسجل ترحيل، بلا نشر وبلا ادعاء Manus · سجل الجلسة: [2026-10-27-agent-m1-runtime](sessions/2026-10-27-agent-m1-runtime.md)

## الطلب الحالي (أعلى أولوية) — تنفيذ لا إرشاد، وبلا بطاقة

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

بيئة محلية Node 22.22.3 / npm 10.9.8، بلا MySQL أو Docker أو Chromium:

- `npm test`: **124/124** ناجحة بعد `git fetch --unshallow`. الجديد: `test/agent-store.test.js` 6/6،
  `test/agent-runtime.test.js` 16/16، `test/agent-routes.test.js` 3/3.
- `npm run check`: ناجح — 68 ملف JavaScript (كان 62).
- `npm run release:check`: ناجح — `0.2.1` / السابق `0.2.0` / `databaseSchema: 1`.
- `npm run check:continuity`: ناجح — 23 وثيقة و59 رابطًا و47 معرفًا بلا دورات.
- `npm run check:secrets`: ناجح · `npm run celia:mcp:verify`: ناجح — 12 أداة، `storage=memory` صريح.
- `npm run build:pages`: ناجح — 7 صفحات (`agent.html` ضمنها) · `npm audit --omit=dev --audit-level=moderate`: 0 ثغرات.
- `npm run migrate` (dry-run) و`-- --apply` **لم يُنفَّذا**: لا MySQL في البيئة؛ الكود يرفض الذاكرة ويطلب قاعدة حقيقية.
- اختبارات المتصفح وMySQL 8.4 تُشغَّل في CI فقط. **لا نتيجة CI لهذه الجلسة بعد الدفع** — المرجع الحي هو PR الفرع.

## حدود لا يجوز نسيانها

- أسرار المستودع التسعة لا تُقرأ ولا تُطبع ولا تُضاف لملفات الحزمة؛ و`credentials.json` و`token.json` ممنوعان من Git مهما طُلب من التوثيق.
- الحزمة ليست موصلة ChatGPT (خارج النطاق صراحةً) ولا تدّعي بحثًا دلاليًا ولا حذفًا تلقائيًا، ولا يُعلن نشرها كمكوّن من النظام قبل قبول المالك (SPDR-002).
- لا مستودع GitHub جديد ولا دفع خارج `arena/bc862105-phone-google`؛ لا releases ولا دمج PR من هذه الجلسة دون طلب صريح.
- إن زوّد المالك `RULE.MD`: حفظ حرفي في الجذر وتوثيق الفروق في `DECISIONS.md` دون اختلاق.
- مهام الخطة الأخرى تبقى كما هي في `BACKLOG.md` (COMP-001/DATA-001/SEC-001… ) دون ادعاء إغلاقها.

## الخطوة التالية بالضبط

1. **CI الفرع:** بعد الدفع، تأكد من خضرة `verify` (Node 22/24) و`mysql` — ثم أضف إلى وظيفة MySQL تشغيل
   `npm run migrate` (dry-run) و`-- --apply` على خدمة MySQL 8.4، وإعادة قراءة `-- --status` للتأكد من عدم drift.
   لا تعلن دعم MySQL الدائم قبل رؤية ذلك.
2. **PLANNER-الحقيقي (AI-002):** واجهة `plan()` جاهزة؛ يلزم مزوّد + تحقق JSON صارم + ميزانية + مجموعة تقييم
   عربية قبل أي وصف للوكيل بالذكاء. لا مفاتيح في المتصفح ولا سجلات.
3. **AGENT-002:** outbox وموافقات مصنّفة قبل تشغيل أي أداة `external_effect`؛ اختبار «انقطاع بعد الإرسال» يجب
   أن ينتج `unknown` ومصالحة لا إرسالًا ثانيًا.
4. **HOST-003 (للمالك):** نقرة تفعيل Pages (Settings → Pages → Source: GitHub Actions) و/أو تفويض Render+Aiven.
   من هذه الجلسة: التفعيل عبر API ما زال 403؛ لا بطاقة ولا تجاوز تحقق.
5. **بقية الخطة** كما هي في BACKLOG (COMP-001/DATA-001/SEC-001/QA-004…) دون ادعاء إغلاقها بهذا التسليم.

## التحقق من الحفظ في الجلسة التالية

```sh
git branch --show-current
git status --short
git log -3 --oneline
gh pr list --state all --head "$(git branch --show-current)"
npm run check && npm run check:secrets && npm run check:continuity && npm test
cd celia-google-spider && python -m unittest discover -s tests -q
```
