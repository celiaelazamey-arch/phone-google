# AI-002 — شريحة Planner وFunction Calling المحلية

**التاريخ:** 2026-10-29
**النطاق:** شريحة عمودية أولى داخل Runtime الحالي؛ ليست تفعيلًا لنموذج حي ولا اكتمالًا لكل WP-3.1.

## ما نُفّذ

- `src/agent/planner-provider.js` يضيف Planner قابلًا للحقن عبر `provider.createPlan(request)`. لا يحتوي الملف على SDK أو اتصال شبكة أو مفتاح مزود.
- يبني `Runtime` الطلب من الهدف، رسائل الخيط (`threadMessages`)، عقد الهدف، الخطوات، نتائج الأدوات السابقة، و`context.memory` (الملخصات والحقائق). عند تفعيل KB يمكن أن يختار النموذج `kb.search` ضمن القائمة المغلقة فتعود أدلة FTS5 كـ`tool_result`؛ في مسار Provider تُبنى الأداة بـ`plannerSafe:true` فتُقيّد النتائج بسياسة `planner-safe-v1` وتدخل في Evidence chain. لا توجد إضافة embeddings أو فهرسة دلالية لقاعدة الكود أو ضخّ بحث تلقائي غير مسجل.
- يمرر للـProvider أدوات قراءة executable فقط، بعدد **2–4**، مع `input_schema` وقائمة `allowedTools` مغلقة. لا يمكن تمرير Calendar أو WhatsApp أو Shell أو Git أو كتابة ملفات في هذه الشريحة.
- يطلب JSON بمخطط `PROVIDER_PLAN_SCHEMA`: جميع الخصائص مطلوبة، الأنواع محددة، و`additionalProperties:false`. القرار `call` أو `finish` أو `clarify`، وكل قرار يحمل `rationale` و`successCriteria` غير فارغة.
- عند `call` يعيد Runtime تنفيذ الأداة عبر Registry الحالي، ثم يضع نتيجتها في رسالة `tool_result` منظمة ويعيد سؤال Provider. يستطيع القرار التالي اختيار قراءة أخرى أو الإنهاء أو طلب التوضيح.
- لا إعادة تخطيط تلقائية بعد فشل أداة: يُسمح بإنهاء/توضيح بعد ملاحظة الفشل، ويُرفض اختيار أداة جديدة بـ`automatic_replan_disabled`. سياسة المراجعة المحدودة المستقبلية تبقى WP-3.2.
- تُسجل رموز `inputTokens`/`outputTokens`/`totalTokens` و`costMicros` إن أعادها الـProvider. غياب القياس لا يُختلق.

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
node --test test/agent-planner-provider.test.js
node --test test/knowledge-governance.test.js test/agent-kb-planner.test.js test/agent-verifier.test.js
```

يغطي الملف الأول مزودًا وهميًا حتميًا: هدفًا عربيًا مع قراءة و`tool_result`، هدفًا إنجليزيًا بلا أداة، التوضيح، JSON/أدوات مرفوضة، منع أداة خارجية قبل الموافقة، فشل القراءة، منع إعادة التخطيط، مهلة المزود، والاستئناف دون تكرار قراءة مؤكدة. وتغطي الملفات الإضافية سياسة الادعاء والمراجعة، ترقية/استعادة KB، ورفض الفاحص للنتائج المخالفة. في اختبار `agent-kb-planner` يختار المزود الوهمي `kb.search`، وينفذه Runtime، ثم يستهلك القرار التالي معرّف الدليل وتاريخ المراجعة؛ لا يكفي JSON صالح وحده للقبول. كل ذلك SQLite/mock فقط؛ لا يثبت جودة Gemini أو أي نموذج حي، ولا اتصال Google/WhatsApp، ولا جاهزية إنتاجية.

## شريحة A1 (2026-10-29، خطة «منافس مانوس» M-A) — Gemini خلف علم مع تحويل حتمي مرئي

- **العلم:** `CELIA_AGENT_PLANNER=gemini` (الافتراضي يبقى `demo` بلا أي تغيير سلوك). طلب `gemini` بلا
  `GEMINI_API_KEY` خطأ تهيئة صريح (`agent_planner_misconfigured`) — لا ارتداد صامت إلى demo.
- **المحوّل:** `src/agent/gemini-planner-provider.js` يبني طلب `generateContent` واحدًا
  (`responseMimeType: application/json`، حرارة 0، قصّ مدخلات حتمي معلن) ويعيد مغلفًا يفحصه
  `createProviderPlanner` بالمخطط الصارم نفسه؛ البوابة النهائية محلية دائمًا. `responseSchema` لم يُرسل
  عمدًا (أنواع nullable و`args` مفتوح خارج الـsubset المضمون)؛ اعتماده بعد قياس حي قرار لاحق.
- **التحويل المرئي:** `src/agent/planner-fallback.js` — عند فشل مزوّدي من قائمة أكواد صريحة
  (`PLANNER_FALLBACK_CODES`): قبل أي أداة يُستدعى المخطط الحتمي نفسه؛ بعد تنفيذ أدوات يكون الإنهاء
  الآمن تسليمًا بحدود (`bounded_delivery`) بلا أي أداة بديلة. الحالتان تسجلان خطوة `planner_fallback`
  ودليل `plan_created` بحكم `BLOCK` في السلسلة. الإلغاء و`automatic_replan_disabled` وأي كود خارج
  القائمة تُرفع كما هي.
- **أدوات المزوّد:** `celia.thread_context` و`celia.system_status` و`celia.draft_outline` (+`kb.search`
  عند تفعيل KB) — قراءة فقط، والحلقة تبقى المنفّذ الوحيد وقائمة سماح المنفذ تغطي مسار الاحتياط
  (`DEMO_PLANNER_TOOL_SURFACE`).
- **الاختبارات:** `test/agent-gemini-planner.test.js` — 24/24 بلا شبكة (fetch وهمي): بناء الطلب والقصّ،
  حراس المفتاح/الموديل، نجاح finish/call مع قياس الرموز، 8 أصناف رفض (HTTP 5xx/429، لا مرشحين، نثر،
  JSON مسوّر، خاصية زائدة، action مجهول، أداة خارج القائمة)، مهلة، تحويل مرئي قبل وبعد الأدوات،
  منع التحويل عند الإلغاء/إعادة التخطيط، وتوصيل الـhost (رفض قيمة مجهولة، رفض غياب المفتاح، قائمة
  السماح، تشغيل كامل بمزود محقون).
- **ما لا تدّعيه هذه الشريحة:** لا قياس جودة Gemini حيًا (ذلك A5 في خطة منافس مانوس)، لا `call_many` (A3)،
  لا model router أو تكلفة مقاسة (A4).

## شريحة A2 (2026-10-29) — إعادة التخطيط المحكومة `plan.revised`

- **السياسة:** `src/agent/replanner.js` (`createReplanPolicy`) — نافذة مراجعة واحدة Fail-Closed:
  `maxPerStep = 1` لكل خطوة فاشلة، و**حارس حلقة** `maxPerRun = 1` لكامل التشغيل (فشل المراجعة نفسها لا
  يفتح سلسلة مراجعات). أداة المراجعة يجب أن تكون `RISK.read` مسجلةً (دفاع تحت بوابة `allowedTools`)،
  والعدّ **حتمي من خطوات المخزن** المعنونة `plan.revised` لا من عدّاد ذاكرة — الاستئناف بعد انقطاع لا
  يمنح نافذة جديدة.
- **التوصيل:** `createProviderPlanner({ revisionPolicy })` — الافتراض `null` يحفظ العقد السابق حرفيًا
  (`automatic_replan_disabled`، مثبت بـRPL-08). وضع `gemini` في الـhost يشحن السياسة افتراضيًا.
- **السلسلة:** المراجعة المسموحة تُسجَّل خطوة `plan.revised` بعنوان ثابت (`REVISION_STEP_TITLE`) ودليل
  `plan_created` يحمل `revision` (الخطوة الفاشلة، الأداة، `attempt/maxPerStep`) — العنوان نفسه مصدر
  العدّ، فالسياسة والسجل لا ينفصلان.
- **أكواد الانحراف:** محاولة ثانية → `max_replan_exceeded` فورًا (توقف، ثم تحويل `planner_fallback`
  مرئي تحت الغلاف المحكوم)؛ أداة غير قرائية في مسار المراجعة → `replan_requires_read_tool`
  (والكتابة خارج `allowedTools` تُرفض قبل ذلك أصلًا بـ`invalid_provider_plan`).
- **المُتحقِّق المستقل:** فشل قراءة اسْتُدرك بمراجعة ناجحة لا يُحسب فشل `goal_contract` — بشروط ضيقة:
  الأداة الفاشلة `read` حصرًا + خطوة `plan.revised` بعد خطوة الفشل + نجاح أداة المراجعة فعلًا بعدها؛
  أي فشل كتابة/أثر خارجي أو مراجعة لم تنجح يبقى حاجبًا (`verification_blocked`، مثبت بـRPL-07).
- **الاختبارات:** `test/agent-replan.test.js` — 9/9 بلا شبكة، تشمل **اختباري الطفرة السلبيين
  الإلزاميين**: (1) محاولة إعادة تخطيط ثانية → رفض صريح `max_replan_exceeded` وصفر تنفيذ إضافي
  (RPL-04/05 بحارس الحلقة وحد الخطوة معًا)؛ (2) طلب أداة كتابة أثناء الاستعادة → حظر قبل أي موافقة أو
  outbox أو تنفيذ (RPL-06 + RPL-02 للدفاع العميق).
- **ما لا تدّعيه A2:** لا مراجعة لأثر خارجي أو كتابة بأي شكل، لا أكثر من مراجعة واحدة لكل تشغيل
  افتراضيًا، ولا تقييم جودة المراجعات بنموذج حي (A5).

## حدود صريحة

- لا إعادة تخطيط عند الفشل، ولا `call_many`، ولا model router، ولا Sandbox، ولا Shell/Git/ملفات عامة.
- لا يوجد دليل قبول Chromium أو MySQL جديد مرتبط بهذا التغيير. عائق الـshallow checkout في اختبار التوافق التاريخي عولج بجلب الـcommit المطلوب، ثم اجتازت المجموعة الكاملة والتغطية؛ لا يُعد ذلك قبولًا لخدمة خارجية.
