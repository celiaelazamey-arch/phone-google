# خطة المحافظة على ما وصلنا إليه — `main@715060a` (28 أكتوبر 2026)

**المبدأ:** الشيء المحفوظ هو ما له دليل قابل لإعادة التشغيل، لا ما كُتب أنه يعمل. لذلك تتكوّن الخطة من (أ) جرد بما
وصلنا إليه مع دليله، (ب) ما يمكن أن يضيع وكيف، (ج) ضوابط تعمل وحدها وتُبلّغ المالك، (د) ما لا يملكه غير المالك،
(هـ) كيف نعيد البناء من الصفر، (و) إيقاع صيانة ومؤشرات «ما زلنا محافظين». القرار: DEC-031 · المهمة: OPS-005.

## أ) الجرد — ما نحافظ عليه ودليله

| المكوّن | الحالة | الدليل |
|---|---|---|
| الشيفرة والاختبارات | 324/324 بلا شبكة، تغطية أسطر 85.8% / فروع 72% / دوال 84% | `Celia quality & resilience` run `40650636307` على `715060a`؛ تدقيق `40649403028` |
| MySQL حقيقي | 11/11 (`test:mysql` على MySQL 8.4 داخل الـrunner) | الـrun نفسه |
| الواجهة الثابتة | <https://celiaelazamey-arch.github.io/phone-google/> | `Deploy (GitHub Pages)` run `40650636259` ✅ |
| بوابة الحافة (Worker) | <https://celia-phone-google.celiaelazamey.workers.dev> — `liveReady: true`، 18/18 bindings + مفاتيح التقاعد | `Deploy (Cloudflare Edge)` run `40650636104` ✅ (commit `715060a`) |
| الإصدار الموقّع | `v0.2.1`، 5 أصول، OIDC | `Publish verified release` run `40650636330` ✅ |
| صورة الحاوية | `ghcr.io/celiaelazamey-arch/phone-google:v0.2.1` (عامة) | مسبار `ghcr_image` متحقق في التدقيق |
| الخدمات الحقيقية | **10 متحققة** (Gemini، cron-job.org، Cloudflare API، Google OAuth client، رمز المالك، رقم الهاتف، Worker، Pages، GHCR، الإصدار) · **4 متقاعدة في Git** (AI Gateway، R2، DeepSeek، AgentRouter) · **2 بانتظار سرّ مالك** (ElevenLabs `CELIA_VOICE_ID`، Figma) | [service-reality.md](service-reality.md) |
| الذاكرة بين الجلسات | STATE/BACKLOG/DECISIONS (DEC-001…DEC-031)/سجلات الجلسات/CHANGELOG، `check:continuity` في CI | `docs/continuity/` |
| شبكة المعرفة والتعلم المحكوم | سجلات CSV موثقة + مانيفست + سجلات مصادر التعلم | `data/kb/`, `data/learning/` واختباراتها |
| ما **ليس** محفوظًا لأنه غير موجود بعد | الخادم الكامل (Render + Aiven MySQL)، WhatsApp Meta، ربط حساب Google | HOST-003 — لا بيانات إنتاج تُنسخ احتياطيًا لأنها لا توجد |

## ب) ما يمكن أن يضيع وكيف

