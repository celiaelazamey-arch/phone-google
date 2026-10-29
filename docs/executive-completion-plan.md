# الخطة التنفيذية لإكمال البنود الناقصة وسد الفجوات والثغرات (أكتوبر 2026)

**التاريخ:** 28 أكتوبر 2026 · **الفرع:** `arena/83dde20a-phone-google` (متفرع من `main@44532f4552c20b8fb51402e14cff8fc15356b97c`) ·
**القرار المرجعي:** [DEC-036](continuity/DECISIONS.md) · **مرجع الحالات الوحيد:** [BACKLOG.md](continuity/BACKLOG.md) ·
**الواقع الحي:** [service-reality.md](service-reality.md) · **خطة المحافظة:** [preservation-plan.md](preservation-plan.md)

> **خلاصة تنفيذية صادقة:** انتقل النظام بعد دمج `#69` (`main@44532f4`) وهذه الحزمة التنفيذية إلى إغلاق كامل لكل الفجوات
> البرمجية والثغرات الأمنية القابلة للإصلاح داخل المستودع، مع ثبات خدمات الإنتاج المهيأة عند **12/12 = 100%** (تشغيلة
> `40680228320`) وثبات دوام قاعدة Cloudflare D1 الحقيقية على الحافة (`storage.mode = "d1"`, `durable = true` في تشغيلة
> `40706047781`). أمّا البنود التي تنتظر لوحات المالك الخارجية أو قراراته السيادية (حماية فرع `main`، بديل Render بعد قيد
> البطاقة، تطبيق Meta WhatsApp، ربط Google الحي، قرار PR `#38`) فهي مفصولة بوضوح تام ومربوطة بخطوات تنفيذية موثقة عبر
> المستودع وموصلات العمل المتصلة دون أي ادعاء زائف أو تسريب لسر واحد.

---

## 1. خط الأساس المُقاس بالدليل قبل وبعد التنفيذ

