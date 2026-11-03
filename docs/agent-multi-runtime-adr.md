# CELIA-ADR (مقترح) — معمارية وكلاء متعددة المحركات، مستقلة عن المزوّد

**الحالة: 🔵 مقترح — غير معتمد، ولا تنفيذ معلقًا على تدقيق المستودع.**
**التاريخ:** 3 نوفمبر 2026 · **المعرّف:** لم يُحجز `DEC` — يُحجز عند الاعتماد فقط.
**الصف:** `MULTI-001` (مقترح بانتظار موافقة المالك) · **الفرع:** `arena/342e1174-phone-google`
**المصدر:** توصية المالك بدمج OpenAI Agents SDK **كمحرك قابل للاستبدال، لا كنظام تشغيل**.

> هذا المستند لا يضيف ميزة ولا اعتمادية ولا علم بيئة. `AGENTS.md`: «في المقترحات،
> وسِم السلوك المستقبلي بوضوح. لا تضف أعلامًا مقترحة إلى `.env.example` ولا تغيّر
> بيانات الإصدار قبل وجود التنفيذ.»

---

## 1 · الخلاصة قبل التفصيل

التدقيق الذي سبق هذا الفصل (‏`ASSUR-005` / `DEC-117`، وقراءة `verifier.js` و`runtime.js`
و`outbox.js` و`harness.js` و`tools.js` و`delegation.js` و`model-router.js` و`goal-contract.js`
و`memory.js` و`web-tools.js` و`web-fetch.js` و`egress-proxy.js` و`gmail.js`) يثبت:

**الفصل المعماري الذي يطلبه المقترح موجود فعلًا — لكن نقطة الفصل تقع عند المخطط، لا عند الحلقة.**

- الموجود اليوم: `plan(context) → خطة مُتحقَّق منها بالمخطط` ← **وحلقة التنفيذ كلها ملك `runtime.js`**.
- ما يطلبه المقترح: نقل الفصل إلى **الحلقة** نفسها (`Agent Loop → SDK أو Native`).

وهذا ليس تفصيلًا: **كل فرض الأمن يسكن الحلقة**. في `runtime.js` بالترتيب:
`plannerToolAllowlist` ← `tools.validateInput` ← `noProgress` ← **بوابة `tools.executable()`**
← `requestApproval` + `outbox.enqueue` ← `verifyApprovedEffectIntegrity` ← الإرسال عبر الموصلات
← `verifier.verifyRun`. نقل الحلقة إلى محرك خارجي يعني نقل هذا الترتيب كله.

---

## 2 · القاعدة الحاكمة: قلب الاتجاه، لا استبدال الحلقة

> **المحرّك البديل يقترح. CeliaOS تنفّذ.**

لا يُسلَّم المحرك الخارجي أي أداة حقيقية. تُسلَّم له **أدوات بالوكالة** تفعل شيئًا واحدًا:
تُدرج نية في الـoutbox وتعيد «موقوفة بانتظار الموافقة». الأثر الخارجي يبقى حصرًا في مسار
`outbox.js` القائم.

**السبب، من عقيدة المستودع لا من رأي:** `AGENTS.md` (UX-005) — «`agent_delegations` هي
الرابط، **لا مسار تنفيذ ثانٍ**». وأدوات SDK الوظيفية، إن مُنحت منفّذًا حقيقيًا، تصير
مسار تنفيذ ثانٍ بالضبط.

**اختبار سالب إلزامي في P0 (لا يُقبل بدونه):** محرك بديل يطلب أداة `external_effect`
→ لا يصل أي منفّذ حقيقي، وتُدرج نية واحدة، ويتوقف التشغيل على `waitingApproval`.

---

## 3 · تصحيحات على جدول الملكية المقترح

