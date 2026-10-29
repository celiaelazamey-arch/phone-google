# CLAUDE.md — بوابة التوجيه الموحّدة لوكلاء التطوير (R0 2026)

> **قاعدة عدم الازدواج ([DEC-003](docs/continuity/DECISIONS.md) · [DEC-052](docs/continuity/DECISIONS.md)):**
> ملف **[AGENTS.md](AGENTS.md)** هو المرجع الحاكم الوحيد لاتفاقية العمل، والقيود غير القابلة للتفاوض، وبوابة الفهم القابل للشرح (`Comprehension Gate`)، وأوامر التحقق في هذا المستودع. وُضع `CLAUDE.md` كمدخل رقيق للأدوات التي تبحث عنه تلقائيًا حتى تقرأ المرجع نفسه بدل نسخ قواعد قابلة للانحراف.

## ترتيب القراءة الإلزامي عند بدء الجلسة

1. اقرأ **[AGENTS.md](AGENTS.md)** كاملًا والتزم بفرع الجلسة المعيَّن من البيئة فقط.
2. اقرأ **[docs/continuity/NOW.md](docs/continuity/NOW.md)** (ملخص مشتق آليًا عبر `npm run now` — لا يُحرَّر يدويًا).
3. اقرأ **[docs/continuity/STATE.md](docs/continuity/STATE.md)** للتركيز الحالي والخطوة التالية (التاريخ السابق محفوظ حرفيًا بلا حذف في **[docs/continuity/STATE-ARCHIVE-2026-10.md](docs/continuity/STATE-ARCHIVE-2026-10.md)**).
4. راجع **[docs/continuity/BACKLOG.md](docs/continuity/BACKLOG.md)** (مرجع حالات المهام الوحيد) و**[docs/continuity/DECISIONS.md](docs/continuity/DECISIONS.md)** (تحقق من آخر `DEC-NNN` قبل حجز رقم جديد) و**[docs/continuity/README.md](docs/continuity/README.md)**.
5. اقرأ **[docs/agent-2026-execution-plan.md](docs/agent-2026-execution-plan.md)** و**[docs/compatibility-contract.md](docs/compatibility-contract.md)** قبل أي تعديل تنفيذي.

## المهارات الإجرائية الأربع المعتمدة (R0)

- **[session-orient](.agents/skills/session-orient/SKILL.md):** فحص الفرع الحي وسياق الاستمرارية وحالة GitHub الفعلية قبل البدء.
- **[continuity-handoff](.agents/skills/continuity-handoff/SKILL.md):** تحديث `STATE`/`BACKLOG`/`DECISIONS` وسجل الجلسة وإعادة توليد `NOW.md` بلا انحراف.
- **[quality-gates](.agents/skills/quality-gates/SKILL.md):** تشغيل حزمة الفحص والتغطية (`89/71/82`) والأمن وبناء الصفحات.
- **[governed-pr-merge](.agents/skills/governed-pr-merge/SKILL.md):** الدفع لفرع الجلسة فقط، وعدم فتح أو دمج PR إلا بكلمة المالك بعد الفحوص الثلاثة.

## قيد صيانة هذا الملف

لا تنسخ قوائم القيود أو السياسات التفصيلية من `AGENTS.md` إلى `CLAUDE.md`؛ أي تعديل على قواعد العمل يُكتب في `AGENTS.md` أو `docs/continuity/DECISIONS.md` فقط.
