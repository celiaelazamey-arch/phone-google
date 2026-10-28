# دليل النشر الإنتاجي الكامل لسيليا مجانًا 100% بدون بطاقة دفع (بدون فيزا)

**رقم القرار المعماري:** `DEC-037` · **التاريخ:** 28 أكتوبر 2026 (`Africa/Cairo`) · **التكلفة الشهرية:** `0$` · **اشتراط بطاقة فيزا / ائتمان:** **صفر (`paymentCardAuthorized: false`)**

---

## 1) نتيجة التحقق الميداني أولًا (`تحقق في البداية`)

قبل تعديل أي ملف، جرى التحقق المباشر من المنصات المتاحة وحسابات المالك الفعلية وموصلات الجلسة:

| المنصة / الحساب | هل تطلب بطاقة دفع (فيزا)؟ | الحالة الفعلية في حسابك بتاريخ 2026-10-28 | الحكم المعماري |
|---|---|---|---|
| **Render Free** | **نعم — حائط تفويض بطاقة 1$ إلزامي بلا زر تخطٍّ** (`DEC-034`) | `0` خدمات؛ متوقف عند بوابة البطاقة | ❌ **مرفوض كمسار وحيد** لخرقه شرط «بدون فيزا» |
| **Vercel AI Gateway** | **نعم — يطلب بطاقة ائتمان (`403 credit card required`)** (`DEC-030`) | معطّل عمدًا عبر `CELIA_DISABLE_AI_GATEWAY=true` | ❌ مستبعد |
| **Hugging Face Docker Spaces** | **نعم — خطة مدفوعة لإنشاء Compute Spaces** | غير مستخدم | ❌ مستبعد |
| **Supabase Free** (`yqzhgogmtscoqejuxplv`) | **لا** (`0$` بلا بطاقة) | مشروع مجاني موجود في `eu-west-1` لكنه متوقف تلقائيًا بسبب الخمول (`INACTIVE`) ويستخدم PostgreSQL بدل MySQL/SQLite | 🟡 احتياطي اختياري فقط (ينام بعد 7 أيام خمول) |
| **Vercel Hobby** (`celiaelazamey-7132`) | **لا** (`0$` بلا بطاقة) | حساب فعّال (`0` مشاريع)، لكنه لا يضم أسرار المستودع الـ 18 ولا قاعدة SQLite مدمجة | 🟡 بديل ثانوي عند الحاجة |
| **Cloudflare Workers + Cloudflare D1 + GitHub Pages** | **لا — مجاني 100% بدون أي فيزا أو بطاقة دفع** | **يعمل حيًّا بالفعل في حسابك الآن:** Worker منشور + قاعدة D1 دائمة (`celia-edge-state` / `f63ccd9f-49b1-4eca-861b-fd478c433518`) + `18/18` سرًّا مربوطة تلقائيًا من GitHub Actions + واجهة Pages حيّة (12 مسارًا) | ✅ **المسار الإنتاجي الأساسي المعتمد بدون فيزا (`DEC-037`)** |

---

## 2) ما الذي كان ينقص نظامك ليُنشَر بالكامل بدون فيزا — وما الذي طُبِّق؟

### الفجوة التي كشفها التحقق
كان الخادم المنشور على **Cloudflare Workers** (`https://celia-phone-google.celiaelazamey.workers.dev`) يعمل كبوابة حالة مصغّرة فقط (`/health`، `/readyz`، `/api/state`، `/api/audit`)، بينما ظلّ محرك **MCP (12 أداة)** و**ربط Google OAuth2 (Gmail / Drive / Calendar / Contacts)** و**Webhook واتساب الرسمي + الرد الذكي بـ Gemini** محصورين داخل حاوية `Express + MySQL` المصممة لـ Render المحجوب ببوابة الفيزا!

### الحل المنفّذ في المستودع (`DEC-037`)
تمت ترقية حزمة `workers/celia-edge/` وتدفقات النشر التلقائي لتشغيل **الخادم الكامل لسيليا مباشرةً على Cloudflare Workers + قاعدة Cloudflare D1 الدائمة** بلا أي حاجة إلى Render أو بطاقة دفع:

1. **قاعدة بيانات SQLite دائمة وكاملة على Cloudflare D1 (`workers/celia-edge/migrations/0002_runtime.sql`):**
   - إضافة الجداول الإنتاجية المطابقة لمخطط النظام (`app_users`، `oauth_states`، `google_credentials`، `whatsapp_contacts`، `whatsapp_messages`، `edge_idempotency`) إلى جانب جداول الحالة وسلسلة التدقيق المشفّرة (`0001_state.sql`) بإجمالي **12 جملة SQL idempotent** تُطبَّق تلقائيًا عند كل نشر.
