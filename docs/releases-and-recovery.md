# الإصدارات والترقية والاستعادة — Celia 0.2.0

هذا دليل تشغيل **Linux + Docker Engine/Compose v2**. لا ينفّذ المتصفح أو MCP أو Google Docs أي نشر في الإنتاج. احتفظ بأسرار النشر وحالته على جهاز المشغّل، ولا تنشرهما في Git.

## 1. ما أصبح ممكنًا وما لا نضمنه

- إصدار SemVer موحد بين `package.json` و`package-lock.json` و`releases/current.json` وهوية MCP وصفحات المعاينة والحاوية.
- حزم مصدر وموقع ثابت وSBOM وSHA256SUMS؛ سير النشر يضيف GitHub OIDC attestations وصورة GHCR محددة بالـdigest.
- تجربة الحاوية المرشّحة دون منفذ عام؛ التبديل لا يبدأ قبل نجاح جاهزيتها وتوافق مخطط البيانات.
- فحص النسخة الفعلية بعد التبديل. عند الفشل تُحاول الأداة استعادة الإصدار السليم المسجّل وتتحقق منه أيضًا.
- قفل يمنع النشر المتزامن، سجل `pending` قبل التبديل، وحفظ حالة ذري بصلاحية `0600`.
- **ليس** هذا نشرًا بلا انقطاع: استبدال حاوية التطبيق قد يقطع الطلبات لفترة قصيرة. ولا يضمن التراجع نجاحه عند فشل Docker/الجهاز/القرص نفسه.
- الرجوع بالكود **ليس** استعادة لبيانات MySQL. نسخ البيانات الاحتياطية وسياسة الاحتفاظ بها مسؤولية مستقلة.

## 2. إصدار جديد من GitHub

بعد مراجعة طلب الدمج ونجاح CI ودمجه في `main`:

1. حدّث `package.json` وlockfile و`releases/current.json` وسجل `history.json` و`CHANGELOG.md` معًا. استخدم رقمًا جديدًا؛ لا تعِد كتابة إصدار منشور.
2. شغّل `npm run release:check && npm test`، ثم اختبارات المتصفح.
3. أنشئ بيئة GitHub باسم `release` واضبط required reviewers إن كانت خطتك تدعمها، وامنع تجاوز الموافقة. اسم البيئة في YAML وحده **لا** يفرض مراجعة بشرية.
4. Actions → **Publish verified release** → Run workflow على `main`. لا يحتاج Workflow مفتاح نشر خاصًا؛ يستخدم `GITHUB_TOKEN` بالصلاحيات المقيدة للنشر وOIDC للإثبات.
5. ينتج GitHub Release باسم `vVERSION` مع:
   - `celia-vVERSION-source.tar.gz`
   - `celia-vVERSION-site.tar.gz`
   - `sbom.cdx.json` (CycloneDX للاعتماديات الإنتاجية)
   - `release.json` وفيه commit وصورة `ghcr.io/...@sha256:...`
   - `SHA256SUMS`
6. هذا **ينشر القطع فقط**؛ لا يغيّر خادمك الإنتاجي تلقائيًا. امنع حذف/تحريك وسوم `v*` عبر repository rulesets، وفعّل release immutability حيث تتوفر.

توليد الحزم محليًا متاح من شجرة نظيفة **ومحفوظة في commit**:

```bash
npm ci
npm run release:check
npm run release:bundle
npm run release:verify
```

تذهب الملفات إلى `.release-artifacts/` المتجاهل في Git. الـchecksums تكشف التلف، لكنها ليست توقيعًا ولا تثبت مصدر حزمة مجهولة. للإصدارات المنشورة استخدم أيضًا GitHub CLI حديثًا يدعم `gh attestation verify` للتحقق من المصدر وسير العمل.

## 3. إعداد أول خادم مُدار

متطلبات: Node.js 22+ (24 LTS موصى به)، Docker/Compose v2، مساحة تسمح بتشغيل مرشّح وحاوية فعالة معًا، وصول إلى GHCR، وMySQL مُعدّ مسبقًا بمخطط `sql/schema.sql`. لا تجري الأداة أي ترحيل تلقائي.

1. ضع أسرارك في ملف خارج المستودع، مثل `/srv/celia/runtime.env`، واضبط:
   - `CELIA_MCP_API_TOKEN` عشوائيًا، لا مثال placeholder.
   - `CELIA_MCP_DISABLE_MYSQL=false` بشكل صريح.
   - إعدادات MySQL الفعلية ومفتاح التشفير وتكاملاتك حسب الحاجة.
   - MySQL في الإنتاج يستخدم TLS؛ استخدم اتصالًا بشهادة موثوقة.
2. `chmod 600 /srv/celia/runtime.env`.
3. أنشئ شبكة Docker موثوقة مشتركة مع قاعدة البيانات، أو استخدم عنوانًا يمكن للحاويات الوصول إليه. **لا** تستخدم `127.0.0.1` للإشارة إلى قاعدة على جهاز المضيف؛ loopback داخل الحاوية يعود إلى الحاوية نفسها.
4. صدّر إعدادات المشغّل (لا أسرار فيها):

```bash
export CELIA_ENV_FILE=/srv/celia/runtime.env
export CELIA_DEPLOY_STATE_DIR=/srv/celia/deploy-state
export CELIA_COMPOSE_PROJECT=celia-production
export CELIA_DOCKER_NETWORK=celia-runtime
export CELIA_BIND_ADDRESS=127.0.0.1
export CELIA_HTTP_PORT=3010
```

