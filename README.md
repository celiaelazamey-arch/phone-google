# مساعد الهاتف + Google

نقطة بداية لخادم API يربط Google OAuth مع WhatsApp Cloud API ويخزن حالة التكامل ورسائل WhatsApp في MySQL.

**تشغيل حيّ كامل (مجاني، بلا مفاتيح):**

```bash
CELIA_MCP_DISABLE_MYSQL=true CELIA_MCP_API_TOKEN=$(openssl rand -hex 32) \
CELIA_MCP_HOST=0.0.0.0 CELIA_MCP_PORT=3010 node src/celia-mcp.js
# ثم افتح http://localhost:3010
```

هذا الأمر يشغّل الواجهة العربية + خادم MCP (١٢ أداة) + مختبر التشفير على ذاكرة مؤقتة، وهو نفس ما يعمل في المعاينة الحيّة.

**صفحة الهبوط الفاخرة (تسويقية، مركّزة على التحويل):** افتح `http://localhost:3010/landing` محليًا — وعلى GitHub Pages تصبح على `https://celiaelazamey-arch.github.io/phone-google/landing.html`. ملفاتها `public/landing.html` + `landing.css` + `landing.js` (أصول خارجية فقط لتوافق CSP)، وتُبنى تلقائيًا ضمن `dist/`، وخطتها المنفَّذة في [`docs/خطة-نشر-صفحة-الهبوط.md`](docs/خطة-نشر-صفحة-الهبوط.md).

**نشر دائم مجاني:** نسخة ثابتة جاهزة لـ GitHub Pages (`npm run build:pages` + سير عمل جاهز؛ التفعيل الأول يحتاج نقرة واحدة من المالك: Settings → Pages → Source: GitHub Actions)، وبديل خادم كامل عبر `render.yaml` + `Dockerfile.mcp` على طبقة Render المجانية. التفاصيل وسبب الحاجة للنقرة في [`docs/خطة-النشر-المجاني.md`](docs/خطة-النشر-المجاني.md).

> الخادم الكامل (`src/server.js`) يحتاج Node.js + MySQL وأسرار Google/WhatsApp/Gemini. النسخة الثابتة على Pages لا تحتوي أي سر ولا تتصل بأي خدمة خارجية.

## ما يتضمنه المشروع

- ربط Google OAuth بتدفق state عشوائي أحادي الاستخدام، cookie آمنة، ومدة صلاحية قصيرة.
- حفظ رموز Google مشفّرة باستخدام AES-256-GCM، لا كنص مكشوف.
- بحث للقراءة فقط في Gmail وDrive وجهات الاتصال، وقراءة مواعيد Calendar مع إنشاء حدث مفرد عبر API موثّق.
- Webhook لواتساب يتحقق من HMAC-SHA256، ويسجل الرسائل الواردة مع منع التكرار.
- الرد الذكي عبر Gemini معطّل افتراضيًا. لا تُرسل الرسالة الواردة إلى Gemini إلا عند وجود موافقة منفصلة مسجلة على معالجة الذكاء الاصطناعي، إضافة إلى موافقة WhatsApp ونافذة خدمة العملاء البالغة 24 ساعة. لا توجد نقطة إرسال جماعي.
- واجهة إرسال فردي تفرض الموافقة المسجلة ونافذة الخدمة. الرسائل خارج النافذة تحتاج قالب WhatsApp معتمد؛ إرسال القوالب غير مفعّل في هذا الإصدار.

## المتطلبات

Node.js 20+، MySQL 8+، وبيانات اعتماد OAuth من Google وبيانات WhatsApp Cloud API من Meta. مفتاح Gemini مطلوب فقط للردود الذكية الآلية.

## التشغيل المحلي

```bash
cp .env.example .env
# عدّل MYSQL_PASSWORD وMYSQL_ROOT_PASSWORD وأنشئ APP_API_TOKEN عشوائيًا بطول 32 حرفًا على الأقل.
# أنشئ TOKEN_ENCRYPTION_KEY بواسطة: openssl rand -base64 32
docker compose up -d mysql
npm install
npm run db:init
npm test
npm start
```

تحقق محليًا من الخادم عبر `GET http://localhost:3000/health`. انسخ `.env.example` إلى `.env` ولا ترفع ملف `.env` أو أي token إلى GitHub.

