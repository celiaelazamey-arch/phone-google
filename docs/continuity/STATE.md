# الحالة الحالية — ابدأ من هنا

**آخر مراجعة:** 27 أكتوبر 2026 · **نوع الجلسة الحالية:** بناء «Celia Google Spider v0.1.0» (موصل Google Drive إلى شبكة معرفة محلية عبر MCP) والتحقق من دمج PR #24

## الطلب والمتطلبات الثابتة

المستخدم وجّه في رسالة ثنائية الجزء: (1) التحقق من إنجاز «توظيف أسرار المستودع التسعة + إصلاح توافق MCP 0.2.0» — تحقّق: PR #24 مدموج بـ`017507b` وفحوصه كلها خضراء؛ و(2) بناء **Celia Google Spider v0.1.0** وفق مواصفة كاملة: حزمة `celia_spider/` (`google_drive.py` و`store.py` و`server.py` و`text_utils.py` و`config.py`)، فهرس محلي في `~/.celia_spider/knowledge.sqlite3` (يُعاد تحديده عبر `CELIA_SPIDER_DATA_DIR`)، ست أدوات MCP، حد 2000 ملف، أول ورقة Sheet فقط، **لا حذف تلقائي** لعناصر محلية غائبة عن Drive، **لا embeddings/بحث دلالي**، **ChatGPT خارج النطاق**، `.gitignore` لـ`credentials.json` و`token.json` وقاعدة البيانات، سكربتات Windows، README عربي بالمراجع، اختبارات unittest وpytest، ترخيص MIT، وتسليم مصدرًا + ZIP.

متطلبات ثابتة مستمرة: قواعد `AGENTS.md` (فرع البيئة فقط، لا تفويض تجاوز الفرع، استمرارية STATE + سجل الجلسة مع ملفات التنفيذ)، عدم كشف أي من أسرار المستودع التسعة ولا ملفات OAuth، عدم اختلاق محتوى (إن زوّد المالك `RULE.MD` يُحفظ حرفيًا وتُوثّق الفروق في `DECISIONS.md`)، وعدم إنشاء مستودع GitHub جديد أو دفع خارج الفرع المعطى دون تأكيد صريح.

## الواقع والهوية

- المستودع: `celiaelazamey-arch/phone-google`؛ خط الأساس لهذه الجلسة `017507bec6efd5f93f6b246240d2e76e1da292cb` (دمج PR #24 على `main`). طلبات PR #17 و#21 و#22 و#23 و#24 مدموجة.
- الفرع المعطى لهذه الجلسة: `arena/64505100-phone-google`. تحقّق دائمًا من الفرع النشط ولا تنشئ أو تنتقل لفرع آخر.
- الكود الحالي `0.2.1` / السابق `0.2.0` / `schema: 1` كما هي دون أي تعديل — حزمة السبّابة طرفية لا تمس Node أو المخطط.
- المستودع مقتطاع (shallow) بعمق 1؛ اختبار توافق 0.2.0 يحتاج commit قاعدة `2508893bd7e6d447b2e19374933556322cc9cdb7` محليًا (`git fetch --depth=1 origin <sha>`) — جُلب في هذه الجلسة فصار 75/75.
- لا رابط Render/Aiven دائم منشأ (HOST-003 بانتظار تفويض المالك).

## المنفذ الآن

1. **حزمة `celia-google-spider/` (SPDR-001 / DEC-011) — مكتملة:**
   - 17 ملف مصدرًا: `pyproject.toml` (0.1.0، Python ≥3.11، MIT) و`LICENSE` و`.gitignore` معزول للاعتمادات والقوالب و`celia_spider/{__init__,config,text_utils,store,google_drive,auth,check,server}.py` و`tests/` (3 ملفات) و`install_windows.bat` و`run_server.bat` و`README.md` عربي، وأرشيف `dist/celia-google-spider-v0.1.0.zip` (متجاهل في Git، سلامته مختبرة).
   - الأدوات الست عبر stdio فقط: مزامنة (إدراج/تحديث بلا حذف)، بحث معجمي بمقتطف ومصدر، قراءة، استكشاف شبكة، مصادر، إحصاءات. خادم MCP يتوافق مع مخططتَي SDK (`MCPServer` مع ارتداد `FastMCP`) ومصافحة stdio حقيقية في الاختبارات تضبط الأدوات الست بالضبط.
   - الحدود مكتوبة في README الحزمة: قراءة فقط (`drive.readonly`)، Docs→نص وSheets→CSV للأولى فقط، بلا embeddings، بلا ChatGPT، بلا مزامنة حية قبل اعتماد المالك وملف اعتماده (SPDR-002).
2. **وظيفة CI اختيارية:** إضافة `spider` في `.github/workflows/celia-mcp.yml` (Python 3.11 بمفتاح SHA مثبت) لتشغيل `unittest` + `pytest` + `compileall` بلا أي بيانات اعتماد.
3. **الاستمرارية:** تحديث `STATE.md` وسجل جلسة جديد `sessions/2026-10-27-celia-google-spider.md`، صفّا SPDR-001/SPDR-002 في `BACKLOG.md`، DEC-011 في `DECISIONS.md`، ومؤشر الحزمة في `README.md` الجذري.

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

1. **مراجعة PR #25 ودمجه من قبل المالك** — الوظائف كلها خضراء (run `40486458531`)؛ لا يُدمج من طرف الوكيل وفق قواعد `AGENTS.md`.
2. **إن رغب المالك في مزامنة حية (SPDR-002):** وضع `credentials.json` محليًا (خارج Git) وتشغيل `python -m celia_spider.auth` ثم المزامنة والتحقق من حدود عدم الحذف، مع تحديث حالة SPDR-002.
3. **متابعة باقي الخطة** من `BACKLOG.md` (COMP-001/DATA-001/SEC-001/HOST-003…) دون ادعاء إغلاقها بهذا التسليم.

## التحقق من الحفظ في الجلسة التالية

```sh
git branch --show-current
git status --short
git log -3 --oneline
gh pr list --state all --head "$(git branch --show-current)"
npm run check && npm run check:secrets && npm run check:continuity && npm test
cd celia-google-spider && python -m unittest discover -s tests -q
```
