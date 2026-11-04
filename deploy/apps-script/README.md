# Celia Apps Script — مصدر المزامنة (GOOG-006)

هذا المجلد هو **مصدر المستودع** لمشروع Google Apps Script. الغرض الحالي
**مزامنة آمنة فقط** — لا سلوك Sheets/Gmail ولا نداءات خارجية بعد
(`celiaAppsScriptHealth()` في `Code.gs` و`oauthScopes: []`).

التدفق الكامل والأوامر حرفيًا في [docs/apps-script-sync.md](../../docs/apps-script-sync.md):

```sh
npx @google/clasp login                          # بحسابك، مرة واحدة
cp -r deploy/apps-script ~/celia-apps && cd ~/celia-apps
npx @google/clasp clone <SCRIPT_ID>              # الجزء الطويل بعد /projects/
cd /path/to/phone-google
npm run apps-script:sync -- --pull               # يعرض الفرق، لا يطبّق
npm run apps-script:sync -- --pull --accept      # بعد مراجعة الفرق فقط
```

- `.clasp.json` الحقيقي **لا يُسلَّم إلى Git** (يحمل معرّف مشروعك) — انظر `.clasp.json.example`.
- `--push` مرفوض من أداة المزامنة: الرفع إلى Google قرار مالك مستقل.
