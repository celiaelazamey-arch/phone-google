# تسليم جلسة — 2026-11-03 — سطح التدقيق يشتقّ ولا يؤكّد (DEC-117 / ASSUR-005)

## المهمة والتفويض

- **طلب المستخدم:** إتمام تدقيق `Agent Harness` مقابل «خارطة طريق اعتمادية CeliaOS» (12 محورًا + 7 إصلاحات جوهرية)، ثم تنفيذ الأولويات الثلاث التي أقرّها: ① دقة سطح التدقيق، ② `scanForInjection` على البريد، ③ `approval_required` كبيانات في عقد الهدف.
- **معرفات BACKLOG ومعايير القبول:** `ASSUR-005` (P0) — سطح التدقيق الحي `GET /api/agent/harness` لا يؤكد قدرة لم يفحصها؛ اختبار يعيد `wired:false` لكل مكوّن عند مخزن ناقص، وعدم تغيّر أي قيمة مُعلَنة لواجهة قائمة عند مخزن حقيقي.
- **النطاق المسموح:** تعديل `src/agent/` + اختباراته + سجلات الاستمرارية. **ما يحتاج موافقة مستقلة:** الدفع، الدمج، النشر، أي فعل خارجي — ولم يُنفَّذ شيء منها (`AGENTS.md` · §12.7 من خارطة المستخدم).
- **ما نُفّذ هذه الجلسة:** البند ① فقط. البندان ② و③ ما زال اقتراحين مدروسَين **لم يُنفَّذا**.

## واقع البداية

- **الفرع الذي أثبتته البيئة وGit:** `arena/342e1174-phone-google` (لا الفرع المذكور في `STATE.md` السابق `arena/ee55f8c5-…`؛ `AGENTS.md`: لا يُستنتج فرع من تقرير قديم).
- **baseline commit:** `main@20c6ab8` — الشجرة نظيفة، `node --version` = v22.22.3، الإصدار `v0.3.0`.
- **worktree المستخدم:** لا عمل غير مُلتزم وجب الحفاظ عليه.
- **حالة PR/CI/النشر:** **لم يُتحقق** — لا `gh` ولا استعلام GitHub في هذه الجلسة؛ لا مطالبة بنشر.
- **عائق بداية مُثبت:** `bash`/`read_file`/`write_file` فشلت كلها بـ`Failed to initialize E2B workspace` عبر ستة أدوار. أُعيدت المحاولة فأُثبتت عودة البيئة، وثبّتَّ `npm ci` (106 حزم، 0 ثغرات) قبل أي قياس.

## ما تغير فعليًا

- **`src/agent/harness.js`:** `inspectAgentHarness` يشتقّ `wired` للمكوّنات العشرة من مسبارات على الكائنات الحيّة (`store.<method>` الفعلية · `tools.executable`/`validateInput`/تصنيف `RISK` · وحدة التقييم)، ويضيف `basis` و`missing` لكل مكوّن. مسباران اختياريان جديدان `sandbox` و`evaluation`: **الغياب = `false` لا `true`**. `evaluation_regression` يعلن `regressionSuiteVerified: false` + `notRuntimeVerifiable`.
- **`src/agent/runtime.js`:** `harness()` يمرّر مسبار التقييم الحي؛ `status()` يشتقّ `approvalGate` و`durable` ويقرأ المعرّفَين من مصدرهما.
- **`src/agent/evidence.js`:** `EVIDENCE_LEDGER = 'sha256-hash-chain-v1'` (كان مكررًا نصًّا في ملفين).
- **`src/agent/outbox.js`:** `OUTBOX_SCHEME = 'transactional-single-dispatch-v1'`.
- **`test/agent-harness-inspection.test.js`:** 9 اختبارات جديدة، مرآةً لـ`test/access-policy.test.js:225`.
- **`docs/plan-system-completion.md`:** `syntax_files` 261 ← 262 (سطران) — أثر إضافة ملف اختبار.
- **قرارات DEC:** `DEC-117` جديد (كان المعرّف حرًّا، وتحقّقت قبل الحجز). لا قرار مستبدل.
- **ما بقي اقتراحًا ولم يُنفَّذ:** البندان ② و③، وP1 («الفحص الفارغ يقول إنه فارغ» في `verifier.js`)، وP2 (`maxOutputLength` في فك ضغط `web-fetch.js`).

## الفحوص

