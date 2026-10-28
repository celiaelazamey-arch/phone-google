# خطة 100% — نظام منشور بلا أخطاء وبلا بطاقة دفع

**التاريخ:** 28 أكتوبر 2026 · **الفرع:** `arena/83dde20a-phone-google` (متفرع من `main@44532f4552c20b8fb51402e14cff8fc15356b97c`) · **الإصدار:** 0.2.1 /
`schema 1` · **المرجع التشغيلي:** [go-live-plan](go-live-plan.md) · **الخطة التنفيذية لسد الفجوات:**
[executive-completion-plan](executive-completion-plan.md) · **جدول واقع الخدمات:**
[service-reality](service-reality.md) · **حالة المهام:** [BACKLOG](continuity/BACKLOG.md) هو المرجع الوحيد، وهذه الوثيقة
ترتيبٌ وبوابات لا حالات.

> **السؤال الذي تجيبه هذه الوثيقة:** «كيف نصل إلى 100% — نظام متكامل، منشور، بلا أخطاء، بلا فيزا/بطاقة دفع؟»
> **الجواب المختصر:** وصلت الشيفرة والاختبارات والأمن وخدمات الإنتاج المهيأة (`12/12 = 100%` في run `40680228320`) ودوام
> الحافة على قاعدة Cloudflare D1 (`storage.durable: true` في run `40706047781`) إلى **100% بأدلّة حية**؛ وبقيت فقط قرارات
> لوحة المالك الخارجية (حماية `main`، بديل الخادم الكامل بعد قيد بطاقة Render `DEC-034`، تطبيق Meta الاختياري، وربط Google الحي).

---

## 0. كيف تُقاس 100% (تعريف الأركان الثمانية)

لا يعني «100%» رقمًا واحدًا. يعني ثمانية أركان، كل ركن له **بوابة** و**دليل مقبول**، ولا يُعلن ركن مكتملًا بوصفٍ بلا دليل.

| # | الركن | بوابة 100% | الدليل المقبول | من يملكه |
|---|---|---|---|---|
| 1 | **الشيفرة** | `check` + `release:check` + `check:continuity` + `npm audit` خضراء | annotations الـworkflow نفسها | الوكيل ✅ |
| 2 | **الاختبارات والتغطية** | اختبارات كلها خضراء على Node 22 و24، وتغطية أسطر ≥89 (المقاس الآن 90.29) | ملخص `test:coverage` + annotation | الوكيل ✅ |
| 3 | **الأنبوب (CI/CD)** | كل workflows التي تُشغَّل على `main` تنتهي `success` أو `skipped` بمسوّغ مُعلن — لا `failure` | `gh run list` لكل commit دمج | الوكيل ✅ (بعد إصلاح REL-002) |
| 4 | **الخدمات الحية** | نسبة الخدمات المهيأة العاملة ≥95% (عتبة QA-005) | run `Service reality audit` `40680228320` (**12/12 = 100%**، `verdict: pass`) | مكتمل ✅ |
| 5 | **الإصدار والحافة الدائمة** | `v0.2.1` بأصوله الخمسة + Worker الحافة بقاعدة Cloudflare D1 (`durable: true`) | `40674752228` + `40706047781` على `main@44532f4` | الوكيل ✅ |
| 6 | **النشر الكامل للخادم الخلفي** | `verify:live` PASS على رابط عام مع MySQL دائم (بعد حجب Render بالبطاقة في `DEC-034`) | تقرير `verify:live` بصيغة PASS ولصقه في سجل جلسة | **قرار المالك** ([executive-completion-plan.md](executive-completion-plan.md)) |
| 7 | **القنوات** | Google مربوط ويعمل من رقم Owner · WhatsApp يستقبل ويوقّع | أمر مالك حقيقي + webhook موقّع من Meta | المالك (Google/Meta) |
| 8 | **الحماية والاستعادة** | نسخة `mysqldump` مستعادة فعليًا + حماية `main` + تنبيه فشل | RPO/RTO مكتوبان + لقطة قواعد الحماية | المالك (قرار/لوحة) |

**ما لا يدخل في «100%» على الطبقة المجانية، ويُقال صراحةً:** توافر عالٍ/SLA، تنفيذ معزول لكل مهمة، تعدد مستخدمين، بحث
دلالي، مزامنة Drive. هذه قرارات ميزانية لاحقة لا نقصًا مخفيًا.

---

## 1. الحقيقة المقاسة الآن (28 أكتوبر 2026، هذا الفرع)

