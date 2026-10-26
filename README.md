# مساعد الهاتف + Google

نقطة بداية لخادم API يربط Google OAuth مع WhatsApp Cloud API ويخزن حالة التكامل ورسائل WhatsApp في MySQL. المستودع **هيكل قابل للتشغيل محليًا** وليس خدمة منشورة أو مربوطة بحساب Google/WhatsApp بعد.

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

## الموجّه الذكي الموحّد (`src/ai-router.js`)

المرحلة 1 من منظومة سيليا 2026: سلسلة إسناد تلقائية تحمي الحصص المجانية وتضمن عدم توقف الردود، وكلها تعمل من متغيرات البيئة دون أي تكلفة إضافية على GitHub Actions (المستودع عام):

| نوع المهمة | سلسلة المزودات بالترتيب |
|---|---|
| ردود سريعة (`fast`) | `GEMINI_API_KEY` → `AGENETROUTERAPI_KEY` (أو `AGENTROUTER_API_KEY`) → Ollama المحلي → حارس سيليا المحلي (بدون شبكة) |
| تفكير/كود (`deep`) | `DEEPSEEK_API_KEY` → AgentRouter → Gemini → Ollama |

خصائص الحماية:

- **المهلة الزمنية:** `AI_ROUTER_FAST_TIMEOUT_MS` (افتراضي 12 ثانية) و`AI_ROUTER_DEEP_TIMEOUT_MS` (45 ثانية) عبر `AbortSignal.timeout`.
- **اقتصاد الحصص:** أي رد `429/503/401/402` يضع المزوّد في تهدئة `AI_ROUTER_COOLDOWN_MS` (افتراضي 60 ثانية، مع احترام ترويسة `Retry-After`)، فيُستبعد تلقائيًا من الطلبات التالية.
- **النماذج المجانية:** افتراضيًا `gemini-2.5-flash` (مع بديلَي `gemini-flash-latest` و`gemini-flash-lite-latest` عند 404)، و`glm-4.5-air` على AgentRouter، و`deepseek-chat` لمهام الكود (يمكن ضبط `DEEPSEEK_MODEL=deepseek-reasoner`).
- **منع كشف الأسرار:** المفاتيح تُرسل في ترويسات فقط، ولا تظهر في URL أو نص الاستجابة أو رسائل الخطأ؛ كما يُستبدل أي مفتاح يعيده النموذج بـ `[REDACTED]`. دالة `status()` تُعيد أسماء المزودات ونماذجها فقط.

الوصول عبر MCP (يتطلب `CELIA_MCP_API_TOKEN`):

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"celia_smart_router",
           "arguments":{"prompt":"اكتب خطة لتطبيق حجوزات","task":"deep"}}}
