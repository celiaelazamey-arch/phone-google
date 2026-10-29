---
name: continuity-handoff
description: تحديث ملفات الاستمرارية ذات المرجعية الأحادية، والتحقق من تسلسل DECISIONS، وحفظ تاريخ STATE بلا حذف، وإعادة توليد NOW.md حتميًا.
---

# مهارة تحديث الاستمرارية وتوليد `NOW.md` (`continuity-handoff`)

استخدم هذه المهارة عند إغلاق مهمة أو نقطة توقف أو قبل الدفع إلى الفرع، التزامًا بـ[بروتوكول الاستمرارية](../../../docs/continuity/README.md) و[DEC-003](../../../docs/continuity/DECISIONS.md) و[DEC-052](../../../docs/continuity/DECISIONS.md).

## 1. قاعدة المرجع الواحد لكل حقيقة

- **التركيز الحالي والخطوة التالية:** [STATE.md](../../../docs/continuity/STATE.md) (نافذة نشطة مركّزة).
- **التاريخ التراكمي الكامل لـ`STATE`:** [STATE-ARCHIVE-2026-10.md](../../../docs/continuity/STATE-ARCHIVE-2026-10.md) — لا يُحذف ولا يُبتر منه سطر واحد؛ عند الأرشفة الدورية يُنقل النص حرفيًا ببصمة SHA-256 موثّقة.
- **حالة المهام ومعايير القبول:** [BACKLOG.md](../../../docs/continuity/BACKLOG.md) — حدّث الصفوف المتأثرة فقط، ولا تغلق مهمة تنفيذية بمجرد كتابة خطتها.
- **أسباب القرارات وحدودها:** [DECISIONS.md](../../../docs/continuity/DECISIONS.md) — إلحاق فقط؛ تحقق من آخر رقم مسجّل قبل إسناد `DEC-NNN` التالي، ولا تفترض توفّر رقم مسبقًا.
- **سجل الجلسة المؤرَّخ:** أنشئ ملفًا جديدًا باسم فريد تحت `docs/continuity/sessions/` وفق [SESSION_TEMPLATE.md](../../../docs/continuity/SESSION_TEMPLATE.md) يذكر الملفات المتغيرة والفحوص المنفذة فعليًا والعوائق والعمليات الخطرة التي لم تُنفَّذ.

## 2. إعادة توليد `NOW.md` والتحقق من عدم الانحراف

`docs/continuity/NOW.md` ملف **مشتق آليًا** من المراجع أعلاه بلا ساعة حائط وبلا تعديل يدوي:

```sh
npm run now
npm run now:check
npm run check:continuity
```

- إذا مسّ التغيير مسارات التنفيذ (`src/`، `public/`، `scripts/`، `sql/`، `integration/`، `test/`، `e2e/`، `package.json`، `.github/workflows/`)، افحص بوابة النطاق قبل الدفع:

```sh
CELIA_CONTINUITY_BASE="$(git merge-base origin/main HEAD)" npm run check:continuity
```
