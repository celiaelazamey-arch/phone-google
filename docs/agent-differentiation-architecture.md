# «معمارية التميّز التنافسي» (§ DIFF) — 12 فكرة مقابل المستودع الفعل

**الحالة:** 🔵 **مقترح / غير معتمد** · **المهمة:** `DIFF-001` · **التاريخ:** 3 نوفمبر 2026
**الفرع:** `arena/342e1174-phone-google` · **الأساس المرجعي:** تدقيق `SI-0` ([`agent-self-intelligence-audit.md`](agent-self-intelligence-audit.md) · `DOC-004`)

**السؤال:** الهوية المقترحة «*The Intelligent System That Knows, Controls, and Evolves Itself*» واثنتا عشرة
ميزة تميّز — كم منها قائم فعلًا في المستودع، وكم مقترح، وكم **يجب ألّا يُبنى** لأنه موجود بشكل آخر؟

**الطريقة:** لا ادعاء بلا مسار. كل حكم أدناه مبني على ملف مقروء أو **قياس أُجري في هذه الجلسة**
(المسابير الثلاثة في §8 من تدقيق `SI-0`، وأوامر `arch:impact` و`measure` و`agents:doctor`). ما لم
يُقَس مُعلَن كغير مقاس.

---

## 1. الحكم المجمل

**21 بندًا:** **9 ✅ قائم ومقيس** · **9 🟡 جزئي** · **2 ❌ غير منفّذ** · **1 🔵 قرار هوية للمالك**.

**النتيجة المركزية:** **الميزة التي اختيرت كأقوى ابتكار — «Consequence Engine» — منفَّذة فعلًا ومقيسة اليوم.**
`npm run arch:impact src/agent/harness.js` أعاد في هذه الجلسة:

```
Changed files: 1
Components: Agent Runtime · Kernel
Modules reached: 8
```

و`impactOf()` يعيد `{files, components:["kernel"], modules, unmapped:[]}` — أي **تقرير أثر قبل التنفيذ**،
مشتقًّا من المصدر، ومحروسًا ببوابة `arch:map:check`. فما ينقص ليس المحرك بل **عرضه على من يتخذ القرار**
(الوكيل أو المالك) بدل بقائه أمر CLI. وهذا هو نفسه استنتاج `SI-0`: **الفجوة وصلة لا قدرة.**

**ثاني نتيجة:** «Autonomy Manager» بمستوياته L0–L4 **قائم بمفردة أخرى**. المستودع يصنّف كل أداة بـ`RISK`
من أربعة مستويات ويشتقّ `requiresApproval` منها، و**افتراضياته اليوم هي L0/L1 حرفيًا**:
`CELIA_AGENT_RUNTIME` ← `'off'` (`src/agent/index.js:190`) · `CELIA_AGENT_CONNECTORS` ← `'none'` (`:232`) ·
`CELIA_AGENT_SANDBOX=off` · `egress=off`. وL4 («محدود مسبق التفويض») هو بالضبط مجموعة
`EXECUTABLE={read,internal_write}`: **9 من 14 أداة** تعمل بلا موافقة لأنها لا تُحدث أثرًا خارجيًا.

---

## 2 · الأفكار الاثنتا عشرة

