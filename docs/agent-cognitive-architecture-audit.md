# تدقيق ادعاءات الإنفوجرافيك — «CeliaOS · Cognitive Architecture 2026»

**التاريخ:** 31 أكتوبر 2026 · **المهمة:** `DOC-003` · **الفرع:** `arena/9dceca86-phone-google`
**السؤال:** كل معلومة في الإنفوجرافيك (الوظائف السبع، سلسلة Harness التسع، Browser/Playwright/MCP، بوابات الأمان، `NETWORK = DENY`، أحجام اللغات) — هل يقف خلفها كود أو اختبار، أم هي تصوّر؟

**الطريقة:** قراءة الملفات + **مسبار تشغيل حقيقي**: بُني host فعلي (`runtime.harness()`) على مخزن SQLite مؤقت ومخطط `demo` وموصلات تقويم وهمية، ثم طُبع الحزام كما يصف نفسه. الأرقام أدناه مقيسة لا مستنتجة.

---

## 1. الحكم المجمل

**36 ادعاءً:** **18 ✅ مثبت** · **9 🟡 جزئي أو مشروط** · **9 ❌ غير مثبت أو مخالف للكود.**

| الحكم | العدد |
|---|---|
| ✅ مثبت في الكود أو اختبار | 18 |
| 🟡 جزئي / بشرط / بافتراض تشغيل غير مفعّل | 9 |
| ❌ غير مثبت أو مخالف للكود | 9 |

التفصيل في الجدول أدناه؛ كل صف يحمل مساره. **أخطر ثلاث معلومات:**

1. **«سلسلة من تسع مراحل» غير صحيحة:** الحزام يعلن **10 مراحل** و**10 مكونات**، و`Policy` و`Approval` مرحلتان لا واحدة.
2. **«Browser / Playwright / MCP» ليست مصدر الإدراك الحالي:** Playwright موجود في `devDependencies` للاختبارات فقط، و`MCP` في هذا المستودع اتجاهه **عكسي** (Celia تخدم أدوات عبر MCP، والعنكبوت يخدم Claude Desktop)، ولا أداة متصفح في سجل الأدوات أصلًا.
3. **«التعلم: يطور نفسه مع الوقت» غير منفّذ:** لا حلقة تعلّم من النتائج؛ تحديث المعرفة يجري بسكربتات المالك (`scripts/kb.mjs`, `kb-seed.mjs`) وبمزامنة العنكبوت، وليس بقرار من الوكيل.

---

## 2. الوظائف الإدراكية السبع

| # | الادعاء | الحكم | الدليل |
|---|---|---|---|
| 1 | **إدراك/معلومات:** يعرف ما عنده وما يحتاجه | 🟡 | المعرفة تأتي من فهرس محلي: `kb.search` / `kb.tool_profile` / `kb.project_context` (`src/agent/tools.js:221,266,280`) وسياسة سياق (`src/context-policy.js`). لا إدراك للويب افتراضيًا: الموصلات `CELIA_AGENT_CONNECTORS=none` (`src/agent/index.js:222`)، وأداة البحث `web.search` **غير موجودة** (`docs/agent-egress.md:52`). |
| 2 | **ذاكرة:** يتذكر ما تعلّمه | ✅ | ذاكرة حتمية لملخصات ووقائع التشغيلات المنتهية، بلا ساعة ولا عشوائية ولا فهرس متجهات (`src/agent/memory.js:4-12`)، مع مخزن دائم `sqlite/mysql` (`src/agent/store.js`). **ليست** تعلّمًا: تخزين ما جرى، لا تغيير سلوك لاحق. |
| 3 | **تفكير:** يحلل ويقارن | ✅ | `src/agent/planner.js` + `planner-provider.js` + `replanner.js` (مراجعة واحدة محكومة) + `goal-contract.js`. المخطط الافتراضي `demo` **حتمي**، ومخطط Gemini خلف علم (`src/agent/index.js:510`). |
| 4 | **قرار:** يختار ما يناسب الموقف | ✅ | بوابة سياسة/موافقة: الموافقة مربوطة ببصمة الحمولة SHA-256، وثلاثة قرارات `approved/edited/rejected` (`src/agent/harness.js:284-420`, `test/agent-approvals.test.js`). |
| 5 | **تنفيذ:** يفعل ويحدث | 🟡 | سجل أدوات بعقود ومدخلات متحققة (`src/agent/tools.js`). لكن تنفيذ الشيفرة `sandbox.exec` **مطفأ افتراضيًا** (`CELIA_AGENT_SANDBOX=off`, `src/agent/index.js:572`) والعزل غير متاح (أدناه). |
| 6 | **تعلم:** يطور نفسه مع الوقت | ❌ | لا حلقة تعلّم من النتائج ولا تعديل ذاتي للسلوك. التقييم (`src/agent/evaluation.js`, `ai-eval.js`) يقيس، ولا يغيّر السياسة. تحديث المعرفة يدوي عبر `scripts/kb.mjs` / `kb-seed.mjs` أو مزامنة العنكبوت. |
| 7 | **تفاعل:** يتواصل مع المستخدم أو البيئة | 🟡 | واجهة الويب وموصلات Google/WhatsApp موجودة، لكن WhatsApp يحتاج تهيئة Meta وهو **غير مهيأ في الإنتاج** (`configured=false`, `DEC-073`)، وGoogle خلف `CELIA_AGENT_CONNECTORS` (افتراضي `none`). |

