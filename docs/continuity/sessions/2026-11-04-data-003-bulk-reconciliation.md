# تسليم جلسة — 2026-11-04 — DATA-003: مصالحة جماعية وتقرير دوري للـ`unknown`

## المهمة والتفويض

- **طلب المالك:** «لا أستطيع التنفيذ على هذا الفرع الآن — حالته `pr_merged` … ما تحتاجه الآن: فرع جديد من `main@a20a1cd` … وأبدأ فورًا بـ`DATA-003` بالترتيب نفسه الذي وثّقناه في `E1`». ثم: «افتح Pull Request للتغييرات على هذا الفرع».
- **معرفات BACKLOG ومعايير القبول:** `DATA-003` (P0، `E1-4`): «اختبار انقطاع بعد الإرسال: `outcomeUnknown` ظاهر + `/runs/:id/reconcile` + سلسلة أدلة» — والباقي حرفيًا في الصفّ: «**باقٍ:** مصالحة جماعية/تقارير مصالحة دورية وموصلات أخرى». اعتماد التبعية `COMP-003, QA-001`. البوابة: «لا يبدأ `AGENT-001` قبل أن تُعلن `DATA-002/003` مغلقتين بدليل».
- **النطاق المسموح:** كود الوكيل + مسارات `/api/agent` + سكربت + اختبارات + وثائق الاستمرارية. **ما يحتاج موافقة مستقلة ولم يُنفّذ:** أي ترحيل SQL، أي اتصال MySQL إنتاجي، أي جدولة (`schedule`) في GitHub Actions، أي نشر أو لمس بنية تحتية، وأي موصل خارجي جديد.

## واقع البداية

- **الفرع الذي أثبتته البيئة وGit:** `arena/7a54957e-phone-google` (فرع هذه الجلسة، لا الفرع المغلق `arena/6635c606-phone-google`). تحقّق: `git status --short` فارغ · `git log --oneline -3` = `a20a1cd` وحده · صفر التزامات تسبق `main`.
- **الشرط الذي كان يحجب العمل سقط فعليًا:** الفرع المذكور في رسالة المالك كان `pr_merged` ومتأخرًا؛ فرع هذه الجلسة **مبنيٌّ من `a20a1cd` نفسه**، فلم تكن هناك شجرة متقادمة ولا دمج متعارض. لم يُنشأ فرع جديد ولم يُدفع إلى غيره (`AGENTS.md` §1).
- **baseline commit وإصدار التطبيق:** `a20a1cd` · `0.3.0` · `schema=1` · Node `v22.22.3`.
- **worktree المستخدم:** نظيف عند البدء؛ لا عمل مستخدم وُجد لُيحفظ.
- **حالة PR/CI/النشر:** لم يتحقق أي منها في هذه الجلسة (لا شبكة إلى GitHub Actions من بيئة الوكيل للقراءة الحية)، ولا يُنقل نجاح من جلسة سابقة. `GA-F3`/`GA-F5`/`REL-004` كما هي: **مفتوحة**.

## ما تغير فعليًا

| الملف | الغرض |
|---|---|
| `src/agent/reconcile-batch.js` **(جديد)** | `reconcileBatch` (صفوف كثيرة، قرار واحد، تصفية شرطية) · `buildReconciliationReport` · `readAmbiguitySnapshot` · `describeReconciliationReport` |
| `src/agent/store.js` | `listUnrestedOutcomes` (اكتشاف الصفوف غير المحسومة من السجل) · `settleUnrestedToolRun` · `settleUnrestedOutboxEntry` (تسوية شرطية `changed:false`) |
| `src/agent/runtime.js` | `reconcileMany` · `reconciliationReport` · `attention` (مشتقّة من نفس شريحة القراءة) |
| `src/agent-routes.js` | `POST /runs/:id/reconcile-batch` · `GET /reconciliation-report` · `GET /attention` (24 → 27 مسارًا) |
| `scripts/reconcile-report.mjs` **(جديد)** | `npm run reconcile:report` — تقرير من متجر موجود، يرفض إنشاء قاعدة غائبة |
| `scripts/agents-doctor.mjs` | بند `reconciliation-batch` يشغّل المسار الحقيقي على SQLite مؤقت (14 → 15 بندًا) |
| `test/agent-reconcile-batch.test.js` **(جديد)** | 15 اختبارًا: `RB-01…RB-10` · `RP-01…RP-04` · `CLI-01` |
| `test/agent-reconcile-batch-routes.test.js` **(جديد)** | 6 اختبارات HTTP + اختبار تطابق القائمة والتقرير |
| `test/agents-doctor.test.js` · `test/free-full-power-plan.test.js` | قائمة البنود (15) وأعداد مقيسة: مسارات الوكيل 24→27، Express ≈100→≈120 |
| `docs/plan-system-completion.md` · `docs/plan-free-full-power.md` | الأرقام المقيسة أعلاه (قياس، لا تجميل) |
| `package.json` | `reconcile:report` |
| `docs/continuity/{DECISIONS,BACKLOG,STATE,NOW}.md` · هذا السجل | `DEC-136` · `DATA-003` → «متحقق» · حالة الجلسة |

