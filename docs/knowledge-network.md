# شبكة معرفة CeliaOS — التصميم المنفَّذ

**التاريخ:** 29 أكتوبر 2026 · **المهمة:** KB-001…KB-004 + حوكمة AI-002 · **الحالة:** منفّذ ومختبر محليًا؛ CI يثبت عند تشغيله
**الإصدار:** `0.2.1` بلا تغيير · **MySQL/`schema 1`:** بلا مساس · **الاعتمادية:** صفر حزم جديدة

> هذه وثيقة تنفيذ لا وعد: كل ما هو مذكور هنا له ملف واختبار ومسار CLI. والحدود المعلنة في §9 جزء من التسليم.

## 1. السلسلة كاملة

```
[1] المصادر        data/kb/*.csv  ·  Drive (استيراد انتقائي موثق؛ لا مزامنة حية شاملة)  ·  بيانات مفتوحة (مسجّلة)
        │                 كل ملف له descriptors.json (kind, licence, trust, staleness)
        ▼
[2] الموصل         manifest.json ببصمات SHA-256  +  git (مصدر الحقيقة للملفات)
        │
        ▼
[3] الإدخال        parseCsv → checkHeader → validateRow → كشف أسرار → فصل تكرار → سجل تشغيل
        │                 فشل صف = رفض مسجّل بسطرِه، وفشل ملف = إحباط كامل قبل أي كتابة
        ▼
[4] المخزن         SQLite + FTS5 (items/entities/edges/sources/ingest_runs)
        │                 مشتق قابل لإعادة البناء؛ MySQL يبقى لحالة الوكيل فقط
        ▼
[5] الاسترجاع      FTS5 (bm25 موزون) → توسيع عربي → ثقة + حداثة + قرب شبكي → حزمة أدلة
        │
        ▼
[6] الوكيل         kb.search / kb.tool_profile / kb.project_context (قراءة فقط) → خطوات SSE
```

## 2. عقود CSV

| الملف | أعمدة إلزامية | أعمدة اختيارية |
|---|---|---|
| `sources_registry.csv` | `id,name,kind,uri,license,last_sync,trust_level,stale_after_days` | `notes,aliases` |
| `tools_registry.csv` | `id,name,category,risk_level,requires_approval,api_endpoint,docs_url,owner` | `skills,data_egress,aliases,notes` |
| `skills_registry.csv` | `id,name,level,category,source,evidence_url` | `projects,tools,aliases,notes` |
| `projects_registry.csv` | `id,name,domain,status,priority,owner,repo_url` | `related,aliases,notes` |
| `knowledge_registry.csv` | `id,title,type,description,source_url,license,updated_at,trust_level,claim_type,review_due` | `related,tags,aliases,lang` |
| `learned_registry.csv` (نفس عقد `knowledge`) | كما أعلاه؛ كل صف يحمل `source_url` للمصدر الخارجي ووسم `learn:<source-id>` ووسوم `segment:Sxx` وحقلا الحوكمة | ثقة الملف `T1`؛ بروتوكول [learning-protocol.md](learning-protocol.md) (DEC-027) |
| `drive_registry.csv` (نفس عقد `knowledge`) | خلاصات المالك الانتقائية مع `claim_type=historical_report` و`review_due` وروابط Drive | لا يتحول تلقائيًا إلى توجيه Planner؛ لا مزامنة حية شاملة |

**قواعد مفروضة في الكود (لا في التوثيق فقط):**

