# جلسة 2026-10-29 — MANUS-B2: مخزن artifacts المواجه للمالك + التنزيل الموقّع (S4 / M-B)

**الفرع:** `arena/a3caa0c8-phone-google` (من `main@5c2a75b` — بعد دمج PR #91/B1)
**النطاق:** صف B2 من [خطة منافس مانوس](../../manus-competitor-plan.md): كل ملف ناتج من العزل يُنشر للمالك مبصومًا SHA-256 في سلسلة الأدلة، برابط تنزيل موقّع منتهي الصلاحية، والعبث بعد التسليم يُكشف بالبصمة ويُرفض.

## ما نُفِّذ

1. **`src/agent/artifact-store.js` (جديد):** `createArtifactStore({ store, rootDir, signingKey, urlTtlMs })` — النشر يعيد حساب SHA-256 على البايتات المسلّمة قبل أي كتابة (`artifact_hash_mismatch` عند أي انحراف)، التخزين محلي بملف `wx`/0600، التسجيل في `agent_artifacts`، والبصم `artifact_published` في السلسلة. التنزيل: توقيع HMAC-SHA256 على `id\exp` بمقارنة timing-safe، ترتيب فحص مقصود (شكل ← توقيع ← مهلة ← وجود ← بصمة) فلا يكشف الرابط غير الموقّع وجود الملف أصلًا؛ البصمة يُعاد حسابها عند كل قراءة → `artifact_tampered` 409. Idempotency بمفتاح فريد `(run_id, source_artifact_id)` في قاعدة البيانات لا الذاكرة.
2. **طبقة البيانات:** جدول `agent_artifacts` — ترحيل `sql/migrations/0006_agent-artifacts.sql` (إضافي فقط) + DDL SQLite في `drivers.js` + أساليب `insertArtifact/getArtifact/findArtifactBySource/listArtifacts` في `store.js` + نوع دليل جديد `artifact_published` في `evidence.js`.
3. **الأداة `artifact.create` (`tools.js`):** مشروطة بوجود المنفّذ **والمخزن معًا** — بدونهما سطح الأدوات القائم بلا تغيير حرفي؛ `internalWrite` + `settledFailures` + `timeoutMs 15000`؛ تقرأ المصدر حصرًا عبر `sandbox.readArtifact` (المتحقق بالبصمة/الحجم/الصلاحية) ثم تنشر.
4. **Runtime:** معامل اختياري `artifacts` + أسلوبان: `listRunArtifacts` (خلف `getRunForOwner` — نفس ملكية `detail`) و`openArtifactDownload` (`artifact_store_disabled` عند الغياب).
5. **المسارات (`agent-routes.js`):** `GET /runs/:id/artifacts` خلف التوكن؛ `GET /artifacts/:id/download` **قبل** `authorize` عمدًا — التوقيع المنتهي الصلاحية هو التفويض كله (زر التنزيل رابط مباشر لا يحمل Bearer): بلا توقيع 401، بعد المهلة 410، عبث 409.
6. **التفعيل (`index.js`):** المخزن يُبنى حصرًا مع `CELIA_AGENT_SANDBOX=exec`؛ `CELIA_ARTIFACT_STORE_ROOT` / `CELIA_ARTIFACT_SIGNING_KEY` (غيابه = مفتاح عشوائي للإقلاع الحالي، الروابط تموت مع إعادة التشغيل عمدًا) / `CELIA_ARTIFACT_URL_TTL_MS` (افتراضي 15 دقيقة، خارج 1s..24h يُفشل الإقلاع).
7. **واجهة `/agent`:** قسم «الملفات الناتجة (artifacts)» بزر تنزيل لكل ملف (اسم/حجم/بصمة مختصرة/أجل الرابط)، وتحديث نص التذييل ليصدق حال B1/B2 (العزل مبني خلف تفعيل صريح، لا «غير مبني بعد»).

## الإثبات

- **`test/agent-artifact-store.test.js` — 9/9:**
  - ART-01 السطح المشروط: لا `artifact.create` بلا المخزن (ولا بالمنفّذ وحده) — القائم بلا تغيير.
  - ART-02 (قبول): حلقة كاملة — ناتج معزول → نشر → بصمة في السلسلة (`artifact_published`, chain ok) → القائمة → فتح الرابط الموقّع يعيد `{"total":5}` بايتًا ببايت.
  - ART-03 (قبول): قلب بايت واحد في الملف المخزن بعد التسليم → `artifact_tampered`.
  - ART-04 الرابط: توقيع مزوّر/مهلة معدّلة/نقل التوقيع لمعرف آخر/معاملات ناقصة → `artifact_signature_invalid`؛ بعد المهلة → `artifact_link_expired`.
  - ART-05 Idempotency بقاعدة البيانات: إعادة نشر = نفس الصف (`replayed`)؛ بصمة مغايرة = `artifact_conflict`.
  - ART-06 بايتات لا تطابق البصمة المعلنة → `artifact_hash_mismatch` وصفر صفوف.
  - ART-07 الإقلاع: مفتاح ضعيف → `artifact_signing_key_weak`؛ TTL خارج الحدود → `artifact_url_ttl_outside_bounds`.
  - ART-08 عبر HTTP حقيقي: القائمة 401 بلا توكن ثم 1 ملف؛ التنزيل الموقّع 200 بترويسة `X-Artifact-SHA256` و`Content-Disposition` وبايتات مطابقة؛ بلا توقيع/بتوقيع مزوّر 401؛ بعد العبث 409 `artifact_tampered`.
  - ART-09 (خلف `CELIA_SANDBOX_INTEGRATION=1`) تكامل حقيقي: عزل namespaces فعلي → `artifact.create` → تنزيل `result.json` بايتًا ببايت وسلسلة أدلة سليمة.
- **ثلاثي العزل تحت بيئة التكامل:** sandbox 17 + sandbox-tool 9 + artifact-store 9 = **35/35**.
- **الحزمة:** `npm run test:coverage` → **724 اختبارًا، 707 ناجحًا، فشل واحد** (N/N-1 البيئي المعروف)، تغطية **90.75 / 75.76 / 87.01** فوق الأرضيات؛ `check` 171 ملفًا؛ `release:check`؛ `build:pages` 12 صفحة؛ `npm audit --omit=dev` صفر ثغرات.

## حدود مُعلنة بصدق

- التخزين محلي فقط (الخيار R2-البديل من نص B2 لم يُبن — قرار استضافة لاحق)، ولا حذف/انتهاء صلاحية للملفات المخزنة نفسها بعد (مهلة الرابط فقط).
- غياب `CELIA_ARTIFACT_SIGNING_KEY` يعني موت الروابط عند إعادة التشغيل — سلوك مقصود فاشل-مغلقًا لا خلل.
- لا نشر ولا تفعيل افتراضي؛ كل شيء خلف `CELIA_AGENT_SANDBOX=exec` القائمة.
- قيد B1 القائم بلا تغيير: تشغيلة عزل واحدة لكل run (`sandbox_duplicate_run`)، وallowlist المخطِّط الحي قراءات فقط.

## خارج هذه الشريحة

- B3 (قوالب مخرجات: Markdown→HTML / CSV / صفحة ثابتة + 3 مهام ذهبية في `eval:ai`) — التالي في S4؛ ثم B4 (رفع Drive خلف الموافقة + outbox).
- PR #90 (A4 model_router) ما زال مفتوحًا **ومتعارضًا** مع `main` بعد دمج #91 — ينتظر قرار المالك (إعادة تطبيق فوق main الحالي أوصى بها الوكيل).
- GOV-001 ما زال يحجب S2/S3.
