# تسليم جلسة — 2026-10-27 — بروتوكول التعلم المحكوم (`CELIA-LEARN-001`) وروابط النشر الموثقة

## المهمة والتفويض

- طلب المستخدم: (1) «روابط النشر»؛ (2) «استخدم صلاحياتك وأدواتك وتعلّم من هنا [YouTube `Cb3mBAH0IaY`] ما يهمنا
  وأعطني تم النشر 100%».
- معرفات BACKLOG: LEARN-001 (جديد — التعلم المحكوم)، HOST-003 (روابط النشر وما تبقى)، DOC-001.
- النطاق المسموح: الفرع `arena/f0f6f9f0-phone-google` فقط؛ لا دمج ولا نشر ولا إنشاء حسابات ولا بطاقة؛ لا نسخ نص
  طرف ثالث إلى المستودع؛ لا ادعاء نشر غير متحقق.

## واقع البداية

- الفرع: `arena/f0f6f9f0-phone-google` متفرع من `main@1a11810` (دمج PR #44). الإصدار `0.2.1`.
- شبكة الصندوق الرملي تمنع `youtube.com` و`github.io` و`workers.dev`؛ قارئ الصفحات المستضاف يصل إلى الويب.
- حالة النشر عند البداية (GitHub API، 2026-10-28 00:53 UTC): Pages deployment `7374226427` ناجح وفحص 10/10 مسارات في
  `40611588083`؛ Worker `deployed` و`liveReady:true` في `40611588035`؛ الإصدار `v0.2.1` موثق في `40611588118`؛ حزمة
  GHCR عامة. لا خدمة Render ولا Aiven.

## ما تغير فعليًا

- **المصدر والتعلم:** `data/learning/sources/yt-Cb3mBAH0IaY/source.json` (هوية الفيديو: «شرح جميع أنواع الذكاء
  الاصطناعي في 25 دقيقة»، قناة خلف القصة، 2026-08-04، 25:04؛ قناة الاستخراج ومحاولاتها الست؛ SHA-256 للنص
  `c7747dbc…55d6`، 6395 حرفًا، 180 سطرًا، 12 مقطعًا ببصماتها؛ `topics_unknown`؛ 9 ادعاءات مدعومة + ادعاء UNKNOWN
  صريح؛ متجه الحالة). النص المحلي `transcript.txt` **مُتجاهَل في Git**.
- **الأداة:** `scripts/learn-source.mjs` (ربط مقاطع صارم + فحص حقن تعليمات حتمي + وضع `--check`).
- **عقود KB:** `src/knowledge/validate.js` — `video` في `SOURCE_KINDS`؛ `reference-only` في `ALLOWED_LICENSES` مع
  `SOURCE_ONLY_LICENSES` (مرفوض خارج `sources`).
- **السجلات:** `data/kb/learned_registry.csv` (9 وحدات `T1`)، صفان جديدان في `sources_registry.csv`
  (`src-learning-notes`, `src-yt-khalf-alqissa-ai-types`)، descriptor + manifest محدثان.
- **الاختبارات:** `test/learning-protocol.test.js` (LS-01..LS-10).
- **الوثائق:** `docs/learning-protocol.md` (جديد)، `docs/knowledge-network.md`، `README.md` §روابط النشر،
  `docs/deployment-profile.json`، `CHANGELOG.md`، DEC-027، BACKLOG (LEARN-001 + HOST-003)، STATE.
- قرارات DEC: **DEC-027** جديد. لا تغيير في `tool-policy.js` ولا الأدوات ولا الأسرار ولا المخطط.
- ما بقي اقتراحًا: بوابة فهم بنموذج (بعد AI-002)، إعادة الربط بطوابع زمنية عند توفر النص الكامل.

## الفحوص

| الأمر/الفحص | commit/البيئة | النتيجة أو سبب عدم التشغيل |
|---|---|---|
| `node scripts/learn-source.mjs data/learning/sources/yt-Cb3mBAH0IaY --check` | هذا الفرع، محليًا | `ok: true`، `drift: []`، `injection_scan.findings: []` |
| `npm run kb:manifest && npm run kb -- verify` | محليًا | 6 ملفات؛ 9 صفوف مضافة (learned)، 0 مرفوضة، 71 حافة، `unresolved: []` |
| `node --test test/learning-protocol.test.js` | محليًا | 10/10 |
| `npm test` | محليًا (بعد `git fetch --unshallow`) | 295/295 — اختبار خط الأساس N/N−1 يحتاج تاريخ Git كاملًا؛ يفشل في نسخة ضحلة فقط |
| `npm run check` · `release:check` · `check:secrets` · `build:pages` · `check:continuity` | محليًا | 104 ملفًا سليمة · 0.2.1/schema 1 · 18/18 سرًا بلا تسريب · dist 9 صفحات (61.1KB) · 32 وثيقة و121 رابطًا و52 مهمة بلا دورات |
| فتح `github.io`/`workers.dev` من الصندوق الرملي | — | `000` (شبكة ممنوعة) — الدليل من GitHub API وتعليقات التشغيلات لا من طلب مباشر |

## الحفظ والتسليم

- commit على `arena/f0f6f9f0-phone-google` ودفع إلى الأصل؛ PR يُفتح من الفرع نفسه (الدمج قرار المالك).
- لا نشر من هذه الجلسة: الدمج إلى `main` هو ما يشغّل Pages/Worker/Release تلقائيًا.
- لم تُنفَّذ أي عملية خطرة: لا حسابات، لا بطاقة، لا ترحيل، لا إرسال خارجي.
- ما يبقى `not-verified`: الخادم الكامل (Render + Aiven) و`verify:live` على رابط عام.

## الاستئناف

- العوائق: نص الفيديو الكامل بطوابع زمنية (من المالك)؛ تفويض إنشاء حسابات Render/Aiven المجانية (من المالك).
- الخطوة التالية: (أ) عند وصول النص الكامل: استبدال `transcript.txt` محليًا، تحديث `segments` في `source.json`، تشغيل
  `learn-source.mjs` ثم `LS-01..LS-10`؛ (ب) HOST-003: إنشاء الخدمة والقاعدة من المالك ثم
  `npm run verify:live -- --url https://<service>.onrender.com --expect-commit <sha>`؛ أول فحص آمن: `npm run kb -- verify`.
