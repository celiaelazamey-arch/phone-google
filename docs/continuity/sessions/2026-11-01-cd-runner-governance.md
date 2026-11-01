# PUB-007 — أنبوب نشر لا يسبق الاختبار، وحماية الإصدار المجمّد، وتثبيت المشغّلات، ومسوّدة `0.3.0`

**التاريخ:** 1 نوفمبر 2026 · **الفرع:** `arena/3ed4990f-phone-google` (طلب #123) · **القرار:** `DEC-108`

## ما قيس قبل أي تعديل

1. **الإصدارات والنشر:** `package.json` و`releases/current.json` عند **`0.2.1`**؛ آخر إصدار مجمّد على GitHub Releases هو **`v0.2.1`** (`2026-10-27T23:44:09Z` · `c4e28d4` · `immutable: true`). تراكم بعده على `main` **230 التزامًا عبر 69 طلب دمج** وصولًا إلى `301df01` المنشور حيًّا على `/health` تحت الرقم `0.2.1`.
2. **نشر يسبق الاختبار:** على `301df01` انطلق `Deploy (Cloudflare Edge)` في الثانية نفسها (`10:20:24Z`) مع `Celia quality & resilience` وانتهى قبل اكتمالها.
3. **تناقض صامت في `release.yml`:** في كل دمج على `main` كان يبني ويدفع صورة `ghcr.io/...:v0.2.1` فوق وسم إصدار مجمّد، ثم يكتشف في آخر خطوة أن `v0.2.1` مجمّد فيخرج بتحذير دون نشر الحزمة.
4. **مشغّلات عائمة + تصحيح علمي:** المستودع **عام (`public`)**، أي أن كل وظيفة تحصل على آلة افتراضية مستقلة (**4 أنوية و16 GB RAM**) مجانًا، لا مشغّل بـ2 نواتين؛ لكن الـ11 ملف سير عمل كانت تستخدم `ubuntu-latest` المرشّح للترحيل إلى `Ubuntu 26.04` في نوفمبر 2026، وتُظهر تحذيرات الترحيل في كل تشغيلة. وفُحص مستودع `actions/runner-images` مباشرةً فثبت توافر `ubuntu-26.04` رسميًا وتوافر `Node 24.22.1` و`GitHub CLI 2.103.2` داخل `ubuntu-slim`.

## ما نُفِّذ

1. **ربط نشر الطرفية بنجاح الاختبارات (`cloudflare-deploy.yml` + `verify-edge-provenance.mjs` + `deploy-cloudflare-edge.mjs`):**
   - انتقل التشغيل التلقائي من `push: [main]` المتوازي إلى `workflow_run` مشروطٍ بنجاح `Celia quality & resilience` على دفعة `main` (`event == 'push' && conclusion == 'success'`).
   - أُضيف حارس `freshness` يرفض الكتابة فوق `main` إن كان الالتزام المُختبَر قد تخطّاه التزامٌ أحدث (`superseded`).
   - مُرِّر `CELIA_EXPECT_COMMIT` عبر جميع خطوات النزاهة والرفع والفحص الحيّ وترقية `known_good` احترامًا لـ`CRIT-01` وحتى تُوقَّع الشهادة وتُختم الحزمة بالالتزام المُختبَر ذاته لا برأس متغيّر.
   - رُبطت الوظيفة ببيئة `production-edge` لتجهيز خانة البيئة في إعدادات المستودع (مع التصريح بأن الاسم وحده ليس قفلًا حتى يفعّل المالك المراجعين المطلوبين وفق `REL-001`).
2. **فحص التجميد قبل البناء والدفع (`release.yml`):**
   - انتقل فحص `.immutable` إلى خطوة `id: identity` في أول الوظيفة قبل `npm ci` وقبل `docker/build-push-action`؛ فعندما يكون الإصدار الحالي مجمّدًا (`v0.2.1`) تتوقف الوظيفة بنزاهة في ثوانٍ دون المساس بوسم الصورة `:v0.2.1` أو بناء حزم مهدرة.
3. **تثبيت المشغّلات واستطلاع `Ubuntu 26.04` (`11` ملف سير عمل):**
   - ثُبِّتت مهام البناء والحاويات وMySQL وPlaywright والنشر على `ubuntu-24.04`.
   - نُقلت المهام الخفيفة التي لا تستخدم Docker (`quality-failure-notify` و`issue-triage` و`issue-triage-selftest`) إلى `ubuntu-slim`.
   - أُضيفت وظيفتا فحص فعليتان في `celia-mcp.yml`: `ubuntu26-canary` على `ubuntu-26.04` و`slim-runner-probe` على `ubuntu-slim` حتى يُثبَت عملهما في CI الحقيقي لا على الورق.
4. **مسوّدة قرار الإصدار `0.3.0` (`REL-003`):**
   - كُتبت [release-0.3.0-proposal.md](../../release-0.3.0-proposal.md) بجرد الـ230 التزامًا والـ69 طلب دمج والفصل الصريح بين ما هو مفعَّل تشغيليًا وما هو غير مفعَّل، مع إبقاء `package.json` عند `0.2.1` التزامًا بقاعدة عدم الرفع التلقائي.
5. **اختبارات انحدار (`test/cd-runner-governance.test.js`):** 6 اختبارات (`CDR-01..06`).

## الحدود وما لم يُمسّ

- لم يُدمج `#123`، ولم يُرفع إصدار `0.2.1` تلقائيًا، ولم يُنشر شيء إلى الإنتاج.
- قفل المراجعين على بيئتَي `production-edge` و`release` في **Settings → Environments** بيد المالك وحده (`REL-001`).
- `SEC-007` و`REL-003` و`conflict_resolution` تبقى مفتوحة ومعلَنة.

## الدليل البصري

لا يوجد تغيير بصري — لم تُمَسّ صفحة ولا رمز لون ولا مولّد أطلس: التغيير في ملفات سير العمل وسكربتَي النشر ومسوّدة قرار الإصدار واختبارات الحوكمة.

## الاستئناف

```sh
node --test test/cd-runner-governance.test.js test/workflows-static.test.js test/security-posture.test.js
CELIA_CONTINUITY_BASE=$(git rev-parse origin/main) npm run check:continuity
CELIA_CONTINUITY_BASE=$(git rev-parse origin/main) npm run visual:first:check
npm run now:check && npm run check && npm test
```
