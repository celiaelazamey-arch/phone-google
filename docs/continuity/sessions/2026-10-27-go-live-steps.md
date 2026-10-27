# تسليم جلسة — 2026-10-27 — الخطوات التالية للتشغيل الحقيقي: أركان ببوابات + استعادة عند الإقلاع + قبول حي

> سجل جلسة. الخطة: [docs/go-live-plan.md](../../go-live-plan.md) · المرجع التشغيلي:
> [deploy/free-always-on/README.md](../../../deploy/free-always-on/README.md) · DEC-018.

## المهمة والتفويض

- طلب المستخدم الحرفي: **«فكر في الخطوات التالية للتشغيل الحقيقي المكتمل الاركان بناءً على المعايير التي اتفقنا
  عليها من البداية»** — مرفقًا بملخص جلسة PR #36 وسؤالها المعلّق (دمج #36 أم مراجعة).
- المتطلب المفهوم: ترتيب ما تبقى بين «منجز توثيقيًا/CI» و«يعمل فعلًا على رابط عام» وفق المعايير المتفق عليها
  (بلا بطاقة، تخزين دائم بلا ارتداد، لا إعادة أثر خارجي، مالك واحد، «متحقق» = دليل حي)؛ وتنفيذ ما يمكن إثباته
  من هنا بلا حساب خارجي.
- معرفات BACKLOG: HOST-003 (قبول حي)، AGENT-001 (استئناف عند الإقلاع)، OPS-004 (أداة قياس)، وترتيب
  DATA-001/INT-001/INT-002/AI-001/AI-002/GOV-001/DATA-004 في الخطة دون تغيير حالاتها.