| الأمر/الفحص | commit/البيئة | النتيجة أو سبب عدم التشغيل |
|---|---|---|
| `npm ci` | فرع الجلسة، نظيف | 106 حزم، `found 0 vulnerabilities` |
| `npm test` (خط الأساس **قبل** التعديل) | `main@20c6ab8` | 1260 اختبارًا / **1243 ناجح / 0 فشل / 17 متخطى** — يطابق `STATE.md` حرفًا |
| `npm test` (**بعد** التعديل) | هذا الفرع | **1269 / 1252 ناجح / 0 فشل / 17 متخطى** (+9 = الاختبارات الجديدة) |
| `npm run check` · `check:secrets` · `check:continuity` · `now:check` · `plan:check` · `atlas:check` · `visual:first:check` · `arch:map:check` · `access:policy:check` | هذا الفرع | **PASS كلها (9/9)** |
| `npm run arch:impact src/agent/harness.js src/agent/runtime.js` | قبل التعديل | مكوّنان: Agent Runtime · Kernel؛ 8 وحدات — فاعتُبر تعديلًا معماريًا |
| `npm run arch:map` | بعد التعديل | أعاد التوليد **بلا فرق بايت** — لا انزلاق في الخريطة |
| `npm run test:coverage` · `test:browser` · `release:check` · `build:pages` · `npm audit` | — | **لم تُشغَّل**: لا تغيير تغطية/متصفح/إصدار في هذه الشريحة؛ `npm audit --omit=dev` غير مطلوب بلا تغيير اعتماديات |

## الدليل البصري

- **لا يوجد تغيير بصري جديد**، والسبب: التغيير يصحّح **قيم** سطح تدقيق قائم لا شكله، ولا قيمة مُعلَنة تغيّرت عند مخزن حقيقي.
- **لكن صفحة مولدة قائمة تتأثر مضمونًا:** [docs/design/runtime-verified-architecture.html](../../design/runtime-verified-architecture.html) (دليل `agent.harness` في `src/design/visual-registry.js:117`). تعرض `isolatedContainerAvailable=false` وهو **ما زال false** (المسبار غائب)، فبقيت صادقة؛ و`visual:first:check` PASS. **فجوة مسجّلة:** الصفحة لا تعرض `basis`/`missing` الجديدين، وتحديثها يستحق شريحة بصرية مستقلة.
- حالات العناصر: 🟢 `wired` مشتقّ ومختبر (9 اختبارات) · 🟠 `regressionSuiteVerified` منفَّذ لكن غير قابل للتحقق وقت التشغيل **عن قصد** · 🟡 الصفحة البصرية لم تستوعب الحقلين الجديدين · ⚪ `sandbox.isolatedContainerAvailable` (AGENT-003 لم تُشحَن).

## الحفظ والتسليم

- **commit:** التغييرات في worktree فرع الجلسة. **حالة الدفع: لم يُدفع** — بلا تصريح مستقل.
- **PR/CI:** لا PR فُتح ولا CI استُعلم. **لا يُعتبر أي نجاح محلي نشرًا.**
- **الإنتاج والبيانات والأسرار:** لم يُمسّ إنتاج ولا قاعدة بيانات. `check:secrets` PASS. لا سرّ في الاختبارات (مسبارات كائنات مجرّدة، ومفتاح المالك في `agent-harness.test.js` قيمة اختبارية معلنة).
- **عمليات خطرة لم تُنفَّذ:** لا حذف/إعادة تهيئة قاعدة، لا إعادة كتابة تاريخ Git، لا نشر إصدار، لا دمج PR، لا تغيير مشاركة/أمان، لا تكلفة بنية تحتية.
- **نتيجة خارجية غير معروفة:** لا أثر خارجي أصلًا في هذه الشريحة، فلا مصالحة مطلوبة.

## ملحق — MULTI-001: مقترح محرك بديل، موثّق لا منفَّذ

طلب المالك فصلًا معماريًا لدمج OpenAI Agents SDK **كمحرك قابل للاستبدال لا كنظام
تشغيل**، وأضافه إلى خارطة طريقه الخارجية، مع إبقاء التنفيذ معلقًا حتى تدقيق
المستودع. **التدقيق كان منفَّذًا بالفعل في هذه الجلسة**، فبُني الفصل على دليله.

- **ملف الخارطة الخارجي غير موجود في المستودع** (`CeliaOS_AI_Reliability_Roadmap_2026.md`)،
  ولا اتفاقية ADR قائمة (فقط `DECISIONS.md`). لذا كُتب الفصل كمستودعي:
  [`docs/agent-multi-runtime-adr.md`](../../agent-multi-runtime-adr.md)، وحالته
  **🔵 مقترح**، ولم يُحجز له `DEC`.