| # | الميزة | الحكم | الدليل والمسار |
|---|---|---|---|
| 01 | **Digital Twin** — نسخة حية تعرف حالة كل مكوّن وتحاكي أثر التعديل | 🟡 | **التوأم المشتقّ قائم وحتمي:** `buildArchitectureMap()` → `{components:16, edges, stats}` و`buildAtlas()` → 12 نطاقًا وبصمة `20e19d8fa5…` و`verifyFacts`=`[]`. **مقيس:** `atlas:facts` أعاد كتابة `docs/design/system-atlas-facts.json` بصفر فرق git. والحالة الحيّة في `runtime.status()` (مسبار 1). **الناقص:** محاكاة الموارد والزمن، و`STALE`/`DEGRADED` كأبعاد رصد |
| 02 | **Consequence Engine** — Impact Report قبل التنفيذ | ✅ | `impactOf()` + `npm run arch:impact` (مقيس أعلاه: 8 وحدات) · `arch:map:check` بوابة · `unmapped:[]` يعلن ما لم يُرسَم بدل ادعاء اكتمال النطاق (§15.11 «`IMPACT_ANALYSIS_PARTIAL`» منفَّذ بالمعنى) (`src/design/architecture-map.js:276`) |
| 03 | **Trust Identity** — هوية وصلاحيات مستقلة، بلا منح ذاتي | 🟡 | **موجود:** 67 صلاحية مسجّلة (`GRANT_IDS` · `src/agent/access-policy.js`) · `RISK` بأربعة مستويات · `FORBIDDEN_SECRET_KEYS` · منحة خروج لكل تشغيل (`src/agent/egress-proxy.js`). **«لا يمنح نفسه صلاحية» مُثبت:** تفويض بلا توسيع — `MAX_DEPTH=2` · `MAX_FANOUT=4` · أدوات الطفل ⊆ الأب · ميزانيته تُطرح من سقفه · `parentDigest` (`src/agent/delegation.js`). **الناقص:** هوية وكيل *مؤقتة ومحدودة النطاق* ككائن من الدرجة الأولى |
| 04 | **Time Machine** — Recovery Point وتراجع | 🟡 | **استعادة حالة المهمة منفَّذة ومتحققة:** `recoverStale` يعلّم `unknown` ولا يعيد الإرسال أبدًا · `findResumableRuns` · `reconcileToolRun` · `findToolRunByKey` · `getOutboxByKey` · `findStaleOutbox` · سلسلة أدلة `sha256-hash-chain-v1` بـ`verifyEvidenceChain` (أساس `recovery_idempotency` = 6 في مسبار 1). **الناقص:** لا Recovery Point للملفات/الإعداد — هذا git، و`validatePlanEditPolicy` يرفض تبديل الأداة (409) وأي `irreversible` (403) |
| 05 | **Knowledge Graph** — ربط المهام والمشكلات والمكونات والقرارات | 🟡 | `kb.search` · `kb.tool_profile` · `kb.project_context` (`src/agent/tools.js`) · `memory.js` (`MEMORY_KIND={summary,fact}`) · `memory:consolidate` · `kb:conflicts` · `agent_delegations` رابطًا لا مسارًا ثانيًا (UX-005). **مقيس:** «فُهرست 81 مادة من 7 مصدرًا، والبحث العربي أعاد 3 نتيجة بأدلة». **الناقص:** **Failure Memory** (حكم ❌ في `DOC-003`)، فلا ربط مشكلة→حل سابق |
| 06a | **Agent Ecosystem — MCP** | 🟡 | `MCP_TOOLS` (`src/celia-mcp.js:182`) و`EXTENDED_MCP_TOOLS` (`:340`) = 12 أداة معلنة، و`celia:mcp:verify` فحص ذاتي. **لكن الاتجاه معكوس** (حكم `DOC-003`): Celia **تخدم** أدوات عبر MCP، والعنكبوت يخدم Claude Desktop — فالمقترح يحتاج عكس الاتجاه لا إضافة مكتبة |
| 06b | **Agent Ecosystem — A2A** | ❌ | **غير منفّذ، وتحقّق سلبي صريح:** البحث عن `a2a`/`agent-to-agent` في `src/ docs/ workers/ scripts/` أعاد إصابة واحدة هي **اللون `#2a2a2a`** في `workers/celia-edge/whatsapp-ui.generated.js` — إيجابية كاذبة. فلا وجود للبروتوكول |
| 07 | **Self-Challenge** — البحث عن ضعف الخطة قبل التنفيذ | 🟡 | `validateProviderPlan(plan,{allowedTools})` يرفض `unknown_tool` و`planner_tool_not_allowed` و`call_many_requires_read_tools` (`src/agent/planner-provider.js`) · `PLANNER_FALLBACK_CODES` + `createGovernedFallbackPlanner` (`planner-fallback.js`) · `replanner.js` مراجعة واحدة محكومة. **الناقص:** تحدٍّ خصومي *مقصود* للخطة؛ الموجود تحقّق من الصحة لا بحث عن الضعف |
| 08 | **Uncertainty Engine** — ما يعرفه وما لا يعرفه ومتى يتوقف | ✅ | **أقوى ما في المستودع.** `verifier.js` ثلاثية PASS/BLOCK/UNKNOWN ≡ VERIFIED/FAILED/INCONCLUSIVE وتجميع يجعل «صفر فحوص = PASS» مستحيلًا · `notRuntimeVerifiable` و`regressionSuiteVerified:false` (`DEC-117`) · `measure` يطبع «غير مقاس بهذا الأمر» · `CONFLICTED` مُمارَس: «تعارض يبقى معلنًا بلا حسم … `unresolved` بلا اختيار» |
| 09 | **Decision Intelligence** — لماذا اتُّخذ القرار وما نتج عنه | 🟡 | `docs/continuity/DECISIONS.md` (117 إدخالًا) · `ROUTE_REASONS` في `model-router.js` يسبّب كل توجيه · سلسلة الأدلة بـ`trace_id` · سجلات الجلسات. **الناقص:** قرار ككائن قابل للاستعلام يربط السبب بالنتيجة المقاسة (اليوم بشري الشكل) |
| 10 | **Resource Intelligence** — اختيار النموذج وفق الجودة والكلفة والسرعة | 🟡 | `MODEL_TIERS{fast,planner}` · `defaultRoute` · `computeCostMicros` · `DEFAULT_PER_CALL_CAPS` · `DECLARED_GEMINI_PRICING` (`src/agent/model-router.js`) · ميزانية `DEFAULT_LIMITS={maxSteps:12, maxCostMicros:100_000, maxDurationMs:120_000, leaseMs:30_000, toolTimeoutMs:10_000}`. **جزئي بإعلانه:** «المخطط الفعّال حاليًا حتمي (`demo-deterministic`) حتى اعتماد `AI-002`»، و`CELIA_AI_ALLOW_CLOUD_FAILOVER=false`، والتسعير **شرط بناء**: «أي نموذج خارج الجدول يتطلب تسعيرًا صريحًا وإلا رفض البناء» |
| 11 | **Workflow Genome** — تحويل العمليات الناجحة إلى Workflows | 🟡 | `CELIA_SEVEN_STAGE_LOOP` و`computeAgentMetrics` (`src/agent/evaluation.js`) · `PLAN_LIFECYCLE_STATE` · `HARNESS_LIFECYCLE_STAGES` (10) · **4 مهارات** في `.agents/skills/` (`continuity-handoff` · `governed-pr-merge` · `quality-gates` · `session-orient`) · `npm run skill:draft` → `scripts/derive-skill-draft.mjs` **يشتقّ مسودة مهارة من سجلات حقيقية**. **الناقص:** الاشتقاق محفّز بشريًا، ولا ترقية تلقائية بعد تكرار النجاح |
| 12 | **Autonomy Manager** — مستوى استقلالية لكل مهمة حسب مخاطرها | ✅ | منفَّذ بمفردة `RISK` لا `L0–L4`: `read`/`internal_write`/`external_effect`/`irreversible` مع `EXECUTABLE={read,internal_write}` و`requiresApproval` مشتقّة. **مقيس (مسبار 2):** 8 `read` · 4 `external_effect` (موافقة) · 1 `internal_write` · 1 `irreversible` (موافقة). **والافتراضي اليوم L0/L1:** runtime `off` · connectors `none` · sandbox `off` · egress `off`. وتحذير §5 من L4 منفَّذ: `sandbox.exec` = `irreversible` + موافقة + مطفأ |

