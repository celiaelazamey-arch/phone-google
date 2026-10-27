# حلقة الوكيل M1 — ما نُفِّذ فعلًا وما لم يُنفَّذ

**التاريخ:** 27 أكتوبر 2026 (محدَّث: طبقة الحوكمة DEC-014) · **المهمة:** AGENT-001 (المرحلة M1) + الجزء الأول من COMP-003
**الحالة:** منفّذ ومختبر محليًا على مخزن SQLite صريح (185 اختبارًا، 31 جديدًا للحوكمة) — **لا يشغّل نموذجًا لغويًا ولا أثرًا خارجيًا**.
**الإصدار:** `0.2.1` بلا تغيير · **مخطط الجداول الخمسة الأساسية:** `schema 1` بلا تغيير.

> لا يجوز وصف النظام بأنه «مثل Manus» بعد. هذه الوثيقة تصف **هيكل الحلقة الدائمة**، لا وكيلًا عامًا: المخطط
> الحالي حتمي (تجريبي)، والأدوات المنفذة قراءة داخلية فقط، والأثر الخارجي مرفوض حتى AGENT-002.

## 1. ما يعمل الآن

| القدرة | التنفيذ | الدليل في الاختبارات |
|---|---|---|
| حلقة Plan → Act → Observe → Deliver | `src/agent/runtime.js` | مهمة واحدة تنفذ 3 أدوات + تسليم (≥6 خطوات مسجلة) |
| حالة دائمة في قاعدة البيانات لا في ذاكرة Node | `src/agent/store.js` على مشغّلين صريحين | إعادة فتح المخزن تستعيد الخطوات واستدعاءات الأدوات |
| لا تكرار بطلب مكرر | قيد فريد `(thread_id, client_message_id)` | الطلب المكرر يعيد نفس التشغيل ولا ينفذ الأداة ثانية |
| استئناف بعد إعادة تشغيل | `claimRun` بقفل زمني + `resumePending()` | التشغيل المقطوع يكمل من آخر خطوة مؤكدة دون إعادة تنفيذها |
| لا إعادة تنفيذ عمياء | استدعاء `started/unknown` → `needs_reconciliation` | انقطاع وسط الأداة لا يستدعيها مرة ثانية إطلاقًا |
| عاملان لا ينفذان التشغيل نفسه | قفل `lease` ذري في UPDATE شرطي | تشغيلان متزامنان = تنفيذ واحد فقط |
| إلغاء | `cancel_requested` + `AbortController` | إلغاء بين خطوتين يوقف المهمة دون أثر |
| ميزانيات | خطوات + تكلفة بالـmicro-USD + زمن أقصى | تجاوز السقف ينتهي بحالة `budget_exhausted` صريحة |
| بوابة مخاطر لكل أداة | `read` / `internal_write` / `external_effect` / `irreversible` | أداتان خارجيتان تُوقفان التشغيل بصف موافقة مسجل قابل للقرار |
| ملكية على كل صف | `owner_id` في الخيوط والتشغيلات وكل قراءة | مالك آخر لا يقرأ ولا يلغي |
| شفافية تشغيل | خطوات مخزنة + بث SSE + عدادات استخدام | `GET /api/agent/runs/:id/events` يبدأ بلقطة ثم أحداثًا |
| عقد هدف لكل تشغيل | `src/agent/goal-contract.js` + `agent_goal_contracts` | العقد بيانات قابلة للفحص (أهداف/معايير/قيود/ميزانية/موعد) ويعرضه تفصيل التشغيل |
| بوابة موافقات قابلة للاستئناف | `agent_approvals` + `POST /runs/:id/approval` (DEC-014) | موافقة تُسجَّل وتُستأنف، ورفض يلغي بلا أثر، واستئناف استدعاء `unknown` مرفوض 409 |
| سجل أدلة مسلسل | `src/agent/evidence.js` + `agent_evidence` | سلسلة بصمات SHA-256؛ العبث أو الحذف يُكشف بالرقم والسبب في الاختبارات |
| مُتحقِّق مستقل | `src/agent/verifier.js` | حكم `PASS`/`BLOCK`/`UNKNOWN` من مكوّن منفصل قبل أي خطوة تسليم |

## 2. التخزين — قرار صريح لا ارتداد صامت