```

كما يُستخدم الموجّه تلقائيًا في أداة `celia_ai_reply` عند ضبط `CELIA_AI_PROVIDER=router`، أو تلقائيًا في وضع `auto` عند وجود مفتاح AgentRouter أو DeepSeek. **استوديو الأدوات العام `/` يعمل كمحاكاة محلية فقط** ولا يستهلك أي مفتاح من مفاتيح الموجّه؛ التوجيه الحقيقي متاح حصرًا عبر `POST /mcp` المحمي بالرمز.

## لوحة فحص الأسرار السبعة (`npm run audit:secrets`)

سير العمل `.github/workflows/celia-mcp.yml` يتحقق تلقائيًا من **الأسرار السبعة** ويكتب جدولًا في تبويب **Summary** لكل تشغيل:

| السر | الفحص (بدون استهلاك حصة) |
|---|---|
| `CELIA_MCP_API_TOKEN` | طول ≥32 حرفًا + اختبار `401` محلي لبوابة Bearer |
| `GEMINI_API_KEY` | `GET /v1beta/models` |
| `AGENETROUTERAPI_KEY` / `AGENTROUTER_API_KEY` | `GET /v1/models` |
| `DEEPSEEK_API_KEY` | `GET /v1/models` ثم `/models` عند 404 |
| `ELEVENLABS_API_KEY` | `GET /v1/user/subscription` + **النسبة المتبقية من الأحرف المجانية** |
| `CELIA_VOICE_ID` | `GET /v1/voices/{id}` |
| `FIGMA_ACCESS_TOKEN` | `GET /v1/me` |

```bash
# محليًا (يقرأ الأسرار من البيئة فقط؛ لا يحتاج .env)
npm run audit:secrets
# وضع صارم: كود خروج 1 إذا لم تُتحقق كل الأسرار
AUDIT_STRICT=true npm run audit:secrets
# في GitHub Actions يُكتب التقرير تلقائيًا إلى GITHUB_STEP_SUMMARY
```

قواعد الأمان: المفاتيح في **ترويسات** فقط (لا روابط استعلام)، ولا تُطبع استجابة أي مزوّد ولا رسالة خطأ شبكية، والتقرير يحتوي أرقامًا وحالات معرّفة مسبقًا مع تمويه إضافي (`[REDACTED]`). الفحوص كلها **قراءة مجانية**: لا توليد نصوص ولا تحويل صوتي. من `workflow_dispatch` يمكن تفعيل `strict_secret_audit=true` لجعل المهمة تفشل عند غياب أي مفتاح.

**قراءة النتيجة:**

- `✅ متصل (HTTP 200)` — نقطة الفحص استجابت بنجاح. ملاحظة دقيقة: بعض نقاط `/v1/models` قد تكون عامة، لذلك هذا يؤكد **وصول المفتاح وعدم رفضه**، بينما التأكيد النهائي للصلاحيات يكون عند أول استخدام فعلي.
- `🟡 429` — المفتاح مقبول لكن الحصة/معدل الطلبات محدود حاليًا.
- `❌ المفتاح مرفوض (401/403)` — جرّبنا الترويسة الأصلية (`xi-api-key` / `X-Figma-Token`) ثم `Authorization: Bearer`، ورُفضتا. **الحل:** أعد إنشاء السر من لوحة المزوّد، ثم حدّثه في *Repository Secrets* بنفس الاسم، بدون علامات تنصيص أو مسافات زائدة. كما تُجرَّد الأزواج المطابقة من علامات التنصيص تلقائيًا عند القراءة.
- `⚠️ تعذّر التأكيد (404)` — بالنسبة لـ `CELIA_VOICE_ID` يعني أن المعرّف غير موجود في قائمة أصوات الحساب؛ استخدم معرّفًا حقيقيًا من `GET /v1/voices`.

تُصدر الأداة أيضًا سطر `::notice title=Celia 7-Secret Audit::` مضغوطًا (حالة كل مزوّد + نسبة الحصة) يمكن قراءته عبر **GitHub Checks API** حتى عند تعذّر تنزيل أرشيف السجلات.

> ملاحظة: قدرة تكامل الـ sandbox على **سرد** أسماء الأسرار محدودة بصلاحيات GitHub (`gh secret list` يعيد 403)، لذلك اللوحة لا تفترض وجودها؛ تعرض بدقة `⚪ غير مضبوط` أو `✅ متصل` أو `❌ مرفوض` لكل مزوّد حسب ما يصل فعلًا إلى بيئة التشغيل.

## النشر المجاني (Render Free / Koyeb Free)

- **`render.yaml`** — Blueprint جاهز على الخطة `free` باستخدام `Dockerfile.mcp` (خادم MCP فقط، منفذ 10000، فحص صحة `/health`). من لوحة Render: *Blueprints → New Blueprint Instance*، ثم أدخل قيم الحقول `sync: false` يدويًا.
- **Koyeb Free** — أنشئ Web Service من نفس المستودع مع `Dockerfile.mcp`، واضبط `CELIA_MCP_PORT=8080` و`CELIA_MCP_HOST=0.0.0.0` وبقية الأسرار السبعة في Environment Variables.
- **نشر يدوي من Actions** — اختر `Run workflow` ثم `deploy_target = render` أو `koyeb`. يتطلب إضافة الأسرار: `RENDER_DEPLOY_HOOK_URL` أو `KOYEB_API_TOKEN` + `KOYEB_SERVICE_ID`. المهمة **لا تعمل تلقائيًا** ولا تُنفّذ عند غيابها.
- حدود الخطة المجانية واقعية: **cold start** بعد الخمول، وتخزين **ذاكرة مؤقتة** (`memory`) بدل MySQL لأن الاستضافة لا توفر قاعدة بيانات مجانية دائمة. لا تُستخدم هذه النسخة لرسائل واتساب إنتاجية قبل توفير HTTPS ودومين وقاعدة بيانات وموافقات العملاء.

## حدود النشر والإكمال

هذا المستودع لا يحتوي أسرارًا ولا يملك نطاق HTTPS، قاعدة بيانات إنتاجية، Google OAuth client، مفتاح Gemini فعليًا، حساب Meta/WhatsApp Business، رقمًا موثقًا، أو قائمة موافقات العملاء. لذلك لا يمكن تفعيل تسجيل الدخول أو استقبال/إرسال رسائل حقيقية أو الرد عبر Gemini أو نشر الخدمة قبل توفير هذه الموارد. لا تشارك أسرار OAuth أو Gemini أو WhatsApp في المحادثات أو ملفات Git؛ ضعها في مخزن أسرار بيئة الاستضافة.
