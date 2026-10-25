# دليل الربط الكامل المجاني — إصدار 2026

> الهدف: تشغيل مساعد الهاتف + Google **بكامل تدفقاته** دون دفع أي رسوم، مع الحفاظ على نفس معايير الأمان والخصوصية في الإنتاج. هذه الوثيقة جزء من حزمة الربط الكامل، ولا تحتوي ولا تطلب أي سرّ.

---

## 1. ماذا تعني «الربط الكامل» هنا؟

النظام يربط أربعة أطراف في تدفّق واحد موثّق:

```
Google (OAuth → Gmail / Drive / Calendar / Contacts)
                │  رموز مشفّرة AES-256-GCM داخل MySQL
                ▼
        واجهة API محمية بـ Bearer Token
                │
                ▼
WhatsApp Cloud API  ──webhook موقّع HMAC──►  تسجيل الرسائل + منع التكرار
                │
                ▼
   موافقة WhatsApp + موافقة AI + نافذة 24 ساعة  ──►  رد Gemini (اختياري)
                │
                ▼
        إرسال فردي فقط (لا جماعي، لا قوالب، لا مرفقات بريد)
```

الربط الكامل لا يعني «تجاوز الحاجة إلى بيانات اعتماد»: بيانات الاعتماد مثل `GOOGLE_CLIENT_SECRET` و`WHATSAPP_ACCESS_TOKEN` و`GEMINI_API_KEY` يجب أن ينشئها **صاحب الحساب** ويضعها في مخزن أسرار بيئة الاستضافة. ما أنجزناه في المستودع هو أن **كل شيء آخر** جاهز ويعمل فعليًا مجانًا: الكود، قاعدة البيانات، الاختبارات، CI، الوثائق، ووضع تجريبي كامل بلا أي حساب.

---

## 2. ثلاثة مستويات تشغيل (كلها مجانية)

| المستوى | ما تحتاجه | التكلفة | متى تستخدمه |
| --- | --- | --- | --- |
| **A. الوضع التجريبي (Demo)** | Node.js 20+ فقط | 0 | استعراض التدفّق كاملًا الآن، داخل معاينة حية، بدون حسابات ولا إنترنت خارجي |
| **B. محلي كامل (Local)** | Node.js + Docker (MySQL 8) | 0 | التطوير والاختبار الحقيقي مع قاعدة بيانات فعلية |
| **C. منشور بمستويات مجانية (Free-tier)** | A + حسابات Google/Meta/Gemini + استضافة مجانية + MySQL مجاني | 0* | تجربة ميدانية بأرقام وحسابات حقيقية |

\* المستويات المجانية للشركات تتغيّر مع الوقت. راجع صفحة التسعير الحالية لكل مزوّد قبل الاعتماد عليها، وراقب الحصص (quota) دائمًا. لا يوجد في هذا المستودع أي التزام بخدمة مدفوعة.

### المستوى A — الوضع التجريبي (الموصى به للبدء)

```bash
npm ci
npm run demo
# افتح المعاينة / http://localhost:3000
```

- نفس `createApp` ونفس مسارات الإنتاج، مع مزوّدي Google/Gemini/WhatsApp وهميين داخل العملية وقاعدة بيانات في الذاكرة.
- كل الأسرار تُولّد عشوائيًا عند كل تشغيل وتختفي عند الإيقاف.
- يُرفض التشغيل إذا كان `NODE_ENV=production` (حماية من تسريب وضع تجريبي للإنتاج).
- لوحة عربية تفاعلية: ربط Google، بحث Gmail/Drive/Contacts، مواعيد Calendar وإنشاؤها، تسجيل الموافقة، رسالة واردة موقّعة HMAC، اختبار توقيع مزوّر، الرد الذكي، صندوق الصادر.
- لا يقوم بأي اتصال شبكي خارجي؛ أي عنوان غير متوقع يرفضه المزوّد الوهمي.

### المستوى B — محلي كامل

