---
name: quality-gates
description: تشغيل بوابات الفحص والتغطية والأمن والصفحات الثابتة وفصل الدليل المحلي عن الدليل الحي قبل التسليم.
---

# مهارة بوابات الجودة والتحقق (`quality-gates`)

نفّذ البوابات المناسبة للأثر الفعلي قبل أي التزام نهائي أو تسليم، التزامًا بـ[AGENTS.md](../../../AGENTS.md) و[DEC-039](../../../docs/continuity/DECISIONS.md) و[DEC-043](../../../docs/continuity/DECISIONS.md) و[DEC-045](../../../docs/continuity/DECISIONS.md).

## 1. حزمة الفحص الأساسية بلا شبكة خارجية

```sh
npm ci --no-audit --no-fund
npm run check
npm run release:check
npm run check:secrets
npm run now:check
npm run check:continuity
npm run copilot:diagram:check
npm run computer:permissions:check
GITHUB_ACTIONS=true npm run test:coverage:ci
CELIA_MCP_DISABLE_MYSQL=true CELIA_DISABLE_OLLAMA=true npm run celia:mcp:verify
npm run build:pages
npm audit --omit=dev --audit-level=moderate
```

## 2. فحوص إضافية حسب المسار المتأثر

- **عند تعديل `public/` أو `e2e/`:** شغّل `npm run test:browser` وتأكد من خلوّ السمات من انتهاكات التباين في axe واحترام `prefers-reduced-motion` وعرض `320px`.
- **عند تعديل `celia-google-spider/`:** شغّل اختبارات الوحدة داخل المجلد بلا بيانات اعتماد حية (`python3 -m unittest discover -s tests -q`).
- **عند تعديل `src/` أو `workers/`:** تأكد من بقاء صفر استدعاءات تنفيذ ديناميكي (`eval`، `new Function`، `child_process`، `vm`، `spawn`) وفق `test/security-posture.test.js` (`SP-09`).

## 3. صدق الإبلاغ عن النتائج

- لا تخلط بين نجاح الفحص المحلي ونجاح CI على GitHub أو التحقق الحي (`npm run verify:live` / `npm run verify:edge`).
- كل رقم أداء أو تغطية يُسجَّل بثلاثيته أو بمعرّف التشغيلة والـcommit، ولا يُنشر رقم غير مقاس في [docs/service-reality.md](../../../docs/service-reality.md).
