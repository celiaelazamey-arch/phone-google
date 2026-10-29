# الحالة الحالية — ابدأ من هنا

> **حفظ التاريخ بلا حذف (`DEC-052` / `CONT-004`):** هذه نافذة الاستئناف النشطة؛ السجل التراكمي الكامل حتى ما بعد PR #84 (`main@738d832` / `9f6f8b2` — 983 سطرًا / 142,150 بايت) محفوظ حرفيًا في **[STATE-ARCHIVE-2026-10.md](STATE-ARCHIVE-2026-10.md)** وبصمته محروسة بـ`R0-02`. القراءة السريعة المشتقة: **[NOW.md](NOW.md)** (`npm run now`).

**آخر مراجعة:** 29 أكتوبر 2026 · **نوع الجلسة الحالية:** **MANUS-B3 + إنقاذ A4 + الخيوط العنكبوتية** على `arena/a3caa0c8-phone-google` (أُضيفت فوق شريحة B2 في PR #92 نفسه بقرار تشغيلي معلن)؛ ثلاث جبهات: **(1) A4 أُنقذ من PR #90 المتعارض** بإعادة تطبيقه فوق main الحالي (`model-router.js` + MR-01..10 = 10/10؛ #90 يُغلق بعد الدمج)؛ **(2) B3 قوالب مخرجات حتمية** (`output-templates.js` دوال نقية مهرَّبة بصفر طلبات خارجية + أداة `template.render` فوق مخزن B2 + بوابة `eval:templates` الذهبية **PASS 3/3** ببصمات مثبتة في `data/eval/b3-templates/golden.json` — بوابة مستقلة عن `eval:ai` المجمّد عمدًا، و`eval:ai` أُعيد تشغيله PASS 120/120) 6/6 اختبارات؛ **(3) قارئ العنكبوت** (`spider-reader.js` read-only صفر شبكة، مرآة حرفية لدلالات `celia_spider` في التطبيع والترتيب والدرجة، أداتا قراءة خلف `CELIA_AGENT_SPIDER=read` والافتراضي `off` وفهرس غائب يُفشل الإقلاع) 5/5؛ الحزمة **745 اختبارًا، 729 ناجحًا، 0 فشل** وتغطية 91.11/75.82/87.18، و56/56 تحت بيئة التكامل. سجل الجلسة: [2026-10-29-manus-b3-templates-a4-spider](sessions/2026-10-29-manus-b3-templates-a4-spider.md) ·

**الجلسة السابقة:** **MANUS-B2 — مخزن artifacts المواجه للمالك + التنزيل الموقّع (S4 / M-B)** على `arena/a3caa0c8-phone-google` (من `main@5c2a75b` بعد دمج PR #91/B1)؛ تنفيذ صف B2: `src/agent/artifact-store.js` (نشر متحقق SHA-256 قبل أي كتابة، رابط HMAC منتهي الصلاحية هو التفويض كله، إعادة حساب البصمة عند كل تنزيل → `artifact_tampered` 409، idempotency بمفتاح `(run_id, source_artifact_id)` في قاعدة البيانات)، جدول `agent_artifacts` (ترحيل `0006` إضافي + SQLite)، دليل `artifact_published` في السلسلة، أداة `artifact.create` مشروطة بالمنفّذ والمخزن معًا (`internalWrite`+`settledFailures`)، مسارا `/runs/:id/artifacts` (توكن) و`/artifacts/:id/download` (قبل `authorize` عمدًا — التوقيع هو التفويض)، وقسم «الملفات الناتجة» بزر تنزيل في `/agent`؛ `test/agent-artifact-store.test.js` **9/9** (ART-08 عبر HTTP حقيقي؛ ART-09 تكامل حقيقي بعزل namespaces فعلي خلف `CELIA_SANDBOX_INTEGRATION=1`) وثلاثي العزل 35/35؛ الحزمة 707 ناجحًا والتغطية 90.75/75.76/87.01؛ الفشل البيئي الوحيد (N/N-1) كما هو؛ **PR #90 (A4) مفتوح ومتعارض مع `main` بعد دمج #91 — بانتظار قرار المالك**. سجل الجلسة: [2026-10-29-manus-b2-artifact-store](sessions/2026-10-29-manus-b2-artifact-store.md) ·

**الجلسة السابقة:** **MANUS-B1 — `sandbox.exec` موصول بالحلقة (S4 / M-B)** على `arena/94838d66-phone-google` (من `main@a2879dd` بعد دمج PR #89)؛ تنفيذ صف B1: محوّل فعلي في `defaultToolDefinitions({ sandbox })` يستدعي منفذ AGENT-003 (`sandbox.run`) خلف بوابة `CELIA_AGENT_SANDBOX=exec` حصرًا (الافتراضي `off` يُبقي التعريف الرافض حرفيًا والقيمة غير الصالحة تُفشل الإقلاع)، `settledFailures` يسجل فشل العزل `failed` مستقرًا يحجبه المُتحقِّق **بلا أي host fallback**، سقف workspace بالسياسة 256MiB (الافتراضي 8MiB بلا تغيير) ومفاتيح `CELIA_SANDBOX_*` للضبط، والنتائج artifacts مبصومة SHA-256 حصرًا؛ `test/agent-sandbox-tool.test.js` **9/9** (منها SBX-09 تكامل حقيقي كامل الحلقة: CSV→حساب→`result.json` عبر `readArtifact` وسلسلة أدلة سليمة) + Sandbox القائم 17/17 = 26/26؛ الحزمة 699 ناجحًا والتغطية 90.72/75.84/86.93؛ الفشل البيئي الوحيد (N/N-1) كما هو؛ PR #90 (A4) ما زال مفتوحًا بانتظار المالك. سجل الجلسة: [2026-10-29-manus-b1-sandbox-exec](sessions/2026-10-29-manus-b1-sandbox-exec.md) ·

**الجلسة السابقة:** **MANUS-A3 — `call_many` للقراءات المستقلة** على `arena/718068f3-phone-google`؛ تنفيذ صف A3 من خطة «منافس مانوس»: إجراء `call_many` في `PROVIDER_PLAN_SCHEMA` (خاصية `calls` اختيارية تحفظ التوافق الخلفي حرفيًا) وفرع runtime بتحقق **ذري** على الدفعة كلها قبل بدء أي toolRun (`call_many_requires_read_tools`/`call_many_batch_too_large`/`unknown_tool`/`planner_tool_not_allowed`/كود المدخلات/`step_budget_exhausted` — صفر تنفيذ جزئي وصفر موافقات وصفر outbox)، إطلاق متوازٍ بسقف بنيوي ≤ 4 وتسوية بترتيب الدفعة، و`call_many_after_failure` يمنع الدفعة كوسيلة استعادة (الاستعادة حصرًا عبر مراجعة A2 — التركيب مثبت CM-07)؛ `test/agent-call-many.test.js` **12/12** ومعيار القبول مقاس: **p50 لمهمة 5 قراءات انخفض 57.9%** (428ms←180ms بطوابع WP-1.1)؛ التغطية 90.75/75.88/86.91؛ الفشل البيئي الوحيد (N/N-1) كما هو. سجل الجلسة: [2026-10-29-manus-a3-call-many](sessions/2026-10-29-manus-a3-call-many.md) ·

**الجلسة السابقة:** **آخر مراجعة:** 29 أكتوبر 2026 · **نوع الجلسة الحالية:** **MANUS-A2 — إعادة التخطيط المحكومة `plan.revised`** على `arena/718068f3-phone-google`؛ بتوجيه هندسي صريح من المالك: `src/agent/replanner.js` (maxPerStep=1 + حارس حلقة maxPerRun=1، قراءة فقط، عدّ حتمي من خطوات السلسلة)، توصيل `revisionPolicy` في `createProviderPlanner` (الافتراض null يحفظ `automatic_replan_disabled` حرفيًا)، تسجيل `plan.revised` في سلسلة SHA-256، `max_replan_exceeded`/`replan_requires_read_tool` ضمن التحويل المرئي، وتضييق `goal_contract` في المُتحقِّق لفشل القراءة المستدرَك بمراجعة ناجحة حصرًا؛ `test/agent-replan.test.js` **9/9** بالطفرتين السلبيتين الإلزاميتين؛ التغطية 90.71/75.70/86.88؛ الفشل البيئي الوحيد (N/N-1) كما هو. سجل الجلسة: [2026-10-29-manus-a2-governed-replan](sessions/2026-10-29-manus-a2-governed-replan.md) ·
**الشريحة السابقة (MANUS-A1):** اعتماد خطة «منافس مانوس» وتنفيذ شريحتها الأولى على `arena/718068f3-phone-google`؛ المالك اعتمد [خطة منافس مانوس](../manus-competitor-plan.md) نصًا، ونُفِّذ الشق الهيكلي لـA1: `CELIA_AGENT_PLANNER=gemini` خلف علم (الافتراضي `demo` بلا تغيير)، محوّل `src/agent/gemini-planner-provider.js`، و`planner_fallback` حتمي مرئي (`src/agent/planner-fallback.js` + خطوة ودليل BLOCK في runtime)؛ `test/agent-gemini-planner.test.js` **24/24** بلا شبكة، الحزمة 670 ناجحًا والتغطية 90.67/75.62/86.79 فوق الأرضية؛ فشل واحد معروف بيئيًا (N/N-1 يحتاج كائن Git تاريخيًا غير موجود في الاستنساخ المضغوط — ثبت على خط الأساس النظيف). لا تشغيل Gemini حي ولا نشر ولا ترحيل؛ التشغيلة الحية المعزولة قرار مالك. سجل الجلسة: [2026-10-29-manus-a1-gemini-planner](sessions/2026-10-29-manus-a1-gemini-planner.md) ·
**الجلسة السابقة (GOOG-005):** Google read-only ضمن حدود 2026 على `arena/d44070e0-phone-google`؛ تنفيذ محلي/Mock لقراءات Gmail وDrive وCalendar وContacts عبر `CELIA_AGENT_CONNECTORS=google_read`، بلا OAuth حي أو scopes جديدة أو كتابة خارجية أو ربط Sandbox بـRuntime. Drive يعرض metadata لأحدث 10 ملفات، وCalendar نافذة محدودة، وContacts صفحة محدودة، مع planner حتمي يفصل القراءة عن create/export. نجح `test/agent-google-read.test.js` **8/8**، والفحص المشترك **28/28**، و`npm run test:coverage` **647/661 ناجحًا، 0 فشل، 14 skipped** بتغطية **90.70% أسطر / 75.45% فروع / 86.90% دوال**؛ لا اتصال Google حي ولا ادعاء ظهور بيانات المالك أو جاهزية إنتاجية ·
**الشريحة السابقة:** PR `#87` دُمج، ونقطة بدء هذه الجلسة `b29d77f`؛ Sandbox السابق **17/17** وGmail السابق **7/7** محفوظان في سجليهما، ولا يُستأنف تفعيلهما أو نشرهما تلقائيًا ·
سجل الجلسة الحالي: [2026-10-29-google-readonly-2026](sessions/2026-10-29-google-readonly-2026.md) ·
سجل Sandbox السابق: [2026-10-29-agent003-sandbox](sessions/2026-10-29-agent003-sandbox.md) ·
سجل KB السابق: [2026-10-29-ai002-kb-governance](sessions/2026-10-29-ai002-kb-governance.md) ·
سجل Drive السابق: [2026-10-29-drive-selective-import](sessions/2026-10-29-drive-selective-import.md) ·
سجل AI-002 السابق: [2026-10-29-ai-002-planner-provider](sessions/2026-10-29-ai-002-planner-provider.md) ·
سجل WP-2.4/AI-001 السابق: [2026-10-29-wp-2-4-ai-001](sessions/2026-10-29-wp-2-4-ai-001.md) ·
سجل WP-2.3 المحلي: [2026-10-29-wp-2-3-agent-memory](sessions/2026-10-29-wp-2-3-agent-memory.md) ·
سجل R0 المدمج في `main@922ed4e`: [2026-10-29-r0-continuity-2026](sessions/2026-10-29-r0-continuity-2026.md) ·
سجل WP-2.1 المدمج في `main@738d832`: [2026-10-29-wp-2-1-context-policy](sessions/2026-10-29-wp-2-1-context-policy.md) ·
سجل WP-1.4: [2026-10-29-wp-1-4-measurements](sessions/2026-10-29-wp-1-4-measurements.md) ·
سجل WP-1.3: [2026-10-29-wp-1-3-theme-tokens](sessions/2026-10-29-wp-1-3-theme-tokens.md) ·
سجل WP-1.2: [2026-10-29-wp-1-2-execution-trace](sessions/2026-10-29-wp-1-2-execution-trace.md) ·
الأرشيف التاريخي الكامل: [STATE-ARCHIVE-2026-10.md](STATE-ARCHIVE-2026-10.md)

## 1. خط الأساس المتحقق (`b29d77f`)

- **بداية جلسة GOOG-005:** الفرع `arena/d44070e0-phone-google` بدأ من `b29d77f` (Merge PR `#87`) بشجرة نظيفة؛ لم يُفتح PR جديد ولم يحدث نشر أو ترحيل في هذه الشريحة.
- **آخر دمج موثق قبل هذه الجلسة:** PR `#85` (R0 / CONT-004 / DEC-052) دُمج بكلمة المالك إلى `main@922ed4e`؛ تشغيلات `main` الست خضراء، والجودة `40846567368` سجلت `602/602`. الحافة والواجهة الثابتة و`v0.2.1` منشورة كما في سجل R0؛ Express + MySQL (`HOST-003`) غير منشور.
- **طلبات السحب المفتوحة عند خط الأساس:** صفر. لم تُقرأ حالة GitHub الحية مجددًا في جلستي WP-2.3/WP-2.4، ولم يُفتح PR من هذا الفرع.
- **قاعدة التوافق:** إصدار `0.2.1` ومخطط التطبيق الأساسي `schema=1` بلا تغيير؛ جداول الوكيل وترحيلاتها مستقلة وإضافية. ملفات التقييم والتقرير لا تغيّر عقود HTTP أو المخطط.

## 2. ما نُفِّذ سابقًا في هذه السلسلة — WP-2.4 / AI-001

- **مجموعة ثابتة:** `data/eval/ai-001/cases.jsonl` فيها 120 حالة فريدة، بصمتها `687cb6ffda8b271de5cfbc745bf204bc30db491128dacf752e92c241e5e15944`؛ فصحى ومصرية، Cairo، أوقات نسبية وصريحة، جهات اتصال ومدد، سياق متعدد الأدوار، نقص/تعارض/حقن، موافقة، تكرار وفشل مزود و`unknown`.
- **مشغّل حتمي بلا شبكة:** `npm run eval:ai` يستخدم مستخرج `src/agent/ai-eval-parser.js` والحلقة والموافقات وoutbox وموصل Calendar والمُتحقق والأدلة الحقيقية على SQLite مؤقت؛ النقل وحده وهمي. يختار آخر رسالة `user` من الخيط، ولا يمرر `expected` إلى المستخرج.
- **تقرير قابل للفحص:** [reports/ai-001.json](../../reports/ai-001.json) يسجل لكل حالة القرار والمسودة والحمولة المعروضة وقرار المالك ومفتاح idempotency ومرجع الحدث وطلبات المزود وسلسلة الأدلة. القرارات البشرية مبرمجة في السيناريوهات، وليست مراجعة بشرية فعلية.
- **البوابة والنتيجة:** الحدود ثُبتت قبل التشغيل في [docs/agent-ai-evaluation.md](../agent-ai-evaluation.md). النتيجة الأخيرة PASS: 120/120 حالة، 109/109 موعدًا مؤهلًا (100%)، p50=22.009ms، p95=33.283ms، تدخل إضافي 5%، صفر تكرار/كتابة غير مصرح بها/إعادة عمياء، و`unknown` 2/2 إلى مصالحة. التكلفة `null` لغياب مزود قابل للقياس.
- **المراجعة البشرية المكتملة:** [عينة المراجعة](../../reports/ai-001-human-review.sample.json) أصبحت `completed_owner_review` بعد 20 قرار مالك فعليًا واحدًا واحدًا: 19 `approved` و1 `rejected` و0 `needs_clarification`؛ `reviewSummary.acceptanceRate=0.95` أي **95%**. الرفض `AI-001-0107` وسببه «معالجة التكرار غير مقبولة». تحقق فحص مستقل من تطابق المخرجات العشرين مع التقرير المجمد وبصمته `11a1f164587d2dc4ccf31de98cfe2346931f153805516b13f04b2e34f336af65` ومن وجود سبب للرفض؛ لم تتغير الأدلة.
- **التحقق المتبقي:** وفق تأكيد المالك، **المفتاح موجود كـRepository secret، لكنه غير مهيأ للتنفيذ المحلي و/أو غير مُمرر في workflow التقييم الحالي؛ لذلك لم يُنفذ قياس حي.** لم تُكتب أحداث Calendar حقيقية ولم تُسجل تكلفة. يبقى AI-001 `جارٍ` إلى التشغيل الحي المعزول، ولا تُستنتج جاهزية المستخدمين من نسبة قبول العينة.
- **الاختبارات:** `AI-EVAL-01..08` ناجحة 8/8 بعد التعديل الأخير؛ تغطي البوابتين السلبيتين وإعادة الإنتاج وطفرات تفشل حدود الجودة والزمن والتدخل والسلامة. الفحص الشامل الختامي **615/615** بتغطية **91.90% أسطر / 75.32% فروع / 87.09% دوال**؛ ونجح فحص 160 ملف JavaScript وبناء 12 صفحة وفحص 12 أداة MCP وبوابات الإصدار والاستمرارية والأسرار.

## 3. WP-2.3 المتراكمة على الفرع نفسه

- `0005_agent-memory.sql` و`src/agent/memory.js` والمخزن والحلقة ومسارات `GET/DELETE /api/agent/memory` وقسم `/agent` تنفذ ذاكرة حتمية مملوكة بلا نموذج أو متجهات، مع فحص أسرار وحذف نهائي ودليل `memory_deleted`.
- قبول MySQL المحدّث واختبار Playwright موجودان، لكن خدمة MySQL المعزولة وChromium غير متوفرين في الصندوق؛ لم يُدّعَ نجاحهما. [خطة النشر](../agent-memory-deployment.md) توثيق مستقبلي فقط، ولا ترحيل إنتاج أو نشر منفّذ.
- التفاصيل والنتيجة 607/607 الخاصة بتلك المرحلة محفوظة في [سجل WP-2.3](sessions/2026-10-29-wp-2-3-agent-memory.md) و`DEC-053`؛ لا تُخلط مع بوابة AI-001 المستقلة.

## 4. تقدّم الخطة والخطوة التالية

- **الخطوة 1:** WP-1.1/WP-1.2/WP-1.3/WP-1.4 مدمجة؛ **WP-2.1** مدمجة في `main@738d832`.
- **على فرع الجلسة فقط:** WP-2.3 وWP-2.4 منفّذتان محليًا وموثقتان بـDEC-053/DEC-054؛ لم تُدمجا أو تُنشرا.
- **على فرع الجلسة الآن:** AGENT-003 Backend موثق في [سجله](sessions/2026-10-29-agent003-sandbox.md) و[دليل التشغيل](../agent-sandbox.md): 17/17 اختبارات عزل حقيقية، Artifact وEvidence، وحدود تدقيق صريحة. لم يُربط بـRuntime ولم يُنشر، و`sandbox.exec` وComputer Use ما زالا غير مفعّلين.
- **GOOG-004 محلي/Mock:** `google.gmail_read` في `src/agent/gmail.js` يعيد آخر 1–5 رسائل بmetadata ومقتطف ≤500 حرف عبر OAuth المشفر القائم؛ الافتراضي `none`، ولا send/outbox/body/attachments. الاختبار 7/7 والفحص المشترك 56/56؛ لا Gmail حي ولا قرار تفعيل تلقائي. التفاصيل في [سجل Gmail](sessions/2026-10-29-gmail-read-connector.md).
- **GOOG-005 محلي/Mock:** `google_read` في `src/agent/index.js` يفعّل الأربعة قرّاء فقط؛ التفاصيل والعقود في [سجل الجلسة](sessions/2026-10-29-google-readonly-2026.md) و[حدود 2026](../google-readonly-2026.md). النتيجة 8/8 و647/647 غير المتخطى في التغطية الكاملة؛ لا اتصال حي، و`calendar.events` يبقى أوسع من read-only على مستوى المنح.
- **التالي بعد الشريحة:** لا تشغيل Google حي أو توسعة Sheets/Docs/YouTube/Photos ضمن هذا العمل؛ أي قبول حي قرار لاحق صريح ومعزول. تبقى مراجعة ربط/نشر Sandbox وإعادة التخطيط المحدودة مستقلة، ولا أدوات ملفات/Shell/Git/Computer Use تلقائيًا. لا R1 ولا MCP-001/002 ولا `gh-aw` ولا embeddings أو توجيه نماذج ضمن هذا العمل.

## 5. العوائق وحدود الدليل

1. **دليل AI-001 محلي فقط:** لا يثبت جودة Gemini/نموذج حي أو اتصال Google/Calendar أو تكلفة أو SLO إنتاجيًا أو مراجعة بشرية فعلية. أزمنة التقرير لمحاكاة حتمية على SQLite وليست قياس إنتاج.
2. **MySQL:** لا خدمة معزولة متاحة؛ قبول `0005` مضاف لكنه لم يُشغّل، ولا ترحيل إنتاج أو Aiven.
3. **Chromium:** executable غير مثبت؛ اختبار WP-2.3 في `e2e/agent.spec.js` لم يُقبل بصريًا في هذا الصندوق.
4. **قرارات المالك القائمة:** Branch protection وCodeQL/Secret scanning (`SEC-006`)، وربط Google/Meta وRender/Aiven (`GOOG-001`/`WA-005`/`HOST-003`)، ومزوّد التخطيط (`GOV-001`/`AI-002`) خارج هذه الحزمة.

## 6. الاستئناف والفحوص

1. ابقَ على `arena/d44070e0-phone-google`؛ راجع [سجل GOOG-005](sessions/2026-10-29-google-readonly-2026.md) و[سجل Gmail](sessions/2026-10-29-gmail-read-connector.md) و[سجل AGENT-003](sessions/2026-10-29-agent003-sandbox.md). لا تفتح/تدمج PR ولا ترحّل أو تنشر أو تفعل مزودًا حيًا إلا بتفويض لاحق صريح.
2. كل معرفة جديدة تحتاج `claim_type` و`review_due`؛ السجل التاريخي/غير المتحقق/المهجور أو المنتهي لا يُستخدم كتوجيه Planner. `kb.search` قراءة محلية فقط، ونتيجتها تُسجل في الأدلة.
3. لا تُستأنف أدوات التنفيذ من خارطة Drive؛ نجاح Backend AGENT-003 لا يفتح Shell/Git/Computer Use ولا يربط `sandbox.exec` تلقائيًا. قراءة Drive الجديدة metadata فقط؛ لا استيراد/كتابة/حذف ولا embeddings.

```sh
git branch --show-current && git status --short && git log -3 --oneline
npm run kb:manifest && npm run kb -- verify
node --test test/knowledge-governance.test.js test/agent-kb-planner.test.js test/agent-verifier.test.js
npm run test:sandbox
node --test test/agent-gmail.test.js
node --test test/agent-google-read.test.js
npm run check && npm run now:check && npm run check:continuity && npm run check:secrets
```