| الوضع | التفعيل | الاستخدام | الرفض |
|---|---|---|---|
| `off` (الافتراضي) | بلا متغيرات | لا شيء؛ المسارات تعيد `503 agent_runtime_disabled` | — |
| `mysql` | `CELIA_AGENT_RUNTIME=mysql` | إنتاج: الجداول تنشئها `npm run migrate -- --apply` فقط | يرفض `pool.isMemory`، ويرفض إن نقص جدول (`agent_schema_missing`) |
| `sqlite` | `CELIA_AGENT_RUNTIME=sqlite` + `CELIA_AGENT_SQLITE_PATH` | محلي/عرض توضيحي دائم في ملف | يرفض `NODE_ENV=production` |

**لا يوجد وضع ذاكرة** لحلقة الوكيل: تشغيل بلا حفظ ليس وكيلًا بل محاكاة.

```bash
# ترحيل MySQL (تجريبي افتراضيًا: dry-run يطبع الخطة دون كتابة)
npm run migrate            # dry-run
npm run migrate -- --apply
npm run migrate -- --status
```

سجل الترحيل `schema_migrations(version, name, checksum, applied_at)` يرفض تغيير ملف مطبَّق سابقًا (drift)، ولا
يحذف ولا يعدّل جدولًا قائمًا، ولا يعمل عند startup. MySQL ينفّذ DDL ضمنيًا، لذلك ملفات الترحيل إضافية
(`IF NOT EXISTS`) وتحتمل إعادة المحاولة؛ الخطأ يوقف التشغيل برسالة صريحة دون rollback وهمي.

## 3. المسارات (مالك فقط — Bearer الحالي)

| المسار | الوظيفة |
|---|---|
| `GET /api/agent/status` | هل الحلقة مفعلة، المخزن، المخطط، السقوف، الأدوات |
| `POST /api/agent/threads` | خيط جديد `{title}` |
| `GET /api/agent/threads` · `GET /api/agent/threads/:id` | الخيوط، الرسائل، التشغيلات |
| `POST /api/agent/threads/:id/runs` | `{message, clientMessageId}` أو ترويسة `Idempotency-Key` → `202` جديد / `200` مكرر |
| `GET /api/agent/runs/:id` | التشغيل + الخطوات + الاستدعاءات + عقد الهدف + الموافقات + الأدلة + حكم المُتحقِّق (بلا أسرار) |
| `GET /api/agent/runs/:id/events` | SSE: `snapshot` ثم `step`/`approval.requested`/`approval.decided`/`verification`/`run.finished` |
| `POST /api/agent/runs/:id/cancel` | طلب إلغاء يُطبَّق بين الخطوات |
| `GET /api/agent/runs/:id/approvals` | قرارات الموافقة المسجلة للتشغيل |
| `POST /api/agent/runs/:id/approval` | قرار المالك `{decision: approved\|rejected, note?}` مع `Idempotency-Key`؛ 409 إن كان التشغيل بلا بوابة أو وجد استدعاء `unknown` |

`clientMessageId` يجب أن يطابق `^[A-Za-z0-9_-]{8,64}$`. خطأ الإدخال `400`، الملكية `404`، والحلقة غير المفعلة `503`.
الواجهة: `/agent` (عربية RTL، أصول محلية، بلا أي مفتاح مزوّد).

## 3.1 طبقة الحوكمة (DEC-014)

| المكوّن | الملف/الجدول | القاعدة الصارمة |
|---|---|---|
| عقد الهدف | `src/agent/goal-contract.js` · `agent_goal_contracts` | كل تشغيل يحمل عقدًا يُبنى حتميًا من حدوده الفعلية؛ معايير النجاح الآلية يقيّمها المُتحقِّق |
| بوابة الموافقات | `agent_approvals` · `runtime.approve()` | قرار idempotent بمفتاح ومرجع ممثل؛ `unknown`/`started` يمنع الاستئناف (`409 reconciliation_required`)؛ الرفض يلغي بلا أثر |
| سجل الأدلة | `src/agent/evidence.js` · `agent_evidence` | إضافي فقط، `prev_hash`+`hash` من SHA-256 وجذر genesis لكل تشغيل؛ العبث يُكشف عند `verifyEvidenceChain` |
| المُتحقِّق المستقل | `src/agent/verifier.js` | منفصل عن المنتِج، بلا كتابة؛ أحكام `PASS`/`BLOCK`/`UNKNOWN`؛ لا خطوة `deliver` بلا `verify` |

تدفق الموافقة: البوابة تُنشئ صفًا `pending` وتوقف التشغيل `waiting_approval` → المالك يقرر عبر المسار →
`approved` يعيد التشغيل إلى `queued` ويستأنف الحلقة (والمخطط التجريبي يسلم نتيجة محدودة تسمي غياب outbox)،
و`rejected` يلغي التشغيل. الموافقة بلا منفذ تنفيذ تنتهي بخطأ صريح `external_connector_unavailable` لا بنجاح وهمي.

