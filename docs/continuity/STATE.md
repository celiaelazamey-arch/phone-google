# الحالة الحالية — ابدأ من هنا

> **حفظ التاريخ بلا حذف (`DEC-052` / `CONT-004`):** هذه نافذة الاستئناف النشطة؛ السجل التراكمي الكامل حتى ما بعد PR #84 (`main@738d832` / `9f6f8b2` — 983 سطرًا / 142,150 بايت) محفوظ حرفيًا في **[STATE-ARCHIVE-2026-10.md](STATE-ARCHIVE-2026-10.md)** وبصمته محروسة بـ`R0-02`. نافذة GOOG-005 السابقة محفوظة في سجلها المؤرخ، والقراءة السريعة المشتقة: **[NOW.md](NOW.md)** (`npm run now`).

**آخر مراجعة:** 29 أكتوبر 2026 · **نوع الجلسة الحالية:** **WP-2.2 / WA-006 — سياق ردود WhatsApp خلف علم مطفأ** على `arena/dd2f6ff7-phone-google`: `src/whatsapp-context.js` يجمع آخر 6 رسائل للرقم نفسه (الرسالة الجارية مستثناة بمعرّف المزوّد) وأعلى 3 نتائج T1/T2 من `kb.search` بملف `planner`، وتُمرَّر عبر `src/context-policy.js` وحده إلى المزوّدات الأربعة؛ `CELIA_WA_CONTEXT=off` افتراضيًا مع فشل مبكر على قيمة غير معروفة · `CTX-00..05` + `CTX-03b` **7/7** · `npm test` **668: 654 ناجحًا، 0 فشل، 14 skipped** · التغطية **90.82% أسطر / 75.55% فروع / 86.94% دوال** · لا رسالة WhatsApp حقيقية ولا مزوّد حي ولا تفعيل إنتاجي أو حافة · `WA-006` يبقى `جارٍ` لنسخة الحافة والتفعيل ·
سجل الجلسة الحالي: [2026-10-29-wp-2-2-whatsapp-context](sessions/2026-10-29-wp-2-2-whatsapp-context.md) ·
سجل GOOG-005 المدمج في `main@05e2eb2` (PR #88): [2026-10-29-google-readonly-2026](sessions/2026-10-29-google-readonly-2026.md) ·
سجل Gmail السابق: [2026-10-29-gmail-read-connector](sessions/2026-10-29-gmail-read-connector.md) ·
سجل Sandbox السابق: [2026-10-29-agent003-sandbox](sessions/2026-10-29-agent003-sandbox.md) ·
سجل KB السابق: [2026-10-29-ai002-kb-governance](sessions/2026-10-29-ai002-kb-governance.md) ·
سجل Drive السابق: [2026-10-29-drive-selective-import](sessions/2026-10-29-drive-selective-import.md) ·
سجل AI-002 السابق: [2026-10-29-ai-002-planner-provider](sessions/2026-10-29-ai-002-planner-provider.md) ·
سجل WP-2.4/AI-001: [2026-10-29-wp-2-4-ai-001](sessions/2026-10-29-wp-2-4-ai-001.md) ·
سجل WP-2.3: [2026-10-29-wp-2-3-agent-memory](sessions/2026-10-29-wp-2-3-agent-memory.md) ·
سجل R0 المدمج: [2026-10-29-r0-continuity-2026](sessions/2026-10-29-r0-continuity-2026.md) ·
سجل WP-2.1 المدمج: [2026-10-29-wp-2-1-context-policy](sessions/2026-10-29-wp-2-1-context-policy.md) ·
الأرشيف التاريخي الكامل: [STATE-ARCHIVE-2026-10.md](STATE-ARCHIVE-2026-10.md)

## 1. خط الأساس المتحقق (`05e2eb2`)

- **بداية هذه الجلسة:** الفرع `arena/dd2f6ff7-phone-google` بدأ من `05e2eb2` (دمج PR #88) بشجرة نظيفة؛ لا PR مفتوح (صفر)، وقضية مفتوحة واحدة `#59` (triage ledger). آخر تشغيلات `main` ناجحة: الجودة · Pages · Cloudflare Edge · Release · Render · Notify.
- **فحوص البداية:** `npm run check` ✅ 166 ملفًا، `npm run now:check` ✅، `npm run check:continuity` ✅ (79 مستندًا/282 رابطًا/77 مهمة/بلا دورات). `npm test` أعطى **646 ناجحًا + 14 skipped + فشل واحد** في `secrets-hub` N/N−1 لأن `2508893…` غائب عن `shallow clone`؛ جُلب الكائن من origin فصار **6/6** بلا تعديل اختبار أو عقد.
- **قاعدة التوافق:** إصدار `0.2.1` و`schema=1` بلا تغيير؛ لا ترحيل ولا جدول جديد في هذه الحزمة. لا تغيير في `workers/` أو `sql/` أو `public/`.

## 2. ما نُفِّذ في هذه الشريحة — WP-2.2 / WA-006 (DEC-058)

- **وحدة قراءة فقط:** `src/whatsapp-context.js` — `readWaContextMode` (مجموعة مغلقة `off`/`on`)، `historyWindow` (أحدث 6، أقدم→أحدث، سقف 1000 حرف/رسالة)، `knowledgeFromSearch` (T1/T2 فقط، 3 نتائج، 240 حرفًا للمقتطف، علامة مصدر = معرّف السجل أو URI)، و`loadWhatsAppContext` الذي لا يرمي أبدًا ويعيد `failures` مسمّاة (`history_unavailable` / `knowledge_disabled` / `knowledge_unavailable`).
- **الربط:** `src/whatsapp.js` يجمع السياق في مسار الرد التلقائي فقط ويستثني الرسالة الجاري الرد عليها؛ `src/ollama.js` يمرّر `knowledge`/`history`/`budgets` إلى Gemini وOpenAI-compatible وOllama (الافتراضي فارغ فلا يتغير أي مستدعٍ قائم)؛ `src/config.js` يضيف `whatsapp.contextEnabled` بفشل مبكر؛ `src/app.js` يمرّر مضيف المعرفة إلى الـwebhook.
- **العلم:** `CELIA_WA_CONTEXT=off` افتراضيًا في `.env.example` والوثائق؛ الإطفاء لا يقرأ `whatsapp_messages` ولا KB، وجسم طلب المزوّد مطابق بايتًا لما قبله.
- **الحدود المختبرة:** لا تسريب بين رقمين (الاستعلام مقيّد بالرقم واختبار يزرع رقمًا ثانيًا)، لا تكرار للدور الحالي، حقن في الدور الحالي لا يغيّر `DEFAULT_POLICY` ولا ينشئ عنصر معرفة مزيفًا، ورسالة مخزّنة خبيثة تبقى سطر بيانات واحدًا بعد `flattenLine`.
- **مؤجل صراحةً:** نسخة الحافة من السياسة (`workers/celia-edge/runtime.js` يبني الـprompt بنفسه وبلا مخزن معرفة؛ النقل يجب أن يكون وحدة مشتركة لا نسخًا)، والتفعيل الإنتاجي، والبحث الدلالي/embeddings.

## 3. القرار المسجَّل مالكيًا في هذه الجلسة

- **مزوّد التخطيط (WP-3.1 / GOV-001):** اختار المالك **Gemini المجاني بشروطه**. لم تبدأ الخطوة 3 ولم يُفعَّل أي مزوّد حي؛ الاختيار مسجَّل كمدخل للشريحة التالية فقط.

## 4. تقدّم الخطة والخطوة التالية

- **الخطوة 1:** WP-1.1..WP-1.4 مدمجة (`main@8f850ce` → `main@50cda13`).
- **الخطوة 2:** WP-2.1 مدمج (`main@738d832`)؛ WP-2.3 وWP-2.4 مدمجان (`main`, PR #86 وما قبله)؛ **WP-2.2 منفَّذ محليًا الآن** على فرع الجلسة بانتظار كلمة المالك لفتح PR ودمجه.
- **التالي بعد الإذن:** إما (أ) «نسخة الحافة لسياق واتساب» بنقل `context-policy` وحدةً مشتركة إلى `workers/celia-edge`، أو (ب) الخطوة 3 / WP-3.1 بمزوّد Gemini المجاني كما اختاره المالك، ثم WP-3.2 (`plan.revised` مرة واحدة) وWP-3.3 (`call_many`) وWP-3.4 (توجيه النماذج والتكلفة).
- **قياس معلّق (WP-1.4):** سلسلة D1 الخمس ونسبة الردود المقصوصة «قيست ولم تُقرأ»؛ حزمة `edge-live-acceptance-50cda13…` على GitHub **غير منتهية الصلاحية** وقابلة للقراءة ولصقها بمعرّف تشغيلة في [service-reality.md](../service-reality.md).

## 5. العوائق وحدود الدليل

1. **لا دليل حي في هذه الحزمة:** كل النتائج محلية/SQLite/Mock؛ لا رسالة WhatsApp حقيقية، ولا تطبيق Meta، ولا مزوّد حي، ولا قياس جودة رد بلغة العملاء.
2. **AI-001 حي:** التقرير المحلي PASS (120/120) والمراجعة البشرية 20/20 مغلقة، لكن المفتاح غير مهيأ للتنفيذ المحلي ولم تُنفَّذ تشغيلة حية معزولة.
3. **MySQL وChromium:** لا خدمة MySQL معزولة ولا Chromium في الصندوق؛ لم يُشغَّل `test:mysql` ولا Playwright.
4. **قرارات المالك القائمة:** تفعيل `CELIA_WA_CONTEXT` في الإنتاج، و`CELIA_WA_CONTEXT` على الحافة بعد نقل السياسة، وحماية `main`/CodeQL (`SEC-006`)، وربط Google/Meta وRender/Aiven (`GOOG-001`/`WA-005`/`HOST-003`)، وميزانية/ترخيص (`GOV-001`).

## 6. الاستئناف والفحوص

1. ابقَ على `arena/dd2f6ff7-phone-google`؛ اقرأ [سجل WP-2.2](sessions/2026-10-29-wp-2-2-whatsapp-context.md) و[DEC-058](DECISIONS.md). **لا تفتح/تدمج PR ولا ترحّل أو تنشر أو تفعّل علَمًا في الإنتاج إلا بكلمة المالك.**
2. كل معرفة جديدة تحتاج `claim_type` و`review_due`؛ `kb.search` قراءة محلية فقط. لا تستأنف أدوات التنفيذ ولا تربط Sandbox بـRuntime.
3. لا تُغلِق `WA-006` قبل نسخة الحافة وقرار التفعيل؛ ولا تُسجّل رقم أداء بلا تشغيلة (DEC-045).

```sh
git branch --show-current && git status --short && git log -3 --oneline
node --test test/whatsapp-context.test.js
npm test
npm run test:coverage
npm run check && npm run now:check && npm run check:continuity && npm run check:secrets
```
