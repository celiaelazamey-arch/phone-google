# تسليم جلسة — 2026-11-02 — أيقونة «الدخول بحساب Google» مفعّلة مع حساب سيليا

## المهمة والتفويض

- **طلب المالك:** «ضيف لها ايقونة للدخول بحساب جوجل مفعله مع نظامي» مع لقطة شاشة لشاشة «حساب سيليا» في صفحة `/whatsapp`.
- **التوضيح الذي طلبه الوكيل وأجاب عنه المالك:** أيقونة Google هل تعني دخولًا حقيقيًا أم اختصارًا لربط Workspace؟ اختار المالك **«دخول حقيقي بحساب Google»**: ينشئ جلسة حساب سيليا من هوية Google، لا زرًا شكليًا ولا رابط ربط المالك.
- **النطاق المسموح:** تعديل واجهة `/whatsapp` ومسار OAuth على الحافة وهجرة D1 إضافية واختباراتها وتحديث العدادات المشتقة. **خارج النطاق:** النشر على الحافة الحية، الدمج إلى `main`، تغيير إعدادات Meta أو Google Cloud Console، تغيير بوابة المالك، رفع مؤشرات الاكتمال.

## واقع البداية

- `public/whatsapp.html` يعرض «إنشاء حساب / تسجيل الدخول» بالبريد وكلمة المرور فقط، و`public/whatsapp.js` يستدعي `/api/account/*`.
- نظام Google OAuth الموجود (`/auth/google` → `/auth/google/callback`) مخصّص **لربط Workspace الخاص بالمالك**: يتطلب Bearer أو تذكرة موقّعة، يطلب نطاقات Gmail/Drive/Calendar، يتحقق من `APP_OWNER_EMAIL` عند ضبطه، ويحفظ refresh token مشفرًا في `google_credentials` — أي أنه ليس تسجيل دخول للمستخدمين العاديين.
- `/healthz` الحي على `main@49d435b` أظهر `googleOAuth.configured=true` و`whatsappOnboarding.configured=true`؛ لا علاقة لذلك بوجود تدفق Sign-In للمستخدمين.
- أحدث نشر Edge هو `41477065969` (15:59–16:00 UTC)؛ لا توجد تشغيلة نشر بعده.

## ما تغير فعليًا

| الملف | الغرض |
|---|---|
| `public/whatsapp.html` · `public/whatsapp.css` · `public/whatsapp.js` | زر بأيقونة Google الرسمية (SVG)، فاصل «أو»، تنسيق يتبع `--t-*`، معالج يبدأ التدفق، عرض أسباب الخطأ الثابتة، وتعطيل صادق للزر في نسخة المعاينة الثابتة. |
| `workers/celia-edge/google-account.js` | وحدة جديدة: `createGoogleAccountAuthUrl` (حالة `signin:` وحيدة الاستخدام في `oauth_states`، نطاقات `openid email profile` فقط، نفس Redirect URI) و`completeGoogleAccountSignIn` (تبادل الكود + userinfo + جلسة، دون حفظ أي رمز Google). |
| `workers/celia-edge/accounts.js` | `signInWithGoogleIdentity`: تحقق من `email_verified` و`sub`، منع ربط هوية Google بحساب بريد مسجّل بكلمة مرور، كلمة مرور عشوائية غير قابلة للتخمين لحساب Google فقط، إصدار جلسة HttpOnly. |
| `workers/celia-edge/runtime.js` | السماح بنمط `signin:` في حالة OAuth مع إلزام كوكي الحالة، وتفرّع الـcallback إلى تدفق الحساب **بعد** استهلاك الحالة وحيدة الاستخدام وقبل أي منطق خاص بالمالك. |
| `workers/celia-edge/worker.js` | مسار `GET /auth/google/signin` قبل بوابة المالك، ودعم إعادة توجيه 302 بكوكي الجلسة + مسح كوكي الحالة. |
| `workers/celia-edge/migrations/0009_google_account_identities.sql` | جدول إضافي `account_google_identities`؛ لا تعديل على `app_accounts`. |
| `workers/celia-edge/whatsapp-ui.generated.js` · `system.manifest.json` · `docs/design/architecture-map.html` | أُعيد توليدها من المصادر لا كتابة يدوية. |
| `test/google-account-signin.test.js` · `e2e/whatsapp.spec.js` | 10 اختبارات وحدة على D1 حقيقي في الذاكرة + تأكيدات على الأيقونة في اختبار المتصفح. |
| عدادات مشتقة | `test/deploy-cloudflare-edge.test.js` و`test/edge-reply-metrics.test.js` و`test/free-full-power-plan.test.js` و`docs/plan-free-full-power.md` و`docs/plan-system-completion.md` حُدّثت من 39/8/13/260 إلى 40/9/14/261 بعد القياس. |

**قرار جديد:** `DEC-114` في `DECISIONS.md`.

## الفحوص

| الأمر | النتيجة |
|---|---|
| `node --test test/google-account-signin.test.js test/whatsapp-onboarding.test.js test/browser-runtime.test.js test/google-consent.test.js` | 51/51 ناجح |
| `npm run build:edge-ui` · `npm run build:manifest` · `npm run arch:map` · `npm run verify:edge-provenance` | ناجحة؛ 12 وحدة، bundle `sha256:788d60c9…` |
| `npm run check` · `npm run release:check` | ناجحان؛ 261 ملفًا، `0.3.0` |
| `npm test` | أُعيد تشغيله بعد مزامنة العدادات؛ النتيجة النهائية في قسم الحفظ أدناه |

## الدليل البصري

[خريطة العمارة المولّدة من graf الاستيراد](../../design/architecture-map.html) تُظهر الوحدة الجديدة `google-account.js` في مكانها من حزمة الحافة؛ لم تُرسم قدرة جديدة يدويًا، ولم يُرفع أي شكل إلى حالة «متحقق» قبل دليل حيّ. الأيقونة نفسها SVG داخل `public/whatsapp.html`.

## الحفظ والتسليم

- **الحالة:** تغييرات محلية على الفرع `arena/fa5a3432-phone-google`؛ لم يُشغَّل نشر ولم تُقرأ قيمة سرية ولم تُمسّ قاعدة البيانات الحية ولا إعدادات Meta/Google.
- **العمليات الخطرة غير المنفذة:** دمج إلى `main`، `Deploy (Cloudflare Edge)`، تعديل Redirect URIs في Google Console، تغيير CSP، تفعيل مهارة، نشر إصدار.

## الاستئناف

- **العائق:** الدخول الحقيقي يحتاج تشغيلة نشر جديدة على `main` بعد مراجعة ودمج PR من هذا الفرع؛ قبلها يعمل التدفق محليًا فقط في الاختبارات.
- **أول فحص آمن بعد النشر:** فتح `/whatsapp` على الحافة الحية والتأكد من ظهور الزر غير معطّل، ثم `GET /auth/google/signin` يجب أن يعيد 302 إلى `accounts.google.com` بنطاقات `openid email profile`، وبعد موافقة المالك تعود الصفحة بجلسة حساب (`/api/account/me` = 200). لا تُختبر الموافقة باسم مستخدم آخر ولا تُرفع مؤشرات B1/B2/F4/F5.
