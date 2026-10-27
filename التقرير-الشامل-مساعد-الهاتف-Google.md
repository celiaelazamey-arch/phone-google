# التقرير الشامل — مساعد الهاتف + Google
### المستودع: `celiaelazamey-arch/phone-google` — الفرع `arena/6f4ef8bc-phone-google`
### التاريخ: 25 أكتوبر 2026 — الإصدار 0.1.0 — Node ≥ 20

## تحديث الحالة الفعلية — 27 أكتوبر 2026

هذا التحديث يصف الحالة التي تحققت من GitHub في 27 أكتوبر، ويعلو على أرقام وحالة المستودع التاريخية أدناه؛ لم تُحذف الأقسام القديمة حتى تبقى سجلًا زمنيًا.

- `main` عند `05a3c9e`، وطلبات الدمج #12–#14 مدمجة. يوجد طلب مفتوح #15 من مالك المستودع يتراجع عن PR #14 ويحذف `docs/خطة-إكمال-الناقص-للوكيل-المنفذ.md`؛ لم يُدمج وقت الفحص.
- يوجد سيرَا عمل في `.github/workflows/`: تحقق Celia MCP/Gemini ونشر GitHub Pages. آخر فحوص `main` الظاهرة ناجحة، وحزمة الاختبارات عند ذلك الالتزام تضم 27 اختبارًا.
- اختبار الطبقة الثابتة في `test/static-shim.test.js` يضم 11 اختبارًا، وليس 9؛ العدد 27 هو إجمالي ملفات الاختبار عند `main`.
- بناء Pages وفحص الملفات الثابتة نجحا، لكن وظيفتي رفع artifact والنشر تخطّتا لأن Pages لم تُفعّل بعد للمستودع. واجهة GitHub API أعادت 404 لمسار Pages؛ لذا لا يُعدّ رابط `github.io` منشورًا أو متحققًا بصريًا بعد.
- لا تزال مفاتيح Actions أسرارًا خاصة؛ هذا التقرير لا يعرض قيمها. النسخة الثابتة على Pages لا تستخدم أسرار Actions ولا تنفذ OAuth أو WhatsApp حقيقيًا.

بناءً عليه، عبارات «8 اختبارات» و«لا CI/CD» و«لا واجهة» في الأقسام التاريخية أدناه تصف لقطة 25 أكتوبر فقط، ولا تصف `main` الحالي. كذلك «9/9» في سجل خطة النشر كان رقمًا قديمًا لا يطابق ملف اختبار الطبقة الثابتة الحالي.

---

## الملخص التنفيذي

المشروع **هيكل خادم API جاهز للتشغيل المحلي** يربط ثلاث منظومات:

1. **Google OAuth 2.0** (Gmail, Drive, Calendar, People/Contacts) بقراءة فقط + إنشاء حدث Calendar واحد.
2. **WhatsApp Cloud API (Meta Graph API)** — استقبال Webhook مع تحقق HMAC و إرسال فردي داخل نافذة خدمة العملاء 24 ساعة.
3. **Gemini (Google Generative Language API)** — توليد ردود واتساب تلقائية **معطلة افتراضياً** ومشروطة بموافقتين منفصلتين.

**الحالة الحالية:** الكود مكتمل كـ scaffold آمن (22 ملف، ~2760 سطر)، مع 8 اختبارات آلية (7 ناجحة محلياً بدون `npm install`، 1 يحتاج تثبيت dependencies). **لا يوجد** تشغيل إنتاجي: لا مجال HTTPS، لا قاعدة إنتاج، لا OAuth client حقيقي، لا رقم واتساب موثق، لا مفتاح Gemini فعّال، ولا قوالب واتساب معتمدة. أي تفعيل حقيقي يتطلب توفير هذه الموارد يدوياً.

> **الخلاصة:** آمن للمراجعة والتجربة المحلية، **غير جاهز للنشر العام** قبل إكمال قائمة التحقق في §12.

---

## 1) نظرة عامة على المستودع

