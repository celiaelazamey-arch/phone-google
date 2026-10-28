# تسليم جلسة — 2026-10-28 — WhatsApp مجاني-أولًا

## الطلب والنطاق
- طلب المستخدم: تفعيل التكامل المتوافق مع Celia/WhatsApp بأقل تكلفة أولية ودون بطاقة، مع الاستفادة من مفاتيح GitHub Actions الموجودة.
- المستودع: `celiaelazamey-arch/phone-google`.
- `main` عند بدء المهمة: `8a9fc567c6c0f32fac7d75ccd8ed0a0bf637d1e7`.
- الفرع: `feat/whatsapp-free-first-setup-20261028`.
- لم يجر تعديل `main` أو دمج/نشر في هذه الجلسة. لا مفاتيح ولا رسائل حقيقية ولا بيانات مستخدمين أُنشئت.

## حقيقة المعمارية قبل التنفيذ
- `src/whatsapp.js` يحتوي Webhook وREST قائمين، ويستخدم Express وMySQL.
- التحقق من Webhook موجود في `src/security.js` باستخدام HMAC-SHA256 على raw bytes؛ توجد معالجة dedup لمعرفات Meta، وموافقات `opted_in` و`ai_opted_in`، وحد نافذة العميل 24 ساعة، ومفتاح موافقة المالك لأوامر Google.
- `workers/celia-edge/worker.js` حاليا Worker للحالة والجدولة والأدلة؛ لا يوجد binding D1 ولا مسار WhatsApp فيه. لذلك أُبقي مسار الرسائل في Express/MySQL بدلا من إضافة مخزن آخر يكرر الحالة.
- `WHATSAPP_AUTO_REPLY_ENABLED` في Render يبقى `false`.

## تغييرات الفرع
1. `src/config.js`: الإصدار الافتراضي لواجهة Meta Graph أصبح `v26.0`، مع استمرار دعم override عبر `WHATSAPP_API_VERSION`.
2. `render.yaml`: أضيفت حقول التشغيل `APP_OWNER_PHONE_E164`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_API_VERSION`. مفاتيح runtime عبر `sync: false` تُدخل في لوحة Render، ولا تنتقل من Actions تلقائيا.
3. `scripts/service-reality.mjs`: أضيف `probeWhatsAppCloudApi` الذي ينفذ GET فقط على معرّف رقم الهاتف؛ يرفض معرفًا غير رقمي وإصدارًا غير صالح، ولا يرسل رسائل ولا يطبع سرًا. نتيجته لا تثبت تهيئة Webhook أو الإرسال الفعلي.
4. `.github/workflows/service-reality.yml`: ربط الأسرار الأربعة الاختيارية وتبديل إصدار API كمتغير فقط لتدقيق القراءة، لا لإرسال رسائل.
5. `test/service-reality.test.js`: اختبار mock للقراءة فقط، واختبار رفض الإعداد غير الصالح قبل الشبكة، واختبارات wiring لحقول Render والـworkflow.
6. `docs/free-hosting.md`, `docs/continuity/BACKLOG.md`, `docs/continuity/STATE.md`, `docs/continuity/DECISIONS.md`: توثيق خطوة الاختبار المجاني، وWA-005، وDEC-032، والقيود الحالية.

## الأسرار الفعلية المطلوبة (ليست موجودة في القائمة السابقة)
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_APP_SECRET`
- `WHATSAPP_VERIFY_TOKEN`

`PHONE_NUMBER` الموجود هو رقم المالك؛ ليس access token ولا Meta Phone Number ID. أضف الأسرار الأربعة في Repository secrets في GitHub إذا رغبت بالتدقيق الحي. وأدخلها منفصلة في Render Dashboard عند نشر الخادم الكامل. لا تنسخها إلى Git أو Pages أو نص المحادثة.

## معيار القبول
1. اجتياز `npm run check`, `npm run check:continuity`, `npm test`, `npm run test:coverage`, `npm run release:check` وCI الكامل.
2. تأكيد أن المسبار يرسل GET فقط إلى Graph API وأنه لا ينفذ POST أو يرسل رسالة.
3. بدء الاختبار برقم Meta التجريبي؛ تحقق challenge عبر GET، ثم POST بتوقيع HMAC صحيح، ورفض توقيع خاطئ، وتأكيد dedup للرسالة نفسها.
4. تحقق حي على نشر الخادم الحالي وأدلة مرتبطة بنفس commit، مع الحفاظ على `WHATSAPP_AUTO_REPLY_ENABLED=false` حتى موافقة المالك والقبول النهائي.
5. لا تعلن أن الإنتاج مجاني بلا حدود: أدوات الاختبار مجانية، أما الرسائل الحقيقية قد تكون مدفوعة وفق حساب Meta وسياساته.

## الحالة النهائية بعد التنفيذ

- **PR #51 مُدمج** عبر Squash؛ commit `b70f9149add3699090ac7874a51019e2dc2c345a`.
- CI الكامل على PR نجح: [40673674333](https://github.com/celiaelazamey-arch/phone-google/actions/runs/40673674333). بوابة جودة `main` نجحت: [40673821757](https://github.com/celiaelazamey-arch/phone-google/actions/runs/40673821757).
- نشر GitHub Pages نجح [40673821758](https://github.com/celiaelazamey-arch/phone-google/actions/runs/40673821758)، وCloudflare Worker نجح [40673821848](https://github.com/celiaelazamey-arch/phone-google/actions/runs/40673821848)، وPublish verified release نجح [40673821824](https://github.com/celiaelazamey-arch/phone-google/actions/runs/40673821824). أحدث release `v0.2.1` يستهدف commit `b70f9149` مع 5 أصول.
- Render workflow [40673950617](https://github.com/celiaelazamey-arch/phone-google/actions/runs/40673950617) أنهى بنجاح نتيجة `not-configured`; هذا **ليس نشرًا**. الخدمة الكاملة وAiven MySQL لم تُنشآ/تُهيّآ بعد.
- تدقيق `Service reality audit` على commit الدمج تخطّى التنفيذ لعدم وجود trigger `[reality]` أو dispatch يدوي؛ لا يوجد تأكيد حي على Meta/WhatsApp.
- لم تظهر الأسرار الأربعة في قائمة Repository secrets التي زود بها المستخدم: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`. يجب إنشاء Meta app واستخدام test phone number ثم إضافة القيم، وعدم مشاركة أي قيمة هنا.
- `WHATSAPP_AUTO_REPLY_ENABLED=false` ما زال قيد الأمان الافتراضي. لا يُفعّل حتى نجاح Webhook challenge وHMAC وdedup والاختبار الحي، ولا ضمان أن الإنتاج مجاني بلا حدود.
- إعداد حماية `main` لم يتغير؛ فحص GitHub أظهر `protected=false`. هذه خطوة تشغيلية للمالك مستقلة عن WhatsApp.
