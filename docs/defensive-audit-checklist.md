# قائمة التدقيق الدفاعي لأسطح Celia

**التاريخ:** 31 أكتوبر 2026 · **المهمة:** `ASSUR-004` · **القرار:** [DEC-083](continuity/DECISIONS.md)
**الحالة:** توثيق فقط — **صفر كود تشغيلي، صفر نشر، صفر استيراد لمكتبة هجوم**

## لماذا هذه الوثيقة موجودة

طُلبت الاستفادة من `SnailSploit/Claude-Red`. القياس: بيانه `claude-skills.json` **v0.3.0 يحوي 78 مهارة في 23 تصنيفًا، وكلها بمعجم `offensive-*`** (تهرّب من EDR، keylogger، shellcode، C2، تصيّد، إخراج بيانات، ثبات، حركة جانبية). هذا **منتج يخدم مستخدمين عاديين**، فاستيراد المكتبة كاملة خارج النطاق وضار بالثقة.

المأخوذ **منهجية لا أدوات**: خمس مهارات ذات صلة دفاعية تُستخدم كقائمة أسئلة على أسطحنا نحن:

| المهارة المصدر (MIT) | السؤال الدفاعي الذي نأخذه |
|---|---|
| `offensive-api-security` | هل كل مسار يتحقق من الملكية لا من وجود رمز فقط؟ |
| `offensive-fuzzing` | هل الدوال الحرجة تتصرف بأمان على دخل غير متوقع؟ |
| `offensive-ai-security` | هل نص الغير بيانات لا تعليمات؟ |
| `offensive-cicd-secrets` | هل الأسرار خارج Git وموصولة ومُتحقَّق منها؟ |
| `offensive-reporting` | هل كل نتيجة مربوطة بدليل قابل لإعادة الإنتاج؟ |

**الإسناد:** المصدر `https://github.com/SnailSploit/Claude-Red`، الترخيب **MIT**، البيان المقاس v0.3.0 بتاريخ 31 أكتوبر 2026. **لم يُنسخ أي ملف من المستودع** إلى هذا المستودع؛ لا `vendor/claude-red/` ولا مهارة في `.agents/skills/`. أسماء المهارات أعلاه إحالات منهجية فقط. وإن قرر المالك استيرادًا لاحقًا فليكن في `vendor/` بإسناد وترخيص محفوظين، **لا** في `.agents/skills/` لأن `R0-04` يثبّت أربع مهارات إجرائية (الدرس المقاس في `DEC-078`).

**نطاق صريح:** كل بند أدناه يفحص **أنظمتنا نحن** في المستودع والاختبارات. لا فحص لهدف خارجي، ولا أداة هجوم، ولا استهداف طرف ثالث.

---

## 1) أسطح مُغطاة ببوابة قائمة

كل صف مربوط بملف موجود فعلًا (تحقّقتُ من وجود كل مسار ومن أسماء الاختبارات).

