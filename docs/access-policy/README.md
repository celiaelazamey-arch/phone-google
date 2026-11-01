# صلاحيات CeliaOS 2026 — المصفوفة المنفَّذة

> **مُولَّد آليًا** من `src/agent/access-policy.js` (`celiaos-access-policy-2026-v1`). لا تُحرّره يدويًا:
> `npm run access:policy` يعيد توليده، و`npm run access:policy:check` يُفشل CI عند الانحراف.
> الشرح البشري والقائمة التي لا يملكها الوكيل في [الوثيقة المرافقة](../access-policy-2026.md).

**القراءة الأولى:** الصلاحيات **66** موزّعة على 8 نطاقات · **10** منها للمالك وحده لا يبلغها أي مستوى ·
**21** تحتاج موافقة مسجّلة دائمًا · **5** تحكم الحوكمة نفسها · **0** موصولة تشغيليًا.
والشبكة `NETWORK = DENY` افتراضيًا، والوكيل لا يملك حساب المالك: `githubOwner = forbidden`.

## 1. مستويات الوصول الستة

المستويات ليست سلمًا واحدًا يُتصاعد عليه: `admin` لا يفتح البنية التحتية، و`infra_admin` لا يفتح كتابة المستودع،
و`system_operator` لا يفتح أيًّا منهما. العمود الأخير هو ما يبلغه المستوى فعلًا.

| المعرّف | المستوى | باللاتينية | المحور | يبلغ |
|---|---|---|---|---|
| `read` | قراءة | Read | repository | read |
| `write` | كتابة | Write | repository | write · read |
| `execute` | تنفيذ | Execute | execution | execute · read |
| `admin` | إدارة المستودع | Admin | repository | admin · write · read · execute |
| `infra_admin` | إدارة البنية التحتية | Infrastructure Admin | infrastructure | infra_admin · execute · read |
| `system_operator` | مشغّل النظام | System Operator | operation | system_operator · execute · read |

## 2. GitHub — الصلاحيات الأساسية (19)

| المعرّف | الصلاحية | المستوى | الطبقة المطلوبة | الموافقة | للمالك وحده | حوكمة ذاتية | موصولة |
|---|---|---|---|---|---|---|---|
| `github.contents.read` | قراءة المستودع والملفات | read | `read` | غير مطلوبة | — | — | — |
| `github.contents.write` | تعديل وإنشاء الملفات | write | `write` | غير مطلوبة | — | — | — |
| `github.commit.push` | الالتزام والدفع إلى فرع | write | `write` | غير مطلوبة | — | — | — |
| `github.branches.manage` | إنشاء الفروع وحذفها | write | `write` | غير مطلوبة | — | — | — |
| `github.pull_requests.manage` | إدارة طلبات الدمج ومراجعتها | write | `write` | غير مطلوبة | — | — | — |
| `github.pull_requests.merge` | دمج طلبات الدمج | write | `write` | مطلوبة | — | — | — |
| `github.issues.manage` | إدارة المشكلات | write | `write` | غير مطلوبة | — | — | — |
| `github.labels_milestones.manage` | إدارة اللصائق والمراحل | write | `write` | غير مطلوبة | — | — | — |
| `github.releases.manage` | إدارة الإصدارات والوسوم | write | `write` | مطلوبة | — | — | — |
| `github.projects.manage` | إدارة المشاريع | write | `write` | غير مطلوبة | — | — | — |
| `github.discussions.manage` | إدارة المناقشات | write | `write` | غير مطلوبة | — | — | — |
| `github.actions.manage` | إدارة سير العمل وتشغيله | write | `write` | غير مطلوبة | — | — | — |
| `github.workflows.manage` | إدارة ملفات سير العمل | write | `write` | مطلوبة | — | نعم | — |
| `github.secrets_variables.manage` | إدارة الأسرار والمتغيرات | admin | `admin` | غير مطلوبة | نعم | — | — |
| `github.environments.manage` | إدارة البيئات | admin | `admin` | غير مطلوبة | نعم | — | — |
| `github.webhooks.manage` | إدارة الويب هوكس | admin | `admin` | غير مطلوبة | نعم | — | — |
| `github.settings.manage` | إدارة إعدادات المستودع | admin | `admin` | غير مطلوبة | نعم | — | — |
| `github.rulesets.manage` | إدارة حماية الفروع وقواعد الفحص | admin | `admin` | غير مطلوبة | نعم | نعم | — |
| `github.pages.manage` | إدارة النشر عبر Pages | admin | `admin` | غير مطلوبة | نعم | — | — |