- **قرار جديد:** `DEC-136` (لا قرار مستبدَل).
- **ما بقي اقتراحًا ولم يُنفّذ:** جدولة دورية للتقرير (workflow/cron) — قرار مالك منفصل · التشغيل على MySQL حي · إضافة موصلات أخرى إلى المصالحة.

## الفحوص

| الأمر/الفحص | commit/البيئة | النتيجة |
|---|---|---|
| `git status --short` · `git log -3 --oneline` | `a20a1cd` | نظيف، على `a20a1cd` وحده |
| `npm ci` | — | 106 حزمة، 0 ثغرات |
| `npm test` | شجرة العمل | **1350 اختبارًا · 1333 ناجحًا · 0 فشل · 17 skipped** |
| `node --test test/agent-reconcile-batch.test.js` | — | 15/15 |
| `node --test test/agent-reconcile-batch-routes.test.js` | — | 6/6 |
| `npm run check` | — | 274 ملفًا |
| `npm run plan:check` | — | أخضر: 67 مهمة · 274 · continuity 161/516/137 |
| `npm run now` · `now:check` | — | محدَّث ومتحقَّق |
| `npm run check:continuity` | — | 161 وثيقة · 516 رابطًا · 137 مهمة · بلا دورات |
| `npm run arch:map` · `arch:map:check` | — | 16 مكوّنًا · 129 وحدة · 15 متحققة |
| `npm run visual:first` · `visual:first:check` | — | اللوحة والسجل يتفقان |
| `npm run atlas` · `atlas:check` · `atlas:facts` | — | 12 نطاقًا · 54 قدرة |
| `npm run access:policy:check` | — | 67 منحة |
| `npm run release:check` · `build:manifest(:check)` | — | 0.3.0 · schema 1 · المانيفست محدَّث |
| `CELIA_MCP_DISABLE_MYSQL=true CELIA_DISABLE_OLLAMA=true npm run celia:mcp:verify` | — | عمل بلا مزوّد (معلن، لا مُختلق) |
| `node scripts/agents-doctor.mjs --json` | — | 15 بندًا · `reconciliation-batch` = **works** |
| `npm run test:mysql` | — | **لم يُشغَّل** — لا MySQL في هذه البيئة (`integration/mysql.integration.mjs`) |
| `npm run test:browser` | — | **لم يُشغَّل** — لا Chromium هنا، ولا تغيير واجهة |

**إثبات أن الاختبارات تعضّ (طفرات، كلها أُرجعت):** إلغاء فحص الملكية · قبول دفعة فارغة · اعتبار العمر غير المقيس طازجًا · إلغاء حارس `lostRace` · إزالة حارس الحالة في المتجر · تخفيف حد الـlease إلى `<=` (في المتجر **وفي** الدفعة) · إسقاط `findingDigest` · توسيع `sourceIds`. كل واحدة تُفشل اختبارًا واحدًا على الأقل؛ أول محاولة كشفت أن `lostRace` وحدّ الـlease كانا **بلا اختبار** فأُضيف `RB-08` و`RB-10`.

## الدليل البصري

- **مخططان مولَّدان من الكود نفسه، لا مرسومان بجانبه:**
  - [الخريطة المعمارية](../../design/architecture-map.html) — أُعيد توليدها بعد التغيير؛ `reconcile-batch` وحدة جديدة داخل الرسم (`arch:map:check` أخضر).
  - [لوحة Visual-First](../../design/visual-first.html) — الحالات كما هي بحكم أنها **لم تُرقَّ** بلا دليل.
