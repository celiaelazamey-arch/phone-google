# AI-002 — شريحة Planner وFunction Calling المحلية

**التاريخ:** 2026-10-29
**النطاق:** شريحة عمودية أولى داخل Runtime الحالي (AI-002 slice) + **مزوّد Gemini و`planner_fallback` المرئي (WP-3.1، DEC-059)**.
**لا شيء هنا مفعّل في الإنتاج:** `CELIA_AGENT_PLANNER` افتراضيه `demo`، ولم تُنفَّذ أي مكالمة Gemini حقيقية في هذه الجلسة (لا مفتاح في الصندوق)،
ولا يوجد ادعاء جاهزية إنتاجية أو جودة نموذج.

## ما نُفّذ

- `src/agent/planner-provider.js` يضيف Planner قابلًا للحقن عبر `provider.createPlan(request)`. لا يحتوي الملف على SDK أو اتصال شبكة أو مفتاح مزود.
- يبني `Runtime` الطلب من الهدف، رسائل الخيط (`threadMessages`)، عقد الهدف، الخطوات، نتائج الأدوات السابقة، و`context.memory` (الملخصات والحقائق). عند تفعيل KB يمكن أن يختار النموذج `kb.search` ضمن القائمة المغلقة فتعود أدلة FTS5 كـ`tool_result`؛ في مسار Provider تُبنى الأداة بـ`plannerSafe:true` فتُقيّد النتائج بسياسة `planner-safe-v1` وتدخل في Evidence chain. لا توجد إضافة embeddings أو فهرسة دلالية لقاعدة الكود أو ضخّ بحث تلقائي غير مسجل.
- يمرر للـProvider أدوات قراءة executable فقط، بعدد **2–4**، مع `input_schema` وقائمة `allowedTools` مغلقة. لا يمكن تمرير Calendar أو WhatsApp أو Shell أو Git أو كتابة ملفات في هذه الشريحة.
- يطلب JSON بمخطط `PROVIDER_PLAN_SCHEMA`: جميع الخصائص مطلوبة، الأنواع محددة، و`additionalProperties:false`. القرار `call` أو `finish` أو `clarify`، وكل قرار يحمل `rationale` و`successCriteria` غير فارغة.
- عند `call` يعيد Runtime تنفيذ الأداة عبر Registry الحالي، ثم يضع نتيجتها في رسالة `tool_result` منظمة ويعيد سؤال Provider. يستطيع القرار التالي اختيار قراءة أخرى أو الإنهاء أو طلب التوضيح.
- لا إعادة تخطيط تلقائية بعد فشل أداة: يُسمح بإنهاء/توضيح بعد ملاحظة الفشل، ويُرفض اختيار أداة جديدة بـ`automatic_replan_disabled`. سياسة المراجعة المحدودة المستقبلية تبقى WP-3.2.
- تُسجل رموز `inputTokens`/`outputTokens`/`totalTokens` و`costMicros` إن أعادها الـProvider. غياب القياس لا يُختلق.

## WP-3.1 — المزوّد الفعلي والاحتياط الحتمي المرئي (DEC-059)

أُضيف إلى `src/agent/planner-provider.js` ثلاث قطع، تبقى كلها **خلف `plan()`** نفسه ولا تعرف الأدوات أو الموافقات:

1. **`createGeminiPlannerProvider({ apiKey, model, fetchImpl })`** — النقل فقط: POST واحد إلى
   `models/<model>:generateContent` بمفتاح في ترويسة `x-goog-api-key`، و`responseMimeType:'application/json'`
   و`responseSchema` محوَّل إلى صيغة Gemini (`toGeminiSchema`: `type:['string','null']` → `nullable:true`، وإسقاط
   `additionalProperties`/`maxLength`/`minItems` من السلك فقط). **المخطط المحلي يبقى الحاكم:** نفس الخطة تُفحص محليًا
   بـ`validateProviderPlan` بكل قيودها، فما يُسقطه السلك لا يُسقطه الفحص. لا SDK، لا إعادة محاولة، لا نقطة نهاية بديلة،
   و`fetchImpl` قابل للحقن فتُختبر الحزمة بلا شبكة.
