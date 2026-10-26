# التقرير الشامل — مساعد الهاتف + Google (منظومة سيليا MCP 2026)
### المستودع: `celiaelazamey-arch/phone-google` — الإصدار 0.1.0 — Node ≥ 20
### آخر تحديث وتوثيق مُتحقق منه: 26 أكتوبر 2026

---

## الملخص التنفيذي

يمثّل المشروع منظومة متكاملة وآمنة تجمع بين **خادم REST API الأساسي** و**خادم Celia MCP (Model Context Protocol — JSON-RPC 2.0)** و**استوديو الوكيل التفاعلي العربي** لربط أربع ركائز:

1. **Google OAuth 2.0** (`Gmail`, `Drive`, `Calendar`, `People/Contacts`) بصلاحيات قراءة فقط + إنشاء حدث تقويم مفرد، مع تشفير الرموز عبر `AES-256-GCM`.
2. **WhatsApp Cloud API (Meta Graph API)** — استقبال Webhook موقّع بـ `HMAC-SHA256` على البايتات الخام، ومنع التكرار، وإرسال فردي محكوم بنافذة 24 ساعة وبموافقتين منفصلتين (`opted_in` و`ai_opted_in`).
3. **محركات الذكاء الاصطناعي الآمنة** — **Google Gemini (`gemini-2.5-flash`)** عبر الترويسة `x-goog-api-key`، و**Ollama المحلي (`qwen2.5:7b`)** المحمي ضد SSRF، و**محرك سيليا المحلي للسياسات** للردود العربية المحافظة الخالية من الهلوسة.
4. **خادم Celia MCP باثنتي عشرة مهارة + واجهات المعاينة الحية (`/`, `/live`, `/skills`)** — يعمل على MySQL 8.4 أو على مخزن الذاكرة الفوري (`memory-pool.js` / `CELIA_MCP_DISABLE_MYSQL=true`) ومفحوص آليًا في **GitHub Actions CI**.

**الحالة المُتحقق منها (100%):**
- فحص الصياغة (`npm run check`): **ناجح بالكامل** لجميع ملفات `src/*.js` و`test/*.js` و`public/*.js`.
- الاختبارات الآلية (`npm test`): **16 / 16 اختبارًا ناجحًا (0 فشل)**.
- الفحص الذاتي لخادم MCP (`npm run celia:mcp:verify`): **ناجح (`selfTest: "passed"`)** مع تسجيل **12 مهارة MCP**.
- التكامل المستمر (`.github/workflows/celia-mcp.yml`): يتحقق آليًا من عدم تتبع `.env`، ومن سرَّي المستودع `CELIA_MCP_API_TOKEN` و`GEMINI_API_KEY`، ومن الرد الحي الفعلي عبر Gemini.

> **ملاحظة حدود الإنتاج:** المستودع جاهز للتشغيل المحلي والمعاينة التفاعلية والربط عبر MCP، بينما يتطلب الإطلاق العام للعملاء الحقيقيين توفير نطاق HTTPS إنتاجي، وبيانات اعتماد Google OAuth حقيقية، ورقم WhatsApp Business موثّق لدى Meta، وقاعدة MySQL مُدارة (انظر §11 و§12).

---

## 1) نظرة عامة على المستودع وشجرة الملفات

| البند | القيمة |
|---|---|
| **الاسم والنسخة** | `phone-google-assistant@0.1.0` (`type: module` — ESM) |
| **بيئة التشغيل** | Node.js 20+ (Node 22 في Docker وGitHub Actions) |
| **التخزين** | MySQL 8.4 (`mysql2/promise`) + مخزن ذاكرة مدمج (`src/memory-pool.js`) |
| **حجم الشفرة البرمجية** | ~6,250 سطر عبر وحدات الخادم والواجهة والاختبارات وملفات البنية |
| **الأمان** | `AES-256-GCM`، `HMAC-SHA256`، `SHA-256` لـ OAuth state، `timingSafeEqual`، و`Helmet CSP` صارم |