| البند | القيمة |
|---|---|
| **الوصف** | Secure starter API for Google OAuth and WhatsApp Cloud API assistant integrations |
| **نوع الحزمة** | `type: module` (ESM) |
| **آخر Commit** | `2eaed47 — feat: scaffold Google Gemini WhatsApp assistant` (25 Oct 2026) |
| **الفروع** | `main` + الفرع الحالي `arena/6f4ef8bc-phone-google` (مطابق لـ main) |
| **الترخيص** | غير محدد (private: false) |
| **اللغات** | JavaScript (Node 22 في Docker، Node 20+ مطلوب) |
| **قاعدة البيانات** | MySQL 8.4 (عبر docker-compose) |

### شجرة الملفات

```
phone-google/
├── .dockerignore
├── .env.example          # قالب متغيرات البيئة (لا أسرار حقيقية)
├── .gitignore            # يحجب .env و node_modules
├── Dockerfile            # node:22-alpine, USER node, EXPOSE 3000
├── docker-compose.yml    # خدمة mysql:8.4 مع healthcheck
├── package.json / lock    # express@5.1, googleapis@150, mysql2@3.14, helmet@8.1, dotenv@16.4
├── README.md             # 6988 بايت — دليل إعداد عربي مفصل
├── sql/schema.sql         # 5 جداول (انظر §4)
├── src/
│   ├── app.js            # factory Express + helmet + trust proxy
│   ├── server.js         # bootstrap + graceful shutdown
│   ├── config.js         # تحميل وتحقق صارم من env
│   ├── db.js             # pool + ensureOwner
│   ├── init-db.js        # تهيئة schema
│   ├── auth.js           # middleware Bearer token
│   ├── security.js       # تشفير، HMAC، E.164، نافذة 24h
│   ├── google.js         # OAuth + 5 مسارات Google
│   ├── whatsapp.js       # Webhook + إرسال + موافقة
│   └── gemini.js         # استدعاء Generative Language API
└── test/
    ├── gemini.test.js    # 2 اختبارات
    ├── routes.test.js     # 3 اختبارات
    └── security.test.js   # 5 اختبارات
```

---

## 2) البنية المعمارية

```
[المتصفح/العميل] --Bearer--> [Express: app.js]
                               ├── GET /health (عام)
                               ├── /webhooks/whatsapp (raw body + HMAC)
                               ├── /auth/google, /auth/google/callback (OAuth state)
                               └── /api/* (مصادقة Bearer)
                                     ├── /api/google/* --> googleapis --> Google
                                     ├── /api/whatsapp/* --> Graph API --> WhatsApp
                                     └── webhook auto-reply --> gemini.js --> Gemini
                               └── MySQL Pool (mysql2/promise)
                                     ├── app_users
                                     ├── oauth_states
                                     ├── google_credentials (مشفرة)
                                     ├── whatsapp_contacts
                                     └── whatsapp_messages
```

**الخصائص المعمارية الرئيسية:**
- **Single-owner deployment**: مستخدم واحد `APP_USER_ID=owner`، لا multi-tenancy.
- **Stateless API** + حالة في MySQL فقط (لا Redis/JWT).
- **Trust proxy** مفعّل فقط في الإنتاج.
- **Helmet** لكل الردود، `x-powered-by` معطل.
- **Raw body** محفوظ لمسار Webhook قبل `express.json()` لتجنب كسر التحقق من التوقيع.
- **Graceful shutdown** عند SIGTERM/SIGINT (إغلاق الخادم + pool خلال 10 ثوان).

---

## 3) متغيرات البيئة (config.js — تحقق صارم)