| القاعدة | التنفيذ | الاختبار |
|---|---|---|
| لا سجل بلا ترخيص | `license` إلزامي ومن قائمة مسموحة (`ALLOWED_LICENSES`) | `validate: licences…` |
| مصدر خارجي بحقوق محفوظة يُربط ولا يُنسخ | `reference-only` مسموح لصفوف `sources` فقط (`SOURCE_ONLY_LICENSES`)؛ نوع المصدر `video` مضاف | `LS-04` في `learning-protocol.test.js` |
| لا سجل بلا مصدر | `items.source_id NOT NULL` + `FOREIGN KEY` | `ingest: dry-run…` |
| لا كيان بلا دليل | `entities.evidence_item_id NOT NULL` | `store: entity detail…` |
| لا حافة لكيان غير موجود | المرحلة الثانية ترفض وتُبلّغ | `ingest: duplicate ids and unresolved…` |
| لا أسرار في البيانات | 11 نمطًا (`sk-`, `ghp_`, `AIza…`, `BEGIN PRIVATE KEY`, `password=`, JWT…) | `validate: credentials are refused` |
| لا تكرار | `UNIQUE(content_hash)` + جدول `item_aliases` | `store: duplicates collapse…` |
| لا حذف صامت | `absent_since` بدل `DELETE` | `ingest: full re-import marks absence…` |
| CSV لا يمنح صلاحية | مطابقة `risk_level`/`requires_approval` مع `CANONICAL_TOOLS` | `validate: a CSV cannot grant itself…` |
| لا تعديل يدوي صامت | `manifest.json` ببصمة SHA-256 لكل ملف | `manifest: a hand-edited CSV…` |
| كل معرفة لها نوع ادعاء ومراجعة | `claim_type` من أربع قيم مغلقة و`review_due` بتاريخ ISO صالح لا يسبق `updated_at` | `knowledge governance: claim types…` |
| لا توصية قديمة كتعليمة | مسار `planner` يقبل `doc` + `operational_guidance` + `T1/T2` + مراجعة سارية فقط؛ التاريخي/غير المتحقق/المهجور/المنتهي يُستبعد قبل النموذج | `knowledge store: planner profile…` و`AI-002 + KB…` |

## 3. نموذج البيانات

```sql
sources(id, kind, uri, license, trust, stale_after_days, last_sync_at, …)
items(id, source_id, kind, title, body, content_hash UNIQUE, trust, uri, source_updated_at,
      claim_type, review_due, absent_since)       -- schema v2؛ الحقول nullable لترقية v1 additive وتفشل مغلقة في Planner
item_aliases(item_id, source_id, uri)          -- نفس المحتوى في موقعين
item_terms(item_id, term, freq)                -- مصطلحات معجمية للتشخيص
entities(id, type, key, title, key_norm, title_norm, status, risk, requires_approval, wired,
         evidence_item_id, trust)              -- UNIQUE(type, key)
entity_attrs(entity_id, key, value)
edges(id, src_type, src_id, dst_type, dst_id, rel, weight, evidence_item_id)
ingest_runs / ingest_rejections                -- سجل كل استيراد وكل صف مرفوض
items_fts(item_id UNINDEXED, title_norm, body_norm) -- FTS5 unicode61 remove_diacritics 2
```

العلاقات المسموحة: `requires` (أداة → مهارة)، `part_of` (مهارة → مشروع)، `mentions` (مشروع/مفهوم → أي كيان).
كل حافة تشير إلى `evidence_item_id`، فلا توجد علاقة بلا مستند يبرّرها.

## 4. الاسترجاع: كيف تُصنَّف النتائج

```
score = 0.55 × معجمي(معياري) + 0.20 × ثقة + 0.15 × حداثة + 0.10 × قرب شبكي
```

- **معجمي:** `bm25(items_fts, 0.0, 3.0, 1.0)` — العنوان أثقل من المتن، معياري على أعلى مرشح.
- **ثقة:** `T3=1.0` · `T2=0.7` · `T1=0.4`، و`minTrust` قابل للرفع (اختبار `T3` يستبعد `T2`).
- **حداثة:** تناقص خطي داخل `stale_after_days` الخاص بالمصدر؛ يتوقف عند الصفر ولا يصبح سالبًا.
- **قرب شبكي:** `1.0` إن كان العنصر دليلًا لكيان مطابق، `0.5` إن كان جارًا بخطوة واحدة.
- **الميزانية:** تُبنى حزمة الأدلة بسقف `limit` و`maxChars`، وتُعلن `truncated/omitted` بدل القص الصامت.
- **التوسيع العربي:** تُجرَّب المصطلحات الدقيقة بـ`AND` أولًا، ثم نسخ منزوعة السوابق/اللواحق بـ`OR`
  (بحد أدنى 3 أحرف)، ولذلك تصل «أربط» إلى «ربط» دون جذر لغوي عدواني.
- **الأمان:** لا استعلام SQL من نص المستخدم؛ كل شيء داخل `MATCH ?` معاملاتي، ولا شبكة ولا LLM في البحث.
- **ملف Planner (`planner-safe-v1`):** بعد استرجاع المرشحين معجميًا، لا تُبنى حزمة النموذج إلا من `kind=doc` و`claim_type=operational_guidance` و`trust∈{T1,T2}` و`review_due` سارية. لا تدخل المطابقات المباشرة للكيانات أو حواف الجيران غير المؤهلة في الحزمة. يحمل كل عنصر `claimType/reviewDue/reviewStatus/plannerEligible`، ويعلن التقرير عدد المستبعدين وسبب غياب نتيجة مؤهلة.
- **الفاحص المستقل:** إذا كان ناتج `kb.search` يحمل ملف Planner، أو كان الـRun يحمل أدلة Provider، يعيد `kb_planner_governance` حساب الأهلية من الحقول والساعة، ويرفض أي عنصر تاريخي أو منتهي أو ادعاء سياسة مخالف أو غلاف حوكمة غائب، حتى لو زُوّر `plannerEligible=true`.

