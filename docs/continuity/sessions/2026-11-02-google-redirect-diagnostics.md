# تسليم جلسة — 2026-11-02 — تشخيص حالة قبول عنوان العودة (WA-010)

## المهمة والتفويض

- **طلب المالك (بعد WA-009):** «أتحقق حيًا الآن من نتيجة الإضافة» — أي هل قَبِل Google الإعداد بعد إضافته في Console؟ الطلب فحص وتحقق، لا تغيير إعدادات ولا نشر.
- **النطاق المسموح:** قراءة حيّة، وإضافة مسار تشخيص للقراءة فقط + توسيع الصفحة العربية القائمة + اختبارات + توثيق الاستمرارية. **خارج النطاق:** تعديل Google Cloud Console، تغيير `client_id`، نشر جديد، دمج إلى `main`، رفع مؤشرات اكتمال.

## واقع البداية (كل ما يلي بقياس فعلي اليوم، 19:21–19:36Z)

| الفحص | الأداة | النتيجة |
|---|---|---|
| `/healthz` على الحافة | طلب شبكي | `ok: true` · `googleOAuth.configured: true` · `0.3.0` على `10fdfad…` · `18/18` سرًا — النشر سليم |
| `GET /auth/google/signin?cachebust=…` | جلب صفحة | صفحة الإعداد العربية «خطوة واحدة متبقية…» — أي أن المسبار لا يزال يرى رفضًا |
| `accounts.google.com/o/oauth2/v2/auth` بنفس `client_id` ونفس `redirect_uri` | طلب مباشر إلى Google متجاوزًا نظامنا | `Error 400: redirect_uri_mismatch` — **الرفض من Google نفسه لا من كاشنا** |
| نفس الطلب مع `http://localhost:3000/auth/google/callback` ومع `…onrender.com/auth/google/callback` | طلبان مستقلان | رُفضا أيضًا — **لا عنوان عودة مسجّل على هذا العميل أصلًا**، وسر الرفض لم يتغير |
| `GET /auth/google/diagnostics` | جلب | `{"error":"not_found"}` — المسار الجديد هذا لم يُنشر بعد |

**الاستنتاج:** لا خلل كود ولا كاش ولا نشر أخفق؛ `client_id` لم يُسجَّل عليه أي عنوان عودة. وحالة «لم يُحفظ» و«حُفظ ولم يوزّع بعد» تُظهران الخطأ نفسه، وهذه هي الفجوة التي تعالجها هذه الشريحة.

## ما تغير فعليًا

| الملف | الغرض |
|---|---|
| `workers/celia-edge/google-account.js` | `googleRedirectDiagnostics()`: تعيد الحكم نفسه الذي تراه الصفحة، كبيانات — `ok`, `clientId`, `redirectUri`, `redirectUriProblem` (`points_at_localhost` / `explicit_env_override` / `derived_from_request_origin`), `google.accepted`, `google.reason`, `consoleUrl`, `nextStep`, `instructions`, `secretExposed`. و`renderGoogleRedirectSetupPage()` صارت تُدرج قسم «إن بقي الرفض بعد الحفظ» بالأسباب الأربعة (عميل مختلف، مشروع مختلف، الحرفية و**Save**، الانتشار 5–10 دقائق) وتذكر **Test users** وتربط المسار التشخيصي. |
| `workers/celia-edge/worker.js` | مسار `GET /auth/google/diagnostics` قبل تدفق الدخول، بترويسة `cache-control: no-store`، و`405` لغير GET. |
| `test/google-account-signin.test.js` | اختباران: JSON عند الرفض والقبول (مع `no-store` و`405` وغياب السر و`oauth_states = 0` وعدم إرسال كوكي)، ومحتوى صفحة الإعداد الموسّعة. |
| `docs/continuity/BACKLOG.md` · `DECISIONS.md` (`DEC-116`) · `STATE.md` · `NOW.md` | صف WA-010 والقرار وواقع الاستئناف والمشتقات. |

## الفحوص (مُنفَّذة الآن في هذا الصندوق)

| الأمر | النتيجة |
|---|---|
| `npm ci` | نجح |
| `node --test test/google-account-signin.test.js` | **14/14** ناجح (كان 12، أُضيف 2) |
| `npm test` | **1260 اختبارًا: 1243 ناجح · 0 فشل · 17 متخطى** |
| `npm run check` | 261 ملفًا سليم |
| `npm run build:edge-ui` · `build:manifest` · `arch:map` · `verify:edge-provenance` | ناجحة — 12 وحدة، الحزمة `sha256:f8c21e2ba77f…` (تغيّرت بعد التعديل) |
| `npm run release:check` · `plan:check` · `check:continuity` · `now:check` | ناجحة (59 مهمة مفتوحة، 144 وثيقة، 442 رابطًا، 125 مهمة) |

## الدليل البصري

تغيير غير بصري بمعناه المعماري (مسار قراءة فقط + نص صفحة)؛ لم تُرسم وحدة جديدة في خريطة العمارة، وأُعيد توليد [architecture-map.html](../../design/architecture-map.html) من الاستيراد الفعلي. لا يوجد شكل جديد يستحق لوحة VFE؛ الصفحة العربية نفسها هي التأثير المرئي، ومصدرها `renderGoogleRedirectSetupPage()`.

## الحفظ والتسليم

- **الحالة:** تغييرات محلية على الفرع `arena/ee55f8c5-phone-google`؛ **لم يُنشر**، ولم تُقرأ قيمة سرية، ولم تُمسّ Google Console ولا D1 الحية.
- **العمليات الخطرة غير المنفذة:** الدفع إلى `main`، `Deploy (Cloudflare Edge)`، تعديل Redirect URIs، تغيير `client_id`، إنشاء عميل OAuth بالنيابة عن المالك.

## الاستئناف

1. دمج هذه الشريحة ونشرها، ثم `GET /auth/google/diagnostics` — القراءة الحالية يجب أن تُظهر `google.accepted: false` و`reason: "redirect_uri_mismatch"`؛ إن ظهر غير ذلك فالفرضية خاطئة ويُراجع `redirectUriProblem`.
2. بعد إضافة المالك للـURI و**Save**، يعيد المسار نفسه `google.accepted: true` ثم `GET /auth/google/signin` = `302` إلى Google، ثم `/api/account/me` = 200 بعد الموافقة.
3. ما زال مفتوحًا وبلا دليل: إضافة `celiaelazamey@gmail.com` في **Test users**، وخطآ Meta (Login with JavaScript SDK وApp Domains).
