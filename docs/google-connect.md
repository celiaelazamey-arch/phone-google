# ربط حساب Google — الحقيقة الكاملة وخطوات التنفيذ

**التاريخ:** 27 أكتوبر 2026 · **الحالة:** الكود موجود ومختبر بـ75/75 اختبار وحدة، لكن **لم يُربط حساب حقيقي بعد**
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

**لماذا هذا مرهق؟** لأن الربط صُمّم ليكون مالكًا فقط. الارتداء أعلاه هو الثمن المقبول مؤقتًا؛ والعلاج الحقيقي
هو GOOG-001 (رابط أحادي الاستخدام) لا تخفيف المصادقة.

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

## 5. ما ينقص فعلًا: GOOG-001 — رابط أحادي الاستخدام للربط من الدردشة

**المشكلة:** لا يمكن للشخص أن يكتب «اربط جوجل» في واتساب ويصله رابط يعمل، لأن `/auth/google` يتطلب Bearer
لا يمكن وضعه في رابط محادثة. **الحل المخطط (غير المنفذ):**

1. مسار مالك `POST /api/google/consent-link` يعيد رابطًا: `https://<host>/auth/google?ticket=<...>`.
2. التذكرة = `HMAC-SHA256` على (`user_id` + انتهاء 10 دقائق + nonce) بمفتاح مشتق من `TOKEN_ENCRYPTION_KEY`،
   والتذكرة نفسها تُستخدم `state` في `oauth_states` فترث الانتهاء والاستخدام الواحد الموجودين.
3. مسار `GET /auth/google?ticket=` عام لكنه يتحقق من التوقيع قبل أي إعادة توجيه — **بلا** كشف Bearer في URL.
4. أداة MCP `google_connect_link` تُرجع الرابط للمساعد، وواتساب يرسله **فقط** إلى `APP_OWNER_PHONE_E164`.
5. اختبارات: تذكرة صالحة تعمل مرة واحدة · منتهية ترفض · موقّعة خطأً ترفض · مستخدم غير مالك لا يحصل على رابط ·
   الرابط لا يعمل بعد الاستخدام.

هذا لا يُنفَّذ الآن لأنه يغيّر سطح مصادقة عامًا (يتطلب موافقة صريحة) وتحقّقه الحي يحتاج نطاق HTTPS عامًا.

## 6. حدود يجب قولها

- بلا نطاق HTTPS عام (HOST-003) يبقى الربط اختبارًا محليًا؛ render free يعطي نطاقًا لكن نوم الخدمة يقطع
  الروابط الطويلة.
- `Gmail/Drive/People` للقراءة فقط في هذا المستودع، والتقويم إنشاء أحداث فقط — لا حذف ولا إرسال بريد.
- ربط حسابك يعني أن النظام يقرأ بريدك وملفاتك ضمن النطاقات أعلاه. راجع ما تفعّله قبل قبول الشاشة.