## 3. أركان CeliaOS الستة

### الواجهة الأمامية — `frontend`

| المعرّف | الصلاحية | المستوى | الطبقة المطلوبة | الموافقة | للمالك وحده | حوكمة ذاتية | موصولة |
|---|---|---|---|---|---|---|---|
| `frontend.code.write` | إنشاء HTML وCSS وJavaScript وتعديلها | write | `write` | غير مطلوبة | — | — | — |
| `frontend.dashboard.write` | تطوير لوحة التحكم | write | `write` | غير مطلوبة | — | — | — |
| `frontend.design.write` | إدارة التصميم ورموز الألوان | write | `write` | غير مطلوبة | — | — | — |
| `frontend.rtl.write` | ضبط الاتجاه RTL وإتاحة الوصول | write | `write` | غير مطلوبة | — | — | — |
| `frontend.pages.execute` | اختبار الصفحات والاستجابة | execute | `execute` | غير مطلوبة | — | — | — |

### النواة والمنطق — `core`

| المعرّف | الصلاحية | المستوى | الطبقة المطلوبة | الموافقة | للمالك وحده | حوكمة ذاتية | موصولة |
|---|---|---|---|---|---|---|---|
| `core.kernel.write` | إدارة Kernel Manager | write | `write` | غير مطلوبة | — | — | — |
| `core.event_bus.write` | إدارة ناقل الأحداث | write | `write` | غير مطلوبة | — | — | — |
| `core.tool_registry.write` | إدارة سجل الأدوات | write | `write` | غير مطلوبة | — | — | — |
| `core.workflow_engine.write` | إدارة محرّك سير العمل | write | `write` | غير مطلوبة | — | — | — |
| `core.agent_runtime.write` | تطوير وقت تشغيل الوكيل | write | `write` | غير مطلوبة | — | — | — |
| `core.model_router.write` | إدارة موجّه النماذج | write | `write` | غير مطلوبة | — | — | — |

### الذكاء الاصطناعي والوكلاء — `ai`

| المعرّف | الصلاحية | المستوى | الطبقة المطلوبة | الموافقة | للمالك وحده | حوكمة ذاتية | موصولة |
|---|---|---|---|---|---|---|---|
| `ai.planner.write` | إدارة المخطِّط | write | `write` | غير مطلوبة | — | — | — |
| `ai.executor.write` | إدارة المنفّذ | write | `write` | غير مطلوبة | — | — | — |
| `ai.critic.write` | إدارة الناقد والمتحقِّق | write | `write` | غير مطلوبة | — | — | — |
| `ai.memory.write` | إدارة الذاكرة والسياق | write | `write` | غير مطلوبة | — | — | — |
| `ai.tools.write` | إدارة الأدوات والوكلاء | write | `write` | غير مطلوبة | — | — | — |
| `ai.browser_adapter.write` | إدارة محوّل المتصفح | write | `system_operator` | مطلوبة | — | — | — |
| `ai.computer_adapter.write` | إدارة محوّل Computer Use | write | `system_operator` | مطلوبة | — | — | — |

### البيانات والذاكرة — `data`

