# واقع الخدمات — ما هو حقيقي ومختبر، وما هو اسم فقط

**آخر تدقيق حقيقي (على نفس commit الفرع `2bd7f58`):** 28 أكتوبر 2026 · workflow `Service reality audit` · run
[`40673018077`](https://github.com/celiaelazamey-arch/phone-google/actions/runs/40673018077) — النتيجة: offline **383/383**،
تغطية **90.27/73.15/83.79**، MySQL **11/11**، حي **11 متحققة / 1 فاشلة = 91.7%** (نفس فشل `CELIA_VOICE_ID` وحده). ·
التدقيق السابق: run
[`40660546276`](https://github.com/celiaelazamey-arch/phone-google/actions/runs/40660546276) على الفرع
`arena/3d9557b5-phone-google` (commit `5a72033`؛ أُعيد بتشخيص أوسع في run
[`40661486530`](https://github.com/celiaelazamey-arch/phone-google/actions/runs/40661486530)، commit `34b58da`، نفس النتيجة)
بعد تحديث المالك للسرّين `CELIA_VOICE_ID` و`FIGMA_ACCESS_TOKEN` · الأداة:
`scripts/service-reality.mjs` (`npm run reality`). التشخيص التفصيلي للأعطال الأصلية جاء من run
[`40646881277`](https://github.com/celiaelazamey-arch/phone-google/actions/runs/40646881277).

القاعدة: **لا تُحسب خدمة «تعمل» إلا إذا أجابت فعلًا من داخل GitHub Actions بالأسرار الحقيقية**. وجود السر ≠ عمل
الخدمة. كل سطر أدناه له دليل في الـrun المذكور (التعليقات التوضيحية `Service Reality · <id>` على الـjob)، والتقرير
الكامل يُرفع كـartifact `service-reality-<sha>` ويُكتب في Step Summary. القيم السرية لا تُطبع أبدًا؛ النص يمر على
`sanitize()` ويختبر `test/service-reality.test.js` عدم التسرب.

## النتيجة الصافية

| الطبقة | النتيجة | الدليل |
|---|---|---|
| الاختبارات بلا شبكة | **383/383** ناجحة · تغطية أسطر **90.27%** (فوق الأرضية 89/71/82) | annotation `Service Reality · offline` |
| MySQL 8.4 حقيقي (خدمة في الـrunner) | **11/11** ناجحة (`test:mysql`) | annotation `Service Reality · mysql` |
| المسابر الحية (20 خدمة) | **11 متحققة · 1 فاشلة · 4 متقاعدة صراحةً · 1 غير مهيأة · 2 لا يمكن التحقق منها · 1 غير منشورة** | annotations per service |
| نسبة العمل بين الخدمات المهيأة | **91.7%** (11 من 12) — **أقل من عتبة 95%** (62.5% → 83.3% → 91.7%، وثبتت في runs `40663707956` و`40673018077`) | annotation `Service Reality` |

**الحكم بصراحة (بعد run `40673018077`):** الشيفرة والاختبارات والبنية المنشورة (Pages، Worker، GHCR، Release) حقيقية ومتحققة،
وقد ثبّت هذا الـrun أن السرّ الواصل من `secrets.CELIA_VOICE_ID` **لم يتغيّر** بعد محاولة التحديث (نفس المعرّف 20 حرفًا ويبعد 18
تعديلًا عن أقرب صوت مرئي) — أي أن الإصلاح المطلوب في تبويب Repository secrets نفسه، لا في الشيفرة. أربع خدمات
كانت اعتماداتها ميتة أو تتطلب بطاقة **تقاعدت صراحةً في Git**. **Figma صار متحققًا** بالتوكن الجديد. بقي عطل واحد:
**ElevenLabs** — المفتاح (الجديد) صالح بالكامل (`/user` 200) ويولّد صوتًا فعلًا (15,925 بايت بصوت مرئي)، لكن قيمة
`CELIA_VOICE_ID` الجديدة **ليست بين 22 صوتًا مرئيًا لهذا المفتاح** (`voice_not_found`). خطوة واحدة → 100%.

## جدول الحقيقة (run `40660546276`؛ التشخيص الأصلي من `40646881277`)

| # | الخدمة | السر | الحكم | ما حدث فعلًا | من يصلحه |
|---|---|---|---|---|---|
| 1 | Gemini (الرد الذكي الفعلي للعملاء) | `GEMINI_API_KEY` | ✅ متحققة | `generateCeliaReply` أعاد ردًا من النموذج (المحتوى لا يُسجَّل) | — |
| 2 | cron-job.org (الإبقاء مستيقظًا) | `CELIAOS_CRONJOB_ORG_API_KEY` | ✅ متحققة | المفتاح يسرد المهام | — |
| 3 | Cloudflare API (نشر الـWorker) | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | ✅ متحققة | التوكن **توكن حساب** (`/accounts/{id}/tokens/verify` نشط) وسكربت `celia-phone-google` مرئي | — |
| 4 | Google OAuth client (Web) | `GOOGLE_CLIENT_ID/SECRET` | ✅ متحققة | `oauth2.googleapis.com/token` ردّ `invalid_grant` على refresh token وهمي = العميل والسر صحيحان | — |
| 5 | رمز المالك على الحافة | `CELIA_MCP_API_TOKEN` | ✅ متحققة | `/api/secrets/status` على الـWorker الحي: 401 بلا رمز، 200 بالرمز | — |
| 6 | رقم الهاتف | `PHONE_NUMBER` | ✅ متحققة | صيغة E.164 صحيحة (قيمة لا تُطبع) | — |
| 7 | Worker الحافة (عام) | — | ✅ متحققة | `/readyz` 200 مع إصدار `0.2.1` | — |
| 8 | GitHub Pages (الواجهة الثابتة) | — | ✅ متحققة | `version.json` 200 | — |
| 9 | صورة GHCR | — | ✅ متحققة | manifest `v0.2.1` بسحب مجهول | — |
| 10 | إصدار GitHub `v0.2.1` | `GITHUB_TOKEN` | ✅ متحققة | الأصول موجودة | — |
| 11 | Vercel AI Gateway | `AI_GATEWAY_API_KEY` | ⏸️ متقاعدة في Git | المفتاح صالح (`/models` يسرد 498 نموذجًا) لكن الطلب **403**: «AI Gateway requires a valid credit card on file» — **يتعارض مع قيد «لا بطاقة»** | المالك: بطاقة أو **تقاعد** (`CELIA_DISABLE_AI_GATEWAY=true`) |
| 12 | DeepSeek | `DEEPSEEK_API_KEY` | ⏸️ متقاعدة في Git | المفتاح صالح لكن **402 Insufficient Balance**؛ كما أن `/models` يسرد `deepseek-flash` و`deepseek-v4-pro` فقط — الافتراضي القديم `deepseek-chat` لم يعد مدرجًا (**أُصلح الافتراضي إلى `deepseek-flash`**) | المالك: شحن رصيد أو تقاعد |
| 13 | AgentRouter | `AGENETROUTERAPI_KEY` | ⏸️ متقاعدة في Git | المفتاح يُقبل لكن `/models` يعيد **0 نماذج** و`chat/completions` يعيد 200 بجسم فارغ — حساب بلا حصة/نماذج | المالك: مراجعة حساب agentrouter أو تقاعد |
| 14 | ElevenLabs (صوت سيليا) | `ELEVENLABS_API_KEY` + `CELIA_VOICE_ID` | ❌ فاشلة (الوحيدة) | بعد التحديث: المفتاح صالح (`/user` 200) و**يولّد صوتًا فعلًا** (15,925 بايت بصوت مرئي)، لكن `/voices/{CELIA_VOICE_ID}` → 400 `voice_not_found`: القيمة الجديدة ليست بين 22 صوتًا مرئيًا لهذا المفتاح — صوت من المكتبة أو مستنسخ يجب إضافته أولًا إلى «My Voices» في الحساب الذي يخصه المفتاح | المالك: `CELIA_VOICE_ID` = `AnsOWV53Mdx5fcIanRBB` — **الصوت المخصص باسم `cela` الموجود فعلًا في الحساب** (ظهر في قائمة الـrun `40661486530`)، أو أي معرّف آخر من القائمة (مثلًا `EXAVITQu4vr4xnSDxMaL` Sarah) |
| 15 | Figma | `FIGMA_ACCESS_TOKEN` | ✅ متحققة (بعد التجديد) | كان 401؛ التوكن الجديد يجيب على `/v1/me` | — |
| 16 | Cloudflare R2 (تخزين) | `CLOUDFLARE_R2_*` ×3 | ⏸️ متقاعدة في Git | `ListBuckets` موقّع SigV4 لم يصل: **TLS handshake مرفوض** على `<account>.r2.cloudflarestorage.com` — النمط المعتاد عندما لا يكون R2 مفعّلًا على الحساب (لم يُنشأ bucket قط) أو عندما لا يملك هذا الحساب هذه المفاتيح | المالك: تفعيل R2 وإنشاء bucket (قد يتطلب وسيلة دفع لدى Cloudflare) أو تقاعد |
| 17 | Codata | `YOUR_CODATA_API_KEY` | 🟡 لا يمكن التحقق | لا `CODATA_BASE_URL` معروفًا؛ `getCodataStatus` حضور فقط | المالك: الرابط الرسمي أو تقاعد |
| 18 | Google Workspace (Gmail/Calendar) | يحتاج ربط حساب | 🟡 لا يمكن التحقق | العميل صحيح (#4) لكن لا حساب مربوط ولا خادم كامل | بعد HOST-003 → «اربط جوجل» |
| 19 | WhatsApp Cloud API | لا توكن Meta في الأسرار | ⚪ غير مهيأة | الاستقبال/الأوامر مختبرة بلا شبكة فقط؛ الإرسال لا يعمل بلا تطبيق Meta | المالك: تطبيق Meta |
| 20 | الخادم الكامل (Render + MySQL) | `CELIA_LIVE_URL` + `RENDER_*` غائبة | 🚫 غير منشور | `planDeployment` يسمّي المدخلات الناقصة | المالك: HOST-003 |

## ما أُصلح في الشيفرة بناءً على هذا الدليل

- `workers/celia-edge/worker.js` `/readyz`: كان يعلن `storage.durable: true` لمجرد وجود أسرار R2 — واجهة زائفة؛ الآن
  `durable: false` + `r2CredentialsPresent` + `durabilityVerifiedBy: 'service-reality audit'`.
- الافتراضي `deepseek-chat` → `deepseek-flash` في `src/ai-providers.js`, `src/ollama.js`, `src/celia-mcp.js`,
  `src/operations.js`, `src/secrets-hub.js`, `.env.example` (يبقى `DEEPSEEK_MODEL` قابلًا للتجاوز).
- `generateOpenAiCompatibleReply`: رفض المزوّد يحمل الآن نص سببه (`upstreamDetail`: رصيد/صلاحية/نموذج) بلا مفتاح ولا
  محتوى؛ وردّ 200 بلا `choices` يشرح ما عاد (مفاتيح الجسم، رسالة المزوّد، `finish_reason`، مخرجات تفكير فقط).
- المدقق يفرّق بين «المفتاح خطأ» و«معرّف الصوت خطأ» (ElevenLabs)، ويجرّب نقطة R2 القياسية المشتقة من
  `CLOUDFLARE_ACCOUNT_ID` عند فشل النقطة المهيأة، ويعلّم النموذج غير المدرج في `/models`، ويفحص توكن Cloudflare
  كحساب أو مستخدم.

## ما نُفِّذ بعد موافقة المالك («ابدأ كما ذكرت») — التقاعد الصريح في Git

لا أملك صلاحية كتابة متغيرات المستودع (`actions/variables` → 403 لهذا التكامل)، فجعلت التقاعد **ملفًا مراجَعًا في Git**:
`docs/deployment-profile.json → serviceRetirements` يضم الآن `ai_gateway` (بطاقة مطلوبة)، `cloudflare_r2` (غير مفعّل)،
`deepseek` (402 بلا رصيد)، `agentrouter` (0 نماذج) — كلٌّ بسببه ودليله (run `40646881277`) وطريقة التراجع عنه (حذف السطر بعد
إصلاح الحساب ثم commit `[reality]`). المصدر الواحد نفسه يغذّي: المدقق (حكم ⏸️ `disabled` خارج النسبة)، نشر الـWorker
(`plain_text` bindings `CELIA_DISABLE_*` فيعرض `/api/secrets/status` قائمة `retiredServices`)، و`render.yaml` (قيم افتراضية
`'true'`)؛ اختبار يمنع انحراف الثلاثة عن بعضها. قيمة بيئة غير فارغة تغلب الملف دائمًا (قرار المالك من اللوحة يسبق Git).

ما بقي **فاشلًا عمدًا** لأن التوصية تجديده لا تقاعده: **Figma** (توكن جديد) و**ElevenLabs** (المفتاح مقيّد؛ المدقق الآن
يُجري توليفًا صوتيًا حقيقيًا من 6 أحرف — بالصوت المهيأ عند النجاح، وبصوت مرئي عند الفشل — ليخبرك إن كان العيب في المفتاح أم في
`CELIA_VOICE_ID` فقط).

## كيف يتقاعد المالك خدمةً بصدق بدل تركها اسمًا

ضع **متغيّر مستودع** (Settings → Variables، ليس سرًا) باسم `CELIA_DISABLE_<SERVICE>` وقيمة `true`
(`AI_GATEWAY`, `DEEPSEEK`, `AGENTROUTER`, `ELEVENLABS`, `FIGMA`, `CODATA`, `CLOUDFLARE_R2`). الـworkflow يمرره،
و`loadFeatures()` يعطّل الخدمة في التشغيل نفسه، والمدقق يبلّغها **⏸️ disabled** ويستبعدها من النسبة. مثال: تقاعد
AI Gateway وR2 (كلاهما يتطلب وسيلة دفع) وتجديد Figma وElevenLabs وشحن DeepSeek أو تقاعده ومراجعة AgentRouter →
النسبة تصبح 100% من الخدمات المتبقية **بدليل run جديد**، لا بوعد.

## كيف يُعاد التدقيق

- أي commit رسالته تحتوي `[reality]` على أي فرع يشغّل الـworkflow بالأسرار الحقيقية؛ أو `workflow_dispatch` من `main`
  بعد الدمج (مدخل `min_rate`).
- محليًا بلا أسرار: `npm run reality -- --skip-live` (الاختبارات + التغطية فقط).
- قراءة النتائج بلا تنزيل: `gh api repos/celiaelazamey-arch/phone-google/check-runs/<job_id>/annotations`.