| المحور | الحالة قبل الحزمة | الحالة بعد التنفيذ | الدليل المرجعي |
|---|---|---|---|
| **دوام الحافة (Cloudflare D1)** | كان محلل SQL ينكسر عند `;` داخل تعليق `--` | **متحقق حيًا (`durable: true`)** على القاعدة `celia-edge-state` (`4` عبارات ترحيل سليمة) | PR `#69` (`main@44532f4`) · تشغيلة `40706047781` |
| **واقع الخدمات الحية (`QA-005`)** | التوثيق القديم كان يذكر `11/12 (91.7%)` | **12/12 متحققة = 100%** (`workingRate: 1`, `failed: []`) + 4 متقاعدة صراحةً في Git | تشغيلة `40680228320` + توحيد الوثائق |
| **أمن بوابة الحافة (`SEC-001` / `SEC-003`)** | مقارنة رمز تعتمد على الطول الأولي، غياب حارس SSRF لروابط `cron-job.org`، غياب سقف بايتات UTF-8 ومهلة المنبع | **مُحصَّن بالكامل:** مقارنة ثابتة الزمن آمنة الطول، حارس HTTPS + SSRF (`422`)، رفض `405` مع `allow`، سقف `8192` بايت (`413`)، مهلة `15s` (`504`/`502`)، ترويسات أمنية، وفصل `/health` عن `/readyz` | `workers/celia-edge/worker.js` · `test/celia-edge-worker.test.js` |
| **حارس SSRF في المزودات (`SEC-003`)** | تغطية IPv4 الأساسية وبعض صيغ IPv6 فقط | **تغطية شاملة:** IPv4 الخاص + CGNAT `100.64/10` + البث المتعدد `>=224` + التمثيل الرقمي/الست عشري + IPv6 (`::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, `::ffff:` المدمج) + `.internal` / `metadata.google.internal` | `src/ai-providers.js` · `test/security-surface-audit.test.js` |
| **تدوير مفاتيح التشفير (`SEC-005`)** | مفتاح منفرد `v1` بلا معرّف مفتاح أو آلية تدوير بدون توقف | **مُنفَّذ بالكامل:** `parseEncryptionKeyring` + مظروف `v2.<keyId>` محمي بـAAD في AES-256-GCM + فك تشفير `v1` القديم + `rotateEncryptedJson` + عزل كامل عن واجهة المحاكاة العامة | `src/security.js`, `src/config.js`, `src/google.js`, `src/celia-mcp.js`, `src/celia-ui.js` |
| **تطابق مسارات الواجهة وفحص النشر (`DOC-002`)** | `/computer` و`/computer-permissions` تعمل في Pages لكنها غائبة عن خادم Express ومسبار `pages.yml` يفحص 10 مسارات فقط | **تطابق 100%:** تقديم `/computer*` و`/computer.css` في Express مع CSP صارم، وتوسيع `pages.yml` لفحص **12/12 مسارًا حيًا** | `src/celia-ui.js` · `.github/workflows/pages.yml` · `test/computer-page.test.js` |
| **شفافية تصنيف الأسرار (`SEC-002`)** | `presentUnwiredNames` يذكر أسرار الحافة دون توضيح أنها موصولة فعليًا في الحافة وفحوص الجاهزية | إضافة `wiredInEdgeOrReadinessNames` بجانب `presentUnwiredNames` مع الحفاظ التام على التوافق العكسي | `src/secrets-hub.js` · `test/security-surface-audit.test.js` |
| **استقرار التغطية (`QA-006`)** | تذبذب اختبار 5000 سجل FTS5 تحت حمل `--experimental-test-coverage` | إحماء JIT مسبق + ميزانية زمن واعية بوضع التغطية (`150ms` عادي / `300ms` تغطية) | `test/knowledge-store.test.js` |
| **تنظيف الـPRs الخطرة والمكررة (`OPS-005`)** | 4 طلبات سحب قديمة مفتوحة (`#67`, `#39`, `#38`, `#34`) | إغلاق موثق لـ`#67` (مكرر) و`#39` (متجاوز) و`#34` (revert خطر على `agent_outbox`) مع إبقاء `#38` لقرار المالك | سجل GitHub PRs وتعليقات الإغلاق |

---

## 2. مصفوفة الفجوات والثغرات وخطة الإغلاق التنفيذية

### أولًا: الفجوات الأمنية والبرمجية المغلقة في الكود (مسؤولية الوكيل — مكتملة 100%)

1. **تحصين طبقة الحافة `workers/celia-edge/worker.js`:**
   - استبدال المقارنة المبكرة للطول بمقارنة ثابتة الزمن باستخدام تجزئة/حشو متساوي الطول لمنع تسرب طول `CELIA_MCP_API_TOKEN`.
   - فرض بروتوكول `https:` ومنع جميع عناوين الشبكات الخاصة والداخلية وخدمات البيانات الوصفية السحابية (`169.254.169.254`, `metadata.google.internal`, `100.64.0.0/10`, `fc00::/7`, `[::ffff:...]`) في `POST /api/cron/jobs` برفض صريح `422`.
   - تحديد سقف حجم الطلب عند `8192` بايت فعلي (UTF-8) برفض `413 Payload Too Large` قبل تحليل JSON.
   - إضافة مهلة `AbortSignal.timeout(15_000)` لطلبات `cron-job.org` مع تحويل انتهاء المهلة إلى `504` وأعطال المنبع إلى `502` دون كشف أي رأس تفويض.
   - **تحديث 2026-10-29 (DEC-042، OPS-007):** الحارس نفسه صار أمام **صندوق صادر** على D1 (`edge_cron_outbox`): `POST/PATCH/DELETE /api/cron/jobs` لم تعد تكتب مباشرة بل تسجّل نيّة (202) تنتظر موافقة المالك بـ`expectedHash` وتُرسل مرة واحدة؛ المهلة/5xx في الإرسال تعني `unknown` يسوّيه المالك لا إعادة محاولة.
   - فصل `/health` (فحص حياة خفيف بلا كتابة على القاعدة) عن `/readyz` (فحص جاهزية كامل يثبت الكتابة والقراءة على D1).
   - دعم قائمة أصول متعددة مفصولة بفواصل في `ALLOWED_ORIGIN` (`https://celiaelazamey-arch.github.io,https://celia-phone-google.celiaelazamey.workers.dev`) مع `Vary: Origin` وترويسات `X-Content-Type-Options: nosniff` و`X-Frame-Options: DENY` و`Referrer-Policy: no-referrer` و`Cache-Control: no-store`.

2. **تدوير مفاتيح التشفير بلا توقف (`SEC-005`):**
   - دعم متغيرين اختياريين `TOKEN_ENCRYPTION_KEY_ID` و`TOKEN_ENCRYPTION_KEYRING` (`kid1:base64,kid2:base64`) مع بقاء `TOKEN_ENCRYPTION_KEY` وحده كافيًا للإقلاع والتوافق مع `render.yaml` وجميع الاختبارات الحالية.
   - ربط `v2.<keyId>` كبيانات إضافية مصادق عليها (`AAD`) داخل `AES-256-GCM` بحيث يفشل أي تلاعب بترويسة معرّف المفتاح فورًا.
   - توفير دالة `rotateEncryptedJson(payload, keyring)` لإعادة تشفير الرموز المخزنة بصيغة `v1` أو بمفتاح قديم إلى المفتاح النشط دون كسر الجلسات القائمة.

3. **توحيد الأسطح ومسارات العرض (`DOC-002` + `OPS-005`):**
   - ربط `/computer` و`/computer.html` و`/computer-permissions` و`/computer-permissions.html` و`/computer.css` في `src/celia-ui.js`.
   - تحديث `.github/workflows/pages.yml` للتحقق الحي من جميع المسارات الـ12 المنشورة.
   - تحديث `scripts/service-reality.mjs` لإظهار `storage.mode` و`durable` في تشخيص خدمة الحافة العامة.

---

### ثانيًا: الفجوات التشغيلية والسيادية خارج الكود (تحتاج قرار/لوحة المالك حصريًا)

احترامًا لقيود [AGENTS.md](../AGENTS.md) الصارمة (**لا بطاقة دفع، لا خطة مدفوعة، لا انتحال هوية، لا تعديل إعدادات حماية الفرع بلا صلاحية إدارية**)، تُوثَّق البنود الخمسة التالية بدقة مع خطة تنفيذ كل منها:

| الرمز | البند الناقص | السبب الجذري الموثق | الخيار التنفيذي المتاح للمالك (بلا بطاقة) | معيار القبول النهائي |
|---|---|---|---|---|
| **G-OWN-1** | حماية الفرع `main` (`protected: false`) | واجهة GitHub ترد `403` لتوكن التكامل على إعدادات الفروع | من GitHub → `Settings → Branches → Add branch ruleset/rule` للفرع `main`: تفعيل Require PR + Require status checks (`Node 24`, `Node 22`, `MySQL 8.4`, `RTL dashboard`, `Node 24 container smoke test`, `Python 3.11`) + منع `force push` والحذف | `gh api repos/celiaelazamey-arch/phone-google/branches/main` يعيد `protected: true` |
| **G-OWN-2** | استضافة الخادم الكامل Express + MySQL (`HOST-003`) | Render يطلب تفويض بطاقة بقيمة `1$` (مرفوض بقرار `DEC-034`)؛ حساب Vercel المتصل فارغ (`0` مشاريع) ومشروع Supabase `supabase-aero-cable` متوقف (`INACTIVE`، محرك Postgres لا MySQL) | أحد مسارين بلا بطاقة: **(أ)** الإبقاء على معمارية الصفحات + Cloudflare Worker + D1 الحالية كسطح إنتاج مجاني دائم 100%؛ أو **(ب)** نشر الحاوية الجاهزة `ghcr.io/celiaelazamey-arch/phone-google:v0.2.1` على مضيف حاويات مجاني بلا بطاقة مع قاعدة Aiven MySQL Free ثم ضبط `CELIA_LIVE_URL` | نجاح `npm run verify:live -- --url $CELIA_LIVE_URL --expect-commit <sha>` بحكم `PASS` |
| **G-OWN-3** | قناة WhatsApp Cloud API (`INT-002` / `WA-005`) | الكود والاختبارات جاهزة، لكن لا تطبيق Meta مربوط في الأسرار | إنشاء تطبيق Meta for Developers (WhatsApp Test Number مجاني) وإضافة `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` | تحول `whatsapp_cloud_api` في `Service reality audit` من `unconfigured` إلى `verified` |
| **G-OWN-4** | ربط حساب Google الحي (`GOOG-001..003` / `INT-001`) | عميل OAuth متحقق (`google_oauth_client: verified`) لكن الربط يتطلب خادمًا عامًا وموافقة المالك في المتصفح | بعد توفر رابط الخادم الكامل: ضبط `GOOGLE_REDIRECT_URI` وتشغيل `npm run google:doctor` ثم إتمام موافقة OAuth لمرة واحدة | نجاح أمر مالك فعلي لقراءة التقويم/البريد بتوقيت `Africa/Cairo` |
| **G-OWN-5** | قرار طلب السحب المفتوح `#38` وحوكمة الاحتفاظ/الترخيص (`DATA-004`, `GOV-001`) | `#38` متعارض مع `main` (`DIRTY`) ويحوي نسخة قديمة من جسر الحافة استُبدلت بـ`celia-edge` مع صفحتي `/cron` و`/google-map` | قرار صريح من المالك: إغلاق `#38` نهائيًا أو استخلاص صفحتي العرض الساكنتين منه في PR نظيف، واعتماد مدة الاحتفاظ بالبيانات ورخصة النشر | صفر PRs متعارضة مفتوحة + توثيق قرار الاحتفاظ في `DECISIONS.md` |

---

## 3. توظيف الموصلات المتصلة وحوكمتها (11 موصلًا مفعّلًا)

تم جرد وتوظيف الموصلات الأحد عشر المفعّلة في هذه الجلسة وفق مبدأ **أقل صلاحية، خصوصية المالك فقط (`private`)، وصفر أسرار في أي مستند خارجي**:

1. **Linear (`team: CEL` — `Celia s`):** إنشاء مشروع تنفيذي مهيكل `CeliaOS — الخطة التنفيذية لإكمال البنود وسد الفجوات (2026)` يضم حزم العمل المكتملة وبنود المالك المتبقية مع ربطها بطلب السحب على GitHub.
2. **Notion:** إنشاء صفحة تنفيذية وتدقيق أمني عربية منظمة تحت مساحة المالك لتوثيق مصفوفة الفجوات، حالة الخدمات الـ20، وخارطة الطريق.
3. **Google Drive + Google Docs + Google Sheets + Google Slides:** إنشاء مجلد خاص بالمالك فقط (`CeliaOS — الخطة التنفيذية 2026`) يضم:
   - **وثيقة Google Docs:** الخطة التنفيذية التفصيلية وتقرير التدقيق الأمني.
   - **جدول Google Sheets:** مصفوفة تتبع الخدمات الـ20، الأسرار الـ18 (أسماء وحالات فقط دون قيم)، وبنود `BACKLOG`.
   - **عرض Google Slides:** عرض تنفيذي منظم لخارطة الطريق ومعمارية الأمان والدوام على الحافة.
4. **Dropbox:** حفظ نسخة احتياطية نصية منقحة (`executive-completion-plan.md`) داخل مجلد `/CeliaOS-Executive-Plan-2026/` للرجوع المستقل.
5. **Google Calendar:** فحص قراءة فقط لإعدادات المنطقة الزمنية للمالك للتأكد من التطابق مع `Africa/Cairo` دون إنشاء أحداث مزعجة.
6. **Gmail:** فحص قراءة فقط لجاهزية الحساب دون إرسال أي بريد خارجي غير مأذون.
7. **Supabase & Vercel:** فحص قراءة فقط للبنية المتصلة (التحقق من عدم وجود مشاريع Vercel نشطة، وتوثيق حالة مشروع Supabase المتوقف `supabase-aero-cable` دون تشغيله أو تعديله التزامًا بقيد عدم الإنفاق).

---

## 4. بوابات التحقق الإلزامية لهذه الحزمة

لا تُقبل هذه الحزمة إلا باجتياز البوابات التالية مجتمعةً على الفرع `arena/83dde20a-phone-google`:

1. `npm test` — نجاح 100% من اختبارات الوحدات والتكامل والأمن (بما فيها `test/security-surface-audit.test.js` و`test/celia-edge-worker.test.js` و`test/edge-d1.test.js`).
2. `npm run test:coverage` — تجاوز أرضية التغطية الصارمة (`89%` أسطر / `71%` فروع / `82%` دوال).
3. اختبارات حزمة Python `celia-google-spider` (`python3 -m unittest discover -s tests -v`).
4. `npm run check` + `npm run check:continuity` + `npm run check:secrets` + `npm run computer:permissions:check` + `npm run build:pages`.
5. خلو التبعيات الإنتاجية من الثغرات (`npm audit --omit=dev` = `0 vulnerabilities`).