| الخطر | كيف يحدث | أين يظهر أولًا |
|---|---|---|
| موت مفتاح/حصة مزوّد | انتهاء توكن (Figma، Cloudflare)، نفاد رصيد (DeepSeek)، تغيير أسماء النماذج (`deepseek-chat` اختفى فعلًا)، تقييد صلاحيات (ElevenLabs) | التدقيق الأسبوعي → issue `service-reality` |
| انحراف النشر | دفع إلى `main` يفشل في Worker/Pages/Release دون أن يلاحظ أحد؛ أو تدوير سرّ دون إعادة نشر الـWorker (الـbindings تُحقن عند النشر فقط) | مسابر `worker_edge_public`/`pages_static`/`github_release` + `/version` مقابل commit |
| تراجع الجودة | دمج يخفض التغطية أو يكسر اختبارًا؛ تحديث تبعية مكسور | أرضية التغطية في CI (`test:coverage`)، `npm audit` في CI |
| انحراف التوثيق | جلسة تنتهي بلا STATE/سجل؛ معرّف مهمة بلا صف | `check:continuity` في CI و«Require handoff» على الـPR |
| خطأ بشري على `main` | force-push، حذف الفرع، دمج PR قديم (#38/#39) أو الـrevert #34 الذي يزيل الـoutbox | حماية الفرع (مالك فقط) + هذا المستند |
| فقدان ذاكرة الوكيل/الصندوق | إعادة استنساخ ضحلة، سقوط `node_modules`، فرع جديد لكل جلسة | بروتوكول الاستمرارية: `git fetch --unshallow`، `npm ci`، القراءة من STATE |
| حدود الطبقات المجانية | Workers 100k طلب/يوم، Pages ~100GB/شهر، نوم Render Free، حصص Gemini المجانية (وتُستخدم بياناتها للتحسين) | مسابر الحافة + `docs/go-live-plan.md` §0 |
| تسرب سرّ | طباعة قيمة في سجل أو issue | منقّي التدقيق (خروج 3)، اختبارات عدم التسرب، `check:secrets`، «Refuse tracked credentials» |

## ج) الضوابط الآلية (تعمل وحدها)

| الضابط | متى | ماذا يحمي | أين تقرأ النتيجة |
|---|---|---|---|
| **التدقيق الأسبوعي** `Service reality audit` | كل اثنين 06:00 UTC (08:00 القاهرة) + يدوي + `[reality]` | عمل الخدمات العشر، الحافة، Pages، الإصدار، GHCR، التغطية، MySQL | annotations الـrun؛ Step Summary؛ artifact 90 يومًا |
| **issue تتبّع واحدة** (label `service-reality`) | عند فشل run مجدول/يدوي على `main`؛ تُغلق وحدها عند النجاح | إيصال الإنذار إلى المالك (إشعارات الجدولة لا تصل لأحد وإلا) | Issues |
| **أرضية التغطية** `npm run test:coverage` (أسطر 80 / فروع 65 / دوال 78) | كل push/PR في `Celia quality & resilience` | ألّا تتآكل الاختبارات تدريجيًا | فشل CI برسالة `does not meet threshold` |
| البوابات القائمة | كل push/PR | `check` (صياغة 114 ملفًا)، `release:check`، `check:continuity`، `npm audit --audit-level=moderate`، `celia:mcp:verify` (عقد N/N−1)، `check:secrets` 18/18، `build:pages`، متصفح RTL/WCAG، MySQL 8.4 استمرارية/استرجاع نسخة | CI |
| نشر من `main` فقط | كل دمج | Pages وWorker والإصدار وGHCR تُعاد من الشيفرة نفسها؛ Render بعد حسابي المالك (DEC-028) | runs الأربعة |
| مانيفست التقاعد | كل اختبار | `serviceRetirements` = bindings الـWorker = `render.yaml` (اختبار يمنع الانحراف) | `test/service-reality.test.js` |
| حارس الـrevert | كل اختبار | لا يمكن إزالة الـoutbox أو إضعاف اختبارات الأسرار دون كسر CI | `test/secrets-hub.test.js:323`، `test/agent-outbox.test.js` |

## د) ما لا يملكه غير المالك (مرتّب بالأثر)

1. **حماية `main`** (Settings → Branches → Add rule → `main`): Require a pull request · Require status checks to pass
   (اختر: `Node 24 · tests & failure recovery`، `Node 22 · tests & failure recovery`، `MySQL 8.4 · persistence / N−1 / backup
   restore`، `RTL dashboard · desktop / mobile / accessibility`، `Node 24 container smoke test`، `Python 3.11 · Celia Google
   Spider tests`) · Block force pushes · Do not allow deletions. (التكامل الحالي يتلقى 403 على هذه الإعدادات.)
2. **الإشعارات:** Watch → Custom → Actions، أو الاكتفاء بـissue `service-reality` (تنشئها الأتمتة وتذكرك أسبوعيًا).
3. **السرّان المتبقيان للوصول إلى 100%:** `CELIA_VOICE_ID` = صوت مرئي للمفتاح (المفتاح يولّد صوتًا فعلًا)؛ توكن Figma جديد
   أو سطر `figma` في `serviceRetirements`. بعد أي تغيير سرّ يُستخدم في الحافة: شغّل `Deploy (Cloudflare Edge)` أو ادفع إلى `main`.
4. **PRs القديمة:** #34 revert **لا يُدمج** (يزيل الـoutbox)؛ #38 و#39 إمّا إغلاق أو إعادة تأسيس على `main` الحالي ثم CI أخضر.
5. **Dependabot security updates** (Settings → Code security): تشغيلها قرار مالك؛ CI سيقيّم كل PR منها بالبوابات نفسها.
6. **تدوير الأسرار:** جدول البند هـ. لا تدوير صامت: كل تدوير يتبعه run `[reality]`.

## هـ) الأسرار الثمانية عشر — كيف يموت كل سرّ وكيف نكتشفه

| السر | كيف يموت | الكشف | بعد التجديد |
|---|---|---|---|
| `GEMINI_API_KEY` | إلغاء المفتاح، نفاد الحصة المجانية | مسبار `gemini` (رد حقيقي) | `[reality]` |
| `CELIAOS_CRONJOB_ORG_API_KEY` | إلغاء من لوحة cron-job.org | مسبار `cronjob` | `[reality]`؛ Render keep-alive يعتمد عليه |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | انتهاء صلاحية التوكن (إن ضُبطت)، تغيير الصلاحيات | مسبار `cloudflare_api` + فشل `Deploy (Cloudflare Edge)` | إعادة نشر الـWorker |
| `CELIA_MCP_API_TOKEN` | تدوير دون إعادة نشر الحافة | مسبار `owner_token_edge` (401/200) | إعادة نشر الـWorker ثم `[reality]` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | حذف عميل OAuth أو تدوير السر | مسبار `google_oauth_client` (`invalid_grant` = صحيح، `invalid_client` = ميت) | تحديث Render لاحقًا |
| `PHONE_NUMBER` | تغيير الرقم | مسبار E.164 | — |
| `ELEVENLABS_API_KEY` / `CELIA_VOICE_ID` | تقييد صلاحيات، حذف الصوت | مسبار `elevenlabs` (توليف حقيقي 6 أحرف) | `[reality]` |
| `FIGMA_ACCESS_TOKEN` | انتهاء PAT | مسبار `figma` | `[reality]` |
| `AI_GATEWAY_API_KEY`، `DEEPSEEK_API_KEY`، `AGENETROUTERAPI_KEY`، `CLOUDFLARE_R2_*` ×3 | **متقاعدة** — لا تُحسب | تبقى `disabled` حتى يُحذف سطرها من المانيفست | حذف السطر + `[reality]` |
| `YOUR_CODATA_API_KEY` | لا نقطة نهاية معروفة | `unverifiable` | `CODATA_BASE_URL` أو تقاعد |

## و) إعادة البناء من الصفر (لو ضاع كل شيء إلا Git والأسرار)

1. `git clone` → `npm ci` → `npm run check && npm run test:coverage` (يجب 324/324 وفوق الأرضية).
2. Pages: دفع إلى `main` يشغّل `Deploy (GitHub Pages)`؛ تحقق `version.json`.
3. Worker: `Deploy (Cloudflare Edge)` يحتاج `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`؛ تحقق `/readyz` → `liveReady`.
4. الإصدار وGHCR: `Publish verified release` من `main` (وسم `v*`)؛ `npm run release:verify` على الأصول.
5. الخادم الكامل: `deploy/free-always-on/README.md` + DEC-028 بعد إنشاء حسابي Render/Aiven ثم `verify:live` PASS.
6. الخاتمة دائمًا: run `[reality]` وقراءة annotations — لا يُعلن شيء قبلها.

## ز) إيقاع الصيانة

- **أسبوعيًا (آلي):** التدقيق + issue إن فشل. **المالك:** دقيقة لقراءة الـissue إن وُجدت.
- **شهريًا (مالك):** مراجعة `npm audit` في آخر CI، حصص Gemini/Workers، وأي توكن له تاريخ انتهاء.
- **ربع سنويًا:** QA-002 (Node LTS التالي)، تحديث التبعيات في PR واحد يمر بالبوابات، مراجعة التقاعدات (هل عاد حساب للحياة؟).
- **كل جلسة وكيل:** بروتوكول الاستمرارية (STATE → BACKLOG → سجل جلسة → `check:continuity`) قبل الإنهاء؛ لا دمج بلا «ادمج».

## ح) مؤشرات «ما زلنا محافظين»

| المؤشر | القيمة الآن | الحد |
|---|---|---|
| خدمات متحققة في آخر تدقيق | 10 | ≥ 10 (و12 بعد السرّين) |
| نسبة العمل بين المهيأ | 83.3% | ≥ 95% بعد السرّين؛ أي هبوط = issue |
| اختبارات بلا شبكة | 324/324 | 0 فشل |
| التغطية | 85.8 / 72 / 84 | ≥ 80 / 65 / 78 (CI يفشل دونها) |
| `/readyz` للـWorker | `liveReady: true` عند `715060a` | commit الحافة = رأس `main` |
| issue `service-reality` مفتوحة | لا (لم يُجدول بعد) | صفر بعد السرّين |
| PRs قديمة مفتوحة | 3 (#34 revert، #38، #39) | قرار مالك موثق |

## ط) ما لا تحميه هذه الخطة (بصراحة)

لا توجد بيانات إنتاج بعد فلا نسخ احتياطي لها (عند تشغيل Render + Aiven يصبح DATA-001 `backup:verify` واجبًا). لا SLA على
الطبقات المجانية ولا «24/7 مضمون». التدقيق أسبوعي لا لحظي. لا يمكن لأي أتمتة إحياء حساب مزوّد ميت أو إضافة بطاقة — هذه
قرارات مالك فقط. حماية الفرع والإشعارات لا تُضبط من هذا التكامل (403) حتى يفعلها المالك.
