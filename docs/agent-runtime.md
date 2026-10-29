# حلقة الوكيل M1 — ما نُفِّذ فعلًا وما لم يُنفَّذ

**التاريخ:** 27 أكتوبر 2026 (محدَّث: 29 أكتوبر 2026 — WP-2.4 / AI-001 / DEC-054 + شريحة AI-002 المحلية + GOOG-004/GOOG-005) · **المهمة:** AGENT-001 (M1) + الحوكمة + AGENT-002 + GOOG-004/GOOG-005 + ذاكرة الوكيل + تقييم المهمة الذهبية + Planner المزود المحلي
**الحالة:** منفّذ ومختبر محليًا على مخزن SQLite صريح — **المسار الافتراضي لا يشغّل نموذجًا لغويًا؛ توجد شريحة Planner/Tool Use بمزود وهمي فقط، والأثر الخارجي لا يخرج إلا عبر outbox وبموصل صريح؛ الذاكرة حتمية وبلا متجهات، وتقييم AI-001 وهمي بلا شبكة**.
**الإصدار:** `0.2.1` بلا تغيير · **مخطط الجداول الخمسة الأساسية:** `schema 1` بلا تغيير.

> لا يجوز وصف النظام بأنه «مثل Manus» بعد. هذه الوثيقة تصف **هيكل الحلقة الدائمة**، لا وكيلًا عامًا: المخطط
> الافتراضي حتمي (تجريبي)، وأدوات الحلقة قراءة داخلية فقط، والأثر الخارجي يخرج من **صندوق outbox** واحد وبموصل
> مُفعَّل صراحةً — والافتراضي بلا موصلات فيُرفض الأثر بـ`external_connector_unavailable`. عقد Planner المزود المحلي
> موثق في [AI-002](agent-planner-provider.md)، ولا يغيّر هذا المسار الافتراضي أو يثبت نموذجًا حيًا.

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
| ذاكرة طويلة الأمد بلا متجهات (WP-2.3) | `src/agent/memory.js` + `agent_thread_summaries`/`agent_owner_facts`؛ ملخص خيط وحقائق `owner.*` تُشتق حتميًا من الخطوات عند `run.finished`، وفحص `findSecret` قبل حفظ نص التسليم | MEM-01..05: الحتمية، الملكية/404، الحذف النهائي مع `memory_deleted` وسلسلة سليمة، ومسارا HTTP؛ `context_memory` يعلن `summaries:true, facts:true` |
| Planner + Tool Use بمزود قابل للحقن (شريحة AI-002) | `src/agent/planner-provider.js` + `plannerToolAllowlist` في Runtime؛ 2–4 قراءات فقط، JSON مغلق، `tool_result` يعود للمزود، وأحداث قرار/تنفيذ مستقلة | `test/agent-planner-provider.test.js`: حالات عربية/إنجليزية، رفض قبل الأثر، فشل آمن، منع إعادة التخطيط، واستئناف بلا تكرار؛ مزود وهمي فقط |
| Gmail read-only (GOOG-004) | `src/agent/gmail.js` + `google.gmail_read`؛ تسجيل صريح بـ`CELIA_AGENT_CONNECTORS=gmail` أو حقن reader، وإعادة استخدام OAuth المشفر و`gmail.readonly`؛ intent حتمي ضيق في `demo` عند التفعيل | `test/agent-gmail.test.js`: 7/7 Mock/SQLite؛ آخر 1–5 رسائل بmetadata فقط، صفر outbox/approvals، ولا اتصال Google حي |
| Google read-only suite (GOOG-005) | `src/agent/google-read.js` + `google.drive_read`/`google.calendar_read`/`google.contacts_read` مع Gmail؛ تفعيل صريح بـ`google_read`، وعقود Drive/People/Calendar قابلة للحقن | `test/agent-google-read.test.js`: 8/8 Mock/SQLite؛ Drive ≤10، Calendar ≤20 ونافذة ≤31 يومًا، Contacts ≤20؛ صفر outbox/approvals؛ لا اتصال حي. التفاصيل في [حدود 2026](google-readonly-2026.md) |
| تقييم المهمة الذهبية العربية (WP-2.4) | `src/agent/ai-eval*.js` + 120 حالة ثابتة؛ الحلقة والموافقات وoutbox وموصل Calendar والمُتحقّق والأدلة حقيقية، والنقل وهمي بلا شبكة | AI-EVAL-01..08 و`npm run eval:ai`: 120/120، مواعيد مؤهلة 109/109، صفر تكرار/كتابة غير مصرح بها/إعادة عمياء، و`unknown` 2/2 إلى مصالحة |
| شفافية تشغيل | خطوات مخزنة + بث SSE + عدادات استخدام | `GET /api/agent/runs/:id/events` يبدأ بلقطة ثم أحداثًا |
| أزمنة مُثبَتة (WP-1.1، DEC-047) | `src/agent/timing.js`: مدة استدعاء الأداة = `updated_at − created_at` للصفوف التي سوّاها الوقت الحقيقي فقط؛ `null` للجارية/`unknown`/المسوّاة يدويًا؛ p50/p95 بأقرب رتبة | MET-01..05: ساعة وهمية تتقدم 7 ms فكل مدة مضاعف لـ7؛ خطوات `decide`/`deliver` بلا مدة |
| أثر التنفيذ (WP-1.2) | حدث `step` مُثرى: `step` بأزمنته، `settledStep` (خطوة `act` السابقة بمدتها المُثبَتة حين يُحسم استدعاؤها)، `usage`/`limits`، `status`، `now`؛ و`now` في `GET /runs/:id` واللقطة (`queued`/`planning`/`executing_tool`/`waiting_approval`/`needs_reconciliation`/`finished` مع `since`/`elapsedMs`/`totalMs`)؛ الخطوات تحمل `toolRunStatus` | TRC-01..04 (`test/agent-trace.test.js`) + `e2e/agent.spec.js`: الشجرة من `plan.stages`، سطر «الآن» `aria-live`، شريطا الميزانية من `run.usage/limits`، زمن كل استدعاء كما أثبته المخزن؛ لا بيانات في الواجهة ليست في `GET /runs/:id` |
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
(`IF NOT EXISTS`) وتحتمل إعادة المحاولة؛ الخطأ يوقف التشغيل برسالة صريحة دون rollback وهمي. يضيف `0005_agent-memory.sql`
جدولَي الذاكرة فقط؛ لا يُطبَّق على الإنتاج إلا بأمر الترحيل الصريح أعلاه، أما SQLite المحلي فينشئ المخطط المكافئ عند فتح الملف.

