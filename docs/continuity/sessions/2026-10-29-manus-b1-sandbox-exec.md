# جلسة 2026-10-29 — MANUS-B1: `sandbox.exec` موصول بالحلقة (S4 / M-B)

**الفرع:** `arena/94838d66-phone-google` (من `main@a2879dd` — بعد دمج PR #89)
**النطاق:** صف B1 من [خطة منافس مانوس](../../manus-competitor-plan.md) — أول «محوّل» جديد يُبنى بالطريقة القياسية: ربط منفذ AGENT-003 القائم بسجل أدوات الحلقة خلف مفتاح بيئة فاشل-مغلقًا، بلا أي host fallback.

## ما نُفِّذ

1. **`src/agent/sandbox-policy.js`:** سقف `workspaceBytes` رُفع من 64MiB إلى **256MiB** (`268_435_456`)؛ الافتراضي 8MiB بلا تغيير، والقيم خارج الحدود تُفشل بناء السياسة كما كانت.
2. **`src/agent/tools.js`:** معامل جديد اختياري `sandbox = null` في `defaultToolDefinitions`؛ مع منفذ حاضر تصبح `sandbox.exec` محوّلًا فعليًا: `risk=internalWrite`، `settledFailures: true`، `timeoutMs: 35000`، و`execute` يستدعي `sandbox.run({ runId, code })`. أي حالة غير `succeeded` تُرفع بكود السبب الصريح (`blocked`/`timeout`/`resource_limit`/`failed`) ولا يُنفَّذ شيء على المضيف. النجاح يعيد ناتجًا مشذبًا مع `artifacts[{id, runId, name, bytes, sha256, uri, expiresAt}]` — لا stdout؛ النتائج تصدر حصرًا كملفات داخل `/workspace/artifacts/` مبصومة SHA-256. بدون منفذ يبقى التعريف الرافض القائم **حرفيًا**.
3. **`src/agent/runtime.js`:** قاعدة الفشل المسوّى: `risk=read` **أو** `settledFailures === true` → الحالة `failed` وتستمر الحلقة (يبقى الحجب عند المُتحقِّق)؛ غير ذلك `unknown` + مصالحة كما كان حرفيًا.
4. **`src/agent/index.js`:** بوابة `CELIA_AGENT_SANDBOX` بقيمتين فقط `off` (الافتراضي) و`exec`؛ أي قيمة أخرى تُفشل الإقلاع `agent_sandbox_misconfigured`. مفاتيح الضبط: `CELIA_SANDBOX_ARTIFACT_ROOT` / `CELIA_SANDBOX_WORKSPACE_BYTES` / `CELIA_SANDBOX_CPU_SECONDS` / `CELIA_SANDBOX_WALL_MS`؛ المنفذ يُبنى بـ`evidenceStore` نفسه.

## الإثبات

- **`test/agent-sandbox-tool.test.js` جديد — 9/9:**
  - SBX-01 بدون منفذ: التعريف الرافض مطابق بايتًا ببايت (حارس توافق خلفي).
  - SBX-02 نجاح عبر الحلقة: ناتج مشذب + artifacts كاملة الحقول بما فيها `runId`.
  - SBX-03 فشل العزل يُرفع بكوده الصريح ولا host fallback.
  - SBX-04 الثابت: فشل معزول واحد → `failed` مستقر → `verification_blocked`؛ محاولة عزل واحدة بالضبط وصفر تنفيذ مضيف.
  - SBX-05 حارس طفرة: أداة `internalWrite` فاشلة **غير** معلنة `settledFailures` ما زالت `unknown` + مصالحة (سلوك قديم حرفي).
  - SBX-06 بوابة `CELIA_AGENT_SANDBOX`: قيمة غير صالحة → `agent_sandbox_misconfigured` عند الإقلاع.
  - SBX-07 السياسة: الافتراضي 8MiB؛ 256MiB مقبول؛ 256MiB+1 → `sandbox_workspace_bytes_outside_bounds`.
  - SBX-08 allowlist المخطِّط الحي قراءات فقط → مزود حي لا يستطيع استدعاء `sandbox.exec` (توسيعها قرار حوكمة مستقل).
  - SBX-09 (خلف `CELIA_SANDBOX_INTEGRATION=1`) **تكامل حقيقي كامل الحلقة**: منفذ namespaces فعلي، مهمة «حلّل CSV واحسب» خطة → تنفيذ معزول → تحقق → تسليم، `result.json` (`{"total":5}`) يُقرأ عبر `readArtifact` ببصمة متطابقة، أدلة `sandbox.*` في سلسلة التشغيل و`evidenceChain.ok`.
- **تكامل Sandbox القائم:** `CELIA_SANDBOX_INTEGRATION=1` → `test/agent-sandbox.test.js` 17/17 + الملف الجديد 9/9 = **26/26**.
- **الحزمة الكاملة:** `npm run test:coverage` → **715 اختبارًا، 699 ناجحًا، فشل واحد** (N/N-1 البيئي المعروف — خط أساس)، تغطية **90.72% أسطر / 75.84% فروع / 86.93% دوال** فوق الأرضيات؛ `npm run check` 170 ملفًا؛ `release:check` و`build:pages` (12 صفحة) و`npm audit --omit=dev` صفر ثغرات.

## حدود موثقة (فاشلة-مغلقة، لا تُدّعى قدرات فوقها)

- تشغيلة واحدة لكل `runId` (حجز `wx` في المنفذ) — استدعاء ثانٍ في نفس التشغيل → `sandbox_duplicate_run`.
- لا Python داخل العزل بعد (شق B1 المتبقي)؛ Node فقط.
- لا نشر ولا تفعيل افتراضي: `CELIA_AGENT_SANDBOX` الافتراضي `off`، والتشغيل في بيئة الإنتاج قرار مالك مستقل.
- allowlist أدوات المخطِّط الحي لم تتغير — `sandbox.exec` متاح للمخطط الحتمي/الاختبارات حصرًا حتى قرار حوكمة.

## خارج هذه الشريحة

- B2 (`artifact.create` + مخزن artifacts برابط موقّع) — التالي في S4؛ `runId` في الناتج المشذب وُضع عمدًا لأن B2 يحتاجه للاسترجاع.
- PR #90 (A4 model_router) ما زال مفتوحًا بانتظار كلمة المالك؛ GOV-001 ما زال يحجب S2/S3.