```bash
npm run setup          # ينشئ .env بأسرار عشوائية (صلاحيات 0600، و.gitignore يستثنيه)
# أضف كلمات مرور MySQL في .env
docker compose up -d mysql
npm run db:init
npm test
npm start
curl http://localhost:3000/health
```

### المستوى C — نشر مجاني

راجع [`deploy/render.yaml`](../../deploy/render.yaml) كنموذج Blueprint و`SECURITY.md` لسياسة الأسرار. الفكرة: خدمة ويب مجانية + قاعدة MySQL مجانية + متغيّرات البيئة في مخزن أسرار الاستضافة + نطاق HTTPS مجاني توفّره الاستضافة. **لا تضع أي سرّ في `render.yaml` أو في Git.**

---

## 3. خريطة الخدمات المجانية

| المكوّن | الخيار المجاني | ملاحظات مهمة |
| --- | --- | --- |
| الكود / CI / التوثيق | GitHub (+ Actions + Pages + Dependabot) | مجاني للمستودعات العامة؛ دقائق Actions محدودة |
| Runtime | Node.js 20 أو 22 LTS | مفتوح المصدر |
| قاعدة البيانات | MySQL 8 محليًا (Docker) أو MySQL متوافق على طبقة Serverless مجانية أو VM دائم مجانًا | تأكد من TLS عند الاتصال البعيد، وقيّد الوصول بجدار ناري |
| Google OAuth + Gmail/Drive/Calendar/People | Google Cloud (شاشة موافقة + مستخدمو اختبار) | التطبيق غير الموثّق يسمح بمستخدمي اختبار فقط؛ النطاقات حسّاسة وتتطلب تحققًا للنشر العام |
| WhatsApp Cloud API | تطبيق Meta + رقم اختبار | المحادثات التي يبدأها المستخدم لها بدل مجاني؛ الرسائل خارج نافذة 24 ساعة تحتاج **قالبًا معتمدًا** — غير مفعّل في هذا الإصدار |
| Gemini | مفتاح API على الطبقة المجانية | الحصة محدودة؛ الردود معلّقة على موافقة AI منفصلة |
| الاستضافة | طبقة مجانية من مزوّد ويب + HTTPS | تحقّق من سياسة النوم/الإيقاف ومن ساعات التشغيل الشهرية |
| المراقبة | `/health` + سجلات الاستضافة | لا حاجة لخدمة مراقبة مدفوعة |

---

## 4. خطوات التفعيل الحقيقي (بدون مشاركة الأسرار في المحادثة)

### 4.1 الأسرار المحلية

```bash
npm run setup     # APP_API_TOKEN + TOKEN_ENCRYPTION_KEY + WHATSAPP_VERIFY_TOKEN
```

`TOKEN_ENCRYPTION_KEY` يجب أن يكون Base64 لـ 32 بايت بالضبط. لا تُعد تدويره بعد حفظ رموز Google وإلا لن تُفكّ تشفيرها.

### 4.2 Google

1. أنشئ مشروعًا في Google Cloud وفعّل: Gmail API، Drive API، Calendar API، People API.
2. اضبط شاشة موافقة OAuth وأضف بريدك كمستخدم اختبار أثناء التطوير.
3. أنشئ OAuth Client من نوع **Web Application**، وأضف redirect URI مطابقًا تمامًا لـ `GOOGLE_REDIRECT_URI` (HTTPS عند النشر).
4. ضع `GOOGLE_CLIENT_ID` و`GOOGLE_CLIENT_SECRET` في مخزن أسرار الاستضافة.
5. اضبط `APP_OWNER_EMAIL` للتحقق من هوية الحساب عند الـ callback.
6. افتح `GET /auth/google` عبر وكيل يضيف `Authorization: Bearer $APP_API_TOKEN`.

النطاقات: `openid email` + Gmail/Drive/Contacts للقراءة فقط + `calendar.events` للقراءة وإنشاء موعد. لا مرفقات بريد ولا إرسال بريد.

