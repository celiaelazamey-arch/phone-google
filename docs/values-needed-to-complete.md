# قائمة القيم الخارجية اللازمة لإكمال النظام

**مراجعة:** 2 نوفمبر 2026 · **الغرض:** قائمة موحّدة بأسماء الإعدادات والقيم التي قد يحتاج المالك إلى إدخالها أو تأكيدها. هذه ليست ملف أسرار؛ لا تضع القيم السرية الفعلية هنا أو في Git أو المحادثة.

> لا أستطيع قراءة محتوى GitHub Actions Secrets أو حسابات Google/Meta/Render من نسخة المستودع. لذلك تسجل هذه القائمة **الأسماء والمصدر والمكان**، لا القيم الفعلية. أدخل الأسرار مباشرة في لوحة الجهة المالكة.

## الخلاصة

- **إصلاحات Dependabot وقراءة D1 التي أُضيفت في هذا الفرع لا تتطلب قيمة خارجية جديدة.** لا يلزم `CELIA_D1_DATABASE_ID`؛ يحمله مسار النشر من artifact داخلي.
- دليل آخر نشر موثق على `main@3aa4024` أظهر `18/18` من أسماء الربوط الأساسية، لكنه لا يثبت اتصال Google أو تهيئة Meta/WhatsApp. لم تُفحص قيم الأسرار نفسها.
- آخر تشخيص موثق لـWhatsApp ذكر نقص تطبيق Meta وإعداد Embedded Signup وسر التطبيق ومفتاح التشفير. هذا تشخيص تاريخي؛ لم يُجرَ نشر أو فحص حي بعد التغييرات المحلية.
- Render بقي `not-configured` عمدًا، و`HOST-003` قرار منفصل؛ لا يحتاجه مسار Edge+D1 بلا بطاقة.

## 1. Google — ربط حساب المالك

| الاسم/الإعداد | المصدر أو القيمة المطلوبة | أين يُضبط | الحالة/الملاحظة |
|---|---|---|---|
| `GOOGLE_CLIENT_ID` | OAuth Client من نوع **Web application** في Google Cloud Console | GitHub → Settings → Secrets and variables → Actions → **Secret** | موجود ضمن قائمة الربوط الأساسية تاريخيًا؛ تحقق من صلاحيته ولا تنشئ بديلًا إن كان صحيحًا |
| `GOOGLE_CLIENT_SECRET` | السر المطابق لنفس OAuth Client | المكان نفسه → **Secret** | لا يُشارك خارج لوحة الأسرار |
| Authorized redirect URI | `https://celia-phone-google.celiaelazamey.workers.dev/auth/google/callback` | Google Cloud Console → OAuth Client → Authorized redirect URIs | يجب أن يطابق حرفيًا؛ `GOOGLE_REDIRECT_URI` في بيئة Worker اختياري إن استُخدم الأصل الافتراضي |
| `APP_OWNER_EMAIL` | بريد المالك الذي سيُقيّد به الربط عند تفعيله | GitHub Actions → Repository **Variable** أو **Secret** | متغير مالك؛ لا تضعه في ملف عام إذا كان خاصًا |
| موافقة المالك | تسجيل الدخول إلى حساب Google والموافقة على النطاقات التي تعرضها شاشة OAuth | صفحة التفويض التي يعيدها `/auth/google/link` | إجراء مالك، لا قيمة سرية. راجع النطاقات الظاهرة قبل الموافقة؛ نطاق `calendar.events` أوسع من القراءة فقط |

**القيمة المشتركة:** يلزم `TOKEN_ENCRYPTION_KEY` لتشفير بيانات OAuth المحفوظة في D1 أيضًا. مواصفة توليده أدناه في قسم WhatsApp.

**بوابة النجاح:** `/api/google/status` يعيد `connected: true` بعد الموافقة، ثم اختبار قراءة مصرح به. لا يُعد وجود Client ID/Secret وحده اتصالًا.