`compose.release.yml` يفتح المنفذ على loopback افتراضيًا؛ ضع reverse proxy مع HTTPS أمامه. `CELIA_BIND_ADDRESS=0.0.0.0` يفتح المنفذ للشبكة ولا يغني عن TLS أو الجدار الناري. في المعاينة فقط يُربط الخادم نفسه بـ`0.0.0.0` للسماح بالوكيل.

5. نزّل حزمة الإصدار من GitHub وتحقق من checksums والإثبات. اقرأ قيمة `image` الفعلية من `release.json`، ثم:

```bash
# استبدل REF وVERSION بالقيم الحقيقية؛ لا تستخدم :latest أو :vVERSION.
npm run deploy:release -- switch --image REF --version VERSION
npm run deploy:release -- status
```

- ترفض الأداة استبدال حاوية موجودة غير مُدارة أو حالة لا تطابق الصورة المشغّلة.
- ترفض التبديل بين MySQL والذاكرة؛ هذه هجرة بيانات وليست رجوع كود.
- الذاكرة مسموحة **للتجربة فقط** عبر `CELIA_MCP_DISABLE_MYSQL=true` و`--allow-memory`. لا تُسمّى نسخة احتياطية، وقد تُفقد عند تشغيل المرشّح أو إعادة التشغيل.
- CLI الحالي ينشر **خادم MCP** من `Dockerfile.mcp`. تشغيل `src/server.js`/خدمة OAuth وWebhook له `Dockerfile` منفصل، ولا تدّعي الأداة إدارته. Render يستخدم آلية النشر/الرجوع الخاصة بمنصته.

## 4. الرجوع والتبديل بين النسخ

بعد نشرين سليمين ومتوافقين على الأقل:

```bash
npm run deploy:release -- status
npm run deploy:release -- rollback
```

`rollback` يختار `previous` المسجلة، ويمرّ بنفس فحوص المرشّح والتوافق والجاهزية. بعد الرجوع تصبح النسخة التي غادرتها هي السابقة؛ يمكن الانتقال إليها مجددًا. للانتقال إلى نسخة أخرى استخدم `switch` مع digest/version ذلك الإصدار.

**أول نشر مُدار لا يملك إصدارًا سابقًا مخترعًا.** `0.1.0` خط أساس مصدر عند commit:

```text
9b5c0d6643f4b1ddcafb7aaa0b32e9bea756ea9f
```

لم يكن يتضمن `/readyz` أو عقد النشر الحالي؛ لذا لا تدعمه أداة الرجوع المُدار. يمكن تنزيل مصدره بالأمر التالي إلى مجلد مستقل، مع مراجعة إعداداته القديمة ونسخ البيانات احتياطيًا، دون استبدال ملفات جهازك العامل عشوائيًا:

```bash
gh api repos/celiaelazamey-arch/phone-google/tarball/9b5c0d6643f4b1ddcafb7aaa0b32e9bea756ea9f > celia-baseline-source.tar.gz
```

## 5. انقطاع جهاز المشغّل أثناء النشر

- إذا وُجد `pending` فالتبديلات الجديدة تُرفض.
- افحص العمليات وDocker أولًا. لا تمسح قفل `deploy.lock` بينما تعمل عملية نشر أخرى.
- بعد التأكد أن العملية القديمة انتهت فقط، أزل القفل العالق من مجلد حالة النشر ثم:

```bash
npm run deploy:release -- recover
npm run deploy:release -- status
```

يعيد `recover` النسخة الفعالة المسجّلة ويتحقق منها؛ وفي أول نشر غير مكتمل يزيل حاوية التطبيق فقط. لا يحذف قاعدة البيانات أو أحجامها. افحص أي حاويات يتيمة باسم `<project>-candidate-*` بعد التعافي وأزلها يدويًا بعد التأكد من أنها ليست النسخة الفعالة.

إذا ظهر `MANUAL_RECOVERY_REQUIRED`، لا تكرر إرسال رسائل أو إنشاء مواعيد. افحص Docker والجهاز، خذ نسخة من سجل الحالة، واستخدم الإصدار السليم المسجّل لاستعادة التشغيل. لا تحذف الـjournal بغرض تجاوز فشل التحقق.

## 6. الرجوع في GitHub Pages

Actions → **Deploy (GitHub Pages)** → Run workflow على `main`:

- اترك `release_tag` فارغًا لبناء `main` الحالي.
- أدخل وسمًا منشورًا مثل `v0.2.0` لاستعادة **نفس حزمة الموقع** بعد التحقق من SHA256 وGitHub attestations وتطابق commit/tag وأصل الوسم في `main`.
- لا يدعم هذا وسومًا بلا حزم/إثباتات من سير النشر الجديد، ومنها خط أساس `0.1.0` غير المنشور آليًا.
- Pages واجهة ثابتة وتجربة متصفح فقط؛ لا تستعيد قاعدة MySQL أو خادم OAuth/Webhook.

## 7. عقد قاعدة البيانات

الإصدار الحالي يبقي schema=1 دون تغيير الجداول. تُعلن `minReadable` و`maxReadable` و`destructiveMigration=false` في manifest.

الأداة تمنع المخططات غير المتوافقة ولا تخمّن إصدار مخطط موجود. هذه بيانات عقد مصدر، **ليست أداة اكتشاف لمخطط قاعدة عُدلت يدويًا**. تحقق من قاعدة الإنتاج قبل اعتماد النشر الأول. لإضافة مخطط مستقبلي اتبع expand → backfill → switch → contract، باختبارات ترحيل مستقلة ونسخ احتياطية، ولا ترفع رقم المخطط لتجاوز المنع.