### 4.3 WhatsApp Cloud API

1. أنشئ تطبيق Meta وأضف WhatsApp، ثم احصل على `WHATSAPP_PHONE_NUMBER_ID` و`WHATSAPP_ACCESS_TOKEN` و`WHATSAPP_APP_SECRET`.
2. اضبط `WHATSAPP_VERIFY_TOKEN` (مولّد عشوائيًا في `.env` بواسطة `npm run setup`).
3. سجّل `https://<نطاقك>/webhooks/whatsapp` في Webhooks واشترك في `messages`.
4. اجمع موافقة صريحة وموثّقة من كل عميل قبل أي إرسال:

```bash
curl -X POST "https://<نطاقك>/api/whatsapp/contacts/14155552671/consent" \
  -H "Authorization: Bearer $APP_API_TOKEN" -H 'content-type: application/json' \
  -d '{"optedIn":true,"aiOptedIn":false,"source":"نموذج موافقة موثق بتاريخ 2026-10-25"}'
```

5. `aiOptedIn:true` فقط إذا أُبلغ العميل صراحةً أن رسائله تُعالج بواسطة Gemini ووافق بشكل منفصل.
6. `WHATSAPP_AUTO_REPLY_ENABLED=true` فقط بعد اكتمال مفاتيح Gemini وMeta والموافقات.

### 4.4 Gemini

ضع `GEMINI_API_KEY` في مخزن الأسرار، و`GEMINI_MODEL` نموذج متاح لحسابك، و`GEMINI_BUSINESS_CONTEXT` حقائق النشاط المسموح استخدامها فقط. سياسة النظام تمنع اختلاق الأسعار أو المخزون أو حالة الطلبات وتُحيل الشكاوى والمدفوعات لموظف بشري.

### 4.5 قاعدة البيانات

```bash
npm run db:init
```

يُنشئ الجداول: `app_users`, `oauth_states`, `google_credentials`, `whatsapp_contacts`, `whatsapp_messages` مع مفاتيح وفهارس ومنع تكرار رسائل المزوّد.

### 4.6 التحقق بعد النشر

```bash
curl https://<نطاقك>/health
curl -H "Authorization: Bearer $APP_API_TOKEN" "https://<نطاقك>/api/google/calendar/events?days=7"
```

---

## 5. واجهات API

كل مسارات `/api/*` تتطلب `Authorization: Bearer $APP_API_TOKEN`.

| الطريقة | المسار | الوصف |
| --- | --- | --- |
| GET | `/health` | فحص الصحة (عام، يعيد `mode`) |
| GET | `/auth/google` | بدء OAuth (يحتاج الرمز) |
| GET | `/auth/google/callback` | استلام OAuth مع state وحيد الاستخدام |
| GET | `/api/google/gmail/search?q=` | بحث بيانات وصفية للرسائل (بدون مرفقات) |
| GET | `/api/google/drive/search?q=` | بحث أسماء الملفات |
| GET | `/api/google/calendar/events?days=7` | مواعيد الأيام القادمة |
| POST | `/api/google/calendar/events` | إنشاء موعد مفرد |
| GET | `/api/google/contacts/search?q=` | بحث جهات الاتصال |
| POST | `/api/whatsapp/contacts/:phone/consent` | تسجيل/سحب الموافقة |
| POST | `/api/whatsapp/messages` | إرسال فردي داخل نافذة 24 ساعة |
| GET/POST | `/webhooks/whatsapp` | تحقّق Meta + استقبال موقّع HMAC |
| GET | `/demo/state` | حالة الوضع التجريبي (demo فقط) |
| POST | `/demo/google/connect` | حقن رموز تجريبية مشفّرة (demo فقط) |
| POST | `/demo/webhook/inbound` | محاكاة رسالة موقّعة (demo فقط) |

---

## 6. ما يفرضه الكود تلقائيًا (لا يعتمد على تذكّرك)

