# الوضع الأمني الموثّق — Security posture (SEC-006)

> ما الذي يحمي هذا المستودع **فعلًا** اليوم، وما الدليل، وما الذي يملكه المالك وحده ولا يستطيع الوكيل تفعيله ولا ادعاءه.
> كل سطر هنا إمّا مثبّت باختبار حتمي في `test/security-posture.test.js` (SP-01..SP-12) أو موسوم صراحةً **owner-only** مع
> خطوات التفعيل. لا شيء هنا «مقترح»؛ المقترحات تذهب إلى `docs/continuity/BACKLOG.md`.

- **المصدر:** تحليل خارجي عرضه المالك في 29 أكتوبر 2026 (أربعة مسارات «دفاع في العمق») قوبل بمطابقة بند-بند مع المستودع.
  النتيجة: المسارات موجودة بصيغة أقوى مما اقترحه النص، لكنها كانت **حقائق غير مثبّتة** — أي تغيير لاحق كان يستطيع إضعافها
  بصمت. هذه الوثيقة والاختبار يحوّلانها إلى قيود قابلة للكسر فقط علنًا.
- **ما رُفض من التحليل نفسه:** جسر «استدلال عميق» ببوابة ثقة ثابتة (`confidence: 0.96` ومُتحقِّق يعيد `true` دائمًا) =
  واجهة بلا جوهر بمقياس DEC-030؛ و«محرك تطور ذاتي» يرقّع ويفتح PR تلقائيًا = مخالف لـDEC-041. لم يُبنَ أي منهما.
- **التاريخ:** 2026-10-29 · **الفرع:** `arena/90163669-phone-google` · **الاختبار:** `node --test test/security-posture.test.js`.

## 1) المسارات الأربعة → الدليل → الاختبار

