# AGENT-003 — Sandbox لكل Run

**الحالة:** Backend محلي منفذ ومختبر على Linux؛ **غير موصول بـ`sandbox.exec` ولا مفعّل في مسار الوكيل أو الإنتاج**.
هذا ليس Docker للنشر، وليس Shell عامًا، وليس تشغيلًا على المضيف مع تسمية مختلفة. أي فشل في إنشاء العزل يوقف التشغيل؛ لا يوجد host fallback.

## 1) المنفذ والسياسة

- `src/agent/sandbox.js` ينشئ جذرًا مؤقتًا مستقلًا لكل `runId` باستخدام `mkdtemp`، ويشغّل `unshare` مع user/mount/network/PID/IPC/UTS namespaces، ثم `chroot` إلى جذر مبني لهذا التشغيل فقط.
- `src/agent/sandbox-entry.sh` هو entrypoint ثابت مملوك للمنفذ. لا تُدرج شيفرة المهمة في أمر shell؛ تُكتب كملف `/task.cjs` في الجذر المقروء فقط ويستدعي Node مسارًا ثابتًا.
- `src/agent/sandbox-policy.js` يثبت `agent-sandbox-v1` ويجعل السياسة deeply frozen. لا توجد مدخلات Run لتغيير الشبكة أو الحدود أو الصلاحيات.
- الهوية داخل العزل `uid=1001/gid=1001` عبر user namespace، مع `no-new-privs` وإسقاط inheritable/ambient/bounding capabilities. لا credentials ولا environment variables موروثة؛ البيئة الممررة هي `HOME=/workspace` و`PATH=/usr/bin` ومتغيرات التشغيل غير السرية فقط.
- الجذر read-only بعد تجهيزه. لا يُربط `/usr/bin` أو `/usr/lib` كدليل عام؛ يكتشف preflight مكتبات Node و`prlimit/setpriv/env` عبر `process.report`/`ldd` ويربط كل binary/library مطلوب منفردًا للقراءة فقط، مع رفض أي dependency خارج جذور النظام المسموحة. يُربط ثنائي Node منفردًا على `/runtime/node`، وworkspace هو `tmpfs` جديد محدود إجماليًا (8 MiB و128 inode افتراضيًا)، وtmpfs صغير لـ`/tmp`، وproc للقراءة فقط، و`null/zero/urandom` فقط. لا `/home` أو `/root` أو `/etc` الحقيقي أو SSH/cloud configuration أو host working directory، ولا `/bin/sh` أو `ls` أو `git` داخل المهمة. مجلد تصدير المضيف لا يُركَّب إلا بعد خروج المهمة وقتل descendants لنسخ المخرجات المصرح بها.
- `maxConcurrent` circuit breaker محلي لكل executor. التجاوز يعيد `blocked/sandbox_concurrency_limit` قبل إنشاء Sandbox ثانٍ.

## 2) الشبكة والحدود

الوضع الوحيد المقبول حاليًا هو `network.mode=deny` مع allowlist فارغة. طلب allowlist غير فارغة يفشل أثناء بناء السياسة لأن **لا يوجد egress proxy/enforcer معتمد في هذه الشريحة**؛ لا نَعِد بقائمة سماح ثم نتجاهلها.

ينشأ network namespace جديد بلا host networking. توجد Probe اختيارية مملوكة للمنفذ، وليست مدخلات JavaScript من المهمة، تكتب نتيجة `connected/code` إلى bind منفصل يصبح read-only قبل بدء المهمة. نتيجة الاتصال الناجح تعتبر `sandbox_network_policy_breach` وتمنع تصدير الـArtifact. نتيجة الرفض تسجل `sandbox_network_attempt` في Evidence.

الموارد الافتراضية:

| الحد | القيمة الافتراضية | الإنفاذ |
|---|---:|---|
| CPU | 2 ثانية | `prlimit --cpu` |
| Address space | 1 GiB | `prlimit --as` |
| V8 heap / semi-space | 64 MiB / 4 MiB | معلمات Node ثابتة |
| العمليات | 16 | `prlimit --nproc` |
| الملفات المفتوحة | 64 | `prlimit --nofile` |
| حجم الملف | 1 MiB | `prlimit --fsize` |
| إجمالي workspace | 8 MiB / 128 inode | tmpfs محدود الحجم والـinodes |
| `/tmp` | 4 MiB / 64 inode | tmpfs محدود |
| Wall time | 2 ثانية | مؤقت خارجي + قتل process group و`--kill-child` |
| التزامن | 2 | عدّاد المنفذ |

النتيجة `timeout/TIMEOUT` عند wall timeout، و`resource_limit/BLOCK` عند حدود الموارد، ولا يُصدَّر Artifact في الحالتين. بعض إصدارات `unshare` تعيد خروجًا 1 مع رسالة `sigprocmask unblock failed` عند SIGXCPU؛ يصنفها المنفذ كحد مورد بدل خروج مهمة طبيعي.