## 5. الأسطح

| السطح | الوصف |
|---|---|
| `npm run kb -- status` | الحالة والعدادات وآخر استيراد وآخر مرفوضات |
| `npm run kb -- verify` | استيراد تجريبي كامل؛ رمز خروج `2` عند وجود صفوف مرفوضة |
| `npm run kb -- import [--apply] [--full] [--kind tools]` | تطبيق أو تجربة؛ `--full` يعلّم الغائب |
| `npm run kb -- search "…" [--limit n] [--chars n]` | نتائج JSON مع الأدلة والحواف |
| `npm run kb -- entity tool celia_status` | كيان كامل: خطر، موافقة، دليل، حواف |
| `npm run kb -- stale [--days n]` | تقرير التقادم والغياب |
| `npm run kb -- export --out f.jsonl` / `restore --file f.jsonl` | نسخة قابلة للاستعادة (JSONL قابل للتدقيق) |
| `GET /api/kb/status·entities·stale·export` · `POST /api/kb/search` | مالك فقط، `no-store`، بلا كتابة |
| `POST /api/kb/import` | معطّل افتراضيًا؛ يحتاج `CELIA_KB_ALLOW_REMOTE_IMPORT=true` لبيئة مؤقتة |
| `/kb` | صفحة عربية RTL لقراءة النتائج والكيانات وتقرير التقادم |
| أدوات الوكيل `kb.search` / `kb.tool_profile` / `kb.project_context` | `risk: read`، بحد زمني، وتُسجَّل كخطوات |

عند بناء Registry لشريحة Provider تُمرر `defaultToolDefinitions({ kb, plannerSafe: true })`؛ هذا يجعل `kb.search` يستخدم ملف Planner المحلي فقط، ويرفض `createProviderPlanner` الأداة بلا هذه العلامة بدل السماح بنسيانها. لا يغيّر ذلك `createAgentHost` الافتراضي ولا يفعّل مزودًا حيًا.

## 6. التشغيل

```bash
# 1) بناء الفهرس (أمر صريح، لا يعمل تلقائيًا عند الإقلاع)
npm run kb -- verify                       # تجربة كاملة + رموز خروج
npm run kb -- import --apply --full         # تطبيق + تعليم الغائب

# 2) تشغيل السطح والوكيل معًا
CELIA_KB=sqlite CELIA_KB_PATH=.data/knowledge.sqlite3 \
CELIA_AGENT_RUNTIME=sqlite CELIA_AGENT_SQLITE_PATH=.data/agent.sqlite3 \
CELIA_MCP_DISABLE_MYSQL=true CELIA_MCP_API_TOKEN=$(openssl rand -hex 32) \
node src/celia-mcp.js
# ثم: /kb للقراءة · /agent لتنفيذ مهمة تستخدم الأدلة

# 3) بعد تعديل أي CSV
npm run --silent kb:manifest && npm run --silent kb -- verify
```

## 7. السياسات المثبتة بالاختبارات

1. **لا استيراد بلا تحقق:** تعديل CSV دون تحديث `manifest.json` يوقف الاستيراد برسالة `manifest_checksum_mismatch`.
2. **تجربة قبل التطبيق:** `import` بلا `--apply` لا يغيّر صفًا واحدًا (يُثبته اختبار صريح).
3. **التكرار ليس صفًا ثانيًا:** المحتوى نفسه في مسارين يُدمج في عنصر واحد + alias.
4. **الثقة تُحترم:** `minTrust=T3` يمنع `T2` من الظهور حتى لو كان أقرب معجميًا.
5. **الغياب ≠ الحذف:** العنصر الغائب يُعلَّم ويظهر في `stale`، ولا يُحذف.
6. **الأدلة إلزامية:** كل نتيجة تحمل `uri` و`licence` و`trust`؛ وكل كيان يحمل `evidence`.
7. **لا سلطة للبيانات:** خطر الأداة يُقرأ من الكود؛ CSV مخالف يُرفض (`registry_risk_mismatch`).
8. **حدود الأداء:** 5000 عنصر، بحث عربي تحت 150ms في الاختبار.
9. **حوكمة الادعاء:** كل سجل معرفة يحمل نوع ادعاء وتاريخ مراجعة؛ التواريخ المستحيلة أو التي تسبق التحديث مرفوضة، وترقية v1 تضيف الحقول بلا حذف.
10. **حلقة AI-002:** مزود وهمي يختار `kb.search`، وRuntime ينفذه، و`tool_result` يعود إلى القرار التالي؛ النتيجة المقبولة وسلسلة الأدلة والفاحص المستقل تُختبر معًا.

