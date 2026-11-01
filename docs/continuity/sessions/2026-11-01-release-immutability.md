# 2026-11-01 — REL-002 / DEC-083: تجميد الإصدارات يوقف خطوة النشر

**الفرع:** `arena/9dceca86-phone-google` · **الملف:** `.github/workflows/release.yml` · **الوضع:** منفَّذ ومختبر محليًا.

## العلة المقيسة
بعد تشغيل **Enable release immutability** صار الإصدار `v0.2.1` مجمّدًا (`immutable=true` من الـAPI). وخطوة «Publish or sync verified release bundles» كانت تنفّذ `gh release upload --clobber` و`gh release edit --target` بلا فحص، فيفشل `publish` في **كل** دفعة إلى `main` بلا طريق للنجاح، بينما بقية السير تنجح.

القياس: `Deploy (GitHub Pages)` و`Deploy (Cloudflare Edge)` و`Code scanning` و`Celia quality` كلها ناجحة على `c4e28d4`، و`Publish verified release` وحده فشل.

## الإصلاح
- تقرأ الخطوة `.immutable` من `repos/$GH_REPO/releases/tags/$TAG` **قبل** أي تعديل.
- إن كان `true`: تُصدر `::warning` تشرح أن الحزمة المبنية **لم تُنشر** وأن رفع أثر جديد يحتاج ترقية إصدار، ثم تخرج بـ`0`.
- إن لم يكن الإصدار مجمّدًا، يبقى المسار القديم (رفع/تعديل) كما هو حرفيًا.
- ملفوفة بـ`|| echo false` حتى لا تُسقط الشبكة الخطوة، وممرّ `GH_REPO` صريح ليعمل خارج المستودع الافتراضي.

## الأساس المنطقي
التجميد سياسة لا عطل: أصول الإصدار المنشور لا تُعدَّل أبدًا. والصواب أن يخبرنا الخطاب بذلك بدل أن يُعيد المحاولة أو يفشل. لا يُضعف الإصلاح أي بوابة، ولا يرقّي إصدارًا، ولا يلمس أي أثر منشور.

## التحقق
`npm test` **943/927/0**، و`check` ناجح، و`workflows-static` (CRIT-01) 2/2، ثم `check:continuity` مع `CELIA_CONTINUITY_BASE` لعقدة `main` بعد إضافة هذا السجل و STATE.
