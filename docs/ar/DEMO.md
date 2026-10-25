# الوضع التجريبي المجاني (Free Offline Demo)

وضع تشغيل كامل **بدون حسابات، بدون مفاتيح، بدون قاعدة بيانات، بدون إنترنت، وبدون أي تكلفة**. يستخدم نفس مسارات Express ونفس منطق الأمان في الإنتاج.

## التشغيل

```bash
npm ci
npm run demo
# ثم افتح http://localhost:3000 أو رابط المعاينة الحية
```

عند العمل خلف معاينة مؤطّرة (iframe) اضبط أصل الإطار:

```bash
DEMO_FRAME_ANCESTORS="https://*.e2b.app" npm run demo
```

أو عبر حاوية مستقلة تمامًا (لا تحتاج MySQL):

```bash
docker compose -f docker-compose.demo.yml up --build
# أو: docker build -f Dockerfile.demo -t phone-google-demo . && docker run -p 3000:3000 phone-google-demo
```

صورة الإنتاج `Dockerfile` لا تتضمن ملفات الواجهة التجريبية، والوضع التجريبي يرفض العمل أصلًا إذا كان `NODE_ENV=production`.

يُطبع في الطرفية رمز Bearer تجريبي عشوائي؛ اللوحة تحصل عليه تلقائيًا عبر وسم `<meta name="demo-token">` في الصفحة. الرمز يتغيّر مع كل تشغيل.

## ماذا يُستبدل؟

| المكوّن | الإنتاج | الوضع التجريبي |
| --- | --- | --- |
| Google APIs | `googleapis` مع OAuth حقيقي | `createDemoGoogleApi()` — بيانات وهمية، نفس واجهة الاستدعاء |
| Gemini | `generativelanguage.googleapis.com` | `config.demo.fetchImpl` — رد عربي حتمي آمن |
| WhatsApp Graph | `graph.facebook.com` | نفس `fetchImpl` — صندوق صادر داخل الذاكرة |
| MySQL | `mysql2/promise` pool | `DemoPool` — ينفّذ نفس جمل SQL داخل الذاكرة |
| الأسرار | مخزن أسرار الاستضافة | تُولّد عشوائيًا عند الإقلاع وتُمحى عند الإيقاف |
| CSP / Helmet | افتراضي صارم | يسمح بأصل المعاينة فقط عبر `DEMO_FRAME_ANCESTORS` |

## سيناريو الاختبار الكامل من اللوحة

1. **ربط حساب Google** → تُخزّن رموز وهمية مشفّرة AES-256-GCM (تحقق من الشكل `v1.*`).
2. جرّب بحث Gmail / Drive / جهات الاتصال، مواعيد Calendar، ثم **إنشاء موعد**.
3. **تسجيل الموافقتين** للرقم `+14155552671`.
4. **إرسال رسالة موقّعة** → يمرّ الجسم الخام عبر `/webhooks/whatsapp` مع HMAC-SHA256 صحيح، يُسجّل في `whatsapp_messages`، ثم يُولّد رد Gemini ويُرسل عبر Graph الوهمي.
5. **إعادة إرسال نفس الرسالة** → لا رد جديد (منع التكرار).
6. **بتوقيع خاطئ** → 401 ولا تُسجّل أي رسالة.
7. **سحب الموافقة** → لا رد ذكي، و`POST /api/whatsapp/messages` يرد 403.

## ما لا يفعله الوضع التجريبي

- لا يتصل بأي نطاق خارجي (أي عنوان غير متوقع يسبب خطأً صريحًا).
- لا يقرأ أو يكتب ملف `.env`.
- لا يُفعّل في `NODE_ENV=production` (يرمي `DEMO_MODE_REFUSED`).
- لا يحتوي أي ثابت سري في الكود: كل القيم `crypto.randomBytes`.
- لا يُترجم إلى نشر فعلي؛ بيانات الاعتماد الحقيقية تبقى خطوة منفصلة في [`FREE-STACK-2026.md`](FREE-STACK-2026.md).

## الاختبارات

```bash
npm test          # 17+ اختبارًا تشمل التدفّق التجريبي الكامل
npm run test:ci   # مع تقرير تغطية
```
