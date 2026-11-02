# الحالة الحالية — ابدأ من هنا

> **حفظ التاريخ بلا حذف (`DEC-052` / `CONT-004`):** هذه نافذة الاستئناف النشطة؛ السجل التراكمي الكامل حتى ما بعد PR #84 (`main@738d832` / `9f6f8b2` — 983 سطرًا / 142,150 بايت) محفوظ حرفيًا في **[STATE-ARCHIVE-2026-10.md](STATE-ARCHIVE-2026-10.md)** وبصمته محروسة بـ`R0-02`، وأقسام 31 أكتوبر–1 نوفمبر المنقولة عند `6b4bb2d` و`a1d3f7b` في **[STATE-ARCHIVE-2026-11.md](STATE-ARCHIVE-2026-11.md)**. القراءة السريعة المشتقة: **[NOW.md](NOW.md)** (`npm run now`).

**آخر مراجعة:** 2 نوفمبر 2026
**نوع الجلسة الحالية:** WA-005 / WA-007 — تثبيت دليل `configured=true` من تشغيلة الحافة `41456011988` (`main@2b47d62`) وإغلاق شق التهيئة التقنية مع إبقاء قبول الرقم والرسائل مفتوحًا.
**السجل:** [WhatsApp Edge verified 41456011988](sessions/2026-11-02-whatsapp-edge-verified-41456011988.md) · **الفرع:** `arena/07ae2211-phone-google` · **الأساس:** `main@2b47d62`. `v0.3.0` ما زال الإصدار الحي المعلن.

## 2 نوفمبر 2026 — WA-008: أيقونة دخول Google مفعّلة مع حساب سيليا (منفَّذة محليًا، لم تُنشر حيًا بعد)

- طلب المالك: إضافة أيقونة «الدخول بحساب Google» إلى شاشة حساب سيليا في `/whatsapp`، على أن تكون **مفعّلة مع النظام لا شكلية**. اختار صراحةً «دخول حقيقي بحساب Google» بدل اختصار ربط Workspace الخاص بالمالك (`DEC-114`).
- **ما نُفّذ:** زر بأيقونة Google الرسمية في `public/whatsapp.html` وتنسيق يتبع رموز السمة، يبدأ `GET /auth/google/signin`. التدفق يعيد استخدام Redirect URI المسجّل `/auth/google/callback` بحالة `signin:` وحيدة الاستخدام، ويطلب `openid email profile` فقط، ويتحقق خادميًا من `sub` و`email_verified` عبر userinfo، ثم يفتح جلسة `app_accounts` عبر `signInWithGoogleIdentity`. الهوية في جدول إضافي `0009_google_account_identities.sql`. لا ربط صامت بحساب بريد مسجّل بكلمة مرور، ولا تخزين رموز Google، ولا اعتماد على `APP_OWNER_EMAIL`، ولا تغيير في CSP أو إعداد Google Console.
- **الدليل المحلي:** `test/google-account-signin.test.js` (10 اختبارات) تغطي بدء التدفق، الجلسة الحقيقية، منع إعادة التشغيل، منع الاستيلاء على البريد، الهوية غير الموثّقة، فشل التبادل، وعدم تأثر تدفق المالك. `build:edge-ui` · `build:manifest` · `arch:map` · `verify:edge-provenance` ناجحة؛ الحزمة صارت **12 وحدة** و**40 عبارة / 9 ملفات هجرة**، وحدِّثت عدادات الاختبارات والخطتين تبعًا لذلك. [سجل الجلسة](sessions/2026-11-02-google-account-signin.md).
- **الحدّ الصريح:** لم يُنشر على الحافة الحية؛ الدخول الحقيقي يبدأ بعد دمج PR إلى `main` وتشغيلة `Deploy (Cloudflare Edge)` جديدة. موافقة Google من متصفح المالك لم تُختبر، ولا يُرفع أي مؤشر اكتمال (B1/B2/F4/F5) بهذه الشريحة.

## 2 نوفمبر 2026 — WA-005 / WA-007 — تثبيت `configured=true` على الحافة الحيّة (`41456011988` على `main@2b47d62`)