## 3. المسارات (مالك فقط — Bearer الحالي)

| المسار | الوظيفة |
|---|---|
|GET `/api/agent/status` | هل الحلقة مفعلة، المخزن، المخطط، السقوف، الأدوات |
| `GET /api/agent/metrics` | المؤشرات الستة + **`durations`** (WP-1.1): `runs{count,p50Ms,p95Ms,maxMs}`، `tools[name]{…}`، `unmeasuredToolRuns` (صفوف مسوّاة بلا مدة مُثبَتة) — من آخر 20 خيطًا × 10 تشغيلات للمالك |
| `GET /api/agent/harness` | فحص المكونات العشرة لـAgent Harness ودورة التنفيذ الـ10 مراحل (DEC-019)؛ مكوّن `context_memory` يعلن `summaries:true, facts:true` |
| `GET /api/agent/memory` | `{summaries, facts}` للمالك فقط، بلا صفوف منتهية افتراضيًا؛ `?threadId=` يقيّد الملخصات، و`?kind=summary\|fact&id=` يعيد عنصرًا واحدًا أو `404` |
| `DELETE /api/agent/memory` | جسم `{kind: summary\|fact, id}` (أو معاملات الاستعلام): حذف نهائي بملكية داخل معاملة مع دليل `memory_deleted`؛ الغائب/مالك آخر `404` |
| `POST /api/agent/threads` | خيط جديد `{title}` |
| `GET /api/agent/threads` · `GET /api/agent/threads/:id` | الخيوط، الرسائل، التشغيلات |
| `POST /api/agent/threads/:id/runs` | `{message, clientMessageId}` أو ترويسة `Idempotency-Key` → `202` جديد / `200` مكرر |
| `GET /api/agent/runs/:id` | التشغيل + الخطة (`plan`) + الخطوات + الاستدعاءات + عقد الهدف + الموافقات + الـoutbox + الأدلة + حكم المُتحقِّق (بلا أسرار) |
| `GET /api/agent/runs/:id/events` | SSE: `snapshot` (= التفاصيل كاملة بما فيها `now`) ثم `step` (مُثرى: `step`، `settledStep`، `usage`، `limits`، `status`، `now`)/`approval.requested`/`approval.decided`/`plan.edited`/`verification`/`run.finished` |
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
| موصلات الأثر الخارجي | `src/agent/connectors.js` · `CELIA_AGENT_CONNECTORS` | Calendar/WhatsApp/Drive فقط عبر outbox وموافقة؛ `iCalUID`/مفاتيح idempotency؛ `failed` فقط عند إثبات عدم الوصول |
| قارئ Gmail | `src/agent/gmail.js` · `google.gmail_read` | قراءة metadata ومقتطف ≤500 حرف عبر OAuth المشفر القائم؛ لا `send()` أو outbox أو body/attachments، ولا يسجل افتراضيًا |
| قرّاء Google الآخرون | `src/agent/google-read.js` · `google_read` | Drive metadata وCalendar events وContacts projections بعقود read مغلقة؛ لا يدخلون registry ذي `send()`، ولا يغيّرون معنى `drive`/`calendar` approval-gated |
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

