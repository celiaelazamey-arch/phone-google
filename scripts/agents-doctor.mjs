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
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createSqliteDriver } from '../src/agent/drivers.js';
import { createAgentStore, RUN_STATUS } from '../src/agent/store.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createDefaultTools } from '../src/agent/tools.js';
import { createDemoPlanner, createScriptedPlanner } from '../src/agent/planner.js';
import { createGeminiPlannerProvider } from '../src/agent/gemini-planner-provider.js';
import { createEgressAllowlist, createEgressProxy } from '../src/agent/egress-proxy.js';
import { createWebAccess, webToolDefinitions } from '../src/agent/web-tools.js';
import { createSandboxExecutor } from '../src/agent/sandbox.js';
import { createKnowledgeHost } from '../src/knowledge/index.js';
import { planDelegation, checkDelegation } from '../src/agent/delegation.js';
import { buildAttention, checkQueue } from '../src/agent/attention.js';
import { consolidate, checkReport } from '../src/agent/consolidation.js';
import { classifyIssue } from '../src/agent/issue-triage/classify.js';
import { defaultRoute, computeCostMicros, DECLARED_GEMINI_PRICING } from '../src/agent/model-router.js';
import {
  createDriveReadConnector,
  createCalendarReadConnector,
  createContactsReadConnector
} from '../src/agent/google-read.js';
import { createGmailReadConnector } from '../src/agent/gmail.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const urlIndex = args.indexOf('--url');
const webTarget = urlIndex >= 0 ? args[urlIndex + 1] : 'https://github.com/';

const statuses = {
  works: { icon: '🟢', ar: 'يعمل' },
  partial: { icon: '🟡', ar: 'جزئي' },
  not_configured: { icon: '⚪', ar: 'غير مفعّل' },
  blocked: { icon: '⛔', ar: 'متعطّل خارجيًا' },
  broken: { icon: '🔴', ar: 'معطوب' }
};

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
      finish(self, 'blocked', `المنع خارج قائمة السماح يعمل (${blocked})، لكن الجلب الحقيقي فشل: ${fetchError}${hint}`, {
        url: webTarget,
        fetchError,
        outOfAllowlist: blocked
      });
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
  const live = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  finish(
    self,
    ok ? (live ? 'works' : 'partial') : 'broken',
    ok
      ? `الأربعة قرأوا سجلًا واحدًا لكل منهم وقلّصوا الحقول (لا بريد مخاطبين ولا وصف ولا نص خام)${live ? '؛ واعتماد OAuth موجود في البيئة' : '؛ ولا اعتماد OAuth في هذه البيئة فالحساب الحقيقي لم يُقرأ'}`
      : `تسرّب حقل غير مسموح إلى المخرج: ${JSON.stringify(leaks)}`,
    { counts, minimized: ok, oauthConfigured: live }
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

// ── 11. وكيل فرز المشكلات ────────────────────────────────────────────────
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
  if (!key) {
    let refused = null;
    try {
      createGeminiPlannerProvider({ apiKey: '' });
    } catch (error) {
      refused = error.message;
    }
    finish(self, 'not_configured', 'لا GEMINI_API_KEY في هذه البيئة؛ البناء يرفض المفتاح الفارغ صراحةً والمخطط الحتمي (demo) هو المستخدم', {
      refused: Boolean(refused),
      fallbackPlanner: 'demo-deterministic'
    });
    return;
  }
  const provider = createGeminiPlannerProvider({ apiKey: key });
  finish(self, 'works', `مزود ${provider.model} بُني بمفتاح موجود (لم يُستدعَ النموذج في هذا الفحص)`, { model: provider.model });
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

if (asJson) {
  process.stdout.write(`${JSON.stringify({ version: 'agents-doctor-v1', generatedAt: new Date().toISOString(), summary, checks: results }, null, 2)}\n`);
} else {
  const header = 'الحالة | الوكيل | النتيجة';
  process.stdout.write(`فحص وكلاء المستودع — ${results.length} وكيلًا\n\n${header}\n--- | --- | ---\n`);
  for (const result of results) {
    process.stdout.write(`${statuses[result.status].icon} ${statuses[result.status].ar} | ${result.ar} | ${result.detail}\n`);
  }
  process.stdout.write(`\nالإجمالي: ${summary.works} يعمل · ${summary.partial} جزئي · ${summary.not_configured} غير مفعّل · ${summary.blocked} متعطّل خارجيًا · ${summary.broken} معطوب\n`);
}

process.exitCode = broken.length === 0 ? 0 : 1;
