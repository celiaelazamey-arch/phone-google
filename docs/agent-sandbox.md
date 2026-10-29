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
- لا egress allowlist بعد، ولا تفعيل لـShell/Git/ملفات المضيف/Computer Use. بدون التفعيل الصريح يبقى `sandbox.exec` هو التعريف الرافض القائم حرفيًا (`irreversible` + `requiresApproval` بلا `execute`).
- لا نشر ولا ترحيل إنتاج ولا ادعاء جاهزية عامة للوكيل أو جودة مزود حي. الربط بالحلقة (B1 أدناه) خلف مفتاح بيئة افتراضيه `off`؛ يلزم قرار مستقل قبل تشغيله في بيئة الإنتاج، مع multi-tenant quotas ومراجعة نشر واختبار بيئة الهدف.

## 6) الربط بالحلقة — B1 (`sandbox.exec` فعلي، 2026-10-29)

- **التفعيل صريح وفاشل-مغلقًا:** `CELIA_AGENT_SANDBOX=exec` يبني المنفذ ويمرره إلى `defaultToolDefinitions({ sandbox })`. الافتراضي `off` يُبقي التعريف الرافض كما كان بايتًا ببايت، وأي قيمة أخرى تُفشل الإقلاع بـ`agent_sandbox_misconfigured`.
- **المحوّل (`src/agent/tools.js`):** عند وجود المنفذ تصبح `sandbox.exec` بخطورة `internalWrite` مع `settledFailures: true` و`timeoutMs: 35000`؛ `execute` يستدعي `sandbox.run({ runId, code })`. أي حالة غير `succeeded` تُرفع بكود السبب الصريح — **لا host fallback أبدًا، ولا يُنفَّذ أي شيء على المضيف**.
- **النتائج artifacts فقط:** المخرجات تُكتب داخل العزل إلى `/workspace/artifacts/` وتعود مبصومة `{id, runId, name, bytes, sha256, uri, expiresAt}`؛ لا stdout في الناتج، و`readArtifact` يتحقق من البصمة والحجم والصلاحية عند القراءة.
- **الفشل المسوّى (`src/agent/runtime.js`):** أداة معلنة `settledFailures` يسجَّل فشلها `failed` قابلًا للقياس (لا `unknown` ولا مصالحة بشرية بلا داعٍ) وتستمر الحلقة؛ المُتحقِّق يحجب أي فشل غير مُستدرك (`verification_blocked`). الأدوات غير المعلنة بلا تغيير حرفي.
- **السياسة:** سقف `workspaceBytes` رُفع إلى 256MiB (الافتراضي 8MiB بلا تغيير)؛ `CELIA_SANDBOX_ARTIFACT_ROOT` و`CELIA_SANDBOX_WORKSPACE_BYTES` و`CELIA_SANDBOX_CPU_SECONDS` و`CELIA_SANDBOX_WALL_MS` قابلة للضبط والقيم خارج الحدود تُفشل بناء السياسة.
- **الإثبات:** `test/agent-sandbox-tool.test.js` — SBX-01..08 بلا شبكة، وSBX-09 تكامل حقيقي خلف `CELIA_SANDBOX_INTEGRATION=1`: مهمة «حلّل CSV واحسب» تمر كاملة (خطة → تنفيذ معزول → تحقق → تسليم) بمنفذ namespaces حقيقي، و`result.json` يُقرأ عبر `readArtifact` وسلسلة الأدلة سليمة.
- **حد موثق:** المنفذ يقبل تشغيلة واحدة لكل `runId` (حجز `wx`)؛ استدعاء ثانٍ في نفس التشغيلة يفشل `sandbox_duplicate_run` — فاشل-مغلقًا، ورفع الحد قرار لاحق. كذلك allowlist أدوات المخطِّط الحي قراءات فقط، فلا يستطيع مزود حي استدعاء `sandbox.exec` قبل قرار حوكمة مستقل (SBX-08).

## 7) مخزن artifacts المواجه للمالك — B2 (`artifact.create` + تنزيل موقّع، 2026-10-29)

