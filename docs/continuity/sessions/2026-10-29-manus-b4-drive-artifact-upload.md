# جلسة 2026-10-29 — MANUS-B4: رفع artifact مبصوم إلى Drive المالك خلف الموافقة

**الفرع:** `arena/dcb565df-phone-google` (منشأ من `main@bdfbb6b` = دمج PR #92 بشجرة نظيفة).
**النطاق:** صف B4 في خطة منافس مانوس — «رفع إلى Drive المالك (الكتابة الأولى خارج Calendar) خلف بوابة الموافقة القائمة + outbox».
**معيار القبول المقاس:** ملف يصل Drive بنية واحدة وإرسال واحد؛ و`unknown` يذهب للمصالحة لا لإعادة إرسال (DEC-015/016 بلا تعديل).

## 1) المشكلة الفعلية التي حلّها B4

`google.drive_export_report` كان موجودًا منذ AGENT-002، لكن حمولته كانت **نصًا يكتبه المخطط** (`title/content/mimeType`). مخرجات B2/B3 لا تُسلَّم بهذا الشكل: الملف الحقيقي محفوظ في مخزن artifacts ببصمة SHA-256 ورابط موقّع، وأي نسخة نصية يكتبها المخطط ليست الملف الذي رآه المالك. الفجوة كانت **مصدر البايتات**، لا وجود الموصل.

## 2) ما نُفِّذ

1. **`artifacts.readForUpload({ id, runId? })`** (`src/agent/artifact-store.js`): قراءة داخلية بلا توقيع (المستدعي هو المضيف داخل إرسال أثر معتمد، لا متصفح)، لكن **البصمة تُعاد حسابها في كل قراءة**، وكل رفض مرمَّز ومثبت: `artifact_id_invalid` / `artifact_not_found` / `artifact_run_mismatch` / `artifact_payload_unavailable` / `artifact_tampered`.
2. **جسر في موصل Drive** (`src/agent/connectors.js`): `createDriveExportConnector({ resolveArtifact })` صار يفهم حمولتين متعارضتين — `{ title, content, mimeType }` (AGENT-002 كما هو حرفيًا) أو `{ artifactId, title?, mimeType? }` — ويتحقق **قبل أي طلب** من: الشكل، تعارض المصدرين (`drive_artifact_content_conflict`)، وجود المخزن (`drive_artifact_export_unavailable`)، الحجم (`drive_artifact_too_large` عند 200k بايت)، كون البايتات نصًا صالحًا (`drive_artifact_not_text`)، والنوع من الامتداد المعلن أو `mimeType` الصريح. النتيجة تحمل `source: { artifactId, sha256, bytes }` فتُسجَّل في الأدلة.
3. **عقد الأداة** (`src/agent/tools.js`): `google.drive_export_report` يُبنى الآن من مصنع — بلا مخزن يبقى العقد حرفيًا `{title, content, mimeType}` (وتمرير `artifactId` = `policy_violation_unknown_argument`)، ومع المخزن يُضاف `artifactId` **مصدرًا بديلًا لا إضافيًا** (محتوى + معرّف = رفض). التصنيف لم يتغير: `external_effect` + `requiresApproval` + connector `google.drive`، ولا `execute` داخل العملية.
4. **التركيب** (`src/agent/index.js`): `buildConnectors` يستلم `resolveArtifact`، والمخزن يُربط **بعد** بنائه (جسر `artifactBridge`) لأن المخزن يعتمد على العزل — لا دورة اعتماد ولا ترتيب هش. بلا مخزن يرفض الجسر بـ`drive_artifact_export_unavailable` بدل `null` صامت.
5. **`text/html`** أُضيف إلى `ALLOWED_DRIVE_MIME_TYPES` وحده، لأن قالب `static_page` في B3 ينتجه؛ رفضه كان سيجعل نوعًا معلنًا من مخرجاتنا غير قابل للتسليم.

## 3) الاختبارات — `test/agent-drive-artifact-upload.test.js` 9/9

| المعرف | ما يُثبته |
|---|---|
| B4-01 | المسار الجديد مشروط بوجود المخزن؛ عقد بلا مخزن مطابق حرفيًا للقائم |
| B4-02 | `readForUpload` يعيد البصمة عند كل قراءة ويرفض الغائب/الغريب/المعبوث بأكواد صريحة |
| B4-03 | البايتات نفسها تصل مرة واحدة، والنوع من الامتداد، والاسم هو العنوان الافتراضي، والمصالحة بـ`celiaOutboxKey` |
| B4-04 | غائب/معبوث/ضخم/ثنائي/بلا نوع = فشل مثبت **بصفر نداءات Drive** (ولا حتى استعلام المصالحة) |
| B4-05 | القبول: `template.render` → موافقة → **ملف واحد** ببايتات مطابقة لبصمة artifact، وسلسلة أدلة سليمة و`PASS` |
| B4-06 | نية واحدة وإرسال واحد: الصف الحي لا يتكرر، والإرسال المسوّى لا ينتج ملفًا ثانيًا |
| B4-07 | خطأ نقل غامض → `unknown` + `needs_reconciliation`، والاستئناف **لا يعيد الإرسال** |
| B4-08 | القبول: العبث بالملف بعد الموافقة يُكشف بالبصمة قبل الشبكة → `failed` + `artifact_tampered` + `BLOCK` |
| B4-09 | بلا جسر: مسار artifact رفض صريح، والتصدير المضمَّن يعمل كما كان بلا `source` |

## 4) الفحوص الفعلية (هذه الجلسة، هذه الشجرة)

| الأمر | النتيجة |
|---|---|
| `node --test test/agent-drive-artifact-upload.test.js` | **9/9 pass** |
| `node --test` لملفات connectors + artifact-store + tool-validation + google-read + output-templates | **28/28** (google-read احتاج `npm ci` لغياب `node_modules` في الصندوق) |
| `npm run test:coverage` | **754 اختبارًا، 737 ناجحًا، 1 فشل بيئي (N/N-1: الكائن `2508893…` غير موجود في هذا الاستنساخ)، 16 skipped** — تغطية **91.01 / 75.98 / 87.10** |
| `npm run check` | Syntax verified: 176 ملف JavaScript |
| `npm run eval:templates` / `eval:ai` | لم يُعالجا: لا تغيير في القوالب ولا في مجموعة AI-001 |

## 5) حدود معلنة (بلا ادعاء)

- **لا نطاق OAuth جديد:** `GOOGLE_SCOPES` لم يتغير (يبقى `drive.readonly`). الرفع الحي إلى Drive يحتاج منحًا بنطاق كتابة (`drive.file` أو أوسع) — وهذا **قرار مالك**، وليس شيئًا استنتجه هذا العمل. لذلك كل ما هنا محلي/Mock بناقل قابل للحقن، والمسار الحي على منح قراءة فقط سيفشل بـ`drive_authorization_failed` بصدق.
- **تصدير واحد لكل تشغيل** لكل أداة: قيد قائم في `enqueueOutbox` (صف حي واحد لكل `run_id + tool_name`) وليس من B4؛ وصف B4 يقبله نصًا («بنية واحدة وإرسال واحد»). تصدير ثانٍ يحتاج تشغيلًا جديدًا.
- **ملكية المعرّف:** الرابط الموقّع ليس التفويض في هذا المسار؛ التفويض هو الموافقة المسجلة + البصمة المتطابقة. لا قراءة عبر HTTP أُضيفت ولا مسار نزيل جديد.
- **الدمج:** PR #93 دُمج بكلمة المالك في **`main@acafa13`** (2026-10-29) بعد 6 فحوص CI ناجحة (2 skip مقصود) — لا ترحيل ولا نشر ولا تفعيل حي رافقه.

## 6) الاستئناف

- **التالي على السلّم:** S4 مكتمل بـB1/B2/B3/B4. الدرجة التالية **S5 — العينان (M-C)**: ابدأ بـ**egress proxy** (أخطر مكوّن) قبل أي `web.fetch`. لا يبدأ S2/S3 قبل GOV-001.
- **قرار مالك مفتوح يخصّ هذا العمل:** منح نطاق كتابة Drive (أو إبقاء الرفع محليًا/Mock) — قرار مستقل عن GOV-001.
- **أول فحص آمن:** `node --test test/agent-drive-artifact-upload.test.js` ثم `npm run check:continuity`.
