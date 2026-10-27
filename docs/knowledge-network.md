# شبكة معرفة CeliaOS — التصميم المنفَّذ

**التاريخ:** 27 أكتوبر 2026 · **المهمة:** KB-001…KB-004 (جديدة) · **الحالة:** منفّذ ومختبر محليًا وفي CI
**الإصدار:** `0.2.1` بلا تغيير · **MySQL/`schema 1`:** بلا مساس · **الاعتمادية:** صفر حزم جديدة

> هذه وثيقة تنفيذ لا وعد: كل ما هو مذكور هنا له ملف واختبار ومسار CLI. والحدود المعلنة في §9 جزء من التسليم.

## 1. السلسلة كاملة

```
[1] المصادر        data/kb/*.csv  ·  Drive (معلن، غير مزامن)  ·  بيانات مفتوحة (مسجّلة)
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
| `knowledge_registry.csv` | `id,title,type,description,source_url,license,updated_at,trust_level` | `related,tags,aliases,lang` |

**قواعد مفروضة في الكود (لا في التوثيق فقط):**

| القاعدة | التنفيذ | الاختبار |
|---|---|---|
| لا سجل بلا ترخيص | `license` إلزامي ومن قائمة مسموحة (`ALLOWED_LICENSES`) | `validate: licences…` |
| لا سجل بلا مصدر | `items.source_id NOT NULL` + `FOREIGN KEY` | `ingest: dry-run…` |
| لا كيان بلا دليل | `entities.evidence_item_id NOT NULL` | `store: entity detail…` |
| لا حافة لكيان غير موجود | المرحلة الثانية ترفض وتُبلّغ | `ingest: duplicate ids and unresolved…` |
| لا أسرار في البيانات | 11 نمطًا (`sk-`, `ghp_`, `AIza…`, `BEGIN PRIVATE KEY`, `password=`, JWT…) | `validate: credentials are refused` |
| لا تكرار | `UNIQUE(content_hash)` + جدول `item_aliases` | `store: duplicates collapse…` |
| لا حذف صامت | `absent_since` بدل `DELETE` | `ingest: full re-import marks absence…` |
| CSV لا يمنح صلاحية | مطابقة `risk_level`/`requires_approval` مع `CANONICAL_TOOLS` | `validate: a CSV cannot grant itself…` |
| لا تعديل يدوي صامت | `manifest.json` ببصمة SHA-256 لكل ملف | `manifest: a hand-edited CSV…` |

## 3. نموذج البيانات

```sql
sources(id, kind, uri, license, trust, stale_after_days, last_sync_at, …)
items(id, source_id, kind, title, body, content_hash UNIQUE, trust, uri, source_updated_at, absent_since)
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

## 8. نتائج التنفيذ الحالية

| الفحص | النتيجة |
|---|---|
| عدد العناصر المستوردة من السجلات الخمسة | 56 عنصرًا · 56 كيانًا · 55 حافة · 0 مرفوض |
| إعادة استيراد متطابقة | 56 «بلا تغيير» و0 مضاف |
| `npm test` | 124 + 34 اختبارًا جديدًا (أدناه) |
| اختبارات المشروع | `knowledge-normalize` 6 · `knowledge-ingest` 9 · `knowledge-store` 8 · `kb-routes` 6 |
| CI | وظيفة Node 22/24 تشمل الآن `kb -- verify/import/search/export/entity/stale` |

## 9. الحدود المعلنة

- **Drive غير مزامن:** `src-google-drive` مصدر مسجّل فقط؛ لا يوجد استيراد حي منه بعد (SPDR-002). لا عنصر واحد
  في الفهرس جاء من Drive.
- **لا embeddings ولا بحث دلالي:** البحث معجمي + حواف صريحة. الادعاء بغير ذلك ممنوع.
- **المخطط ليس نموذجًا لغويًا:** إجابات الوكيل مسودة حتمية + أدلة مسرودة، لا استنتاج حر (AI-002).
- **الاستضافة:** ملف SQLite محلي؛ على مضيف بلا قرص دائم يُعاد بناء الفهرس بعد النشر. `status` يعلن ذلك
  (`durability.persistent=false`) ولا يدّعي حفظًا دائمًا. `CELIA_KB_PERSISTENT=true` لا يُضبط إلا بقرص مثبت.
- **النسخ الاحتياطي:** `export` إلى JSONL مدقّق ومختبر الاستعادة؛ الرفع إلى Drive غير منفّذ (يحتاج اعتماد OAuth).
- **الحجم:** صُمم لآلاف العناصر. الملايين تحتاج ترحيلًا إلى جدول FTS خارجي/قاعدة متخصصة، وهذا قرار مؤجل.
- **اللغة:** التطبيع العربي مفيد لكنه ليس تحليلًا صرفيًا كاملًا؛ اللهجات والجذور المعطوبة قد تفشل في الاسترجاع.
