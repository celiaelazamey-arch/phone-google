# جلسة 2026-10-29 — MANUS-A4: موجّه النماذج `model_router`

**الفرع:** `arena/718068f3-phone-google` · **الخطة:** [منافس مانوس](../../manus-competitor-plan.md) M-A صف A4 / درجة الصعود S1 · **يبني على:** A1+A2+A3 المدموجة في `main` عبر PR #89 (`a2879dd`)

## ما نُفّذ

- **`src/agent/model-router.js` (جديد):** مزوّد فوق مزوّدين متوافق مع `createProviderPlanner`:
  - طبقتان: `fast` (استخراج/تلخيص فوق ملاحظات ناجحة) و`planner` (التخطيط الابتدائي + أي قرار بعد
    فشل ملحوظ — المراجعة المحكومة A2 تستحق أقوى تفكير).
  - `defaultRoute` دالة خالصة حتمية؛ القرار (tier/reason/pricing) يُثبَّت في `usage.router` فيُبصم
    في سلسلة الأدلة عبر `outputHash` (المخزن يحفظ البصمات لا الحمولات — بتصميمه).
  - `computeCostMicros`: رموز المزوّد المقاسة × تسعير معلن (ميكرو-دولار/1000 رمز) بتقريب لأعلى دائمًا.
  - **رفض لا تجاوز:** `maxCostMicrosPerCall` أسوأ حالة معلنة لكل طبقة؛ «المُنفق + أسوأ حالة > السقف»
    → `cost_budget_refused` قبل الإرسال (صفر إنفاق)؛ غياب عقد الميزانية → `cost_budget_unknown`
    (Fail-Closed)؛ رموز فوق الأسوأ المعلن → `model_cost_contract_violation`.
  - `DECLARED_GEMINI_PRICING` إعلان تهيئة مؤرخ (2026-10) لا قياس؛ `DEFAULT_PER_CALL_CAPS` قرار معلن.
- **`planner-provider.js`:** `requestFor` يحمل عقد الميزانية `budget` من صف التشغيل الحقيقي
  (`run.limits.maxCostMicros` / `run.usage.costMicros`)؛ `usageOf` يمرر `usage.router` إلى الأدلة.
- **`runtime.js`:** `cost_budget_refused` ينهي التشغيل `budget_exhausted` (لا `failed` عام) بخطوة
  «فشل التخطيط» مرئية ودليل BLOCK.
- **`evaluation.js`:** `computeAgentMetrics` (مغذّي `/api/agent/metrics`) يضيف
  `cost: { totalCostMicros, totalTokens, runsWithCost }` من كل التشغيلات، والحالة الفارغة تحمل البند.
- **`index.js`:** وضع `CELIA_AGENT_PLANNER=gemini-router` — طبقتا Gemini (النموذج الأقوى من
  `config.gemini.model`، والسريع من `CELIA_AGENT_FAST_MODEL`، افتراضيه `gemini-2.5-flash-lite`)؛
  نموذج بلا تسعير معلن = خطأ تهيئة صريح؛ وضعا `demo` و`gemini` بلا تغيير حرفيًا؛ تصدير واجهات A4.

## الدليل

- **`test/agent-model-router.test.js` — 10/10 بلا شبكة:** MR-01 توجيه حتمي خالص؛ MR-02 عقد البناء؛
  MR-03 حساب التكلفة بتقريب لأعلى؛ **MR-04 (طفرة سلبية): الاستدعاء الذي لا يتسع يُرفض قبل بلوغ
  المزوّد (صفر استدعاءات)**؛ MR-05 خرق عقد التسعير يوقف بكود صريح؛ MR-06 غياب الميزانية Fail-Closed؛
  MR-07 تشغيلة حقيقية: planner ثم fast والتكلفة المجموعة 600 ميكرو في `recordCost` والقرار في
  `providerTrace.usage.router`؛ **MR-08 (معيار القبول): سقف 800 — النداء الثاني يُرفض قبل الإرسال،
  الإنفاق 400 ≤ 800 دائمًا، الحالة `budget_exhausted`**؛ MR-09 بند `cost` في المقاييس؛
  MR-10 أكواد الرفض الثلاثة خارج `PLANNER_FALLBACK_CODES` ولا تُحوَّل.
- **الحزمة:** 701 ناجح / 14 متجاوز / 1 فشل بيئي معروف (secrets-hub N/N-1). التغطية
  **90.82 / 75.92 / 86.97** فوق 89/71/82. البوابات: check (170 ملفًا)، release:check،
  build:pages (12)، audit (0 ثغرات) — خضراء.

## قرارات

- التسعير **إعلان مالك مؤرخ** لا قياس — موثق كذلك في الكود والوثيقة؛ تحديثه قرار معلن.
- أكواد الميزانية حوكمة لا فشل مزوّد → خارج التحويل الحتمي (نفس منطق `automatic_replan_disabled`).
- `cost_budget_refused` → `budget_exhausted` في الـruntime: استنفاد معلن لا فشل غامض.
- ما بعد الفشل يذهب للطبقة الأقوى دائمًا — الاستعادة ليست مكانًا للتوفير.

## التالي

- **S2/S3 (A5 والقياس الحي):** معلّقان على GOV-001 (مفتاح + ميزانية) — قرار مالك.
- إن تأخر GOV-001: القفز إلى **S4 (M-B اليدان: `sandbox.exec` بالحلقة + artifacts)** وفق قاعدة
  الصعود 4 (المسار الحرج لا يتوقف).