### تفعيل قارئ Gmail (اختياري وصريح — GOOG-004)

```bash
CELIA_AGENT_CONNECTORS=gmail       # الافتراضي none: لا تسجيل ولا قراءة
# يمكن جمعه مع calendar/whatsapp/drive بالفواصل عند الحاجة
```

يستخدم `google.gmail_read` النطاق القائم `gmail.readonly` و`fetchInboxMessages()` مع منح OAuth المشفر نفسه.
المدخل الوحيد `maxResults` من 1 إلى 5 (الافتراضي 5) و`unreadOnly`؛ لا query حر ولا body أو مرفقات. النتيجة
`id/from/subject/date/snippet/unread` (المقتطف ≤500 حرف)، وتسجل كنتيجة أداة وEvidence hash chain، لا كـoutbox أو أثر خارجي. غياب إعداد
Google أو pool الدائم يفشل الإعداد برمز `agent_connector_unconfigured`. هذه الوثيقة لا تفعّل الحساب الحي؛ الاختبار
الحالي Mock فقط، والتفعيل الفعلي قرار لاحق.

### تفعيل قرّاء Google الأربعة (اختياري وصريح — GOOG-005)

```bash
CELIA_AGENT_CONNECTORS=google_read
```

يسجّل هذا الخيار Gmail وDrive وCalendar وContacts للقراءة فقط، بلا outbox connector ولا scopes جديدة.
Drive يعيد أحدث 1–10 ملفات غير محذوفة بـ`id/name/mimeType/modifiedTime`، وCalendar يقرأ حتى 20 حدثًا في
نافذة صريحة لا تتجاوز 31 يومًا، وContacts يقرأ صفحة أولى محدودة حتى 20 جهة مع فلترة محلية اختيارية.
التفاصيل والعقود وحدود `calendar.events` الحالي موثقة في [Google read-only ضمن حدود 2026](google-readonly-2026.md).
لا يعني التسجيل أن حسابًا حيًا مربوط أو أن أسماء ملفات المالك ظهرت؛ الاختبارات الحالية Mock فقط.

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

## 3.2 ذاكرة الوكيل (WP-2.3 / DEC-053)

- **ما يُحفظ:** عند كل انتقال نهائي إلى `run.finished` يقرأ `runtime` الخطوات الدائمة مرتبةً ويحدّث ملخص الخيط والحقائق
  `owner.last_run_status` و`owner.last_run_steps`، ويضيف `owner.last_tools` و`owner.last_result` عندما توجد أداة/نتيجة.
  الملخص الحالي يصف آخر تشغيل في الخيط؛ ليس نموذجًا لغويًا ولا سجلًا بديلًا عن الخطوات ولا بحثًا دلاليًا.
- **ما لا يُحفظ:** لا رسائل المستخدم الخام ولا حمولات الأدوات ولا embeddings. نص خطوة `deliver` وحده مرشح للحفظ، بعد تسطيحه
  وحدّه وفحصه بـ`findSecret`؛ النص المشتبه باحتوائه سرًا يُحذف من الذاكرة وتُسجَّل عبارة حذف ثابتة بدل نسخه. الفحص دفاع نمطي،
  وليس ضمانًا لاكتشاف كل سر ممكن.
- **الملكية والانتهاء:** كل صف يحمل `owner_id` و`source_run_id` و`created_at` و`expires_at`. كل قراءة مفردة وحذف يشترطان
  المالك، ولا يكشف `404` وجود مورد لمالك آخر. `expires_at` اختياري؛ الصف المنتهي لا يظهر في القراءة الافتراضية.