2. **تشفير رموز OAuth بمعيار WebCrypto `AES-256-GCM` مع عزل المفاتيح (`workers/celia-edge/crypto.js`):**
   - تشفير رموز Google (`refresh_token` / `access_token`) بصيغة مغلف موثّق `v2.<keyId>.<iv>.<tag>.<ciphertext>` عبر `TOKEN_ENCRYPTION_KEY` أو اشتقاق مفتاح معزول بـ **HKDF-SHA-256** تلقائيًا دون تخزين أي رمز نصي في D1، مع توافق رجعي كامل مع مغلفات `v1.*`، وتوقيع تذاكر ربط المتصفح قصيرة العمر (`10` دقائق)، والتحقق من توقيع Meta `X-Hub-Signature-256` على البايتات الخام (`raw bytes`) بزمن ثابت.
3. **خادم MCP كامل يضم الأدوات الـ 12 الرسمية (`POST /mcp` و`GET /mcp` في `workers/celia-edge/runtime.js`):**
   - جميع أدوات سيليا الـ 12 تعمل مباشرةً على Workers + D1 بمصادقة `Authorization: Bearer <CELIA_MCP_API_TOKEN>`:
     `celia_status`, `system_live_view`, `find_skills`, `celia_ai_reply`, `google_gmail_search`, `google_drive_search`, `google_calendar_events_list`, `google_calendar_events_create`, `google_contacts_search`, `whatsapp_consent_upsert`, `whatsapp_contacts_list`, `whatsapp_send_text` (12 أداة مطابقة تمامًا لخادم Node MCP).
4. **تكامل Google Workspace الكامل بدون خادم خارجي:**
   - `GET /auth/google`، `POST /auth/google/link`، `GET /auth/google/callback` (مع `state` أحادي الاستخدام محمي في D1 وتجديد تلقائي لـ `access_token` وحماية من التكرار `Idempotency-Key` عند إنشاء أحداث التقويم)، بالإضافة إلى مسارات البحث في Gmail وDrive وCalendar وContacts وفصل الحساب (`POST /api/google/disconnect`).
5. **تكامل WhatsApp Cloud API + أوامر المالك بالعربية + ذكاء Gemini:**
   - `GET /webhooks/whatsapp` (تحدي التحقق الرسمي من Meta) و`POST /webhooks/whatsapp` (التحقق من التوقيع الخام، ومنع تكرار الرسائل في D1، وتنفيذ أوامر المالك الفورية بالعربية: **«اربط جوجل»**، **«لخص آخر إيميل»**، **«هات جدولي»**، والرد التلقائي المحكوم بالموافقة ونافذة الـ 24 ساعة عبر `GEMINI_API_KEY` مع بديل محلي آمن).
6. **ربط تلقائي للنشر والفحص الحيّ وواجهة GitHub Pages:**
   - تحديث `scripts/deploy-cloudflare-edge.mjs` لرفع الوحدات الأربع (`worker.js`، `state.js`، `crypto.js`، `runtime.js`) وتطبيق جميع ترحيلات D1 وتمرير أسرار WhatsApp الاختيارية متى أُضيفت.
   - تحديث `.github/workflows/cloudflare-deploy.yml` لتشغيل بوابة القبول الحيّة `npm run verify:edge` تلقائيًا بعد كل نشر على `main` وإصدار تقرير خالٍ من الأسرار.
   - تحديث `.github/workflows/pages.yml` لضبط `CELIA_REAL_SERVICE_URL=https://celia-phone-google.celiaelazamey.workers.dev` أثناء بناء الواجهة الثابتة.

---

## 3) الروابط الإنتاجية المجانية الدائمة لنظامك (تعمل بلا فيزا ولا تنام)

| المكوّن | الرابط الحي الدائم | المزايا في الخطة المجانية بدون فيزا |
|---|---|---|
| **الواجهة العربية المتكاملة (GitHub Pages)** | `https://celiaelazamey-arch.github.io/phone-google/` | مجاني 100%، شهادة HTTPS تلقائية، بلا نوم، 12 صفحة موثقة بـ WCAG 2.2 AA RTL |
| **الخادم الخلفي + MCP + OAuth + Webhook (Cloudflare Workers + D1)** | `https://celia-phone-google.celiaelazamey.workers.dev` | `100,000` طلب يوميًا مجانًا، قاعدة D1 SQLite دائمة (`5 GB`)، **صفر وقت نوم (`0 ms cold sleep`)**، بلا بطاقة |
| **نقطة بروتوكول MCP عن بُعد** | `https://celia-phone-google.celiaelazamey.workers.dev/mcp` | JSON-RPC 2.0 محمي بـ `Bearer CELIA_MCP_API_TOKEN` |
| **نقطة فحص الجاهزية والدوام** | `https://celia-phone-google.celiaelazamey.workers.dev/readyz` | تتحقق فعليًا في كل طلب من الكتابة والقراءة داخل D1 (`durable: true`) |

