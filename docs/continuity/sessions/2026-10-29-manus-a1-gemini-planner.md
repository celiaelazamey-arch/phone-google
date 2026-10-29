# تسليم جلسة — 2026-10-29 — خطة «منافس مانوس» + شريحة A1 (مخطط Gemini خلف علم)

## المهمة والتفويض

- طلب المستخدم والمتطلبات الجديدة المهمة: «خطة تطوير لها بالكامل لتستحق لقب منافس مانوس» ثم «اعتمد ثم أبدأ بتنفيذ M-A/A1 (توصيل المخطط الحي خلف علم مع بقاء الافتراضي الحتمي)».
- معرفات BACKLOG ومعايير القبول: AI-002 (الشق الهيكلي للمزود الحي)؛ القبول: علم صريح، مخطط JSON صارم، `planner_fallback` مرئي، الافتراضي `demo` بلا تغيير، اختبارات بلا شبكة.
- النطاق المسموح؛ ما يحتاج موافقة مستقلة: تنفيذ واختبار على الفرع فقط. التشغيلة الحية المعزولة لـ`eval:ai` بالمفتاح الفعلي وميزانية المزوّد تبقيان قرار مالك (GOV-001، §5 من الخطة).

## واقع البداية

- الفرع الذي أثبتته البيئة وGit: `arena/718068f3-phone-google` من `main@05e2eb2` (دمج PR #88)، شجرة نظيفة.
- baseline commit وإصدار التطبيق: `05e2eb2` · `0.2.1` · `schema=1`.
- worktree المستخدم الذي وجب الحفاظ عليه: لا عمل غير محفوظ عند البداية.
- حالة PR/CI/النشر إن تحققت: `main` == `origin/main` عند البداية، صفر PR مفتوح (قراءة حية بـ`gh pr list` في هذه الجلسة).

## ما تغير فعليًا

- `docs/manus-competitor-plan.md` (جديد): خطة «منافس مانوس» الكاملة (6 معايير C1–C6، 6 مراحل M-A..M-F)؛ اعتمدها المالك نصًا («اعتمد») في هذه الجلسة.
- `src/agent/gemini-planner-provider.js` (جديد): محوّل Gemini خلف عقد `provider.createPlan` — طلب واحد `responseMimeType: application/json` بحرارة 0، قصّ مدخلات حتمي معلن، قياس رموز من `usageMetadata` فقط (`measured`)، تسوية وحيدة لشذوذ `args` كسلسلة، وأكواد فشل صريحة. `responseSchema` لم يُرسل عمدًا (موثق).
- `src/agent/planner-fallback.js` (جديد): `createGovernedFallbackPlanner` — قائمة أكواد `PLANNER_FALLBACK_CODES` الصريحة؛ قبل أي أداة → المخطط الحتمي نفسه؛ بعد تنفيذ أدوات → إنهاء آمن بتسليم بحدود (`bounded_delivery`) بلا أداة بديلة؛ الإلغاء و`automatic_replan_disabled` يُرفعان دائمًا.
- `src/agent/runtime.js`: كتلة واحدة إضافية — `decision.plannerFallback` تُسجَّل خطوة `planner_fallback` ودليل `plan_created` بحكم `BLOCK` قبل متابعة القرار الحتمي.
- `src/agent/planner.js`: تصدير `DEMO_PLANNER_TOOL_SURFACE` (قائمة عضوية صريحة لقائمة سماح المنفذ في وضع الاحتياط).
- `src/agent/index.js`: `CELIA_AGENT_PLANNER` يقبل `demo` (افتراضي، بلا تغيير سلوك) أو `gemini`؛ `gemini` بلا `GEMINI_API_KEY` → `agent_planner_misconfigured` صريح لا ارتداد صامت؛ أدوات المزوّد قراءة فقط (`celia.thread_context/system_status/draft_outline` + `kb.search` عند KB)؛ منفذ حقن `plannerProvider` للاختبارات؛ تصدير الرموز الجديدة.
- `test/agent-gemini-planner.test.js` (جديد): 24 اختبارًا بلا شبكة (GEM-01..09، FBK-01..04، HOST-01..04).
- وثائق: `docs/agent-planner-provider.md` (قسم شريحة A1 وإزالة حد «لا planner_fallback» بتأريخ)، `docs/go-live-plan.md` (تأريخ تغيّر الرفض الصريح)، `.env.example` (قيمتا العلم)، `docs/manus-competitor-plan.md` (A1 ✅ الشق الهيكلي).
- ما بقي مجرد اقتراح ولم ينفذ: التشغيلة الحية المعزولة (باقي A1)، A2 إعادة التخطيط المحكومة، A3 `call_many`، A4 model router/التكلفة، A5 توسيع التقييم؛ ولا قرار DEC جديد سُجّل (القرار الحاكم هو اعتماد المالك للخطة في المحادثة).

## الفحوص

| الأمر/الفحص | commit/البيئة | النتيجة أو سبب عدم التشغيل |
|---|---|---|
| `node --test test/agent-gemini-planner.test.js` | هذه الشجرة، Node 22.22.3 | 24/24 ناجح، بلا شبكة |
| `node --test` (الحزمة الكاملة) | هذه الشجرة | 670 ناجح / 14 skipped / **1 فاشل معروف بيئيًا**: `secrets-hub` N/N-1 يحتاج كائن Git تاريخيًا (`2508893b…`) غير موجود في هذا الاستنساخ المضغوط؛ **ثبت فشله على خط الأساس النظيف قبل أي تعديل** (git stash ثم إعادة التشغيل) |
| `npm run test:coverage` | هذه الشجرة | 90.67% أسطر / 75.62% فروع / 86.79% دوال — فوق الأرضية 89/71/82 |
| `npm run check` | هذه الشجرة | 167 ملفًا، ناجح |
| `CELIA_MCP_DISABLE_MYSQL=true CELIA_DISABLE_OLLAMA=true npm run celia:mcp:verify` | هذه الشجرة | ناجح (بلا مزود حي في هذه البيئة) |
| `npm run release:check` · `npm run now:check` · `npm run check:continuity` · `npm run build:pages` · `npm audit --omit=dev` | هذه الشجرة | كلها ناجحة؛ 0 ثغرات |

## الحفظ والتسليم

- commit/مرجع التغيير، وحالة الدفع الفعلية: خطة «منافس مانوس» دُفعت في `2b229e1`؛ شريحة A1 تُحفظ وتُدفع في commit تالٍ على الفرع نفسه (انظر Git log الفعلي للفرع).
- رابط PR وCI إن توفر: لم يُفتح PR في هذه الجلسة؛ لا يُعد commit الفرع نشرًا.
- حالة الإنتاج والبيانات والأسرار: لا نشر، لا ترحيل، لا اتصال Gemini حي، لا لمس أسرار؛ مفتاح الاختبارات سلسلة وهمية.
- أي نتيجة خارجية غير معروفة: لا شيء — كل الفحوص محلية بلا أثر خارجي.

## الاستئناف

- العوائق والمعلومات المطلوبة دون أسرار: تفعيل `GEMINI_API_KEY` في بيئة تقييم معزولة وسقف ميزانية (قرار مالك) لإكمال شق A1 الحي.
- الخطوة التالية بالضبط ومعرفها وأول فحص آمن: M-A/A2 — `plan.revised` المحكومة (مرة واحدة لكل خطوة فاشلة، قراءات فقط) مع اختباري الطفرة السلبيين؛ أول فحص آمن: `node --test test/agent-gemini-planner.test.js test/agent-planner-provider.test.js`.