## إعداد Google

1. أنشئ مشروعًا في Google Cloud، وفعّل Gmail API وGoogle Drive API وGoogle Calendar API وPeople API.
2. أنشئ OAuth Client من نوع Web Application، واضبط redirect URI المطابق تمامًا لقيمة `GOOGLE_REDIRECT_URI`.
3. في التطوير المحلي يمكن أن يكون callback هو `http://localhost:3000/auth/google/callback`. على الإنترنت استخدم HTTPS ونطاقك الفعلي. لا تستخدم `yourdomain.com` كنطاق حرفي.
4. أدخل `GOOGLE_CLIENT_ID` و`GOOGLE_CLIENT_SECRET` و`GOOGLE_REDIRECT_URI` في مخزن الأسرار الخاص ببيئة التشغيل. قد تتطلب شاشة موافقة OAuth حسابات اختبار أثناء التطوير أو التحقق من Google قبل الاستخدام العام.
5. افتح `GET /auth/google` من خلال واجهة/وكيل يضيف رمز Bearer للمالك؛ بعد الموافقة يعيد Google المتصفح إلى callback.

عند ضبط `APP_OWNER_EMAIL`، يتحقق callback من هوية Google الموثقة ويرفض أي حساب آخر. نطاقات الهوية `openid email` تستخدم لهذا التحقق.

النطاقات المستخدمة: Gmail read-only، Drive read-only، Contacts read-only، وCalendar events (للقراءة وإنشاء موعد). لا يقرأ التطبيق مرفقات البريد ولا يرسل بريدًا إلكترونيًا.

## إعداد WhatsApp Cloud API

- أنشئ تطبيق Meta وWhatsApp Business Phone Number، واضبط `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` وإصدار Graph API مدعومًا في `WHATSAPP_API_VERSION`.
- سجّل عنوان HTTPS `https://<your-domain>/webhooks/whatsapp` في إعدادات Webhooks لدى Meta واشترك في `messages`.
- أدخل `GEMINI_API_KEY` في `.env` المحلي أو مخزن أسرار الاستضافة؛ لا ترسله في المحادثة ولا تضعه في ملفات GitHub. اختر `GEMINI_MODEL` متاحًا لحسابك، ويمكن وضع حقائق النشاط المسموح استخدامها في `GEMINI_BUSINESS_CONTEXT`.
- لا تضبط `WHATSAPP_AUTO_REPLY_ENABLED=true` إلا بعد إعداد مفاتيح Gemini وMeta وإبلاغ العملاء صراحةً بأن رسائلهم ستُعالج بواسطة Gemini، وتسجيل موافقتهم المنفصلة. يطلب النظام `aiOptedIn: true` بالإضافة إلى `optedIn: true`، ولا يعتبر مجرد وصول رسالة موافقة.
- للمراسلات خارج نافذة 24 ساعة، يلزم قالب معتمد وموافقة مناسبة؛ هذه النسخة ترفضها بدل تجاوز السياسة.

## المصادقة وواجهات API

كل مسارات `/api/*` تتطلب `Authorization: Bearer $APP_API_TOKEN`.

- `GET /api/google/gmail/search?q=<Gmail query>`
- `GET /api/google/drive/search?q=<name>`
- `GET /api/google/calendar/events?days=7`
- `POST /api/google/calendar/events` مع JSON مثل `{"summary":"موعد","start":"2026-10-27T14:00:00Z","end":"2026-10-27T14:30:00Z"}`
- `GET /api/google/contacts/search?q=<query>`
- `POST /api/whatsapp/contacts/<phone-without-plus>/consent` مع JSON `{"optedIn":true,"aiOptedIn":true,"source":"نموذج موافقة موثق"}` لتسجيل الموافقتين فقط إذا كانتا قد أُخذتا فعلًا؛ `aiOptedIn` اختياري ويمكن أن يبقى `false`.
- `POST /api/whatsapp/messages` مع JSON `{"phone":"+14155552671","text":"مرحبًا"}` لإرسال فردي مسموح به.