---

## 4) خطوات التفعيل النهائية من طرفك (دون إدخال أي بطاقة فيزا)

### الخطوة أ — النشر التلقائي (يعمل تلقائيًا بمجرد دمج PR `#70` في `main`)
لا تحتاج إلى إنشاء أي حساب جديد أو دفع أي مبلغ:
- أسرار Cloudflare (`CLOUDFLARE_API_TOKEN` و`CLOUDFLARE_ACCOUNT_ID`) والأسرار الـ 18 موجودة بالفعل في **GitHub Actions Secrets**.
- فور دمج الفرع في `main`، يشغّل GitHub Actions تلقائيًا:
  1. `cloudflare-deploy.yml`: يطبّق ترحيلات D1 الـ 12، ويرفع الخادم الرباعي الوحدات، ويتحقق حيًّا عبر `verify-live.mjs --mode edge` من عمل الأدوات الـ 12 وقاعدة D1 وبوابة `401`.
  2. `pages.yml`: يحدّث واجهة GitHub Pages مربوطةً بالخادم الحي.

### الخطوة ب — تفعيل ربط Google OAuth على النطاق المجاني (دقيقتان في Google Cloud Console)
في إعداد عميل OAuth الخاص بك داخل [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials) (المجاني بلا بطاقة):
1. أضف رابط الاستدعاء العكسي (Authorized redirect URI) التالي حرفيًا:
   ```text
   https://celia-phone-google.celiaelazamey.workers.dev/auth/google/callback
   ```
2. لبدء الربط في المتصفح (بصفتك المالك)، اطلب رابط تفويض موقّعًا لمرة واحدة:
   ```bash
   curl -sS -X POST https://celia-phone-google.celiaelazamey.workers.dev/auth/google/link \
     -H "Authorization: Bearer $CELIA_MCP_API_TOKEN"
   ```
   افتح الرابط الناتج ووافق على الصلاحيات؛ سيُحفَظ `refresh_token` مشفّرًا بـ `AES-256-GCM` داخل قاعدة D1 وسيتحول `/api/google/status` إلى `"connected": true`.

### الخطوة ج — تفعيل WhatsApp Cloud API المجاني (اختياري عند جاهزية تطبيق Meta)
1. من [Meta Developer Hub](https://developers.facebook.com/) (رقم الاختبار المجاني لا يطلب بطاقة دفع)، اضبط عنوان Webhook على:
   ```text
   https://celia-phone-google.celiaelazamey.workers.dev/webhooks/whatsapp
   ```
2. أضف الأسرار الأربعة التالية في **GitHub Repository → Settings → Secrets and variables → Actions** فقط (لا تلصقها في المحادثة أو الكود):
   - `WHATSAPP_ACCESS_TOKEN`
   - `WHATSAPP_PHONE_NUMBER_ID`
   - `WHATSAPP_APP_SECRET`
   - `WHATSAPP_VERIFY_TOKEN`
3. أعد تشغيل workflow **`Deploy Cloudflare Edge Worker`** من تبويب Actions لربطها بالخادم في ثوانٍ. بعدها يمكنك إرسال **«اربط جوجل»** أو **«لخص آخر إيميل»** أو **«هات جدولي»** من رقم هاتفك المسجّل في `PHONE_NUMBER` مباشرةً عبر واتساب!

---

## 5) أمر التحقق الحي في أي وقت

بعد دمج التحديث في `main`، يمكنك التحقق محليًا أو من GitHub Actions عبر:

```bash
CELIA_MCP_API_TOKEN="<رمزك_السري>" npm run verify:edge
```

يتحقق هذا الأمر آليًا من:
1. استجابة `/healthz` بكود `200` وزمن استجابة منخفض.
2. تطابق إصدار `/version` مع آخر التزام منشور.
3. نجاح `/readyz` وإثبات الكتابة الفعلية في قاعدة Cloudflare D1 (`storage.mode = "d1"`, `durable = true`).
4. رفض الوصول غير المصرح به إلى `/mcp` بكود `401`.
5. استرجاع قائمة أدوات MCP الـ 12 كاملة عبر `POST /mcp` دون تسريب أي سر في التقرير الناتج.
