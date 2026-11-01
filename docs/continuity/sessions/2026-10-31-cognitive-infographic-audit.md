# 2026-10-31 — DOC-003 / DEC-081: تدقيق ادعاءات إنفوجرافيك «البنية الإدراكية 2026»

**الفرع:** `arena/9dceca86-phone-google` · **الناتج:** [docs/agent-cognitive-architecture-audit.md](../../agent-cognitive-architecture-audit.md) · **الوضع:** توثيق فقط، صفر تغيير في وقت التشغيل.

## السؤال
صورتان تصفان CeliaOS كـ«نظام إدراكي متكامل»: سبع وظائف، حزام من **تسع** مراحل، إدراك خارجي عبر **Browser / Playwright / MCP**، `NETWORK = DENY`، وفصل بين الموجود والمقترح والفجوات. أيّ من هذه المعلومات يقف خلفه كود؟

## كيف قِيس
1. قراءة الوحدات المرجعية: `src/agent/{harness,verifier,sandbox-policy,sandbox,tools,memory,planner,model-router,index}.js`، `src/agent/web-tools.js`، `src/agent/spider-reader.js`، `docs/{agent-sandbox,agent-egress,agent-web-gaps}.md`، `celia-google-spider/README.md`، `package.json`.
2. **مسبار تشغيل** لا قراءة فقط: بُني host فعلي (مخزن SQLite مؤقت + مخطط `demo` + موصلات تقويم وهمية) ثم `runtime.harness()` طُبع كما يصف نفسه.
3. أحجام اللغات بـ`git ls-files | xargs wc -l`.

## النتيجة: 36 ادعاءً — 18 ✅ · 9 🟡 · 9 ❌
- **10 مراحل لا 9**، و`Policy Check` و`Approval` مرحلتان (`harness.js:20-31`)؛ المفقود من الصورة: `Observe`، `Persist Evidence`، `Update State`.
- **لا Browser ولا Playwright ولا MCP كمصدر إدراك:** Playwright في `devDependencies`، والـMCP اتجاهه معكوس (Celia تُصدِّر أدوات، العنكبوت يخدم Claude Desktop)، و`web.search` مؤجّلة بقرار مالك.
- **Sandbox مبني ومختبر لكنه غير مفعّل:** `isolatedContainerAvailable=false` و`CELIA_AGENT_SANDBOX=off` افتراضيًا، والوثيقة تصرّح بذلك.
- **التعلم غير منفّذ:** لا حلقة تعلّم؛ التقييم يقيس ولا يغيّر السياسة، وتحديث المعرفة يدوي.
- **الوكيل مطفأ افتراضيًا:** `CELIA_AGENT_RUNTIME=off`، ولا إعداد في المستودع يفعّله.
- **صحيح:** `NETWORK=DENY` مفروض بالكود، الموافقة البشرية وسلسلة الأدلة والتحقق المستقل موجودة ومختبرة، والملاحظات الأربع في الإنفوجرافيك مطابقة للواقع، وJavaScript فعلًا الجزء الأكبر.

## عيب جانبي مكتشف
`docs/celiaos-architecture-map.html` ما زالت تصنّف `model_router` «مقترحًا (A4)» وهو منفّذ ومختبر الآن — الخريطة أقدم من الكود وتحتاج تحديثًا لاحقًا (لم تُعدَّل في هذه الجلسة).

## الحدود
لا تغيير في أي ملف تشغيل ولا في الإنفوجرافيك نفسه (الصور خارج المستودع)؛ التصحيحات مكتوبة كنص جاهز للاستبدال في §8 من التقرير.