| المكوّن | في المقترح | الحكم المبني على التدقيق |
|---|---|---|
| Task Lifecycle | CeliaOS | ✅ صحيح — `PLAN_LIFECYCLE_STATE` + `RUN_STATUS` مركزيان في `store.js` |
| Canonical Memory | CeliaOS | ✅ صحيح — `memory.js` + `store.js`؛ و«لا مخزن في الذاكرة عن قصد» (`drivers.js`) |
| Approval Authority | CeliaOS | ✅ صحيح — `outbox.js` + `verifyApprovedEffectIntegrity` |
| Capability Registry | CeliaOS | ✅ صحيح — `tools.js` بتصنيف `RISK` الإجباري |
| Execution Sandbox | CeliaOS | ✅ صحيح — `sandbox.js`/`sandbox-policy.js`؛ **لكن `isolatedContainerAvailable=false` حتى AGENT-003** |
| Evidence Store | CeliaOS | ✅ صحيح — `evidence.js` بسلسلة `EVIDENCE_LEDGER` |
| Independent Verification | CeliaOS | ✅ صحيح — `verifier.js` بـPASS/BLOCK/UNKNOWN، ويوقف التشغيل فعلًا |
| Model Routing | CeliaOS | ✅ صحيح — `model-router.js` بـ`MODEL_TIERS`/`ROUTE_REASONS`/`computeCostMicros` |
| **Agent Handoffs** | **SDK Adapter** | ❌ **مرفوض كما هو مكتوب.** التسليم مملوك بحساب أمني لا يملكه SDK: `delegation.js` — `MAX_DEPTH=2` · `MAX_FANOUT=4` · `RISK_ORDER` · `parentDigest` («أبوان بنفس المعرّف وسقف مختلف ليسا نفس السلطة») · وعقد **No widening**: سقف خطر الابن ≤ سقف الأب، وأدواته مجموعة فرعية، وميزانيته **تُطرح** من سقف الأب. تسليمُ التسليمِ للمحرك يُسقط هذا الحساب. **الصحيح:** `handoffs` الخاصة بالمحرك **تُترجَم إلى** `planDelegation`، ولا تحلّ محله |
| **Agent Loop** | **SDK أو Native** | 🟡 **مقبول بشرط §2 فقط** (قلب الاتجاه). بلا هذا الشرط يصير مسار تنفيذ ثانٍ |

---

## 4 · ما هو موجود فعلًا ويُعاد استخدامه (لا يُبنى جديد)

| قدرة يسمّيها المقترح | الموجود في المستودع | المسار |
|---|---|---|
| عقد مخطّط مُتحقَّق منه | `PROVIDER_PLAN_SCHEMA` (مُجمَّد عميقًا) · `validateProviderPlan(plan, {allowedTools})` · `createProviderPlanner` | `src/agent/planner-provider.js` |
| تحويل محكوم عند فشل مزوّد | `createGovernedFallbackPlanner` · `PLANNER_FALLBACK_CODES` | `src/agent/planner-fallback.js` |
| توجيه النماذج بالطبقة والتكلفة | `MODEL_TIERS{fast,planner}` · `ROUTE_REASONS` · `DEFAULT_PER_CALL_CAPS` · `computeCostMicros` · `createModelRouter` | `src/agent/model-router.js` |
| مزوّد ثانٍ فعلي | `gemini-planner-provider.js` (خلف علم) + مخطط `demo` حتمي افتراضيًا | `src/agent/` |
| Tool Gateway | سجل الأدوات + `validateToolInput` (حظر المفاتيح السرية والحقول غير المعلنة) + `plannerToolAllowlist` («مستقل عن عقد المزوّد») | `tools.js` · `runtime.js` |
| Human Review / Resume | `RUN_STATUS.waitingApproval` · `requestApproval` · `findResumableRuns` · `startToolRun` يعيد استخدام النتيجة السابقة («لا تنفيذ ثانٍ») | `runtime.js` · `store.js` |
| Sessions / سياق | `contextFor` + `listMemory({summaryLimit:1, factLimit:20})` | `runtime.js` · `memory.js` |
| Tracing | سلسلة تجزئة SHA-256 + `inputHash`/`outputHash` + `sourceIds` + بث SSE | `evidence.js` · `runtime.js` |
| Guardrails | `scanForInjection` (9 قواعد مرجّحة، ثنائية اللغة) + تنقية النص + منحة خروج قصيرة العمر لكل جلب | `issue-triage/injection.js` · `web-tools.js` |
| منع الخروج غير المصرّح | allowlist **يُحسم قبل DNS** · 407 قبل تحليل الهدف · سقف لكل منحة · `maxTunnelsPerGrant` | `egress-proxy.js` |