2. **`createFallbackPlanner({ primary, fallback })`** — عند فشل المزوّد (قائمة مغلقة `PLANNER_PROVIDER_FAILURES`)
   يتولى `demo-deterministic` القرار ويُعاد **موسومًا** بـ`plannerFallback:{code, details, provider, model, request}`.
   `Runtime` يحوّل الوسم إلى **خطوة مرئية** «احتياط حتمي مرئي» + مدخل `plan_created` بحكم `block` (الخطة النموذجية لم تُقبل؛
   الذي نُفِّذ هو قرار الاحتياط). **لا يُلطَّف الإلغاء:** `planner_cancelled` (أو `signal.aborted`) يُعاد كما هو، وأي رمز خارج
   القائمة المغلقة يُعاد بلا احتياط.
3. **تضييق سطح الأدوات:** الغلاف يرث `providerDriven` و`allowedTools` من المخطط المزوّد، فيهبط في `Runtime`
   `plannerToolAllowlist` إلى أدوات القراءة المغلقة (2–4). تشغيل العلم **لا يمكن أن يوسّع** سطح التنفيذ: أثر خارجي في وضع
   المزوّد يبقى خارج القائمة حتى لو اقترحه الاحتياط.

اختيار المخطط في `createAgentHost`:
`CELIA_AGENT_PLANNER=demo` (افتراضي) أو `provider` (و`gemini` مرادف صريح)، وأي قيمة أخرى تُسقط الإقلاع بـ`invalid_agent_planner`.
وضع `provider` بلا `GEMINI_API_KEY` يفشل مغلقًا بـ`planner_provider_not_configured`، ونقص أدوات القراءة يفشل بـ
`planner_tools_unavailable`. الحالة في `/api/agent/status` تُظهر `planner: gemini+deterministic-fallback` و`plannerToolAllowlist`.

**التكلفة لا تُختلق:** الرموز تُقاس من `usageMetadata` وتصل `recordCost`، أما `costMicros` فتبقى **0** لأن المستودع لا يحمل
جدول أسعار، و`usage.priceKnown=false` يعلن ذلك صراحةً (DEC-054/DEC-059).

## الحوكمة والتنفيذ

السماح ليس قيدًا في الـPrompt فقط:

1. يتحقق Planner من المخطط والأداة المغلقة ومدخلات الأداة قبل إرجاع القرار.
2. يعيد `Runtime` فحص وجود الأداة، `plannerToolAllowlist`، و`tools.validateInput` قبل `startToolRun` أو أي موافقة/outbox. عند Planner المزود تُشتق قائمة المنفذ تلقائيًا من `planner.allowedTools`، ويمكن تضييقها صراحة عند إنشاء Runtime.
3. تبقى الموافقات وoutbox وidempotency والمصالحة كما هي. لا تُستخدم أدوات خارجية في هذه الشريحة، ولا يوجد إرسال أعمى لنتيجة `unknown`.
4. يحتفظ `createAgentHost` بمساره الافتراضي `demo-deterministic`؛ لم يُضف علم إنتاج أو مزود حي. التصدير البرمجي للـPlanner لا يعني تفعيله في التطبيق.

## حوكمة `kb.search` في هذه الشريحة

- `src/knowledge/governance.js` يعرّف `operational_guidance` و`historical_report` و`unverified_recommendation` و`deprecated_security_practice`. كل سجل معرفة يحمل `review_due` بتاريخ مراجعة صالح؛ الحقول القديمة الناقصة تفشل مغلقة ولا تصبح مؤهلة.
- `profile:'planner'` في المخزن يستبعد أي مرشح ليس `doc` أو ليس توجيهًا تشغيليًا أو ليس T1/T2 أو انتهت مراجعته، قبل بناء `items` التي يراها النموذج. لا تُستخدم المطابقة المباشرة للكيانات لإدخال كيان من دليل مستبعد.
- `defaultToolDefinitions({ kb, plannerSafe: true })` هو مسار الحقن للاختبار/المضيف المخصص؛ لا يغيّر `createAgentHost` الافتراضي. يرفض `createProviderPlanner` تسجيل `kb.search` بلا علامة الأمان البرمجية هذه، فشلًا مغلقًا قبل أي قرار أو تنفيذ. النتيجة تحمل `governance` و`claimType` و`reviewDue` و`reviewStatus` و`plannerEligible` مع المصدر والترخيص والثقة.
- `kb_planner_governance` في المتحقق المستقل يعيد حساب الأهلية ويرفض السياسة أو العنصر المخالف؛ في Run يحمل أدلة Provider يكون غياب غلاف الحوكمة نفسه `BLOCK`؛ لا يكتفي بوصف النموذج أو بصحة JSON.