---

## 3. «Agent Harness — تسع مراحل»

مسبار التشغيل الحقيقي أعاد حرفيًا:

```
stages: 10 ["Goal","Plan","Select Tool","Policy Check","Approval",
            "Sandbox Execute","Observe","Independently Verify",
            "Persist Evidence","Update State"]
agent_runtime  model_router  tool_registry  context_memory  policy_approval_gate
sandbox_executor (wired=true, isolatedContainerAvailable=false)
independent_verifier  evidence_observability  recovery_idempotency  evaluation_regression
```

| # | الادعاء في الإنفوجرافيك | الحكم | الدليل / التصحيح |
|---|---|---|---|
| 8 | «سلسلة من 9 مراحل» | ❌ | **10 مراحل** في `HARNESS_LIFECYCLE_STAGES` (`src/agent/harness.js:20-31`)، ومصدرها الحزام نفسه لا الشكل. المفقود من الصورة: `Observe`, `Persist Evidence`, `Update State`. |
| 9 | «Policy & Approval» مرحلة واحدة | ❌ | مرحلتان: `Policy Check` ثم `Approval` (`harness.js:23-24`)؛ الدمجهما يُخفي أن الفحص السياسي يسبق طلب الموافقة ويستقل عنها. |
| 10 | «Memory (الذاكرة)» مرحلة في السلسلة | 🟡 | الذاكرة **مكوّن** (`context_memory`)، وما يقابلها في السلسلة مرحلة `Update State` (`harness.js:29,36`). |
| 11 | «Sandbox (بيئة التنفيذ الآمنة)» مكوّن عامل | 🟡 | `sandbox_executor` يعلن نفسه `wired=true` و**`isolatedContainerAvailable=false`** (`src/agent/harness.js:398-406`)، والوثيقة تقول: «Backend محلي منفذ ومختبر… **غير موصول بـ`sandbox.exec` ولا مفعّل في مسار الوكيل أو الإنتاج**» (`docs/agent-sandbox.md:3`). |
| 12 | Goal / Planner | ✅ | `src/agent/goal-contract.js`, `src/agent/planner.js`. |
| 13 | Model Router | ✅ | `src/agent/model-router.js` (طبقتان fast/planner، توجيه حتمي مسجّل)، مفعّل عبر `CELIA_AGENT_PLANNER=gemini-router`. **ملاحظة:** خريطة `docs/celiaos-architecture-map.html` ما زالت تصنّفه «مقترحًا» — الخريطة أقدم من الكود. |
| 14 | Tool Selector | ✅ | `src/agent/tools.js` (سجل + `validateToolInput` + تصنيف مخاطر). |
| 15 | Verifier (التحقق) | ✅ | مُتحقِّق مستقل بلا صلاحية كتابة، ثلاثة أحكام `PASS/BLOCK/UNKNOWN` (`src/agent/verifier.js:16-33`). |
| 16 | Evidence (الأدلة) | ✅ | سلسلة SHA-256 قابلة للتحقق (`src/agent/evidence.js`, `test/agent-evidence.test.js`). |

---

## 4. «مصدر إدراك وتحديث خارجي: Browser / Playwright / MCP»