| المتغير | مطلوب | التحقق | الملاحظات |
|---|---|---|---|
| `APP_API_TOKEN` | نعم | ≥ 32 حرف | Bearer لكل `/api/*` و `/auth/google` البداية |
| `TOKEN_ENCRYPTION_KEY` | نعم | base64 = 32 بايت بالضبط | AES-256-GCM لرموز Google |
| `PORT` | لا (3000) | 1–65535 integer |  |
| `NODE_ENV` | لا |  | يحدد `secure cookie` + `trust proxy` + `MySQL SSL` |
| `APP_BASE_URL` | لا |  | افتراضي `http://localhost:3000` |
| `APP_USER_ID` | لا (owner) |  | مفتاح `app_users.id` |
| `APP_OWNER_EMAIL` | لا |  | إن ضُبط، يفرض مطابقة `email_verified` في OAuth |
| `APP_OWNER_PHONE_E164` | لا |  |  |
| `MYSQL_*` | متغير |  | host/port/database/user/password |
| `GOOGLE_CLIENT_ID/SECRET` | اختياري* |  | *مطلوب لعمل OAuth، إلاّ يعيد 503 |
| `GOOGLE_REDIRECT_URI` | لا |  | افتراضي `APP_BASE_URL/auth/google/callback` |
| `GEMINI_API_KEY` | اختياري* |  | *مطلوب إن كان `AUTO_REPLY_ENABLED=true` |
| `GEMINI_MODEL` | لا (gemini-2.5-flash) |  |  |
| `GEMINI_BUSINESS_CONTEXT` | لا | ≤4000 حرف | سياق النشاط المرسل كـ systemInstruction |
| `WHATSAPP_VERIFY_TOKEN` | اختياري |  | يتحقق في GET webhook |
| `WHATSAPP_APP_SECRET` | اختياري* |  | *مطلوب للتحقق HMAC وللرد التلقائي |
| `WHATSAPP_ACCESS_TOKEN` | اختياري* |  |  |
| `WHATSAPP_PHONE_NUMBER_ID` | اختياري* |  |  |
| `WHATSAPP_API_VERSION` | لا (v23.0) |  |  |
| `WHATSAPP_AUTO_REPLY_ENABLED` | لا (false) | === 'true' | البوابة الرئيسية لتفعيل Gemini |

**فشل مبكر (fail-fast):** `server.js` يرمي خطأ عند بدء التشغيل إذا كان `AUTO_REPLY_ENABLED=true` بدون اكتمال إعداد Gemini/WhatsApp.

---

## 4) قاعدة البيانات — 5 جداول (sql/schema.sql)

### 4.1 `app_users`
```sql
id VARCHAR(64) PK, email VARCHAR(254) UNIQUE, phone_e164 VARCHAR(16) UNIQUE
```
مالك واحد افتراضي، يُنشأ/يُحدّث عند كل بدء تشغيل عبر `ensureOwner()`.

### 4.2 `oauth_states`
```sql
state_hash CHAR(64) PK, user_id FK→app_users, expires_at DATETIME, used_at DATETIME NULL
```
- يخزن **هاش SHA-256** للـ state وليس القيمة الخام.
- صلاحية 10 دقائق، استخدام لمرة واحدة (`used_at IS NULL` + `UPDATE ... affectedRows===1`).

### 4.3 `google_credentials`
```sql
user_id PK FK, encrypted_tokens MEDIUMTEXT, scopes TEXT, updated_at
```
- `encrypted_tokens` مشفّر بـ AES-256-GCM (انظر §5).
- يُحدّث تلقائياً عند `client.on('tokens')` (refresh).

### 4.4 `whatsapp_contacts`
```sql
phone_e164 VARCHAR(16) PK, opted_in BOOLEAN, ai_opted_in BOOLEAN,
consent_source VARCHAR(128), consented_at DATETIME, last_inbound_at DATETIME
```
- فصل واضح بين موافقة واتساب العامة وموافقة معالجة AI.
- `aiOptedIn` لا يمكن أن يكون true بدون `optedIn`.

### 4.5 `whatsapp_messages`
```sql
id BIGINT AUTO_INCREMENT PK, provider_message_id VARCHAR(128) UNIQUE,
phone_e164, direction ENUM('inbound','outbound'), message_type,
body TEXT, status, created_at
INDEX (phone_e164, created_at)
```
- منع تكرار عبر `INSERT IGNORE` على `provider_message_id`.
- يخزن آخر رسائل الداخلة/الخارجة للتدقيق.

**ملاحظة تشغيلية:** `init-db.js` يقسّم `schema.sql` على `;` وينفذ كل جملة بـ `pool.query()` — بسيط وفعّال لـ 5 جداول.