| الطبقة | القيمة المقاسة | كيف قِيست |
|---|---|---|
| اختبارات Node | **383/383 ناجحة · 0 فاشلة** | `npm test` محليًا، Node 22.22.3 |
| التغطية | **أسطر 90.29% · فروع 73.20% · دوال 83.79%** (كانت 85.72/71.79/83.83) | `npm run test:coverage` |
| أرضية التغطية في CI | صارت **89/71/82** بدل 80/65/78 | `package.json` + `COVERAGE_FLOOR` في `scripts/service-reality.mjs` |
| فحوص البوابة | `check` 114 ملفًا ✓ · `release:check` ✓ · `npm audit --omit=dev` 0 ثغرة | محليًا |
| الخدمات الحية | **12 متحققة / 0 فاشلة من 12 مهيأة = 100%** (`verdict: pass`, `workingRate: 1`) | run [`40680228320`](https://github.com/celiaelazamey-arch/phone-google/actions/runs/40680228320) |
| النشر والدوام | Pages (`12/12` مسارًا) ✅ · Worker + Cloudflare D1 (`storage.durable: true`) ✅ · GHCR ✅ · Release ✅ · **Render محجوب ببطاقة (`DEC-034`)** | تشغيلة `40706047514` + `40706047781` على `main@44532f4` |
| فشل واحد على `main@fc4d60f` | `Publish verified release` فشل في خطوة تحقق **مدموجة** بلا تسمية البوابة | run `40665130469` |
| **بعد الدمج (PLAN-001/REL-002/QA-006)** على `main@5709bad` | **كل الـworkflows ناجحة**: الجودة `40674752264` · الإصدار `40674752228` (بواباته الأربع مسمّاة كلها ✅) · Pages `40674752288` · Worker `40674752211` · Render `40674873835` | `gh run list --branch main` |

**سبب الفشل الحقيقي (مثبت في PR #49 المدموج في `main@8a9fc56`):** اختبار `test/knowledge-ingest.test.js:164` — كان
`KnowledgeStore.stats()` يختار آخر سجل بـ`ORDER BY started_at DESC` وحده، فإذا تساوى توقيتان بدقة المللي ثانية لم يكن
المختار هو الأحدث؛ أُصلح بـ`rowid DESC` وتثبيت ساعة الاختبار. **تصحيح ذاتي:** تحليلي الأول استنتج من زمن التوقف (20 ثانية)
أن الفشل قبل `npm test`، وهذا خطأ — الاختبارات في CI تُشغّل الملفات بالتوازي فتنتهي أسرع من 24 ثانية المحلية. ومع ذلك
يبقى الفشل نفسه **بلا هوية**: خطوة `npm run check && npm run release:check && npm test && npm audit` تُبلغ «exit code 1»
ولا تسمّي البوابة. **الإصلاح المنفَّذ:** فصل البوابات الأربع في خطوات مسمّاة، وجعل النشر idempotent (إعادة التشغيل على
أصول متطابقة تنتهي `success` بلا رفع).

---

## 2. العوائق الخمسة — كلها لدى المالك، وكلها مجانية

| # | العائق | الأثر | الخطوة الدقيقة (بلا بطاقة) | دليل الإغلاق |
|---|---|---|---|---|
| O1 | ~~`CELIA_VOICE_ID` غير مطابق لصوت مرئي~~ | **✅ أُغلق بالكامل (12/12 = 100%)** | حُدِّث السر وجرى التحقق الحي منه بتوليف صوتي فعلي | run `40680228320` (`elevenlabs verified`, `verdict: pass`) |
| O2 | حجب إنشاء خدمة Render بطلب تفويض بطاقة بقيمة `1$` (`DEC-034`) | يمنع الخادم الخلفي الكامل (الركن 6)؛ وتم تعويض دوام الحافة فعليًا بـCloudflare D1 المجاني (`durable: true`) | اختيار مسار بديل بلا بطاقة من [executive-completion-plan.md](executive-completion-plan.md) (الإبقاء على Pages + Worker + D1، أو نشر حاوية GHCR على مضيف مجاني بلا بطاقة + Aiven MySQL Free) | `verify:live` بحكم `PASS` عند اعتماد مضيف حاويات مجاني |
| O3 | لا متغيّر `CELIA_LIVE_URL` ولا أسرار Render | نفس ما سبق — الأنبوب جاهز وينتظر الاسمين | Actions → Secrets and variables → **Variables** → `CELIA_LIVE_URL` = رابط Render؛ **Secrets** → `RENDER_API_KEY` (Account Settings → API Keys) + `RENDER_SERVICE_ID` (`srv-…`) أو `RENDER_DEPLOY_HOOK_URL` | run `Render full backend (free)` بحالة `deployed` و`liveReady` |
| O4 | لا تطبيق Meta ولا رقم WhatsApp | يمنع القناة 3ب | Meta for Developers → Create App → WhatsApp → رقم تجريبي → webhook = `https://<service>/webhooks/whatsapp` + `WHATSAPP_VERIFY_TOKEN` + `WHATSAPP_APP_SECRET` في Render | webhook يتحقق حيًا + `whatsapp_cloud_api verified` في التدقيق |
| O5 | لا حساب Google مربوط | يمنع «لخص آخر إيميل / هات جدولي» | Google Cloud → OAuth client (Web) بـredirect `https://<service>/auth/google/callback` → `npm run google:doctor` بلا مانع → رابط الموافقة من المالك | `200` حي + أمر مالك حقيقي يصل من رقمه |

**قاعدة صارمة:** لا كلمة مرور ولا مفتاح ولا صورة بطاقة تُلصق في الدردشة. تُكتب الأسرار في لوحة المزوّد أو في GitHub
Settings فقط، وهذا المشروع يفحص عدم تسريب أي قيمة (`check:secrets` + `sanitize()` + اختبار تسرّب).

---

## 3. خطة التنفيذ — مراحل مرتبة ببوابات

### المرحلة P0 — «لا فشل أحمر على `main`» (منفَّذة في هذه الجلسة)
1. **REL-002:** فصل بوابات الإصدار الأربع في `.github/workflows/release.yml` (تسمية البوابة الفاشلة).
2. **REL-002:** جعل خطوة النشر idempotent: إن كانت `SHA256SUMS` على الإصدار مطابقة للمولَّدة → `notice` وخروج 0.
3. **QA-006:** رفع أرضية التغطية إلى 89/71/82 (المقاس 90.29/73.20/83.79) وإضافة 21 اختبارًا جديدًا في 8 ملفات تغطي
   ما كان أهمّ ثقب: مسارات تشغيل الحافة، دورة الإيقاف، معالج الإصدار، بروتوكول MCP وأدواته، تحقق أدوات الوكيل، وبوابات
   الإرسال الخارجي (WhatsApp/Calendar).
   **البوابة:** `Celia quality & resilience` أخضر على Node 22 و24، و`Publish verified release` أخضر على `main` بعد الدمج —
   **تحققت:** run [`40674752228`](https://github.com/celiaelazamey-arch/phone-google/actions/runs/40674752228) على
   `main@5709bad` أظهر `Gate 1/4` … `Gate 4/4` كلها `success` ثم نشرًا ناجحًا.

### المرحلة P1 — «سرّ واحد يفصل الخدمات عن 95%» (ينتظر O1)
4. تشغيل التدقيق بوضع سريع جديد: `workflow_dispatch` → `Service reality audit` → `live_only: true` → ~دقيقة واحدة بدل
   ~20، مع `min_rate` 0.95.
   **البوابة:** annotation `workingRate: 1` و`verdict: pass`. عندها تُحدَّث QA-005 إلى «متحقق».
5. إن بقي الفشل نفسه: العائق في تبويب الأسرار لا في الكود — التدقيق يطبع طول المعرّف وأقرب صوت مرئي والفرق بالأحرف
   **دون كشف القيمة**، فيصبح موضع الخطأ محددًا لا مخمَّنًا.

### المرحلة P2 — «منشور» (ينتظر O2 وO3)
6. Aiven + Render Blueprint + أسرار اللوحة → `deploy-render.yml` ينشر تلقائيًا بعد كل CI أخضر على `main`.
7. `npm run migrate -- --apply` من جهاز المالك، ثم `CELIA_AGENT_RUNTIME=mysql` و`CELIA_AGENT_RESUME_ON_BOOT=true`.
8. cron-job.org كل 10 دقائق على `/readyz` مع تنبيه فشل بالبريد (مجاني).
   **البوابة:** `CELIA_LIVE_URL=… CELIA_MCP_API_TOKEN=… npm run verify:live -- --url … --expect-commit <sha>` → **PASS**،
   ويُلصق التقرير في سجل جلسة. عندها HOST-003 من «بانتظار» إلى «متحقق».

### المرحلة P3 — «القنوات» (ينتظر O4 وO5)
9. WhatsApp: webhook موقّع + تحقق + أمر مالك من `APP_OWNER_PHONE_E164` فقط، والرد الآلي يبقى `false` حتى قرار منفصل.
10. Google: عميل OAuth → موافقة → `google:doctor` → قراءة Gmail/Calendar حقيقية.
    **البوابة:** أمر Owner حقيقي واحد لكل قناة + `INT-001`/`INT-002` إلى «متحقق».

### المرحلة P4 — «لا تراجع صامت»
11. تفعيل حماية `main` بأسماء الفحوص من [preservation-plan](preservation-plan.md) §د.
12. أول `mysqldump` + تمرين استعادة + حفظ `TOKEN_ENCRYPTION_KEY` خارج Render → RPO/RTO مكتوبان (DATA-001).
13. مراجعة أسبوعية تلقائية: issue `service-reality` تفتح نفسها وتغلق نفسها (OPS-005).

### المرحلة P5 — «التغطية تباعًا»
14. ما زال بلا تغطية: `runStdioServer`، مسار `main` في `celia-mcp.js`، ومسارات OAuth/consent في `google.js`، ونصف
    `celia-ui.js`, `secrets-hub.js`. الهدف التالي: أسطر ≥92% بلا اختبارات شكلية — كل اختبار جديد يُثبت سلوكًا أو رفضًا.

---

## 4. بروتوكول التحقق (لكل مرحلة، لا استثناء)

1. **قبل** أي ادعاء: run على **نفس commit** الذي نقصده (لا run من فرع قديم).
2. **الأدلة الأربعة** في سجل الجلسة: `run id` + `commit sha` + annotation المنقّحة + مخرجات الأمر المحلي.
3. **لا تُعلن خدمة «تعمل»** إلا بمسبار حي بالأسرار الحقيقية من داخل Actions.
4. **لا يُعلن نشر** إلا بـ`verify:live` PASS على الرابط العام.
5. أي أخضر محلي لا يُغني عن أحمر/أخضر CI، وأي رقم تغطية يُذكر بثلاثته (أسطر/فروع/دوال).

---

## 5. المخاطر وردودها

| الخطر | الاحتمال | الأثر | الردّ |
|---|---|---|---|
| Render Free ينام → زمن إيقاظ ثوانٍ | مرتفع | تجربة أولى بطيئة | cron-job.org كل 10 دقائق + قياس `wake_latency` في `verify:live` |
| Aiven Free بلا نسخ مُدارة | مرتفع | فقد بيانات | `mysqldump` دوري إلى موضع مشفّر خارج Render (DATA-001) |
| حصة ElevenLabs المجانية 10k حرف/شهر | متوسط | فشل الصوت | التدقيق يستخدم 6 أحرف فقط؛ الأصوات البديلة مرئية في التشخيص |
| Gemini غير المدفوع يستخدم المحتوى | متوسط | خصوصية | قرار مالك معلن قبل تفعيل الرد الآلي للعملاء (AI-002) |
| فشل CI عشوائي في `npm ci`/الشبكة | منخفض | ضجيج | خطوات مسمّاة + `concurrency` + إعادة تشغيل idempotent |

---

## 6. ما تغيّر في هذه الجلسة (قابل للتحقق بالفرق)

- `.github/workflows/release.yml`: أربع بوابات مسمّاة + نشر idempotent بمقارنة `SHA256SUMS`.
- `.github/workflows/service-reality.yml`: مدخل `live_only` لتشغيل تحقق سريع (~دقيقة).
- `scripts/deploy-cloudflare-edge.mjs`: `main()` صار قابلًا للحقن (`env`/`fetchImpl`/`log`) ومُصدَّرًا — لاختبار مسارات
  الرفض والنشر بلا شبكة ولا مفتاح.
- `src/celia-mcp.js`: تصدير `runSelfTest({ env, log })` لاختباره في العملية نفسها.
- `package.json` + `scripts/service-reality.mjs`: أرضية تغطية 89/71/82.
- اختبارات جديدة: `deploy-cloudflare-edge`، `deploy-release`، `learn-source`، `reality-notify-main`، `lifecycle`،
  `celia-mcp-tools`، `celia-mcp-protocol`، `celia-mcp-selftest`، `agent-tool-validation`، `outbound-guards` (+21 اختبارًا،
  383 إجمالًا).

**لم يُنفَّذ ولن يُدّعى:** لا حساب، لا نشر، لا ترحيل على قاعدة حقيقية، لا لمس قيمة سرّية، لا دمج إلى `main` من هذه الجلسة.
