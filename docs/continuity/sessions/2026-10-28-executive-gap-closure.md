# جلسة 2026-10-28 — الخطة التنفيذية لإكمال البنود الناقصة وسد الفجوات والثغرات ومزامنة الموصلات (`DEC-036`)

- **التاريخ:** 28 أكتوبر 2026 (`Africa/Cairo`)
- **الفرع:** `arena/83dde20a-phone-google` (متفرع من `main@44532f4552c20b8fb51402e14cff8fc15356b97c` بعد دمج PR `#69`)
- **المهام المرتبطة:** `PLAN-001`، `SEC-001`، `SEC-002`، `SEC-003`، `SEC-005`، `DOC-002`، `QA-005`، `QA-006`، `OPS-005`
- **القرارات:** [DEC-036](../DECISIONS.md) (استكمالًا لـ`DEC-035`)

## 1. السياق وخط الأساس المتحقق قبل التنفيذ

- بعد دمج PR `#69` في `main@44532f4552c20b8fb51402e14cff8fc15356b97c`:
  - تشغيلة `Deploy (Cloudflare Edge)` رقم `40706047781` أنشأت ورحّلت وربطت قاعدة Cloudflare D1 `celia-edge-state` (`f63ccd9f-49b1-4eca-861b-fd478c433518`، 4 عبارات SQL نظيفة) وأثبتت من `/readyz` الحي: `storage: { mode: "d1", durable: true, latencyMs: 106 }`.
  - تشغيلة `Deploy (GitHub Pages)` رقم `40706047514` و`Publish verified release` رقم `40706047877` و`Celia quality & resilience` رقم `40706047968` كلها خضراء على `main`.
  - آخر تدقيق `Service reality audit` بالأسرار الحقيقية (`40680228320`) حقق `verdict: pass` بنسبة **12/12 = 100%** (`workingRate: 1`, `failed: []`) شاملاً توليف ElevenLabs الصوتي وFigma.
  - فحص سلسلة التوريد `npm audit --omit=dev` سجل **0 ثغرات**.

## 2. ما نُفِّذ في المستودع (`arena/83dde20a-phone-google`)

1. **تدوير مفاتيح تشفير رموز OAuth (`SEC-005`):**
   - تحديث `src/security.js` لدعم `parseEncryptionKeyring` (بصيغتيْ الاستدعاء) والمغلف المختوم `v2.<keyId>.<iv>.<tag>.<ciphertext>` المربوط بـAAD (`celia-token-envelope:v2:<keyId>`) مع التوافق الخلفي الكامل مع مغلفات `v1.*` ودالة `rotateEncryptedJson`.
   - توصيل `TOKEN_ENCRYPTION_KEY_ID` و`TOKEN_ENCRYPTION_KEYRING` الاختياريين في `src/config.js` و`src/google.js` و`src/celia-mcp.js` و`src/celia-ui.js`.
2. **تحصين حارس SSRF الشامل (`SEC-003`):**
   - تصدير وتوسيع `isDisallowedHost` في `src/ai-providers.js` لحجب جميع عناوين IPv4/IPv6 الخاصة والمحجوزة وCGNAT وmetadata وعناوين `::ffff:` المدمجة ونطاقات `.local`/`.internal`/`.localhost`.
   - تطبيق حارس مماثل داخل `validateCronJobPayload` في `workers/celia-edge/worker.js` بحيث يُرفض أي عنوان داخلي أو غير `https://` برمز `422`.
3. **تحصين خادم الحافة ومركز الأسرار (`SEC-001`, `SEC-002`, `OPS-005`):**
   - تحديث `workers/celia-edge/worker.js` و`wrangler.toml` و`scripts/deploy-cloudflare-edge.mjs` لمقارنة رمز المالك بزمن ثابت آمن للطول عبر `SHA-256`، وفرض سقف `8 KiB` لأجسام JSON (`413`)، وإرجاع `405` مع `Allow`، وفصل `/health` عن `/readyz`، وإضافة الترويسات الأمنية، ودعم أصليْ CORS (`https://celiaelazamey-arch.github.io,http://localhost:3000`).
   - إضافة `wiredInEdgeOrReadinessNames` في `src/secrets-hub.js` وإبراز تفاصيل `storage.mode` و`storage.durable` في `scripts/service-reality.mjs`.
4. **إكمال مسارات الواجهة وبوابات النشر والتوثيق (`DOC-002`, `QA-005`, `QA-006`, `PLAN-001`):**
   - توصيل مسارات `/computer` و`/computer.html` و`/computer-permissions` و`/computer-permissions.html` و`/computer.css` في `src/celia-ui.js`.
   - توسيع فحص المسارات الحية في `.github/workflows/pages.yml` إلى `12/12` مسارًا.
   - إنشاء [docs/executive-completion-plan.md](../../executive-completion-plan.md) وتحديث `docs/deployment-profile.json` و`docs/service-reality.md` و`docs/plan-100-percent.md` و`docs/preservation-plan.md` و`README.md`.
   - إضافة جناح التدقيق الأمني الشامل `test/security-surface-audit.test.js` وتوسيع `test/celia-edge-worker.test.js` و`test/computer-page.test.js` و`test/knowledge-store.test.js` و`test/service-reality.test.js`.

## 3. ما نُفِّذ عبر الموصلات الـ11 المتصلة (نطاق خاص بالمالك وصفر أسرار)