---

## 5) الأمن والخصوصية — تحليل مفصل

### 5.1 التشفير (security.js)
- **AES-256-GCM**: nonce 12 بايت عشوائي + auth tag، التنسيق `v1.<nonce>.<tag>.<ciphertext>` (كلها base64). يمنع التلاعب (authenticated encryption).
- **hashOAuthState**: SHA-256 hex — لا يُخزن state الخام في DB.
- **safeEqual**: `crypto.timingSafeEqual` بعد التحقق من الطول — يمنع timing attacks في مقارنة Bearer tokens و verify tokens و OAuth state cookie.
- **مفتاح 32 بايت**: تحقق مزدوج في `config.js` و `security.js`.

### 5.2 مصادقة API (auth.js)
- كل `/api/*` + بداية OAuth تتطلب `Authorization: Bearer <APP_API_TOKEN>` حرفياً.
- `/health` و `/auth/google/callback` و `/webhooks/whatsapp` هي المسارات العامة الوحيدة (الأخيران محميان بـ cookie/state و HMAC على التوالي).

### 5.3 Google OAuth (google.js — 221 سطر)
- **Scopes** (6): `openid email gmail.readonly drive.readonly calendar.events contacts.readonly`.
- **تدفق آمن**: `crypto.randomBytes(32)` → hash → DB + cookie `httpOnly sameSite=lax secure(production) maxAge 10m path=/auth/google/callback`.
- **تحقق مزدوج**: `safeEqual(state, cookieState)` + استعلام DB عن `expires_at > UTC_TIMESTAMP() AND used_at IS NULL` + `UPDATE used_at` مع فحص `affectedRows===1` (يمنع race condition).
- **التحقق من المالك**: إن وُجد `APP_OWNER_EMAIL`، يتحقق من `id_token` عبر `verifyIdToken` و `email_verified`.
- **Refresh token**: يدمج `previous.refresh_token` إذا لم ترسله Google، ويشترط وجوده وإلاّ 400.
- **قراءة فقط**: لا إرسال بريد، لا قراءة مرفقات — فقط metadata للبريد.
- **تجديد تلقائي**: `client.on('tokens')` يحدث DB دون كشف الأخطاء للعميل.

### 5.4 WhatsApp (whatsapp.js — 141 سطر)
- **التحقق GET**: `hub.mode=subscribe` + `safeEqual(verify_token)` → يعيد `hub.challenge`.
- **التحقق POST**: `X-Hub-Signature-256: sha256=<hex>` مقابل `HMAC-SHA256(appSecret, rawBody)` — يستخدم `express.raw` للحصول على `Buffer` الأصلي.
- **منع التكرار**: `INSERT IGNORE` على `provider_message_id` + `if (!affectedRows) continue`.
- **نافذة 24 ساعة**: `isWithinCustomerWindow(last_inbound_at)` = `now - last < 24h` — يطبق سياسة WhatsApp Business.
- **موافقة مزدوجة**: `opted_in` و `ai_opted_in` — لا رد تلقائي بدون الاثنين.
- **حدود الإرسال**: `isValidE164(/^\+[1-9]\d{7,14}$/)`، نص 1–4096 حرف، يزيل `+` عند الإرسال لـ Graph API.
- **لا قوالب**: خارج النافذة → `403 outside_customer_service_window_use_approved_template`، لا إرسال broadcast.

### 5.5 Gemini (gemini.js — 28 سطر)
- **سياسة افتراضية صارمة** (6 قواعد عربية/إنجليزية): رد قصير جملتين، لا اختلاق أسعار/مخزون/مواعيد، تحويل الشكاوى/المدفوعات/البيانات الشخصية لموظف بشري، لا طلب كلمات مرور/OTP/بطاقات، لا كشف system instructions.
- **المفتاح في Header**: `x-goog-api-key` فقط، لا يظهر في URL (اختبار يتحقق من ذلك).
- **تحديد السياق**: `businessContext.slice(0,4000)` + `customerMessage.slice(0,4000)` + `maxOutputTokens:180` + `temperature:0.2` + إرجاع `slice(0,1000)`.
- **معطّل افتراضياً**: لا يُستدعى إلا إذا `autoReplyEnabled && body && opted_in && ai_opted_in && withinWindow` — مع `try/catch` لا يوقف Webhook عند فشل Gemini (يرجع 200 دائماً).

