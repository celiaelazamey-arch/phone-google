# عقد جسر المهام المجدولة — celia-cron-bridge

**التاريخ:** 27 أكتوبر 2026 · **الحالة:** الكود المرجعي والاختبارات منفذة
(`workers/celia-cron-bridge/`, `test/cron-bridge.test.js`, `test/cron-lib.test.js`)،
**النشر لم يحدث بعد** — يحتاج حساب Cloudflare وقرار المالك. الواجهة: [`public/cron.html`](../public/cron.html).

## 1. حدود الثقة

```
متصفح المالك (GitHub Pages)        Cloudflare Worker                 cron-job.org
لوحة /cron (ثابتة، بلا أسرار)
   │  Authorization: Bearer CELIA_ADMIN_TOKEN
   ▼
celia-cron-bridge  ── Authorization: Bearer CRONJOB_API_KEY ──▶  api.cron-job.org
```

- الصفحة على Pages **ثابتة ولا تحتوي أي سر**. الرمز الإداري يُدخله المالك وقت التشغيل ويبقى في
  `sessionStorage` للتبويب فقط، ويُمسح عند القطع أو إغلاق التبويب. لا يوضع في رابط ولا يُرسل لمزوّد آخر.
- السرّان يعيشان داخل Worker عبر `wrangler secret put`:
  `CRONJOB_API_KEY` (مفتاح حساب cron-job.org) و`CELIA_ADMIN_TOKEN` (رمز دخول اللوحة، 32 حرفًا عشوائيًا فأكثر).
- الجسر **محوّل (adapter) لا صانع قرار**: بوابة السياسة والموافقات تبقى في نواة CeliaOS (العقدة 2 في المعمارية).
  تأكيدات الواجهة الحسّاسة (إنشاء/تعديل/حذف) طبقة بشرية مرئية، وليست بديلًا عن بوابة الخادم في المسار الكامل.

## 2. سطح الواجهة السبعي

كل المسارات تحت `/api/cron` بترويسة `Authorization: Bearer <CELIA_ADMIN_TOKEN>` (عدا `OPTIONS`).

| الأداة | طلب اللوحة → الجسر | الجسر → cron-job.org | الحساسية |
|---|---|---|---|
| `cron.list` | `GET /api/cron/jobs` | `GET /jobs` | قراءة |
| `cron.create` | `POST /api/cron/jobs` بجسم `{job}` | `PUT /jobs` | حسّاسة |
| `cron.update` | `PATCH /api/cron/jobs/:jobId` بجسم `{job}` | `PATCH /jobs/:jobId` | حسّاسة |
| `cron.enable` | `PATCH /api/cron/jobs/:jobId` `{job:{enabled:true}}` | `PATCH /jobs/:jobId` | كتابة |
| `cron.disable` | نفسها بـ`enabled:false` | `PATCH /jobs/:jobId` | كتابة |
| `cron.history` | `GET /api/cron/jobs/:jobId/history` | `GET /jobs/:jobId/history` | قراءة |
| `cron.delete` | `DELETE /api/cron/jobs/:jobId` | `DELETE /jobs/:jobId` | حسّاسة |

ومساعدات: `GET /api/cron/health` (يتطلب الرمز ويثبت صحته) و`GET /` (هوية الخدمة بلا أسرار).

### أمثلة الأجسام

إنشاء (يحوّله الجسر إلى `PUT /jobs` عند المزوّد):

```json
{
  "job": {
    "url": "https://celia.example/webhooks/daily",
    "title": "فحص صحة الخادم اليومي",
    "enabled": true,
    "saveResponses": true,
    "requestMethod": 0,
    "schedule": {
      "timezone": "Africa/Cairo",
      "expiresAt": 0,
      "hours": [8], "minutes": [0],
      "mdays": [-1], "months": [-1], "wdays": [-1]
    }
  }
}
```

القيمة `-1` في أي مصفوفة جدول تعني «كل». `requestMethod`: 0=GET، 1=POST، 2=PUT، 3=PATCH، 4=DELETE.
السجل يعيد `{history:[{identifier,date,datePlanned,httpStatus,statusText,duration}], predictions:[unix…]}`
والتنبؤات حتى ثلاثة مواعيد قادمة.

## 3. جدول الأخطاء

