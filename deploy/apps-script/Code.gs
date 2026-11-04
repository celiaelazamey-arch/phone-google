/**
 * Celia Apps Script — نقطة بداية المزامنة فقط (GOOG-006).
 *
 * النطاق المتعمد الآن: صفر سلوك خارجي. لا Sheets ولا Gmail ولا أي نداء شبكة،
 * و`oauthScopes` فارغة في `appsscript.json` حتى يقرر المالك غرضًا حقيقيًا
 * ويُضاف كقرار مستقل مع نطاقاته الدنيا.
 */
var CELIA_APPS_SCRIPT_VERSION = '1';

function celiaAppsScriptHealth() {
  return {
    name: 'celia-apps-script',
    version: CELIA_APPS_SCRIPT_VERSION,
    externalCalls: false,
    scopes: []
  };
}
