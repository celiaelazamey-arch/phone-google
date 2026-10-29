# 2026-10-29 — GOOG-004: موصل Gmail للقراءة فقط

## النطاق والقرار

- اختار المالك مسار **connector**: أداة قراءة داخل Runtime، لا تنفيذ OAuth جديد ولا تفعيل إنتاجي تلقائي.
- أُضيف `src/agent/gmail.js` بعقد `createGmailReadConnector` وأداة `google.gmail_read`. لا يوجد `send()` ولا دخول إلى outbox؛ الأداة `risk=read` ولا تطلب موافقة كتابة.
- أُعيد استخدام `fetchInboxMessages()` و`GOOGLE_SCOPES` الحاليين في `src/google.js`، بما فيه `gmail.readonly` وتخزين OAuth المشفر. لم تُضف `credentials.json` أو رموز إلى الكود أو الأدلة، ولم يُوسّع أي scope.
- التسجيل صريح فقط عبر `CELIA_AGENT_CONNECTORS=gmail` أو حقن reader في الاختبارات. الوضع الافتراضي `none` لا يسجل الأداة. المخطط الحتمي `demo` يدعم intent ضيقًا لعبارات Gmail الصريحة عند تفعيل reader، ويعرض الموضوع/المرسل من النتيجة؛ ليس مخططًا لغويًا حرًا.

## سلوك الأداة

- المدخل المغلق: `maxResults` صحيح من 1 إلى 5 (الافتراضي 5)، و`unreadOnly` منطقي اختياري. أي query أو حقل secret أو نوع/حد غير صالح يُرفض قبل النقل.
- المخرج: `{provider, readOnly, count, messages[]}`؛ كل رسالة تحمل `id/from/subject/date/snippet/unread`، مع snippet منقّح ومحدود إلى 500 حرف. لا body أو attachments أو حمولة Gmail خام في عقد الأداة.
- النقل يحقن `fetchInboxMessages({pool, config, userId, signal})` ولا يرى العقد أسرار OAuth. أخطاء المزود تتحول إلى رموز آمنة مثل `google_not_connected` و`gmail_read_failed` بلا رسالة token-bearing.

## الدليل المحلي

- `node --test test/agent-gmail.test.js`: **7/7**. يشمل آخر خمس رسائل عبر Mock، تنقية metadata، رفض الحدود والحقول السرية قبل النقل، أخطاء آمنة، وتشغيل Runtime على SQLite مع Evidence chain وصفر outbox/approvals.
- الفحص المشترك بعد تثبيت الاعتماديات من lockfile: **56/56** لملفات Gmail وRuntime وConnectors والموافقات ومسارات الوكيل وأوامر Google.
- `npm run test:sandbox`: **17/17** على Linux الفعلي، بما فيها claims المانعة لإعادة التشغيل عبر executors. هذه نتيجة AGENT-003 مستقلة، وليست دليلًا على Gmail أو على الجاهزية الإنتاجية.
- `npm run test:coverage`: **653 إجماليًا، 639 ناجحًا، 0 فشل، 14 skipped**؛ التغطية **90.61% أسطر / 75.42% فروع / 86.73% دوال**. نجح `npm run check` على 165 ملف JavaScript، و`check:continuity` على 78 وثيقة/279 رابطًا/76 مهمة، و`check:secrets` بلا تسريب، و`git diff --check`.
- لم يُستخدم Google حقيقي ولم تُطلب أو تُطبع أي credentials أو access/refresh tokens.

## حدود لم تُغلق

- لا اتصال Gmail حي، ولا اختبار OAuth تفاعلي، ولا ادعاء أن الحساب مربوط أو أن الرسائل الحقيقية قُرئت. التفعيل الحي قرار لاحق صريح ويحتاج بيئة المالك ومراجعة مستقلة.
- لا إرسال أو تعديل أو حذف أو تنزيل مرفقات، ولا أدوات Shell/Git/Computer Use، ولا ربط Sandbox بـRuntime بسبب هذه الشريحة.
- `createAgentHost` ما زال يقبل المخطط الحتمي `demo` فقط؛ وجود الأداة لا يعني مخططًا لغويًا حرًا أو فهمًا تلقائيًا للبريد.

## التالي

قرار مستقل قبل أي تشغيل حي: حساب اختبار/المالك، منح `gmail.readonly` القائم، وفحص قراءة محدود بمعرّفات رسائل منقّحة وتقرير لا يحتوي أسرارًا. لا يُستنتج ذلك من نجاح Mock.
