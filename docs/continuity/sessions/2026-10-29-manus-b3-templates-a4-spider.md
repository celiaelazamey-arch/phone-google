# جلسة 2026-10-29 — MANUS-B3 + إنقاذ A4 + الخيوط العنكبوتية (S4/S1)

**الفرع:** `arena/a3caa0c8-phone-google` (نفس فرع B2 — PR #92 كان مفتوحًا فأُضيفت الشريحة إليه بقرار تشغيلي معلن: دمج الفرع أولًا كان سيجمّد الجلسة قبل إنجاز الباقي).
**النطاق بالترتيب الذي نُفِّذ:** (1) إنقاذ A4 من PR #90 المتعارض بإعادة تطبيقه فوق main الحالي؛ (2) صف B3 قوالب المخرجات؛ (3) تفعيل محكوم لقارئ فهرس Celia Google Spider.

## 1) إنقاذ A4 — `model_router` (يُغلق PR #90)

- أُعيد تطبيق شريحة A4 كاملة من فرع PR #90 (`2b99293`) فوق هذا الفرع: `src/agent/model-router.js` و`test/agent-model-router.test.js` حرفيًا، ورقع `evaluation.js`/`planner-provider.js`/`runtime.js` بـ`git apply --3way` نظيفًا، و`index.js` بفضّ تعارض واحد (سطر `plannerSafe` اجتمع فيه B1/B2 مع `gemini-router`).
- وثائق A4 (`agent-planner-provider.md` + صفّا الخطة A4/S1 + سجل جلسة A4) جُلبت من الفرع نفسه.
- **الإثبات:** MR-01..10 = **10/10** على هذا الفرع (منها MR-04/08: `cost_budget_refused` رفضٌ قبل الإرسال لا تجاوز، والتشغيل ينتهي `budget_exhausted`).
- PR #90 يُغلق بعد دمج هذا الفرع — محتواه أصبح متفوقًا عليه هنا بلا تعارض.

## 2) B3 — قوالب المخرجات الحتمية

- **`src/agent/output-templates.js`:** `markdown_report` / `csv_table` / `static_page` — دوال نقية (لا ساعة/عشوائية/شبكة): نفس الـspec = نفس البايتات؛ تهريب HTML كامل وsubset Markdown مغلق؛ CSV بـRFC 4180؛ الصفحات بلا أي مورد خارجي.
- **أداة `template.render`:** مشروطة بمخزن B2؛ `internalWrite`+`settledFailures`؛ النشر عبر مسار B2 المبصوم؛ `sourceArtifactId` من بصمة المحتوى → idempotent بقاعدة البيانات.
- **البوابة الذهبية:** `npm run eval:templates` (`scripts/eval-templates.mjs` + `src/agent/template-eval.js`) — 3 مهام عبر الحلقة الحقيقية كاملة تُقارن ببصمات مثبتة في `data/eval/b3-templates/golden.json` → **PASS 3/3** (`reports/b3-templates.json`)، وTPL-06 يحرس التطابق في CI.
- **انحراف معلن عن نص الخطة:** المهام الذهبية في بوابة مستقلة لا داخل `eval:ai` — مجموعة AI-001 مجمّدة ببصمتها (120 حالة) ولا تُلوَّث بنوع مخرجات مختلف؛ الدمج قرار A5. `eval:ai` أُعيد تشغيله بعد التغييرات: **PASS 120/120** بلا تعديل تقريره المجمد.
- اختبارات: `test/agent-output-templates.test.js` **6/6** (حتمية البايتات، التهريب، أكواد الرفض، إغلاق الـsubset، شرطية الأداة، البوابة الذهبية).

## 3) الخيوط العنكبوتية — قارئ فهرس العنكبوت (قراءة فقط)

- **`src/agent/spider-reader.js`:** يفتح `knowledge.sqlite3` (فهرس `celia-google-spider/` المبني محليًا من Drive عبر MCP/stdio) **read-only وبصفر شبكة**، ويعيد تنفيذ دلالات Python حرفيًا: تطبيع `text_utils.py`، ترتيب/درجة/مقتطف `store.search`، و`graph_stats`.
- **أداتا قراءة حتميتان:** `spider.search_knowledge` و`spider.graph_stats` خلف `CELIA_AGENT_SPIDER=read` حصرًا (الافتراضي `off`؛ قيمة أخرى → `agent_spider_misconfigured`؛ فهرس غائب → `spider_index_unavailable` عند الإقلاع — لا ادعاء شبكة معرفة غير موجودة).
- **حد صريح:** القارئ لا يزامن ولا يكتب؛ المزامنة تبقى حصرًا بأدوات العنكبوت الست المستقلة بقرار المالك.
- اختبارات: `test/agent-spider-reader.test.js` **5/5** على فهرس ثابت بنفس مخطط Python (منها مرآة التطبيع العربي: أ→ا، ة→ه، ى→ي، الأرقام الهندية).

## البوابات الختامية

- `npm run test:coverage`: **745 اختبارًا، 729 ناجحًا، 0 فشل** (حتى N/N-1 البيئي زال بعد تعميق استنساخ Git لجلب الفرع القديم)، تغطية **91.11 / 75.82 / 87.18**.
- تحت `CELIA_SANDBOX_INTEGRATION=1`: sandbox 17 + sandbox-tool 9 + artifact-store 9 + templates 6 + spider 5 + model-router 10 = **56/56**.
- `check` 175 ملفًا · `release:check` · `build:pages` 12 صفحة · `npm audit --omit=dev` صفر ثغرات · `eval:ai` PASS 120/120 · `eval:templates` PASS 3/3.
- `reports/ai-001.json` أُعيد إلى نسخته المجمدة الملتزمة عمدًا (إعادة تشغيل التقييم كانت للإثبات لا للتجميد الجديد).

## حدود معلنة

- B3: لا PDF ولا قوالب خارج الأنواع الثلاثة المعلنة؛ الـsubset مغلق عمدًا.
- العنكبوت: القراءة من فهرس موجود فقط؛ لا مزامنة من الحلقة، ولا اتصال Google من هذا المسار إطلاقًا.
- A4: التفعيل الحي (`CELIA_AGENT_PLANNER=gemini-router`) يتطلب مفتاح Gemini — GOV-001 ما زال قرار المالك.
- المتبقي من S4: **B4** (رفع إلى Drive خلف الموافقة + outbox) — الكتابة الخارجية الأولى بعد Calendar.
