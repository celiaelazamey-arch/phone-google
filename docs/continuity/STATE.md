# الحالة الحالية — ابدأ من هنا

> **حفظ التاريخ بلا حذف (`DEC-052` / `CONT-004`):** هذه نافذة الاستئناف النشطة؛ السجل التراكمي الكامل حتى ما بعد PR #84 (`main@738d832` / `9f6f8b2` — 983 سطرًا / 142,150 بايت) محفوظ حرفيًا في **[STATE-ARCHIVE-2026-10.md](STATE-ARCHIVE-2026-10.md)** وبصمته محروسة بـ`R0-02`. القراءة السريعة المشتقة: **[NOW.md](NOW.md)** (`npm run now`).

**آخر مراجعة:** 29 أكتوبر 2026 · **نوع الجلسة الحالية:** **AGENT-003 Sandbox Backend + GOOG-004 Gmail read-only** على `arena/0b72e456-phone-google`؛ عزل Linux حقيقي محلي وموصل Gmail محلي/Mock فقط، بلا Drive أو Gemini أو Gmail حي أو كتابة خارجية أو ربط Sandbox بـRuntime. أُضيف منفذ namespaces/chroot/rlimits بسياسة default-deny، mounts منفردة، UID/GID=1001، Capabilities صفرية، workspace tmpfs محدود، إتلاف descendants والجذر، وArtifact بSHA-256/TTL وEvidence. نجح `npm run test:sandbox` **17/17**، و`test/agent-gmail.test.js` **7/7** مع فحص مشترك **56/56**، و`npm run test:coverage` **639/653 ناجحًا، 0 فشل، 14 skipped** بتغطية **90.61% أسطر / 75.42% فروع / 86.73% دوال**؛ لا اتصال Gmail حي ولا تفعيل `sandbox.exec` أو جاهزية إنتاجية ·
**الشريحة السابقة:** حوكمة KB/AI-002 محفوظة في commit `2a78ce8` على هذا الفرع؛ نتائجها الحتمية 629/629، وAI-001 والتشغيل الحي ما زالا غير مغلقين ·
سجل الجلسة الحالي: [2026-10-29-gmail-read-connector](sessions/2026-10-29-gmail-read-connector.md) ·
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

## 1. خط الأساس المتحقق (`main@922ed4e`)

- **آخر دمج موثق:** PR `#85` (R0 / CONT-004 / DEC-052) دُمج بكلمة المالك إلى `main@922ed4e`؛ تشغيلات `main` الست خضراء، والجودة `40846567368` سجلت `602/602`. الحافة والواجهة الثابتة و`v0.2.1` منشورة كما في سجل R0؛ Express + MySQL (`HOST-003`) غير منشور.
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
- **التالي بعد الشريحة:** مراجعة مستقلة لقرار ربط/نشر Sandbox، ثم إعادة تخطيط محدودة للفشل الداخلي وفق الترتيب المعتمد؛ لا أدوات ملفات/Shell/Git/Computer Use تلقائيًا بسبب نجاح الـBackend. لا R1 ولا MCP-001/002 ولا `gh-aw` ولا embeddings أو توجيه نماذج ضمن هذا العمل. لا تُفعّل مواد Drive كودًا أو قدرة تلقائيًا.

## 5. العوائق وحدود الدليل

1. **دليل AI-001 محلي فقط:** لا يثبت جودة Gemini/نموذج حي أو اتصال Google/Calendar أو تكلفة أو SLO إنتاجيًا أو مراجعة بشرية فعلية. أزمنة التقرير لمحاكاة حتمية على SQLite وليست قياس إنتاج.
2. **MySQL:** لا خدمة معزولة متاحة؛ قبول `0005` مضاف لكنه لم يُشغّل، ولا ترحيل إنتاج أو Aiven.
3. **Chromium:** executable غير مثبت؛ اختبار WP-2.3 في `e2e/agent.spec.js` لم يُقبل بصريًا في هذا الصندوق.
4. **قرارات المالك القائمة:** Branch protection وCodeQL/Secret scanning (`SEC-006`)، وربط Google/Meta وRender/Aiven (`GOOG-001`/`WA-005`/`HOST-003`)، ومزوّد التخطيط (`GOV-001`/`AI-002`) خارج هذه الحزمة.

## 6. الاستئناف والفحوص

1. ابقَ على `arena/0b72e456-phone-google`؛ راجع [سجل Gmail](sessions/2026-10-29-gmail-read-connector.md) و[سجل AGENT-003](sessions/2026-10-29-agent003-sandbox.md). لا تفتح/تدمج PR ولا ترحّل أو تنشر أو تفعل مزودًا حيًا إلا بتفويض لاحق صريح.
2. كل معرفة جديدة تحتاج `claim_type` و`review_due`؛ السجل التاريخي/غير المتحقق/المهجور أو المنتهي لا يُستخدم كتوجيه Planner. `kb.search` قراءة محلية فقط، ونتيجتها تُسجل في الأدلة.
3. لا تُستأنف أدوات التنفيذ من خارطة Drive؛ نجاح Backend AGENT-003 لا يفتح Shell/Git/Computer Use ولا يربط `sandbox.exec` تلقائيًا. لا توسيع Drive ولا embeddings الآن.

```sh
git branch --show-current && git status --short && git log -3 --oneline
npm run kb:manifest && npm run kb -- verify
node --test test/knowledge-governance.test.js test/agent-kb-planner.test.js test/agent-verifier.test.js
npm run test:sandbox
node --test test/agent-gmail.test.js
npm run check && npm run now:check && npm run check:continuity && npm run check:secrets
```
