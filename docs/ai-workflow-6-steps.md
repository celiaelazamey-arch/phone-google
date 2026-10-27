# دليل عملي لتعلّم الذكاء الاصطناعي وتطبيقه في ست خطوات — مع التطبيق العملي على CeliaOS

**القاعدة الأساسية:** لا تبدأ باختيار نموذج الذكاء الاصطناعي؛ ابدأ بالمشكلة التي تريد حلها، ثم اختر أقل منظومة تعقيدًا وتكلفة تحقق النتيجة المطلوبة.

---

## الخطوة 1: حدد المهمة قبل اختيار النموذج

قسّم أي مهمة إلى **مدخلات**، و**نتيجة مطلوبة**، و**معيار نجاح يمكن اختباره** (`Goal Contract` في [src/agent/goal-contract.js](../src/agent/goal-contract.js)):

| المهمة | التقنية المناسبة في CeliaOS | التنفيذ الفعلي في الكود |
|---|---|---|
| حساب أسعار وفواتير | كود حتمي، لا اعتماد على تخمين النموذج | `validateExtractedData` في [src/agent/automation/validator.js](../src/agent/automation/validator.js) |
| استخراج بيانات من مستندات | استخراج منظم مع قواعد تحقق برمجية وبصمة SHA-256 | `document_data_automation` (`DEC-020`) في [src/agent/automation/index.js](../src/agent/automation/index.js) |
| تحليل كتالوج منتجات | فحص الحقول الناقصة وصياغة مسودة وصف للمراجعة قبل النشر | `auditProductCatalog` (`product.catalog_audit`) في [src/agent/evaluation.js](../src/agent/evaluation.js) |
| تلخيص النصوص وتصنيفها | نموذج لغوي سريع ومنخفض التكلفة | `recommendTaskStrategy` (`fast_low_cost_llm`) |
| تحليل مشكلة تقنية معقدة | نموذج قوي في الاستدلال والبرمجة | `recommendTaskStrategy` (`reasoning_llm`) |
| تصميم صور وإعلانات | سير عمل إبداعي من 6 مراحل مع فحص القيود | `buildCreativeWorkflowPlan` (`creative.workflow_plan`) |
| تنفيذ خطوات على خدمة خارجية | وكيل يستخدم أدوات بصلاحيات محددة و`agent_outbox` | موصلات `google.calendar`، `whatsapp.cloud`، `google.drive` (`DEC-022`) |

---

## الخطوة 2: اختر النموذج المناسب، وليس النموذج الأشهر

تُطبَّق هذه القاعدة في دالة `recommendTaskStrategy({ taskType, goal })` داخل [src/agent/evaluation.js](../src/agent/evaluation.js) وفي موجه المزودات [src/ai-providers.js](../src/ai-providers.js):
- **نموذج سريع ومنخفض التكلفة (`fast_low_cost`):** للتصنيف، وتحديد الأداة المطلوبة، وإعادة الصياغة.
- **نموذج أقوى في الاستدلال (`strong_reasoning`):** لتصميم المعماريات، وتحليل الأعطال، وتخطيط المهام متعددة الخطوات.
- **نموذج متخصص في الوسائط (`multimodal_plus_fast_llm`):** للصوت أو التصميم ضمن مراحل منضبطة.

---

## الخطوة 3: تجاوز عقبة التكلفة دون التضحية بالاستقرار

تُحسب التكلفة التقديرية للرموز النصية في `estimateTokenCost` داخل [src/agent/evaluation.js](../src/agent/evaluation.js) وفق الصيغة:

$$\text{التكلفة} \approx \frac{\text{رموز الإدخال}}{10^6}\times \text{سعر الإدخال} + \frac{\text{رموز الإخراج}}{10^6}\times \text{سعر الإخراج}$$