- فحص وجرد حالة الموصلات الـ11 المتصلة (`vercel`, `supabase`, `linear`, `notion`, `google_drive`, `google_docs`, `google_sheets`, `google_slides`, `google_calendar`, `dropbox`, `gmail`).
- إنشاء مشروع التتبع التنفيذي في `Linear` (`55a2e8fd-c1fe-4253-9485-efc0b76cc95e` على فريق `CEL`) و7 مهام مهيكلة (`CEL-5`..`CEL-8` بحالة `Done` و`CEL-9`..`CEL-11` لبنود المالك بحالة `Todo`)، ومجلد `Google Drive` الخاص (`1ZhVmTDGam2i_EixiwI0bGPxbJ4gShOPo`) الذي يضم مستند الخطة في `Google Docs` (`1HEv5hkdaYfGu8akZkR3fFcyis3sJrstF2jwiikQE0PA`) ومصفوفة الـ3 تبويبات في `Google Sheets` (`18cXH45gVKC8QALyvHRAFddW_0EoZXY7gaSXts4yeNhw`) والعرض التنفيذي من 5 شرائح في `Google Slides` (`1MLHKJx0Ukr3DB5jn6dmNUpkQ4_Hv__atDEjnbwRzios`)، ونسخة الخطة في `Dropbox` (`/CeliaOS-Executive-Plan-2026/executive-completion-plan.md`).
- تشخيص حالة الموصلات القرائية بأمان: `Google Calendar` مضبوط حالياً على `UTC` (بينما التوقيت المحلي للمالك `Africa/Cairo`)، و`Supabase` يضم المشروع `yqzhgogmtscoqejuxplv` (`INACTIVE`, Postgres `17.6`)، و`Vercel` يضم `0` مشاريع، و`Notion` لا يشارك حالياً مع التكامل سوى دليل `People` المُدار من النظام (`restricted_resource`)، مع عدم إرسال أي رسائل عبر `Gmail` (`celiaelazamey@gmail.com`).

## 4. المرحلة الثانية في نفس الجلسة — تطبيق النشر الإنتاجي الكامل مجانًا بدون فيزا (`DEC-037`)

1. **التحقق الأولي (`تحقق في البداية`):** فحص قيود البطاقة في المنصات الحية والموصلات (`Render` محجوب ببوابة `1$`، `Vercel AI Gateway` محجوب بـ`403`، `Supabase` متوقف بالخمول `INACTIVE`، بينما `Cloudflare Workers + D1 + GitHub Pages` يعمل حيًّا بلا بطاقة ومع `18/18` سرًّا مربوطة تلقائيًا).
2. **ترقية `workers/celia-edge/` إلى خادم إنتاجي متكامل فوق Cloudflare D1:**
   - إنشاء `workers/celia-edge/migrations/0002_runtime.sql` (8 عبارات SQLite idempotent تُضاف إلى `0001_state.sql` ليصبح المجموع 12 عبارة تشمل جداول المستخدمين ورموز Google المشفرة وحالات OAuth وجهات اتصال ورسائل واتساب ومفاتيح منع التكرار).
   - إنشاء `workers/celia-edge/crypto.js` (`AES-256-GCM` بصيغة `v2.<keyId>` عبر `TOKEN_ENCRYPTION_KEY` أو اشتقاق `HKDF-SHA-256` مع توافق `v1.*`، وتوقيع تذاكر المتصفح، وفحص `X-Hub-Signature-256` الخام).
   - إنشاء `workers/celia-edge/runtime.js` وربطه بـ`worker.js` لتشغيل جميع أدوات MCP الـ12 (`POST /mcp`)، وربط Google OAuth2 (Gmail / Drive / Calendar / Contacts)، وWebhook واتساب الرسمي وأوامر المالك العربية («اربط جوجل»، «لخص آخر إيميل»، «هات جدولي») والرد الذكي بـGemini.
   - تحديث `scripts/deploy-cloudflare-edge.mjs` لرفع الوحدات الأربع وتطبيق كل الترحيلات وتمرير إعدادات واتساب الاختيارية، وإضافة `--mode edge` في `scripts/verify-live.mjs` (`npm run verify:edge`) وتشغيله آليًا في `.github/workflows/cloudflare-deploy.yml`، وضبط `CELIA_REAL_SERVICE_URL` في `.github/workflows/pages.yml`، وتوثيق الدليل الكامل في [docs/no-visa-deployment.md](../../no-visa-deployment.md)، والتحقق بجناح `test/edge-full-runtime.test.js` فوق `node:sqlite`.

## 5. ما لم يُثبت وبقي لقرار المالك

- دمج PR `#70` في `main` لينطلق نشر الـWorker المحدّث وتتحقق `verify:edge` على الرابط العام، وإضافة `https://celia-phone-google.celiaelazamey.workers.dev/auth/google/callback` في Google Cloud Console لإتمام ربط `GOOG-001`.
- تفعيل حماية الفرع `main` في إعدادات GitHub (`Settings → Branches`).
- قرار المالك بشأن حسم مصير PR `#38`، وتطبيق Meta WhatsApp الاختياري (`WA-005`) وبيانات `SPDR-002` وسياسات `DATA-004`/`GOV-001`/`REL-001` (ويبقى `HOST-003` لخادم حاوية MySQL المستقل خيارًا ثانويًا غير ملزم بعد اكتمال مسار Workers + D1 بلا بطاقة).