- تشفير رموز Google بـ AES-256-GCM، و`state` مخزّن كـ SHA-256 مع صلاحية 10 دقائق واستهلاك مرة واحدة، وربطه بكوكي `httpOnly` + `SameSite=Lax`.
- تحقّق HMAC-SHA256 على **البايتات الخام** قبل تحليل JSON في الـ webhook.
- منع تكرار الرسائل عبر مفتاح فريد على `provider_message_id`.
- رفض أي إرسال بدون موافقة، ورفض أي رسالة خارج نافذة 24 ساعة (يلزم قالب معتمد غير مفعّل هنا).
- رفض تشغيل الرد الآلي إلا مع `optedIn && aiOptedIn` ونافذة الخدمة ومفاتيح Gemini كاملة.
- `helmet`، حد أحجام الأجسام، تحديد طول المدخلات، E.164، توحيد التوقيت UTC، إيقاف تشغيلي نظيف.
- الوضع التجريبي معزول: يُرفض في `NODE_ENV=production`، ولا يحتوي أسرارًا ثابتة، ولا يتصل بأي نطاق خارجي.

---

## 7. حدود يجب أن تعرفها بوضوح

- لا يمكن تفعيل تسجيل دخول Google أو إرسال/استقبال رسائل WhatsApp حقيقية أو ردود Gemini فعلية **من داخل هذه الجلسة**؛ ذلك يتطلب حساباتك ومفاتيحك أنت، وتُضاف في بيئة الاستضافة لا في المحادثة ولا في Git.
- لا توجد إدارة مستخدمين متعددة، لوحة تحكم إدارية، بث جماعي، جدولة تذكيرات، قوالب معتمدة، ولا معالجة طلبات بيع أو دفع.
- الطبقات المجانية لها حصص وقيود سياسات (خصوصًا Meta وGoogle). راقب الاستهلاك، ولا تبنَ عليها خدمة حرجة دون خطة ترقية.
- أي تغيير في `TOKEN_ENCRYPTION_KEY` بعد ربط Google يبطل الرموز المحفوظة؛ أعد الربط عند التدوير.

---

## 8. استكشاف الأخطاء

| العَرَض | السبب المرجّح | الحل |
| --- | --- | --- |
| `google_not_configured` (503) | Client ID/Secret ناقصان | أضفهما في مخزن الأسرار |
| `google_not_connected` (409) | لم يكتمل OAuth أو مُسحت الرموز | افتح `/auth/google` مجددًا |
| `recipient_has_not_opted_in` (403) | لا توجد موافقة مسجّلة | سجّل الموافقة عبر endpoint |
| `outside_customer_service_window_use_approved_template` (403) | مرّت 24 ساعة على آخر رسالة واردة | انتظر رسالة من العميل أو فعّل قوالب معتمدة |
| webhook يرد 401 | توقيع HMAC خاطئ أو `WHATSAPP_APP_SECRET` غير مطابق | طابق السر وتأكد من تمرير الجسم الخام |
| الرد الآلي لا يعمل | مفاتيح ناقصة أو `aiOptedIn=false` أو العلم معطّل | راجع الشروط الأربعة في الأعلى |

---

## 9. ملفات الحزمة

```
.github/workflows/ci.yml           اختبارات تلقائية مجانية
.github/workflows/pages.yml        نشر الوثائق على GitHub Pages
.github/dependabot.yml            تحديثات اعتماديات أسبوعية
docs/ar/FREE-STACK-2026.md        هذا الدليل
docs/ar/DEMO.md                   دليل الوضع التجريبي
docs/site/index.html              موقع الوثائق الثابت
deploy/render.yaml                مخطط نشر مجاني (بلا أسرار)
scripts/setup-env.mjs             مولّد أسرار محلية
src/demo-*.js, public/            المزوّدون الوهميون واللوحة العربية
test/demo.test.js                 اختبارات التدفّق الكامل
```