**النتيجة:** الجدول الزمني للمقترح لا يبدأ من صفر. ما يُبنى جديدًا هو **عقد المحوّل** فقط.

---

## 5 · عوائق صريحة — تُحسم قبل أي تنفيذ، لا خلاله

| # | العائق | الواقع المثبت | ما يتطلبه |
|---|---|---|---|
| 1 | **`NETWORK = DENY`** | `egress=off` · `CELIA_AGENT_CONNECTORS=none` · الوسيط لا يفتح `network.allowlist` في `sandbox-policy.js` (تصريح `egress-proxy.js`: ذلك الانعكاس هو C1-b ويحدث بعد توجيه الـsandbox فعلًا) | إدخال `api.openai.com` عبر `egress-proxy` بمنح لكل تشغيل، **لا** اتصال مباشر |
| 2 | **التسعير المعلن شرط بناء** | `model-router.js`: «أي نموذج خارج الجدول يتطلب تسعيرًا صريحًا **وإلا رفض البناء**»؛ الموجود `DECLARED_GEMINI_PRICING` فقط، وموسوم «إعلان تهيئة بتاريخ 2026-10، **لا قياس**» | إعلان micros/1K لكل نموذج OpenAI معتمد، وإلا يرفض الموجّه |
| 3 | **اعتمادية جديدة** | 5 prod · 2 dev (المؤشر 8 في `npm run measure`)؛ `npm audit --omit=dev --audit-level=moderate` بوابة | `@openai/agents` تصير السادس → تحديث الأساس المشتقّ + إعادة التدقيق |
| 4 | **تعارض مع الهدف المعلن** | هدف المالك «عدم الاعتماد على خدمات مدفوعة»؛ واستدلال OpenAI مدفوع | قرار مالك صريح بالتكلفة، أو قصر المحرك على مزودين محليين |
| 5 | **توافق Ollama/DeepSeek غير مُختبَر** | المقترح نفسه يحذّر: «لا تفترض أن جميع خصائصه تعمل بالتساوي مع جميع النماذج» | اختبار توافق مسبق قبل الاعتماد، لا بعده |
| 6 | **TypeScript مقابل Python** | المستودع Node ≥22 / ESM / Express؛ وPython موجود في CI | ‏TS SDK هو المتسق مع المعمارية؛ Python يستدعي عملية ثانية عبر حدود |

---

## 6 · اختبارات القبول التسعة — مقابل ما هو مفروض اليوم

| الاختبار المقترح | الحالة اليوم | الدليل |
|---|---|---|
| تشغيل مهمة قراءة بسيطة | 🟢 مفروض | `call_many` قراءة-فقط حصرًا (`risk !== read` → رفض الدفعة) |
| رفض أداة غير مصرّح بها | 🟢 مفروض | `unknown_tool` · `planner_tool_not_allowed` · `call_many_requires_read_tools` |
| إيقاف المهمة عند الموافقة | 🟢 مفروض | `!tools.executable()` ← `waitingApproval` |
| استئناف التشغيل نفسه بعد الموافقة | 🟢 مفروض | `findResumableRuns` · `startToolRun` idempotency · «لا تنفيذ ثانٍ» |
| اكتشاف فشل الأداة وعدم إعلان النجاح | 🟢 مفروض | `settledFailure` → `failed` مقابل `unknown`؛ والمدقّق يحجب التسليم فوق فشل غير مستدرَك |
| منع Prompt Injection من تجاوز السياسة | 🟡 جزئي | مفروض على الويب (`scanForInjection` + تنقية)؛ **فجوة على البريد** — بند ② المفتوح |
| الحفاظ على Trace ID أثناء التسليم | 🟢 مفروض | `parentDigest` + سلسلة الأدلة + `agent_delegations` |
| منع اتصالات خارجية دون تصريح | 🟢 مفروض | allowlist قبل DNS · 407 قبل الهدف · منحة لكل جلب تُسحب في `finally` |
| التشغيل مع أكثر من مزوّد | 🟡 جزئي | مزوّدان (demo حتمي + Gemini خلف علم)؛ **لا محرك بديل للحلقة بعد** |

