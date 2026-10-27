# تسليم جلسة — 2026-10-27 — بناء Celia Google Spider v0.1.0 (موصل Google Drive إلى شبكة معرفة محلية)

## المهمة والتفويض

- طلب المستخدم: تقرير «توظيف أسرار المستودع التسعة + إصلاح توافق MCP 0.2.0» (تحقّق: PR #24 مدموج وأخضر)، ثم مواصفة كاملة لبناء **Celia Google Spider v0.1.0**: حزمة `celia_spider/` بتسع ملفات مذكورة (OAuth بصلاحية قراءة فقط، استخراج، فهرس SQLite بشبكة مستند↔مصطلح↔مستند، بحث، خادم MCP stdio، تطبيع عربي/إنجليزي، إعدادات)، أدوات MCP الست (`spider_sync_google_drive`، `spider_search_knowledge`، `spider_read_document`، `spider_explore_network`، `spider_list_sources`، `spider_graph_stats`)، حد 2000 ملف، أوّل ورقة Sheet فقط، لا حذف تلقائي، لا embeddings، ChatGPT خارج النطاق، توثيق عربي ومراجع، اختبارات unittest وpytest، ترخيص MIT، وتسليم مصدرًا + ZIP.
- معرفات BACKLOG ومعايير القبول: SPDR-001 (بناء واختبارات محلية) وSPDR-002 (مزامنة حية بقبول المالك — لا تُفتح بلا اعتماده).
- النطاق المسموح: عمل على الفرع المعطى `arena/64505100-phone-google` فقط؛ دون مستودع GitHub جديد، دون نشر، دون لمس أسرار المستودع التسعة أو كود Node أو schema. أسئلة التوضيح (نية/مكانة الحزمة) تخطّيها المستخدم — نُفّذ بالحكم: داخل المستودع كمسار علوي.

## واقع البداية

- الفرع الذي أثبتته البيئة: `arena/64505100-phone-google` متفرعًا من `017507b` (`main` بعد دمج PR #24).
- baseline commit: `017507b` — الإصدار `0.2.1` / `schema: 1` دون أي تغيير.
- حالة PR/CI قبل البدء: PR #24 مدموج 2026-10-27T08:58:58Z؛ مهام CI المرتبطة به (40477103282) وبعده (40477355371/40477355390) كلها ناجحة (`verify` شامل `check:secrets`، `mysql`، `browser`، `container`). لا أثر سابق لـ`celia_spider` محليًا أو في GitHub (بحث كود فارغ) — المواصفة عُوملت كطلب بناء لا كوثيقة إنجاز.

## ما تغير فعليًا

- `celia-google-spider/` — حزمة Python جديدة (17 ملف مصدرًا تُرفع):
  - `pyproject.toml` (0.1.0، Python ≥3.11، MIT، `mcp>=1.9` + مكتبات Google، اختيارية `dev=[pytest]`)، `LICENSE` MIT، `.gitignore` (يعزل `credentials.json`/`token.json`/`client_secret*`/`*.sqlite3*`/`.venv/`/`dist/`/`*.zip`/`__pycache__`/`.pytest_cache`).
  - `celia_spider/config.py` (مسارات وحدود عبر `CELIA_SPIDER_DATA_DIR`/`CELIA_SPIDER_CREDENTIALS`/`CELIA_SPIDER_MAX_FILES`/`CELIA_SPIDER_MAX_FILE_BYTES`، نطاق `drive.readonly` فقط)، `text_utils.py` (tokenization عربي/إنجليزي باحتواء التشكيل ثم إزالته، توحيد الألف/التاء المربوطة/الأرقام، مقتطفات بمواضع النص الأصلي)، `store.py` (SQLite: `documents`/`terms`/`document_terms`/`meta`، بحث مرتّب بعدد المصطلحات المطابقة ثم التكرار، استكشاف شبكة، إحصاءات، تحديث حصري بلا حذف العناصر الغائبة)، `google_drive.py` (تصدير Docs→plain وSheets→CSV للأولى فقط، حدود حجم، ترشيح الملفات المدعومة، `sync` بملخص عدّادات)، `auth.py` (OAuth محلي، توكن 0600)، `check.py` (تقرير جاهزية JSON مع `--live`)، `server.py` (6 أدوات MCP عبر stdio مع ترحّل `MCPServer`→`FastMCP`).
  - `tests/` ثلاث ملفات (تطبيع/فهرس وشبكة/مصافحة stdio حقيقية)، `install_windows.bat` و`run_server.bat`، `README.md` عربي بالجوانب والحدود وخطوات الإعداد والمراجع، و`dist/celia-google-spider-v0.1.0.zip` (متجاهل في Git).
- `.github/workflows/celia-mcp.yml`: إضافة وظيفة Python 3.11 تشغّل اختبارات الحزمة (checkout وsetup-python مثبتان بـSHA).
- `docs/continuity/`: تحديث `STATE.md` لجلسة الحاضر، سجل هذه الجلسة، صفّا SPDR-001/SPDR-002 في `BACKLOG.md`، وDEC-011 في `DECISIONS.md`.
- `README.md` (الجذر): مؤشر قصير إلى حزمة السبّابة الجديدة.

## الفحوص

| الأمر/الفحص | commit/البيئة | النتيجة أو سبب عدم التشغيل |
|---|---|---|
| `python -m unittest discover -s tests -v` (في `celia-google-spider/`) | Python 3.11.2 / venv خارج المستودع | **10/10 ناجحة** |
| `python -m pytest -q` | نفسه | **10 passed** |
| `python -m compileall -q celia_spider tests` | نفسه | سلامة الصياغة |
| `python -m celia_spider.server </dev/null` | نفسه | خروج 0 (stdio يُغلق نظيفًا) |
| `zip -T dist/celia-google-spider-v0.1.0.zip` | نفسه | سلامة الأرشيف (19 ملفًا، بلا اعتمادات أو فهارس) |
| `npm ci` | Node 22.22.3 / npm 10.9.8 | ناجح |
| `npm run check` | نفس البيئة | ناجح — 55 ملف JavaScript |
| `npm run release:check` | نفس البيئة | ناجح — `0.2.1` / `0.2.0` / `schema 1` |
| `npm test` | نفس البيئة | أول تشغيل **74/75** لفشل اختبار N/N−1 لأن المستودع مقتطاع وcommit قاعدة `2508893…` غائب؛ بعد `git fetch --depth=1 origin 2508893bd7e6d447b2e19374933556322cc9cdb7` صار **75/75 ناجحة** |
| `npm run check:secrets` | نفس البيئة | ناجح — تتبع 9/9 (بدون قيم مضيئة محليًا؛ 401/200 حي في CI) |
| `CELIA_MCP_DISABLE_MYSQL=true CELIA_DISABLE_OLLAMA=true npm run celia:mcp:verify` | نفس البيئة | ناجح — 12 أداة |
| `npm run build:pages` | نفس البيئة | ناجح — 6 صفحات (`dist/`) |
| `npm run check:continuity` | بعد حفظ ملفات الاستمرارية (وكذلك ببوابة `CELIA_CONTINUITY_BASE=017507b…`) | ناجح — 15 وثيقة و46 رابطًا و40 معرفًا بلا دورات؛ بوابة التغيير اجتازت |
| مزامنة حية مع Drive | — | لم تُجرَ: لا `credentials.json` في بيئة الجلسة (SPDR-002) |

## الحفظ والتسليم

- يُرفع على `arena/64505100-phone-google` فقط؛ الحالة الفعلية تُسجَّل بعد الدفع وفتح PR.
- لا نشر ولا release ولا دمج؛ الإنتاج والأسرار كما هي: أسرار المستودع التسعة غير ملمسة، و`credentials.json`/`token.json` ممنوعان من Git.
- لم يُنفَّذ: مستودع GitHub جديد، أي دفع خارج الفرع المعطى، نشر Render/Aiven (HOST-003), أو ادعاء مزامنة حية.

## الاستئناف

- العوائق: مزامنة Drive الحية بانتظار اعتماد المالك وملف اعتماده (SPDR-002)؛ اختبارات المتصفح/MySQL يشغّلها CI.
- الخطوة التالية بالضبط: متابعة فحوص PR الجديد حتى الاخضرار (`gh pr checks <n>`)؛ أول فحص آمن: `npm run check && npm run check:continuity && npm test`.