- **النتيجة المعمارية المركزية:** الفصل المطلوب موجود فعلًا **عند المخطط**
  (`PROVIDER_PLAN_SCHEMA` · `validateProviderPlan` · `createGovernedFallbackPlanner` ·
  `MODEL_TIERS`/`ROUTE_REASONS`/`computeCostMicros`)، وكل فرض الأمن يسكن **الحلقة**
  (`runtime.js`). فنقل الفصل إلى الحلقة ينقل معه الترتيب الحاكم كله. القاعدة المقترحة
  قلب الاتجاه: **المحرك البديل يقترح، CeliaOS تنفّذ** — ولا يُسلَّم أي منفّذ حقيقي،
  وإلا صارت أدوات المحرك مسار تنفيذ ثانٍ، وهو ما تحظره `AGENTS.md` (UX-005).
- **تصحيحان على جدول الملكية المقترح:** ① «Agent Handoffs → SDK Adapter» **مرفوض كما
  هو مكتوب** — `delegation.js` تملك حسابًا أمنيًا لا يملكه SDK (`MAX_DEPTH=2` ·
  `MAX_FANOUT=4` · `RISK_ORDER` · `parentDigest` · **No widening**: سقف الابن ≤ الأب
  وأدواته مجموعة فرعية وميزانيته تُطرح من سقف الأب)؛ الصحيح ترجمة `handoffs` المحرك
  إلى `planDelegation`. ② «Agent Loop → SDK أو Native» مقبول **بشرط القلب فقط**.
- **سبعة من اختبارات القبول التسعة مفروضة اليوم** بأدلة مساراتها (§6 من المستند)؛
  فالعمل الجديد ليس بناء الأمان بل إثبات بقائه عندما يقترح الحلقةَ طرف آخر.
- **ستة عوائق تُحسم قبل التنفيذ:** `NETWORK=DENY` (يلزم `api.openai.com` عبر
  `egress-proxy` بمنحة لكل تشغيل) · التسعير المعلن **شرط بناء** في `model-router.js`
  («أي نموذج خارج الجدول يتطلب تسعيرًا صريحًا وإلا رفض البناء») · اعتمادية سادسة
  تغيّر المؤشر 8 وبوابة `npm audit` · تعارض مع هدف «بلا خدمات مدفوعة» · توافق
  Ollama/DeepSeek غير مُختبَر · TS مقابل Python عبر حدود عملية.
- **ما لم يُنفَّذ:** لا اعتمادية أُضيفت، ولا علم بيئة، ولا إدخال `.env.example`، ولا
  `DEC` حُجز، ولا مؤشر اكتمال رُفع.
- **أثر مشتقّ مسجَّل:** إضافة مهمة مفتوحة (`MULTI-001` بحالة «بانتظار قرار») أفشلت
  `plan:check` حتى وُضعت في موجة واحدة بالضبط — **W2 «قرارات المالك · لا كودًا»** —
  وحُدِّثت ثمانية مواضع مترابطة في `plan-system-completion.md` (العدد 59→60، وصف W2
  4→5، قرار W2 الجديد، و`open_tasks` 60/22/30/8) ثم أساس `continuity` 146/446/128.
  وهذا هو السلوك المصمَّم: «الجدول محروس آليًا… إضافة مهمة تُفشل الفحص حتى يُحدَّث
  الجدول في التغيير نفسه».

## الاستئناف

- **العوائق:** لا عائق تقني. بيئة العمل كانت معطّلة ستة أدوار ثم عادت؛ إن تعطّلت مجددًا فمسار `fetch_page` إلى `raw.githubusercontent.com` يقرأ المستودع دون `bash` (استُخدم فعلاً لقراءة `verifier.js` و`outbox.js` و`harness.js` و`runtime.js` و`goal-contract.js` و`memory.js` و`web-tools.js` و`web-fetch.js` و`issue-triage/injection.js` و`egress-proxy.js`).
- **الخطوة التالية بالضبط:** البند ② — تطبيق `scanForInjection` (الموجود في `src/agent/issue-triage/injection.js` والمستورد فعلًا في `web-tools.js`) داخل `sanitizeMessage` في `src/agent/gmail.js` على `subject`+`from`+`snippet`. **أول فحص آمن:** `node --test test/agent-gmail*.test.js` ثم `npm test`.
- **بعده:** البند ③ (`approval_required` كبيانات في `buildGoalContract` + تعميم `EXTERNAL_HINTS_RE` خارج نطاق التقويم) · P1 (فحوص `verifier.js` الفارغة تقول إنها فارغة) · P2 (`maxOutputLength` في `zlib` داخل `web-fetch.js`).
- **تأكيد التحديث:** حُدِّثت `STATE.md`، وصُفّ `ASSUR-005` في `BACKLOG.md`، و`DEC-117` في `DECISIONS.md`، وهذا السجل، ثم `npm run now` لإعادة توليد `NOW.md`.
