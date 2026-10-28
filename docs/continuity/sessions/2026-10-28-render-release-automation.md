# تسليم جلسة — 2026-10-28 — أتمتة نشر الخادم الكامل على Render بعد حسابي المالك (DEC-028)

## المهمة والتفويض

- طلب المستخدم: عرض صفحة أسرار Actions (18 سرًا للمستودع، لا أسرار بيئة) وقال «موجودين استخدمهم» — أي أن الأسرار
  الموجودة يجب أن تكفي للوصول إلى «تم النشر 100%».
- معرفات BACKLOG: HOST-003 (الخادم الكامل)، HOST-002 (الإبقاء مستيقظًا).
- النطاق المسموح: الفرع `arena/bf717032-phone-google` فقط؛ لا دمج ولا نشر ولا إنشاء حسابات ولا بطاقة؛ لا وضع تجريبي
  بلا MySQL؛ لا ادعاء نشر غير متحقق؛ لا تغيير في قائمة الأسرار الثمانية عشر المتتبعة (DEC-025).

## واقع البداية

- الفرع متفرع من `main@a930383` (دمج PR #45). الإصدار `0.2.1`. خطوط `main` الأربعة خضراء: CI `40615518732`، Pages
  `40615518798` (10/10 مسارات)، Worker `40615518722` (`liveReady:true`، 18/18)، Release `40615518730`.
- الأسرار الثمانية عشر كلها موصولة فعلًا (Worker bindings، مسابر CI، `check:secrets`)؛ تصنيفها: مزوّدو الذكاء
  (`AGENETROUTERAPI_KEY`, `AI_GATEWAY_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`)، المجدول (`CELIAOS_CRONJOB_ORG_API_KEY`)،
  رمز المالك (`CELIA_MCP_API_TOKEN`)، الصوت (`ELEVENLABS_API_KEY`, `CELIA_VOICE_ID`)، Cloudflare (`CLOUDFLARE_ACCOUNT_ID`,
  `CLOUDFLARE_API_TOKEN`)، R2 (`CLOUDFLARE_R2_*` ×3)، `FIGMA_ACCESS_TOKEN`، Google OAuth (`GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`)، `PHONE_NUMBER`، `YOUR_CODATA_API_KEY`.
- **لا سرّ منها يمنح مضيف Node أو قاعدة MySQL.** الخادم الكامل (Express + MySQL) غير منشور: لا خدمة Render ولا قاعدة
  Aiven ولا `verify:live` PASS على رابط عام.

## ما تغير فعليًا

- **workflow جديد** `.github/workflows/deploy-render.yml`: `on: workflow_run` بعد نجاح «Celia quality & resilience» على
  `main` + `workflow_dispatch` (`plan_only`, `skip_keepalive`)؛ `permissions: contents: read`؛ يقرأ فقط
  `vars.CELIA_LIVE_URL`، `secrets.RENDER_API_KEY`، `secrets.RENDER_SERVICE_ID`، `secrets.RENDER_DEPLOY_HOOK_URL`،
  `secrets.CELIA_MCP_API_TOKEN`، `secrets.CELIAOS_CRONJOB_ORG_API_KEY`؛ يرفع `.validation-artifacts/live-acceptance.json`
  كـartifact إن وُجد.
- **سكربت جديد** `scripts/deploy-render.mjs` (`npm run deploy:render`، و`--plan` بلا شبكة): `planDeployment` →
  `not-configured` أخضر يسمّي الناقص؛ وإلا إطلاق نشر Render (API: `POST /v1/services/{id}/deploys` ثم استطلاع الحالة حتى
  `live`/فشل؛ hook: `POST` ثم استطلاع `/version` حتى يطابق الـcommit) بمهلة 20 دقيقة → `verify:live` عبر `runCli` المصدَّر
  (`--expect-commit`، الرمز من البيئة فقط؛ `--max-first-ms 90000`) → بعد PASS فقط keep-alive على cron-job.org
  (`GET /jobs` ثم `PUT /jobs` أو `PATCH /jobs/{id}` بعنوان `celia-keepalive:<host>`، `/readyz`، دقائق `0,10,…,50` UTC).
  كل المخرجات والإشعارات تمر بـ`sanitize` (يحذف قيم `RENDER_API_KEY`, `RENDER_DEPLOY_HOOK_URL`, `CELIA_MCP_API_TOKEN`,
  `CELIAOS_CRONJOB_ORG_API_KEY`).
- **اختبارات** `test/deploy-render.test.js` (8): الخطة بلا مدخلات/بالمدخلات/بالبديل hook/رفض http، وظيفة keep-alive،
  تصنيف حالات Render، التنقيح، CLI `--plan` بلا تسريب، وعقد الـworkflow (بوابة CI، المدخلات، لا `MYSQL_*`/
  `TOKEN_ENCRYPTION_KEY` في GitHub).
- **الوثائق:** `deploy/free-always-on/README.md` (§4 الخطوتان 3 و5، و§4.2 جديد)، `README.md` §روابط النشر،
  `docs/deployment-profile.json` (`automationAfterOwnerAccounts`)، `CHANGELOG.md`، `package.json`.
- **الاستمرارية:** DEC-028، BACKLOG HOST-003، STATE، هذا السجل.
- لا تغيير في `render.yaml` (يبقى `autoDeployTrigger: off`)، ولا في `TRACKED_SECRETS`، ولا الأدوات ولا المخطط.

## الفحوص

| الأمر/الفحص | commit/البيئة | النتيجة أو سبب عدم التشغيل |
|---|---|---|
| `node --test test/deploy-render.test.js` | هذا الفرع، محليًا | 8/8 |
| `node scripts/deploy-render.mjs --plan` | محليًا بلا مدخلات | `status: not-configured`، `missing: [CELIA_LIVE_URL (repository variable), RENDER_API_KEY + RENDER_SERVICE_ID (or RENDER_DEPLOY_HOOK_URL)]`، خروج 0 |
| `npm run check` · `release:check` · `check:secrets` · `build:pages` · `check:continuity` | محليًا | 106 ملفات سليمة · 0.2.1/schema 1 · 18/18 سرًا متتبعًا بلا تسريب · dist 9 صفحات · 33 وثيقة و125 رابطًا و52 مهمة بلا دورات |
| `npm test` | محليًا (بعد `npm ci` و`git fetch --unshallow`) | 303/303 — اختبار الانحراف `free-hosting-plan` احتاج إضافة `CELIA_LIVE_URL` إلى قائمة الأسماء غير-Render (متغيّر GitHub لا مفتاح Render)؛ اختبار N/N−1 يفشل في النسخة الضحلة فقط |
| تشغيل حقيقي لـ`deploy-render.yml` | — | **لم يُنفَّذ**: لا خدمة Render ولا مدخلات؛ أول تشغيل بعد الدمج سيعيد `not-configured` أخضر حتى يضيفها المالك |

## الحفظ والتسليم

- commit على `arena/bf717032-phone-google` ودفع إلى الأصل؛ PR يُفتح من الفرع نفسه (الدمج قرار المالك).
- لا نشر من هذه الجلسة؛ لا حسابات، لا بطاقة، لا ترحيل، لا إرسال خارجي.
- ما يبقى `not-verified`: الخادم الكامل حتى يكتب الـworkflow `verified` بتقرير PASS.

## الاستئناف

- العوائق: إنشاء المالك لقاعدة Aiven MySQL Free وخدمة Render Free من `render.yaml` (Blueprint)، ثم إضافة
  `CELIA_LIVE_URL` (variable) و`RENDER_API_KEY`+`RENDER_SERVICE_ID` (أو `RENDER_DEPLOY_HOOK_URL`).
- الخطوة التالية بعدها: Actions → «Render full backend (free) — deploy & verify» → Run workflow؛ قراءة إشعار
  `Render Live Status` والـartifact؛ تسجيل البنود `manual` من §5 في سجل جلسة. أول فحص آمن: `npm run deploy:render -- --plan`.
