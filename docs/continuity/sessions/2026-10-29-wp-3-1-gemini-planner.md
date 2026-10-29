# 2026-10-29 — WP-3.1 / AI-002: مزوّد Gemini واحتياط حتمي مرئي

## المهمة والتفويض

- طلب المالك بعد اختيار WP-2.2 سابقًا: الرسالة **«3»** = بدء **الخطوة 3 من الخطة التنفيذية** (WP-3.1)، وقد سبق أن أجاب على سؤال المزوّد بـ**Gemini المجاني بشروطه**.
- معرّفات BACKLOG: `AI-002` (الحزمة) و`AGENT-010` (تعتمد عليها). معيار القبول: مجموعة AI-001 بالنِسبة المعلنة مسبقًا (بلا تغيير هنا)، وعبارة «حتمي (تجريبي)» لا تُرفع قبل التفعيل الإنتاجي بقرار.
- النطاق المسموح: تنفيذ محلي + اختبارات + وثائق. **ما يحتاج موافقة مستقلة:** أي مكالمة Gemini حقيقية، وأي تفعيل في بيئة، وفتح/دمج PR.

## واقع البداية

- الفرع `arena/dd2f6ff7-phone-google` عند `0fe6327` (WP-2.2) بشجرة نظيفة، ومدفوع إلى الأصل.
- `createAgentHost` كان يرفض أي مخطط غير `demo` بـ`agent_planner_unavailable`، و`createProviderPlanner` موجود بلا مزوّد فعلي ولا سياسة احتياط.

## ما تغير فعليًا

- **`src/agent/planner-provider.js`:**
  - `GEMINI_PLANNER_POLICY` (تعليمة نظام عربية تفرض JSON واحدًا والقائمة المغلقة).
  - `toGeminiSchema` (تحويل تكراري: `type:['string','null']` → `nullable:true`، إسقاط `additionalProperties`/`maxLength`/`maxItems`/`minItems` **من السلك فقط**).
  - `createGeminiPlannerProvider` (POST واحد، مفتاح في ترويسة، `responseMimeType`/`responseSchema`، `fetchImpl` قابل للحقن، رموز أخطاء معلنة، بلا تسريب مفتاح أو جسم رد، `usage` من `usageMetadata` مع `costMicros:0` و`priceKnown:false`).
  - `PLANNER_PROVIDER_FAILURES` (قائمة مغلقة) و`createFallbackPlanner` (وسم `plannerFallback`، وراثة `providerDriven`/`allowedTools`، وإعادة رمي `planner_cancelled`/الرمز المجهول).
- **`src/agent/runtime.js`:** عند `plannerFallback` تُكتب خطوة «احتياط حتمي مرئي» و`plan_created` بحكم `block` مع بصمة طلب المزوّد.
- **`src/agent/index.js`:** `AGENT_PLANNER_MODES`/`readAgentPlanner` (فشل مغلق)، `PROVIDER_PLANNER_TOOLS`/`selectProviderTools` (قراءة فقط، 2–4)، ربط المخطط المركّب `gemini+deterministic-fallback`، ورفع قيد «demo فقط».
- **`.env.example`:** `CELIA_AGENT_PLANNER` و`CELIA_AGENT_PLANNER_TOOLS` و`CELIA_AGENT_PLANNER_TIMEOUT_MS` (كلها قيم موجودة في الكود الآن).
- **اختبار جديد:** `test/agent-planner-fallback.test.js` (`GEM-01..03` · `FB-01..04` · `HOST-01`).
- **الوثائق:** `docs/agent-planner-provider.md` (قسم WP-3.1)، `docs/agent-runtime.md` §3.4، `docs/agent-2026-execution-plan.md` (صف ونص WP-3.1)، `BACKLOG` (`AI-002`)، `DECISIONS` (**DEC-059**)، `CHANGELOG`، `STATE`، `NOW`.

## الفحوص

| الأمر/الفحص | commit/البيئة | النتيجة أو سبب عدم التشغيل |
|---|---|---|
| `node --test test/agent-planner-fallback.test.js` | شجرة العمل، Node 22.22.3 | **8/8** |
| `npm test` | شجرة العمل | **676 إجمالًا · 662 ناجحًا · 0 فشل · 14 skipped** |
| `npm run test:coverage` | شجرة العمل | **90.95% أسطر / 75.63% فروع / 86.99% دوال**؛ `planner-provider.js` 98.66% أسطر |
| `npm run check` | شجرة العمل | ✅ 168 ملف JavaScript |
| `npm run now:check` + `npm run check:continuity` | شجرة العمل | يُعاد تشغيلهما بعد تحديث STATE؛ `check:continuity` كشف سطرًا مكسورًا في BACKLOG (رمز `\|` داخل خلية) فأُصلح |
| `npm run test:sandbox` | — | **لم يُشغَّل**؛ لا تغيير في ملفات الـSandbox |
| `npm run test:mysql` / Playwright | — | **لم يُشغَّل**؛ لا MySQL ولا Chromium في الصندوق، ولا تغيير في `public/` |
| مكالمة Gemini حقيقية | — | **لم تُنفَّذ** ولا مفتاح في الصندوق؛ كل الاختبارات بـ`fetchImpl` وهمي |

## الحفظ والتسليم

- commit على `arena/dd2f6ff7-phone-google` ودفع إلى الأصل نفسه؛ **لا PR مفتوح** (يحتاج كلمة المالك).
- **لم يُفعّل** `CELIA_AGENT_PLANNER=provider` في أي بيئة؛ `demo` يبقى الافتراضي في الكود و`.env.example` وصفحات الحالة.
- لم تُنفَّذ عمليات خطرة: لا مكالمة مزوّد، لا نشر، لا ترحيل، لا دمج، لا لمس `workers/` أو `sql/` أو `public/`، لا تغيير في تقارير AI-001 المجمدة.

## الاستئناف

- العوائق: (1) تشغيل Gemini حي يحتاج مفتاحًا ونطاق قبول معزولًا بقرار مالك؛ (2) جدول أسعار إن أُريد `costMicros` غير صفري (WP-3.4)؛ (3) `plan.revised` و`call_many` لم يبدأا.
- الخطوة التالية بالضبط: كلمة مالك لفتح PR (WP-2.2 + WP-3.1 على الفرع نفسه)، ثم **WP-3.2** (`plan.revised` مرة واحدة لكل خطوة فاشلة من فئة قراءة/كتابة داخلية) أو تشغيل حي معزول لـWP-3.1.
- أُحدثت `STATE.md` و`NOW.md` وصف `AI-002` في `BACKLOG.md`، وأُلحق `DEC-059`.