```text
phone-google/
├── .dockerignore
├── .env.example                       # قالب متغيرات البيئة (خالٍ من الأسرار)
├── .gitignore                         # يحجب .env و node_modules
├── .github/workflows/celia-mcp.yml    # فحص CI الحي لـ Celia MCP + Gemini Secret
├── Dockerfile                         # node:22-alpine (شامل src + public + sql)
├── docker-compose.yml                 # MySQL 8.4 مع healthcheck
├── package.json / package-lock.json
├── README.md
├── sql/schema.sql                     # 5 جداول أساسية
├── src/                               # 14 وحدة خلفية
│   ├── app.js                         # تطبيق Express الأساسي (REST + Webhooks)
│   ├── server.js                      # تشغيل الخادم الأساسي وإغلاق آمن
│   ├── config.js                      # تحقق صارم لمتغيرات الخادم الأساسي
│   ├── db.js                          # تجمع اتصالات MySQL وضمان سجل المالك
│   ├── init-db.js                     # تهيئة جداول قاعدة البيانات
│   ├── memory-pool.js                 # مخزن ذاكرة متوافق مع استعلامات النظام
│   ├── auth.js                        # مصادقة Bearer برمز APP_API_TOKEN
│   ├── security.js                    # AES-256-GCM وHMAC وE.164 ونافذة 24h
│   ├── google.js                      # تدفق OAuth 2.0 ومسارات Google الخمسة
│   ├── whatsapp.js                    # Webhook واتساب والإرسال والموافقات
│   ├── gemini.js                      # عميل Gemini وسياسة الرد الآمن
│   ├── ollama.js                      # عميل Ollama qwen2.5:7b والتوجيه الذكي
│   ├── celia-mcp.js                   # خادم MCP (HTTP + stdio + 12 مهارة)
│   └── celia-ui.js                    # مسارات الواجهة ومختبر التشفير وSandbox RPC
├── public/                            # 7 ملفات واجهة متوافقة 100% مع CSP
│   ├── index.html                     # استوديو الوكيل الذكي ومحاكي واتساب
│   ├── app.js                         # منطق الاستوديو وتشغيل الـ 12 أداة
│   ├── live.html                      # لوحة النظام الحي اللحظية (/live)
│   ├── live.js                        # سكربت لوحة النظام الحي الخارجي
│   ├── skills.html                    # مستكشف المهارات Find Skills (/skills)
│   ├── skills.js                      # سكربت مستكشف المهارات الخارجي
│   └── styles.css                     # نظام التصميم العربي المتجاوب (داكن/فاتح)
└── test/                              # 4 ملفات اختبار (16 اختبارًا آليًا)
    ├── celia-mcp.test.js              # 6 اختبارات شاملة لـ MCP والواجهات وCSP
    ├── gemini.test.js                 # 2 اختبارات لعميل Gemini وحماية المفتاح
    ├── routes.test.js                 # 3 اختبارات لمسارات REST وOAuth وWebhook
    └── security.test.js               # 5 اختبارات للتشفير والتواقيع ونافذة 24h
```

---

## 2) البنية المعمارية المزدوجة

### أ) خادم REST الأساسي (`npm start` — المنفذ الافتراضي `3000`)
- `GET /health` — فحص حيوية عام.
- `GET|POST /webhooks/whatsapp` — تحقق اشتراك Meta واستقبال الرسائل الخام الموقّعة بـ `HMAC-SHA256`.
- `GET /auth/google` و`GET /auth/google/callback` — ربط حساب المالك بتحقق `state` مزدوج (كوكي `httpOnly` + تجزئة `SHA-256` أحادية الاستخدام في قاعدة البيانات).
- `/api/google/*` و`/api/whatsapp/*` — محمية بترويسة `Authorization: Bearer $APP_API_TOKEN`.

### ب) خادم Celia MCP والواجهة الحية (`npm run celia:mcp` — المنفذ الافتراضي `3010`)
- `POST /mcp` و`GET /mcp` — نقطة بروتوكول `MCP 2024-11-05` المحمية بـ `CELIA_MCP_API_TOKEN` (أو وضع `stdio` عبر `npm run celia:mcp:stdio`).
- `/` و`/live` و`/skills` — واجهات عربية تفاعلية تعمل بملفات JavaScript خارجية (`app.js`, `live.js`, `skills.js`) دون أي سكربت مضمّن، التزامًا بسياسة `script-src 'self'; script-src-attr 'none'`.
- `/api/live` و`/api/skills` و`/api/skills/find` و`/health` و`/healthz` — نقاط JSON حية لفحص حالة المنظومة واستكشاف المهارات.
- `POST /ui/workspace/rpc` و`POST /ui/workspace/crypto-lab` — بيئة تجربة معزولة في الذاكرة (Sandbox) لا تكشف أي رموز أو مفاتيح حقيقية.