---

## 3 · مقاييس النجاح السبعة (§8) — هل لها أداة قياس اليوم؟

| المؤشر | الحكم | أداة القياس القائمة |
|---|---|---|
| System Understanding Accuracy | ✅ | `verifyFacts(facts)` = `[]` (مقيس) + بوابة `atlas:check` + بصمة `fingerprintOf` |
| Change Impact Accuracy | ✅ | `impactOf()` → `unmapped:[]` + بوابة `arch:map:check` (مقيس: 8 وحدات) |
| Recovery Success | ✅ | `recovery_idempotency` أساس=6 في مسبار 1 + `recoverStale`/`reconcileToolRun` + `test/agent-harness-inspection.test.js` |
| Capability Truthfulness | ✅ | `capabilityStatus()` يفصل `present`/`tested`/`missing` + `DEC-117` (كل `wired` مشتقّ) + `agents:doctor` لكل وكيل على حدة |
| Decision Quality | ✅ | `npm run measure` (12 مؤشرًا) + `eval:ai`/`eval:templates`/`eval:web` + أرضيات التغطية 89/71/82 |
| Human Control Compliance | ✅ | `policy_approval_gate` أساس=8 (مسبار 1) + «الأداة معلنة **بلا منفّذ** (`execute=null`) والتشغيل توقف عند `waiting_approval`» + `access:policy:check` |
| Cross-Runtime Portability | ❌ | **لا أداة قياس** — ومحجوب بـ`MULTI-001` (محرك بديل غير معتمد). لا يُقاس ما لا يوجد محركاه بعد |

**6 من 7 لها أداة قياس فعلًا.** وهذا يطبّق §6 من الخطة: «ابدأ بقياس خط أساس حقيقي قبل وضع أهداف رقمية» —
الخط الأساس موجود، فلا حاجة لاختراع مؤشرات.

---

## 4 · ما يجب ألّا يُبنى

بوابة `SI-0` («لا إنشاء مخازن أو أدوات مكررة») تسري على هذا الفصل حرفيًا:

1. **لا محرك أثر جديد.** `impactOf` + `arch:impact` + `arch:map:check` هي الـConsequence Engine. المطلوب
   **وصلة** (أداة `risk:read` أو مسار HTTP)، وهو بند `SI-2/E4` نفسه — لا مكوّن ثانٍ.