### 5.6 حماية عامة
- **Helmet** (8.1.0) لكل الردود، `trust proxy` محدود (1 فقط في الإنتاج)، `express.json limit 256kb`، `webhook raw limit 1mb`.
- **404/500 handlers** موحدة لا تكشف stack trace.
- **.env محجوب** في `.gitignore` و `.dockerignore`.

---

## 6) واجهات API الكاملة

### 6.1 عامة
| الطريقة | المسار | المصادقة | الوصف |
|---|---|---|---|
| GET | `/health` | لا | `{status:"ok"}` — فحص حيوية |
| GET | `/webhooks/whatsapp` | verify_token | تحقق اشتراك Meta |
| POST | `/webhooks/whatsapp` | HMAC-SHA256 | استقبال رسائل واتساب |

### 6.2 Google OAuth
| الطريقة | المسار | المصادقة | الوصف |
|---|---|---|---|
| GET | `/auth/google` | Bearer | يبدأ OAuth — يضع cookie ويعيد redirect لـ Google |
| GET | `/auth/google/callback` | cookie+state | يعالج code، يتحقق من المالك، يحفظ tokens مشفرة |

### 6.3 Google APIs (كلها Bearer)
| الطريقة | المسار | معاملات | الوصف | حدود |
|---|---|---|---|---|
| GET | `/api/google/gmail/search?q=` | q ≤500 حرف | يبحث Gmail (metadata فقط) | 10 رسائل، snippet + From/To/Subject/Date |
| GET | `/api/google/drive/search?q=` | q ≤200 حرف | يبحث Drive بالاسم | 20 ملف، `trashed=false` |
| GET | `/api/google/calendar/events?days=` | days 1–30 (افتراضي 7) | يقرأ أحداث التقويم | 50 حدث، primary calendar |
| POST | `/api/google/calendar/events` | `{summary, start, end, timeZone?}` | ينشئ حدثاً | summary ≤200 حرف |
| GET | `/api/google/contacts/search?q=` | q ≤100 حرف | يبحث جهات الاتصال محلياً | 100 جهة، تصفية case-insensitive، إرجاع 20 |

### 6.4 WhatsApp APIs (كلها Bearer)
| الطريقة | المسار | الجسم | الوصف |
|---|---|---|---|
| POST | `/api/whatsapp/contacts/:phone/consent` | `{optedIn:boolean, aiOptedIn?:boolean, source:string}` | تسجيل/إلغاء الموافقة — `source` مطلوب عند `optedIn:true`، `aiOptedIn` يتطلب `optedIn` |
| POST | `/api/whatsapp/messages` | `{phone:"+1415...", text:"..."}` | إرسال فردي — يفرض `opted_in` + نافذة 24h — يعيد 202 + providerMessageId |

**أكواد الأخطاء الموحدة:**
- `401 unauthorized` — Bearer مفقود/خاطئ
- `400 query_required / valid_phone_and_text_required / ...` — تحقق مدخلات
- `403 recipient_has_not_opted_in / outside_customer_service_window_use_approved_template`
- `503 google_not_configured` — OAuth غير مُعد
- `409 google_not_connected` — لم يربط المالك حسابه بعد
- `502 google_request_failed / whatsapp_send_failed`

---

## 7) التشغيل المحلي

```bash
cp .env.example .env
# عدّل: MYSQL_PASSWORD, MYSQL_ROOT_PASSWORD, APP_API_TOKEN (≥32), TOKEN_ENCRYPTION_KEY (openssl rand -base64 32)
docker compose up -d mysql
npm install
npm run db:init   # ينشئ الجداول + app_users
npm test          # 8 اختبارات (7 pass + 1 يحتاج node_modules)
npm start         # يستمع على PORT (افتراضي 3000)
curl http://localhost:3000/health  # => {"status":"ok"}
npm run check     # فحص syntax لكل ملفات src و test
```

