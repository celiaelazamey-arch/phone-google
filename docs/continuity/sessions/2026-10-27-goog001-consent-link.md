# تسليم جلسة — 2026-10-27 — تنفيذ GOOG-001: رابط ربط Google أحادي الاستخدام

## المهمة والتفويض

- قرار المالك بعد سؤال الخيارات: **«كلهم بدون الاعتماد على الخدمات المدفوعة، مجانًا فقط في البداية، لخدمة
  النظام بالكامل بدون فيزا تحقق»** — أي نفّذ جوجل + واتساب + الدليل، على الطبقة المجانية فقط.
- نُفّذ في هذه الجلسة: **GOOG-001** (رابط ربط أحادي الاستخدام) وأمر واتساب للمالك. اختير هذا لأنه الفجوة
  الحقيقية: الربط موجود، لكن لا يمكن الوصول إليه من محادثة.
- النطاق: `src/consent-ticket.js` (جديد)، `src/google.js`، `src/whatsapp.js`، اختبار جديد، وثائق.
  **لم يُلمس**: `sql/schema.sql` (بلا جداول جديدة — أُعيد استخدام `oauth_states`)، عدد أدوات MCP الـ12،
  الإصدار `0.2.1`.

## واقع البداية

- الفرع `arena/051ed103-phone-google` · baseline `5dead2c` · PR #27 مفتوح لهذا الفرع.
- `npm ci` منفذ مسبقًا في هذه البيئة؛ `npm test` كان **75/75**.

## ما تغير فعليًا

- **`src/consent-ticket.js` (جديد):** `mintConsentTicket` و`verifyConsentTicket`. التذكرة
  `base64url(payload).base64url(HMAC-SHA256)`، مفتاح مشتق `HMAC(TOKEN_ENCRYPTION_KEY, 'google-consent-ticket-key')`
  بفصل نطاق، حمولة `{u: userId, e: انتهاء بالثواني, n: nonce 128-بت}`، حد أقصى 10 دقائق، ومقارنة `timingSafeEqual`.
- **`src/google.js`:**
  - `createGoogleConsentLink()` مصدَّرة: تصكّ تذكرة وتسجّل `hashOAuthState(ticket)` في `oauth_states` بـ`FROM_UNIXTIME`.
  - `POST /api/google/consent-link` خلف `requireApiToken` → `{ url, expiresAt, singleUse: true }`.
  - `GET /auth/google`: بقيت حماية Bearer كما هي، وأُضيف مسار `?ticket=` الذي يتحقق من التوقيع ثم من صف
    `oauth_states` غير المستخدم وغير المنتهي، ثم يعيّن كوكي الحالة ويحوّل إلى Google. لا كشف لرمز الـAPI في أي رابط.
  - أُعيد تنظيم بداية التدفق في `startAuthorization()` لتشاركها الطريقتان بلا تكرار.
- **`src/whatsapp.js`:** `isGoogleConnectCommand()` (نمط ضيق: `اربط جوجل`، `اربط حسابي جوجل`، `اربط جوجل الآن`،
  `ربط جوجل`، `connect google`، `link google` …). في الـwebhook: إن كان المرسل هو `APP_OWNER_PHONE_E164` فقط،
  يُصدر رابطًا ويرسله ويسجّل الرسالة الصادرة، ثم `continue` (لا رد AI). أي مرسل آخر لا يفعّل شيئًا.
- **`test/google-consent.test.js` (جديد، 8 اختبارات):** round-trip، تعديل الحِمل/التوقيع، مفتاح آخر، مستخدم آخر،
  انتهاء، 401 بلا Bearer، تحويل إلى `accounts.google.com` بلا رمز API في الرابط، إعادة استخدام/انتهاء ⇒ 400،
  تذكرة مزوّرة لا تصل إلى Google، ومطابقة الأمر الضيقة فقط.
- **وثائق:** `docs/google-connect.md` القسم 5 صار يصف المنفذ بدقة؛ `BACKLOG` GOOG-001 ⇒ متحقق؛ `STATE` محدّث.
- **لم يُنفَّذ:** أداة MCP للرابط (لتجنّب كسر عقد الـ12 أداة في COMP-002)؛ أي اتصال Google حقيقي.

## الفحوص

| الأمر/الفحص | commit/البيئة | النتيجة |
|---|---|---|
| `npm test` | Node 22.22.3 | **83/83 ناجحة** (75 سابقة + 8 جديدة) |
| `npm run check` | نفس البيئة | نجح — 56 ملف JavaScript |
| `npm run check:secrets` | نفس البيئة | نجح — 9 أسرار متتبعة |
| `npm run release:check` | نفس البيئة | نجح — `0.2.1` / `databaseSchema: 1` |
| `node scripts/check-continuity.mjs` | نفس البيئة | نجح — 20 وثيقة، 56 رابطًا، 46 مهمة |
| ربط حي مع Google | — | **لم يُنفَّذ**: لا اعتماد ولا نطاق HTTPS عام |

## الحفظ والتسليم

- commit: `feat(google): single-use consent link and owner WhatsApp command (GOOG-001)` — يُدفع إلى PR #27.
- لا نشر، لا أسرار، لا تغيير مخطط، لا تغيير إصدار.
- جدول المودع: `TOKEN_ENCRYPTION_KEY` الجديد المستخدم لتوقيع التذاكر هو نفسه القديم — لا سر جديد مطلوب.

## الاستئناف

- العوائق: (1) عميل OAuth في Google Cloud من المالك؛ (2) نطاق HTTPS عام (HOST-003) — الطبقة المجانية فقط حسب
  قرار المالك، وهو ما يقيّد نوم الخدمة؛ (3) اختبار حي.
- الخطوة التالية بالضبط: وضع `GOOGLE_CLIENT_ID/SECRET` و`APP_OWNER_EMAIL` و`APP_BASE_URL` و`APP_OWNER_PHONE_E164`،
  ثم `POST /api/google/consent-link` وفتح الرابط، ثم إثبات `200` من `/api/google/calendar/events?maxResults=1`.
- تحديث STATE/BACKLOG: تم. لا قرار DEC جديد (GOOG-001 صف مهمة).