## 2. WhatsApp — مسار Meta Embedded Signup الحالي

### القيم المطلوبة لفحص `configured=true`

| الاسم | المصدر أو الصيغة | أين يُضبط |
|---|---|---|
| `WHATSAPP_APP_ID` | App ID الرقمي من Meta for Developers | GitHub Actions → **Variable** أو **Secret** |
| `WHATSAPP_APP_SECRET` | App Secret من Meta → App Settings → Basic | GitHub Actions → **Secret** |
| `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` | Configuration ID من Facebook Login for Business → Configurations | GitHub Actions → **Variable** أو **Secret** |
| `TOKEN_ENCRYPTION_KEY` | 32 بايت عشوائية ممثلة بـBase64 | GitHub Actions → **Secret**؛ مشتركة مع تشفير Google/D1 |

توليد المفتاح محليًا، دون طباعته أو إرساله إلى المحادثة:

```sh
openssl rand -base64 32
```

احتفظ بنسخة آمنة منه. تغيير المفتاح بعد حفظ بيانات مشفّرة قد يمنع فكها، ما لم تُجهّز خطة تدوير مفاتيح متوافقة.

### إعداد Meta غير السري

- تطبيق Meta من نوع Business مع منتج WhatsApp وFacebook Login for Business / Embedded Signup.
- صلاحيتا Embedded Signup: `whatsapp_business_management` و`whatsapp_business_messaging`.
- النطاق المسموح: `celia-phone-google.celiaelazamey.workers.dev`.
- عنوان Webhook: `https://celia-phone-google.celiaelazamey.workers.dev/webhooks/whatsapp`.
- إصدار Graph API: الافتراضي `WHATSAPP_API_VERSION=v26.0`؛ لا يلزم تعيينه ما لم يختر المالك إصدارًا آخر مدعومًا.

**تمييز مهم:** في Embedded Signup تُجمع بيانات الرقم/الرمز خلال رحلة الربط وتُحفظ للحساب؛ لا تُدخل `WHATSAPP_ACCESS_TOKEN` أو `WHATSAPP_PHONE_NUMBER_ID` يدويًا لمجرد جعل `whatsappOnboardingConfig` جاهزًا. أما مسار الربط اليدوي القديم فيحتاجهما، وقد يحتاج `WHATSAPP_VERIFY_TOKEN` لمصافحة Webhook. `WHATSAPP_VERIFY_TOKEN` ليس من شروط `configured=true` في فحص Embedded Signup الحالي.

**بوابة النجاح:** ملخص النشر يقول `whatsapp-onboarding: configured=true`، ثم يربط المالك رقمًا حقيقيًا/اختباريًا ويثبت رسالة واردة وصادرة. لا تُرسل أي قيمة Meta سرية هنا.

## 3. القيم الأساسية المسجّلة للنشر الحالي — تحقق لا إعادة إدخال

الأسماء التالية هي قائمة `SECRET_KEYS` التي كان التقرير التاريخي يعدّها `18/18`. العدد يثبت وجود bindings في تلك التشغيلة فقط، ولا يعني أن كل خدمة متصلة أو أن كل مفتاح مطلوب لكل ميزة. أعد إدخال قيمة فقط إذا تبيّن من إعدادات المالك أنها غير موجودة أو منتهية.

```text
AGENETROUTERAPI_KEY
AI_GATEWAY_API_KEY
CELIAOS_CRONJOB_ORG_API_KEY
CELIA_MCP_API_TOKEN
CELIA_VOICE_ID
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
CLOUDFLARE_R2_ACCESS_KEY_ID
CLOUDFLARE_R2_S3_ENDPOINT
CLOUDFLARE_R2_SECRET_ACCESS_KEY
DEEPSEEK_API_KEY
ELEVENLABS_API_KEY
FIGMA_ACCESS_TOKEN
GEMINI_API_KEY
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
PHONE_NUMBER
YOUR_CODATA_API_KEY
```

