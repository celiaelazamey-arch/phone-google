# 2026-10-29 — AGENT-003 Sandbox Backend

## ما نُفّذ

- أُضيف `src/agent/sandbox.js` و`src/agent/sandbox-entry.sh` و`src/agent/sandbox-policy.js`: إنشاء وإتلاف جذر مؤقت لكل Run، user/mount/net/PID/IPC/UTS namespaces، chroot، UID/GID=1001، mounts منفردة للـNode/bootstrap libraries بلا `/usr/bin` العام أو Shell/Git، root read-only، workspace tmpfs بحد إجمالي، بيئة بلا أسرار موروثة، وحدود موارد وتزامن.
- الشبكة `default-deny` فقط؛ تُرفض allowlist غير فارغة حتى يوجد enforcer خارجي. Probe الشبكة مملوكة للمنفذ وتسجل Evidence، ولا تُدّعى تغطية syscall audit الشاملة.
- أُضيف Artifact store تحت `.data/agent-artifacts/<runId>/` مع claim ذري يمنع replay بعد restart، وmanifest وSHA-256 وTTL ومرجع غير مسار مضيف، وأحداث `sandbox_created/network_attempt/artifact/finished` في سلسلة Evidence.
- بقي `sandbox.exec` مرفوضًا وComputer Use غير موصول؛ لم تُفعّل Shell أو Git أو ملفات المضيف.

## الدليل

- `npm run test:sandbox`: **17/17** على Linux الفعلي، لا Mock. شمل Escape وقراءة `.env` و`/etc/passwd` وSSH/cloud paths، خدمة TCP داخلية حقيقية على المضيف، CPU/memory/إجمالي workspace/wall/concurrency، ثبات السياسة، إتلاف الجذر، وArtifact/Evidence.
- `npm run check`: ناجح، 164 ملف JavaScript.
- عُدّل SP-09 ليستثني فقط `src/agent/sandbox.js` من منع spawn، مع فحص أن العزل وdefault-deny موجودان؛ أي spawn خارج هذا الملف ما زال فشلًا.

## حدود لم تُغلق

- لا syscall audit شامل (`strace`/`auditctl`/`bpftool` غير متاحة)، ولا MicroVM، ولا egress allowlist، ولا ربط Runtime أو نشر أو quotas متعددة المستخدمين.
- لا دليل على مقاومة kernel zero-day أو كل هروب؛ الاختبار الحالي Escape أساسي كما هو محدد.
- لا تشغيل حي لـGemini أو Calendar/WhatsApp، ولا ادعاء جاهزية إنتاجية.

## التالي

قرار مستقل قبل ربط المنفذ بـ`Runtime` أو فتح `sandbox.exec`: مراجعة أمنية وبيئة هدف، ثم egress/quotas إن لزما. لا انتقال إلى Shell/Git/الملفات العامة تلقائيًا بسبب نجاح هذا الـBackend.