| # | الادعاء | الحكم | الدليل |
|---|---|---|---|
| 17 | **Browser** | ❌ | لا أداة متصفح في سجل الأدوات (`src/agent/tools.js`)، ولا حزمة متصفح في التبعيات غير أداة الاختبار. |
| 18 | **Playwright** | ❌ | `@playwright/test` و`@axe-core/playwright` في `devDependencies` فقط (`package.json:72-73`) لاختبارات الواجهة؛ ليست قدرة وكيل. |
| 19 | **MCP كمصدر إدراك** | ❌ | الاتجاه معكوس: Celia **تخدم** أدواتها عبر MCP (`src/celia-mcp.js` + `src/mcp-contract.js`)، والعنكبوت يخدم `Claude Desktop` و`Claude Code` عبر stdio (`celia-google-spider/README.md`). الوكيل لا يتصل بأي عميل MCP خارجي (لا `@modelcontextprotocol/sdk` في التبعيات). |
| 20 | «البحث في الويب ✔» | ❌ | `web.search` **مؤجّلة بقرار مالك** (C2-b): `docs/agent-egress.md:3,52`. الوكيل لا يبحث. |
| 21 | «قراءة الصفحات ✔» | 🟡 | موجودة كـ`web.fetch` فقط، **خلف علم** `CELIA_AGENT_EGRESS` وبقائمة سماح per-run ومنحة قصيرة لكل جلب وفحص حقن (`src/agent/web-tools.js:20-22`). لا جلب مفتوح. |
| 22 | «استخراج المعلومات ✔» | 🟡 | الاستخراج **مقتطفات منسوبة** لا تلخيص دلالي بنموذج (`docs/agent-egress.md:161`). |
| 23 | «تحديث المعرفة ✔» | ❌ | التحديث بسكربتات المالك أو مزامنة العنكبوت؛ العنكبوت نفسه **بلا embeddings وبلا بحث دلالي** (`celia-google-spider/README.md`)، والوكيل يقرأ فهرسه SQLite للقراءة فقط (`src/agent/spider-reader.js:5-13`). |

---

## 5. «بوابات الأمان والحوكمة»

| # | الادعاء | الحكم | الدليل |
|---|---|---|---|
| 24 | `NETWORK = DENY` | ✅ | سياسة العزل ترفض أي وضع غير `deny` وأي سماح غير فارغ: `sandbox_network_must_default_deny` (`src/agent/sandbox-policy.js:11,75-77`). |
| 25 | مراقبة ومراجعة السجلات | ✅ | سلسلة أدلة SHA-256 + أحداث تشغيل + `verifyChain` (`src/agent/evidence.js`). |
| 26 | موافقة بشرية قبل الإجراءات الحساسة | ✅ | لا تنفيذ لأداة `external_effect`/`irreversible` قبل موافقة مالك مسجّلة (`src/agent/harness.js:390-396`, `test/agent-approvals.test.js`). |
| 27 | «عزل وتنفيذ آمن (Sandbox)» | 🟡 | العزل مبني ومختبر على Linux (`test:sandbox` 17/17) لكنه **غير موصول وغير مفعّل** في مسار الوكيل/الإنتاج (`docs/agent-sandbox.md:3`)، والأدوات غير القابلة للتراجع مرفوضة صراحةً حتى توفير عزل حاويات. |
| 28 | سياسات وصول دقيقة | ✅ | تصنيف مخاطر لكل أداة + بوابات صلاحية + رفض افتراضي (`src/agent/tools.js`, `src/policy.js`). |

---

## 6. «الحالة الحالية والمستقبلية» و«ملاحظات مهمة»

| # | الادعاء | الحكم | الدليل |
|---|---|---|---|
| 29 | «الموجود الآن: التخطيط، التنفيذ، الذاكرة» | 🟡 | موجودة بالكود والاختبارات، لكن **الوكيل مطفأ افتراضيًا**: `CELIA_AGENT_RUNTIME` يقبل `off|mysql|sqlite` والافتراضي `off` (`src/agent/index.js:177-184`)، ولا ملف في المستودع يفعّله. «ممكن» لا «عامل في الإنتاج». |
| 30 | «مقترح للتطوير: بحث أعمق، تعلم أكثر، أدوات متقدمة» | ✅ | متسق مع `docs/agent-web-gaps.md` (G3: لا بحث) وخريطة المراحل. |
| 31 | «فجوات غير مثبتة: التعلم الذاتي الكامل، ذكاء عام شامل» | ✅ | لا حلقة تعلّم ولا ادعاء AGI في الكود ولا في الوثائق. |
| 32 | «النظام ليس ذكاءً عامًا كاملًا؛ لا يتعلم ذاتيًا؛ يعتمد على ما يعرفه؛ يعمل محدودًا بلا بحث» | ✅ | الأربعة مطابقة لما يقوله الكود: `memory.js` لا يعدّل السلوك، و`web.search` غائبة، والمعرفة من فهرس مُغذّى يدويًا. |

---

## 7. «بالبرمجة في مستودعك»

| # | الادعاء | الحكم | القياس |
|---|---|---|---|
| 33 | JavaScript هو الجزء الأكبر | ✅ | **64,629** سطرًا من `*.js` + **15,074** من `*.mjs` = 79,703 مقابل **3,431** HTML و**5,511** CSS (`git ls-files | xargs wc -l`). |
| 34 | HTML/CSS تعطي الشكل والواجهة | ✅ | `public/` 13 صفحة + `styles.css`/`theme.css`؛ الورقة واحدة والرموز في `theme.css` (DEC-080). |
| 35 | Python/Shell قد تكون دعمًا أو أدوات | ✅ | Python: **1,052** سطرًا في 11 ملفًا داخل `celia-google-spider/` (خادم MCP للـDrive، قراءة فقط). Shell: **112** سطرًا، ملف واحد `src/agent/sandbox-entry.sh`. «قد تكون» أضعف من الواقع: Python مكوّن فعلي، لكنه **خارج مسار الوكيل**. |
| 36 | «النظام الكامل = … + تعلم» | ❌ | الجزء «تعلم» غير منفّذ (صف 6). النظام كامل في التخطيط/السياسة/الأدلة/التحقق، وناقص في التعلّم والبحث الآلي. |

