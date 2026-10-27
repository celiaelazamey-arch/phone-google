# celia-cron-bridge — جسر جدولة CeliaOS نحو cron-job.org

**الحالة:** كود مرجعي واختبارات Node، **لم يُنشر بعد**. النشر قرار ومالك للحساب، لا يتم من المستودع.

الجسر هو العقدة 3 في معمارية «CeliaOS × cron-job.org»: واجهة ثابتة على GitHub Pages
بلا أسرار → جسر Worker يحمل السرّين → cron-job.org عبر REST API الرسمي.

```
المتصفح (Pages)                    Cloudflare Worker                    cron-job.org
لوحة /cron        ── Bearer CELIA_ADMIN_TOKEN ──▶  celia-cron-bridge  ── Bearer CRONJOB_API_KEY ──▶ api.cron-job.org
```

## الأسرار (لا تُكتب في الكود ولا في Pages)

| السر | أين يُحفظ | الدور |
|---|---|---|
| `CRONJOB_API_KEY` | Worker secret | مفتاح حساب cron-job.org (Console → Settings) |
| `CELIA_ADMIN_TOKEN` | Worker secret | رمز دخول لوحة CeliaOS؛ 32 حرفًا عشوائيًا على الأقل |
| `ALLOWED_ORIGIN` | Worker var (ليس سرًا) | أصل Pages المسموح له بالمناداة من المتصفح |

```sh
npm i -g wrangler            # أو استخدم npx wrangler
wrangler login
cp wrangler.toml.example wrangler.toml   # عدّل الاسم/الأصل
wrangler secret put CRONJOB_API_KEY
wrangler secret put CELIA_ADMIN_TOKEN
wrangler deploy
```

التطوير المحلي: `cp .dev.vars.example .dev.vars` ثم `wrangler dev` (الملف `.dev.vars`
مُستثنى من Git).

## العقد السطحي

كل المسارات تحت `/api/cron` وتتطلب `Authorization: Bearer <CELIA_ADMIN_TOKEN>`
(عدا `OPTIONS` للفحص المسبق CORS). الترجمة إلى cron-job.org:

| أداة اللوحة | طلب المتصفح للجسر | طلب الجسر للمزوّد |
|---|---|---|
| `cron.list` | `GET /api/cron/jobs` | `GET /jobs` |
| `cron.create` | `POST /api/cron/jobs` | `PUT /jobs` |
| `cron.update` | `PATCH /api/cron/jobs/:id` | `PATCH /jobs/:id` |
| `cron.enable` / `cron.disable` | `PATCH /api/cron/jobs/:id` بجسم `{job:{enabled}}` | `PATCH /jobs/:id` |
| `cron.history` | `GET /api/cron/jobs/:id/history` | `GET /jobs/:id/history` |
| `cron.delete` | `DELETE /api/cron/jobs/:id` | `DELETE /jobs/:id` |

وفحوص إضافية: `GET /api/cron/health` (يتطلب الرمز ويثبت صحته) و`GET /` (هوية الخدمة بلا أسرار).

## حدود أمنية منفذة في الكود

- **قائمة سماح للحقول:** `url/title/enabled/saveResponses/requestMethod/schedule` فقط؛ أي حقل غير معروف يُرفض 422 بدل تمريره.
- **تحقق المدخلات:** `url` بـ HTTP(S)، جداول مصفوفات في المدى الصحيح، جسم ≤ 8 كيلوبايت، معرّفات أرقام.
- **تعقيم الأخطاء:** أخطاء المزوّد تُعاد برمز الحالة ورسالة عربية عامة؛ لا تروي ترويسات المزوّد ولا أي مفتاح.
- **CORS صريح:** يُعكس الأصل المطابق لـ`ALLOWED_ORIGIN` فقط؛ بلا إعداد = نفس المنشأ فقط.
- **بلا سجل حساس:** السجلات تحوي المسار والرمز فقط، لا الرموز ولا الأجسام.
- **حد المزوّد:** cron-job.org يسمح بـ 5 طلبات/ثانية؛ اللوحة لا تعيد الإرسال تلقائيًا على 429.

العقد الكامل وأمثلة الأجسام في [`../../docs/cron-bridge-contract.md`](../../docs/cron-bridge-contract.md).
الاختبارات: `node --test test/cron-bridge.test.js` من جذر المستودع (تستبدل الشبكة بمحاكٍ).