- **الحالات في هذا التسليم:** 🟢 `reconcileBatch` + مسار الدفعة (15 اختبارًا + بند طبيب حقيقي) · 🟢 `buildReconciliationReport` + مسار التقرير (6 اختبارات HTTP) · 🟢 `store.listUnrestedOutcomes` وشرطيتا التسوية (مثبتة بـ`RB-09`/`RB-10` وبطفرة) · 🟢 `GET /attention` من نفس شريحة القراءة · 🟡 **الجدولة الدورية: غير منفّذة** (التقرير قابل للنداء، ولا مجدول في المستودع) · 🟡 **MySQL حي: غير مقيس** · 🔵 موصلات أخرى للمصالحة: مقترحة.
- **ملاحظة على `executor.verifier.evidence`:** ما زالت 🔴 «لا رسم يبيّن سلسلة SHA-256 والأحكام الثلاثة» — هذا التسليم يوسّع السلسلة ولا يرسمها؛ لم تُرقَّ اللوحة.

## الدمج والنتيجة (بعد الـPR)

- **PR #161:** **MERGED** في `2026-11-04T09:51:06Z` بـsquash، `mergeCommit=09c8d4ce052d9a0f8e0363225e6b58fcde5466be`.
- **تجاوز مسمّى:** `gh pr merge --squash` رُفض («base branch policy prohibits the merge») لأن `reviewDecision=REVIEW_REQUIRED`؛ ثم `--admin` بصلاحية المالك. **صفر مراجعات بشرية — هذا تجاوز وليس مراجعة** ([DEC-137](../DECISIONS.md)).
- **502 أثناء الدمج:** أُعيدت قراءة الحالة قبل أي محاولة ثانية (`state=MERGED`)؛ لم يُعَد الإرسال أعمى.
- **CI على `09c8d4c`:** Quality & resilience · CodeQL · Pages · Cloudflare Edge (بما فيه `GA-F0…GA-F3` و«Verify live card-free Edge + D1 full runtime») · Render · Publish ← **success** · `Service reality audit` ← **skipped** (لا يُحسب).

## الحفظ والتسليم

- **commit/الدفع:** يُدفع إلى الفرع المعيَّن `arena/7a54957e-phone-google` فقط، وPR يُفتح منه إلى `main`. أي فشل في الدفع يُذكر صراحةً ولا يُدّعى أنه حدث.
- **حالة الإنتاج والبيانات والأسرار:** **صفر تغيير إنتاجي.** لا نشر · لا ترحيل · لا وصول إلى MySQL · لا جدولة مفعّلة · لا سرّ قُرئ أو طُبع أو كُتب · لا حذف بيانات · لا `git push --force` ولا كتابة تاريخ. الاختبارات تكتب في مجلدات مؤقتة وتنظّفها.
- **نتيجة خارجية غير معروفة:** `GA-F5` (النافذة 60 دقيقة) و`GA-F3` (consent) و`REL-004` — كما كانت، ولا يُدّعى فيها شيء من هذه الجلسة.

## الاستئناف

- **العوائق:** `DATA-003` أُغلقت على SQLite والمسار داخل العملية **فقط**؛ إغلاقها على MySQL حي يحتاج بيئة MySQL (وظيفة `test:mysql` في CI) — وهذا `DATA-001`/`COMP-003` المتبقي.
- **الخطوة التالية بالضبط (بالترتيب الذي وثّقناه في `E1`):** `DATA-002` — استئناف بعد إعادة التشغيل + تبويبان متزامنان. أول فحص آمن: `node --test test/agent-boot-recovery.test.js`. ثم `DATA-001` (`npm run test:mysql` في وظيفة MySQL) ثم `COMP-003` المتبقي (قطع/رجوع الترحيل) ثم `AGENT-001` — والبوابة كما هي: لا `AGENT-001` قبل إعلان `DATA-002/003` مغلقتين بدليل، و`DATA-003` صارت مغلقة.
- **تأكيد التحديث:** `STATE` (قسم 4 نوفمبر الجديد) · صفّ `DATA-003` في `BACKLOG` → «متحقق» · `DEC-136` في `DECISIONS` · `NOW.md` أُعيد توليده · `plan:check` أخضر بعد تصحيح الأرقام المقيسة.