---

## 8. المراحل العشر — أسماء وترتيب حرفيان

منقولة حرفيًا من `HARNESS_LIFECYCLE_STAGES` في `src/agent/harness.js:20-31`، ولا تُترجم ولا تُعاد تسميتها عند النقل. العربي **ترجمة توضيحية** تحتها، والاسم الرسمي هو الإنجليزي.

| # | الاسم الحرفي (رسمي) | ترجمة توضيحية | ملاحظة النقل |
|---|---|---|---|
| 1 | `Goal` | الهدف | — |
| 2 | `Plan` | الخطة | — |
| 3 | `Select Tool` | اختيار الأداة | — |
| 4 | `Policy Check` | فحص السياسة | **لا تُدمج مع 5** |
| 5 | `Approval` | الموافقة | **لا تُدمج مع 4** |
| 6 | `Sandbox Execute` | التنفيذ المعزول | مبني ومختبر؛ `isolatedContainerAvailable=false` |
| 7 | `Observe` | الرصد | **غائبة من النسخة السابقة** |
| 8 | `Independently Verify` | التحقق المستقل | — |
| 9 | `Persist Evidence` | تثبيت الأدلة | **غائبة من النسخة السابقة** |
| 10 | `Update State` | تحديث الحالة | **غائبة من النسخة السابقة** |

**المكونات العشرة أيضًا حرفية** (`HARNESS_COMPONENT_IDS`): `agent_runtime` · `model_router` · `tool_registry` · `context_memory` · `policy_approval_gate` · `sandbox_executor` · `independent_verifier` · `evidence_observability` · `recovery_idempotency` · `evaluation_regression`.

**النسخة المصححة المنفّذة:** [runtime-verified-architecture.html](design/runtime-verified-architecture.html) مع [لقطة PNG بالحجم الكامل](design/runtime-verified-architecture.png) (2880×4828). المصدر واحد: نفس أسماء هذه الجداول، والحكم على كل بطاقة مأخوذ من §2–§6.

## 9. التصحيحات الستة المطبَّقة في النسخة الجديدة

| # | التصحيح | أين ظهر في [runtime-verified-architecture](design/runtime-verified-architecture.html) |
|---|---|---|
| 1 | فصل `Policy Check` عن `Approval` | بطاقتان مستقلتان بلون تمييز (4 و5) وتنبيه صريح بالدمج السابق |
| 2 | إظهار `Observe` · `Persist Evidence` · `Update State` | ثلاث بطاقات بحدّ سماوي ووسم «أُضيفت» |
| 3 | Playwright ليست قدرة تشغيل كمبيوتر | بطاقة `Playwright` بوسم «للاختبارات» ودليل `devDependencies` |
| 4 | MCP ليس اتصالًا واردًا | بطاقة `MCP` بوسم «اتجاه معكوس» |
| 5 | `web.fetch` مقيّدة و`web.search` مؤجّلة | بطاقة `web.fetch` بوسم «مقيّد» + صف في جدول القيود (C2-b) |
| 6 | لا تعلّم ذاتي: تقييم + مراجعة + معرفة يدوية | بطاقة «تعلم» بوسم «غير مثبت» ودليل التقييم بلا تعديل سياسة |

**وأُضيف فوقها لتوضيح الفرق بين الوجود والتفعيل:** قسم «القيود التشغيلية المقيسة» (`CELIA_AGENT_RUNTIME=off`، `CELIA_AGENT_SANDBOX=off`، `isolatedContainerAvailable=false`، `CELIA_AGENT_CONNECTORS=none`، `CELIA_AGENT_SPIDER=off`، WhatsApp `configured=false`)، وقسم «ما ثبت بالكود والاختبار» للأربعة المؤكدة.

## 10. ما لا يُقاس

- تشبيهات «العينان والأذنان = البحث، العقل = الذاكرة، الإرادة = القرار…» **بلاغية لا هندسية**؛ لا تُقدَّم كحكم على الكود.
- عبارة «إنسان كامل» تصوّر للمنتج لا ادعاء قابل للتحقق؛ الإنفوجرافيك نفسه يضع «الذكاء العام الشامل» في خانة **الفجوات غير المثبتة**، وهذا هو الحكم الصحيح.