## الأدلة

لمسار Provider فقط، تُضاف إلى سلسلة الأدلة الحالية أحداث مستقلة:

| الحدث | المعنى |
|---|---|
| `plan_created` | قبول خطة أو رفضها، مع نتيجة التحقق |
| `tool_selected` | اختيار الأداة وسماح المنفذ، قبل بدء الاستدعاء |
| `tool_executed` | النتيجة المؤكدة أو فشل الأداة، بعد تسوية `toolRun` |
| `verification_result` | حكم المتحقق المستقل قبل التسليم |

كل حدث مرتبط بـ`stepId` وله `inputHash` و`outputHash` من SHA-256 ضمن السلسلة الحالية. لا تتغير أنواع أدلة مسار `demo`، ولا تُعدّل تقارير AI-001 المجمدة.

## الاختبار المحلي

```sh
node --test test/agent-planner-provider.test.js   # 10/10 شريحة AI-002 الأولى
node --test test/agent-planner-fallback.test.js   # 8/8 WP-3.1 (GEM-01..03 · FB-01..04 · HOST-01)
node --test test/knowledge-governance.test.js test/agent-kb-planner.test.js test/agent-verifier.test.js
```

يغطي الملف الأول مزودًا وهميًا حتميًا: هدفًا عربيًا مع قراءة و`tool_result`، هدفًا إنجليزيًا بلا أداة، التوضيح، JSON/أدوات مرفوضة، منع أداة خارجية قبل الموافقة، فشل القراءة، منع إعادة التخطيط، مهلة المزود، والاستئناف دون تكرار قراءة مؤكدة. وتغطي الملفات الإضافية سياسة الادعاء والمراجعة، ترقية/استعادة KB، ورفض الفاحص للنتائج المخالفة. في اختبار `agent-kb-planner` يختار المزود الوهمي `kb.search`، وينفذه Runtime، ثم يستهلك القرار التالي معرّف الدليل وتاريخ المراجعة؛ لا يكفي JSON صالح وحده للقبول. كل ذلك SQLite/mock فقط؛ لا يثبت جودة Gemini أو أي نموذج حي، ولا اتصال Google/WhatsApp، ولا جاهزية إنتاجية.

## حدود صريحة

- **`planner_fallback` و`CELIA_AGENT_PLANNER=provider` صارا منفَّذين في الكود (DEC-059)، لكنهما غير مفعّلين في أي بيئة**؛
  الافتراضي `demo`، ولا يوجد ملف إنتاج يغيّره.
- **لا مكالمة Gemini حقيقية في هذه الجلسة:** لا مفتاح في الصندوق، والاختبارات تستخدم `fetchImpl` وهميًا. أي تشغيل حي بقرار
  مالك مستقل ومعزول، و`docs/agent-runtime.md` لا يرفع عبارة «حتمي (تجريبي)» قبل ذلك.
- لا إعادة تخطيط عند الفشل (`plan.revised`)، ولا `call_many`، ولا model router، ولا Sandbox، ولا Shell/Git/ملفات عامة —
  هذه WP-3.2/WP-3.3/WP-3.4.
- لا يوجد دليل قبول Chromium أو MySQL جديد مرتبط بهذا التغيير. عائق الـshallow checkout في اختبار التوافق التاريخي عولج بجلب الـcommit المطلوب، ثم اجتازت المجموعة الكاملة والتغطية؛ لا يُعد ذلك قبولًا لخدمة خارجية.
