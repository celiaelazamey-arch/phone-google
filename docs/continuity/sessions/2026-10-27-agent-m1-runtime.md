# تسليم جلسة — 2026-10-27 — حلقة الوكيل M1 + سجل الترحيل (تنفيذ، بلا ادعاء Manus)

## المهمة والتفويض

- طلب المالك التنفيذي: «بقدر ما تستطيع» — تنفيذ لا إرشاد، وعدم التوقف إلا عند بطاقة/تكلفة، مع تصريح صريح
  بكل جزء لا يمكن تحقيقه مجانًا. الأولوية المعلنة سابقًا: وكيل متكامل على نمط Manus، ونشر مجاني بلا بطاقة.
- معيار القبول المختار: **AGENT-001 / M1** (حلقة دائمة، استئناف، منع تكرار، شفافية) + الجزء الأول من
  **COMP-003** (سجل ترحيل إضافي) — لأنها الوحيدة القابلة للإثبات بلا حساب خارجي ولا بطاقة.
- ما يحتاج موافقة مستقلة ولم يُلمس: نشر دائم في حساب المالك (HOST-003)، ترحيل قاعدة إنتاج، AGENT-002/003/004،
  أي تكلفة أو بطاقة، وأي دفع خارج الفرع المخصص.

## واقع البداية

- الفرع المثبت من البيئة وGit: `arena/bc862105-phone-google` على `c3c42e29e792831d603750f2a0d089c54f3616eb`.
- الإصدار `0.2.1` · `database.schema = 1` · 12 أداة MCP · worktree نظيف بلا عمل مستخدم معلّق.
- `gh pr list`: PR #17–#29 مدموجة. `gh api .../pages`: `has_pages=false`، ومحاولة التفعيل ما زالت
  `403 Resource not accessible by integration` (نقص صلاحية `pages` في الرمز، لا إعداد يمكن تجاوزه من هنا).
- المستودع عام (public)؛ لا أسرار مزوّدين في البيئة؛ لا MySQL ولا Docker محليًا؛ GitHub Actions هو المرجع الحي الوحيد.

## ما تغير فعليًا

**محرك الحلقة والتخزين**

- `src/agent/drivers.js`: مشغّل MySQL (لا ينشئ مخططًا) ومشغّل SQLite دائم (`node:sqlite`) مرفوض في الإنتاج،
  مع تسلسل المعاملات على الاتصال الواحد.
- `src/agent/store.js`: مخزن دائم فوق المشغّلين — خيوط/رسائل/تشغيلات/خطوات/استدعاءات أدوات، قفل lease ذري،
  قيود فريدة للطلب المكرر، ترقيم خطوات داخل معاملة.
- `src/agent/runtime.js`: حلقة Plan→Act→Observe→Deliver، إلغاء، ميزانيات خطوات/تكلفة/زمن، علامة
  `needs_reconciliation` لكل استدعاء غير محسوم، وبث أحداث.
- `src/agent/tools.js` و`src/agent/planner.js`: تصنيف مخاطر إلزامي، أدوات قراءة داخلية، مخططان حتميان
  (تجريبي وللاختبارات) — **لا نموذج لغوي**.
- `src/agent/index.js`: تفعيل صريح `off|mysql|sqlite` بلا ارتداد صامت إلى الذاكرة.
- `scripts/migrate.mjs` + `sql/migrations/0002-agent-runtime.sql`: سجل `schema_migrations` ببصمات SHA-256،
  dry-run افتراضي، رفض drift، وجداول وكيل إضافية لا تمس الخمسة الأساسية.

**الأسطح**

- `src/agent-routes.js` + وصلها في `src/app.js` و`src/celia-mcp.js`: `/api/agent/*` بمصادقة المالك الحالية وSSE.
- `public/agent.html` + `agent.css` + `agent.js`: واجهة عربية RTL، رمز في `sessionStorage`، بث مباشر، إلغاء،
  وتصريح «نسخة ثابتة» على GitHub Pages بدل ادعاء خادم.
- `package.json`: `npm run migrate`.
- `.gitignore`: `.data/` لمخزن SQLite المحلي.

**الاستمرارية**