- **الحذف والدليل:** `DELETE` يزيل الصف نفسه، ثم يلحق بالتشغيل المصدر مدخل `memory_deleted` يحوي النوع والمعرفات وبصمات
  المحتوى فقط، لا الملخص أو قيمة الحقيقة المحذوفة. الحذف والإلحاق معاملة واحدة؛ تكرار حذف الصف نفسه يعيد `404`، وسلسلة
  الأدلة السابقة لا تُعاد كتابتها. تشغيل جديد قد يشتق ذاكرة جديدة من خطواته؛ هذا لا يستعيد الصف المحذوف.
- **الواجهة:** قسم «ما يتذكره الوكيل» في `/agent` يقرأ المسار نفسه بعد الاتصال وبعد `run.finished`، ويعرض مصدر كل عنصر
  وتاريخه وزر «حذف نهائي». لا يحتفظ المتصفح بنسخة بديلة من الذاكرة.

## 4. ما لم يُنفَّذ — بصراحة

1. **لا نموذج حي ولا تفعيل إنتاجي:** `demo-deterministic` ما زال الافتراضي والوحيد الذي يقبله `createAgentHost`.
   أُضيف عقد `planner-provider.js` واختُبر بمزود وهمي داخل الحلقة، مع أدوات قراءة مغلقة و`tool_result` وأدلة مستقلة؛
   هذا يثبت التكامل والحوكمة محليًا فقط، لا تخطيطًا حرًّا أو جودة استدلال. تقييم AI-001 يستخدم مستخرجًا عربيًا حتميًا
   ونقلًا وهميًا، ولا يرفع هذا الحد ولا يثبت جودة Gemini أو تكلفته أو اتصال Calendar الحي. التفاصيل في
   [مستند شريحة AI-002](agent-planner-provider.md).
2. **الأثر الخارجي مشروط بموصل مهيأ صراحة:** موصلات Calendar وWhatsApp وDrive موجودة في الكود وتُربط اختياريًا،
   لكن لا يثبت هذا التغيير أي اتصال إنتاجي حي بها. المصالحة وإعادة المحاولة اليدوية صارتا مسارًا وواجهة (DEC-016)،
   لكن `unknown` لا يُعاد تلقائيًا أبدًا ولا يوجد حل تلقائي بالتصويت — القرار البشري شرط.
