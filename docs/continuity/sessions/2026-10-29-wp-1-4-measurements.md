# جلسة 2026-10-29 — «ابدأ» → WP-1.4 قياس القصّ وزمن D1 (DEC-050)

**الفرع:** `arena/69672f71-phone-google` (من `main@0357442` = دمج PR #82) · **PR:** لم يُفتح بعد — يُفتح على رسالة المنصة أو كلمة المالك، ويُدمج بكلمة «ادمج» ·
**القرار:** DEC-050 · **الخطة:** `docs/agent-2026-execution-plan.md` §WP-1.4 (معتمدة بـDEC-047) · **صف BACKLOG:** AGENT-008

## 1. ما وصل
بعد دمج #82 وإغلاق #80 بلا دمج بقرار المالك، كتب المالك «ابدأ» → الحزمة الرابعة من الخطة: عدّاد الردود المقصوصة يُخزَّن مع الرسالة، سلسلة زمن D1 في
`verify:live` بدل رقم واحد، وقسم «أرقام مقاسة» بتاريخ وتشغيلة — بلا رقم مخترَع.

## 2. ما قيس قبل التصميم (من الشيفرة لا من الذاكرة)
- `generateEdgeAiReply` يرسل `maxOutputTokens: 220` ويتجاهل `candidates[0].finishReason` ويقصّ الرد عند 1000 حرف؛ Express: 180 رمزًا وقصّ 1000 ويعيد نصًا.
- `whatsapp_messages` بلا عمود قياس، و`applyMigrations` يعيد تطبيق **كل** عبارات الترحيل في كل رفع (DEC-044) → `ALTER TABLE ADD COLUMN` سيكسر الرفع الثاني.
- `Dockerfile` ينسخ `src public sql releases` فقط → `src/` لا يستورد من `workers/`.
- `/readyz` على الحافة يعيد `storage.latencyMs` (كتابة رمز + قراءته) — هو مصدر السلسلة الطبيعي بلا مسار جديد.
- النقاط المعروفة لزمن D1 بتشغيلة: 130 ms (`40823425686` على `8f850ce`) و189 ms (`40830998982` على `0357442`). الـ1400 ms في النقد بلا تشغيلة.

## 3. ما فُعل — بالترتيب
1. **ترحيل `0004_reply_metrics.sql`:** `CREATE TABLE IF NOT EXISTS whatsapp_reply_metrics` (مفتاح فريد `provider_message_id` = معرّف رسالة Meta في
   `whatsapp_messages`؛ `source`, `provider`, `model`, `finish_reason`, `candidate_chars`, `sent_chars`, `truncated`, `truncation_reason`, `max_output_tokens`,
   `created_at`) + فهرس — عبارتان idempotent، المجموع 16. لا نص ولا هاتف.
2. **`workers/celia-edge/reply-metrics.js`:** `classifyReplyTruncation` (قصّ = `MAX_TOKENS` و/أو > 1000 حرف؛ `SAFETY` وغيرها ليست قصًّا)، `recordReplyMetric`
   (لا يرمي؛ `INSERT OR IGNORE`؛ `{ok:false, reason}` عند `d1_not_bound`/`missing_fields`/`missing_counts`/`metrics_write_failed`)، `summarizeReplyMetrics`
   (نافذة 1–365 يومًا؛ `truncatedRatio: null` عند صفر ردود؛ بحسب السبب وبحسب المزوّد/المصدر؛ `maxCandidateChars`؛ `lastAt`).
3. **`runtime.js`:** `EDGE_MAX_OUTPUT_TOKENS = 220` ثابتًا مصدَّرًا؛ النتيجة تحمل `finishReason`/`truncated`/`truncationReason`/`candidateChars`/`sentChars`/`maxOutputTokens`؛
   الرد المحلي `truncated:false`, `maxOutputTokens:null`؛ الويبهوك يسجّل الصف بعد نجاح `callMetaSendText` بمعرّف `wamid` (`recordEdgeReplyMetric`).
4. **`worker.js`:** `/api/ai/reply` يسجّل تحت `source: api` بمعرّف `api:<uuid>` ويعيد `metricRecorded`؛ مسار جديد `GET /api/whatsapp/reply-metrics?days=`
   (البادئة محمية بالرمز؛ 503 `d1_not_bound` بلا قاعدة؛ يرفق `maxOutputTokens`, `charCap`, `decision: DEC-050`).
5. **Express:** `src/reply-metrics.js` (نسخة المصنّف — اختبار تكافؤ)، `generateWhatsAppReplyDetailed` + `GEMINI_MAX_OUTPUT_TOKENS = 180`؛ `generateWhatsAppReply`
   يعيد `.text` كما كان؛ `generateCeliaReply` يعيد `truncation`. لا تخزين دائم في Express (MySQL غير حي — HOST-003).
6. **`scripts/verify-live.mjs`:** `--d1-samples` (افتراضيًا 5؛ حدود 2–20)؛ فحص `d1_latency_series` بعد `ready_durable` (`latencyMs[]`, `minMs/medianMs/maxMs`,
   `spreadRatio`, `roundTrip`, `durableAll`؛ يفشل بـ`latency_not_reported` أو `not_durable_in_series` فقط؛ لا عتبة)؛ فحص `edge_reply_metrics` (يمرّ على 200 + `ok` +
   أعداد صحيحة + `decision`؛ يُتخطّى بلا رمز)؛ على `GITHUB_ACTIONS=true` سطر `::error title=verify-live <id>::<id> (<reason>) — <title>` لكل فحص فاشل.
7. **الوثائق:** `docs/service-reality.md` §«أرقام مقاسة» (صفّان بتشغيلة، صفّان «لم تُقَس بعد»)، DEC-050، الخطة (§WP-1.4 ✅ + سطر التقدم + صف المخاطر)،
   BACKLOG AGENT-008، CHANGELOG، STATE، هذا السجل.
8. **الاختبارات:** `test/edge-reply-metrics.test.js` RM-01..06؛ `test/verify-live.test.js` فحصان جديدان (سلسلة 130/1400/150/160/140 → وسيط 150، أقصى 1400،
   `spreadRatio` 9.33، 6 استدعاءات `/readyz`؛ بلا رمز → `skipped` للفحصين المحميَّين؛ عامل بلا `latencyMs` → `latency_not_reported`؛ مسار غائب → 404) +
   `::error` يسمّي `ready_durable` على الخادم الوهمي؛ `test/deploy-cloudflare-edge.test.js` 14 → 16؛ `test/service-reality.test.js` بوابة «أرقام مقاسة».

## 4. الدليل (محليًا، قبل الدفع)
- `GITHUB_ACTIONS=true npm run -s test:coverage:ci` → **589/589**، تغطية **91.55 / 74.77 / 86.00** (الحد 89/71/82)؛ `reply-metrics.js` 100% أسطر في النسختين.
- `node scripts/check.mjs` → 152 ملفًا · `npm run check:continuity` → 60 وثيقة/170 رابطًا/74 مهمة ✅ · `npm run check:secrets` ✅ (التشغيل الأول بعد التغطية
  خرج 1 كما هو معروف، والثاني 0).
- ما **لم** يُقَس هنا ولا يمكن: السلسلة الحية ونسبة القصّ الحية (الصندوق لا يبلغ `workers.dev`؛ الجدول يُنشأ بأول رفع بعد الدمج). الجدولان في «أرقام مقاسة»
  يقولان «لم تُقَس بعد» صراحةً، والاختبار يمنع كتابة رقم فيهما بلا تشغيلة.

## 5. ما يحتاج المالك
- فتح PR لهذا الفرع (رسالة المنصة أو كلمته) ثم «ادمج»؛ بعد الدمج: قراءة `d1_latency_series` و`edge_reply_metrics` من تشغيلة `Cloudflare Edge` الأولى
  ونسخهما إلى «أرقام مقاسة» (أو الطلب مني في الجلسة التالية).
- ما زال مفتوحًا من قبل: سبب فشل التحقق الحي في `40830998982` (الأثر على تخزين لا يبلغه الصندوق) — مع هذه الحزمة ستسمّي التشغيلة التالية فحصها الفاشل بنفسها.

## 6. قرارات صغيرة مسجَّلة هنا
- «مع الرسالة» تحقق بربط `provider_message_id` لا بعمود في `whatsapp_messages` (الترحيلات تُعاد كلها في كل رفع).
- `truncatedRatio: null` عند صفر ردود — الصفر الكاذب ادعاء.
- لا عتبة على سلسلة D1 قبل توزيع حقيقي (DEC-045).
- المصنّف نسختان متطابقتان (`src/`، `workers/`) بحكم حدود النشر، واختبار التكافؤ هو العقد بينهما.
