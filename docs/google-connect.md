# ربط حساب Google — الحقيقة الكاملة وخطوات التنفيذ

**التاريخ:** 27 أكتوبر 2026 · **الحالة:** الكود موجود ومختبر (95/95 اختبار وحدة في المجموع، 12 منها للربط)، لكن **لم يُربط حساب حقيقي بعد**
(لا `GOOGLE_CLIENT_ID` في هذه البيئة، ولا نطاق HTTPS عام). هذه الوثيقة تصف ما هو منفذ فعلًا، وما يحتاج إجراءك،
وما ينقص ليكون الربط من داخل الدردشة.

## 1. الحكم أولًا: لا تنسخ المقتطف المقترح في محادثة أخرى

الكود الذي اقترحته المحادثة الأخرى (`app.get('/auth/google', …)` مع `state: req.query.phone` وحفظ
`JSON.stringify(tokens)` في `users.google_token`) **قديم ومكرر وغير آمن** في هذا المستودع. الأسباب مُثبتة بالكود:

| الاقتراح الخارجي | الواقع في هذا المستودع | لماذا الاقتراح غير صالح هنا |
|---|---|---|
| يُضاف في `src/server.js` | `src/server.js` **14 سطًرا فقط**: تحميل `.env` ثم `createApp` ثم `listen` — لا مسارات فيه | المسارات في `src/google.js` وتُركَّب في `src/app.js`؛ الإضافة في `server.js` لن تعمل |
| `const { google } = require('googleapis')` | المشروع ESM (`"type": "module"`) | `require` يُكسر التشغيل كليًا |
| `state: req.query.phone` | `crypto.randomBytes(32)` + تخزين `state_hash` في `oauth_states` بانتهاء 10 دقائق + استخدام واحد + مطابقة `safeEqual` مع كوكي `httpOnly` | `state` مأخوذ من المستخدم = ثغرة **CSRF**؛ أي زائر يستطيع إتمام ربط حساب على حسابك |
| `UPDATE users SET google_token = ?` | جدول `google_credentials.encrypted_tokens` بتشفير **AES-256-GCM** (`src/security.js`) | لا يوجد جدول `users` في `sql/schema.sql`، والتوكنات الخام في قاعدة البيانات ممنوعة |
| `https://yourdomain.com/...` مكتوب | `GOOGLE_REDIRECT_URI` من البيئة مع افتراضي مشتق من `APP_BASE_URL` | قيمة ثابتة تُعطّل كل بيئة غير النطاق المكتوب |
| `scope: calendar` | `calendar.events` (أضيق) + `openid/email` للتحقق من هوية المالك | `calendar` تعني قراءة وكتابة كل التقويم؛ توسيع صلاحية بلا حاجة |
| بلا `prompt: 'consent'` | موجود | بدونه كثيرًا لا يعود `refresh_token`، فينقطع الربط عند أول انتهاء ساعة |
| بلا تحقق هوية | `verifyIdToken` مقابل `APP_OWNER_EMAIL` (`email_verified`) | يمنع ربط حساب Google شخصي آخر بالخطأ أو عمدًا |

**فعلًا الآن:** لا أحد يحتاج كتابة كود ربط جديد. الفجوة ليست في الكود بل في **ملف الاعتماد والنطاق العام**،
ثم في **رابط أحادي الاستخدام** ليتم الربط من الدردشة بلا كشف رمز الـAPI (GOOG-001 أدناه).

## 2. خطوات Google Cloud (مرة واحدة، ~5 دقائق)

1. <https://console.cloud.google.com> ← **New Project** ← الاسم: `Celia Personal Assistant`.
2. **APIs & Services → Library** ← فعّل الأربعة: **Gmail API**، **Google Calendar API**، **Google Drive API**،
   **People API**.
3. **OAuth consent screen**: اختر **External** ثم أكمل الاسم وبريد الدعم. أثناء التطوير أبقِ النشر على
   **Testing** وأضف بريدك في **Test users** — بهذا لا تحتاج تحقق Google. (الاستخدام العام لاحقًا يحتاج التحقق،
   خصوصًا للنطاقات الحساسة مثل Gmail وDrive.)
