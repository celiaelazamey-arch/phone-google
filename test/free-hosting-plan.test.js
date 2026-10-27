import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Contract between the free always-on plan and the thing that actually deploys it.
 *
 * A plan document that drifts from `render.yaml` is worse than no document: the owner
 * follows the prose while the provider uses the YAML. These tests fail on drift in
 * either direction and on any promise the free tier cannot keep.
 */

const root = path.resolve(import.meta.dirname, '..');
const PLAN = 'deploy/free-always-on/README.md';

/** Keys that decide whether the documented path runs at all. */
const FREE_PATH_KEYS = [
  'NODE_ENV',
  'PORT',
  'CELIA_MCP_HOST',
  'CELIA_MCP_PORT',
  'CELIA_MCP_API_TOKEN',
  'TOKEN_ENCRYPTION_KEY',
  'CELIA_MCP_DISABLE_MYSQL',
  'CELIA_ENABLE_INTEGRATIONS',
  'CELIA_DB_INITIALIZE',
  'CELIA_DEPLOYMENT_ROOT',
  'MYSQL_HOST',
  'MYSQL_PORT',
  'MYSQL_DATABASE',
  'MYSQL_USER',
  'MYSQL_PASSWORD',
  'MYSQL_SSL_CA_BASE64'
];

async function readPlan() {
  return readFile(path.join(root, PLAN), 'utf8');
}

async function readBlueprint() {
  return readFile(path.join(root, 'render.yaml'), 'utf8');
}

function blueprintKeys(yaml) {
  return new Set([...yaml.matchAll(/^\s+- key: ['"]?([A-Z0-9_]+)['"]?\s*$/gm)].map((match) => match[1]));
}

test('خطة التشغيل المجاني تذكر كل متغيّر يحكم المسار الحر، وكل ما تذكره موجود في render.yaml', async () => {
  const plan = await readPlan();
  const keys = blueprintKeys(await readBlueprint());
  for (const key of FREE_PATH_KEYS) {
    assert.ok(keys.has(key), `${key} يجب أن يبقى في render.yaml`);
    assert.match(plan, new RegExp(`\\b${key}\\b`), `${key} مذكور في render.yaml ويجب أن يشرحه المستند`);
  }
  // Anything the document names must be a real key, so it cannot invent configuration.
  const mentioned = new Set(plan.match(/\b(?:CELIA|MYSQL|TOKEN|GOOGLE|WHATSAPP|APP)_[A-Z0-9_]+\b/g) || []);
  const invented = [...mentioned].filter((name) => !keys.has(name) && !['CELIA_REAL_SERVICE_URL', 'CELIA_AGENT_RUNTIME', 'CELIA_AGENT_SQLITE_PATH', 'CELIA_AGENT_RESUME_ON_BOOT'].includes(name));
  assert.deepEqual(invented, [], 'المستند لا يخترع متغيّرات غير موجودة في التصميم');
});

test('الخطة تصرّح بأن التشغيل الدائم المجاني غير مضمون ولا تبيع وعدًا لا يمكن الوفاء به', async () => {
  const plan = await readPlan();
  assert.match(plan, /غير مضمون/);
  assert.match(plan, /750/);
  assert.match(plan, /لا SLA/);
  // The honest arithmetic must stay: 750 hours cannot cover two services.
  assert.match(plan, /خدمة `web` واحدة فقط|خدمة واحدة فقط/);
  // A free tier that sleeps must never be described as an unqualified 24/7 guarantee.
  assert.doesNotMatch(plan, /مضمون 24\/7|تشغيل 24\/7 مضمون/);
});

test('الخطة تحيل إلى التصميم الواحد ولا تنشئ نسخة ثانية تنحرف عنه', async () => {
  const plan = await readPlan();
  assert.match(plan, /`render\.yaml`/, 'يجب أن تحيل إلى ملف الجذر');
  await assert.rejects(
    () => readFile(path.join(root, 'deploy/free-always-on/render.yaml'), 'utf8'),
    'لا تُكرَّر نسخة ثانية من التصميم في deploy/'
  );
});

test('الخطة لا تدّعي تنفيذًا: الحالة غير متحققة وتطلب التحقق من المالك', async () => {
  const plan = await readPlan();
  assert.match(plan, /not-verified/);
  assert.match(plan, /لم يحدث|لم يُنفَّذ/);
  assert.match(plan, /\[ \]/, 'قائمة القبول قابلة للتأشير لا خبرًا مسبقًا');
});
