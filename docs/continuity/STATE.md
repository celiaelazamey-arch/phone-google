# الحالة الحالية — ابدأ من هنا

**آخر مراجعة:** 27 أكتوبر 2026 · **نوع الجلسة الحالية:** جوجل أولًا — تنفيذ GOOG-001 (رابط ربط أحادي الاستخدام + أمر واتساب للمالك) و[دليل ربط Google](../google-connect.md)

## الطلب الحالي (أعلى أولوية)

قال المالك: **«الغرض نظام متكامل مثل مانوس»** — أي أن الهدف المنتجي هو وكيل ينفّذ مهمة كاملة لا مساعد
يستدعي أداة واحدة. الاستجابة في هذه الجلسة **وثائقية فقط**: [خطة الوكيل](../agent-runtime-plan.md)
(تحليل قدرات Manus السبع، الفجوة الفعلية بالدليل من الكود، معمارية M1–M4، حدود مستحيلة على الطبقة المجانية)،
DEC-012، وأربعة صفوف AGENT. **لا كود ولا مخطط جديد ولا ادعاء قدرة** — النظام اليوم مساعد موصول بأدوات،
ووصفه بأنه «مثل Manus» ممنوع حتى إنجاز AGENT-001.

**منفذ (GOOG-001):** `src/consent-ticket.js` (تذكرة HMAC بعشرة دقائق ومفتاح مشتق بفصل نطاق) ·
`POST /api/google/consent-link` (مالك فقط) · `GET /auth/google?ticket=` عام يتحقق من التوقيع والصف غير المستخدم
قبل التحويل · أمر واتساب «اربط جوجل» يعمل فقط من `APP_OWNER_PHONE_E164`. **8/8 اختبارات** في
`test/google-consent.test.js` والمجموع **83/83**. **لم يُختبر ربط حي مع Google** (لا اعتماد ولا نطاق عام).

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