4. **Credentials → Create credentials → OAuth client ID → Web application**.
   - **Authorized redirect URIs** يجب أن تطابق `GOOGLE_REDIRECT_URI` **حرفيًا**:
     - محليًا: `http://localhost:3000/auth/google/callback`
     - إنتاج: `https://<نطاقك-العام>/auth/google/callback`
   - لا تستخدم مسارًا آخر ولا شرطة زائدة ولا `http` في الإنتاج.
5. انسخ `Client ID` و`Client secret` إلى مخزن الأسرار فقط.

> **مهم:** لا ترسل `Client secret` في أي محادثة (ولا حتى لي). لا حاجة لإرسال `Client ID` أيضًا — ضعه في
> `.env` أو في متغيرات المنصة بنفسك. سكربت السبّابة (SPDR-002) يحتاج عميلًا من نوع **Desktop app** منفصلًا؛
> لا تخلط بين الاثنين.

## 3. أين تُوضع القيم

**محليًا** في `.env` (متجاهل في Git، ولا يُرفع أبدًا):

```
APP_BASE_URL=http://localhost:3000
APP_API_TOKEN=<32 حرفًا عشوائيًا على الأقل>
TOKEN_ENCRYPTION_KEY=<openssl rand -base64 32>
APP_USER_ID=owner
APP_OWNER_EMAIL=<بريدك في Google — يلزم لتحقق الهوية>
APP_OWNER_PHONE_E164=+20…
GOOGLE_CLIENT_ID=<من Google Cloud>
GOOGLE_CLIENT_SECRET=<من Google Cloud>
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
```

**لدى المنصة (Render)** نفس الأسماء في **Environment** — لا Repository secrets إلا إذا أضفت خطوة CI تقرؤها
صراحةً (حاليًا لا توجد).

## 4. كيف يتم الربط اليوم (قبل GOOG-001)

المسار `/auth/google` محمي بـ`Authorization: Bearer <APP_API_TOKEN>` — وهذا مقصود: فتح رابط الربط لأي زائر
يسمح لأي شخص بإتمام ربط حساب على حسابك. والطريق المباشر غير مريح لأن المتصفح لا يرسل ترويسات مخصّصة عند
فتح رابط، ومعه كوكي `google_oauth_state` يُضبط من الخادم. لهذا يوجد اليوم طريقان يعملان:

**الطريق (أ) — محليًا على جهازك، خطوتان:**

```sh
# 1) اطلب الرابط واقرأ Location وكوكي الحالة
curl -si -H "Authorization: Bearer $APP_API_TOKEN" \
  http://localhost:3000/auth/google | grep -iE '^(location|set-cookie):'
```

انسخ قيمة `google_oauth_state` من `set-cookie`، ثم في **DevTools → Console** على نفس الأصل
(`http://localhost:3000`) تنفّذ السطر التالي، وتفتح بعده رابط `location` الذي نسخته:

```js
document.cookie = 'google_oauth_state=<القيمة-المطبوعة>; path=/auth/google/callback; sameSite=lax';
```

**الطريق (ب) — عندك وصول لـ`APP_API_TOKEN` من عميل HTTP:** استخدم أي عميل يرسل ترويسة Bearer ويعرض
`Location`، ثم كرّر خطوة الكوكي في المتصفح.

ثم في الحالتين:

1. سجّل دخول Google بالبريد المطابق لـ`APP_OWNER_EMAIL` واقبل الصلاحيات.
2. تعود إلى `/auth/google/callback` برسالة **«Google account connected»** ويُخزَّن التوكن مشفّرًا في
   `google_credentials` مع `refresh_token`.
3. تحقّق: `curl -H "Authorization: Bearer $APP_API_TOKEN" "http://localhost:3000/api/google/calendar/events?maxResults=1"`
   يجب أن يعيد `200` لا `409`.

