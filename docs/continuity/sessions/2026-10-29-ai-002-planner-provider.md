# جلسة 2026-10-29 — AI-002 Planner + Function Calling (شريحة محلية أولى)

**الفرع:** `arena/0b72e456-phone-google` · **النشر/المزود الحي/الكتابة الخارجية:** لم يحدث · **المرجع عند البدء:** `6b669b6`.

## النطاق والتنفيذ

نُفذت شريحة واحدة تجمع Planner وTool Use داخل Runtime القائم، لا مسارًا موازيًا ولا وكيل برمجة عامًا. أُضيف `src/agent/planner-provider.js` بعقد `provider.createPlan` قابل للحقن، ومخطط JSON مغلق، و2–4 أدوات قراءة executable، وطلب يحوي الهدف والحالة والذاكرة و`tool_result`. أُضيفت قائمة سماح تنفيذية، وفحص مدخلات للمسار المزود، ومنع `automatic_replan_disabled` بعد فشل قراءة، وحدود مهلة/رموز/تكلفة عند توفر قياس المزود.

أُضيفت أحداث الأدلة `plan_created` و`tool_selected` و`tool_executed` و`verification_result` للمسار المزود فقط، مع `stepId` وبصمات SHA-256 للمدخلات والمخرجات. بقي `demo-deterministic` هو الافتراضي، ولم تتغير موافقات/outbox/idempotency أو تقارير AI-001. لا SDK أو اتصال شبكة أو مفتاح في الشريحة، ولا Sandbox/Shell/Git/كتابة ملفات.

## الأدلة المنفذة

- `node --test test/agent-planner-provider.test.js` → **10/10**: عربي وإنجليزي، قراءة صحيحة و`tool_result`، إنهاء وتوضيح بلا أداة، رفض JSON/أداة غير مصرح بها، منع أداة خارجية قبل الموافقة، فشل آمن، منع إعادة التخطيط، مهلة المزود، واستئناف بلا تكرار قراءة مؤكدة.
- `node --test test/agent-planner-provider.test.js test/agent-runtime.test.js test/agent-ai-eval.test.js` → **34/34** بعد إضافة `threadMessages` و`context.memory`؛ AI-001 لم يتكسر.
- كان أول تشغيل كامل يفشل فقط في `test/secrets-hub.test.js:323` لأن الـshallow checkout يفتقد `2508893bd7e6d447b2e19374933556322cc9cdb7`. جُلب ذلك الـcommit التاريخي صراحةً بـ`git fetch --no-tags origin <sha>` دون تغيير الفرع؛ اختبار الملف أصبح **6/6**.
- `npm test` النهائي بعد إزالة العائق → **625/625 ناجحة، صفر فشل/تخطي**.
- `npm run test:coverage` النهائي → **625/625**؛ التغطية المقاسة **91.92% أسطر / 75.23% فروع / 87.21% دوال**، فوق أرضية 89/71/82.
- `npm run check` → **161 ملف JavaScript**؛ `npm run check:secrets` → `wiringVerified:true` و`zeroLeakVerified:true`؛ `npm run check:continuity` → **73 وثيقة و265 رابطًا و75 مهمة بلا دورات**؛ `git diff --check` ناجح.

## حدود الادعاء

هذه الاختبارات حتمية على SQLite ومزود وهمي. تثبت عقد الحلقة، اختيار/تنفيذ القراءة، إعادة النتيجة، الحوكمة والاستئناف فقط؛ لا تثبت جودة Gemini أو أي نموذج حي، ولا اتصال Google/WhatsApp، ولا قبول Chromium/MySQL، ولا جاهزية إنتاجية. AI-001 ما زال غير مغلق كتشغيل حي. لم تُعدّل `reports/ai-001.json` أو عينة المراجعة البشرية، ولم تُسجل قرارات مراجعة آلية.

التوثيق التفصيلي في [agent-planner-provider.md](../../agent-planner-provider.md). لم يُضف `planner_fallback` أو علم تفعيل مزود أو إعادة تخطيط مستقبلية؛ ترتيب التقارب التالي يبقى Sandbox ثم مراجعة محدودة ثم أدوات أوسع داخل عزل وموافقات.
