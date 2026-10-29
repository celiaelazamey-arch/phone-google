# تسليم جلسة — 2026-10-29 — MANUS-A2: إعادة التخطيط المحكومة `plan.revised`

## المهمة والتفويض

- طلب المستخدم: توجيه هندسي صارم بالبدء الفوري في M-A/A2 بالقيود: `max_replan_per_step = 1`، قراءة فقط أثناء الاستعادة، Fail-Closed، منع الحلقات المفتوحة، تسجيل `plan.revised` في سلسلة SHA-256، واختبارا الطفرة السلبيان (رفض المراجعة الثانية بكود صريح؛ حظر أداة الكتابة).
- معرفات BACKLOG: AI-002 / AGENT-010 (WP-3.2 في الخطة التنفيذية) — شريحة A2 من خطة «منافس مانوس» المعتمدة.
- النطاق: تنفيذ واختبار على الفرع فقط؛ لا نشر ولا ترحيل ولا مزود حي.

## واقع البداية

- الفرع: `arena/718068f3-phone-google` عند `b337bd7` (A1 مدمجة في الفرع ومدفوعة)، شجرة نظيفة.
- الإصدار `0.2.1` · `schema=1` بلا تغيير.

## ما تغير فعليًا

- `src/agent/replanner.js` (جديد): `createReplanPolicy` — `maxPerStep=1` + **حارس حلقة** `maxPerRun=1` (فشل المراجعة لا يفتح سلسلة مراجعات)، أداة المراجعة `RISK.read` مسجلة حصرًا (`replan_requires_read_tool`)، والعدّ حتمي من خطوات المخزن المعنونة `plan.revised` (`REVISION_STEP_TITLE`) لا من ذاكرة — الاستئناف لا يمنح نافذة جديدة. تجاوز أي حد → `max_replan_exceeded` فورًا.
- `src/agent/planner-provider.js`: معامل `revisionPolicy` (الافتراض `null` يحفظ `automatic_replan_disabled` حرفيًا — RPL-08)؛ القرار المسموح يحمل `planRevision`.
- `src/agent/runtime.js`: خطوة المراجعة تُعنون `plan.revised` وتُسجَّل في دليل `plan_created` مع `revision` (الخطوة الفاشلة/الأداة/`attempt`) داخل السلسلة.
- `src/agent/planner-fallback.js`: `max_replan_exceeded` و`replan_requires_read_tool` ضمن أكواد التحويل المرئي — توقف فوري ثم `planner_fallback` مرئي.
- `src/agent/verifier.js`: `goal_contract` لا يحسب فشل قراءة اسْتُدرك بمراجعة ناجحة — بشروط ضيقة (الفاشلة `read` حصرًا + خطوة `plan.revised` بعدها + نجاح أداة المراجعة فعلًا)؛ فشل الكتابة/الأثر الخارجي أو مراجعة لم تنجح يبقى حاجبًا (`verification_blocked` — RPL-07).
- `src/agent/index.js`: وضع `gemini` يشحن `createReplanPolicy()` افتراضيًا؛ تصدير `createReplanPolicy`/`REPLAN_LIMITS`/`REVISION_STEP_TITLE`.
- `test/agent-replan.test.js` (جديد): 9/9 (RPL-01..09) بلا شبكة، يشمل الطفرتين السلبيتين الإلزاميتين وحالة الـhost end-to-end.
- تحديث `test/agent-gemini-planner.test.js` (قائمة أكواد التحويل)، `docs/agent-planner-provider.md` (قسم A2)، `docs/manus-competitor-plan.md` (A2 ✅).
- لم ينفذ: A3 `call_many`، A4 model router/التكلفة، A5 التقييم الحي — ولا مصالحة جماعية ولا أي تغيير في عقود REST/MCP أو المخطط.

## الفحوص

| الأمر/الفحص | البيئة | النتيجة |
|---|---|---|
| `node --test test/agent-replan.test.js` | هذه الشجرة، Node 22.22.3 | 9/9، بلا شبكة |
| `node --test test/agent-{replan,gemini-planner,planner-provider}.test.js` | هذه الشجرة | 43/43 |
| `npm run test:coverage` | هذه الشجرة | 679 ناجحًا / 14 skipped / 1 فاشل بيئي معروف (N/N-1 يحتاج كائن Git تاريخيًا غير موجود في الاستنساخ — مثبت على خط الأساس قبل A1)؛ تغطية 90.71/75.70/86.88 فوق 89/71/82 |
| `npm run check` · `release:check` · `build:pages` · `npm audit --omit=dev` | هذه الشجرة | 168 ملفًا؛ كلها ناجحة؛ 0 ثغرات |
| `npm run now` + `check:continuity` | هذه الشجرة | ناجحة بعد تحديث الاستمرارية |

## الحفظ والتسليم

- commit على فرع الجلسة ودفع إليه حصرًا؛ لا PR جديد، لا نشر، لا ترحيل، لا أسرار.
- لا نتيجة خارجية غير معروفة — كل الفحوص محلية.

## الاستئناف

- الخطوة التالية: M-A/A3 — `call_many` للقراءات المستقلة (≤4 متزامنة) مع رفض أي أثر خارجي داخلها؛ أول فحص آمن: `node --test test/agent-replan.test.js test/agent-gemini-planner.test.js`.
- العائق القائم للشق الحي من A1: تفعيل `GEMINI_API_KEY` في بيئة تقييم معزولة وسقف ميزانية (قرار مالك، GOV-001).