- حدود التفويض: لا دمج/إغلاق PR (#34، #36) بلا طلب صريح، لا حساب ولا بطاقة ولا أسرار ولا نشر ولا ترحيل على
  قاعدة حقيقية.

## واقع البداية

- الفرع الذي أثبتته البيئة: `arena/0220ec0b-phone-google` من `4d4eb85` (= `origin/main` بعد دمج PR #35)، شجرة
  نظيفة. **قرار هيكلي:** دُمج فرع PR #36 (`daf815a`) في هذا الفرع (merge commit `3e9b420`) لأن كل خطوة تعتمد
  على DEC-017 والخطة وقائمة §5؛ لم يُنشأ أي فرع آخر ولم يُدفع إلى غير فرع الجلسة.
- الإصدار `0.2.1` / `schema 1` بلا تغيير. `git fetch --unshallow` نجح فعمل اختبار N/N−1 محليًا.
- حالة GitHub الحية (تاريخ ووقت الفحص 2026-10-27 ~17:50–18:05 UTC):
  - PR #36: `OPEN`، `mergeable: MERGEABLE`، `mergeStateStatus: CLEAN`، الفحوص السبع `SUCCESS` (الخارجي skipped).
  - PR #34: `OPEN`، Revert لـ#33، أُنشئ 14:40:50Z (بعد دمج #33 بـ24 ثانية)، `mergeable: UNKNOWN`.
  - Pages: `GET /repos/celiaelazamey-arch/phone-google/pages` ⇒ `build_type: workflow`، `https_enforced: true`،
    `html_url: https://celiaelazamey-arch.github.io/phone-google/`؛ `pages/builds/latest` ⇒ 404 (لا بناء
    قديم). آخر `pages.yml` على `main` (run `40526270578` على `4d4eb85`): خطوة Configure Pages
    `conclusion=success` بسبب `continue-on-error` لكن خطوة «First-time Pages setup note» نُفِّذت والرفع/النشر
    تخطّيا ⇒ `outcome=failure` حينها. سجل الخطوة نفسه غير قابل للقراءة من هنا (مخزّن خارج النطاق المسموح).
    `gh workflow run pages.yml --ref main` ⇒ `403 Resource not accessible by integration`.
  - عمليات نشر بيئة `github-pages` السابقة (11:47–11:55) نشأت من مفتاح `environment:` في workflow الفرع،
    وخطوتا الرفع/النشر فيها **متخطّاتان** — أي لا نشر فعلي حدث قط.
  - المستودع عام (`private: false`).

## ما تغير فعليًا

- `src/agent/runtime.js`: `recoverOnBoot({ limit, staleLimit })` = `outbox.recoverStale()` ثم `resumePending()`؛
  تقرير بمعرفات وحالات فقط.
- `src/agent/index.js`: `readAgentBootRecovery()` (`CELIA_AGENT_RESUME_ON_BOOT` true/false، افتراضي false، غير
  ذلك خطأ معلن `invalid_agent_boot_recovery`)، `agentHost.recoverOnBoot()` (لا يرمي؛ يسجّل `lastBootRecovery`)،
  `status().bootRecovery = { policy, env, last }`، و`scheduleBootRecovery()` بمؤقّت `unref` وسجل بالرمز فقط.
- `src/celia-mcp.js` و`src/server.js`: استدعاء `scheduleBootRecovery` بعد `listen`/`installShutdown`.
- `scripts/verify-live.mjs` (جديد) + `npm run verify:live`: الفحوص `url`, `reachable`, `wake_latency`, `version`,
  `ready_durable`, `agent_auth_gate`, `agent_status` + قائمة `manual` (4). الرمز من البيئة فقط؛ يرفض كتابة تقرير
  يحويه؛ المضيف فقط؛ رمز خروج 1/2/3.
- `test/agent-boot-recovery.test.js` (جديد، 5) و`test/verify-live.test.js` (جديد، 5)؛ تحديث سماح
  `test/free-hosting-plan.test.js` بالمتغيّر الاختياري الجديد.
- وثائق: `docs/go-live-plan.md` (جديد)، `deploy/free-always-on/README.md` (حالة Pages الجديدة، المتغيّر، §5
  بالأمر، §7)، `docs/agent-runtime.md` (قسم الاستعادة عند الإقلاع وتحديث البند 6)، `.env.example`،
  `CHANGELOG.md`، `README.md`، STATE، BACKLOG (AGENT-001/HOST-003/OPS-004)، DECISIONS (DEC-018).
- قرارات: **DEC-018** جديد. لا استبدال لقرار سابق؛ DEC-017 يبقى.
- بقي اقتراحًا ولم يُنفَّذ: `backup:verify` (DATA-001)، موصل WhatsApp في الـoutbox، AI-001/AI-002، مقاييس
  OPS-001، أي workflow نداء دوري داخل المستودع (cron-job.org هو الموصى به).
- **لم يُغيَّر** `render.yaml` ولا `schema 1` ولا الإصدار ولا أدوات MCP.

## الفحوص

| الأمر/الفحص | commit/البيئة | النتيجة أو سبب عدم التشغيل |
|---|---|---|
| `npm test` | worktree (بعد `--unshallow`) · Node 22.22.3 | **246** اختبارًا · **246** ناجح (منها 10 جديدة؛ اختبار N/N−1 نجح لأن التاريخ كامل) |
| `node --test test/agent-boot-recovery.test.js` | worktree | 5/5 |
| `node --test test/verify-live.test.js` | worktree | 5/5 |
| `node --test test/free-hosting-plan.test.js` | worktree | 4/4 |
| `npm run check` | worktree | 91 ملف JS |
| `npm run release:check` | worktree | 0.2.1 / previous 0.2.0 / schema 1 |
| `npm run check:continuity` | worktree | 29 وثيقة · 70+ رابطًا · 51 مهمة · بلا دورات (أُعيد بعد إضافة هذا السجل) |
| `npm run check:secrets` | worktree | `zeroLeakVerified: true` |
| `CELIA_MCP_DISABLE_MYSQL=true CELIA_DISABLE_OLLAMA=true npm run celia:mcp:verify` | worktree | `selfTest: passed` · 12 أداة · `storage: memory` صريح |
| `npm run build:pages` | worktree | 8 صفحات · 12 أداة |
| `npm audit --omit=dev --audit-level=moderate` | worktree | 0 ثغرات |
| فحص حي: `celia-mcp.js` بـ`CELIA_AGENT_RUNTIME=sqlite` + `CELIA_AGENT_RESUME_ON_BOOT=true` | محلي 127.0.0.1:3123 | سطر السجل «Agent boot recovery: 0 … resumed in 1ms»، و`/api/agent/status` يعيد `bootRecovery.policy=resume, last.performed=true` |
| فحص حي: `verify:live --allow-http` على الخادم أعلاه | محلي | **FAIL كما يجب** (5 pass، 2 fail: `ready_durable` ذاكرة، `agent_status` dialect=sqlite)؛ التقرير بلا الرمز (0 تطابق) |
| `test:mysql` / `test:browser` | — | **لم يُشغَّلا** (لا MySQL ولا Chromium هنا؛ يغطيهما CI للفرع) |
| `verify:live` على رابط حقيقي | — | **لم يُنفَّذ**: لا خدمة منشورة |

## الحفظ والتسليم

- الفرع `arena/0220ec0b-phone-google` فقط (يحوي `daf815a` من فرع #36 مدمجًا)؛ لا دفع إلى غيره. حالة الدفع
  وPR تُذكر في رسالة التسليم.
- لا نشر، لا أسرار، لا بطاقة، لا مساس بأي قاعدة بيانات، لا دمج/إغلاق PR — **لم تُنفَّذ**.
- لا نتيجة خارجية غير معروفة؛ لا إعادة إرسال.

## الاستئناف

- العوائق: قرارات المالك الأربعة في §4 من الخطة؛ حسابات Aiven/Render؛ النداء الدوري؛ تشغيل `verify:live` على
  الرابط العام.
- الخطوة التالية بالضبط: الركن 0 (دمج #36 ثم هذا الفرع، إغلاق #34، التأكد أن `deploy` في `pages.yml` لم تُتخطَّ
  وأن الرابط يفتح) ثم الركن 1 (HOST-003) بالتسلسل المكتوب في STATE؛ أول فحص آمن بعد النشر:
  `npm run verify:live -- --url https://<service> --expect-commit <sha>`.
- تأكيد: حُدِّث STATE وصفوف AGENT-001/HOST-003/OPS-004 وأُضيف DEC-018 وهذا السجل.