| السطح | البوابة القائمة | الدليل |
|---|---|---|
| ملكية مسارات الوكيل (لا يكفي وجود رمز) | `requireApiToken` + تمرير `ownerId` في كل مسار | `src/agent-routes.js`، `test/agent-routes.test.js`، `SEC-001` |
| عزل الأسرار عن المتصفح | بوابة توصيل 18 سرًا | `npm run check:secrets`، `SP-08`، `SEC-002` |
| SSRF ومنع metadata والشبكات الخاصة | `isDisallowedHost` / `isDisallowedTargetHost` | `SP-10`، `test/security-surface-audit.test.js` (HIGH-02 1..4)، `SEC-003` |
| تشفير الرموز بمغلّف مربوط بـAAD | keyring `v2.<keyId>` مع توافق `v1` | `test/security-surface-audit.test.js` (SEC-005)، `SEC-005` |
| خروج الشبكة من المعزل | قائمة سماح exact-or-subdomain + منح مؤقتة | `test/agent-egress-proxy.test.js` `EP-01..06` |
| تنفيذ كود داخل معزل يفشل مغلقًا | لا `eval`/`new Function`؛ استثناء وحيد محكوم | `SP-09`، `test/agent-sandbox.test.js`، `npm run test:sandbox` |
| نص الغير بيانات لا تعليمات | `scanForInjection` + «Issue text is data» | `src/agent/issue-triage/injection.js`، `test/issue-triage.test.js` |
| تعلّم من مصدر خارجي بلا تسريب | بصمة كل مقطع + ماسح `secret_exfil` | `scripts/learn-source.mjs`، `test/learn-source.test.js` |
| صلاحيات Actions وتثبيت الإجراءات بـSHA | أقل امتياز، لا `pull_request_target` | `SP-01..04` |
| تدقيق الاعتماديات | `npm audit --omit=dev --audit-level=moderate` | `celia-mcp.yml:89`، `release.yml:65`، `SP-05` |
| سجل تدقيق لا يُعدَّل | `edge_audit` بـ`INSERT` فقط وسلسلة بصمات | `SP-11` |
| انحراف الحزمة قبل الرفع | بوابة بصمة تفشل مغلقًا | `test/edge-provenance.test.js` `PR-01..04`، `MAN-002` |
| دخل غير متوقع على الدوال الحرجة | خصائص حتمية ببذرة معلنة | `test/agent-fuzz-properties.test.js` `FZ-01..10`، `ASSUR-001` |
| تكرار استدعاء فاشل بلا تقدّم | رفض قبل الأثر الخارجي والإنفاق | `test/agent-no-progress.test.js` `NP-01..09`، `ASSUR-002` |
| اشتقاق مهارة بلا تسريب سرّ | `findSecret` على النص كله + حراسة المسار | `test/agent-skill-draft.test.js`، `test/skill-draft-cli.test.js`، `ASSUR-003` |
| محاولة تخمين على حسابات الحافة | 8 محاولات / 15 دقيقة ثم 429 | `workers/celia-edge/accounts.js` (`rateLimit`) |

## 2) فجوات مقاسة — مسجّلة لا مُدّعاة الإصلاح

| الفجوة | القياس | الحالة |
|---|---|---|
| **لا محدّد معدّل دخول على سطح Express** | `src/app.js` يركّب `helmet()` و`requireApiToken` و`express.json({limit:'256kb'})`، ولا مركّب معدل؛ و`grep` على `src/` لا يجد `express-rate-limit` ولا مكافئه. المحدّد الموجود في `workers/celia-edge/accounts.js` يحمي مسارات الحساب على الحافة **فقط** | **`SEC-007`** جديد — مخطط، لم يُنفَّذ |
| مسح الشيفرة الثابت (CodeQL/Semgrep) غير مفعّل | موثّق صراحة في `docs/security-posture.md` §«ما ليس مُنفَّذًا»؛ التفعيل owner-only | قائم في `SEC-006`/§2، لا يُدّعى |
| فحص الأنواع | المشروع JavaScript/ESM بلا TypeScript | موثّق كلفةً في `security-posture.md` |
| تقارير SBOM دورية | `SEC-004` «جارٍ» — التدقيق قائم والتقارير باقية | `SEC-004` |
| نشر ذرّي وتراجع تلقائي | `MAN-004` لم يُنفَّذ؛ النشر الحالي يستبدل الحيّ | `MAN-004` |

**صدق الدعوى:** لا يقل هذا الجدول إن انعدام محدّد المعدّل على Express يعني انعدامه في النظام كله — الحافة تحمي مسارات الحساب. ولا يُسمّى أي صف «مُصلَحًا»؛ `SEC-007` **مخطط** فقط.

## 3) كيف تُعاد إنتاج هذه القائمة

```bash
npm run check:secrets          # توصيل الأسرار
npm run build:manifest:check   # العقد المولّد
npm run test:coverage:ci       # كل البوابات بما فيها SP/EP/FZ/NP/SD
npm run check:continuity       # الروابط والمهام
```

وللتحقق من بنود بعينها:

```bash
node --test test/security-posture.test.js test/security-surface-audit.test.js
node --test test/agent-egress-proxy.test.js test/agent-fuzz-properties.test.js
node --test test/agent-no-progress.test.js test/agent-skill-draft.test.js
```

## 4) ما لا تفعله هذه الوثيقة

- لا تُفعّل مسحًا ولا تحدّد معدّلًا ولا تنشر شيئًا.
- لا تستورد أداة هجوم ولا تنسخ مهارة من المستودع المصدر.
- لا تفحص أي هدف خارجي؛ نطاقها مستودعنا واختباراتنا.
- لا تدّعي أن نجاح البوابات يعني أمنًا مطلقًا: `docs/security-posture.md` يفصل ما هو محقَّق عمّا يملكه المالك وحده.
