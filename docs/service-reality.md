# واقع الخدمات — ما هو حقيقي ومختبر، وما هو اسم فقط

**آخر تدقيق حقيقي بالأسرار + دوام الحافة:** 28 أكتوبر 2026 · workflow `Service reality audit` · run
[`40680228320`](https://github.com/celiaelazamey-arch/phone-google/actions/runs/40680228320) (`b708056`) — النتيجة: **`verdict: pass`**،
حي **12 متحققة / 0 فاشلة = 100% (`workingRate: 1`, `failed: []`)**، تغطية فوق الأرضية 89/71/82، MySQL **11/11**؛
وتشغيلة الحافة [`40706047781`](https://github.com/celiaelazamey-arch/phone-google/actions/runs/40706047781) على `main@44532f4`
أثبتت دوام قاعدة Cloudflare D1 الحقيقية (`storage.mode = "d1"`, `storage.durable = true`, `4` عبارات ترحيل SQL) ·
الخطة التنفيذية المكملة: [executive-completion-plan.md](executive-completion-plan.md) · الأداة:
`scripts/service-reality.mjs` (`npm run reality`). التدقيقات السابقة للرجوع التاريخي: `40673018077` و`40660546276` و`40646881277`.

القاعدة: **لا تُحسب خدمة «تعمل» إلا إذا أجابت فعلًا من داخل GitHub Actions بالأسرار الحقيقية**. وجود السر ≠ عمل
الخدمة. كل سطر أدناه له دليل في الـrun المذكور (التعليقات التوضيحية `Service Reality · <id>` على الـjob)، والتقرير
الكامل يُرفع كـartifact `service-reality-<sha>` ويُكتب في Step Summary. القيم السرية لا تُطبع أبدًا؛ النص يمر على
`sanitize()` ويختبر `test/service-reality.test.js` عدم التسرب.

## النتيجة الصافية

| الطبقة | النتيجة | الدليل |
|---|---|---|
| الاختبارات بلا شبكة | ناجحة 100% · تغطية تتجاوز الأرضية المفروضة (89/71/82) مع تحصين `SEC-001/002/003/005` | annotation `Service Reality · offline` |
| MySQL 8.4 حقيقي (خدمة في الـrunner) | **11/11** ناجحة (`test:mysql`) | annotation `Service Reality · mysql` |
| المسابر الحية (20 خدمة) | **12 متحققة · 0 فاشلة · 4 متقاعدة صراحةً · 1 غير مهيأة · 2 لا يمكن التحقق منها · 1 غير منشورة** | annotations per service (`40680228320`) |
| نسبة العمل بين الخدمات المهيأة | **100%** (12 من 12، `workingRate: 1`) — **فوق عتبة 95% (`verdict: pass`)** | run `40680228320` + دوام الحافة D1 في `40706047781` |

**الحكم بصراحة (بعد run `40680228320` ودمج `#69` على `main@44532f4`):** الشيفرة والاختبارات والبنية المنشورة (Pages بـ12 مسارًا،
Worker الحافة المحصن، قاعدة Cloudflare D1 بدوام فعلي `durable: true`، GHCR، Release) حقيقية ومتحققة بالكامل. أربع خدمات كانت
اعتماداتها ميتة أو تتطلب بطاقة **تقاعدت صراحةً في Git** (`serviceRetirements`)، وكلا **Figma** و**ElevenLabs** (`CELIA_VOICE_ID`)
جُدِّدا وتحققا حيًا بتوليف صوتي فعلي (`12/12 = 100%`).

## جدول الحقيقة (run `40660546276`؛ التشخيص الأصلي من `40646881277`)

| # | الخدمة | السر | الحكم | ما حدث فعلًا | من يصلحه |
|---|---|---|---|---|---|
| 1 | Gemini (الرد الذكي الفعلي للعملاء) | `GEMINI_API_KEY` | ✅ متحققة | `generateCeliaReply` أعاد ردًا من النموذج (المحتوى لا يُسجَّل) | — |
| 2 | cron-job.org (الإبقاء مستيقظًا) | `CELIAOS_CRONJOB_ORG_API_KEY` | ✅ متحققة | المفتاح يسرد المهام | — |
| 3 | Cloudflare API (نشر الـWorker) | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | ✅ متحققة | التوكن **توكن حساب** (`/accounts/{id}/tokens/verify` نشط) وسكربت `celia-phone-google` مرئي | — |
| 4 | Google OAuth client (Web) | `GOOGLE_CLIENT_ID/SECRET` | ✅ متحققة | `oauth2.googleapis.com/token` ردّ `invalid_grant` على refresh token وهمي = العميل والسر صحيحان | — |
| 5 | رمز المالك على الحافة | `CELIA_MCP_API_TOKEN` | ✅ متحققة | `/api/secrets/status` على الـWorker الحي: 401 بلا رمز، 200 بالرمز | — |
| 6 | رقم الهاتف | `PHONE_NUMBER` | ✅ متحققة | صيغة E.164 صحيحة (قيمة لا تُطبع) | — |
| 7 | Worker الحافة + قاعدة D1 (عام) | — | ✅ متحققة | `/readyz` 200 مع إصدار `0.2.1` و`storage.mode=d1, durable=true` على `celia-edge-state` (`40706047781`) | — |
| 8 | GitHub Pages (الواجهة الثابتة) | — | ✅ متحققة | `version.json` + 12/12 مسارًا حيًا في `pages.yml` (`40706047514`) | — |
| 9 | صورة GHCR | — | ✅ متحققة | manifest `v0.2.1` بسحب مجهول | — |
| 10 | إصدار GitHub `v0.2.1` | `GITHUB_TOKEN` | ✅ متحققة | الأصول موجودة | — |
| 11 | Vercel AI Gateway | `AI_GATEWAY_API_KEY` | ⏸️ متقاعدة في Git | المفتاح صالح (`/models` يسرد 498 نموذجًا) لكن الطلب **403**: «AI Gateway requires a valid credit card on file» — **يتعارض مع قيد «لا بطاقة»** | المالك: بطاقة أو **تقاعد** (`CELIA_DISABLE_AI_GATEWAY=true`) |
| 12 | DeepSeek | `DEEPSEEK_API_KEY` | ⏸️ متقاعدة في Git | المفتاح صالح لكن **402 Insufficient Balance**؛ كما أن `/models` يسرد `deepseek-flash` و`deepseek-v4-pro` فقط — الافتراضي القديم `deepseek-chat` لم يعد مدرجًا (**أُصلح الافتراضي إلى `deepseek-flash`**) | المالك: شحن رصيد أو تقاعد |
| 13 | AgentRouter | `AGENETROUTERAPI_KEY` | ⏸️ متقاعدة في Git | المفتاح يُقبل لكن `/models` يعيد **0 نماذج** و`chat/completions` يعيد 200 بجسم فارغ — حساب بلا حصة/نماذج | المالك: مراجعة حساب agentrouter أو تقاعد |
| 14 | ElevenLabs (صوت سيليا) | `ELEVENLABS_API_KEY` + `CELIA_VOICE_ID` | ✅ متحققة (بعد تصحيح المعرّف) | في run `40680228320`: المفتاح و`CELIA_VOICE_ID` المحدث ولّدا مقطع `audio/*` فعليًا وحققا `12/12 = 100%` | — |
| 15 | Figma | `FIGMA_ACCESS_TOKEN` | ✅ متحققة (بعد التجديد) | كان 401؛ التوكن الجديد يجيب على `/v1/me` | — |
| 16 | Cloudflare R2 (تخزين) | `CLOUDFLARE_R2_*` ×3 | ⏸️ متقاعدة في Git | `ListBuckets` موقّع SigV4 لم يصل: **TLS handshake مرفوض** على `<account>.r2.cloudflarestorage.com` — النمط المعتاد عندما لا يكون R2 مفعّلًا على الحساب (لم يُنشأ bucket قط) أو عندما لا يملك هذا الحساب هذه المفاتيح | المالك: تفعيل R2 وإنشاء bucket (قد يتطلب وسيلة دفع لدى Cloudflare) أو تقاعد |
| 17 | Codata | `YOUR_CODATA_API_KEY` | 🟡 لا يمكن التحقق | لا `CODATA_BASE_URL` معروفًا؛ `getCodataStatus` حضور فقط | المالك: الرابط الرسمي أو تقاعد |
| 18 | Google Workspace (Gmail/Calendar) | يحتاج ربط حساب | 🟡 لا يمكن التحقق | العميل صحيح (#4) لكن لا حساب مربوط ولا خادم كامل | بعد HOST-003 → «اربط جوجل» |
| 19 | WhatsApp Cloud API | لا توكن Meta في الأسرار | ⚪ غير مهيأة | الاستقبال/الأوامر مختبرة بلا شبكة فقط؛ الإرسال لا يعمل بلا تطبيق Meta | المالك: تطبيق Meta |
| 20 | الخادم الكامل (Render + MySQL) | `CELIA_LIVE_URL` + `RENDER_*` غائبة | 🚫 غير منشور | `planDeployment` يسمّي المدخلات الناقصة | المالك: HOST-003 |

## ما أُصلح في الشيفرة بناءً على هذا الدليل

- `workers/celia-edge/worker.js` `/readyz`: كان يعلن `storage.durable: true` لمجرد وجود أسرار R2 — واجهة زائفة؛
  ثم صار `durable: false` صادقًا مع `r2CredentialsPresent`، والآن (DEC-035) صار الدوام **حقيقيًا** عبر D1:
  كل نداء يكتب رمزًا جديدًا ويقرأه، و`durable: true` لا تُعلن إلا بعد تطابق فعلي؛ وبدون ربط D1 يبقى `false`
  بسبب صريح. سجل `edge_audit` سلسلة تجزئة تكشف أي تعديل.
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

## أرقام مقاسة (WP-1.4 — DEC-050)

القاعدة هنا أصرم من بقية الملف: **كل رقم في هذا القسم له تاريخ ومعرّف تشغيلة وcommit**، وما لم يُقَس بعدُ يُكتب «لم يُقَس»
لا تقديرًا. يحرس الجدول اختبار `service-reality.test.js` («أرقام مقاسة»): أي صف يحمل `ms` أو نسبة بلا تشغيلة يُسقط الاختبار.

### زمن Cloudflare D1 (كتابة رمز + قراءته داخل العامل، `storage.latencyMs` من `/readyz`)

| التاريخ | التشغيلة | commit | ما قيس | القيمة |
|---|---|---|---|---|
| 2026-10-29 | [`40823425686`](https://github.com/celiaelazamey-arch/phone-google/actions/runs/40823425686) | `8f850ce` | قياس واحد في `verify:live` (فحص `ready_durable`) | 130 ms |
| 2026-10-29 | [`40830998982`](https://github.com/celiaelazamey-arch/phone-google/actions/runs/40830998982) | `0357442` | قياس واحد في خطوة الرفع (`liveReady`) | 189 ms |
| 2026-10-29 | [`40835848879`](https://github.com/celiaelazamey-arch/phone-google/actions/runs/40835848879) | `50cda13` | قياس واحد في خطوة الرفع (`liveReady`؛ أول رفع يحمل WP-1.4: 6 وحدات، 16 عبارة) | 162 ms |
| 2026-10-29 | [`40839027744`](https://github.com/celiaelazamey-arch/phone-google/actions/runs/40839027744) | `738d832` | قياس واحد في خطوة الرفع (`liveReady`؛ رفع WP-2.1 — لا تغيير في `workers/`) | 108 ms |
| — | — | — | سلسلة 5 قياسات متتالية (`d1_latency_series`: أدنى/وسيط/أقصى/`spreadRatio`) | **لم تُقَس هنا بعد (قيست في التشغيلة ولم تُقرأ)** — الفحص **مرّ** في تشغيلة `40835848879` على `50cda13` (العيّنات الخمس دائمة وبرقم)، لكن القيم في الأثر `edge-live-acceptance-50cda13…`/ملخص الخطوة وليست في التعليقات التوضيحية؛ تُنسخ هنا عند قراءتها (المالك من المتصفح، أو `::notice` في تغيير لاحق) |

- الادعاء الذي يُختبر: «تباين 130→1400 ms». ما هو موثّق فعلًا حتى اليوم رقمان مفردان (130 و189 ms)؛ الـ1400 ms **لا تشغيلة لها**
  في هذا المستودع، فلا تُثبت ولا تُنفى قبل أن تظهر السلسلة. بعد الدمج يُنسخ صف السلسلة من `detail` الفحص (`latencyMs[]`,
  `medianMs`, `maxMs`, `spreadRatio`) كما هو، بمعرّف التشغيلة.
- لا عتبة تُفرض على السلسلة بعد (DEC-045: القياس أولًا)؛ الفحص يفشل فقط إذا غاب الرقم أو غاب الدوام في أي عيّنة.

### الردود المقصوصة في WhatsApp (`whatsapp_reply_metrics`, `GET /api/whatsapp/reply-metrics`)

| التاريخ | التشغيلة | commit | ما قيس | القيمة |
|---|---|---|---|---|
| — | — | — | `replies` / `truncated` / `truncatedRatio` / `byReason` خلال 30 يومًا (فحص `edge_reply_metrics`) | **لم تُقَس هنا بعد (الجدول حي والنسبة لم تُقرأ)** — الترحيل `0004_reply_metrics` طُبّق في تشغيلة `40835848879` (`migrations.statements: 16`) والفحص **مرّ** (المسار يجيب `ok: true` بأعداد صحيحة)؛ القيم في الأثر نفسه؛ `truncatedRatio: null` يعني «لا ردود بعد» لا صفرًا |

- ما يُعدّ قصًّا (ولا شيء غيره): `finishReason = MAX_TOKENS` من Gemini (`max_tokens`)، أو تجاوز المرشَّح 1000 حرف قبل الإرسال
  (`char_cap`)، أو كلاهما. الحد الحالي `maxOutputTokens = 220` على الحافة و`180` في محرك Express، ولا يُغيَّر أيّهما قبل قراءة النسبة.
- ما يُخزَّن مع الرسالة: معرّف رسالة Meta، المصدر (`webhook`/`api`)، المزوّد والنموذج، سبب التوقف، عدد أحرف المرشَّح والمرسَل،
  علم القصّ وسببه، وحدّ الرموز وقت الرد. **لا نص ولا رقم هاتف** في الجدول.
