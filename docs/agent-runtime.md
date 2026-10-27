# حلقة الوكيل M1 — ما نُفِّذ فعلًا وما لم يُنفَّذ

**التاريخ:** 27 أكتوبر 2026 (محدَّث: outbox الأثر الخارجي DEC-015) · **المهمة:** AGENT-001 (M1) + الحوكمة (DEC-014) + باقي AGENT-002 (الـoutbox وموصل التقويم)
**الحالة:** منفّذ ومختبر محليًا على مخزن SQLite صريح (211 اختبارًا) — **لا يشغّل نموذجًا لغويًا، والأثر الخارجي لا يخرج إلا عبر outbox وبموصل صريح**.
**الإصدار:** `0.2.1` بلا تغيير · **مخطط الجداول الخمسة الأساسية:** `schema 1` بلا تغيير.

> لا يجوز وصف النظام بأنه «مثل Manus» بعد. هذه الوثيقة تصف **هيكل الحلقة الدائمة**، لا وكيلًا عامًا: المخطط
> الحالي حتمي (تجريبي)، وأدوات الحلقة قراءة داخلية فقط، والأثر الخارجي يخرج من **صندوق outbox** واحد وبموصل
> مُفعَّل صراحةً — والافتراضي بلا موصلات فيُرفض الأثر بـ`external_connector_unavailable`.

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
|GET `/api/agent/status` | هل الحلقة مفعلة، المخزن، المخطط، السقوف، الأدوات |
| `GET /api/agent/harness` | فحص المكونات العشرة لـAgent Harness ودورة التنفيذ الـ10 مراحل (DEC-019) |
| `POST /api/agent/threads` | خيط جديد `{title}` |
| `GET /api/agent/threads` · `GET /api/agent/threads/:id` | الخيوط، الرسائل، التشغيلات |
| `POST /api/agent/threads/:id/runs` | `{message, clientMessageId}` أو ترويسة `Idempotency-Key` → `202` جديد / `200` مكرر |
| `GET /api/agent/runs/:id` | التشغيل + الخطة (`plan`) + الخطوات + الاستدعاءات + عقد الهدف + الموافقات + الـoutbox + الأدلة + حكم المُتحقِّق (بلا أسرار) |
| `GET /api/agent/runs/:id/events` | SSE: `snapshot` ثم `step`/`approval.requested`/`approval.decided`/`plan.edited`/`verification`/`run.finished` |
| `POST /api/agent/runs/:id/cancel` | طلب إلغاء يُطبَّق بين الخطوات |
| `GET /api/agent/runs/:id/plan` | عرض الخطة المهيكل (`PLAN_READY`, `WAITING_FOR_APPROVAL`, `EDITED`, `APPROVED`, `REJECTED`, `EXECUTING`) والانتقالات |
| `POST /api/agent/runs/:id/plan` | تعديل الخطة المتوقفة (`{payload, summary?, note?}` مع `Idempotency-Key`): يعيد فحص السياسات ويبقي التشغيل في `waiting_approval` |
| `GET /api/agent/runs/:id/approvals` | قرارات الموافقة المسجلة للتشغيل |
| `GET /api/agent/runs/:id/outbox` | نوايا الأثر الخارجي: الحالة، المحاولات، المرجع الخارجي، رمز الخطأ الآمن |
| `POST /api/agent/runs/:id/approval` | قرار المالك `{decision: approved\|rejected\|edited, payload?, note?}` مع `Idempotency-Key`؛ 409 إن كان التشغيل بلا بوابة أو وجد استدعاء `unknown` |
| `POST /api/agent/runs/:id/reconcile` | مخرج `needs_reconciliation` (DEC-016): `{target: tool_run\|outbox, targetId, outcome: applied\|not_applied, externalRef?, note?, resume?}` مع `Idempotency-Key`؛ لا يستدعي أي موصل |

`clientMessageId` يجب أن يطابق `^[A-Za-z0-9_-]{8,64}$`. خطأ الإدخال `400`، الملكية `404`، والحلقة غير المفعلة `503`.
الواجهة: `/agent` (عربية RTL، أصول محلية، بلا أي مفتاح مزوّد).

## 3.1 طبقة الحوكمة (DEC-014)