- `CLOUDFLARE_ACCOUNT_ID` و`CLOUDFLARE_API_TOKEN`: بيانات تشغيل النشر، ولا تحتاج تغييرًا بسبب إصلاحات هذا الفرع.
- `CELIA_MCP_API_TOKEN`: رمز مالك يُستخدم مع `/auth/google/link`؛ لا تضعه في رابط أو ملف عام.
- مفاتيح المزوّدين الأخرى تخص ميزات اختيارية/محددة؛ لا تفعّل خدمة أو فوترة جديدة لمجرد ظهور اسمها هنا.
- `TOKEN_ENCRYPTION_KEY` **ليس** ضمن قائمة الـ18 أعلاه، وهو إعداد إضافي منفصل.
- قيمة `CELIA_TIMEZONE` الحالية `Africa/Cairo`، وGraph API الافتراضي `v26.0`؛ لا يلزم تغييرهما الآن.

## 4. Render + Aiven/MySQL — مشروط بقرار إعادة فتح `HOST-003`

هذه القيم **ليست مطلوبة** لإكمال مسار Edge+D1 الحالي. لا تنشئ حسابًا أو خدمة مدفوعة، ولا تتجاوز مطالبة البطاقة. إذا قرر المالك تشغيل الخادم الكامل Express+MySQL لاحقًا:

| الاسم | المصدر/الصيغة | الوجهة |
|---|---|---|
| `RENDER_API_KEY` | Render Account Settings → API Keys | GitHub Actions **Secret** |
| `RENDER_SERVICE_ID` | Render service Settings → Service ID (`srv-…`) | GitHub Actions **Secret**؛ اختياري إذا اكتُشفت الخدمة بالاسم |
| `RENDER_DEPLOY_HOOK_URL` | Render service → Deploy Hook | GitHub Actions **Secret**؛ بديل لمفتاح API، لا يُستخدم معه عادة |
| `CELIA_LIVE_URL` | رابط HTTPS الفعلي لخدمة Render | GitHub Actions **Variable** أو **Secret**؛ يُكتشف تلقائيًا عند استخدام API key |
| `MYSQL_HOST` | اسم مضيف Aiven | Render Environment فقط |
| `MYSQL_PORT` | منفذ MySQL من Aiven | Render Environment فقط |
| `MYSQL_DATABASE` | قاعدة جديدة مخصصة وفارغة | Render Environment فقط |
| `MYSQL_USER` | مستخدم القاعدة | Render Environment فقط |
| `MYSQL_PASSWORD` | كلمة مرور Aiven | Render Environment **Secret** فقط |
| `MYSQL_SSL_CA_BASE64` | شهادة CA الخاصة بـAiven بصيغة Base64 | Render Environment **Secret** فقط |
| `APP_BASE_URL` | أصل HTTPS الفعلي لخدمة Render | Render Environment؛ يُستخدم لبناء callback والروابط |

يولد Blueprint قيمتي `CELIA_MCP_API_TOKEN` و`TOKEN_ENCRYPTION_KEY` عند إنشاء الخدمة. يلزم تشغيل `verify:live` على الرابط الحقيقي قبل اعتبار HOST-003 مكتملًا. لا تخلط أسرار GitHub Actions مع بيئة Render؛ لا تنتقل تلقائيًا.

## 5. المطلوب لإكمال الخطة لكنه ليس «قيمة» سرية