- `docs/agent-runtime.md` (السطح والحدود)، تحديث `STATE.md`، صفوف `AGENT-001`/`COMP-003` في `BACKLOG.md`،
  `DEC-013`، إضافة في `docs/compatibility-contract.md`، وإشارة في `README.md`. لا تغيير إصدار ولا manifest.

## الفحوص

| الأمر/الفحص | commit/البيئة | النتيجة أو سبب عدم التشغيل |
|---|---|---|
| `node --test test/agent-store.test.js` | worktree | 6/6 ناجحة (تكرار، lease، ترقيم متزامن، بقاء بعد إعادة فتح) |
| `node --test test/agent-runtime.test.js` | worktree | 16/16 (منها استئناف، انقطاع وسط أداة، عاملان، إلغاء، ميزانية، بوابة مخاطر، ملكية) |
| `node --test test/agent-routes.test.js` | worktree | 3/3 (401، 503 عند التعطيل، 202/200 للتكرار، SSE snapshot) |
| `npm test` | worktree | **124/124** (كان 98؛ +26 اختبارًا) |
| `npm run check` | worktree | 68 ملف JS سليم (كان 62) |
| `npm run release:check` | worktree | 0.2.1 / previous 0.2.0 / schema 1 |
| `npm run check:continuity` | worktree | 23 وثيقة · 59 رابطًا · 47 مهمة بلا دورات |
| `npm run check:secrets` | worktree | ناجح |
| `npm run celia:mcp:verify` | ذاكرة صريحة | 12 أداة · `storage=memory` |
| `npm run build:pages` | worktree | 7 صفحات في `dist/` (يشمل `agent.html`) |
| `npm audit --omit=dev --audit-level=moderate` | worktree | 0 ثغرات |
| MySQL حي / `npm run migrate -- --apply` | — | **لم يُنفَّذ محليًا**: لا MySQL في البيئة. أُضيف اختبار CI حقيقي (`integration/mysql.integration.mjs`) يشغّل الترحيل مرتين + حلقة كاملة + انقطاعًا وسط أداة؛ نتيجته من وظيفة `MySQL 8.4` فقط |
| `npm run test:browser` | — | لم يُنفَّذ (Chromium غير مثبت هنا) |
| نشر Pages | run `40497695505` | فشل متوقع: `configure-pages` مع `enablement: true` أعاد `403 Resource not accessible by integration` — رمز GitHub App المتاح للجلسة لا يملك إنشاء Pages. حُوِّل السير عمل إلى تحذير/تخطٍّ صريح بدل فشل أحمر |
| نشر Render | — | **لم يحدث** ولم يُطلب: يتطلب حساب المالك وبطاقة تحقق، وهو مرفوض بشرط المستخدم |

## الحفظ والتسليم

- commit على `arena/bc862105-phone-google` ودفع إليها؛ PR من الفرع نفسه. CI هو المرجع الحي، لا هذا السجل.
- **لم يُنفَّذ:** أي نشر دائم، أي ترحيل قاعدة إنتاج، أي تفعيل Pages من حساب المالك، أي دفع أو release،
  أي كتابة في `main`، وأي طلب بطاقة أو دفع تكلفة.
- لا بيانات عملاء ولا أسرار في هذا السجل أو في الكود الجديد.

## الاستئناف

- عائق HOST-003 كما هو: تفعيل Pages (نقرة مالك) و/أو حساب Render+Aiven (تفويض مالك) — لا يمكن اختصاره من هنا.
- أول فحص آمن في CI: `npm test` داخل الوظيفة القائمة + تشغيل `npm run migrate` (dry-run) على خدمة MySQL 8.4
  في CI للتأكد من أن الملف الإضافي يطبق ثم يعيد القراءة دون drift.
- الخطوة التالية البرمجية: ربط `planner` بمزوّد (AI-002) مع اختبار JSON صارم وميزانية، ثم AGENT-002 (outbox
  وموافقات) قبل أي أداة خارجية.
- تأكيد: حُدِّث `STATE.md` وصفّا `AGENT-001`/`COMP-003` في `BACKLOG.md`، وأُضيف `DEC-013`، ولم يُحذف أي سجل قديم.
