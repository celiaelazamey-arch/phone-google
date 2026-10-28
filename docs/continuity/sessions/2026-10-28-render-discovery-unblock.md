# جلسة 2026-10-28 — لماذا لم يُنشر Render، والإصلاح الذي يُنهي اعتماد المالك على رقم خدمة

**الفرع:** `arena/2edb2881-phone-google` · **الطلب:** «هذه أسرار المستودع الآن — أكمل النشر».

## 1. ما قالته بيانات المستودع فعلًا (لا ما افترضته)

| الدليل | القيمة |
|---|---|
| آخر 5 تشغيلات لـ`deploy-render.yml` | كلها `success` في 14–21 ثانية على `main` |
| خطوات التشغيل `40684252799` | «Trigger Render deploy…» = success، «Upload live acceptance report» = **skipped** |
| `scripts/deploy-render.mjs` (قبل الإصلاح) | يقرأ `vars.CELIA_LIVE_URL` فقط، ويطلب `RENDER_API_KEY` **+** `RENDER_SERVICE_ID` |
| صفحة أسرار المالك | فيها `CELIA_LIVE_URL` (سرّ، الآن) و`RENDER_API_KEY`، **ولا وجود لـ`RENDER_SERVICE_ID`** ولا `RENDER_DEPLOY_HOOK_URL` |
| `GET https://celia-phone-google.onrender.com/readyz` | صفحة Render «Not Found» — لا خدمة على هذا الاسم بعد |
| `gh api .../actions/secrets` من الجلسة | `403 Resource not accessible by integration` |
| `gh workflow run deploy-render.yml` | `403` — التطبيق بلا `actions: write`، ولو أن المستخدم `admin` |

**الخلاصة:** النشر لم يفشل، بل خرج «أخضر» لأنه لم يبدأ: الرابط موجود في تبويب غير الذي يقرأه الـworkflow،
ورقم الخدمة الذي يطلبه غير موجود عند المالك. تشغيل «success» 21 ثانية = `not-configured`، وهذا سلوك مقصود في
التصميم (لا ادعاء نشر بلا دليل) لكنه كان يخفي أن المالك أدّى دوره فعلًا.

## 2. الإصلاح (DEC-033)

1. **الرابط من أي تبويب:** يُقبل `CELIA_LIVE_URL` من تبويب المتغيّرات أو من تبويب الأسرار — والأولوية للمتغيّر
   كي يستطيع المالك تجاوز قيمة قديمة في السرّ دون حذفها.
2. **اكتشاف الخدمة:** عند وجود `RENDER_API_KEY` وحده يقرأ السكربت `GET /v1/services?limit=100` ويأخذ `id`
   و`serviceDetails.url` للخدمة المسمّاة `celia-phone-google` (اسم `render.yaml`)، أو الخدمة الوحيدة.
   مع تعدّد الخدمات بلا تطابق: **يرفض التخمين** ويطبع الأسماء المرئية للمفتاح. لم تُضف أي سرّ جديد.
3. **`--plan` يبقى بلا شبكة** ويعلن `needsDiscovery: true` بدل الادعاء؛ والتشغيل الحقيقي وحده يكتشف.
4. **`service-reality` لا ينهار** على `liveUrl: null`: يقول «لم تُحلَّ الخدمة بعد» بدل `${null}/readyz`.

## 3. البرهان على أن الإصلاح يعمل (بلا أسرار)

- `test/deploy-render.test.js`: **14/14** — منها: قبول الرابط من التبويبين وأولوية المتغيّر، خطة كاملة بمفتاح
  وحده (`ok:true`, `needsDiscovery:true`, `missing:[]`)، `pickService` يرفض التعدّد، اكتشاف `id`+`url` بنداء
  واحد مع ترويسة `Bearer`، ورسالة الفشل `render_service_not_found:celia-phone-google(visible: …)`.
- `node scripts/deploy-render.mjs --plan` بمفتاح فقط: `status: planned` و`missing: []` وسرّ المفتاح لا يُطبع.

## 4. ما بقي — نقرة واحدة، ولا شيء آخر

التشغيل يحتاج حدث `workflow_run` ناجحًا على `main` (أي **دمج**) أو تشغيلًا يدويًا من الواجهة. كلاهما خارج
صلاحية الجلسة (`403` على `workflow_dispatch`) وخارج تفويضي (لا دمج بلا طلب). عليه:

1. **Merge PR #62** → بعد نجاح «Celia quality & resilience» على `main` يبدأ `deploy-render.yml` تلقائيًا.
   أو **Actions → «Render full backend (free) — deploy & verify» → Run workflow → plan_only=false**.
2. إن لم تكن خدمة Render موجودة بعد: Dashboard → New → Blueprint → هذا المستودع (يقرأ `render.yaml`)، والأدخلات
   الستة لـAiven في اللوحة فقط. بعدها التشغيل التالي يكتشف الخدمة بنفسه.
3. إن كانت موجودة باسم آخر: التشغيل سيفشل برسالة تسمّي الأسماء المرئية للمفتاح — أرسلها لي وأضبط الاسم أو
   `RENDER_SERVICE_ID` في دقيقة.

## 5. لماذا لا أُنشئ الخدمة بنفسي

`POST /v1/services` متاح تقنيًا بالمفتاح، لكنه يتطلب `ownerId` ونوع الخدمة وإعدادات Docker و`repo`، ثم تبقى
`MYSQL_*` الستة التي لا يملكها إلا المالك من Aiven. أي إنشاء آلي سينتج خدمة تفشل في الإقلاع ثم تُحسب فشلًا
حقيقيًا — أسوأ من انتظار نقرة. الحد الفاصل مُعلن في `docs/service-reality.md`: لا خدمة تُنشأ نيابة عن المالك.

## 6. البوابات

```
node --test test/deploy-render.test.js   → 14/14
node --test test/service-reality.test.js → 12/12
npm run check:continuity                 → 44 وثيقة، 139 رابطًا، 64 مهمة
```