| # | المسار | ما هو موجود (محقَّق يدويًا 2026-10-29) | الدليل في المستودع | الاختبار |
|---|---|---|---|---|
| A1 | أذونات الرمز في Actions | 10/10 ملفات workflow تعلن `permissions:` في الأعلى؛ الافتراضي `contents: read`؛ لا `write-all` | `.github/workflows/*.yml` | SP-01, SP-02 |
| A2 | أقل امتياز للكتابة | الوظيفة الوحيدة التي تكتب محتوى المستودع هي `publish` في `release.yml` (على مستوى الوظيفة، لنشر الإصدار)؛ `pages`/`agent-branch-pages` تكتب `pages` و`id-token` فقط | `release.yml` سطر ~20 | SP-02 |
| A3 | لا تشغيل لكود الشوكات بالأسرار | لا `pull_request_target` في أي workflow | `.github/workflows/` | SP-03 |
| A4 | تثبيت الإجراءات الخارجية | كل `uses:` مثبّت إلى SHA كامل (40 hex) مع تعليق إصدار (`# v7.0.1` …): checkout, setup-node, setup-python, upload-artifact, deploy-pages, configure-pages, upload-pages-artifact, attest-build-provenance, docker/* | `grep -h uses: .github/workflows/*.yml` | SP-04 |
| A5 | تدقيق الاعتماديات | `npm audit --omit=dev --audit-level=moderate` في بوابة الجودة («Celia quality & resilience») وقبل النشر («Publish verified release») | `celia-mcp.yml` ~60، `release.yml` ~65 | SP-05 |
| A6 | تحديثات الاعتماديات | Dependabot: npm أسبوعيًا (مجموعة `production-patches`)، github-actions أسبوعيًا، docker شهريًا | `.github/dependabot.yml` | SP-06 |
| B1 | الأسرار خارج Git | `.gitignore`: `.env`, `.env.*`, `!.env.example`؛ الملف الوحيد المتتبَّع `.env.example` (قوالب لا مفاتيح) | `git ls-files` | SP-07 |
| B2 | توصيل الأسرار محقَّق | `npm run check:secrets` (`scripts/check-secrets-wiring.mjs`، 18 سرًا موصولًا) يعمل داخل بوابة الجودة مع `check:continuity` و`test:coverage:ci` على كل دفعة إلى أي فرع | `celia-mcp.yml` ~48/~104 | SP-08 |
| C1 | لا تنفيذ ديناميكي خارج العزل | صفر `eval(`/`new Function(`/`vm` في `src/` و`workers/`، وصفر `child_process`/`spawn` خارج الاستثناء الوحيد `src/agent/sandbox.js`؛ هذا المنفذ يشغّل `unshare` بسياسة AGENT-003 وentrypoint ثابت ويفشل مغلقًا، وليس Shell عامًا أو تفعيلًا لـ`sandbox.exec`؛ السكربتات في `scripts/` تعمل في CI فقط | فحص نصي كامل + اختبارات العزل `test:sandbox` | SP-09 |
| C2 | حارس SSRF للأهداف الخارجية | `isDisallowedTargetHost()` يرفض loopback والشبكات الخاصة وlink-local وmetadata وIPv6 المكافئة وأرقام IPv4 العشرية/الست عشرية | `workers/celia-edge/cron.js` | SP-10 |
| C3 | سجل تدقيق بسلسلة بصمات | `edge_audit` يُكتب بـ`INSERT` فقط مع `prev_hash`/`hash` (SHA-256)؛ لا `UPDATE`/`DELETE` عليه في أي ملف | `workers/celia-edge/state.js`، `migrations/0001_state.sql` | SP-11 |
| C4 | بوابات الجودة | 560+ اختبارًا حتميًا بأرضية تغطية 89/71/82 (`test:coverage`)، `check.mjs`، N/N−1 لعقود MCP، فحص الانحدار يفشل البناء (لا retry أعمى — DEC-041) | `package.json`، `celia-mcp.yml` | (اختبارات المشروع كلها) |
| D1 | ضوابط المالك | موثّقة أدناه بحالتها الحقيقية؛ لا يدّعي الاختبار تفعيلها | §2 | SP-12 |

### ما ليس مُنفَّذًا (بصراحة)

- **فحص الأنواع (Type checking):** المشروع JavaScript/ESM بلا TypeScript. إضافة `tsc --noEmit` مع `checkJs` قرار جديد بكلفة
  (تعليقات JSDoc على ~150 ملفًا) — يبقى في BACKLOG لا هنا.
- **مسح الشيفرة الثابت (CodeQL/Semgrep):** غير مُفعَّل. CodeQL مجاني للمستودعات العامة ويُفعَّل من الإعدادات (owner-only، §2).
- **توقيع الالتزامات (commit signing):** غير مطلوب حاليًا؛ الوكيل يلتزم بهوية `Arena Agent` بلا توقيع GPG.

## 2) ضوابط يملكها المالك وحده (owner-only)

الوكيل **لا يستطيع تغيير** هذه الإعدادات، ويقرأ منها القليل فقط: `GET /repos/{owner}/{repo}/branches/main/protection` يعيد **403
«Resource not accessible by integration»**، وكذلك `secret-scanning/alerts`، `code-scanning/default-setup`، `actions/permissions/workflow`
و`vulnerability-alerts`. ما **يمكن** قراءته بلا صلاحية إدارة: علم `protected` في `GET /branches/main`، قوائم `GET /rulesets` و
`GET /rules/branches/main`، رسالة `GET /dependabot/alerts` (تقول صراحةً إن كانت التنبيهات معطّلة)، وقائمة `GET /actions/workflows`
(يظهر فيها workflow ديناميكي `dynamic/github-code-scanning/codeql` عند تفعيل CodeQL الافتراضي). لذلك الحالة هنا واحدة من ثلاث فقط:
**UNKNOWN** (لا قراءة)، **VERIFIED (تاريخ)** (قراءة إيجابية أو تأكيد مالك مؤرَّخ)، **NOT ENABLED (تاريخ)** (قراءة سلبية صريحة) — ولا
يُسجَّل أي ضابط «مفعّلًا» بلا دليل.

**آخر فحص آلي: 2026-10-29** (بعد قول المالك «تم»): `branches/main → protected: false`، `rulesets → []`، `rules/branches/main → []`،
`dependabot/alerts → 403 "Dependabot alerts are disabled for this repository."`، لا `dynamic/github-code-scanning/codeql` في قائمة
الـworkflows (الموجود الديناميكي الوحيد: `dynamic/dependabot/dependabot-updates`)، والبقية 403. أي أن **ضابطين على الأقل لم يُفعَّلا بعد**؛
الصفوف أدناه تعكس ذلك لا كلمة التأكيد. إعادة الفحص: الأوامر في §4.

| الضابط | الحالة | لماذا يهم | خطوات التفعيل (Settings في GitHub) |
|---|---|---|---|
| **Branch protection / Ruleset على `main`** | NOT ENABLED (2026-10-29) — `protected: false`، لا rulesets؛ تفاصيل الحماية الكلاسيكية 403 لكن العلم السلبي قاطع | يمنع الدفع المباشر أو القسري إلى `main` ويجعل بوابة الجودة شرطًا للدمج | Settings → **Rules → Rulesets → New branch ruleset** → Target `main` → فعّل: **Require status checks to pass** (أضف checks من workflow «Celia quality & resilience»: `Node 24 · tests & failure recovery`، `Node 22 · tests & failure recovery`، `Node 24 container smoke test`، `MySQL 8.4 · persistence / N−1 / backup restore`، `RTL dashboard · desktop / mobile / accessibility`، `Python 3.11 · Celia Google Spider tests`)، **Require linear history**، **Block force pushes**، **Restrict deletions**. **لا** تفعّل *Require pull request reviews*: المستودع بمالك واحد، والشرط سيُقفل كل دمج (المراجع المطلوب لا يمكن أن يكون كاتب الـPR). |
| **Dependabot alerts + security updates** | NOT ENABLED (2026-10-29) — الواجهة تقول نصًا: «Dependabot alerts are disabled for this repository» | ينبّه بالثغرات في الاعتماديات ويفتح PRs ترقيع تلقائيًا (تمر عبر بوابة الجودة نفسها) | Settings → **Advanced Security** (أو *Code security and analysis*) → **Dependabot alerts: Enable** → **Dependabot security updates: Enable**. ملف `dependabot.yml` الموجود يغطي تحديثات الإصدارات فقط؛ التنبيهات الأمنية تحتاج هذا المفتاح. |
| **Secret scanning + Push protection** | UNKNOWN (403 — لا قراءة؛ يُحدَّث بتأكيد مالك مؤرَّخ أو لقطة شاشة من Settings → Advanced Security) | يرفض الدفعات التي تحوي أسرارًا معروفة الشكل قبل أن تصل إلى التاريخ | Settings → **Advanced Security** → **Secret scanning: Enable** → **Push protection: Enable** (مجاني للمستودعات العامة). |
| **CodeQL (code scanning)** | NOT ENABLED (2026-10-29) — لا workflow ديناميكي `dynamic/github-code-scanning/codeql` في قائمة الـworkflows؛ `default-setup` 403 | تحليل ثابت للـJavaScript على كل PR | Settings → **Advanced Security** → **Code scanning → Set up → Default**. يضيف workflow يديره GitHub؛ إن ظهر في `.github/workflows/` لاحقًا فسيخضع لـSP-01..SP-04 تلقائيًا. |
| **Actions → Workflow permissions** | UNKNOWN (403 — لا قراءة؛ كل workflow في المستودع يعلن `permissions:` صراحةً فالأثر العملي محدود — SP-01) | الافتراضي على مستوى المستودع يجب أن يكون *Read repository contents* حتى لو نسي ملف ما `permissions:` | Settings → **Actions → General → Workflow permissions → Read repository contents and packages permissions**؛ وأبقِ *Allow GitHub Actions to create and approve pull requests* **معطّلًا**. |

بعد التفعيل: أبلغ الوكيل بـ«تم» فتُحدَّث الحالة هنا إلى `VERIFIED (YYYY-MM-DD)` بتاريخ تأكيدك (لا يستطيع الوكيل التحقق بنفسه؛ SP-12 يرفض VERIFIED بلا تاريخ).

## 3) كيف يكسر أحدهم هذا الوضع — وماذا يحدث

| التغيير | ما يفشل | الرسالة |
|---|---|---|
| إضافة workflow بلا `permissions:` | SP-01 | `<file>: top-level permissions block is declared` |
| رفع `contents: write` في workflow غير `release.yml` | SP-02 | `<file>: must not write repository contents` |
| `uses: actions/checkout@v4` (وسم بدل SHA) | SP-04 | `"actions/checkout@v4" must be pinned to a 40-hex commit SHA` |
| حذف `npm audit` من بوابة الجودة أو الإصدار | SP-05 | `quality workflow runs npm audit` |
| التزام ملف `.env.local` بالخطأ | SP-07 | `no real .env file is committed` |
| استدعاء `child_process` من `src/` خارج `src/agent/sandbox.js` أو إضافة `eval`/`vm` داخله | SP-09 | `dynamic code execution or process spawning found outside the isolated AGENT-003 executor` |
| تخفيف حارس SSRF (السماح بـ`169.254.169.254`) | SP-10 | `"169.254.169.254" must be refused` |
| `UPDATE edge_audit …` في أي ملف | SP-11 | `<file>: edge_audit is append-only` |
| تغيير حالة Branch protection في §2 إلى VERIFIED أو ENABLED بلا تاريخ | SP-12 | `Branch protection: status is UNKNOWN, VERIFIED (date) or NOT ENABLED (date)` |

الكسر المقصود (مثلًا workflow جديد يحتاج `issues: write`) مسموح: عدّل الاختبار **في الـPR نفسه** مع سطر في DECISIONS يشرح لماذا.

## 4) الأوامر

```bash
node --test test/security-posture.test.js     # SP-01..SP-12 (بلا شبكة)
npm run check:secrets                          # توصيل الأسرار (18)
npm audit --omit=dev --audit-level=moderate    # ما تشغّله بوابة الجودة
grep -h "uses:" .github/workflows/*.yml | sort | uniq -c   # قائمة الإجراءات المثبّتة

# فحص ضوابط المالك بما تسمح به الصلاحيات (قراءة فقط؛ 403 = لا قراءة، لا استنتاج)
R=repos/celiaelazamey-arch/phone-google
gh api $R/branches/main --jq .protected            # false = لا حماية كلاسيكية
gh api $R/rulesets; gh api $R/rules/branches/main  # [] = لا rulesets
gh api "$R/dependabot/alerts?per_page=1"           # «Dependabot alerts are disabled…» = غير مفعّل
gh api "$R/actions/workflows" --jq '.workflows[].path' | grep code-scanning   # غياب السطر = لا CodeQL افتراضي
```

## 5) الروابط

- `docs/agent-risk-matrix.md` — مصفوفة المخاطر (QA-009) والأركان الأربعة المنفَّذة.
- `docs/ci-failure-notify.md` — الإبلاغ عن فشل `main` (لا retry أعمى).
- `docs/continuity/DECISIONS.md` — DEC-030 (لا واجهات بلا جوهر)، DEC-041 (لا إصلاح ذاتي مستقل).
- `docs/learning-protocol.md` — لماذا لا يُنفَّذ شيء من نص طرف ثالث (`scanInjection`).