## 8. نتائج التنفيذ الحالية

| الفحص | النتيجة |
|---|---|
| الاستيراد الحالي من 7 ملفات | 81 عنصرًا · 0 مرفوض · 91 حافة في التحقق الجاف؛ بعد الترقية المحلية 34 تحديثًا/47 بلا تغيير، ثم إعادة التطبيق 81 بلا تغيير |
| حوكمة KB وAI-002 المحلية | `knowledge-governance` 3/3 · `agent-kb-planner` 1/1 · `agent-verifier` 13/13 |
| الفحص الكامل بعد التغيير | `npm test`: **629/629**؛ `npm run check`: 163 ملف JavaScript؛ التغطية 91.98% أسطر/75.53% فروع/87.32% دوال |
| بوابات إضافية | `check:secrets` و`now:check` و`check:continuity` و`git diff --check` ناجحة؛ الاستمرارية 76 وثيقة/273 رابطًا/75 مهمة |
| CI | وظيفة Node 22/24 تشمل `kb -- verify/import/search/export/entity/stale`؛ لا تُدّعى نتيجة CI جديدة من التشغيل المحلي |
| تحديث Drive الانتقائي — 29 أكتوبر 2026 | صفّا معرفة من `src-google-drive-curated` مصنّفان `historical_report` مع مراجعة مجدولة؛ لا مزامنة حية شاملة ولا أهلية Planner تلقائية |

## 9. الحدود المعلنة

- **Drive ليس مزامنة حية شاملة:** `src-google-drive` يبقى مصدرًا عامًا لم تُجرَ مزامنته الحية بعد (SPDR-002).
  في 29 أكتوبر 2026 أُضيف `src-google-drive-curated` و`drive_registry.csv` لاستيراد خلاصتين انتقائيتين
  بروابط المصدر وثقة `T1`؛ هذا ليس اتصالًا مستمرًا ولا قراءة كاملة لكل Drive. التفاصيل في
  [تقرير الاستيراد](drive-import-2026-10-29.md).
- **لا embeddings ولا بحث دلالي:** البحث معجمي + حواف صريحة. الادعاء بغير ذلك ممنوع.
- **الحوكمة ليست إثبات صحة:** `operational_guidance` وT1/T2 ومراجعة سارية شروط أهلية للقراءة الآلية، وليست ضمانًا لصحة المصدر أو إذنًا بتنفيذ أثر خارجي. السجلات التاريخية وغير المتحققة والممارسات الأمنية المهجورة تبقى قابلة للبحث العادي لكنها لا تدخل حزمة Planner.
- **المخطط ليس نموذجًا لغويًا:** الافتراضي مسودة حتمية + أدلة مسرودة؛ شريحة Provider قابلة للحقن مختبرة بمزود وهمي فقط، ولا مزود حي مفعّل (AI-002).
- **الاستضافة:** ملف SQLite محلي؛ على مضيف بلا قرص دائم يُعاد بناء الفهرس بعد النشر. `status` يعلن ذلك
  (`durability.persistent=false`) ولا يدّعي حفظًا دائمًا. `CELIA_KB_PERSISTENT=true` لا يُضبط إلا بقرص مثبت.
- **النسخ الاحتياطي:** `export` إلى JSONL مدقّق ومختبر الاستعادة؛ الرفع إلى Drive غير منفّذ (يحتاج اعتماد OAuth).
- **الحجم:** صُمم لآلاف العناصر. الملايين تحتاج ترحيلًا إلى جدول FTS خارجي/قاعدة متخصصة، وهذا قرار مؤجل.
- **اللغة:** التطبيع العربي مفيد لكنه ليس تحليلًا صرفيًا كاملًا؛ اللهجات والجذور المعطوبة قد تفشل في الاسترجاع.