ويفرض حارس `evaluateProviderSafety` ثلاثة قيود صارمة:
1. عدم إرسال أي أسرار أو بيانات عملاء خام (`PII`) إلى الخطط المجانية (`customer_pii_blocked_on_free_tier`).
2. وجود مهلة زمنية صريحة لكل طلب (`explicit_request_timeout_required`).
3. وجود سلوك سقوط آمن عند نفاد الحصة (`quota_exhaustion_fallback_required`).

---

## الخطوة 4: ادمج عدة تقنيات في دورة عمل واحدة

تُدار هذه الدورة في [src/agent/runtime.js](../src/agent/runtime.js) و[src/agent/harness.js](../src/agent/harness.js):
1. **فهم الهدف (`Goal & Task Engine`):** عقد هدف قابل للفحص الآلي (`agent_goal_contracts`).
2. **التخطيط واختيار النموذج والأدوات (`Planner + Model Router + Tool Registry`):** `PLAN_READY → WAITING_FOR_APPROVAL`.
3. **التنفيذ المنضبط:** قواعد حتمية + أدوات مصنفة بالمخاطر + `agent_outbox`.
4. **التحقق المستقل (`Evidence + Verifier`):** سلسلة بصمات SHA-256 (`agent_evidence`) + `verifier.js` + بوابة الفهم `Comprehension Gate` (`DEC-021`).
5. **النتيجة أو المراجعة البشرية:** تسليم موثّق (`PASS`)، أو طلب مراجعة بشرية (`review_required`)، أو إيقاف آمن (`needs_reconciliation`).

---

## الخطوة 5: حوّل هذا الدمج إلى إنتاج إبداعي وتجاري فعلي

توفّر دالة `buildCreativeWorkflowPlan` (الأداة `creative.workflow_plan`) المراحل الست المنضبطة:
1. **صياغة الملخص الإبداعي (`creative_brief`):** الجمهور، الرسالة، الأسلوب، المقاس، والقيود.
2. **توليد الأفكار (`ideation_directions`):** عدة اتجاهات متمايزة بدل الاكتفاء بأول اقتراح.
3. **إنتاج المسودة (`draft_production`):** اختيار الأداة المناسبة بعد اعتماد الملخص.
4. **فحص المخرجات (`output_inspection`):** مراجعة الأبعاد، اتجاه RTL، والحقوق.
5. **التعديل والتحسين (`targeted_refinement`):** ملاحظات محددة قابلة للقياس.
6. **التسليم المنظم (`organized_delivery`):** حفظ النسخة النهائية ومصدرها ونتيجة المراجعة.

---

## الخطوة 6: قِس النتائج وحوّل التجربة إلى نظام قابل للتحسين

يمثّل CeliaOS الحلقة السباعية في `CELIA_SEVEN_STAGE_LOOP`:

`Goal → Plan → Execute → Observe → Verify → Evidence → Improve`

وتفصل دالة `buildTruthPartition` في كل تشغيل وفي واجهة `/agent` بين ثلاثة أشياء:
1. **ما نُفّذ فعلًا (`executed`):** تؤكده سجلات `agent_tool_runs` (`succeeded`) و`agent_outbox` (`sent`).
2. **ما تحقّق منه النظام (`verified`):** تؤكده فحوص `verifier.js` المستقلة وسلسلة `agent_evidence` وبوابة الفهم (`PASS`).
3. **ما لم يثبت بعد (`unverified`):** يبقى غير متحقق (مثل الموافقات المعلقة أو النتائج غير المحسومة `unknown`) حتى لو بدا الناتج مقنعًا.

وتحسب دالة `computeAgentMetrics` (ونقطة `GET /api/agent/metrics`) المؤشرات الستة:
- نسبة المهام الناجحة (`successRate`).
- عدد مرات إعادة المحاولة (`retryCount`).
- دقة البيانات (`dataAccuracyRate`).
- متوسط زمن الإنجاز (`averageDurationMs`).
- التكلفة لكل مهمة مكتملة (`costPerCompletedTaskMicros`).
- عدد الحالات التي احتاجت إلى مراجعة بشرية (`humanReviewCount`).