- دُمج PR #141 في `main@2b47d62479248bc613e055f59a0e72e791de8b0b`؛ نجحت تشغيلات `Celia quality & resilience` (`41455784604`) و`Deploy (GitHub Pages)` (`41455784652` — 13/13 مسارًا) و`Publish verified release` (`41455784637`) و`CodeQL` (`41455784653`) و`Deploy (Cloudflare Edge)` (`41456011988` · الوظيفة `125312744775`).
- أثبتت تشغيلة الحافة `41456011988` حيًا: `whatsapp-onboarding: configured=true` (بلا إعدادات ناقصة)، و`coreSecretBindings=18/18`، و`optionalSecretBindings=3` (`WHATSAPP_APP_SECRET` و`WHATSAPP_APP_ID` و`TOKEN_ENCRYPTION_KEY` مع ربط `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` نصيًا)، و`totalSecretBindings=21`، و`storage.mode=d1` مع `durable=true` (`latencyMs=107`)، و`Edge Provenance` (11 وحدة، `sha256:0230b6f65fbe…`)، وترقية الشريحة إلى `known_good` لـ`2b47d62`.
- **تمييز حاسم:** إغلاق شق **التهيئة التقنية والنشر** في `WA-005` و`WA-007` فقط؛ أما ربط رقم مملوك عبر نافذة Meta Embedded Signup من `/whatsapp`، وإرسال رسالة اختبار عبر Graph API، واستقبال رسالة واردة بـWebhook موقّع وإيصال تسليم، واختبار عزل الرسائل بين حسابي مستخدمين عاديين، فتبقى مفتوحة للقبول الحي.
- مؤشرات الاكتمال الرسمية تبقى دون ترفيع تلقائي: `B1 = 5.5/8`، `B2 = 2.5/6`، المهارات النشطة `L5 = 0/17`، المهام المفتوحة `59` (`22 P0`). التفاصيل في [سجل الجلسة](sessions/2026-11-02-whatsapp-edge-verified-41456011988.md).

## 2 نوفمبر 2026 — WA-005 / DES-002 — توثيق دمج #138 و#140 وإعادة نشر الحافة بعد إضافة الأسرار

- دُمج PR #138 (`main@167fcb7`) ثم PR #140 (`main@b5d3f3c`) لإصلاح بصمة الكتلة ب في `STATE-ARCHIVE-2026-11.md` (`SA-01`)؛ نجحت على `b5d3f3c` تشغيلات `Celia quality & resilience` (`41445712732`) و`Deploy (GitHub Pages)` (`41445712744`) و`Publish verified release` (`41445712767`) و`CodeQL` (`41445712752`) و`Deploy (Cloudflare Edge)` (`41445911518`).
- تشغيلة الحافة `41445911518` (`2026-11-02T12:35:13Z` على `b5d3f3c`) أثبتت `status=deployed` و`liveReady=true` و`storage.mode=d1` و`durable=true` و`coreSecretBindings=18/18` و`optionalSecretBindings=1` (`WHATSAPP_APP_SECRET`) وترقية الشريحة إلى `known_good`، لكنها أخرجت `whatsapp-onboarding: configured=false — missing: Meta app, Embedded Signup configuration, encryption key` لأنها سبقت إضافة المالك لـ`TOKEN_ENCRYPTION_KEY` ومعرّفات Meta.
- أفاد المالك بإضافة `TOKEN_ENCRYPTION_KEY` ومعرّفات Meta وطلب دفعًا جديدًا إلى `main` لتشغيل `Deploy (Cloudflare Edge)` وربط الإعدادات الجديدة وتحديث `whatsappOnboarding.configured`. التفاصيل في [سجل الجلسة](sessions/2026-11-02-whatsapp-onboarding-edge-redeploy.md).

## 2 نوفمبر 2026 — DES-002 — إصلاح CodeQL وتجهيز handoff

- رأس الفرع قبل إصلاح الأمن `3b3069d`; أُنشئ commit محلي `82122a1` لقراءة `SKILL.md` من واصف ملف واحد بعد `open` و`fstat`، مع `O_NOFOLLOW` حيث يدعمه النظام، واختبار رابط رمزي خارجي. نتيجة الاختبار المركز `11/11` و`npm run check` فحص 260 ملفًا بنجاح.
- PR #138 مفتوح كمسودة. تشغيل الدفع السابق `41434737671` نجح على SHA الأقدم؛ تشغيل PR `41438061000` فشل ببوابة handoff، وفحص CodeQL `125253362117` وجد ثغرة عالية قبل الإصلاح. لم تُشغّل فحوص PR بعد على `82122a1`.
- live `/readyz`: `ready=true`, D1 durable/read-back، `0.3.0@322d5350f8836d447d6057e761cddf3aab84c83d`. صفحة `version.json` تعرض SHA نفسه، وهو يطابق `main` الحالية لا SHA الإصدار immutable `7596c27`؛ يبقى هذا التعارض موثقًا ولا يُحسم ضمن DES-002.
- `/healthz`: `whatsappOnboarding configured=false` وتنقص قيم Meta app/config/app secret ومفتاح التشفير. `googleOAuth configured=true`، لكن حالة ربط/consent لم تُتحقق مباشرة. لم تُقرأ أسرار GitHub؛ API أعاد 403 والمتصفح انتهى بمهلة.
- محليًا `npm test` و`npm run check:secrets` لم يكتملَا بسبب غياب الاعتماد `dotenv` في `node_modules`; لم يُشغّل `npm ci`. خمس المهارات ما زالت `draft`؛ لا تفعيل دون مراجعة المالك وتشغيل مستقل وبوابات DEC-112. Render غير مهيأ وفق مسار «بلا بطاقة»؛ لا خدمة أو كلفة أُنشئت.
- مؤشرات خطة الاكتمال ما تزال `B2=2.5/6`, `L5=0/17`, `F5=0/2`; DES-002 شريحة جزئية وليست اكتمال النظام.
- `npm run now:check`, `npm run plan:check` (59 مهمة؛ continuity `141/437/123`), `npm run visual:first:check` و`check:continuity` بعد commit التوثيق ناجحة؛ الأخيرة تحققت من 141 وثيقة و437 رابطًا و123 مهمة بلا دورات اعتماد.
- التالي: دفع الفرع المعيّن فقط، ثم التحقق من CodeQL وCI الجديدين وتسجيل أرقام التشغيل. لا دمج قبل صفر فحوص معلّقة/فاشلة وكلمة مالك صريحة بالدمج.