3. **التنفيذ المعزول غير موصول بالوكيل:** أُضيف Backend محلي لـAGENT-003 في `src/agent/sandbox.js` مع namespaces وحدود وموارد وArtifact store واختبارات حقيقية (`docs/agent-sandbox.md`)، لكن `sandbox.exec` ما زال `irreversible` ويُرفض من بوابة Runtime؛ لا Shell/Git/Computer Use ولا مسار إنتاجي أو egress allowlist مفعّل.
4. **لا تعدد مستخدمين:** الملكية مفروضة على كل صف، لكن الإعداد الحالي لمالك واحد (AGENT-004 لاحقًا).
5. **MySQL:** لا خدمة MySQL في بيئة الجلسة، لذلك اختبارات التطوير على SQLite. اختبار القبول في
   [integration/mysql.integration.mjs](../integration/mysql.integration.mjs) شُغِّل فعليًا على **MySQL 8.4** في
   CI (run `40593284086`، commit `99b7895` على الفرع `arena/5fccc4e6-phone-google`): الترحيل طُبق مرتين، الحلقة نُفذت،
   التكرار مُنع، الاستدعاء المنقطع أصبح `unknown`، وتعديل الخطة `editPlan` وأتمتة المستندات `DEC-020` وبوابة الفهم
   `DEC-021` تحققت جميعها على MySQL 8.4. قبول `0005` والذاكرة والحذف أُضيف إلى ملف التكامل ويحتاج تشغيلة MySQL جديدة؛
   لم تُنفَّذ تلك التشغيلة في جلسة WP-2.3 المحلية. يبقى غير متحقق: تطبيق الترحيل على **قاعدة إنتاج** أو Aiven، وسلوك التشغيل
   تحت حمل حقيقي.
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
node --test test/agent-harness.test.js             # 5/5 دورة الخطة ومعمارية Agent Harness
node --test test/agent-document-automation.test.js # 7/7 أتمتة المستندات والبيانات (8 حالات فشل/هجوم)
node --test test/agent-comprehension-gate.test.js  # 10/10 بوابة الفهم والشرح المبسّط (CL-01..CL-10)
node --test test/agent-store.test.js               # 6/6
node --test test/agent-runtime.test.js             # 16/16
node --test test/agent-gmail.test.js               # 7/7 Gmail read-only · Mock/SQLite
node --test test/agent-google-read.test.js         # 8/8 Google read-only suite · Mock/SQLite
node --test test/agent-routes.test.js              # 3/3
node --test test/agent-memory.test.js              # MEM-01..04: حتمية/أسرار/ملكية/حذف/انتهاء
node --test test/agent-memory-routes.test.js       # MEM-05: عرض وحذف HTTP وسلسلة الأدلة
node --test test/agent-ai-eval.test.js              # AI-EVAL-01..08: 8/8
node --test test/agent-planner-provider.test.js     # AI-002: 10/10، مزود وهمي وSQLite فقط
npm run eval:ai                                     # 120/120 · PASS · تقرير reports/ai-001.json
npm test                                            # 615/615 محليًا بعد WP-2.4
npm run check                                       # 160 ملف JavaScript بعد WP-2.4
npm run release:check                               # 0.2.1 / previous 0.2.0 / schema 1
npm run check:continuity                            # وثائق وروابط بلا دورات
npm run check:secrets                               # ناجح
npm run celia:mcp:verify                            # 12 أداة · storage=memory
npm run build:pages                                 # 12 صفحة ثابتة في جلسة WP-2.3
npm audit --omit=dev --audit-level=moderate         # 0 ثغرات
```

في بداية الجلسة منع استنساخ git الضحل اختبار توافق N/N−1 من قراءة كائن commit الأساس (`git cat-file`). عولج العائق
بجلب commit الأساس المطلوب محليًا، ثم نجح الاختبار ضمن **607/607**؛ لا يُسجَّل ذلك فشلًا حاليًا ولا بديلًا عن CI الكامل.

## 6. الأثر على العقود

- الجداول الخمسة الأساسية و`database.schema = 1` بلا مساس؛ جداول الوكيل **إضافية** وبوابة سجل ترحيل مستقلة
  (`0003_agent-governance.sql` ثم `0004_agent-outbox.sql` ثم `0005_agent-memory.sql`؛ كلها `IF NOT EXISTS`).
  جدولا الذاكرة الجديدان يرفعان عدد جداول `agent_` إلى 11 بعد الترحيل، ولا يغيّران مخطط التطبيق الأساسي.
- الرجوع إلى صورة لا تعرف `/api/agent` يترك الجداول الإضافية غير المستخدمة؛ لا فقد بيانات ولا كسر للمسارات القديمة.
- الجداول الإضافية لا تُنشأ في قاعدة لا يملك مالكها تفويض تشغيل الترحيل عليها.
- كل المسارات الجديدة اختيارية ومعطلة افتراضيًا، وتمرّ عبر مصادقة المالك القائمة؛ عقد المسارات القديمة
  (`GET /runs/:id` وSSE) توسّع بحقول جديدة فقط بلا حذف أو إعادة تسمية.

## 7. خطة النشر والتكامل (توثيق مستقبلي، لا نشر منفّذ)

راجعت خطة نشر WP-2.3 ووُثّقت في [docs/agent-memory-deployment.md](agent-memory-deployment.md). النقاط الحاكمة:

- الهدف المنفذ هو **Express + MySQL**؛ لا PostgreSQL ولا بديل D1 صامت. Pages واجهة ثابتة ولا تثبت جاهزية API الذاكرة.
- `0005` إضافي وidempotent، لكن DDL في MySQL يثبّت ضمنيًا؛ لا معاملة ذرية متعددة العبارات ولا rollback وهمي. الذرية الموثقة في هذه الحزمة تخص حذف الذاكرة مع دليلها.
- الترتيب المقترح: dry-run وفحص وrestore مثبت → ترحيل staging وقبول MySQL → ترحيل الهدف المأذون → نشر الكود/تفعيل `CELIA_AGENT_RUNTIME=mysql` → قبول API وChromium والأدلة الحية.
- لا يُسمّى ذلك «Zero-Downtime» قبل اختبار النشر، ولا يُفرض أربع حقائق في كل تشغيل؛ حقائق الأدوات والنتيجة مشروطة بوجودها.
- لم يُنفّذ push أو PR أو ترحيل خارجي أو نشر في جلسة التوثيق؛ أي مرحلة مستقبلية تحتاج تفويضها ودليلها المستقلين.