- **المسار الكامل:** `sandbox.exec` → `artifact.create` (تقرأ عبر `readArtifact` المتحقق بالبصمة/الحجم/الصلاحية حصرًا) → `src/agent/artifact-store.js` يعيد التحقق من SHA-256 على البايتات المسلّمة قبل أي كتابة، يخزّن محليًا، يسجّل صف `agent_artifacts` (ترحيل `sql/migrations/0006` إضافي + DDL SQLite)، ويبصم `artifact_published` في سلسلة الأدلة.
- **ثلاثة ثوابت فاشلة-مغلقة:** (1) بايت تغيّر بين التصدير والنشر → `artifact_hash_mismatch` ولا يُكتب شيء؛ (2) البصمة يُعاد حسابها عند **كل** تنزيل → العبث بعد التسليم `artifact_tampered` 409 ولا بايت معبوث يصل المالك؛ (3) رابط التنزيل الموقّع HMAC بمهلة صريحة هو التفويض كله — بلا توقيع صالح 401 دون كشف وجود الملف، وبعد المهلة 410.
- **Idempotency في قاعدة البيانات لا الذاكرة:** مفتاح فريد `(run_id, source_artifact_id)` — إعادة النشر بنفس البصمة تعيد نفس الصف (`replayed`)، وببصمة مختلفة تُرفض `artifact_conflict`.
- **الأداة مشروطة:** `artifact.create` (`internalWrite`, `settledFailures`) موجودة فقط حين يتوفر المنفّذ والمخزن معًا؛ بدونهما سطح الأدوات القائم بلا تغيير حرفي (ART-01).
- **الواجهة:** `/agent` يعرض قسم «الملفات الناتجة» بزر تنزيل لكل artifact (الاسم، الحجم، البصمة، أجل الرابط)؛ القائمة خلف توكن `/api/agent/runs/:id/artifacts` وملكية التشغيل نفسها التي تحمي `detail`.
- **الضبط:** `CELIA_ARTIFACT_STORE_ROOT` (افتراضي `.data/agent-artifact-store`)، `CELIA_ARTIFACT_SIGNING_KEY` (غيابه = مفتاح عشوائي لهذا الإقلاع، فالروابط تموت مع إعادة التشغيل عمدًا)، `CELIA_ARTIFACT_URL_TTL_MS` (افتراضي 15 دقيقة؛ خارج 1s..24h يُفشل الإقلاع)؛ مفتاح أقصر من 32 حرفًا → `artifact_signing_key_weak` عند البناء.
- **الإثبات:** `test/agent-artifact-store.test.js` ART-01..08 بلا شبكة (منها ART-08 عبر HTTP حقيقي: تنزيل البايتات بالضبط، 401 بلا توقيع، 409 بعد عبث)، وART-09 خلف `CELIA_SANDBOX_INTEGRATION=1`: عزل namespaces حقيقي → نشر → تنزيل `{"total":5}` بايتًا ببايت وسلسلة الأدلة سليمة.

## 8) قوالب المخرجات — B3 (`template.render`، 2026-10-29)

- **`src/agent/output-templates.js`:** ثلاثة قوالب حتمية معلنة — `markdown_report` (تقرير HTML RTL)، `csv_table` (RFC 4180)، `static_page` (صفحة واحدة). دوال نقية: لا ساعة ولا عشوائية ولا شبكة، فنفس الـspec ينتج نفس البايتات دائمًا؛ كل مدخل يُهرَّب HTML وsubset الـMarkdown مغلق (عناوين/قوائم/عريض/كود — HTML خام لا يمر أبدًا)، والصفحات المولدة بلا أي مورد خارجي.
- **الأداة `template.render`:** مشروطة بمخزن B2 (`internalWrite` + `settledFailures`)؛ التصيير على المضيف دالة نقية — ليس تنفيذ كود ولا يحتاج عزلًا — والنشر عبر نفس مسار B2 المبصوم؛ `sourceArtifactId` مشتق من بصمة المحتوى فإعادة التصيير idempotent بقاعدة البيانات.
- **البوابة الذهبية:** `npm run eval:templates` — 3 مهام تمر الحلقة الحقيقية كاملة (خطة → تصيير → نشر → تحقق → تنزيل موقّع) وتُقارن ببصمات مثبتة حرفيًا في `data/eval/b3-templates/golden.json`؛ انحراف بايت واحد يُفشلها، وTPL-06 يحرسها في CI.

## 9) الخيوط العنكبوتية — قارئ فهرس Celia Google Spider (2026-10-29)

- **`src/agent/spider-reader.js`:** قراءة فقط وصفر شبكة — يفتح `knowledge.sqlite3` الذي يبنيه العنكبوت (`celia-google-spider/`) بوضع read-only ويعيد تنفيذ دلالات Python حرفيًا: تطبيع `text_utils.py` (NFKC، التشكيل، الألف/التاء المربوطة/الألف المقصورة، الأرقام الهندية)، ترتيب `store.search` والدرجة `matched*10+min(freq,90)` والمقتطف (نصف قطر 90) — مثبت بمرآة اختبارية على نفس المخطط (SPD-01/02).
- **أداتان قراءة حتميتان:** `spider.search_knowledge` و`spider.graph_stats` — موجودتان فقط مع `CELIA_AGENT_SPIDER=read` (الافتراضي `off`؛ قيمة أخرى → `agent_spider_misconfigured` عند الإقلاع). مسار الفهرس: `CELIA_SPIDER_DB_PATH` أو `CELIA_SPIDER_DATA_DIR` أو `~/.celia_spider/knowledge.sqlite3`.
- **فاشل-مغلقًا:** فهرس غائب = `spider_index_unavailable` عند الإقلاع — لا أدوات تدّعي شبكة معرفة غير موجودة، ولا «بحثت فلم أجد» بلا فهرس مفتوح. المزامنة نفسها تبقى حصرًا في أدوات العنكبوت الست المستقلة (MCP/stdio) بقرار المالك — هذا القارئ لا يزامن ولا يكتب.