2. **لا مفردة استقلالية ثانية.** `L0–L4` و`RISK` بمستوياته الأربعة يصفان المحور نفسه. إضافة `L*` بجانب
   `RISK` تنشئ مرجع حالة ثانيًا، وهو ما تمنعه `AGENTS.md` («لا تصبح مرجع حالة ثانيًا») ومبدأ §15.19 رقم 9.
   الصحيح: **خريطة معلنة** `L0–L4 → RISK + أعلام البيئة` تُشتقّ ولا تُخزَّن.
3. **لا توأم رقمي كمخزن.** `system-atlas-facts.json` مُتتبَّع في git وحتمي (صفر فرق عند إعادة التوليد).
   تحويله إلى مخزن قابل للكتابة يكسر §15.19 رقم 1.
4. **لا Recovery Point موازٍ لـgit.** استعادة حالة المهمة منفَّذة في المخزن الدائم؛ واستعادة الملفات
   مسؤولية git. كائن ثالث يجمع الاثنين = مصدر حقيقة موازٍ.
5. **لا A2A قبل عكس اتجاه MCP.** `DOC-003` أثبت أن اتجاه MCP الحالي معكوس؛ إضافة بروتوكول ثانٍ فوق
   اتجاه غير مستقرّ يبني على فراغ.
6. **لا تغيير في بيانات الهوية أو الإصدار.** `AGENTS.md`: «لا تغيّر بيانات الإصدار قبل وجود التنفيذ».
   فالهوية المقترحة (§5) تمسّ `system.manifest.json` و`src/version.js` والأطلس والملصق — **ولا يُلمس منها
   شيء الآن**.

---

## 5 · قرار الهوية — 🔵 للمالك وحده

الاسم المقترح «**CELIA OS — SELF-UNDERSTANDING INTELLIGENCE PLATFORM**» بشعار
«*Intelligence with Proof. Autonomy with Control.*» ومحاور KNOW · PREDICT · CONTROL · EVOLVE.

**حكم التدقيق:** الشعار **صادق جزئيًا اليوم وقابل للإثبات** — فـ`KNOW` (فهرس ورسم مشتقّان) و`PREDICT`
(تقرير أثر مقيس) و`CONTROL` (بوابة موافقة بأساس 8 وتفويض بلا توسيع) كلها مُثبتة بمسابير هذه الجلسة.
أما `EVOLVE` فـ**غير مُثبت**: لا حلقة تعلّم من النتائج (حكم ❌ في `DOC-003`)، ولا Failure Memory، ولا
Experience Intelligence (§4 من المقترح).

**لذلك:** اعتماد الاسم **قرار مالك** لا نتيجة تدقيق، وهو يغيّر هوية المنتج وبيانات الإصدار — فلا يُنفَّذ
ضمن `DIFF-001`. إن اعتُمد، يلزمه `DEC` مستقلّ وتغيير في `AGENTS.md` و`system.manifest.json` والملصقات،
**بعد** وجود `EVOLVE` أو بتصريح صريح بأن المحور الرابع مقترح.

---

## 6 · التوصية

**لا تُنفَّذ الأفكار الاثنتا عشرة، ولا حتى الخمس «P0» منها.** الدليل يقول إن أربعًا من الخمس موجودة
كليًا أو جزئيًا (01 🟡 · 02 ✅ · 03 🟡 · 04 🟡 · 12 ✅)، وأن الفجوة المشتركة بينها واحدة:
**المشتقّات المحكومة موجودة لكنها غير متاحة للوكيل ولا للمالك كسطح قرار.**

فالترتيب المفروض بالدليل، وهو نفسه ترتيب `SI-0`:

1. **`SI-2/E4`** — أدوات `risk:read` تلفّ `buildArchitectureMap`/`factsOf`/`impactOf`. هذا **يُسلّم
   01 و02 و03 و12 دفعة واحدة** بوصلة واحدة، بلا مكوّن جديد.
2. **البند ② المعلّق** (`scanForInjection` في `gmail.js#sanitizeMessage`) — فجوة أمنية **مثبتة**، وأولى
   من أي توسيع، تطبيقًا لـ§15.13: إغلاق فجوات السطح الحالي قبل توسيعه.
3. **Failure Memory** (05) — الفجوة الحقيقية الوحيدة التي تُكسب `EVOLVE` معناها، وهي ❌ منذ `DOC-003`.
4. **عكس اتجاه MCP** ثم A2A (06) — قرار معماري مستقل.
5. **الهوية (§5)** — `DEC` مستقل بعد 1–3.

**قاعدة الإفصاح:** يبقى هذا الفصل 🔵 مقترحًا. **لا يُحوَّل أي بند فيه إلى EXISTS أو IMPLEMENTED بناءً على
هذا المستند وحده** — تطبيقًا لـ§15.18، ولقاعدة الخطة الختامية: «لا تضف مكوّنًا لأن اسمه موجود في
المعمارية. أضفه فقط عندما يثبت التدقيق وجود فجوة حقيقية».