حاليًا رمز API واحد لمالك واحد (single-owner deployment). لا توجد إدارة مستخدمين/صلاحيات متعددة، لوحة تحكم، WhatsApp broadcast، جدولة تذكيرات، معالجة طلبات بيع أو ربط فعلي بـMySQL موجود لدى المستخدم.

## خادم Celia MCP (`npm run celia:mcp`)

يوفر المشروع خادم **Model Context Protocol (JSON-RPC 2.0)** محميًا برمز `CELIA_MCP_API_TOKEN` على المسار `POST /mcp` (مع وضع `stdio` اختياري عبر `npm run celia:mcp:stdio` ولوحة فحص تفاعلية عربية على `/`). يدعم الخادم تلقائيًا:
- **Gemini (`GEMINI_API_KEY`)** كمزود أساسي فور توفّر المفتاح (بما في ذلك داخل **GitHub Actions Secrets** عبر `.github/workflows/celia-mcp.yml` دون الحاجة إلى تنزيل نماذج محلية).
- **Ollama المحلي (`qwen2.5:7b`)** كبديل محلي عند تشغيله على جهازك الشخصي.

```bash
cp .env.example .env
# أنشئ CELIA_MCP_API_TOKEN باستخدام openssl rand -hex 32، وضعه في .env
# اختياري على جهازك المحلي فقط إن لم تستخدم GEMINI_API_KEY:
ollama pull qwen2.5:7b
npm install
npm run celia:mcp
```

## حدود النشر والإكمال

هذا المستودع لا يحتوي أسرارًا ولا يملك نطاق HTTPS، قاعدة بيانات إنتاجية، Google OAuth client، مفتاح Gemini فعليًا، حساب Meta/WhatsApp Business، رقمًا موثقًا، أو قائمة موافقات العملاء. لذلك لا يمكن تفعيل تسجيل الدخول أو استقبال/إرسال رسائل حقيقية أو الرد عبر Gemini أو نشر الخدمة قبل توفير هذه الموارد. لا تشارك أسرار OAuth أو Gemini أو WhatsApp في المحادثات أو ملفات Git؛ ضعها في مخزن أسرار بيئة الاستضافة.

## النشر المجاني على GitHub Pages (نسخة الواجهة + أدوات MCP داخل المتصفح)

```bash
npm run build:pages      # يولّد dist/ من public/ + طبقة المحاكاة
# o افتح dist/index.html عبر أي خادم ثابت أو ارفع dist/ كما هي
```

- سكربت البناء `scripts/build-pages.mjs` يستخرج `MCP_TOOLS` و`SERVER_INFO` من `src/celia-mcp.js` ويحقنهما في `dist/celia-static-shim.js`، ثم يحقن الوسم في كل صفحة ويضيف `.nojekyll` و`404.html`.
- الطبقة الثابتة تخدم `GET /health` و`POST /ui/workspace/rpc` و`POST /mcp` و`POST /ui/workspace/crypto-lab` داخل المتصفح: `initialize`, `ping`, `tools/list`, `tools/call` (١٢ أداة), `resources/*`, `prompts/*`.
- النشر تلقائي عبر `.github/workflows/pages.yml` عند كل دفع إلى `main` (بيئة `github-pages`, `build_type: workflow`). لا يحتاج أي سر ولا بطاقة دفع.
- الاختبارات: `node --test test/static-shim.test.js` (تبني `dist/` وتتحقق من كل أداة ونقاط REST ومسار التشفير والموافقات).

### قيود النسخة الثابتة (معلنة في الواجهة)

- التخزين في ذاكرة التبويب فقط (`storage: memory`) ويُصفَّر عند التحديث.
- Google/WhatsApp تُرجع بيانات `demo: true`؛ لا OAuth حقيقي ولا إرسال رسائل، ولا استقبال Webhook (Pages لا تقبل POST خارجيًا).
- الردود يولّدها محرك السياسة العربي المدمج `celia-local-policy-engine` بلا مفتاح؛ وللردود السحابية الصق مفتاحك في تبويب «النماذج المجانية» (يبقى في `sessionStorage` بمتصفحك).
- للترقية إلى خدمة كاملة: Render/Koyeb/Cloudflare + MySQL مُدار، ثم إضافة الأسرار في منصة الاستضافة وربط Webhook واتساب.