---

## 3) سجل مهارات Celia MCP الاثنتي عشرة (`MCP_TOOLS`)

| # | اسم المهارة | الفئة | الوظيفة |
|---|---|---|---|
| 1 | `celia_status` | النظام | فحص جاهزية الخادم والتخزين ومزودي الذكاء الاصطناعي وGoogle وWhatsApp دون كشف أسرار |
| 2 | `find_skills` | النظام | بحث حي بالعربية والإنجليزية وتصفية فورية لقدرات المنظومة مع أمثلة استدعاء JSON-RPC |
| 3 | `system_live_view` | النظام | تقرير قياسات لحظي (زمن التشغيل، الذاكرة، حالة المزودات، وروابط المسارات الحية) |
| 4 | `celia_ai_reply` | الذكاء الاصطناعي | توليد رد عملاء آمن عبر Gemini أو Ollama `qwen2.5:7b` وفق القواعد الست الصارمة |
| 5 | `google_gmail_search` | Google | بحث قراءة فقط في بيانات رسائل Gmail الوصفية ومقتطفاتها (بدون مرفقات) |
| 6 | `google_drive_search` | Google | بحث قراءة فقط عن ملفات Google Drive بالاسم |
| 7 | `google_calendar_events_list` | Google | عرض مواعيد التقويم الأساسي القادمة (1–30 يومًا) |
| 8 | `google_calendar_events_create` | Google | إنشاء موعد جديد في التقويم الأساسي مع تحقق النطاق الزمني |
| 9 | `google_contacts_search` | Google | بحث قراءة فقط في جهات اتصال Google (الاسم، الهاتف، البريد) |
| 10 | `whatsapp_consent_upsert` | WhatsApp والأمان | تسجيل/تحديث موافقة المراسلة (`optedIn`) وموافقة الذكاء الاصطناعي المنفصلة (`aiOptedIn`) |
| 11 | `whatsapp_contacts_list` | WhatsApp والأمان | استعراض جهات الاتصال المسجلة وحالة نافذة الـ 24 ساعة |
| 12 | `whatsapp_send_text` | WhatsApp والأمان | إرسال رسالة فردية مشروطة بالموافقة المسبقة وبقاء نافذة الـ 24 ساعة مفتوحة |

بالإضافة إلى موردَي MCP (`celia://status` و`celia://policy/customer-reply`) وقالب التوجيه القياسي (`whatsapp_customer_reply`).

---

## 4) قاعدة البيانات ومخزن الذاكرة

يعتمد النظام على 5 جداول في `sql/schema.sql` (`app_users`، `oauth_states`، `google_credentials`، `whatsapp_contacts`، `whatsapp_messages`)، ويوفر `src/memory-pool.js` محاكاة متوافقة للاستعلامات الأساسية تُمكّن `celia-mcp.js` من العمل الفوري في البيئات السحابية والاختبارية عند تعذر الاتصال بـ MySQL أو عند تفعيل `CELIA_MCP_DISABLE_MYSQL=true`.

---

## 5) الضوابط الأمنية المطبّقة

1. **تشفير رموز OAuth (`src/security.js`):** تشفير مصادق عليه `AES-256-GCM` بمفتاح 32 بايت وعشوائية nonce بطول 12 بايت لكل عملية حفظ (`v1.<nonce>.<tag>.<ciphertext>`).
2. **مقارنة ثابتة الزمن:** `crypto.timingSafeEqual` لجميع رموز API ورموز التحقق وحالة OAuth لمنع هجمات التوقيت.
3. **حماية مسارات الواجهة (CSP):** ترويسات `Helmet` تفرض `script-src 'self'` و`script-src-attr 'none'` مع فصل كامل لكود الواجهة في ملفات `.js` خارجية وتهريب جميع النصوص الديناميكية (`escapeHtml`) لمنع XSS.
4. **حماية SSRF في Ollama (`src/ollama.js`):** حصر الاتصال افتراضيًا في عناوين الاسترجاع المحلي (`127.0.0.1` / `localhost` / `::1`) ما لم يُفعّل `OLLAMA_ALLOW_REMOTE=true` صراحةً.
5. **الامتثال لسياسات واتساب والذكاء الاصطناعي:** اشتراط موافقة مزدوجة موثقة المصدر + نافذة 24 ساعة + إرسال مفتاح Gemini عبر ترويسة HTTP فقط.