**لماذا هذا مرهق؟** لأن الربط صُمّم ليكون مالكًا فقط. **البديل الأسهل الآن موجود:** رابط GOOG-001 في القسم 5 —
اطلبه بـ`POST /api/google/consent-link` أو اكتب «اربط جوجل» في واتساب، ثم افتحه في المتصفح مباشرة.

### الفحوص التي تُثبت النجاح والفشل بوضوح

| الأعراض | المعنى | الإجراء |
|---|---|---|
| `503 google_not_configured` | `GOOGLE_CLIENT_ID/SECRET` غير مقروءين في هذه العملية | تأكد من `.env` أو متغيرات المنصة بعد إعادة التشغيل |
| `409 google_not_connected` | لا صف في `google_credentials` | أعد خطوة الربط |
| `401 unauthorized` | Bearer خاطئ أو ناقص | نفس قيمة `APP_API_TOKEN` في نفس البيئة |
| `403 The selected Google account does not match…` | البريد ليس `APP_OWNER_EMAIL` أو غير موثّق | استخدم البريد الصحيح أو صحّح المتغير |
| `redirect_uri_mismatch` من Google | عدم تطابق حرفي مع المكوّن | أعد نسخ URI كما هو بالضبط في Google Cloud |
| `Google did not return a refresh token…` | موافقة قديمة بلا `prompt=consent` | اسحب الصلاحية من `myaccount.google.com/permissions` وأعد الربط |
| `access blocked / app not verified` | النشر ليس Testing أو بريدك ليس Test user | أضف بريدك في Test users |

## 5. GOOG-001 — رابط الربط أحادي الاستخدام (منفذ)

**المشكلة التي حُلّت:** لم يكن ممكنًا أن يكتب المالك «اربط جوجل» في واتساب ويصله رابط يعمل، لأن `/auth/google`
يتطلب `Authorization: Bearer` لا يجوز وضعه في رابط محادثة. **الحل المنفذ:**

| المُكوّن | السلوك |
|---|---|
| `src/consent-ticket.js` | تذكرة = `base64url(payload).base64url(HMAC-SHA256)`، المفتاح مشتق من `TOKEN_ENCRYPTION_KEY` بفصل نطاق، الصلاحية 10 دقائق، و`n` عشوائي 128-بت |
| `POST /api/google/consent-link` | مالك فقط (Bearer)؛ يعيد `{ url, expiresAt, singleUse: true }` ويسجّل `state_hash` في `oauth_states` |
| `GET /auth/google?ticket=…` | عام لكنه يتحقق من التوقيع أولًا، ثم من وجود الصف غير المستخدم وغير المنتهي، ثم يعيّن كوكي الحالة ويحوّل إلى Google — **بلا Bearer في الرابط** |
| `/auth/google/callback` | كما هو: يستهلك الحالة مرة واحدة، ويتحقق من `APP_OWNER_EMAIL`، ويخزّن التوكن مشفّرًا |
| واتساب | رسالة من `APP_OWNER_PHONE_E164` تطابق `اربط جوجل` / `اربط حسابي جوجل` / `اربط جوجل الآن` / `connect google` ⇒ يرد بالرابط؛ أي مرسل آخر لا يفعّل شيئًا |

**كيف تستخدمه الآن:** بعد وضع `GOOGLE_CLIENT_ID/SECRET`:

```sh
curl -s -X POST -H "Authorization: Bearer $APP_API_TOKEN" \
  https://<نطاقك>/api/google/consent-link
# {"url":"https://<نطاقك>/auth/google?ticket=…","expiresAt":"…","singleUse":true}
```

افتح الرابط في المتصفح ⇒ اختر الحساب ⇒ تعود برسالة النجاح. الرابط لا يعمل مرتين، ولا بعد 10 دقائق، ولا
بعد تعديل أي بايت في التذكرة.

**اختبارات مثبتة (8/8 في `test/google-consent.test.js`):** تذكرة صحيحة تمرّ · تعديل الحِمل أو التوقيع يُرفض ·
تذكرة بمفتاح آخر تُرفض · مستخدم آخر يُرفض · منتهية تُرفض · المسار يرفض بلا Bearer (401) · الرابط المولّد
لا يحتوي رمز الـAPI إطلاقًا ويحوّل إلى `accounts.google.com` · رابط مستخدم أو منتهٍ يعيد 400 برسالة واضحة ·
الأمر لا يُطابق إلا الصيغ المحددة.