- المستودع: `celiaelazamey-arch/phone-google`؛ خط الأساس لهذه الجلسة `5dead2c888d445fcaf18e4a1717a282d616a8fa3` (دمج PR #26 على `main`). طلبات PR #17 و#21 و#22 و#23 و#24 و#25 و#26 مدموجة.
- الفرع المعطى لهذه الجلسة: `arena/051ed103-phone-google`. تحقّق دائمًا من الفرع النشط ولا تنشئ أو تنتقل لفرع آخر. (الفرعان `arena/64505100-…` و`arena/20079390-…` انتهيا بعد الدمج ولا يُعدّل منهما شيء.)
- الكود الحالي `0.2.1` / السابق `0.2.0` / `schema: 1` كما هي دون أي تعديل — حزمة السبّابة طرفية لا تمس Node أو المخطط.
- المستودع مقتطاع (shallow) بعمق 1؛ اختبار توافق 0.2.0 يحتاج commit قاعدة `2508893bd7e6d447b2e19374933556322cc9cdb7` محليًا (`git fetch --depth=1 origin <sha>`) — جُلب في هذه الجلسة فصار 75/75.
- لا رابط Render/Aiven دائم منشأ (HOST-003 بانتظار تفويض المالك).

## سجل العمل السابق (مكتمل) — حزمة السبّابة SPDR-001

1. **حزمة `celia-google-spider/` (SPDR-001 / DEC-011) — مكتملة:**
   - 17 ملف مصدرًا: `pyproject.toml` (0.1.0، Python ≥3.11، MIT) و`LICENSE` و`.gitignore` معزول للاعتمادات والقوالب و`celia_spider/{__init__,config,text_utils,store,google_drive,auth,check,server}.py` و`tests/` (3 ملفات) و`install_windows.bat` و`run_server.bat` و`README.md` عربي، وأرشيف `dist/celia-google-spider-v0.1.0.zip` (متجاهل في Git، سلامته مختبرة).
   - الأدوات الست عبر stdio فقط: مزامنة (إدراج/تحديث بلا حذف)، بحث معجمي بمقتطف ومصدر، قراءة، استكشاف شبكة، مصادر، إحصاءات. خادم MCP يتوافق مع مخططتَي SDK (`MCPServer` مع ارتداد `FastMCP`) ومصافحة stdio حقيقية في الاختبارات تضبط الأدوات الست بالضبط.
   - الحدود مكتوبة في README الحزمة: قراءة فقط (`drive.readonly`)، Docs→نص وSheets→CSV للأولى فقط، بلا embeddings، بلا ChatGPT، بلا مزامنة حية قبل اعتماد المالك وملف اعتماده (SPDR-002).
2. **وظيفة CI اختيارية:** إضافة `spider` في `.github/workflows/celia-mcp.yml` (Python 3.11 بمفتاح SHA مثبت) لتشغيل `unittest` + `pytest` + `compileall` بلا أي بيانات اعتماد.
3. **الاستمرارية:** تحديث `STATE.md` وسجل جلسة جديد `sessions/2026-10-27-celia-google-spider.md`، صفّا SPDR-001/SPDR-002 في `BACKLOG.md`، DEC-011 في `DECISIONS.md`، ومؤشر الحزمة في `README.md` الجذري.

## آخر تغيير في هذه الجلسة (SPDR-003)

- `celia-google-spider/README.md` قسم «المراجع»: السطر المعنون «Python quickstart» كان يشير إلى
  `guides/manage-downloads` — صُحّح إلى `quickstart/python`، وأُضيف فهرس REST v3 ودليل التنزيلات
  كسطرين منفصلين، وبقي رابط الحصص. الروابط الثلاثة على المسار القانوني `/workspace/drive/…`.
- **تدقيق:** لا workflow يستخدم `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`؛ ذكر `pages.yml` لهما هو فحص
  تسرّب في `dist` فقط. إضافتهما إلى Repository secrets لا تفعّل مزامنة ولا أي خطوة بذاتها؛ وصولهما للتشغيل
  عبر `.env` المحلي أو متغيرات Render إلى `src/config.js` و`src/celia-mcp.js`.
- التفاصيل والفحوص في `sessions/2026-10-27-reference-link-fix.md`.

## التحقق الحالي

بيئة محلية Python 3.11.2 / Node 22.22.3 / npm 10.9.8:

- `python -m unittest discover -s tests -v` (داخل `celia-google-spider/`): **10/10 ناجحة** (شاملة مصافحة MCP stdio).
- `python -m pytest -q`: **10 passed**. و`python -m compileall -q celia_spider tests` سليم.
- `zip -T dist/celia-google-spider-v0.1.0.zip`: سليم (19 ملفًا، بلا اعتمادات أو فهارس).
- `npm run check`: ناجح — فحص syntax لـ **55 ملف JavaScript**.
- `npm run release:check`: ناجح — `0.2.1` / السابق `0.2.0` / `databaseSchema: 1`.
- `npm test`: **75/75 ناجحة** بعد جلب commit قاعدة 0.2.0 (انظر «الواقع والهوية»).
- `npm run check:secrets`: ناجح — تتبع 9/9 أسرار (قيم غير مضيئة محليًا بمفردها؛ التحقق الحي 401/200 يشغّله CI).
- `npm run celia:mcp:verify`: ناجح — مصافحة وفحص جاهزية، 12 أداة.
- `npm run build:pages`: ناجح — 6 صفحات ثابتة (`dist/`).
- `npm run check:continuity`: ناجح — 15 وثيقة و46 رابطًا و40 معرفًا بلا دورات، مع بوابة `CELIA_CONTINUITY_BASE=017507b…` (STATE وسجل الجلسة ضمن نفس النطاق).
- اختبارات المتصفح وMySQL 8.4 لا تُشغَّل محليًا (ثنائيات/خدمة غير متاحة)؛ فحصهما آلي في CI.
- **CI الفعلي على PR #25 (run `40486458531` على `eac8eec`): كل الوظائف خضراء** — `Python 3.11 · Celia Google Spider tests` (جديد) و`verify` على Node 22/24 (شامل بوابة الاستمرارية و`check:secrets` و`celia:mcp:verify` و`build:pages`) و`container` و`browser` و`mysql`، و`live-gemini` مُتخطّاة بتصميمها.

## حدود لا يجوز نسيانها

- أسرار المستودع التسعة لا تُقرأ ولا تُطبع ولا تُضاف لملفات الحزمة؛ و`credentials.json` و`token.json` ممنوعان من Git مهما طُلب من التوثيق.
- الحزمة ليست موصلة ChatGPT (خارج النطاق صراحةً) ولا تدّعي بحثًا دلاليًا ولا حذفًا تلقائيًا، ولا يُعلن نشرها كمكوّن من النظام قبل قبول المالك (SPDR-002).
- لا مستودع GitHub جديد ولا دفع خارج `arena/64505100-phone-google`؛ لا releases ولا دمج PR من هذه الجلسة.
- إن زوّد المالك `RULE.MD`: حفظ حرفي في الجذر وتوثيق الفروق في `DECISIONS.md` دون اختلاق.
- مهام الخطة الأخرى تبقى كما هي في `BACKLOG.md` (COMP-001/DATA-001/SEC-001… ) دون ادعاء إغلاقها.

## الخطوة التالية بالضبط

1. **اختبار الربط الحي:** بعد وضع `GOOGLE_CLIENT_ID/SECRET` و`APP_OWNER_EMAIL` و`APP_BASE_URL` على نطاق HTTPS
   (HOST-003)، اطلب `POST /api/google/consent-link` وافتح الرابط؛ ثم `200` من
   `/api/google/calendar/events?maxResults=1`. لا تدّعِ نجاحًا قبل رؤية هذا الـ200.
2. **أربعة قرارات المالك أعلاه** — بدونها لا يبدأ AGENT-001؛ الافتراض الافتراضي عند غياب القرار مذكور في DEC-012.
2. **`npm ci && npm run check && npm run check:secrets && npm run check:continuity && npm test`** في بيئة كاملة
   (لم تُشغَّل `check:*` ولا الاختبارات هنا لغياب `node_modules`؛ نُفّذ `check-continuity` مباشرة بنجاح).
2. **إن أراد المالك الخيار 2** (ربط `GOOGLE_CLIENT_ID/SECRET` بخطوة CI): يحدد الاستخدام المقصود — لا ربط بلا غرض معلن.
3. **إن رغب المالك في مزامنة حية (SPDR-002):** OAuth client من نوع Desktop في Google Cloud، ثم `credentials.json` محليًا (خارج Git)، ثم `python -m celia_spider.auth`، ثم المزامنة والتحقق من حدود عدم الحذف — لا موافقة تفاعلية داخل CI.
4. **متابعة باقي الخطة** من `BACKLOG.md` (COMP-001/DATA-001/SEC-001/HOST-003…) دون ادعاء إغلاقها بهذا التسليم.

## التحقق من الحفظ في الجلسة التالية

```sh
git branch --show-current
git status --short
git log -3 --oneline
gh pr list --state all --head "$(git branch --show-current)"
npm run check && npm run check:secrets && npm run check:continuity && npm test
cd celia-google-spider && python -m unittest discover -s tests -q
```
