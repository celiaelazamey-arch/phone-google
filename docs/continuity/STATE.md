# الحالة الحالية — ابدأ من هنا

> **حفظ التاريخ بلا حذف (`DEC-052` / `CONT-004`):** هذه نافذة الاستئناف النشطة؛ السجل التراكمي الكامل حتى ما بعد PR #84 (`main@738d832` / `9f6f8b2` — 983 سطرًا / 142,150 بايت) محفوظ حرفيًا في **[STATE-ARCHIVE-2026-10.md](STATE-ARCHIVE-2026-10.md)** وبصمته محروسة بـ`R0-02`. نافذة GOOG-005 السابقة محفوظة في سجلها المؤرخ، والقراءة السريعة المشتقة: **[NOW.md](NOW.md)** (`npm run now`).

**آخر مراجعة:** 29 أكتوبر 2026 · **نوع الجلسة الحالية:** **WP-3.1 / AI-002 — مزوّد Gemini واحتياط حتمي مرئي** على `arena/dd2f6ff7-phone-google`: `createGeminiPlannerProvider` (POST واحد بمفتاح في ترويسة، `responseMimeType`/`responseSchema` بصيغة Gemini، بلا SDK/إعادة محاولة/تسريب) و`createFallbackPlanner` (فشل المزوّد → قرار `demo-deterministic` موسوم، وخطوة «احتياط حتمي مرئي» + `plan_created` بحكم `block`) و`CELIA_AGENT_PLANNER` بقيمتَي demo أو provider بفشل مغلق على غيرها، وعلى غياب المفتاح، وعلى نقص أدوات القراءة؛ الغلاف يرث القائمة المغلقة فلا يوسّع سطح التنفيذ · `GEM-01..03` + `FB-01..04` + `HOST-01` **8/8** · `npm test` **676: 662 ناجحًا، 0 فشل، 14 skipped** · التغطية **90.95% أسطر / 75.63% فروع / 86.99% دوال** · **لا مكالمة Gemini حقيقية ولا تفعيل في أي بيئة** · `AI-002` يبقى `جارٍ` للتشغيل الحي ·
الشريحة السابقة في الجلسة نفسها: WP-2.2 / WA-006 (DEC-058، `0fe6327`) · سجل WP-3.1: [2026-10-29-wp-3-1-gemini-planner](sessions/2026-10-29-wp-3-1-gemini-planner.md) ·
سجل WP-2.2: [2026-10-29-wp-2-2-whatsapp-context](sessions/2026-10-29-wp-2-2-whatsapp-context.md) ·
سجل GOOG-005 المدمج في `main@05e2eb2` (PR #88): [2026-10-29-google-readonly-2026](sessions/2026-10-29-google-readonly-2026.md) ·
سجل Sandbox السابق: [2026-10-29-agent003-sandbox](sessions/2026-10-29-agent003-sandbox.md) ·
سجل KB السابق: [2026-10-29-ai002-kb-governance](sessions/2026-10-29-ai002-kb-governance.md) ·
سجل AI-002 السابق: [2026-10-29-ai-002-planner-provider](sessions/2026-10-29-ai-002-planner-provider.md) ·
سجل WP-2.4/AI-001: [2026-10-29-wp-2-4-ai-001](sessions/2026-10-29-wp-2-4-ai-001.md) ·
سجل WP-2.3: [2026-10-29-wp-2-3-agent-memory](sessions/2026-10-29-wp-2-3-agent-memory.md) ·
سجل WP-2.1 المدمج: [2026-10-29-wp-2-1-context-policy](sessions/2026-10-29-wp-2-1-context-policy.md) ·
الأرشيف التاريخي الكامل: [STATE-ARCHIVE-2026-10.md](STATE-ARCHIVE-2026-10.md)

## 1. خط الأساس المتحقق (`05e2eb2`)

- **بداية هذه الجلسة:** الفرع `arena/dd2f6ff7-phone-google` بدأ من `05e2eb2` (دمج PR #88) بشجرة نظيفة؛ لا PR مفتوح (صفر)، وقضية مفتوحة واحدة `#59` (triage ledger). آخر تشغيلات `main` ناجحة: الجودة · Pages · Cloudflare Edge · Release · Render · Notify.
- **فحوص البداية:** `npm run check` ✅ 166 ملفًا، `npm run now:check` ✅، `npm run check:continuity` ✅ (79 مستندًا/282 رابطًا/77 مهمة/بلا دورات). `npm test` أعطى **646 ناجحًا + 14 skipped + فشل واحد** في `secrets-hub` N/N−1 لأن `2508893…` غائب عن `shallow clone`؛ جُلب الكائن من origin فصار **6/6** بلا تعديل اختبار أو عقد.
- **قاعدة التوافق:** إصدار `0.2.1` و`schema=1` بلا تغيير؛ لا ترحيل ولا جدول جديد في هذه الحزمة. لا تغيير في `workers/` أو `sql/` أو `public/`.

## 2. ما نُفِّذ في هذه الشريحة — WP-3.1 / AI-002 (DEC-059)

- **المزوّد:** `createGeminiPlannerProvider` في `src/agent/planner-provider.js` — نقل واحد إلى `models/<model>:generateContent` بمفتاح في ترويسة، و`responseMimeType:'application/json'`، و`responseSchema` من `toGeminiSchema` (`type:['string','null']` → `nullable:true`، وإسقاط قيود غير مدعومة **من السلك فقط**). المخطط المحلي يبقى الحاكم في `validateProviderPlan`. لا SDK، لا إعادة محاولة، لا نقطة بديلة، والأخطاء رموز معلنة بحالة HTTP بلا مفتاح ولا جسم رد.
- **الاحتياط المرئي:** `createFallbackPlanner` يتولى أي رمز من `PLANNER_PROVIDER_FAILURES` بقرار `demo-deterministic` موسوم؛ `runtime` يكتب خطوة «احتياط حتمي مرئي» و`plan_created` بحكم `block` مع بصمة طلب المزوّد. `planner_cancelled`/`signal.aborted` لا يُلطَّفان، والرمز المجهول يُعاد بلا احتياط.
- **الفشل المغلق:** `readAgentPlanner` يقبل `demo` (افتراضي) و`provider`/`gemini` فقط؛ `provider` بلا `GEMINI_API_KEY` → `planner_provider_not_configured`، ونقص أدوات القراءة → `planner_tools_unavailable`، وقيمة مجهولة → `invalid_agent_planner`. الحالة تعرض `gemini+deterministic-fallback` و`plannerToolAllowlist` (قراءة فقط، 2–4).
- **التكلفة بلا اختلاق:** الرموز تُقاس من `usageMetadata` وتصل `recordCost`؛ `costMicros` يبقى 0 و`priceKnown:false` لغياب جدول أسعار.
- **الشريحة السابقة في الجلسة نفسها (WP-2.2، DEC-058، `0fe6327`):** نافذة آخر 6 رسائل للرقم نفسه + أعلى 3 نتائج T1/T2 خلف `CELIA_WA_CONTEXT=off`، عبر سياسة السياق وحدها.

## 3. القرار المسجَّل مالكيًا في هذه الجلسة

- **مزوّد التخطيط (WP-3.1 / GOV-001):** اختار المالك **Gemini المجاني بشروطه**، ونُفِّذ المزوّد في الكود محليًا (DEC-059) **بلا تفعيل** ولا مكالمة حية ولا ادعاء جودة.
- **التفعيل الحي:** لم يُفعَّل `CELIA_AGENT_PLANNER=provider` في أي بيئة؛ `demo` يبقى الافتراضي في الكود و`.env.example`.

## 4. تقدّم الخطة والخطوة التالية

- **الخطوة 1:** WP-1.1..WP-1.4 مدمجة (`main@8f850ce` → `main@50cda13`).
- **الخطوة 2:** WP-2.1 وWP-2.3 وWP-2.4 مدمجة؛ **WP-2.2 منفَّذ محليًا** (DEC-058، `0fe6327`) بانتظار كلمة المالك.
- **الخطوة 3:** **WP-3.1 منفَّذ محليًا** (DEC-059) بلا مكالمة Gemini حية؛ المتبقي **WP-3.2** (`plan.revised` مرة واحدة لكل خطوة فاشلة من فئة قراءة/كتابة داخلية) و**WP-3.3** (`call_many` للقراءات المستقلة) و**WP-3.4** (توجيه النماذج وتكلفة فعلية تحتاج جدول أسعار معتمدًا).
- **قياس معلّق (WP-1.4):** سلسلة D1 الخمس ونسبة الردود المقصوصة «قيست ولم تُقرأ»؛ حزمة `edge-live-acceptance-50cda13…` على GitHub غير منتهية الصلاحية وقابلة للقراءة بمعرّف تشغيلة في [service-reality.md](../service-reality.md).

## 5. العوائق وحدود الدليل

1. **لا دليل حي في هذه الجلسة:** لا مكالمة Gemini، ولا رسالة WhatsApp، ولا مزوّد حي، ولا قياس جودة تخطيط أو رد بلغة العملاء. كل اختبارات WP-3.1 تستخدم `fetchImpl` وهميًا.
2. **AI-001 حي:** التقرير المحلي PASS (120/120) والمراجعة البشرية 20/20 مغلقة، لكن المفتاح غير مهيأ للتنفيذ المحلي ولم تُنفَّذ تشغيلة حية معزولة.
3. **MySQL وChromium:** لا خدمة MySQL معزولة ولا Chromium في الصندوق؛ لم يُشغَّل `test:mysql` ولا Playwright في هذه الجلسة.
4. **قرارات المالك القائمة:** تفعيل `CELIA_AGENT_PLANNER=provider` في أي بيئة، وتشغيل Gemini حي معزول، وتفعيل `CELIA_WA_CONTEXT` في الإنتاج، وحماية `main`/CodeQL (`SEC-006`)، وربط Google/Meta وRender/Aiven (`GOOG-001`/`WA-005`/`HOST-003`)، وميزانية/ترخيص (`GOV-001`).

## 6. الاستئناف والفحوص

1. ابقَ على `arena/dd2f6ff7-phone-google`؛ اقرأ [سجل WP-3.1](sessions/2026-10-29-wp-3-1-gemini-planner.md) و[DEC-059](DECISIONS.md) و[سجل WP-2.2](sessions/2026-10-29-wp-2-2-whatsapp-context.md). **لا تفتح/تدمج PR ولا ترحّل أو تنشر أو تفعّل `provider` أو `CELIA_WA_CONTEXT` في أي بيئة إلا بكلمة المالك.**
2. كل معرفة جديدة تحتاج `claim_type` و`review_due`؛ `kb.search` قراءة محلية فقط. لا تستأنف أدوات التنفيذ ولا تربط Sandbox بـRuntime.
3. لا تُغلق `AI-002` قبل التشغيل الحي المعزول، ولا `WA-006` قبل نسخة الحافة وقرار التفعيل؛ ولا تُسجّل رقم أداء بلا تشغيلة (DEC-045).

```sh
git branch --show-current && git status --short && git log -3 --oneline
node --test test/agent-planner-fallback.test.js test/agent-planner-provider.test.js
node --test test/whatsapp-context.test.js
npm test
npm run test:coverage
npm run check && npm run now:check && npm run check:continuity && npm run check:secrets
```
