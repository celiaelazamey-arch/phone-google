# Google read-only ضمن حدود 2026 — GOOG-005

**التاريخ:** 29 أكتوبر 2026 · **الحالة:** تنفيذ محلي/Mock فقط؛ لا اتصال Google حي ولا تفعيل إنتاجي.

هذه الشريحة تستكمل قراءة Gmail وDrive وCalendar وContacts داخل Agent Runtime، ولا توسّع النطاق إلى Sheets أو Docs أو YouTube أو Photos، ولا تفعّل كل خدمات Google. «2026» هنا تاريخ مراجعة وحدود تنفيذ، وليس شهادة توافق حية من Google.

## التفعيل الصريح

```bash
CELIA_AGENT_RUNTIME=sqlite                 # أو mysql بعد تطبيق الترحيل المناسب
CELIA_AGENT_CONNECTORS=google_read
```

- `none` هو الافتراضي، ولا يسجّل أيًا من قرّاء Google.
- `google_read` يسجّل `google.gmail_read` و`google.drive_read` و`google.calendar_read` و`google.contacts_read` فقط. لا ينشئ موصل outbox، ولا يفعّل `calendar` أو `drive` بمعناهما الحالي للكتابة/التصدير.
- يلزم إعداد Google OAuth القائم وpool دائم للـgrant المشفر. غيابهما يفشل الإعداد برمز `agent_connector_unconfigured`؛ لا يوجد fallback إلى credentials ملفية أو اتصال مجهول.
- `gmail` ما زال متاحًا لتفعيل Gmail وحده. جمع `google_read` مع `calendar` أو `drive` أو `whatsapp` قرار منفصل صريح، ويُبقي آثار تلك الموصلات تحت الموافقة.

## العقود والحدود

| الأداة | القراءة المسموحة | سقف الإخراج والمدخل | ما لا تفعله |
|---|---|---|---|
| `google.gmail_read` | أحدث رسائل Inbox: `id/from/subject/date/snippet/unread` | 1–5 رسائل؛ snippet ≤500 حرف؛ `unreadOnly` منطقي | لا body/attachments ولا إرسال/تعديل/حذف |
| `google.drive_read` | `files.list` لأحدث الملفات غير المحذوفة، مرتبة بـ`modifiedTime desc` | 1–10 ملفات؛ `id/name/mimeType/modifiedTime` فقط | لا محتوى/تنزيل/رفع/حذف/تصدير |
| `google.calendar_read` | `events.list` على primary ضمن `timeMin/timeMax` صريحين | حتى 20 حدثًا؛ نافذة ≤31 يومًا؛ start/end منقّحان | لا إنشاء/تعديل/حذف موعد |
| `google.contacts_read` | `people.connections.list` للصفحة الأولى، مع فلترة محلية اختيارية | حتى 20 جهة؛ query ≤100 حرف؛ ≤3 هواتف و≤3 بريدات لكل جهة | لا إضافة/تعديل/حذف ولا pagination غير محدود |

المدخلات مغلقة، والحقول السرية والمعطيات غير المعلنة تُرفض قبل النقل. النتائج تُسقَط منها الحقول الخام الإضافية وتُسجّل عبر عقد الأداة وسلسلة Evidence المعتادة. القراءة `risk=read` ولا تحتاج approval ولا تُنشئ outbox؛ هذا لا يجعل بيانات Google عامة، فالمسارات تبقى مالك-فقط.

## مراجعة النطاقات الحالية

لم يتغير `GOOGLE_SCOPES`: `openid` و`email` و`gmail.readonly` و`drive.readonly` و`calendar.events` و`contacts.readonly`. أُضيفت إعادة استخدام `fetchDriveFiles()` و`fetchGoogleContacts()` و`listAgendaEvents()` و`fetchInboxMessages()` مع OAuth المشفر نفسه، ولم تُضف `drive` الكاملة أو `spreadsheets` أو `documents` أو `calendar` الكاملة أو أي scope جديد.

**حد صريح:** `calendar.events` أوسع من قراءة فقط على مستوى منح OAuth. قيد «read-only» في هذه الشريحة هو قيد الكود والموصل (`events.list` فقط)، وليس ادعاءً بأن المنح أصبح least-privilege. تغيير النطاق أو إعادة منحه يحتاج قرارًا وتجربة OAuth مستقلة، ولم يُنفّذ هنا.

## المخطط والفصل عن الكتابة

المخطط الافتراضي ما زال `demo` الحتمي، لا مخططًا لغويًا حرًا. عند تفعيل القرّاء يتعرف على عبارات قراءة ضيقة، ويستعمل زمن التشغيل لبناء نافذة Calendar من سبعة أيام. نية القراءة تمنع السقوط اللاحق في نية إنشاء Calendar أو تصدير Drive؛ طلبات الإنشاء/التصدير الصريحة تبقى في مسارها القديم approval-gated. الاستعلام النصي العام لجهات الاتصال متاح في عقد الأداة؛ المخطط الحتمي لا يخمن استعلامًا من نص غير منظم، ويستخدم صفحة محدودة أو نصًا بين علامتي اقتباس فقط.

## الدليل المحلي

- `node --test test/agent-google-read.test.js`: **8/8**؛ يشمل Mock للأدوات الثلاث الجديدة، وحدود النتائج، ومنع الحقول السرية، وأخطاء آمنة، وحقن عملاء Drive/People، وتسجيل `google_read`، وتشغيل Runtime لثلاث قراءات بلا approvals/outbox.
- `node --test test/agent-gmail.test.js test/agent-connectors.test.js test/owner-google-commands.test.js`: **28/28** بعد إضافة المسار، بما فيها توافق Gmail وCalendar الحاليين.
- `npm run test:coverage`: **647 ناجحًا / 0 فشل / 14 skipped من 661**؛ التغطية **90.70% أسطر / 75.45% فروع / 86.90% دوال**. جلب commit الأساس التاريخي `2508893…` كان لازمًا لاختبار N/N−1 في الـshallow clone، ولم يُغيَّر الاختبار أو قاعدة التوافق.
- لم يُستخدم Google حقيقي، ولم تُطلب أو تُطبع `credentials.json` أو access/refresh tokens. نجاح Mock/SQLite لا يثبت ظهور أسماء ملفات حساب المالك ولا جودة اتصال حي.

## ما لم يُنفّذ

لا OAuth تفاعلي، ولا قراءة حساب حقيقي، ولا Sheets/Docs/YouTube/Photos، ولا embeddings أو بحث دلالي، ولا Shell/Git/Computer Use أو ربط Sandbox بـRuntime، ولا نشر أو ترحيل أو PR/دمج ضمن هذه الشريحة. أي قبول حي لاحق يجب أن يكون صغيرًا وصريحًا ومعزولًا، بحساب ونطاقات ومراجعة مالك منفصلة.