| المكوّن | الملف/الجدول | القاعدة الصارمة |
|---|---|---|
| عقد الهدف | `src/agent/goal-contract.js` · `agent_goal_contracts` | كل تشغيل يحمل عقدًا يُبنى حتميًا من حدوده الفعلية؛ معايير النجاح الآلية يقيّمها المُتحقِّق |
| بوابة الموافقات | `agent_approvals` · `runtime.approve()` | قرار idempotent بمفتاح ومرجع ممثل؛ `unknown`/`started` يمنع الاستئناف (`409 reconciliation_required`)؛ الرفض يلغي بلا أثر |
| صندوق الأثر الخارجي | `src/agent/outbox.js` · `agent_outbox` | نية واحدة بمفتاح idempotency قبل القرار؛ ادعاء شرطي واحد؛ `dispatching` لا يُدعى ثانية ويُسوّى `unknown` عند انتهاء المهلة؛ لا إعادة إرسال تلقائية |
| موصل التقويم | `src/agent/connectors.js` · `CELIA_AGENT_CONNECTORS` | الموصل الوحيد الذي يلمس طرفًا ثالثًا؛ `iCalUID` حتمي؛ `failed` فقط عند إثبات عدم الوصول |
| سجل الأدلة | `src/agent/evidence.js` · `agent_evidence` | إضافي فقط، `prev_hash`+`hash` من SHA-256 وجذر genesis لكل تشغيل؛ العبث يُكشف عند `verifyEvidenceChain` |
| المصالحة البشرية | `runtime.reconcile()` · `POST /runs/:id/reconcile` | تُحلّ فقط صفوف `unknown`/`started` (أو `dispatching` بlease منتهٍ) بقرار مالك مسجل في السلسلة؛ لا نوش على نتيجة محسومة، ولا إرسال من هذا المسار |
| المُتحقِّق المستقل | `src/agent/verifier.js` | منفصل عن المنتِج، بلا كتابة؛ أحكام `PASS`/`BLOCK`/`UNKNOWN`؛ لا خطوة `deliver` بلا `verify`؛ فحص `reconciliation_evidence` يمنع تحصيل نتيجة بلا شاهد في السلسلة |

تدفق الموافقة والأثر الخارجي (DEC-015): البوابة تُسجّل نية `pending` في `agent_outbox` **قبل** إنشاء طلب
الموافقة (فيرى المالك الحمولة الدقيقة، بما فيها الوقت المقترح)، ثم يوقف التشغيل `waiting_approval` → المالك يقرر:

- `rejected` → النية تُلغى `cancelled` ويُلغى التشغيل: لا أثر خارجي إطلاقًا.
- `approved` → التشغيل يعود `queued`، وفي أول دورة تصرّف النية عبر `outbox.dispatch` **قبل** سؤال المخطط
  (فلا تبقى موافقة معتمدة بلا تنفيذ): `sent` يُسجّل مرجعًا خارجيًا، و`failed` (رفض مؤكد) يُنهي التشغيل
  `external_effect_failed`، و`unknown` يرسله `needs_reconciliation` ولا يعيد الإرسال.
- بلا موصل مُهيَّأ → `external_connector_unavailable` بلا أي طلب خارجي. لا نجاح وهمي في أي مسار.

### تفعيل موصل التقويم (اختياري وصريح)

```bash
CELIA_AGENT_CONNECTORS=calendar      # الافتراضي none: كل أثر خارجي مرفوض صراحة
CELIA_AGENT_CALENDAR_TIMEZONE=Africa/Cairo   # اختياري
```

يشترط `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` وحسابًا موصولًا بصلاحية `calendar.events`؛ إن غاب أي منها
يفشل الإعداد برمز `agent_connector_unconfigured` بدل تدهور صامت. الموصل لا يضيف نطاقًا ولا سرًا جديدًا.

### الاستعادة عند الإقلاع (اختيارية وصريحة — DEC-018)

```bash
CELIA_AGENT_RESUME_ON_BOOT=true      # الافتراضي false: لا يستأنف الخادم شيئًا من تلقاء نفسه
```

على طبقة مجانية تُقتل العملية عند كل خمول، فالإقلاع حدث روتيني لا استثناء. عند التفعيل تنفّذ العملية الصاعدة —
بعد `listen` مباشرة وفي الخلفية حتى لا تتأخر الجاهزية — خطوتين بالترتيب ولا ثالث لهما:

1. `outbox.recoverStale()`: كل نية بقيت `dispatching` بعقد إيجار منتهٍ تُسوَّى `unknown` **بلا أي إرسال**، لأن
   النتيجة هي بالضبط ما لا نعرفه (DEC-007/DEC-015).
2. `resumePending()`: التشغيلات التي بقيت `queued`/`running` بعقد منتهٍ تُستأنف من آخر خطوة مؤكدة؛ وما فيه
   استدعاء غير محسوم يركن في `needs_reconciliation` لقرار المالك.

النتيجة تظهر في `GET /api/agent/status` تحت `bootRecovery` (`policy: resume|manual` و`last` بمعرفات وحالات
فقط، بلا محتوى). قيمة غير `true/false` خطأ تهيئة صريح (`invalid_agent_boot_recovery`) لا افتراضًا صامتًا،
وفشل الاستعادة يُسجَّل برمزه ولا يُسقط الخادم. الاختبارات في `test/agent-boot-recovery.test.js`.

### المصالحة والإعادة اليدوية (DEC-016)

كان `409 reconciliation_required` طريقًا مسدودًا: لا قرار يُخرجه. الآن:

- **قرار واحد = حقيقة واحدة:** مصالحة `tool_run` تُسوّي أيضًا نية الـoutbox ذات مفتاح الـidempotency نفسه (والعكس)،
  فلا تبقى نية `sent` مع استدعاء `unknown`.
- **لا نوش لنتيجة محسومة:** `sent`/`failed`/`succeeded` تُرفض بـ`409 target_not_reconcilable`؛ و`dispatching`
  بlease حيّ يُرفض كذلك لأن عاملاً آخر قد يكون داخل الطلب.
- **الاستئناف محكوم:** إن بقي أي صف غير محسوم يبقى التشغيل `needs_reconciliation`. وإن لم يبقَ شيء، يُعاد
  التشغيل `queued` ويبدأ. `resume: true` لا يتجاوز قاعدة عدم اليقين أبدًا.
- **إعادة المحاولة (AGENT-002):** نية `failed` تثبت أن شيئًا لم يصل، فتُقبل `not_applied` + `resume: true` فقط،
  ثم تُعاد بنفس الصف والمفتاح؛ ولا تُرسل إلا بقرار مسجل. ومفتاح الموافقة صار مربوطًا بـ**بصمة الحمولة**
  (`approval:<run>:<tool>:<hash12>`) فلا تركب حمولة مختلفة على موافقة سابقة.
- **الإثبات:** كل قرار يُقيَّد كمدخل `reconciliation` بسلسلة SHA-256، ويظهر في `/agent` مع لوحة أزرار صريحة
  («الأثر موجود» / «لم يصل» / «إعادة محاولة»).

## 4. ما لم يُنفَّذ — بصراحة

1. **لا نموذج لغوي:** `planner` الحالي حتمي (خطوات ثابتة حسب الرسالة). واجهة `plan()` جاهزة، لكن ربط مزوّد
   (AI-002) لم يُنفَّذ ولم يُختبر؛ لذلك لا تخطيط حرّ ولا جودة استدلال.
2. **الأثر الخارجي محدود بموصل واحد:** الـoutbox وموصل Google Calendar مبنيان، لكن WhatsApp وDrive لم يُبنَيا.
   المصالحة وإعادة المحاولة اليدوية صارتا مسارًا وواجهة (DEC-016)، لكن `unknown` لا يُعاد تلقائيًا أبدًا ولا
   يوجد حل تلقائي بالتصويت — القرار البشري شرط.
3. **لا تنفيذ معزول:** `sandbox.exec` يُرفض دائمًا حتى AGENT-003؛ لا حاوية ولا مخرجات artifacts بعد.
4. **لا تعدد مستخدمين:** الملكية مفروضة على كل صف، لكن الإعداد الحالي لمالك واحد (AGENT-004 لاحقًا).
5. **MySQL:** لا خدمة MySQL في بيئة الجلسة، لذلك اختبارات التطوير على SQLite. اختبار القبول في
   [integration/mysql.integration.mjs](../integration/mysql.integration.mjs) شُغِّل فعليًا على **MySQL 8.4** في
   CI (run `40499146250`، commit `5cfa05d`): الترحيل طُبق مرتين، الحلقة نُفذت، التكرار مُنع، والاستدعاء المنقطع
   أصبح `unknown`. يبقى غير متحقق: تطبيق الترحيل على **قاعدة إنتاج** أو Aiven، وسلوك التشغيل تحت حمل حقيقي.
6. **الاستئناف عند الإقلاع قرار صريح لا افتراضي:** `recoverOnBoot()` موصولة بنقطتي الدخول (`celia-mcp.js`
   و`server.js`) لكنها لا تعمل إلا بـ`CELIA_AGENT_RESUME_ON_BOOT=true` (DEC-018). الافتراضي `false` يحافظ على
   السلوك السابق (الاستئناف بيد إنسان)، ولا يوجد استئناف دوري بمؤقّت.

## 5. الفحوص المنفذة

```sh
node --test test/agent-goal-contract.test.js       # 4/4 عقد الهدف
node --test test/agent-approvals.test.js           # 9/9 بوابة الموافقات
node --test test/agent-evidence.test.js            # 6/6 سلسلة الأدلة
node --test test/agent-verifier.test.js            # 8/8 المُتحقِّق المستقل
node --test test/agent-approval-routes.test.js     # 4/4 مسارات HTTP
node --test test/agent-reconciliation.test.js      # 14/14 مصالحة وإعادة وملكية
node --test test/agent-reconcile-routes.test.js    # 4/4 مسار المصالحة عبر HTTP
node --test test/agent-store.test.js               # 6/6
node --test test/agent-runtime.test.js             # 16/16
node --test test/agent-routes.test.js              # 3/3
npm test                                            # 229 اختبارًا (228 أخضر محليًا؛ الإخفاق الوحيد بيئي: استنساخ ضحل)
npm run check                                       # 87 ملف JS
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