**ما بقي غير مثبت:** الربط الحي مع حساب Google حقيقي (يحتاج اعتمادك ونطاق HTTPS). لا يوجد أداة MCP جديدة
لأن عدد الأدوات الـ12 عقد توافق مع 0.2.0 (COMP-002)؛ إن أردت الرابط داخل عميل MCP نضيفه ضمن الأدوات الاختيارية.

## 6. قبل فتح الرابط: فحص جاهزية بلا شبكة (GOOG-002)

أكثر أربعة أخطاء شيوعًا في هذا الربط (`503 google_not_configured`، `redirect_uri_mismatch`،
تخطّي تحقق الهوية بهدوء، وفتح رابط على `localhost` من الهاتف) لا تحتاج حساب Google لكتشافها — كلها
مشاكل **بيئة** يمكن فحصها محليًا. لذلك أضيف فحص واحد يقرأ المتغيرات فقط: بلا شبكة، بلا قاعدة بيانات،
وبلا طباعة أي قيمة سرية.

**محليًا** (`.env` مقروء تلقائيًا):

```sh
npm run google:doctor            # تقرير عربي/إنجليزي مختصر + رمز خروج 1 عند وجود مانع
npm run google:doctor -- --json  # نفس التقرير للقراءة الآلية
```

**على الخدمة المنشورة** (مالك فقط، بترويسة Bearer):

```sh
curl -s -H "Authorization: Bearer $APP_API_TOKEN" https://<نطاقك>/api/google/preflight | jq .summary
```

| الفحص | مانع (fail) | تحذير (warn) |
|---|---|---|
| `client_id` | فارغ أو `replace-with-…` ⇒ كل المسارات 503 | صيغة ليست Web application |
| `client_secret` | فارغ أو `replace-with-…` | أقصر من المعتاد |
| `redirect_uri` | مسار ليس `/auth/google/callback` · شرطة زائدة/`?`/`#` · `http` على نطاق عام | — |
| `public_base_url` | ليس URL مطلقًا | `localhost` (HOST-003) أو نطاق عام بلا HTTPS |
| `base_url_alignment` | — | `APP_BASE_URL` و`GOOGLE_REDIRECT_URI` على مضيفين مختلفين |
| `owner_email` | فارغ أو غير صالح ⇒ **التحقق من الهوية معطّل** | — |
| `owner_phone` | — | فارغ أو ليس E.164 ⇒ أمر واتساب لا يعمل |
| `encryption_key` | فارغ أو ليس 32 بايت base64 | — |
| `api_token` | فارغ أو أقل من 32 حرفًا | — |
| `feature_switch` | `CELIA_DISABLE_GOOGLE=true` | — |

الفحص **لا يثبت** أن Google سيقبل الطلب: لا يتحقق من وجود العميل فعليًا في Google Cloud، ولا من أن البريد
مضاف في **Test users**، ولا من أن النطاق يعمل. هذه تبقى إجراءاتك في القسم 2، ودليل الأعراض في القسم 4.
**10/10 اختبارات** في `test/google-preflight.test.js` + `test/google-preflight-route.test.js` (منها اختبار
«لا يتسرب أي سر إلى التقرير»، واختبار أن المسار يرد 401 بلا Bearer).

## 7. حدود يجب قولها

- بلا نطاق HTTPS عام (HOST-003) يبقى الربط اختبارًا محليًا؛ render free يعطي نطاقًا لكن نوم الخدمة يقطع
  الروابط الطويلة.
- `Gmail/Drive/People` للقراءة فقط في هذا المستودع، والتقويم إنشاء أحداث فقط — لا حذف ولا إرسال بريد.
- ربط حسابك يعني أن النظام يقرأ بريدك وملفاتك ضمن النطاقات أعلاه. راجع ما تفعّله قبل قبول الشاشة.
