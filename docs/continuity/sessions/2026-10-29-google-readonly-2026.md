# 2026-10-29 — GOOG-005: مراجعة Google read-only ضمن حدود 2026

## القرار والنطاق

- اختار المالك `google_readonly_2026`: مراجعة/استكمال Gmail وDrive وCalendar وContacts بالنطاقات الحالية، مع اختبارات Mock، ولا OAuth حي أو scopes جديدة. Sheets وDocs وYouTube وPhotos مستبعدة.
- لا تغيير في `GOOGLE_SCOPES`: `openid` و`email` و`gmail.readonly` و`drive.readonly` و`calendar.events` و`contacts.readonly`. لا `drive` الكاملة أو `spreadsheets` أو `documents` أو `calendar` الكاملة.
- لا يوجد التزام بجاهزية إنتاجية أو بظهور بيانات حساب المالك. لم يُطلب `credentials.json` أو access/refresh tokens، ولم يحدث اتصال Google حقيقي.

## ما نُفّذ

- `src/agent/google-read.js`: موصلات وأدوات `google.drive_read` و`google.calendar_read` و`google.contacts_read`، بعقود `risk=read` ومدخلات مغلقة وإسقاط الحقول الخام. Gmail يبقى في `src/agent/gmail.js` بعقده المستقل.
- `src/google.js`: `fetchDriveFiles()` و`fetchGoogleContacts()` و`createGooglePeopleClient()`، مع إعادة استخدام `listAgendaEvents()` و`fetchInboxMessages()` والـOAuth المشفر. العملاء قابلون للحقن في الاختبارات.
- `src/agent/index.js` و`tools.js`: التفعيل الصريح `CELIA_AGENT_CONNECTORS=google_read` للأربعة؛ لا outbox connector. قيمتا `drive` و`calendar` الحاليتان لا تتغيران وتبقيان للآثار approval-gated.
- `src/agent/planner.js`: نوايا قراءة ضيقة وملخصات منقّحة، مع منع قراءة Calendar/Drive من السقوط إلى create/export بعد نجاحها. المخطط ما زال `demo` الحتمي.
- `.env.example` و`docs/agent-runtime.md` و`docs/agent-risk-matrix.md` و`docs/google-readonly-2026.md`: التفعيل والعقود والحدود، بما فيها أن `calendar.events` أوسع من read-only على مستوى المنح؛ القيد الجديد في الكود فقط.

## عقود القبول المحلية

| الخدمة | العقد المختبر |
|---|---|
| Gmail | 1–5 رسائل، metadata/snippet ≤500 حرف، بلا body/attachments/send |
| Drive | أحدث 1–10 ملفات غير محذوفة، `id/name/mimeType/modifiedTime`، بلا محتوى أو كتابة |
| Calendar | حتى 20 حدثًا، نافذة صريحة ≤31 يومًا، `events.list` فقط |
| Contacts | صفحة أولى حتى 20 جهة، query ≤100 حرف، ≤3 هواتف/بريدات لكل جهة، بلا كتابة |

## الأدلة والنتائج

- `node --test test/agent-google-read.test.js`: **8/8**. يغطي الحدود والتنقية والأخطاء الآمنة والحقول السرية وعملاء Drive/People الوهميين وتسجيل `google_read` وRuntime بلا approvals/outbox وسلسلة Evidence.
- `node --test test/agent-gmail.test.js test/agent-connectors.test.js test/owner-google-commands.test.js`: **28/28**.
- `npm run test:coverage`: **661 إجماليًا، 647 ناجحًا، 0 فشل، 14 skipped**؛ **90.70% أسطر / 75.45% فروع / 86.90% دوال**. ملف `google-read.js` حقق 100% أسطر ودوال في هذا التشغيل.
- تشغيل `npm test` الأول أظهر فشلًا واحدًا فقط في اختبار N/N−1 لأن `2508893…` غائب من الـshallow clone. جُلب الكائن من origin دون تعديل الاختبار، ثم نجح `test/secrets-hub.test.js` **6/6** ونجح تشغيل التغطية الكامل أعلاه.
- كل قراءة Runtime في الاختبار تُنتج سجل أداة وEvidence hash chain؛ لا توجد سجلات outbox أو approvals. هذا دليل محلي/Mock، لا دليل OAuth أو Google حي.

## حدود وقرارات مؤجلة

- لا OAuth تفاعلي ولا قبول حي ولا قراءة أسماء ملفات حقيقية. التفعيل الحي قرار لاحق صغير وصريح ومعزول.
- لا توسعة Sheets/Docs/YouTube/Photos، ولا embeddings أو بحث دلالي، ولا Shell/Git/Computer Use أو ربط Sandbox بـRuntime.
- لا commit/push/PR/merge/نشر/ترحيل ضمن هذه الجلسة حتى الآن. الفرع `arena/d44070e0-phone-google`.

## التالي

مراجعة الفرق والفحوص النهائية وتحديث `NOW.md`. أي تشغيل حي لاحق يحتاج قرار مالك مستقلًا وحساب اختبار/مالك ونطاق قبول منقّحًا؛ لا يُستنتج من هذه النتائج.