| المعرّف | الصلاحية | المستوى | الطبقة المطلوبة | الموافقة | للمالك وحده | حوكمة ذاتية | موصولة |
|---|---|---|---|---|---|---|---|
| `data.store.write` | إدارة SQLite وD1 | write | `write` | غير مطلوبة | — | — | — |
| `data.schema.write` | إدارة المخطط والهجرات | write | `infra_admin` | مطلوبة | — | — | — |
| `data.memory.write` | إدارة محرّك الذاكرة | write | `write` | غير مطلوبة | — | — | — |
| `data.evidence.write` | إدارة مخزن الأدلة | write | `write` | غير مطلوبة | — | — | — |
| `data.backup.write` | النسخ الاحتياطي والاستعادة | write | `infra_admin` | مطلوبة | — | — | — |
| `data.knowledge.write` | إدارة المعرفة وRAG | write | `write` | غير مطلوبة | — | — | — |

### الأمان والحوكمة — `security`

| المعرّف | الصلاحية | المستوى | الطبقة المطلوبة | الموافقة | للمالك وحده | حوكمة ذاتية | موصولة |
|---|---|---|---|---|---|---|---|
| `security.policy.write` | محرّك السياسة | admin | `admin` | مطلوبة | — | نعم | — |
| `security.approval.write` | بوابة الموافقة | admin | `admin` | مطلوبة | — | نعم | — |
| `security.sandbox.write` | العزل التنفيذي | admin | `admin` | مطلوبة | — | نعم | — |
| `security.evidence.write` | التحقق من الأدلة | write | `write` | غير مطلوبة | — | — | — |
| `security.audit.read` | سجلات التدقيق | read | `read` | غير مطلوبة | — | — | — |
| `security.identity.write` | إدارة الصلاحيات والهويات | admin | `admin` | غير مطلوبة | نعم | — | — |

### البنية التحتية والنشر — `infrastructure`

| المعرّف | الصلاحية | المستوى | الطبقة المطلوبة | الموافقة | للمالك وحده | حوكمة ذاتية | موصولة |
|---|---|---|---|---|---|---|---|
| `infra.ci.write` | التكامل والنشر المستمر | admin | `admin` | مطلوبة | — | — | — |
| `infra.pages.write` | GitHub Pages | admin | `admin` | مطلوبة | — | — | — |
| `infra.workers.write` | Cloudflare Workers | write | `infra_admin` | مطلوبة | — | — | — |
| `infra.d1.write` | قاعدة D1 | write | `infra_admin` | مطلوبة | — | — | — |
| `infra.render.write` | خدمات Render | write | `infra_admin` | مطلوبة | — | — | — |
| `infra.monitoring.read` | مراقبة الخدمات والنشر | read | `read` | غير مطلوبة | — | — | — |

## 4. الخدمات الخارجية (11)

GitHub Admin لا يمنح شيئًا هنا؛ كل صفٍّ يقف على اعتماده الخاص.

| المعرّف | الصلاحية | المستوى | الطبقة المطلوبة | الموافقة | للمالك وحده | حوكمة ذاتية | موصولة |
|---|---|---|---|---|---|---|---|
| `service.github.admin` | GitHub — إدارة المستودع | admin | `admin` | غير مطلوبة | نعم | — | — |
| `service.cloudflare.scoped` | Cloudflare — Workers وD1 وفق نطاق المشروع | write | `infra_admin` | مطلوبة | — | — | — |
| `service.render.scoped` | Render — الخدمات والنشر | write | `infra_admin` | مطلوبة | — | — | — |
| `service.whatsapp.meta` | WhatsApp Business — التكامل | admin | `admin` | غير مطلوبة | نعم | — | — |
| `service.google_ai.keys` | Google AI — مفاتيح النماذج | admin | `admin` | غير مطلوبة | نعم | — | — |
| `service.ollama.local` | Ollama — النماذج المحلية | execute | `execute` | غير مطلوبة | — | — | — |
| `service.mcp.registry` | MCP — إدارة الأدوات وتسجيلها | write | `write` | مطلوبة | — | — | — |
| `service.browser` | المتصفح — إجراءات مصرّح بها | write | `system_operator` | مطلوبة | — | — | — |
| `service.computer_use` | Computer Use — تحكم بموافقة المستخدم | write | `system_operator` | مطلوبة | — | — | — |
| `service.database` | قاعدة البيانات — البيانات والمخططات | write | `infra_admin` | مطلوبة | — | — | — |
| `service.monitoring` | المراقبة — السجلات وحالة الخدمات | read | `read` | غير مطلوبة | — | — | — |