**Docker:**
- `Dockerfile`: `node:22-alpine`, `npm ci --omit=dev`, `USER node`, `COPY src sql`.
- `docker-compose.yml`: `mysql:8.4` مع `healthcheck` كل 5 ثوان، مجلد `mysql-data` دائم، منفذ `127.0.0.1:3306`.

---

## 8) الاختبارات

| الملف | الاختبارات | الحالة (بدون تثبيت) | ما يختبر |
|---|---|---|---|
| `gemini.test.js` | 2 | ✅ pass | إرسال المفتاح في header فقط، رفض بدون مفتاح |
| `routes.test.js` | 3 | ❌ fail (يحتاج express) | health عام، API يطلب Bearer، OAuth يطلب token + callback يرفض بدون cookie، Webhook يرفض بدون verify_token |
| `security.test.js` | 5 | ✅ pass | تشفير AES، safeEqual، hash state، HMAC WhatsApp، E.164 + نافذة 24h |

**الإجمالي:** 8 اختبارات — 7 نجحت، 1 فشل لعدم وجود `node_modules` في البيئة الحالية (سيمر بعد `npm install`).

---

## 9) تحليل الكود التفصيلي — ملف بملف

| الملف | سطر | المسؤولية | نقاط قوة | ملاحظات/تحسين مقترح |
|---|---|---|---|---|
| `app.js` (24 سطر) | factory | إنشاء Express، helmet، توجيه | ترتيب raw قبل json صحيح، trust proxy مشروط | يمكن إضافة rate limiting |
| `config.js` (53 سطر) | تحميل env | تحقق صارم، freeze | رسائل خطأ واضحة، base64 طول دقيق | إضافة تحقق E.164 لـ owner phone |
| `server.js` (26 سطر) | bootstrap | تشغيل، ensureOwner، fail-fast، shutdown | فحص Gemini/WhatsApp مبكر، graceful shutdown 10s | إضافة log منظم (pino/winston) |
| `db.js` (20 سطر) | MySQL | Pool + ensureOwner | SSL في الإنتاج، charset utf8mb4، timezone Z | إضافة `enableKeepAlive` |
| `init-db.js` (17 سطر) | تهيئة | قراءة schema.sql وتنفيذه | بسيط، idempotent (IF NOT EXISTS) | معالجة تعليقات SQL إن وُجدت |
| `auth.js` (12 سطر) | مصادقة | Bearer timingSafe | بسيط وصحيح | يمكن إضافة تدوير tokens |
| `security.js` (54 سطر) | أمان | تشفير، HMAC، E.164، نافذة | كل الدوال مغطاة باختبارات | إضافة تنظيف المدخلات XSS |
| `google.js` (221 سطر) | Google | OAuth + 5 APIs | آمن، refresh تلقائي، owner check | إضافة pagination لـ Gmail/Drive |
| `whatsapp.js` (141 سطر) | WhatsApp | Webhook + إرسال | HMAC، dedup، نافذة، موافقة مزدوجة | إضافة دعم media/location |
| `gemini.js` (28 سطر) | AI | استدعاء Gemini | سياسة صارمة، حدود إدخال/إخراج | إضافة retry + timeout |

---

## 10) حدود النشر والإكمال — ما لا يفعله المشروع حالياً

> كما هو موثق في README، هذه هي الفجوات الصريحة:

1. **لا أسرار مُضمنة** — يجب توفير كل المفاتيح يدوياً (Google OAuth client، Gemini key، WhatsApp tokens).
2. **لا نطاق HTTPS** — Webhook و OAuth callback يتطلبان HTTPS عام — غير موجود.
3. **لا قاعدة بيانات إنتاجية** — MySQL محلي فقط، لا replication/backup.
4. **لا لوحة تحكم / إدارة مستخدمين** — مستخدم واحد فقط، API يدوي بـ curl/Bearer.
5. **لا إرسال جماعي (broadcast)** — ممنوع عمداً، فردي فقط داخل نافذة 24h.
6. **لا قوالب WhatsApp** — خارج النافذة مرفوض، لا إرسال template.
7. **لا جدولة تذكيرات / معالجة طلبات بيع / ربط MySQL موجود** — غير مُنفذ.
8. **لا قراءة مرفقات Gmail ولا إرسال بريد** — metadata فقط.
9. **لا واجهة أمامية** — خادم API فقط.
10. **لا CI/CD** — لا GitHub Actions، لا فحص أمان تلقائي.

---

## 11) خارطة الطريق للإنتاج

### المرحلة 1 — البنية الأساسية (أسبوع 1–2)
- [ ] حجز نطاق + شهادة HTTPS (Let's Encrypt / Cloudflare).
- [ ] إنشاء مشروع Google Cloud + OAuth consent screen + تفعيل 4 APIs + إنشاء OAuth Web Client + ضبط redirect URI الإنتاجي.
- [ ] إنشاء تطبيق Meta + رقم WhatsApp Business + إعداد Webhook + الحصول على `verify_token`, `app_secret`, `access_token`, `phone_number_id`.
- [ ] إنشاء قاعدة MySQL مُدارة (RDS / Cloud SQL) + نسخ احتياطي يومي + تشفير at-rest.
- [ ] إنشاء مفتاح Gemini + اختبار `GEMINI_MODEL` متاح.
- [ ] نشر الخادم (Fly.io / Render / Railway / VPS) + ضبط متغيرات البيئة في Secret Manager (لا في Git).

### المرحلة 2 — الأمان والامتثال (أسبوع 3)
- [ ] تفعيل `APP_OWNER_EMAIL` + اختبار OAuth حقيقي.
- [ ] مراجعة شاشة موافقة Google (قد تتطلب تحقق Google للاستخدام العام).
- [ ] إعداد سياسة خصوصية + نموذج موافقة واتساب/AI موثق (مطلوب لـ `consent_source`).
- [ ] إضافة Rate Limiting (express-rate-limit) + CORS إن لزم.
- [ ] إضافة سجلات منظمة + تنبيهات (Sentry / Logtail).
- [ ] تفعيل `WHATSAPP_AUTO_REPLY_ENABLED` فقط بعد إبلاغ العملاء كتابياً.

### المرحلة 3 — الميزات (أسبوع 4+)
- [ ] لوحة تحكم بسيطة لإدارة الموافقات وعرض الرسائل.
- [ ] دعم قوالب WhatsApp المعتمدة للإرسال خارج النافذة.
- [ ] جدولة تذكيرات Calendar → WhatsApp (cron).
- [ ] Webhook لتحديثات حالة الرسائل (delivered/read).
- [ ] اختبارات تكامل مع MySQL حقيقية + CI (GitHub Actions).

---

## 12) قائمة التحقق قبل الإطلاق (Checklist)

- [ ] `APP_API_TOKEN` عشوائي ≥32 حرف، محفوظ في Secret Manager
- [ ] `TOKEN_ENCRYPTION_KEY` مولد بـ `openssl rand -base64 32`
- [ ] `GOOGLE_REDIRECT_URI` يطابق تماماً ما في Google Cloud Console (HTTPS)
- [ ] `APP_BASE_URL` هو النطاق الإنتاجي الفعلي
- [ ] `GOOGLE_CLIENT_ID/SECRET` من مشروع مُفعل (4 APIs مفعلة)
- [ ] `WHATSAPP_*` الأربعة صحيحة + `WHATSAPP_API_VERSION` مدعوم
- [ ] `GEMINI_API_KEY` صالح + `GEMINI_BUSINESS_CONTEXT` مُراجع
- [ ] MySQL الإنتاج يعمل + `npm run db:init` نُفّذ بنجاح
- [ ] `GET /health` يعيد 200 من الإنترنت (HTTPS)
- [ ] OAuth flow كامل مجرب (redirect → callback → Gmail search)
- [ ] Webhook WhatsApp مُسجل في Meta ويعيد 200 للتحقق
- [ ] إرسال واتساب فردي مجرب داخل النافذة
- [ ] الموافقات مسجلة عبر `/consent` مع `source` موثق
- [ ] `WHATSAPP_AUTO_REPLY_ENABLED` لم يُفعل إلا بعد موافقة AI منفصلة

---

## 13) المخاطر والامتثال

| الخطر | الوصف | التخفيف الحالي | المطلوب إضافياً |
|---|---|---|---|
| **كشف أسرار** | تسريب tokens في logs/Git | تشفير DB، gitignore، ختمة Secret Manager في README | فحص pre-commit (gitleaks)، تدوير دوري |
| **انتحال OAuth** | هجوم CSRF على state | state عشوائي 32 بايت + cookie httpOnly + hash DB + مرة واحدة | إضافة PKCE إن انتقل لـ mobile |
| **تزوير Webhook** | رسائل واتساب مزيفة | HMAC-SHA256 على raw body | مراقبة معدل الرسائل |
| **إساءة استخدام AI** | هلوسة Gemini، تسريب بيانات | سياسة 6 قواعد + حدود 4000/1000 حرف + تحويل للبشري | مراجعة بشرية دورية للردود |
| **خرق WhatsApp Business Policy** | إرسال خارج النافذة/بدون موافقة | رفض 403 + موافقة مزدوجة | اعتماد قوالب Meta قبل التوسع |
| **GDPR/خصوصية** | تخزين رسائل + جهات اتصال | `consent_source` + `consented_at` + موافقة AI منفصلة | حق الحذف، retention policy |

---

## 14) أوامر مرجعية

```bash
# تثبيت وتشغيل
cp .env.example .env && nano .env
docker compose up -d mysql
npm install
npm run db:init
npm test
npm start

# اختبار API (استبدل TOKEN)
curl http://localhost:3000/health
curl -H "Authorization: Bearer $APP_API_TOKEN" http://localhost:3000/auth/google -v  # يبدأ OAuth
curl -H "Authorization: Bearer $APP_API_TOKEN" "http://localhost:3000/api/google/gmail/search?q=invoice"
curl -H "Authorization: Bearer $APP_API_TOKEN" "http://localhost:3000/api/google/drive/search?q=report"
curl -H "Authorization: Bearer $APP_API_TOKEN" "http://localhost:3000/api/google/calendar/events?days=7"
curl -H "Authorization: Bearer $APP_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"summary":"اجتماع","start":"2026-10-27T14:00:00Z","end":"2026-10-27T14:30:00Z"}' \
  http://localhost:3000/api/google/calendar/events
curl -H "Authorization: Bearer $APP_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"optedIn":true,"aiOptedIn":true,"source":"نموذج موافقة موثق"}' \
  http://localhost:3000/api/whatsapp/contacts/14155552671/consent
curl -H "Authorization: Bearer $APP_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"phone":"+14155552671","text":"مرحباً"}' http://localhost:3000/api/whatsapp/messages

# فحص
npm run check
docker compose logs mysql
```

---

## 15) الخلاصة والتوصية

المشروع **ممتاز كبداية آمنة** — يطبق أفضل ممارسات OAuth state، تشفير tokens، HMAC webhooks، فصل الموافقات، وسياسة AI محافظة. الكود نظيف، مُختبر، وموثق بالعربية.

**التوصية:** استخدمه كأساس للتطوير المحلي والاختبار، ثم اتبع خارطة الطريق (§11) وقائمة التحقق (§12) قبل أي نشر إنتاجي. لا تفعّل `WHATSAPP_AUTO_REPLY_ENABLED` ولا تشارك أي سر في محادثات أو ملفات Git — ضعها فقط في `.env` المحلي أو Secret Manager للاستضافة.

---

*أُعد هذا التقرير آلياً من فحص كامل للكود (10 ملفات مصدرية، 5 جداول، 8 اختبارات) في 25 أكتوبر 2026.*
*المستودع: https://github.com/celiaelazamey-arch/phone-google — الفرع: arena/6f4ef8bc-phone-google*