| الحالة | `error.code` | المعنى |
|---|---|---|
| 401 | `unauthorized` | الرمز الإداري غائب/مرفوض؛ المقارنة بزمن ثابت |
| 404 | `not_found` | مسار أو وظيفة غير موجودة |
| 405 | `method_not_allowed` | طريقة غير مدعومة على المسار |
| 413 | `payload_too_large` | الجسم أكبر من 8 كيلوبايت |
| 400 | `invalid_json` / `empty_body` / `unreadable_body` | جسم تالف |
| 422 | `invalid_job` | حقل خارج قائمة السماح أو قيمة غير صالحة |
| 429 | `upstream_429` | تجاوز حد المزوّد (5 طلبات/ثانية) |
| 502 | `upstream_unreachable` | فشل شبكي نحو المزوّد — لا إعادة إرسال تلقائية |
| 503 | `upstream_not_configured` | `CRONJOB_API_KEY` غير مضبوط على Worker |

أخطاء المزوّد تُعقّم: رمز الحالة يُمرّر ورسالة عربية عامة فقط؛ لا تروي ترويسات المزوّد ولا أي مفتاح.

## 4. قواعد التحقق وقائمة السماح

الحقول المقبولة في `job` حصرًا: `url` (HTTP(S))، `title` (نص ≤120)، `enabled`/`saveResponses` (boolean)،
`requestMethod` (0–8)، و`schedule` بحقول: `timezone` (≤64 حرفًا)، `expiresAt` (صحيح غير سالب)،
ومصفوفات `hours/minutes/mdays/months/wdays` أعدادًا في المدى الصحيح وبحد أقصى 64 عنصرًا. أي حقل آخر
(مثل `extendedData` أو ترويسات مخصصة) يُرفض 422 بدل تمريره صامتًا.

## 5. CORS والمتصفح

- `ALLOWED_ORIGIN` قائمة أصول مفصولة بفواصل (مثل `https://celiaelazamey-arch.github.io`). يُعكس الأصل المطابق فقط مع `Vary: Origin`.
- بدون إعداد المتغير: نفس المنشأ فقط، فلا يستطيع موقع غريب مناداة الجسر من متصفح.
- فحص `OPTIONS` المسبق لا يتطلب رمزًا؛ الطرق المعلنة: `GET,POST,PATCH,DELETE,OPTIONS`.

## 6. الحدود المجانية (قد تتغيّر — راجع المزوّدين)

| الخدمة | الحد المعلن وقت الكتابة |
|---|---|
| cron-job.org | معدل API 5 طلبات/ثانية؛ الحصص اليومية للخطة المجانية تُراجع من Console |
| Cloudflare Workers | 100 ألف طلب/يوم في الخطة المجانية؛ الجسر بلا حالة ولا يخزن بيانات |
| GitHub Pages | استضافة ملفات ثابتة فقط — لا أسرار ولا دوال خادم |

## 7. النشر والاختبار

```sh
cd workers/celia-cron-bridge
cp wrangler.toml.example wrangler.toml   # اضبط الاسم وALLOWED_ORIGIN
wrangler secret put CRONJOB_API_KEY
wrangler secret put CELIA_ADMIN_TOKEN
wrangler deploy
```

التفاصيل في [`workers/celia-cron-bridge/README.md`](../workers/celia-cron-bridge/README.md).
الاختبارات بلا شبكة (المزوّد محاكى): `node --test test/cron-bridge.test.js test/cron-lib.test.js`.
اختبارات المتصفح للوحة: `npm run test:browser` (`e2e/cron-dashboard.spec.js`، تحتاج Chromium).

## 8. حدود معلنة

- الجسر لا ينفذ بوابة الموافقات بنفسه؛ هو العقدة 3 فقط. تفويض العمليات الحسّاسة في المسار الكامل يبقى في نواة CeliaOS.
- لا إعادة محاولة تلقائية على 429/502/انقطاع — القرار بشري أو عبر المصالحة الموثقة في DEC-016.
- لا سجل يحتوي رموزًا أو أجسامًا؛ سجلات Worker تحوي المسار والرمز فقط.
- العقد مبني على وثائق cron-job.org الرسمية (REST API، نقطة النهاية `https://api.cron-job.org`)؛ أي تغيير من المزوّد يلزم تحديث هذا الملف والاختبارات معًا.