---

## 6) الاختبارات الآلية والتكامل المستمر (CI)

| الملف | عدد الاختبارات | الحالة | نطاق التحقق |
|---|---|---|---|
| `test/celia-mcp.test.js` | 6 | ✅ ناجح | إعدادات MCP، وضع الذاكرة `CELIA_MCP_DISABLE_MYSQL`، حماية SSRF، مصادقة `/mcp`، التوجيه لـ Gemini/Ollama، وفحص مسارات `/live` و`/skills` والتزام CSP الصارم |
| `test/gemini.test.js` | 2 | ✅ ناجح | إرسال مفتاح Gemini في الترويسة فقط ورفض التشغيل بدون مفتاح |
| `test/routes.test.js` | 3 | ✅ ناجح | عمومية `/health`، حماية `/api/*` و`/auth/google`، ورفض Webhook غير المهيأ |
| `test/security.test.js` | 5 | ✅ ناجح | تشفير/فك تشفير `AES-256-GCM`، `safeEqual`، تجزئة `state`، توقيع `HMAC`، ونافذة 24h |

**الإجمالي:** **16 اختبارًا آليًا — 16 ناجح (100%)**.

ويعمل سير العمل `.github/workflows/celia-mcp.yml` تلقائيًا عند كل دفع أو طلب دمج للتحقق من عدم وجود ملفات `.env` متتبعة، وفحص سرَّي `CELIA_MCP_API_TOKEN` و`GEMINI_API_KEY`، وتشغيل الخادم فعليًا واستدعاء `celia_ai_reply` حيًا عبر Gemini.

---

## 7) أوامر التشغيل والتحقق السريع

```bash
# 1. التثبيت وفحص الصياغة والاختبارات الكاملة
npm ci
npm run check
npm test

# 2. الفحص الذاتي الشامل لخادم Celia MCP
npm run celia:mcp:verify

# 3. تشغيل خادم Celia MCP والواجهة الحية على الذاكرة (بدون الحاجة لـ MySQL)
CELIA_MCP_DISABLE_MYSQL=true CELIA_MCP_API_TOKEN=$(openssl rand -hex 32) npm run celia:mcp
# ثم افتح:
#   http://localhost:3010/        (الاستوديو الرئيسي)
#   http://localhost:3010/live    (لوحة النظام الحي)
#   http://localhost:3010/skills  (مستكشف المهارات Find Skills)

# 4. تشغيل خادم REST الأساسي مع MySQL عبر Docker
cp .env.example .env   # واضبط APP_API_TOKEN وTOKEN_ENCRYPTION_KEY وMYSQL_PASSWORD
docker compose up -d mysql
npm run db:init
npm start
```

---

## 8) قائمة التحقق المتبقية قبل النشر الإنتاجي للعملاء الحقيقيين

- [ ] توفير نطاق عام بشهادة HTTPS صالحة وضبط `APP_BASE_URL` و`GOOGLE_REDIRECT_URI`.
- [ ] إنشاء عميل Google OAuth حقيقي وتفعيل واجهات Gmail / Drive / Calendar / People الأربعة.
- [ ] ربط رقم WhatsApp Business رسمي على Meta وضبط `WHATSAPP_VERIFY_TOKEN` و`WHATSAPP_APP_SECRET` و`WHATSAPP_ACCESS_TOKEN` و`WHATSAPP_PHONE_NUMBER_ID`.
- [ ] توفير قاعدة MySQL 8+ إنتاجية مُدارة مع نسخ احتياطي دوري وتشغيل `npm run db:init`.
- [ ] حفظ جميع الأسرار في مدير أسرار الاستضافة فقط، وعدم تفعيل `WHATSAPP_AUTO_REPLY_ENABLED=true` إلا بعد توثيق موافقات العملاء الفردية.
