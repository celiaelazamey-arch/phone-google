# تسليم جلسة — 2026-10-27 — شبكة المعرفة: من CSV إلى أدلة يستخدمها الوكيل

## المهمة والتفويض

بعد أن قدّم الوكيل تصميمًا نصيًا لشبكة معرفة CeliaOS، قال المالك: **«اوك نفذ بالكامل بشكل انتاجي»**.
التفويض إذن واضح: تنفيذ حقيقي باختبارات وتوثيق ودليل، لا خطة ولا وصف. القيود القائمة لم تتغير: بلا بطاقة،
بلا دفع، بلا تجاوز تحقق، والتوقف الصريح عند أي منهما، وعدم ادّعاء تكافؤ مع Manus قبل إثباته.

## واقع البداية

- الفرع `arena/c0d6fcba-phone-google` متفرع من `804a4af` (`main` بعد دمج PR #30).
- حلقة الوكيل M1 منفذة (AGENT-001 جزئيًا)، ولا وسيلة لها للاستشهاد بأي مصدر: كل خطة تنتهي بملخص بلا مرجع.
- لا مخزن معرفة، ولا سجلات موثقة، ولا سطح قراءة للمالك، ولا تحقق من ترخيص/ثقة مصدر.
- `npm ci` لازمة في هذه البيئة (`node_modules` غير موجود)، و`node:sqlite` متاح مع FTS5 (SQLite 3.51.3).

## ما نُفِّذ فعليًا

### 1. السجلات والعقد — `data/kb/*.csv` و`src/knowledge/{csv,validate,tool-policy}.js`

- خمسة سجلات مولّدة من الكود نفسه: `sources_registry` (5) · `tools_registry` (24 أداة = 16 MCP + 5 وكيل + 3 kb)
  · `skills_registry` (10) · `projects_registry` (6) · `knowledge_registry` (12) = **56 صفًا**.
- `scripts/kb-seed.mjs` يبنيها من `src/mcp-contract.js` و`CANONICAL_TOOLS`، مع `aliases` عربية/إنجليزية لكل سجل.
- `scripts/kb-manifest.mjs` يكتب `manifest.json` ببصمة SHA-256 لكل ملف؛ تعديل CSV يدويًا بلا تحديث المانيفست
  يُفشل الاستيراد (`manifest_checksum_mismatch`).
- `parseCsv` صارم (RFC 4180، رفض الاقتباس الشارد، رؤوس مكررة/فارغة، سقف صفوف) — لا regex هش.
- `validateRow` يفرض: معرّفًا مطابقًا `^[a-z0-9][a-z0-9_.-]{2,63}$`، ترخيصًا من قائمة مسموحة، ثقة T1–T3،
  خطرًا وموافقة **مطابقين لـ`CANONICAL_TOOLS`** (`registry_risk_mismatch`/`registry_approval_mismatch`)،
  ورفض أي صف يحوي سرًا بأحد 11 نمطًا (`sk-`, `ghp_`, `AIza…`, `BEGIN PRIVATE KEY`, JWT…).
- **قاعدة حاكمة:** CSV لا يمنح صلاحية. الأدوات توجد في الكود، والسجل يوثّقها؛ أي تعارض يُرفض ولا يُعتمد.

### 2. المخزن — `src/knowledge/schema.js` و`store.js`

- SQLite محلي مع FTS5 (`unicode61 remove_diacritics 2`) وإصدار مخطط مستقل (`KNOWLEDGE_SCHEMA_VERSION=1`)
  لا يمس `schema: 1` الخاص بـMySQL.
- `items` بـ`UNIQUE(content_hash)` و`absent_since` بدل الحذف · `item_aliases` لدمج نفس المحتوى من مسارين ·
  `entities` بـ`UNIQUE(type,key)` و`evidence_item_id NOT NULL` (لا كيان بلا دليل) · `edges` مسماة
  (`requires`, `part_of`, `mentions`) مع وزن ودليل · `sources` و`ingest_runs` و`ingest_rejections`.
- كل عمليات الكتابة داخل معاملة واحدة؛ إعادة الاستيراد لا تكرر شيئًا.

### 3. الإدخال — `src/knowledge/ingest.js`

- ترتيب ثابت لكل تشغيل: `upsertSource` ← `startRun` ← الصفوف ← الحواف ← `markAbsent` (عند `--full` فقط) ← `finishRun`.
  (كان خطأين حقيقيين: `startRun` قبل المصدر ⇒ `FOREIGN KEY`، و`reject` قبل التشغيل ⇒ `NOT NULL`.)
- الحواف على مرحلتين: تُحلّ بعد إدخال كل الملفات، مع `knownKeys` يستنتج نوع الطرف من بادئة المفتاح،
  فلا تعتمد التجربة على بيانات لم تُكتب (`edge_target_missing` بدل علاقة صامتة).
- كل صف مرفوض يُسجَّل برقم سطره ورمزه، ورمز الخروج `2` عند أي رفض — لا نجاح تجميلي.

### 4. الاسترجاع — `src/knowledge/normalize.js` + `store.search`

- تطبيع عربي مع خريطة إزاحات (`normalizeWithMap`) تُعيد snippet من النص الأصلي، و`tokenize`، وقائمة إيقاف
  تتضمن «كيف»، و`stem` متحفظ (يزيل `ال` فقط).
- عند الاستعلام فقط: `expandTerms` يزيل السوابق (`وال/بال/ال/و/ب/ل/س…`) واللواحق (`هما/ات/ين/ه/ي…`) بحد 3 أحرف،
  فتُطابق «أربط» ← «ربط». الفهرسة تبقى على الصيغة الدقيقة — لا تضخّم.
- `score = 0.55·lexical(bm25 موزون) + 0.20·trust + 0.15·freshness + 0.10·graph-proximity`، مع `minTrust`،
  وتوسيع OR بعد فشل AND، وحزمة أدلة بسقف `limit`/`maxChars` وإعلان `truncated`/`omitted`.
- كل نتيجة تحمل `uri`, `licence`, `trust`, `sourceId`, `breakdown`. «لا مطابقة» تُعلَن بسبب صريح، ولا يُختلق مرجع.

### 5. الأسطح — `src/kb-routes.js` و`src/agent/{tools,planner}.js` و`public/kb.*`

- `/api/kb`: `GET status|entities|entities/:type/:key|stale|export` و`POST search` — مالك فقط، `no-store`،
  بلا أي كتابة؛ `POST import` معطّل إلا بـ`CELIA_KB_ALLOW_REMOTE_IMPORT=true`، وكل شيء يعيد `503` مهذّبًا حين `CELIA_KB=off`.
- ثلاث أدوات وكيل قراءة فقط: `kb.search`, `kb.tool_profile`, `kb.project_context` (limit 5s، وسائط محدودة).
  لا تُسجَّل إطلاقًا إن كانت المعرفة متوقفة — لا ارتداد صامت إلى الذاكرة.
- المخطط التجريبي صار: `kb.search` أولًا، ثم الأداة، ثم تسليم يسرد أدلة فعلية `title (trust، licence) uri`؛
  وبلا معرفة لا يظهر أي رابط ولا أي ادعاء.
- صفحة `/kb` عربية RTL (`public/kb.{html,css,js}`): الرمز في `sessionStorage`، بناء DOM بـ`textContent` فقط،
  حالات 401/403/503 وفارغة، وتقرير تقادم. على GitHub Pages تعلن الصفحة بصراحة أنها نسخة ثابتة بلا فهرس.

### 6. النسخ والاستعادة وCLI

- `npm run kb -- status|verify|import [--apply|--full|--kind]|search|entity|entities|stale|export --out|restore --file`.
- `exportJsonl`/`importJsonl` يستخدمان `recordType` (لا `type`) بعد إصلاح تصادم bind؛ اختبار الاستعادة يقارن البصمة.
- خطوة CI جديدة: `verify` + `import --apply` + `search` عربي + `export` + `entity` + `stale` على قواعد نظيفة.

## الأدلة المقاسة

| الفحص | النتيجة |
|---|---|
| `npm run kb -- verify` | 56 مضافًا · 55 حافة · 0 غير محلول · 0 مرفوض |
| `import --apply` مرتين | `added 56` ثم `unchanged 56` (تطابق تام) |
| `kb status` | items 56 · entities 56 · edges 55 · sources 5 · schemaVersion 1 |
| بحث «كيف أربط جوجل» | 3 نتائج، أولها «ربط حساب Google خطوة بخطوة» |
| بحث «موعد تقويم» | كيان `google.calendar_create_event` بخطره `external_effect` و`requiresApproval`، و4 حواف |
| `npm test` | **153/153** (124 سابقًا + 29 لشبكة المعرفة) |
| `npm run check` | **78** ملف JavaScript |
| `npm run check:secrets` | ناجح (تدقيق ربط لا قيم) |
| `npm run celia:mcp:verify` | selfTest passed · **12** أداة MCP (لم تتغير — `kb.*` أدوات وكيل فقط) |
| `npm run release:check` | 0.2.1 · schema 1 |
| `npm run build:pages` | 7 صفحات بما فيها `kb.html` |
| CI على `dc17493` (run `40502456740`) | الوظائف السبع ناجحة، وخطتا المعرفة (`verify/import/search/entity/stale` و`export→restore`) ناجحتان |
| كشف حي (معاينة) | `/api/kb/status` = enabled · 56 عنصرًا · 55 حافة؛ `/api/kb/search` «كيف أربط جوجل» = 3 أدلة مع `uri` وترخيص؛ تشغيل وكيل ناجح بخطوة `kb.search` أولًا وتسليم يسرد المراجع |

## الحدود المعلنة (لا تُخفى في العرض)

- **Drive غير مزامن.** `src-google-drive` مسجّل كمصدر فقط؛ لا عنصر واحد في الفهرس جاء منه (SPDR-002).
- **لا بحث دلالي.** البحث معجمي + حواف صريحة؛ لا embeddings ولا LLM في الاسترجاع. الادعاء بغير ذلك ممنوع.
- **التخطيط حتمي.** الأدلة تُسرد في التسليم؛ لا استنتاج لغوي حر (AI-002).
- **التخزين محلي.** على مضيف بلا قرص دائم يُعاد بناء الفهرس بعد النشر، و`status.durability.persistent=false`
  يقول ذلك صراحة. `CELIA_KB_PERSISTENT=true` لا يُضبط إلا بقرص مثبت.
- **النسخة البعيدة غير منفذة.** `export` محلي ومختبر الاستعادة؛ الرفع إلى Drive يحتاج اعتماد OAuth (KB-004 باقٍ).
- **الحجم.** آلاف العناصر مصمم لها ومختبرة (5000 عنصر < 150ms)؛ الملايين تحتاج قرار ترحيل مؤجل.
- **النشر.** لا يزال محجوبًا بصلاحية الحساب (`has_pages=false`, تفعيل 403)، ولا خادم مجاني دائم بلا بطاقة.

## الخطوة التالية

1. مراقبة CI على هذه الدفعة (خطوة المعرفة الجديدة + MySQL 8.4 + المتصفح RTL).
2. كشف حي لـ`/api/kb/status` و`/api/kb/search` على معاينة مع `CELIA_KB=sqlite` بعد `import --apply`.
3. مواصلة AGENT-002 (أثر خارجي عبر outbox) — وهي التي تحوّل «سرد الدليل» إلى «فعل موثّق».