## 5. القيود التي لا تُرفع بأي صلاحية

| المعرّف | القيد | باللاتينية | الدليل في الكود |
|---|---|---|---|
| `network_default_deny` | الشبكة ممنوعة افتراضيًا | NETWORK = DENY by default | `src/agent/sandbox-policy.js` |
| `human_approval` | موافقة بشرية قبل العمليات الحساسة والخارجية | Human approval before sensitive and external effects | `src/agent/harness.js` |
| `payload_fingerprint` | الموافقة مربوطة ببصمة الحمولة | Approval bound to the payload fingerprint | `src/agent/harness.js` |
| `evidence_chain` | أدلة بسلسلة SHA-256 | SHA-256 evidence chain | `src/agent/evidence.js` |
| `independent_verify` | تحقق مستقل PASS / BLOCK / UNKNOWN | Independent verifier verdict | `src/agent/verifier.js` |
| `no_secrets` | لا كشف للأسرار ولا تسجيلها | No secret in arguments or logs | `src/agent/tools.js` |
| `kill_switch` | إيقاف الوكيل فورًا | Immediate stop | `src/agent/runtime.js` |
| `no_self_policy` | لا تعديل لسياسات الأمان دون موافقة | No self-modification of security policy | `src/agent/access-policy.js` |

## 6. دورة الإدارة العشرية — والخريطة إلى مراحل الحزام

هذه **ليست** مراحل حزام جديدة. أسماء المراحل العشر تبقى كما هي في `HARNESS_LIFECYCLE_STAGES`،
والاختبار يرفض أي اسم لا يطابقها. الخطوة الثامنة خارج الحزام بقصد.

| # | الخطوة | مرحلة الحزام | القيد |
|---|---|---|---|
| 1 | فهم المشروع | `Goal` | عقد الهدف قبل أي خطوة |
| 2 | تحليل المشكلة | `Plan` | الخطة بحالتها المسجّلة |
| 3 | تخطيط التغيير | `Plan` | المراجعة والتعديل قبل التنفيذ |
| 4 | كتابة الكود | `Sandbox Execute` | داخل التنفيذ المعزول |
| 5 | تشغيل الاختبارات | `Sandbox Execute` | الفشل يُسمّى لا يُستهلك |
| 6 | التحقق من الأدلة | `Independently Verify` | حكم مستقل لا تقييم ذاتي |
| 7 | طلب الموافقة | `Approval` | مربوطة ببصمة الحمولة |
| 8 | الدمج والنشر | خارج الحزام | بوابات المستودع وكلمة المالك |
| 9 | مراقبة النتائج | `Observe` | ما جرى فعلًا لا ما قيل |
| 10 | تحديث المعرفة | `Update State` | بعد حفظ الدليل |

## 7. ما يملكه المالك وحده

- **إبقاء تجاوز القاعدة على دور المالك وحده، وحذف أداة «مسؤول المستودع» التي لا تُنتج نتائج** — `docs/continuity/STATE.md`
- **إدخال أسرار المنصات (Meta، مفاتيح النماذج، رموز النشر) — لا تُمنح للوكيل أبدًا** — `src/secrets-hub.js`
- **إنشاء البيئات وحمايتها واعتماد المراجعين** — `.github/workflows/release.yml`
- **كلمة الدمج والدفع: لا دمج ولا نشر ولا إصدار بغيرها** — `docs/continuity/STATE.md`