## 4. ما لم يُنفَّذ — بصراحة

1. **لا نموذج لغوي:** `planner` الحالي حتمي (خطوات ثابتة حسب الرسالة). واجهة `plan()` جاهزة، لكن ربط مزوّد
   (AI-002) لم يُنفَّذ ولم يُختبر؛ لذلك لا تخطيط حرّ ولا جودة استدلال.
2. **أثر خارجي بلا منفذ:** قرار الموافقة صار مسجلًا وقابلًا للاستئناف، لكن outbox الإرسال وموصلات
   التقويم/WhatsApp/Drive غير مبناة (AGENT-002 المتبقي)؛ لا يُجرى أي اتصال خارجي بعد الموافقة.
3. **لا تنفيذ معزول:** `sandbox.exec` يُرفض دائمًا حتى AGENT-003؛ لا حاوية ولا مخرجات artifacts بعد.
4. **لا تعدد مستخدمين:** الملكية مفروضة على كل صف، لكن الإعداد الحالي لمالك واحد (AGENT-004 لاحقًا).
5. **MySQL:** لا خدمة MySQL في بيئة الجلسة، لذلك اختبارات التطوير على SQLite. اختبار القبول في
   [integration/mysql.integration.mjs](../integration/mysql.integration.mjs) شُغِّل فعليًا على **MySQL 8.4** في
   CI (run `40499146250`، commit `5cfa05d`): الترحيل طُبق مرتين، الحلقة نُفذت، التكرار مُنع، والاستدعاء المنقطع
   أصبح `unknown`. يبقى غير متحقق: تطبيق الترحيل على **قاعدة إنتاج** أو Aiven، وسلوك التشغيل تحت حمل حقيقي.
6. **لا استئناف تلقائي عند الإقلاع:** `resumePending()` موجودة ومختبرة لكنها غير موصولة بمؤقّت أو startup hook؛
   تشغيلها يحتاج قرارًا (تفعيل صريح) كي لا يعيد الخادم تشغيل مهام بلا طلب.

## 5. الفحوص المنفذة

```sh
node --test test/agent-goal-contract.test.js       # 4/4 عقد الهدف
node --test test/agent-approvals.test.js           # 9/9 بوابة الموافقات
node --test test/agent-evidence.test.js            # 6/6 سلسلة الأدلة
node --test test/agent-verifier.test.js            # 8/8 المُتحقِّق المستقل
node --test test/agent-approval-routes.test.js     # 4/4 مسارات HTTP
node --test test/agent-store.test.js               # 6/6
node --test test/agent-runtime.test.js             # 16/16
node --test test/agent-routes.test.js              # 3/3
npm test                                            # 185 اختبارًا (184 أخضر محليًا)
npm run check                                       # 83 ملف JS
npm run release:check                               # 0.2.1 / previous 0.2.0 / schema 1
npm run check:continuity                            # وثائق وروابط بلا دورات
npm run check:secrets                               # ناجح
npm run celia:mcp:verify                            # 12 أداة · storage=memory
npm run build:pages                                 # 8 صفحات ثابتة
npm audit --omit=dev --audit-level=moderate         # 0 ثغرات
```

الإخفاق المحلي الوحيد سببه استنساخ git ضحل بعمق commit واحد يمنع اختبار توافق N/N−1 من قراءة كائن commit
الأساس (`git cat-file`)، وهو عائق بيئة لا عائق كود؛ نفس الاختبار أخضر في CI بتاريخ المستودع الكامل.

## 6. الأثر على العقود

- الجداول الخمسة الأساسية و`database.schema = 1` بلا مساس؛ جداول الوكيل **إضافية** وبوابة سجل ترحيل مستقلة
  (الترحيل `0003_agent-governance.sql` يضيف ثلاثة جداول فقط: `agent_approvals` و`agent_goal_contracts`
  و`agent_evidence`، وكلها `IF NOT EXISTS`).
- الرجوع إلى صورة لا تعرف `/api/agent` يترك الجداول الإضافية غير المستخدمة؛ لا فقد بيانات ولا كسر للمسارات القديمة.
- الجداول الإضافية لا تُنشأ في قاعدة لا يملك مالكها تفويض تشغيل الترحيل عليها.
- كل المسارات الجديدة اختيارية ومعطلة افتراضيًا، وتمرّ عبر مصادقة المالك القائمة؛ عقد المسارات القديمة
  (`GET /runs/:id` وSSE) توسّع بحقول جديدة فقط بلا حذف أو إعادة تسمية.
