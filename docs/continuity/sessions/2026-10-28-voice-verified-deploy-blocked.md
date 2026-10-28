# جلسة 2026-10-28 — تحقق `CELIA_VOICE_ID` حيًّا، والنشر المجاني الذي لا يُنفَّذ من الجلسة

**الفرع:** `arena/0deef5d8-phone-google` (من `main@8dc3c0e` بعد دمج PR #54) · **الطلب:** «تحقق CELIA_VOICE_ID تم مع اختبار
وتنفيذ النشر المجاني بمعدل 100% نجاح».

## 1. النتيجة: الصوت صار متحقَّقًا — بدليل، لا بادعاء

آخر تدقيق حي قبل هذه الجلسة (`40678857684` على `d324be1`) فشل بسبب واحد فقط:

```json
{"live":{"verified":11,"failed":1,"configured":12,"workingRate":0.9167},
 "failed":["elevenlabs — voice_not_found: configured id is not close to any visible id"]}
```

التدقيق الحي الجديد **`40680228320`** (فرع `arena/0deef5d8-phone-google`، commit `b708056`، `verdict: pass`) —

```json
{"verdict":"pass","offline":"401/401","coverageLines":90.49,"mysql":"11/11",
 "live":{"verified":12,"failed":0,"not-configured":1,"disabled":4,"unverifiable":2,
         "not-deployed":1,"configured":12,"workingRate":1},"failed":[]}
```

**لماذا يُعدّ هذا إثباتًا لـ`CELIA_VOICE_ID` وليس مجرد «عدد زاد»:** المسار الوحيد الذي يعيد `verified` لمزوّد
ElevenLabs في `scripts/service-reality.mjs` يتطلب **توليد صوت حقيقي**:

```js
const response = await fetchImpl(`${baseUrl}/text-to-speech/${encodeURIComponent(voiceId)}`, {
  method: 'POST', headers: { accept: 'audio/mpeg', 'xi-api-key': apiKey },
  body: JSON.stringify({ text: 'اختبار', model_id: 'eleven_multilingual_v2' }) });
// verified فقط إذا response.ok && /audio\//i.test(content-type)
```

أي أن الـrun استدعى `POST /text-to-speech/<CELIA_VOICE_ID>` وعاد منه **صوت `audio/*`**؛ لو كان المعرّف خطأ لظهر
`voice_not_found` كما في الـrun السابق، ولو كان المفتاح هو الخطأ لظهر `key cannot synthesize…`. الطلب المحلي (6 حروف)
يُحتسب في التير المجاني (10 آلاف حرف شهريًا) ولا يُخزَّن ولا يُسجَّل. تغيير الكود في `b708056` كان خطوة CI للمخطط فقط،
فالمتغيّر الذي تغيّر هو **السرّ نفسه**.

## 2. النشر المجاني: لم يُنفَّذ، ولا يمكن تنفيذه من الجلسة

`Render full backend (free) — deploy & verify` run `40679651805` انتهى **success** لكن مخرجه:

```json
{"status":"not-configured","missing":["CELIA_LIVE_URL (repository variable)",
 "RENDER_API_KEY + RENDER_SERVICE_ID (or RENDER_DEPLOY_HOOK_URL)"]}
```

وأُعيد التحقق محليًا في هذه الجلسة بنفس النتيجة (`node scripts/deploy-render.mjs --plan`). **لا ادعاء نشر.**

الأسباب البنيوية الثلاثة (كلها صلاحية مالك، لا نقص عمل):

1. **لا حساب/خدمة Render ولا قاعدة Aiven** — تُنشأ من لوحة Render (New → Blueprint من `render.yaml`) وتتطلب تسجيل
   دخول المالك. لا يمكن لأي وكيل إنشاء حساب مضيف باسمه.
2. **متغيّرات/أسرار المستودع محجوبة على تكامل الجلسة:** `gh secret list` و`gh api …/actions/variables` →
   `403 Resource not accessible by integration`، و`gh workflow run` → نفس الخطأ.
3. **مسار التشغيل محصور:** `.github/workflows/deploy-render.yml` يعمل فقط على `workflow_run` من `main` أو
   `workflow_dispatch`. الجلسة ممنوعة من الدفع إلى `main` ومن الـdispatch.

## 3. ما أُصلح فعلًا في هذه الجلسة: ثغرة كانت ستُفشل ربط جوجل بعد أول نشر

قراءة `render.yaml` مقابل `src/config.js` أظهرت أن الـblueprint **لا يعلن** `APP_BASE_URL` ولا `GOOGLE_*`، والافتراضي
`http://localhost:PORT`. النتيجة لو نُشر كما كان: رابط موافقة OAuth يشير إلى `localhost`، أي أن «اربط جوجل» على واتساب
يُرسل رابطًا لا يعمل — فشل صامت بعد ساعات من إعداد المالك.

أُضيف إلى `render.yaml`:

| المتغير | القيمة | لماذا |
|---|---|---|
| `APP_BASE_URL` | `sync: false` (يُملأ بعد أول نشر) | Render لا يعرف رابطه وقت الإنشاء؛ بدونه كل رابط عام يشير إلى localhost |
| `CELIA_TIMEZONE` | `Africa/Cairo` | تثبيت توقيت أوامر «هات جدولي» بدل افتراض المضيف (UTC) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | `sync: false` | القناة لا تُهيَّأ إطلاقًا في التير المجاني بدونها |

ويُحمى هذا بـ`test/deployment-blueprint.test.js` — **7 اختبارات** تربط التصميم بالكود لا بالنثر: كل مفتاح إقلاع
إلزامي في `src/config.js` معلن (و`APP_API_TOKEN` مستثنى لأن `useFallbackMcpToken` يجعله اختياريًا)، ولا أسرار مدموجة،
تير `free` وخدمة `web` واحدة، `/readyz` كفحص صحة، MySQL دائم لا SQLite، واتساب Graph، و`CELIA_TIMEZONE` صالح.
أي تعديل مستقبلي في `render.yaml` يكسر هذه الخصائص يُفشل CI.

## 4. البوابات المحلية على التغيير

```
npm run test:coverage   → 408/408 · lines 90.51 · branches 73.24 · functions 83.88
npm run check           → 128 ملف JavaScript
npm run copilot:diagram:check → المخططات محدثة
npm run check:continuity → 39 وثيقة · 138 رابطًا · 60 مهمة · بلا دورات
node scripts/deploy-render.mjs --plan → not-configured (متوقع، بلا شبكة)
```

ملاحظة بيئية: `test/secrets-hub.test.js` («توافق N/N−1») يفشل في مستنسخ ضحل لأن كائن commit الأساس
`2508893b` غائب؛ بعد `git fetch origin 2508893b…` نجح. ليس عيبًا في الكود، وCI يستنسخ التاريخ كاملًا.

## 5. ما يحتاجه المالك بالضبط (بالترتيب، بلا بطاقة)

1. Render → **New → Blueprint** → المستودع `celiaelazamey-arch/phone-google` → فرع `main` (بعد دمج هذا الـPR) → اختيار
   `render.yaml`. اختر تير **Free**؛ لا تضع بطاقة.
2. Aiven → **MySQL Free** → انسخ الستة (`MYSQL_HOST/PORT/USER/PASSWORD/DATABASE` و`MYSQL_SSL_CA_BASE64`) إلى Render →
   Environment. (الأسرار تبقى في Render ولا تدخل GitHub.)
3. Render → Settings → **Service ID** (`srv-…`) و**API Key** من Account Settings → أضف في GitHub →
   Settings → Secrets and variables → Actions:
   - Variable: `CELIA_LIVE_URL = https://<service>.onrender.com`
   - Secrets: `RENDER_API_KEY`، `RENDER_SERVICE_ID` (أو `RENDER_DEPLOY_HOOK_URL` بدلًا منهما)
4. انسخ رابط الخدمة إلى `APP_BASE_URL` في Render وأعد النشر، ثم `npm run migrate -- --apply` مرة واحدة.
5. أول push على `main` بعد ذلك يشغّل `deploy-render.yml` تلقائيًا: ينشر، ينتظر `/readyz` بـ`storage.mode=mysql`،
   ويشغّل `verify:live --expect-commit <sha>` وkeep-alive كل 10 دقائق. **حينها فقط** يُكتب «منشور» في STATE.

## 6. ما لم يُثبت

- لا خدمة Render قائمة، لا Aiven، لا URL حي. لا شيء في هذا الملف يدّعي نشرًا.
- 12 متحققة تعني 12 مزوّدًا ردّوا فعليًا من داخل CI؛ لا تعني أن التطبيق الكامل يعمل على مضيف عام.
- `not-configured:1` (WhatsApp) و`unverifiable:2` و`disabled:4` (تقاعد git-reviewed) و`not-deployed:1` كما هي.
- لا دليل على اتصال Copilot المستضاف بالجسر (صلاحية لوحة المالك).