## 2 نوفمبر 2026 — REL-003 — نتيجة النشر الحي

- PR #136 → `main@7596c27`; `v0.3.0` نُشر immutable عند SHA نفسه (run `41399947570`, 5 أصول/OIDC).
- Edge `41400115739`: النسخة والـSHA مطابقان؛ D1 durable/read-back و`known_good`.
- Pages `41399947941`: 13/13 route. تحقق لاحقًا من جسم `version.json` الحي: `0.3.0@322d535`; لم يطابق SHA الإصدار immutable `7596c27`، لذا يلزم توضيح معيار المطابقة قبل إغلاق REL-003.
- Render `41400115801` `not-configured`; audit `41399947513` `skipped`; WhatsApp ما زال `configured=false`. Google OAuth مضبوط في health لكن consent/connected غير متحقق هنا. لا أسرار مقروءة أو موافقات متجاوزة.
- معيار PLAN-002 §1 ما زال مفتوحًا (59 مهمة). التفاصيل في [سجل الجلسة](sessions/2026-11-02-release-0.3.0.md) و[سجل النشر](../deployments/ledger.json).

## 0. خط الأساس والدرجة

- **الإصدار:** `v0.2.1` · `schema=1` · Node `>=22`. **لا ترقية إصدار ولا ترحيل جديد في هذه الشريحة.**
- **الجودة (بعد هذه الدفعة):** `npm test` **1149 اختبارًا / 1133 ناجحًا / 0 فشل / 16 skipped**، و`check` 236 ملفًا؛ والبوابات المرافقة ناجحة.
- **السلّم:** S1/A4 ✅ · S5: C1-a ✅ · C1-b ✅ · C2-a ✅ · **C2-b (`web.search`) مؤجّلة** بقرار المالك · C3/C4 موقوفة على بيئة بلا Chromium.

## 1. حدود هذه الدفعة

1. **لا تغيير سلوك مرئي بلا تحقق بصري:** القيم المنقولة مطابقة بايتًا لقيمها الأصلية.
2. **`theme.css` وحده يحمل اللون الحرفي**؛ و`landing.css`/`fonts.css` خارج البوابة بقائمة ratchet تنكمش فقط (THM-02).
3. **الملفات المولّدة لا تُحرَّر مباشرة** (`computer-permissions.html`، `whatsapp-ui.generated.js`).
4. **الإيجابيات الكاذبة مسجّلة لا معمَّمة** (قواعد 67 و49 و73).

## 2. الاستئناف والفحوص

1. ابقَ على فرع الجلسة المعيَّن؛ اقرأ [سجل الهجرة](sessions/2026-10-31-color-tokens-migration.md) قبل تعديل أي `public/*.css`.
2. **قاعدة التسمية:** لا تُسمِّ رمزًا بكلمة لون؛ الاسم يصف الدور (`--t-sheen`). والشفافية بـ`color-mix` من رمز لا برقم.
3. صفحة تستورد `theme.css` بلا مبدّل ⇒ تُضاف إلى `SINGLE_IDENTITY` في `test/theme-tokens.test.js` (THM-04).
4. بعد تعديل `theme.css` أو `styles.css`: `npm run build:edge-ui` وإلا فشل `VER-07`.

```sh
git branch --show-current && git status --short && git log -3 --oneline
npm run now && npm run now:check && npm run check:continuity
npm run check && npm test && npm run build:manifest
npm run arch:map && npm run atlas && npm run atlas:facts
```
