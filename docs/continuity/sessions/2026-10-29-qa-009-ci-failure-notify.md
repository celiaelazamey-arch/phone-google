# جلسة 29 أكتوبر 2026 — «نعم»: QA-009 (فشل `main` يفتح issue تسمّي الاختبار) + مصفوفة مخاطر الوكيل (DEC-041)

**الفرع:** `arena/02b291bc-phone-google` (فوق `0366942`/`ed03fa4` = إعادة إنشاء PR #71 + DEC-040) · **القاعدة:** `main@c7723be` ·
**القرار:** DEC-041 · **المهمة:** QA-009 · **الوثائق:** `docs/ci-failure-notify.md`، `docs/agent-risk-matrix.md`

## 1. الطلب وكيف قُرئ

المالك ألصق سلسلة من مقترح خارجي: «annotations بدل exit 1» → «وكيل إصلاح ذاتي مستقل (retry حتى الخضرة، رقعة، دمج تلقائي)» →
مصفوفة مخاطر بأربعة أركان (تخطيط، عزل، ذاكرة، إصلاح ذاتي) بحلول «إجماع 90%»، MicroVMs، `max_retries = 3`، rollback تلقائي —
ثم أرفق `src_ops_qa_alert_js.js` و`docs_agent_risk_matrix_md.md` وأجاب «نعم» على سؤال «اعتماد السكربت أو كتابة الوثيقة؟».
قُرئ «نعم» على أنه تفويض بالاثنين **بالشكل المتوافق مع النظام**، لا بالشكل المرفق:

| المرفق | ما فيه | ما فُعل |
|---|---|---|
| `src/ops/qa_alert.js` | يقرأ `logs/execution_trace.log` ويبحث عن `STATUS: FAILED` (لا شيء في المستودع يكتب هذا الملف)؛ لا يسمّي الاختبار؛ يعمل داخل الوظيفة الفاشلة؛ يبحث عن الـissue بالعنوان بين أول 30 issue بلا لصيقة؛ لا تعقيم | **لم يُعتمد** (DEC-030: لا «موكب»). استُبقيت فكرتاه الصحيحتان: الإغلاق الذاتي عند الخضرة و`GITHUB_TOKEN` فقط |
| `docs/agent-risk-matrix.md` (المرفق) | يكرر خلاصتي السابقة مع ثلاثة ادعاءات غير دقيقة: «المُتحقِّق يحكم بحد أدنى للثقة 95%» (لا توجد نسبة في `verifier.js`؛ 95% معيار الخدمات)، «DEC-035 = حفظ الوكيل» (DEC-035 عن D1 على الحافة؛ مخزن الوكيل MySQL/SQLite)، «تم اعتماد `src/ops/qa_alert.js`» | كُتبت نسخة مصحَّحة بإحالات لملفات واختبارات، وبجدول «ما هو غير موجود فعلًا» |

## 2. ما نُفِّذ

- `scripts/ci-failure-notify.mjs` — `--run <id> [--branch main] [--dry-run] [--fixture f.json]`؛ يقرأ عبر `gh api`:
  `actions/runs/{id}` → `…/jobs` → `check-runs/{job}/annotations` للوظائف الفاشلة → أحدث تشغيلة مكتملة على الفرع (حارس
  التجاوز). `classifyRun` (red/green/skip بسبب)، `collectFailures` (اختبارات مسمّاة من `path≠.github`، `coverage threshold`،
  السطر الختامي `node --test`، إسقاط «Process completed with exit code»، إزالة التكرار، الوظائف الصامتة)، `buildIssueBody`
  (علامتا `<!-- qa-009 -->` و`<!-- qa-009 run:<id> -->`، جدول، تغطية، ملخص، روابط الوظائف الصامتة، أمر إعادة الإنتاج، فقرة
  «لا شيء تلقائي»)، `redact()` على كل نص منسوخ، `decide()` (create/comment/close/noop) و`issueRecordsRun` (الجسم + التعليقات).
- `.github/workflows/quality-failure-notify.yml` — `workflow_run` على «Celia quality & resilience» `[completed]` لفرع `main`
  + `workflow_dispatch` (`run_id`، `dry_run` افتراضيًا true)؛ `permissions: contents/actions/checks: read · issues: write`؛
  `concurrency` بلا إلغاء؛ المدخلات تمرّ عبر env لا بالاستبدال في الصدفة؛ actions مثبتة بـSHA؛ لا `npm ci`.
- `test/ci-failure-notify.test.js` — 17 اختبارًا + `test/fixtures/ci-failure-notify/red-run.json` (بشكل الـAPI الحقيقي: وظيفة
  Node بفشل مسمّى مكرر + تغطية + ختامي + exit code، وظيفة Playwright بعنوان فيه `|` وJWT، وظيفة MySQL صامتة، وظيفة ناجحة
  وأخرى متخطّاة)، `gh` وهمي يسجّل الأوامر، ربط نصي بعناوين المُبلِّغ، تثبيت كتلة الصلاحيات حرفيًا.
- `package.json`: `ci:notify`. وثيقتان جديدتان. DEC-041، صف QA-009، CHANGELOG، STATE، هذا السجل.

## 3. الدليل

| ما قيس | النتيجة |
|---|---|
| `node test/ci-failure-notify.test.js` | 17/17 |
| قراءة حية بلا كتابة: `--run 40797023396 --dry-run` (آخر تشغيلة Quality على `main`، بعد دمج PR #72) | `verdict green`، الجسم يحمل `c7723be` ورابط التشغيلة |
| `--run 40798428314 --dry-run` (تشغيلة هذا الفرع) | `skipped — head branch arena/02b291bc-phone-google is not main` |
| `--run 40703187936 --branch arena/3f0d6498-phone-google --dry-run` | `skipped — event pull_request is not push` |
| `--run 40687283608 --branch arena/2edb2881-phone-google --dry-run` | `skipped — superseded by newer completed run 40691045150 (success)` |
| `--run 40673613296 --branch feat/whatsapp-free-first-setup-20261028 --dry-run` (push أحمر قبل DEC-039) | `verdict red, 0 named test(s), 1 failed job(s)` → «Failed without a named test (open the job log)» برابط الوظيفة — الصدق بدل التجميل |
| `--fixture red-run.json --dry-run` | عنوان «2 failing tests»؛ صفّان مسمّيان؛ `ghp_…` وJWT مُعقَّمان؛ `\|` محمية؛ وظيفة MySQL صامتة مدرجة |
| المجموعة الكاملة / `check` / `check:continuity` / CI على الفرع | تُسجَّل أدناه بعد الدفع |

## 4. ما لم يُفعل — عن قصد

- لم تُنشأ أي issue حقيقية: كل التشغيلات الحية `--dry-run`؛ أول كتابة حقيقية تحدث فقط بعد الدمج وعند أول فشل فعلي على `main`.
- لا retry، لا رقعة مولَّدة، لا rollback، لا دمج، لا نموذج لغوي، لا سرّ غير `GITHUB_TOKEN`.
- لم يُفتح PR لهذا الفرع (ينتظر «افتح PR»)؛ #71 و#38 كما هما (DEC-040).
- لم تُنسخ صياغة «ينافس Claude/Manus» إلى أي وثيقة.

## 5. الخطوات التالية (مالك)

1. «افتح PR» لهذا الفرع → بعد الدمج: أول تشغيلة Quality مكتملة على `main` تُطلق «Quality failure notify (main)» — عندها تتحول
   حالة QA-009 إلى «متحقق» برقم التشغيلة (ولو كانت خضراء: `::notice … nothing to do (no open tracking issue)`).
2. اختياري: من Actions، `workflow_dispatch` للـworkflow بمعرّف تشغيلة حمراء قديمة و`dry_run = true` لرؤية الجسم دون كتابة.
3. طبقة «يقترح» (رقعة + PR عبر بوابة الموافقة) تنتظر قرار AI-002/GOV-001 — ليست جزءًا من هذه الجلسة.
