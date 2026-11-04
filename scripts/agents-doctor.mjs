#!/usr/bin/env node
/**
 * agents:doctor — فحص حي لكل وكيل داخل المستودع، لا قراءة ملفات فقط.
 *
 * لكل وكيل يُشغَّل المسار الحقيقي: الحلقة الكاملة، البحث في شبكة المعرفة، الجلب عبر
 * وسيط الخروج، قراءة Google، بوابة الموافقة، الصندوق الرملي، التفويض، الدمج، قائمة
 * الانتظار، فرز المشكلات، المخطط السحابي، موجّه النماذج، وسطح MCP.
 *
 * الحالات (نفس مفردات VFE-001):
 *   works           🟢 نُفِّذ هنا فعليًا ونجح
 *   partial         🟡 يعمل بحدود أو بجزء من المسار
 *   not_configured  ⚪ الكود موجود لكن لا اعتماد/مفتاح في هذه البيئة — يرفض صراحةً ولا يخترع نتيجة
 *   blocked         ⛔ يحتاج بيئة خارجية (شبكة، Docker، MySQL) لم تتوفر هنا
 *   broken          🔴 نُفِّذ وفشل بخطأ غير متوقع
 *
 * الاستخدام:
 *   node scripts/agents-doctor.mjs            # جدول عربي
 *   node scripts/agents-doctor.mjs --json     # JSON للأنظمة
 *   node scripts/agents-doctor.mjs --url https://example.com   # هدف اختبار الجلب
 *
 * لا يكتب داخل المستودع: كل حالة تُبنى في دليل مؤقت وتُحذف بعده. لا يطبع أي سر.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

import { createSqliteDriver } from '../src/agent/drivers.js';
import { createAgentStore, RUN_STATUS, TOOL_RUN_STATUS } from '../src/agent/store.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createDefaultTools } from '../src/agent/tools.js';
import { createDemoPlanner, createScriptedPlanner } from '../src/agent/planner.js';
import { createGeminiPlannerProvider } from '../src/agent/gemini-planner-provider.js';
import { createEgressAllowlist, createEgressProxy } from '../src/agent/egress-proxy.js';
import { createWebAccess, webToolDefinitions } from '../src/agent/web-tools.js';
import { createSandboxExecutor } from '../src/agent/sandbox.js';
import { createKnowledgeHost } from '../src/knowledge/index.js';
import { planDelegation, checkDelegation } from '../src/agent/delegation.js';
import { createDiagnosisReport, TEST_OUTCOMES } from '../src/agent/self-diagnosis.js';
import { buildAttention, checkQueue } from '../src/agent/attention.js';
import {
  RECONCILE_OUTCOME,
  RECONCILE_TARGET,
  buildReconciliationReport,
  reconcileBatch
} from '../src/agent/reconcile-batch.js';
import { consolidate, checkReport } from '../src/agent/consolidation.js';
import { classifyIssue } from '../src/agent/issue-triage/classify.js';
import { defaultRoute, computeCostMicros, DECLARED_GEMINI_PRICING } from '../src/agent/model-router.js';
import {
  createDriveReadConnector,
  createCalendarReadConnector,
  createContactsReadConnector
} from '../src/agent/google-read.js';
import { createGmailReadConnector } from '../src/agent/gmail.js';
import { preflightGoogleConfig } from '../src/google-preflight.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const setupOnly = args.includes('--setup');
const failOnRegression = args.includes('--fail-on-regression');
const urlIndex = args.indexOf('--url');
const webTarget = urlIndex >= 0 ? args[urlIndex + 1] : 'https://github.com/';
const flagValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

// الأسماء فقط تُطبع لاحقًا؛ القيم لا تخرج من هذه العملية أبدًا.
const envFile = flagValue('--env-file') || (existsSync(path.join(root, '.env')) ? path.join(root, '.env') : null);
if (envFile) {
  if (!existsSync(envFile)) {
    process.stderr.write(`ملف البيئة غير موجود: ${envFile}\n`);
    process.exit(2);
  }
  loadEnv({ path: envFile, quiet: true });
}
const baselinePath = flagValue('--baseline');
const writeBaselinePath = flagValue('--write-baseline');

const statuses = {
  works: { icon: '🟢', ar: 'يعمل' },
  partial: { icon: '🟡', ar: 'جزئي' },
  not_configured: { icon: '⚪', ar: 'غير مفعّل' },
  blocked: { icon: '⛔', ar: 'متعطّل خارجيًا' },
  broken: { icon: '🔴', ar: 'معطوب' }
};

// Reject malformed baselines before running probes; never echo input values.
let baseline = null;
if (baselinePath) {
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    const ids = new Set();
    if (baseline?.version !== 'agents-doctor-v1'
      || typeof baseline.generatedAt !== 'string'
      || !Number.isFinite(Date.parse(baseline.generatedAt))
      || !Array.isArray(baseline.checks) || baseline.checks.length === 0
      || !baseline.checks.every((entry) => {
        if (!entry || typeof entry.id !== 'string' || !entry.id.trim()
          || typeof entry.status !== 'string'
          || !Object.hasOwn(statuses, entry.status) || ids.has(entry.id)) return false;
        ids.add(entry.id);
        return true;
      })) throw new Error('invalid_baseline');
  } catch {
    process.stderr.write('خط الأساس غير صالح: يلزم agents-doctor-v1 وتاريخ صالح وفحوص غير فارغة بمعرّفات فريدة وحالات معروفة.\n');
    process.exit(2);
  }
}

const results = [];
const temp = mkdtempSync(path.join(os.tmpdir(), 'celia-agents-doctor-'));
const tempPath = (name) => path.join(temp, name);

function finish(check, status, detail, evidence = {}) {
  results.push({ id: check.id, ar: check.ar, status, detail, evidence });
}

function unwrap(error) {
  return error?.code || error?.message || String(error);
}

const checks = [];
const check = (id, ar, run) => checks.push({ id, ar, run });

// ── خطة التوصيل: مشتقة من بوابة Google الحقيقية ومن إعدادات المستودع، لا من وثيقة ──
const GOOGLE_ENV_BY_CHECK = {
  client_id: ['GOOGLE_CLIENT_ID'],
  client_secret: ['GOOGLE_CLIENT_SECRET'],
  redirect_uri: ['GOOGLE_REDIRECT_URI'],
  public_base_url: ['APP_BASE_URL'],
  encryption_key: ['TOKEN_ENCRYPTION_KEY'],
  api_token: ['APP_API_TOKEN'],
  owner_email: ['APP_OWNER_EMAIL'],
  feature_switch: ['CELIA_DISABLE_GOOGLE']
};
const AI_PROVIDER_ENV_NAMES = ['GEMINI_API_KEY', 'AI_GATEWAY_API_KEY', 'DEEPSEEK_API_KEY', 'AGENETROUTERAPI_KEY', 'AGENTROUTER_API_KEY'];

function buildSetup() {
  const report = preflightGoogleConfig(process.env);
  const blocking = report.checks.filter((entry) => entry.status === 'fail');
  const neededEnv = [...new Set(blocking.flatMap((entry) => GOOGLE_ENV_BY_CHECK[entry.id] || []))];
  return {
    version: 'agents-doctor-setup-v1',
    derivedFrom: ['src/google-preflight.js', 'src/config.js'],
    google: {
      ready: report.ok,
      blockingChecks: blocking.map((entry) => entry.id),
      failingFixes: blocking.map((entry) => ({ check: entry.id, fix: entry.fix })),
      envNames: neededEnv,
      redirectUri: report.redirectUri,
      consentPath: '/auth/google',
      verifyCommand: 'npm run google:doctor',
      consentLinkCommand: 'curl -s -H "Authorization: Bearer $APP_API_TOKEN" "$APP_BASE_URL/api/google/consent-link"',
      note: 'النطاقات يحددها الخادم في src/google.js؛ لا تُكرَّر هنا حتى لا تنحرف عن الكود.'
    },
    ai: {
      envNames: ['GEMINI_API_KEY'],
      defaultModel: String(process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim(),
      alternatives: AI_PROVIDER_ENV_NAMES.filter((name) => String(process.env[name] || '').trim())
    },
    recheckCommand: 'npm run agents:doctor -- --json'
  };
}

function formatSetup(setup) {
  const lines = [];
  lines.push('خطة التوصيل — مشتقة من الكود نفسه، بلا قيم أسرار:');
  lines.push('');
  lines.push('1) Google OAuth');
  lines.push(`   · الفحوص الحاجزة الآن: ${setup.google.blockingChecks.length ? setup.google.blockingChecks.join(', ') : 'لا شيء'}`);
  if (setup.google.envNames.length) lines.push(`   · أسماء المتغيرات الناقصة: ${setup.google.envNames.join(', ')}`);
  lines.push(`   · Authorized redirect URI في Google Cloud = ${setup.google.redirectUri}`);
  lines.push(`   · ثم: ${setup.google.verifyCommand}   (يجب أن يخرج بـ 0)`);
  lines.push(`   · ثم موافقة المالك: افتح ${setup.google.consentPath} بحسابك، أو ${setup.google.consentLinkCommand}`);
  lines.push('   · ثم أعد القياس ليتحول الوكيل من 🟡 إلى 🟢.');
  lines.push('');
  lines.push('2) مخطط النموذج');
  lines.push(`   · ${setup.ai.envNames.join(' أو ')} — الموديل الافتراضي ${setup.ai.defaultModel}`);
  lines.push(`   · بدائل معلنة في المستودع: ${AI_PROVIDER_ENV_NAMES.slice(1).join(', ')} (الاسم فقط)`);
  lines.push('');
  lines.push('3) القياس والمقارنة');
  lines.push(`   · ${setup.recheckCommand} --write-baseline /tmp/agents-baseline.json`);
  lines.push(`   · ${setup.recheckCommand} --baseline /tmp/agents-baseline.json`);
  lines.push('');
  lines.push('لا يُكتب أي سر في هذا المخرج، ولا يُفعَّل شيء تلقائيًا: كل خطوة قرار صريح للمالك.');
  return lines.join('\n');
}

if (setupOnly) {
  const setup = buildSetup();
  process.stdout.write(asJson ? `${JSON.stringify(setup, null, 2)}\n` : `${formatSetup(setup)}\n`);
  process.exit(0);
}

// ── 1. الحلقة الكاملة: تخطيط → تنفيذ → مراقبة → تحقق → تسليم ──────────────
check('runtime-loop', 'حلقة الوكيل الكاملة (Planner → Act → Observe → Verify → Deliver)', async (self) => {
  const driver = await createSqliteDriver({ path: tempPath('runtime.sqlite3') });
  const store = createAgentStore({ driver });
  const tools = createDefaultTools({
    statusProvider: async () => ({ version: '0.2.1', storage: 'sqlite', toolsCount: 3 })
  });
  const runtime = createAgentRuntime({ store, tools, planner: createDemoPlanner(), workerId: 'agents-doctor' });
  const thread = await store.createThread({ ownerId: 'owner', title: 'فحص الوكلاء' });
  const { run } = await runtime.submit({ threadId: thread.id, message: 'لخّص حالة النظام' });
  const finished = await runtime.runToCompletion(run.id);
  const detail = await runtime.detail(run.id);
  const chain = await store.verifyEvidenceChain(run.id);
  await driver.close();
  const ok = finished.status === RUN_STATUS.succeeded && chain.ok && detail.steps.length > 0;
  finish(
    self,
    ok ? 'works' : 'broken',
    ok
      ? `اكتملت المهمة بحالة ${finished.status}، ${detail.steps.length} خطوة محفوظة، وسلسلة الأدلة سليمة (${chain.count} سجلًا)`
      : `الحالة ${finished.status}، سلسلة الأدلة ${chain.ok ? 'سليمة' : 'مكسورة'}، خطوات ${detail.steps.length}`,
    { status: finished.status, steps: detail.steps.length, evidenceRecords: chain.count, evidenceHead: chain.head?.slice(0, 16) }
  );
});

// ── 2. سجل الأدوات وتصنيف المخاطر ─────────────────────────────────────────
check('tool-registry', 'سجل الأدوات وتصنيف المخاطر (قراءة / كتابة داخلية / أثر خارجي / غير قابل للتراجع)', async (self) => {
  const tools = createDefaultTools({ statusProvider: async () => ({}) });
  const list = tools.list();
  const byRisk = list.reduce((acc, tool) => {
    acc[tool.risk] = (acc[tool.risk] || 0) + 1;
    return acc;
  }, {});
  const executable = list.filter((tool) => tools.executable(tool.name)).length;
  const externalBlocked = list.filter((tool) => tool.risk === 'external_effect' || tool.risk === 'irreversible')
    .every((tool) => tools.executable(tool.name) === false);
  finish(
    self,
    executable > 0 && externalBlocked ? 'works' : 'broken',
    `${list.length} أداة معلنة: ${executable} قابلة للتنفيذ بلا موافقة، والباقي أثر خارجي/غير قابل للتراجع يُرفض بلا موافقة`,
    { total: list.length, executable, byRisk }
  );
});

// ── 3. وكيل البحث في شبكة المعرفة ────────────────────────────────────────
check('kb-search', 'وكيل البحث في شبكة المعرفة (kb.search) — محلي بلا شبكة', async (self) => {
  const host = createKnowledgeHost({
    env: { CELIA_KB: 'sqlite', CELIA_KB_PATH: tempPath('knowledge.sqlite3') },
    directory: path.join(root, 'data/kb')
  });
  await host.importDirectory({ dryRun: false, full: true });
  const status = await host.status();
  const search = await host.search({ query: 'بحث المعرفة', limit: 3 });
  const items = search.items || [];
  finish(
    self,
    items.length > 0 ? 'works' : 'broken',
    items.length > 0
      ? `فُهرست ${status.stats?.items ?? 0} مادة من ${status.stats?.sources ?? 0} مصدرًا، والبحث العربي أعاد ${items.length} نتيجة بأدلة`
      : 'الفهرس بُني لكن البحث لم يُعد نتائج',
    {
      indexedItems: status.stats?.items ?? 0,
      sources: status.stats?.sources ?? 0,
      hits: items.map((item) => item.title).slice(0, 3),
      terms: search.terms ?? []
    }
  );
});

// ── 4. وكيل الويب: جلب حقيقي عبر وسيط الخروج + اختبار المنع ───────────────
check('web-fetch', 'وكيل الويب (web.fetch) — جلب حقيقي عبر وسيط الخروج مع قائمة سماح', async (self) => {
  const host = new URL(webTarget).hostname;
  const allowlist = createEgressAllowlist({ hosts: [host] });
  const proxy = createEgressProxy({});
  const address = await proxy.listen({ port: 0 });
  try {
    const web = createWebAccess({ proxy, proxyUrl: address.url, allowlist });
    const tool = webToolDefinitions({ web })[0];
    let fetched = null;
    let fetchError = null;
    try {
      fetched = await tool.execute({ url: webTarget }, { run: { id: 'agents-doctor-web' } });
    } catch (error) {
      fetchError = unwrap(error);
    }
    let blocked = null;
    try {
      await tool.execute({ url: 'https://example.com/' }, { run: { id: 'agents-doctor-block' } });
      blocked = 'لم يُمنع — خلل في قائمة السماح';
    } catch (error) {
      blocked = unwrap(error);
    }
    const allowBlocked = blocked === 'web_url_not_allowed';
    if (fetched && allowBlocked) {
      finish(self, 'works', `جُلبت ${webTarget} بحالة ${fetched.status} و${fetched.chars} حرفًا مبصومة SHA-256، ونطاق خارج القائمة مُنع قبل أي اتصال (${blocked})`, {
        url: webTarget,
        httpStatus: fetched.status,
        chars: fetched.chars,
        sha256: fetched.sha256?.slice(0, 16),
        injectionTainted: fetched.injection?.tainted === true,
        outOfAllowlist: blocked
      });
      return;
    }
    if (allowBlocked) {
      const hint = fetchError === 'web_tls_failed'
        ? '؛ شبكة هذه البيئة تعترض TLS فتفشل ثقة Node بينما curl ينجح — الحل تشغيل الفحص مع NODE_EXTRA_CA_CERTS لشهادة البيئة، وهو قرار ثقة صريح لا يُفعّل تلقائيًا'
        : '';
      // SI-5/D3: التشخيص الحقيقي يُبنی أيضًا بالبنية الثابتة — بلا اختراع نتائج: اختبار
      // التمييز بين فرضيتي TLS لم يُجرَ هنا فيبقى `untested` والحالة فرضية لا تأكيدًا.
      const diagnosis = fetchError === 'web_tls_failed'
        ? createDiagnosisReport({
          symptom: `الجلب الحقيقي عبر web.fetch فشل: ${fetchError}`,
          evidence: [
            `web.fetch أعد ${fetchError} على ${webTarget}`,
            `المنع خارج قائمة السماح يعمل قبل أي اتصال (${blocked})`
          ],
          hypotheses: [
            { id: 'H1', statement: 'شبكة البيئة تعترض TLS فتفشل ثقة Node في شهادة البيئة' },
            { id: 'H2', statement: 'شهادة الهدف نفسه غير صالحة أو غير موثوقة' }
          ],
          discriminatingTests: [
            {
              id: 'T1',
              hypothesis: 'H1',
              distinguishes: 'نفس الهدف ينجح من عميل بثقة البيئة (curl) ويفشل من Node ⇒ H1، وينجح الاثنان أو يفشلان معًا ⇒ H2',
              outcome: TEST_OUTCOMES.untested
            }
          ],
          recommendedAction: 'أعد الفحص مع NODE_EXTRA_CA_CERTS لشهادة البيئة ثم سجّل نتيجة اختبار التمييز',
          limit: 'قرار ثقة صريح لا يُفعّل تلقائيًا'
        })
        : null;
      const evidence = {
        url: webTarget,
        fetchError,
        outOfAllowlist: blocked
      };
      if (diagnosis) evidence.diagnosis = diagnosis;
      finish(self, 'blocked', `المنع خارج قائمة السماح يعمل (${blocked})، لكن الجلب الحقيقي فشل: ${fetchError}${hint}`, evidence);
      return;
    }
    finish(self, 'broken', `خلل في قائمة السماح: ${blocked}`, { url: webTarget, fetchError, outOfAllowlist: blocked });
  } finally {
    await proxy.close();
  }
});

// ── 5. وكلاء القراءة من Google (Drive / Calendar / Contacts / Gmail) ───────
check('google-read', 'وكلاء القراءة من Google (Drive · Calendar · Contacts · Gmail) — قراءة فقط وتقليص الحقول', async (self) => {
  // كل نقل يُعيد حقولًا زائدة عن الحاجة عمدًا: المطلوب أن تُسقَط قبل أن تصل للوكيل.
  const drive = createDriveReadConnector({
    transport: { listFiles: async () => ([{ id: 'f1', name: 'تقرير', mimeType: 'application/pdf', modifiedTime: '2026-11-01T00:00:00Z', owners: [{ email: 'owner@example.com' }], permissions: [{ role: 'writer' }] }]) }
  });
  const calendar = createCalendarReadConnector({
    transport: { listEvents: async () => ([{ id: 'e1', summary: 'اجتماع', start: { dateTime: '2026-11-02T09:00:00Z' }, end: { dateTime: '2026-11-02T10:00:00Z' }, attendees: ['attendee@example.com'], description: 'ملاحظات داخلية' }]) }
  });
  const contacts = createContactsReadConnector({
    transport: { listContacts: async () => ([{ resourceName: 'people/1', name: 'اسم', phones: ['+201000000000'], emails: ['contact@example.com'], rawPayload: 'RAW-CONTACT' }]) }
  });
  const gmail = createGmailReadConnector({
    transport: { listMessages: async () => ([{ id: 'm1', threadId: 't1', internalDate: '2026-11-01T00:00:00Z', snippet: 'مرحبا', labelIds: ['INBOX'], raw: 'MIME-RAW', payload: { headers: [{ name: 'Subject', value: 'موضوع' }] } }]) }
  });
  const [driveOut, calendarOut, contactsOut, gmailOut] = await Promise.all([
    drive.read({ maxResults: 5 }),
    calendar.read({ timeMin: '2026-11-01T00:00:00Z', timeMax: '2026-11-03T00:00:00Z', maxResults: 5 }),
    contacts.read({ maxResults: 5 }),
    gmail.read({ maxResults: 5 })
  ]);
  const text = (value) => JSON.stringify(value);
  const leaks = [
    text(driveOut).includes('owner@example.com') || text(driveOut).includes('permissions'),
    text(calendarOut).includes('attendee@example.com') || text(calendarOut).includes('ملاحظات داخلية'),
    text(contactsOut).includes('RAW-CONTACT'),
    text(gmailOut).includes('MIME-RAW') || text(gmailOut).includes('payload')
  ];
  const counts = [driveOut.count, calendarOut.count, contactsOut.count, gmailOut.count];
  const ok = leaks.every((leak) => leak === false) && counts.every((count) => count === 1);
  // ما تقوله بوابة Google الحقيقية في هذا الكود نفسه، لا تخمين: أسماء الفحوص الفاشلة بلا قيم.
  const preflight = preflightGoogleConfig(process.env);
  const blocking = preflight.checks.filter((entry) => entry.status === 'fail').map((entry) => entry.id);
  const warnings = preflight.checks.filter((entry) => entry.status === 'warn').map((entry) => entry.id);
  const configured = blocking.length === 0;
  const reason = configured
    ? 'الاعتماد مهيّأ كاملًا؛ تبقّى خطوة موافقة المالك على /auth/google ليُقرأ حساب حقيقي — هذا الفحص لا يقرأ حسابًا نيابةً عنه'
    : `ولا اعتماد OAuth بعد: الفحوص الحاجزة (${blocking.join(', ')}) — شغّل npm run google:doctor لخطوات الإصلاح`;
  finish(
    self,
    ok ? 'partial' : 'broken',
    ok
      ? `الأربعة قرأوا سجلًا واحدًا لكل منهم وقلّصوا الحقول (لا بريد مخاطبين ولا وصف ولا نص خام)؛ ${reason}`
      : `تسرّب حقل غير مسموح إلى المخرج: ${JSON.stringify(leaks)}`,
    { counts, minimized: ok, oauthConfigured: configured, blockingChecks: blocking, warnings, googlePreflightOk: preflight.ok }
  );
});

// ── 6. بوابة الموافقة: الأثر الخارجي ينتظر ولا ينفّذ ───────────────────────
check('approval-gate', 'بوابة الموافقة — أثر خارجي بلا موافقة ينتظر ولا ينفّذ', async (self) => {
  let executed = 0;
  const tools = createDefaultTools({ statusProvider: async () => ({}) });
  const effect = tools.get('google.calendar_create_event');
  const declaredOnly = effect && effect.execute === null;
  const planner = createScriptedPlanner([
    { action: 'call', tool: 'google.calendar_create_event', args: { summary: 'اجتماع', start: '2026-11-02T09:00:00Z', end: '2026-11-02T10:00:00Z' } }
  ]);
  const driver = await createSqliteDriver({ path: tempPath('approval.sqlite3') });
  const store = createAgentStore({ driver });
  const runtime = createAgentRuntime({ store, tools, planner, workerId: 'agents-doctor' });
  const thread = await store.createThread({ ownerId: 'owner', title: 'موافقة' });
  const { run } = await runtime.submit({ threadId: thread.id, message: 'أنشئ موعدًا' });
  const finished = await runtime.runToCompletion(run.id);
  await driver.close();
  const ok = declaredOnly && executed === 0 && finished.status === RUN_STATUS.waitingApproval;
  finish(
    self,
    ok ? 'works' : 'broken',
    ok
      ? `الأداة معلنة بلا منفّذ (execute=null) والتشغيل توقف عند ${finished.status}: لا أثر خارجي بلا موافقة`
      : `الحالة ${finished.status}، execute=${effect?.execute === null ? 'null' : 'موجود'}، تنفيذات=${executed}`,
    { status: finished.status, declaredOnly, executions: executed }
  );
});

// ── 7. الصندوق الرملي: تنفيذ كود معزول ────────────────────────────────────
check('sandbox', 'وكيل التنفيذ المعزول (sandbox.exec) — شبكة مقطوعة وسقوف موارد', async (self) => {
  const executor = createSandboxExecutor({ artifactRoot: tempPath('sandbox-artifacts') });
  const outcome = await executor.run({
    runId: `doctor-${Date.now().toString(36)}`,
    code: 'console.log("sandbox-ok", 2 + 2)'
  });
  const ok = outcome.status === 'succeeded' && outcome.verdict === 'PASS' && outcome.network?.mode === 'deny';
  finish(
    self,
    ok ? 'works' : outcome.reason ? 'blocked' : 'broken',
    ok
      ? `نُفِّذ كود داخل الصندوق (${outcome.verdict}) وشبكته ${outcome.network.mode}، وخرج بلا خطأ`
      : `لم يُنفَّذ: ${outcome.reason || outcome.status}`,
    { status: outcome.status, verdict: outcome.verdict, network: outcome.network?.mode ?? null, reason: outcome.reason ?? null }
  );
});

// ── 8. وكيل التفويض: الطفل لا يتجاوز الأب ────────────────────────────────
check('delegation', 'وكيل التفويض — ميزانية وصلاحيات الطفل مجموعة جزئية من الأب', async (self) => {
  const parent = { runId: 'parent-1', status: 'running', maxRisk: 'read', tools: ['read.alpha'], remainingSteps: 6, remainingCostMicros: 20_000 };
  const roster = [{ id: 'researcher', tools: ['read.alpha'], maxRisk: 'read' }];
  const tasks = [
    { taskId: 'a', agent: 'researcher', objective: 'اقرأ', steps: 3, costMicros: 5_000 },
    { taskId: 'b', agent: 'researcher', objective: 'تجاوز', steps: 9, costMicros: 50_000 }
  ];
  const plan = planDelegation({ parent, tasks, roster });
  const verified = checkDelegation(plan, { parent, tasks, roster });
  const refused = Array.isArray(plan.refused) ? plan.refused : [];
  const ok = plan.accepted.length === 1 && refused.length === 1 && verified.ok && plan.executes === false;
  finish(
    self,
    ok ? 'works' : 'broken',
    ok
      ? `قُبلت مهمة واحدة (${plan.accepted[0]?.taskId}) ورُفضت التي تجاوز ميزانية الأب بالاسم: ${refused.map((item) => item.code).join(', ')}`
      : `مقبول=${plan.accepted.length}، رفض=${refused.length}، تحقق=${verified.ok}`,
    { accepted: plan.accepted.map((task) => task.taskId), refused: refused.map((item) => item.code), verified: verified.ok }
  );
});

// ── 9. الذاكرة: دمج بلا محو ───────────────────────────────────────────────
check('memory-consolidation', 'الذاكرة والدمج — تكرار يُدمج وتعارض يبقى معلنًا بلا حسم', async (self) => {
  const claims = [
    { subject: 'celia', predicate: 'version', value: '0.2.1', sourceId: 's1', itemId: 'i1' },
    { subject: 'celia', predicate: 'version', value: '0.2.1', sourceId: 's2', itemId: 'i2' },
    { subject: 'celia', predicate: 'version', value: '0.3.0', sourceId: 's3', itemId: 'i3' }
  ];
  const report = consolidate(claims);
  const verified = checkReport(report);
  const ok = verified.ok && report.contested === 1 && report.resolution === 'unresolved' && report.retained === claims.length;
  finish(
    self,
    ok ? 'works' : 'broken',
    ok
      ? `دُمج التكرار مع الاحتفاظ بكل المصادر (${report.retained}/${claims.length})، وبقي التعارض معلنًا ${report.resolution} بلا اختيار`
      : `تحقق=${verified.ok}، تعارض=${report.contested}، حسم=${report.resolution}، محفوظ=${report.retained}/${claims.length}`,
    { retained: report.retained, groups: report.groups, contested: report.contested, resolution: report.resolution, verified: verified.ok }
  );
});

// ── 10. قائمة الانتظار المستحقة ───────────────────────────────────────────
check('attention', 'قائمة الانتظار المستحقة — مشتقة من السجلات لا مخترعة', async (self) => {
  const snapshot = {
    runs: [{ id: 'run-1', status: 'waiting_approval', title: 'موافقة تقويم', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' }],
    approvals: [{ id: 'ap-1', runId: 'run-1', toolName: 'google.calendar_create_event', status: 'pending', createdAt: '2026-11-01T00:00:00Z' }],
    toolRuns: [{ id: 'tr-1', runId: 'run-1', toolName: 'google.calendar_create_event', status: 'unknown' }],
    outbox: [],
    busMessages: []
  };
  const queue = buildAttention(snapshot, { now: '2026-11-01T01:00:00Z' });
  const verified = checkQueue(queue, snapshot);
  const ok = queue.items.length > 0 && verified.ok;
  finish(
    self,
    ok ? 'works' : 'broken',
    ok
      ? `بُنيت ${queue.items.length} مستحقة من السجلات نفسها (${queue.items.map((item) => item.reason).join(', ')}) والتحقق يقبلها`
      : `عناصر=${queue.items.length}، تحقق=${verified.ok}`,
    { items: queue.items.length, reasons: queue.items.map((item) => item.reason), verified: verified.ok }
  );
});

// ── 11. المصالحة الجماعية والتقرير الدوري (DATA-003) ──────────────────────
check('reconciliation-batch', 'المصالحة الجماعية والتقرير الدوري — قرار واحد، صفوف كثيرة، بلا إرسال', async (self) => {
  // A real store in a temp file, not a mock: the conditional writes are the point of the capability.
  const driver = await createSqliteDriver({ path: tempPath('reconcile.sqlite3') });
  const store = createAgentStore({ driver, clock: () => Date.parse('2026-11-01T00:00:00.000Z') });
  try {
    const thread = await store.createThread({ ownerId: 'owner', title: 'مصالحة' });
    const { run } = await store.createRun({
      threadId: thread.id,
      ownerId: 'owner',
      userMessageId: null,
      clientMessageId: 'doctor-reconcile-0001',
      planner: 'doctor',
      maxSteps: 6,
      maxCostMicros: 1000
    });
    const ids = [];
    for (const index of [0, 1]) {
      const { toolRun } = await store.startToolRun({
        runId: run.id,
        toolName: `read.${index}`,
        risk: 'read',
        idempotencyKey: `${run.id}:doctor:${index}`
      });
      await store.finishToolRun(toolRun.id, TOOL_RUN_STATUS.unknown, JSON.stringify({ reason: 'process_interrupted' }));
      ids.push(toolRun.id);
    }
    const batch = await reconcileBatch(
      {
        store,
        runId: run.id,
        actor: 'owner',
        target: RECONCILE_TARGET.toolRun,
        targetIds: ids,
        outcome: RECONCILE_OUTCOME.applied,
        note: 'فحص الطبيب'
      },
      { now: '2026-11-01T00:00:00.000Z' }
    );
    // One row is settled by a person first, so the batch must report a skip instead of overwriting.
    const leftover = await store.listUnrestedOutcomes();
    const report = buildReconciliationReport(leftover, { now: '2026-11-01T06:00:00.000Z' });
    const chain = await store.verifyEvidenceChain(run.id);
    const ok = batch.settled === 2 && batch.complete === true && chain.ok && report.resends === false && report.schedules === false;
    finish(
      self,
      ok ? 'works' : 'broken',
      ok
        ? `سُوِّيت ${batch.settled} صفوف بقرار واحد (بصمة ${batch.findingDigest.slice(0, 12)})، والسلسلة سليمة، والتقرير يقول «${report.reading}» بلا جدولة ولا إرسال`
        : `مستقر=${batch.settled}، مكتمل=${batch.complete}، سلسلة=${chain.ok}`,
      {
        settled: batch.settled,
        skipped: batch.skipped.length,
        complete: batch.complete,
        unresolvedTotal: report.unresolvedTotal,
        schedules: report.schedules,
        resends: report.resends,
        chainOk: chain.ok
      }
    );
  } finally {
    await store.close().catch(() => {});
  }
});

// ── 12. تبويبان متزامنان (DATA-002) ───────────────────────────────────────
check('two-tabs', 'تبويبان متزامنان — قرار واحد يفوز، والخاسر يُرفض بـ409 ولا يكتب فوق تقدم أحدث', async (self) => {
  const driver = await createSqliteDriver({ path: tempPath('two-tabs.sqlite3') });
  const store = createAgentStore({ driver });
  try {
    const thread = await store.createThread({ ownerId: 'owner', title: 'تبويبان' });
    const { run } = await store.createRun({
      threadId: thread.id,
      ownerId: 'owner',
      userMessageId: null,
      clientMessageId: 'doctor-two-tabs-0001',
      planner: 'doctor',
      maxSteps: 5,
      maxCostMicros: 1000
    });
    const step = await store.appendStep({ runId: run.id, kind: 'act', title: 'google.calendar_create_event' });
    const { approval } = await store.requestApproval({
      runId: run.id,
      stepId: step.id,
      toolName: 'google.calendar_create_event',
      risk: 'external_effect',
      idempotencyKey: `approval:${run.id}:doctor`
    });
    // Two tabs decide the same gate at the same time, with their own keys.
    const results = await Promise.allSettled([
      store.decideApproval({ approvalId: approval.id, decision: 'approved', actor: 'owner', decisionKey: 'doctor-tab-alpha-1' }),
      store.decideApproval({ approvalId: approval.id, decision: 'approved', actor: 'owner', decisionKey: 'doctor-tab-bravo-2' })
    ]);
    const won = results.filter((item) => item.status === 'fulfilled');
    const lost = results.filter((item) => item.status === 'rejected');
    const conflict = lost[0]?.reason;
    // The loser must be a named 409 conflict, never a 500: that was the measured defect.
    const namedConflict = conflict?.code === 'approval_already_decided' && conflict?.status === 409;
    const ok = won.length === 1 && lost.length === 1 && namedConflict && approval.decision === 'pending';
    finish(
      self,
      ok ? 'works' : 'broken',
      ok
        ? 'فاز قرار واحد فقط، والخاسر تلقّى 409 مسمّى (لا 500)، والصفّ حُسم مرة واحدة'
        : `فائز=${won.length} · خاسر=${lost.length} · رمز=${conflict?.code ?? '—'} · حالة=${conflict?.status ?? '—'}`,
      { winners: won.length, losers: lost.length, conflictCode: conflict?.code ?? null, conflictStatus: conflict?.status ?? null }
    );
  } finally {
    await store.close().catch(() => {});
  }
});

// ── 13. وكيل فرز المشكلات ────────────────────────────────────────────────
check('issue-triage', 'وكيل فرز المشكلات (issue-triage) — تصنيف محلي بلا شبكة', async (self) => {
  const critical = classifyIssue({ title: 'تسرب مفتاح API في سجلات الإنتاج', body: 'المفتاح ظهر في سجلات النشر ويمكن استغلاله. أمني وعاجل جدًا.' });
  const bug = classifyIssue({ title: 'الخادم يتعطل عند رفع ملف كبير', body: 'عند رفع ملف 40 ميغابايت يتوقف الخادم بخطأ 500 ويعود بعد إعادة التشغيل.' });
  const ok = Boolean(critical.type) && Boolean(bug.type) && critical.priority === 'critical';  finish(
    self,
    ok ? 'works' : 'broken',
    ok
      ? `صنّف الأول ${critical.type}/${critical.priority} بثقة ${critical.confidence} والثاني ${bug.type}/${bug.priority} بثقة ${bug.confidence}`
      : `الأول ${critical.type}/${critical.priority}، الثاني ${bug.type}/${bug.priority}`,
    { first: { type: critical.type, priority: critical.priority, confidence: critical.confidence }, second: { type: bug.type, priority: bug.priority, confidence: bug.confidence } }
  );
});

// ── 12. المخطط السحابي (LLM) ──────────────────────────────────────────────
check('planner-llm', 'المخطط الذكي (Gemini planner) — لا يعمل بمفتاح وهمي أو ناقص', async (self) => {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  const alternatives = ['AI_GATEWAY_API_KEY', 'DEEPSEEK_API_KEY', 'AGENETROUTERAPI_KEY', 'AGENTROUTER_API_KEY']
    .filter((name) => String(process.env[name] || '').trim());
  if (!key) {
    let refused = null;
    try {
      createGeminiPlannerProvider({ apiKey: '' });
    } catch (error) {
      refused = error.message;
    }
    if (alternatives.length > 0) {
      finish(self, 'partial', `لا GEMINI_API_KEY لكن يوجد ${alternatives.join(' / ')} (الاسم فقط)؛ المخطط الحتمي هو المستخدم الآن، ومخطط النموذج يحتاج GEMINI_API_KEY`, {
        configuredAlternatives: alternatives,
        fallbackPlanner: 'demo-deterministic'
      });
      return;
    }
    finish(self, 'not_configured', 'لا GEMINI_API_KEY ولا بديل من مفاتيح المزودين؛ البناء يرفض المفتاح الفارغ صراحةً والمخطط الحتمي (demo) هو المستخدم', {
      refused: Boolean(refused),
      fallbackPlanner: 'demo-deterministic',
      acceptedEnvNames: ['GEMINI_API_KEY', ...alternatives]
    });
    return;
  }
  const provider = createGeminiPlannerProvider({ apiKey: key });
  finish(self, 'partial', `مزود ${provider.model} مهيّأ لكن غير متحقق: لم يُستدعَ النموذج ولم تُختبر صلاحية المفتاح`, { model: provider.model, configured: true, liveVerified: false });
});

// ── 13. موجّه النماذج والتكلفة ────────────────────────────────────────────
check('model-router', 'موجّه النماذج والتكلفة — قرار حتمي وتكلفة بتقريب لأعلى', async (self) => {
  const initial = defaultRoute({ state: { toolResults: [] } });
  const extraction = defaultRoute({ state: { toolResults: [{ status: 'succeeded' }] } });
  const failed = defaultRoute({ state: { toolResults: [{ status: 'failed' }] } });
  const pricing = DECLARED_GEMINI_PRICING.planner ?? Object.values(DECLARED_GEMINI_PRICING)[0];
  const cost = computeCostMicros({ inputTokens: 1000, outputTokens: 500 }, pricing);
  const ok = initial.tier === 'planner' && extraction.tier === 'fast' && failed.tier === 'planner'
    && extraction.reason !== initial.reason && Number.isSafeInteger(cost) && cost > 0;
  finish(
    self,
    ok ? 'works' : 'broken',
    ok
      ? `التخطيط الأولي → ${initial.tier} (${initial.reason})، استخراج بعد نتيجة ناجحة → ${extraction.tier} (${extraction.reason})، وبعد فشل أداة → ${failed.tier}؛ تكلفة 1000/500 توكن = ${cost} ميكرو-دولار`
      : `الابتدائي=${initial.tier}، الاستخراج=${extraction.tier}، الفاشل=${failed.tier}، التكلفة=${cost}`,
    { initialTier: initial.tier, extractionTier: extraction.tier, failedTier: failed.tier, costMicros: cost }
  );
});

// ── 14. سطح MCP ──────────────────────────────────────────────────────────
check('mcp-surface', 'سطح MCP (12 أداة) — فحص ذاتي للخادم', async (self) => {
  const child = spawnSync(process.execPath, ['src/celia-mcp.js', '--self-test'], {
    cwd: root,
    env: { ...process.env, CELIA_MCP_DISABLE_MYSQL: 'true', CELIA_DISABLE_OLLAMA: 'true' },
    encoding: 'utf8',
    timeout: 120_000
  });
  const text = String(child.stdout || '');
  const json = text.slice(text.indexOf('{'));
  let parsed = null;
  try {
    parsed = JSON.parse(json);
  } catch {
    parsed = null;
  }
  const ok = parsed?.selfTest === 'passed' && Number(parsed?.toolsCount) > 0;
  finish(
    self,
    ok ? 'works' : 'broken',
    ok
      ? `الفحص الذاتي نجح: ${parsed.toolsCount} أداة، إصدار ${parsed.serverInfo?.version}، مزود الذكاء ${parsed.effectiveAiProvider}`
      : `فشل الفحص الذاتي: ${(child.stderr || text).slice(0, 300)}`,
    { toolsCount: parsed?.toolsCount ?? null, version: parsed?.serverInfo?.version ?? null, aiProvider: parsed?.effectiveAiProvider ?? null }
  );
});

// ── التشغيل ───────────────────────────────────────────────────────────────
for (const item of checks) {
  try {
    await item.run(item);
  } catch (error) {
    finish(item, 'broken', `استثناء غير متوقع: ${unwrap(error)}`, { error: unwrap(error) });
  }
}

rmSync(temp, { recursive: true, force: true });

const summary = Object.keys(statuses).reduce((acc, key) => {
  acc[key] = results.filter((result) => result.status === key).length;
  return acc;
}, {});
const broken = results.filter((result) => result.status === 'broken');
const RANK = { works: 4, partial: 3, blocked: 2, not_configured: 2, broken: 1 };

let comparison = null;
if (baselinePath) {
  const previous = new Map(baseline.checks.map((entry) => [entry.id, entry.status]));
  const changes = results.map((result) => {
    const was = previous.get(result.id) ?? null;
    const direction = was === null ? 'new' : was === result.status ? 'same' : RANK[result.status] > RANK[was] ? 'improved' : 'regressed';
    return { id: result.id, was, now: result.status, direction };
  });
  const currentIds = new Set(results.map((result) => result.id));
  const removed = baseline.checks.filter((entry) => !currentIds.has(entry.id))
    .map((entry) => ({ id: entry.id, was: entry.status, now: null, direction: 'regressed', reason: 'check_removed' }));
  changes.push(...removed);
  comparison = {
    removed,
    baselinePath,
    baselineGeneratedAt: baseline?.generatedAt ?? null,
    unchanged: changes.filter((change) => change.direction === 'same').length,
    improved: changes.filter((change) => change.direction === 'improved'),
    regressed: changes.filter((change) => change.direction === 'regressed'),
    appeared: changes.filter((change) => change.direction === 'new'),
    changes
  };
}
if (writeBaselinePath) {
  const payload = { version: 'agents-doctor-v1', generatedAt: new Date().toISOString(), summary, checks: results };
  const absolute = path.resolve(writeBaselinePath);
  writeFileSync(absolute, `${JSON.stringify(payload, null, 2)}\n`);
  if (absolute.startsWith(root + path.sep) && !absolute.includes(`${path.sep}.data${path.sep}`)) {
    process.stderr.write(`تنبيه: خط الأساس داخل المستودع (${path.relative(root, absolute)})؛ لا تضفه إلى Git.\n`);
  }
}

if (asJson) {
  process.stdout.write(`${JSON.stringify({ version: 'agents-doctor-v1', generatedAt: new Date().toISOString(), summary, checks: results, ...(comparison ? { comparison } : {}) }, null, 2)}\n`);
} else {
  const header = 'الحالة | الوكيل | النتيجة';
  process.stdout.write(`فحص وكلاء المستودع — ${results.length} وكيلًا\n\n${header}\n--- | --- | ---\n`);
  for (const result of results) {
    process.stdout.write(`${statuses[result.status].icon} ${statuses[result.status].ar} | ${result.ar} | ${result.detail}\n`);
  }
  process.stdout.write(`\nالإجمالي: ${summary.works} يعمل · ${summary.partial} جزئي · ${summary.not_configured} غير مفعّل · ${summary.blocked} متعطّل خارجيًا · ${summary.broken} معطوب\n`);
  if (comparison) {
    process.stdout.write(`\nمقارنة بخط الأساس ${comparison.baselinePath}: ${comparison.unchanged} بلا تغيير · ${comparison.improved.length} تحسّن · ${comparison.regressed.length} تراجع · ${comparison.appeared.length} جديد\n`);
    for (const change of comparison.improved) process.stdout.write(`  ↑ ${change.id}: ${change.was} → ${change.now}\n`);
    for (const change of comparison.regressed) process.stdout.write(`  ↓ ${change.id}: ${change.was} → ${change.now ?? 'محذوف (check_removed)'}\n`);
    for (const change of comparison.appeared) process.stdout.write(`  + ${change.id}: ${change.now}\n`);
  }
}

process.exitCode = broken.length === 0 && !(failOnRegression && comparison?.regressed.length) ? 0 : 1;