**سبعة من تسعة مفروضة اليوم.** فالعمل الجديد ليس بناء خصائص الأمان — بل إثبات أنها **تبقى** مفروضة عندما تقترح الحلقةَ جهةٌ أخرى. وهذا هو معيار القبول الحقيقي للمحوّل.

---

## 7 · التقسيم المقترح — مُعاد التثبيت على ما هو موجود

| المرحلة | التنفيذ | اختبار القبول |
|---|---|---|
| **P0** | عقد المحوّل كدالة نقية فوق الأنواع القائمة (`plan(context)` ← قرار مُتحقَّق منه بـ`PROVIDER_PLAN_SCHEMA`) | محركان خلف واجهة واحدة، **بلا منفّذ حقيقي لدى أي منهما** |
| **P0** | الاختبار السالب §2 | أداة `external_effect` من محرك بديل → نية واحدة + `waitingApproval` + صفر تنفيذ |
| **P0** | الترجمة إلى `planDelegation` لا استبداله | سقف الابن ≤ الأب، والعمق ≤ 2، والرفض مسمّى (`REFUSAL.*`) |
| **P0** | الموافقة/الاستئناف عبر المسار القائم | استئناف **نفس** `runId` بعد الموافقة بلا نية مكررة |
| **P1** | ربط آثار المحرك بـ`trace_id` التشغيل | كل حدث محرك يُسجَّل في سلسلة الأدلة بـ`sourceIds` |
| **P1** | إعلان تسعير المزوّد الجديد | `computeCostMicros` يحسب، وسقف الميزانية يحجب |
| **P1** | اختبار التوافق (Ollama/DeepSeek) | تقرير قابل لإعادة التشغيل، لا انطباع |
| **P2** | تسليم المتخصصين | عبر `delegation.js` فقط |
| **P2** | تقييم المحركات | على نفس مجموعة التقييم، بعدادات لا بحجج |

---

## 8 · ما لا يفعله هذا المستند

- لا يحجز `DEC` — الاعتماد قرار مالك.
- لا يضيف اعتمادية ولا علم بيئة ولا إدخال `.env.example`.
- لا يغيّر `NETWORK = DENY` ولا `isolatedContainerAvailable`.
- لا يرفع مؤشر اكتمال (B1/B2/F4/F5).
- لا يعتبر أي سطر فيه منفَّذًا: **كل ما في §7 🔵 مقترح.**

## 9 · الخطوة التالية

قرار مالك بأحد ثلاثة: **(أ)** اعتماد العقد (§2 + §7/P0) وحجز `DEC` · **(ب)** رفض نقل
الفصل إلى الحلقة والاكتفاء بالفصل القائم عند المخطط (وهو يكفي لتبديل المزوّد دون
تبديل المحرك) · **(ج)** تأجيل حتى إغلاق البندين المفتوحين ② و③ وP1 وP2 من
`ASSUR-005`.

**توصية مبنية على التدقيق:** ‏**(ب) ثم (أ)**. الفصل القائم عند المخطط يمنح بالفعل
«تغيير النموذج دون فقدان الذاكرة أو السياسات أو السجلات» — وهو الفرق الذي يسمّيه
المقترح شخصية CeliaOS. ونقل الفصل إلى الحلقة adds سطحًا جديدًا قبل إغلاق فجوتين
مثبتتين في السطح الحالي.