## 3) دورة الإتلاف والـArtifact

1. يُنشأ جذر وworkspace وaudit جديدة لكل Run.
2. ينتظر المنفذ خروج العملية/المهلة قبل جمع المخرجات؛ تُقتل أي descendants متبقية داخل PID namespace، ثم بعد خروج المهمة فقط تُركَّب وجهة تصدير مضيفة وتُنسخ إليها محتويات `/workspace/artifacts` من tmpfs.
3. يُحذف الجذر المؤقت كاملًا في `finally`؛ فشل الإتلاف يحوّل النتيجة إلى `blocked/sandbox_cleanup_failed`.
4. لا يُقبل إلا ملف عادي داخل `/workspace/artifacts`. القيد الثابت **ملف واحد كحد أقصى** ولا تقبل السياسة رفعه؛ symlink أو directory أو اسم غير آمن أو حجم زائد يرفض التصدير.
5. يُنشأ `claim.json` ذريًا لكل `runId` قبل بدء Sandbox؛ أي تشغيل ثانٍ بالمعرف نفسه، حتى من executor آخر بعد restart، يُرفض بـ`sandbox_duplicate_run`. يبقى الـclaim كسجل/حجر replay عند الفشل، لكنه ليس Artifact.
6. ينسخ الملف بعد توقف المهمة إلى `.data/agent-artifacts/<runId>/` (أو `artifactRoot` المحقون في الاختبار)، مع `manifest.json`، واسم داخلي غير قابل للتخمين، وSHA-256 وعدد البايتات و`createdAt/expiresAt`.
7. المرجع العام هو `sandbox-artifact://<id>/<name>`، وليس مسار مضيف خام. `readArtifact()` يعيد فتح الملف عبر manifest ويعيد حساب SHA-256 ويتحقق من الحجم وTTL قبل إرجاع المحتوى.
8. أحداث `sandbox_created` و`sandbox_network_attempt` و`sandbox_artifact` و`sandbox_finished` يمكن كتابتها في `AgentStore.appendEvidence` بنفس `runId/stepId` وسلسلة SHA-256 الموجودة. لا تُخزَّن شيفرة المهمة أو stdout/stderr الخام في أحداث الإنشاء/الإنهاء.

## 4) ما أثبتته الاختبارات

الأمر الحقيقي، وليس Mock:

```bash
npm run test:sandbox
```

يتطلب Linux وuser/mount/network namespaces و`unshare` و`chroot` و`prlimit` و`setpriv`. اختبارات العزل الحقيقية لا تعمل في `npm test` الافتراضي إلا عند `CELIA_SANDBOX_INTEGRATION=1`؛ اختبارات السياسة والفشل المغلق تعمل دائمًا. آخر تشغيل محلي موثق في 2026-10-29: **17/17 ناجحة**، ويشمل:

- إنشاء/إتلاف، UID/GID غير جذري، Capabilities صفرية، root read-only، mounts دقيقة بلا Shell/Git، وعدم قراءة `.env` و`/etc/passwd` ومسارات SSH/cloud.
- رفض اتصال خارجي TEST-NET مع Evidence، ورفض الوصول إلى TCP listener حقيقي على `127.0.0.1` في المضيف مع صفر اتصالات مستلمة.
- wall timeout وCPU وmemory وإجمالي workspace tmpfs وconcurrency، وقتل descendants قبل التصدير، وتنظيف الجذر بعد كل حالة.
- رفض Artifactين وsymlink، وثبات السياسة وعدم استعادة root، ومنع replay عبر executor instances، وربط Artifact بـEvidence chain صالح واختبار TTL.

## 5) الحدود الصريحة وما لم يُفعّل

- **لا syscall audit شامل:** `strace`/`auditctl`/`bpftool` غير متاحة في بيئة التنفيذ الحالية. لذلك Evidence يثبت Probe الشبكة التي يملكها المنفذ، ولا يدّعي تسجيل كل syscall أو كل محاولة اكتشاف شبكي يمكن أن يجريها native code. الإنفاذ default-deny ما زال في network namespace.
- هذا Backend يعتمد على namespaces/chroot/rlimits، وليس MicroVM. لا يثبت مقاومة kernel zero-day أو كل هروب ممكن؛ اختبار Escape هنا أساسي كما هو مطلوب، وليس ضمانًا أمنيًا مطلقًا.
- لا egress allowlist بعد، ولا تفعيل لـShell/Git/ملفات المضيف/Computer Use. بقاء `sandbox.exec` مصنفًا `irreversible` و`requiresApproval` وبوابة الرفض الحالية مقصود حتى قرار ربط مستقل.
- لا نشر ولا ترحيل إنتاج ولا ادعاء جاهزية عامة للوكيل أو جودة مزود حي. يلزم قرار مستقل قبل تشغيل هذا المنفذ من Runtime، مع multi-tenant quotas ومراجعة نشر واختبار بيئة الهدف.