- **Service reality audit:** أحدث تدقيق للخدمات الأربعين كان `skipped` على SHA المقصود. يلزم تشغيل تقرير قابل للفحص على SHA الحالي؛ وبعده يقرر المالك لكل خدمة غير جاهزة: تفعيل بقيمة مزوّد صالحة، أو تقاعد موثق، أو إبقاؤها خارج النطاق. لا توجد قائمة أسرار واحدة يمكن اعتمادها بدل التقرير.
- **`REL-003`:** قرار المالك بشأن إصدار `0.3.0` أو تعريف صريح للإصدار المجمد `0.2.1`؛ هذا قرار إصدار، لا قيمة سرية.
- **`GOV-001`/قواعد الدمج:** ضبط ومراجعة حماية `main` والـrequired checks؛ إجراء لوحة، لا قيمة API.
- **الدليل الحي:** بعد وصول التعديلات إلى `main`، يحتاج المالك تشغيل النشر/القبول المصرح به لإنتاج قراءة D1 بعد الترقية. لم يُنفذ نشر أو ترحيل إنتاجي في هذه الجلسة.

## مكان إدخال الأسرار بأمان

GitHub: **Repository → Settings → Secrets and variables → Actions**. أدخل السر في الجهة المناسبة، ولا تضع قيمته الفعلية في هذا الملف أو في commit أو issue أو محادثة. لا أحتاج استلام كلمات مرور أو مفاتيح أو رموز منك؛ يكفي إبلاغي باسم الإعداد وحالة نجاح الفحص بعد أن تدخله بنفسك.

## 6. ما يمكن جلبه تلقائيًا وما لا يمكن

**نعم، بيانات التفويض الخاصة بالحساب يمكن جلبها بعد موافقة صاحب الحساب**؛ وهذا هو الغرض من OAuth وEmbedded Signup، وليس استخراج أسرار التطبيق:

- **Google:** بعد اختيار الحساب والموافقة، يتبادل الخادم authorization code مع Google، يتحقق من البريد/المالك عند ضبط `APP_OWNER_EMAIL`، ثم يحفظ رموز OAuth مشفّرة في D1 تحت `user_id`. إعادة الربط للمستخدم نفسه تحدّث صفه؛ والفصل يحذف ربطه. `APP_OWNER_EMAIL` الحالي، إن كان مضبوطًا، سيمنع ربط حساب Google مختلف حتى يغيّره المالك صراحةً. لا يحدث تبديل صامت بلا موافقة OAuth جديدة.
- **WhatsApp:** Embedded Signup يجلب بيانات اتصال نشاط WhatsApp، ومنها رقم العمل ومعرّف الهاتف ورمز الوصول، ويحفظها مشفّرة لكل `user_id`. إعادة الربط تحدّث اتصال هذا المستخدم، ويرفض النظام حاليًا ربط معرّف الهاتف نفسه بمستخدم آخر.
- **رقم الهاتف الشخصي لا يُستخرج من Google تلقائيًا في التدفق الحالي.** رقم WhatsApp Business يأتي من Meta بعد التفويض؛ وإذا كان المطلوب رقم مالك لأوامر النظام، فيُضبط/يُتحقق منه كإعداد مستقل. لا تعتمد رقم الهاتف وحده لإثبات الهوية؛ فقد يتغير مالكه.

**لا يمكن ولا ينبغي جلب هذه الإعدادات من مجرد تسجيل Google أو إدخال رقم هاتف:** `GOOGLE_CLIENT_ID/SECRET`، و`WHATSAPP_APP_ID/APP_SECRET/EMBEDDED_SIGNUP_CONFIG_ID`، ومفتاح التشفير، ورموز Cloudflare/Render/Aiven. هذه بيانات تطبيق/بنية يملكها المسؤول، وتُهيأ مرة واحدة في مخزن الأسرار. كذلك لا يستطيع Google كشف سر OAuth الخاص بالتطبيق للمستخدم بعد تسجيل الدخول.

المراجع البرمجية الحالية: `workers/celia-edge/runtime.js` (Google OAuth والتشفير/التحديث)، و`workers/celia-edge/whatsapp-onboarding.js` و`workers/celia-edge/whatsapp-store.js` (Embedded Signup والتخزين لكل مستخدم).