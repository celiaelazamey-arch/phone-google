import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { attachChromiumDiagnostics } from './diagnostics.js';

const LIVE = 'http://127.0.0.1:3100';
const STATIC = 'http://127.0.0.1:3101/phone-google';
const TOKEN = 'e2e-only-not-a-production-token-0000000000';

async function expectNoA11yViolations(page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const unexpected = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => n.target.join(' '))
  }));
  expect(unexpected).toEqual([]);
}

test.describe('مساحة الوكيل وشبكة المعرفة (/agent, /kb) — فحص Chromium التشخيصي', () => {
  test('صفحة /agent الحية تعمل بلا أي خطأ تشخيصي وتلتزم بـ WCAG 2.2 AA و320px RTL', async ({ page }, testInfo) => {
    const { diagnostics, flush } = attachChromiumDiagnostics(page);
    try {
      await page.setViewportSize({ width: 320, height: 640 });
      await page.goto(`${LIVE}/agent`, { waitUntil: 'networkidle' });

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.locator('#mode-badge')).toContainText('أدخل الرمز لعرض الحالة');
      await expect(page.locator('#plan-state')).toContainText('بلا خطة');

      const overflow320 = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow320).toBeLessThanOrEqual(1);

      await page.setViewportSize({ width: 1280, height: 800 });
      await page.fill('#token', TOKEN);
      await page.click('#connect');
      await expect(page.locator('#auth-status')).toContainText('متصل');
      await expect(page.locator('#mode-badge')).toContainText('الوكيل متوقف (off)');

      await expectNoA11yViolations(page);
      expect(diagnostics, diagnostics.join('\n')).toEqual([]);
    } finally {
      await flush(testInfo);
    }
  });

  test('النسخة الثابتة تحت مسار فرعي (/phone-google/agent.html و /phone-google/kb.html) تحمل كل الأصول بلا 404 وتعلن حدودها بصدق', async ({
    page
  }, testInfo) => {
    const { diagnostics, flush } = attachChromiumDiagnostics(page);
    try {
      await page.setViewportSize({ width: 320, height: 640 });
      await page.goto(`${STATIC}/agent.html`, { waitUntil: 'networkidle' });

      await expect(page.locator('#mode-badge')).toContainText('نسخة ثابتة');
      await expect(page.locator('#run')).toBeDisabled();
      const overflowAgent = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflowAgent).toBeLessThanOrEqual(1);
      await expectNoA11yViolations(page);

      await page.goto(`${STATIC}/kb.html`, { waitUntil: 'networkidle' });
      await expect(page.locator('#kb-badge')).toContainText('نسخة ثابتة');
      await expect(page.locator('#search')).toBeDisabled();
      const overflowKb = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflowKb).toBeLessThanOrEqual(1);
      await expectNoA11yViolations(page);

      expect(diagnostics, diagnostics.join('\n')).toEqual([]);
    } finally {
      await flush(testInfo);
    }
  });
});

/**
 * WP-1.2 (AGENT-008, DEC-047) — أثر التنفيذ: شجرة الخطة وسطر «الآن» وشريط الميزانية.
 * خادم e2e يعمل بالوكيل متوقفًا (CELIA_AGENT_RUNTIME غير مضبوط)، فتُعترض مسارات /api/agent/** بأجسام مطابقة لعقد
 * الخادم الحقيقي (نفس المفاتيح التي يختبرها test/agent-trace.test.js: `now`، `settledStep`، `toolRunStatus`،
 * `run.limits`)؛ الهدف هنا هو منطق الصفحة الحقيقي في المتصفح الحقيقي، لا الحلقة نفسها.
 */
const T0 = Date.parse('2026-10-29T10:00:00.000Z');
const at = (offsetMs) => new Date(T0 + offsetMs).toISOString();
const LIMITS = { maxSteps: 12, maxCostMicros: 100000 };
const STAGES = (flags) => [
  { id: 'understand', title: '1. الفهم (Goal & Constraints)', completed: flags[0] },
  { id: 'plan', title: '2. التخطيط (Steps, Tools, Risks, Criteria)', completed: flags[1] },
  { id: 'present_and_wait', title: '3. العرض والانتظار (WAITING_FOR_APPROVAL: Approve / Edit / Reject)', completed: flags[2] },
  { id: 'execute_and_verify', title: '4. التنفيذ والتحقق المستقل (Execute & Independently Verify)', completed: flags[3] }
];
const PLAN = (flags, state, transitions) => ({
  version: 'plan-v1',
  revision: 1,
  state,
  transitions,
  stages: STAGES(flags),
  objective: 'استخرج بيانات الفاتورة',
  successCriteria: [],
  constraints: [],
  dependencies: [],
  toolName: null,
  risk: null,
  payload: null,
  pendingApprovalId: null,
  outboxId: null,
  outboxStatus: null,
  editCount: 0,
  verificationVerdict: null
});
const step = (index, kind, title, extra = {}) => ({
  id: `s${index}`,
  runId: 'run',
  index,
  kind,
  title,
  summary: extra.summary ?? null,
  toolName: extra.toolName ?? null,
  createdAt: at(100 * index),
  startedAt: at(100 * index),
  finishedAt: extra.finishedAt ?? null,
  durationMs: extra.durationMs ?? null,
  toolRunId: extra.toolRunId ?? null,
  toolRunStatus: extra.toolRunStatus ?? null
});
const openSteps = [
  step(1, 'decide', 'فهم الطلب', { summary: 'عقد الهدف جاهز' }),
  step(2, 'act', 'kb.search', { toolName: 'kb.search', summary: 'بحث في شبكة المعرفة', toolRunId: 't1', toolRunStatus: 'started' })
];
const settledAct = { ...openSteps[1], finishedAt: at(242), durationMs: 42, toolRunStatus: 'succeeded' };
const doneSteps = [
  openSteps[0],
  settledAct,
  step(3, 'observe', 'kb.search ✓', { toolName: 'kb.search', summary: '{"hits":2}' }),
  step(4, 'verify', 'تحقق مستقل', { summary: 'PASS' }),
  step(5, 'deliver', 'تسليم', { summary: 'مسودة مخطط جاهزة من بيانات الفاتورة.' })
];
const runRecord = (id, status, usage, extra = {}) => ({
  id,
  threadId: 'thr-e2e',
  ownerId: 'owner',
  status,
  planner: 'demo',
  limits: LIMITS,
  usage,
  cancelRequested: false,
  createdAt: at(0),
  updatedAt: at(extra.updatedMs ?? 150),
  finishedAt: extra.finishedAt ?? null,
  lastError: null
});
const sse = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
const baseDetail = (runId) => ({
  goalContract: null,
  approvals: [],
  outbox: [],
  evidence: [],
  evidenceChain: { ok: true, count: 0 },
  truthPartition: null,
  verification: null,
  toolRuns: [{ id: 't1', runId, stepId: 's2', toolName: 'kb.search', risk: 'read', status: 'started', outcome: null, createdAt: at(200), updatedAt: at(200), durationMs: null }]
});
const liveSnapshot = (runId) => ({
  type: 'snapshot',
  runId,
  at: at(300),
  run: runRecord(runId, 'running', { steps: 2, costMicros: 0, tokens: 0 }),
  plan: PLAN([true, true, false, false], 'EXECUTING', ['PLAN_READY', 'EXECUTING']),
  now: { state: 'executing_tool', status: 'running', stepId: 's2', stepIndex: 2, toolName: 'kb.search', since: at(200), elapsedMs: 100, totalMs: 300 },
  steps: openSteps,
  ...baseDetail(runId)
});
const finishedRun = runRecord('run-done', 'succeeded', { steps: 5, costMicros: 0, tokens: 0 }, { updatedMs: 4200, finishedAt: at(4200) });
const finishedDetail = {
  run: finishedRun,
  plan: PLAN([true, true, false, true], 'EXECUTING', ['PLAN_READY', 'EXECUTING']),
  now: { state: 'finished', status: 'succeeded', stepId: 's5', stepIndex: 5, toolName: null, since: at(4200), elapsedMs: null, totalMs: 4200, terminal: true },
  steps: doneSteps,
  ...baseDetail('run-done'),
  verification: { seq: 3, verdict: 'PASS', at: at(400), hash: 'a'.repeat(64) },
  toolRuns: [{ id: 't1', runId: 'run-done', stepId: 's2', toolName: 'kb.search', risk: 'read', status: 'succeeded', outcome: { hits: 2 }, createdAt: at(200), updatedAt: at(242), durationMs: 42 }]
};
const stepEvent = (index, extra = {}) => ({
  type: 'step',
  runId: 'run-done',
  at: at(100 * index),
  step: doneSteps[index - 1],
  settledStep: extra.settledStep ?? null,
  status: 'running',
  usage: { steps: index, costMicros: 0, tokens: 0 },
  limits: LIMITS,
  now: extra.now
});
const doneStream = sse([
  liveSnapshot('run-done'),
  stepEvent(3, { settledStep: settledAct, now: { state: 'planning', status: 'running', stepId: 's3', stepIndex: 3, toolName: null, since: at(300), elapsedMs: 0, totalMs: 300 } }),
  stepEvent(4, { now: { state: 'planning', status: 'running', stepId: 's4', stepIndex: 4, toolName: null, since: at(400), elapsedMs: 0, totalMs: 400 } }),
  stepEvent(5, { now: { state: 'planning', status: 'running', stepId: 's5', stepIndex: 5, toolName: null, since: at(500), elapsedMs: 0, totalMs: 500 } }),
  { type: 'run.finished', runId: 'run-done', at: at(4200), status: 'succeeded', run: finishedRun }
]);

async function mockAgentApi(page) {
  let threadCreated = false;
  let runsStarted = 0;
  let memory = { summaries: [], facts: [] };
  const json = (route, body, status = 200) =>
    route.fulfill({ status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });
  await page.route('**/api/agent/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();
    if (pathname.endsWith('/api/agent/status')) {
      return json(route, {
        enabled: true,
        mode: 'sqlite',
        dialect: 'sqlite',
        planner: 'demo',
        verifier: 'rules-v1',
        approvalGate: true,
        connectors: [],
        limits: LIMITS,
        tools: [],
        durable: true,
        note: 'e2e: استجابات معترَضة بعقد الخادم الحقيقي'
      });
    }
    if (pathname.endsWith('/api/agent/memory')) {
      if (method === 'GET') return json(route, memory);
      if (method === 'DELETE') {
        const body = request.postDataJSON();
        memory = {
          summaries: body.kind === 'summary' ? memory.summaries.filter((item) => item.id !== body.id) : memory.summaries,
          facts: body.kind === 'fact' ? memory.facts.filter((item) => item.id !== body.id) : memory.facts
        };
        return json(route, { deleted: true, kind: body.kind, id: body.id, sourceRunId: 'run-done' });
      }
    }
    if (pathname.endsWith('/api/agent/threads') && method === 'GET') {
      return json(route, { threads: threadCreated ? [{ id: 'thr-e2e', title: 'مهمة جديدة', createdAt: at(0) }] : [] });
    }
    if (pathname.endsWith('/api/agent/threads') && method === 'POST') {
      threadCreated = true;
      return json(route, { thread: { id: 'thr-e2e', title: 'مهمة جديدة', createdAt: at(0) } }, 201);
    }
    if (pathname.endsWith('/threads/thr-e2e/runs') && method === 'POST') {
      runsStarted += 1;
      const runId = runsStarted === 1 ? 'run-live' : 'run-done';
      return json(route, { runId, status: 'queued', duplicate: false, eventsUrl: `/api/agent/runs/${runId}/events` }, 202);
    }
    if (pathname.endsWith('/runs/run-live/events')) {
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }, body: sse([liveSnapshot('run-live')]) });
    }
    if (pathname.endsWith('/runs/run-done/events')) {
      memory = {
        summaries: [{ id: 'memory-summary-e2e', threadId: 'thr-e2e', sourceRunId: 'run-done', summary: 'حالة التشغيل الأخير: succeeded.\nآخر نتيجة محفوظة: مسودة مخطط جاهزة.', createdAt: at(4200), updatedAt: at(4200), expiresAt: null }],
        facts: [{ id: 'memory-fact-e2e', ownerId: 'owner', sourceRunId: 'run-done', tag: 'owner.last_result', value: 'مسودة مخطط جاهزة.', createdAt: at(4200), updatedAt: at(4200), expiresAt: null }]
      };
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }, body: doneStream });
    }
    if (pathname.endsWith('/runs/run-done')) {
      return json(route, finishedDetail);
    }
    if (pathname.endsWith('/runs/run-live')) {
      return json(route, { ...liveSnapshot('run-live'), type: undefined });
    }
    // B2: قسم «الملفات الناتجة» يجلب artifacts بعد كل تحديث تفاصيل — التشغيل المنتهي
    // يعرض ملفًا واحدًا برابط موقّع، وما عداه قائمة فارغة (المخزن مفعّل بلا نواتج).
    if (method === 'GET' && /\/runs\/[^/]+\/artifacts$/.test(pathname)) {
      if (pathname.includes('run-done')) {
        return json(route, {
          enabled: true,
          urlTtlMs: 900000,
          artifacts: [{
            id: 'art-e2e-1',
            runId: 'run-done',
            name: 'report.html',
            bytes: 2048,
            sha256: 'a'.repeat(64),
            createdAt: at(4200),
            download: {
              path: `/api/agent/artifacts/art-e2e-1/download?exp=99999999999999&sig=${'b'.repeat(64)}`,
              exp: 99999999999999,
              expiresAt: '2026-10-30T00:00:00.000Z'
            }
          }]
        });
      }
      return json(route, { enabled: true, urlTtlMs: 900000, artifacts: [] });
    }
    return json(route, { error: `unmocked ${method} ${pathname}` }, 500);
  });
}

test.describe('أثر التنفيذ في /agent (WP-1.2): شجرة الخطة، سطر «الآن»، شريط الميزانية — من بيانات التشغيل فقط', () => {
  test('حدث SSE يظهر خلال أقل من ثانية؛ العقد تعكس PLAN_READY→EXECUTING ثم الانتهاء؛ 320px بلا تمرير أفقي؛ بلا انتهاكات WCAG', async ({ page }, testInfo) => {
    const { diagnostics, flush } = attachChromiumDiagnostics(page);
    try {
      await mockAgentApi(page);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${LIVE}/agent`, { waitUntil: 'networkidle' });
      await expect(page.locator('#now-line')).toHaveText('لا تشغيل');
      await expect(page.locator('#bar-steps')).toHaveAttribute('aria-valuenow', '0');

      await page.fill('#token', TOKEN);
      await page.click('#connect');
      await expect(page.locator('#auth-status')).toContainText('متصل — الوكيل جاهز');
      await expect(page.locator('#fact-steps')).toHaveText('12');

      // التشغيل الأول: البث يصل بلقطة واحدة والأداة ما زالت تعمل — السطر «الآن» والعقدة «قيد التنفيذ» خلال < 1 ث.
      await page.fill('#message', 'استخرج بيانات الفاتورة invoice-valid-1042.csv');
      const clickedAt = Date.now();
      await page.click('#run');
      await expect(page.locator('#now-line')).toContainText('الآن: ينفّذ kb.search منذ', { timeout: 1000 });
      expect(Date.now() - clickedAt).toBeLessThan(1000);
      await expect(page.locator('#now-line')).toHaveAttribute('data-state', 'executing_tool');
      const actNode = page.locator('#steps li[data-index="2"]');
      await expect(actNode).toHaveAttribute('data-node', 'running');
      await expect(actNode).toContainText('قيد التنفيذ');
      await expect(actNode).toContainText('الزمن: —');
      await expect(page.locator('#plan-tree li[data-stage="understand"]')).toHaveAttribute('data-status', 'done');
      await expect(page.locator('#plan-tree li[data-stage="plan"]')).toHaveAttribute('data-status', 'done');
      await expect(page.locator('#plan-tree li[data-stage="present_and_wait"]')).toHaveAttribute('data-status', 'current');
      await expect(page.locator('#plan-tree li[data-stage="execute_and_verify"]')).toHaveAttribute('data-status', 'pending');
      await expect(page.locator('#plan-tree li.transitions')).toContainText('PLAN_READY → EXECUTING');
      await expect(page.locator('#bar-steps')).toHaveAttribute('aria-valuenow', '17'); // 2 / 12
      await expect(page.locator('#limit-steps')).toHaveText('12');
      await expect(page.locator('#limit-cost')).toHaveText('100000');
      await expect(page.locator('#bar-cost')).toHaveAttribute('aria-valuenow', '0');

      // التشغيل الثاني: البث يحمل خطوات لاحقة؛ خطوة act تُستكمل بمدتها المُثبَتة من settledStep، ثم الانتهاء بالتفاصيل.
      await page.click('#run');
      await expect(page.locator('#now-line')).toContainText('انتهى (نُفذ) — الإجمالي 4.2 ث', { timeout: 5000 });
      await expect(page.locator('#now-line')).toHaveAttribute('data-state', 'finished');
      await expect(page.locator('#run-state')).toHaveText('نُفذ');
      const settledNode = page.locator('#steps li[data-index="2"]');
      await expect(settledNode).toHaveAttribute('data-node', 'done');
      await expect(settledNode).toContainText('الزمن: 42 ms');
      await expect(page.locator('#steps li[data-index="5"]')).toHaveAttribute('data-node', 'done');
      await expect(page.locator('#steps li[data-index="4"]')).toContainText('الزمن: —');
      await expect(page.locator('#plan-tree li[data-stage="present_and_wait"]')).toHaveAttribute('data-status', 'skipped');
      await expect(page.locator('#plan-tree li[data-stage="execute_and_verify"]')).toHaveAttribute('data-status', 'done');
      await expect(page.locator('#plan-tree li[data-stage="execute_and_verify"]')).toContainText('زمن الأدوات المُثبَت 42 ms');
      await expect(page.locator('#bar-steps')).toHaveAttribute('aria-valuenow', '42'); // 5 / 12
      await expect(page.locator('#delivery')).toBeVisible();
      await expect(page.locator('#verification-badge')).toContainText('PASS');

      // B2: الملف الناتج يظهر بزر تنزيل موقّع — البصمة المختصرة والرابط من بيانات التشغيل فقط.
      await expect(page.locator('#artifacts-badge')).toHaveText('1');
      await expect(page.locator('#artifacts li')).toContainText('report.html');
      await expect(page.locator('#artifacts a')).toHaveAttribute(
        'href',
        /\/api\/agent\/artifacts\/art-e2e-1\/download\?exp=\d+&sig=[0-9a-f]{64}$/
      );

      await expectNoA11yViolations(page);

      await page.setViewportSize({ width: 320, height: 640 });
      const overflow320 = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow320).toBeLessThanOrEqual(1);
      await expectNoA11yViolations(page);

      expect(diagnostics, diagnostics.join('\n')).toEqual([]);
    } finally {
      await flush(testInfo);
    }
  });
});

test.describe('WP-2.3: قسم «ما يتذكره الوكيل» يعرض ويحذف الذاكرة من مسار المالك', () => {
  test('الملخص والحقيقة يظهران بعد run.finished ويختفيان بعد الحذف النهائي', async ({ page }, testInfo) => {
    const { diagnostics, flush } = attachChromiumDiagnostics(page);
    try {
      await mockAgentApi(page);
      await page.setViewportSize({ width: 320, height: 640 });
      await page.goto(`${LIVE}/agent`, { waitUntil: 'networkidle' });
      await page.fill('#token', TOKEN);
      await page.click('#connect');
      await expect(page.locator('#auth-status')).toContainText('متصل — الوكيل جاهز');
      await page.fill('#message', 'استخرج بيانات الفاتورة');
      await page.click('#run');
      await expect(page.locator('#now-line')).toHaveAttribute('data-state', 'executing_tool');
      await page.click('#run');
      await expect(page.locator('#memory-summaries')).toContainText('مسودة مخطط جاهزة', { timeout: 5000 });
      await expect(page.locator('#memory-facts')).toContainText('owner.last_result');
      await page.locator('#memory-facts button[data-memory-kind="fact"]').click();
      await expect(page.locator('#memory-facts')).toContainText('لا حقائق محفوظة');
      await page.locator('#memory-summaries button[data-memory-kind="summary"]').click();
      await expect(page.locator('#memory-summaries')).toContainText('لا ملخصات محفوظة');
      await expectNoA11yViolations(page);
      expect(diagnostics, diagnostics.join('\\n')).toEqual([]);
    } finally {
      await flush(testInfo);
    }
  });
});

test.describe('سمات الواجهة (WP-1.3، UX-003): تتبع النظام افتراضيًا، ثلاث سمات بلا انتهاك تباين، الاختيار يبقى، والحركة المخفَّضة تُحترم', () => {
  const textColour = (page) => page.evaluate(() => getComputedStyle(document.body).color);
  const colourScheme = (page) => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  const token = (page, name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

  test('بلا اختيار مخزّن تتبع الصفحة prefers-color-scheme (فاتح ثم داكن) قبل الرسم وبلا انتهاكات WCAG', async ({ page }, testInfo) => {
    const { diagnostics, flush } = attachChromiumDiagnostics(page);
    try {
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto(`${LIVE}/agent`, { waitUntil: 'networkidle' });
      await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
      await expect(page.locator('html')).toHaveAttribute('data-theme-resolved', 'light');
      expect(await colourScheme(page)).toBe('light');
      expect(await textColour(page)).toBe('rgb(18, 26, 51)'); // --t-text (light) = #121a33
      expect(await token(page, '--t-bg')).toBe('#f4f6fb');
      await expect(page.locator('select[data-theme-switcher]')).toHaveValue('system');
      await expectNoA11yViolations(page);

      await page.emulateMedia({ colorScheme: 'dark' });
      await page.reload({ waitUntil: 'networkidle' });
      await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
      await expect(page.locator('html')).toHaveAttribute('data-theme-resolved', 'dark');
      expect(await colourScheme(page)).toBe('dark');
      expect(await textColour(page)).toBe('rgb(232, 236, 255)'); // --t-text (dark) = #e8ecff
      expect(await page.evaluate(() => localStorage.getItem('celia_theme'))).toBeNull();
      expect(diagnostics, diagnostics.join('\n')).toEqual([]);
    } finally {
      await flush(testInfo);
    }
  });

  test('المبدّل المشترك: كل سمة (light/dark/oled) تمرّ axe مع محتوى تشغيل حقيقي؛ الاختيار يبقى بعد إعادة التحميل وعبر /kb و/cron', async ({ page }, testInfo) => {
    const { diagnostics, flush } = attachChromiumDiagnostics(page);
    try {
      await mockAgentApi(page);
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.goto(`${LIVE}/agent`, { waitUntil: 'networkidle' });
      await page.fill('#token', TOKEN);
      await page.click('#connect');
      await expect(page.locator('#auth-status')).toContainText('متصل — الوكيل جاهز');
      await page.fill('#message', 'استخرج بيانات الفاتورة invoice-valid-1042.csv');
      await page.click('#run');
      await expect(page.locator('#now-line')).toHaveAttribute('data-state', 'executing_tool');
      await page.click('#run');
      await expect(page.locator('#now-line')).toHaveAttribute('data-state', 'finished', { timeout: 5000 });
      await expect(page.locator('#verification-badge')).toContainText('PASS');

      const expectations = {
        light: { scheme: 'light', bg: '#f4f6fb', text: 'rgb(18, 26, 51)' },
        dark: { scheme: 'dark', bg: '#0b1020', text: 'rgb(232, 236, 255)' },
        oled: { scheme: 'dark', bg: '#000000', text: 'rgb(242, 242, 242)' }
      };
      for (const theme of ['light', 'dark', 'oled']) {
        await page.selectOption('select[data-theme-switcher]', theme);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.locator('html')).toHaveAttribute('data-theme-resolved', theme);
        expect(await colourScheme(page)).toBe(expectations[theme].scheme);
        expect(await token(page, '--t-bg')).toBe(expectations[theme].bg);
        expect(await textColour(page)).toBe(expectations[theme].text);
        // صفر انتهاكات لكل سمة — بما فيها color-contrast على الشارات والعقد والأزرار بمحتوى التشغيل المعروض.
        await expectNoA11yViolations(page);
      }

      // الاختيار الأخير (oled) يبقى بعد إعادة التحميل ويُطبَّق قبل الرسم في الصفحات الشقيقة.
      await page.reload({ waitUntil: 'networkidle' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'oled');
      await expect(page.locator('select[data-theme-switcher]')).toHaveValue('oled');
      expect(await page.evaluate(() => localStorage.getItem('celia_theme'))).toBe('oled');
      for (const path of ['/kb', '/cron']) {
        await page.goto(`${LIVE}${path}`, { waitUntil: 'networkidle' });
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'oled');
        expect(await token(page, '--t-bg')).toBe('#000000');
        await expect(page.locator('select[data-theme-switcher]')).toHaveValue('oled');
        await expectNoA11yViolations(page);
      }
      // العودة إلى «يتبع النظام» تزيل المفتاح والسمة الصريحة.
      await page.selectOption('select[data-theme-switcher]', 'system');
      await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
      expect(await page.evaluate(() => localStorage.getItem('celia_theme'))).toBeNull();
      await page.selectOption('select[data-theme-switcher]', 'light');
      await page.goto(`${LIVE}/kb`, { waitUntil: 'networkidle' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await expectNoA11yViolations(page);

      expect(diagnostics, diagnostics.join('\n')).toEqual([]);
    } finally {
      await flush(testInfo);
    }
  });

  // WA-005 انحدار حقيقي: إضافة رابط «ربط واتساب» جعلت الشريط يتجاوز العرض عند 412px
  // (Pixel 7) فيُدفَع زر الاتصال خارج الشاشة. فحص 320px وحده لم يكن كافيًا لأن الالتفاف
  // كان مقيّدًا بـ max-width:360px. نثبّت العرض الذي انكسر فعليًا ونقيس الإصابة لا العرض فقط.
  test('شريط التنقل لا يدفع أدوات التحكم خارج الشاشة عند 361–530px (انحدار رابط واتساب)', async ({ page }, testInfo) => {
    const { diagnostics, flush } = attachChromiumDiagnostics(page);
    try {
      for (const width of [361, 412, 480, 530]) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`${LIVE}/agent`, { waitUntil: 'networkidle' });
        const measured = await page.evaluate(() => {
          const button = document.querySelector('#connect');
          const box = button.getBoundingClientRect();
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return {
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            insideViewport: box.x >= 0 && box.right <= window.innerWidth,
            clickable: hit === button || button.contains(hit)
          };
        });
        expect(measured.overflow, `عرض ${width}px`).toBeLessThanOrEqual(1);
        expect(measured.insideViewport, `زر الاتصال داخل العرض ${width}px`).toBe(true);
        expect(measured.clickable, `زر الاتصال قابل للنقر عند ${width}px`).toBe(true);
      }
      expect(diagnostics, diagnostics.join('\n')).toEqual([]);
    } finally {
      await flush(testInfo);
    }
  });

  test('prefers-reduced-motion: reduce يلغي الانتقالات (مقاسة من الأنماط المحسوبة، قبل وبعد)', async ({ page }, testInfo) => {
    const { diagnostics, flush } = attachChromiumDiagnostics(page);
    try {
      const transitionOf = (selector) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).transitionDuration, selector);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.goto(`${LIVE}/agent`, { waitUntil: 'networkidle' });
      expect(await transitionOf('#connect')).toBe('0.12s, 0.12s');

      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.reload({ waitUntil: 'networkidle' });
      expect(await transitionOf('#connect')).toBe('0s');
      expect(await transitionOf('.bar-fill')).toBe('0s');
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
      expect(diagnostics, diagnostics.join('\n')).toEqual([]);
    } finally {
      await flush(testInfo);
    }
  });
});

/**
 * L1 (U2 · U5 · U3) — لوحات الواجهة الثلاث في متصفح حقيقي.
 *
 * الخادم معترض بمسارات موجودة فعلًا (`/threads`, `/threads/:id`, `/attention`,
 * `/runs/:id/artifacts`, `/artifacts/:id/download`) — لا مسار جديد اخترعته الواجهة.
 * الهدف منطق الصفحة الحقيقي: ما يُرسم من السجل فقط، والرفض المسمّى، وبلا تمرير أفقي.
 */
const L1_THREADS = [
  { id: 'thr-a1', ownerId: 'owner', title: 'تقرير المبيعات الأسبوعي', status: 'active', createdAt: at(0), updatedAt: at(5000) },
  { id: 'thr-b2', ownerId: 'owner', title: 'مراجعة حالة النظام', status: 'active', createdAt: at(0), updatedAt: at(1000) }
];
const L1_DETAIL = {
  thread: L1_THREADS[0],
  messages: [
    { id: 'm1', threadId: 'thr-a1', role: 'user', content: 'جهّز تقرير المبيعات <b>بدون</b> أرقام مخترعة', clientMessageId: 'c1', createdAt: at(100) },
    { id: 'm2', threadId: 'thr-a1', role: 'ghost_role', content: 'دور غير مسمّى يبقى كما هو', clientMessageId: null, createdAt: at(200) }
  ],
  runs: [{ id: 'run-done', threadId: 'thr-a1', ownerId: 'owner', status: 'succeeded', planner: 'demo', planSummary: 'ثلاث خطوات', limits: LIMITS, usage: { steps: 3, costMicros: 0, tokens: 0 } }]
};
const L1_ATTENTION = {
  version: '1',
  now: at(6000),
  total: 2,
  counts: { decision: 1, ambiguous: 1, failure: 0, info: 0 },
  owed: 2,
  clear: false,
  items: [
    { id: 'approval:ap-1', reason: 'approval_pending', severity: 'decision', ar: 'موافقة تنتظر قرارك', en: 'an approval is waiting for you', runId: 'run-done', since: at(3000), waitingMs: 300000, title: null, evidence: { approvalId: 'ap-1' }, next: 'decide', source: 'approval_pending' },
    { id: 'run:run-done', reason: 'outbox_unknown', severity: 'ambiguous', ar: 'أثر خارجي غير محسوم', en: 'an external effect is unresolved', runId: 'run-done', since: at(3500), waitingMs: 2500, title: null, evidence: { outboxId: 'ob-1' }, next: 'reconcile', source: 'outbox_unknown' }
  ],
  dropped: [],
  sends: false,
  tracksRead: false,
  digest: 'e2edigest0001'
};
const L1_ARTIFACTS = {
  enabled: true,
  urlTtlMs: 900000,
  artifacts: [
    { id: 'art-md', runId: 'run-done', name: 'report.md', bytes: 96, sha256: 'c'.repeat(64), createdAt: at(4200), download: { path: '/api/agent/artifacts/art-md/download?exp=99999999999999&sig=' + 'd'.repeat(64), exp: 99999999999999, expiresAt: '2026-12-30T00:00:00.000Z' } },
    { id: 'art-html', runId: 'run-done', name: 'page.html', bytes: 64, sha256: 'e'.repeat(64), createdAt: at(4300), download: { path: '/api/agent/artifacts/art-html/download?exp=99999999999999&sig=' + 'f'.repeat(64), exp: 99999999999999, expiresAt: '2026-12-30T00:00:00.000Z' } }
  ]
};

async function mockConsolePanels(page) {
  const json = (route, body, status = 200) =>
    route.fulfill({ status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });
  await page.route('**/api/agent/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    if (pathname.endsWith('/api/agent/status')) {
      return json(route, { enabled: true, mode: 'sqlite', dialect: 'sqlite', planner: 'demo', verifier: 'rules-v1', approvalGate: true, connectors: [], limits: LIMITS, tools: [], durable: true, note: 'e2e L1' });
    }
    if (pathname.endsWith('/api/agent/memory') && method === 'GET') return json(route, { summaries: [], facts: [] });
    if (pathname.endsWith('/api/agent/threads') && method === 'GET') return json(route, { threads: L1_THREADS });
    if (pathname.endsWith('/api/agent/threads/thr-a1') && method === 'GET') return json(route, L1_DETAIL);
    if (pathname.endsWith('/api/agent/attention') && method === 'GET') return json(route, L1_ATTENTION);
    if (method === 'GET' && /\/runs\/[^/]+\/artifacts$/.test(pathname)) return json(route, L1_ARTIFACTS);
    if (pathname.includes('/artifacts/art-md/download')) {
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8' }, body: '# عنوان التقرير\n\nنص **عريض** و`شفرة`\n\n- بند\n' });
    }
    return json(route, { error: `unmocked ${method} ${pathname}` }, 500);
  });
}

test.describe('لوحات L1 في /agent: سجل المحادثات (U2) · صندوق المهام (U5) · معاينة المخرجات (U3)', () => {
  test('السجل يعرض الخيوط ورسائلها من المسارات القائمة، والتصفية محلية وصادقة، وبلا تمرير أفقي ولا انتهاك WCAG', async ({ page }, testInfo) => {
    const { diagnostics, flush } = attachChromiumDiagnostics(page);
    try {
      await mockConsolePanels(page);
      await page.setViewportSize({ width: 320, height: 720 });
      await page.goto(`${LIVE}/agent`, { waitUntil: 'networkidle' });
      await page.fill('#token', TOKEN);
      await page.click('#connect');
      await expect(page.locator('#auth-status')).toContainText('متصل');

      // U2: الخيطان كما في السجل، والحدّ المعلن هو حدّ الخادم نفسه.
      await expect(page.locator('#history-badge')).toHaveText('2 / 2');
      await expect(page.locator('#history-list .thread-open')).toHaveCount(2);
      await expect(page.locator('#history-limit')).toHaveText('20');
      await expect(page.locator('#history-list')).toContainText('تقرير المبيعات الأسبوعي');

      // اختيار خيط يمرّ بمسار التفاصيل القائم — الرسائل تُعرض مُهرَّبة، والدور غير
      // المسمّى يُطبع كما هو، ولا يُخترع رد وكيل.
      await page.click('#history-list .thread-open[data-thread-id="thr-a1"]');
      await expect(page.locator('#history-detail')).toContainText('جهّز تقرير المبيعات');
      await expect(page.locator('#history-detail')).toContainText('ghost_role');
      const injected = await page.locator('#history-detail b').count();
      expect(injected, 'message markup is escaped, not parsed').toBe(0);

      // التصفية محلية في ما حُمِّل، والفشل يُعلن نطاقه لا يخفيه.
      await page.fill('#history-filter', 'مبيعات');
      await expect(page.locator('#history-list .thread-open')).toHaveCount(1);
      await expect(page.locator('#history-badge')).toHaveText('1 / 2');
      await page.fill('#history-filter', 'لا يوجد كهذا');
      await expect(page.locator('#history-list')).toContainText('لا خيط يطابق');
      await expect(page.locator('#history-list')).toContainText('ضمن آخر 2 خيطًا محمّلًا');
      await page.fill('#history-filter', '');

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow).toBeLessThanOrEqual(1);
      await page.setViewportSize({ width: 1280, height: 900 });
      await expectNoA11yViolations(page);
      expect(diagnostics, diagnostics.join('\n')).toEqual([]);
    } finally {
      await flush(testInfo);
    }
  });

  test('صندوق المهام يجمّع بلا إعادة ترتيب ولا تخفيف شدة، ويعرض معرّف الدليل وsends/tracksRead كما هي', async ({ page }, testInfo) => {
    const { diagnostics, flush } = attachChromiumDiagnostics(page);
    try {
      await mockConsolePanels(page);
      await page.setViewportSize({ width: 320, height: 720 });
      await page.goto(`${LIVE}/agent`, { waitUntil: 'networkidle' });
      await page.fill('#token', TOKEN);
      await page.click('#connect');
      await expect(page.locator('#auth-status')).toContainText('متصل');

      await expect(page.locator('#inbox-badge')).toHaveText('2 مستحق');
      const groups = page.locator('#inbox-list .inbox-group');
      await expect(groups).toHaveCount(2);
      // ترتيب الخادم (decision قبل ambiguous) survives التجميع.
      await expect(groups.nth(0)).toContainText('قرار مطلوب · 1');
      await expect(groups.nth(1)).toContainText('غير محسوم · 1');
      await expect(page.locator('#inbox-list')).toContainText('approval:ap-1');
      await expect(page.locator('#inbox-list')).toContainText('approvalId=ap-1');
      await expect(page.locator('#inbox-list')).toContainText('منتظر 5 دقيقة');
      // البند الثاني انتظر 2.5 ثانية: أقل من دقيقة تُسمّى كذلك، لا «0 دقيقة».
      await expect(page.locator('#inbox-list')).toContainText('منتظر أقل من دقيقة');
      await expect(page.locator('#inbox-flags')).toHaveText('sends=false · tracksRead=false');
      await expect(page.locator('#inbox-summary')).toContainText('المجموع 2');
      await expect(page.locator('#inbox-summary')).toContainText('e2edigest000');

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow).toBeLessThanOrEqual(1);
      await page.setViewportSize({ width: 1280, height: 900 });
      await expectNoA11yViolations(page);
      expect(diagnostics, diagnostics.join('\n')).toEqual([]);
    } finally {
      await flush(testInfo);
    }
  });

  test('معاينة المخرجات: Markdown يُعرض مُهرَّبًا داخل الصفحة، وHTML يُرفض رفضًا مسمّى قبل أي جلب', async ({ page }, testInfo) => {
    const { diagnostics, flush } = attachChromiumDiagnostics(page);
    try {
      await mockConsolePanels(page);
      // U3 يحتاج تشغيلًا: نعترض تفاصيل التشغيل المنتهي نفسه المستعمل في بقية الاختبارات.
      await page.route('**/api/agent/runs/run-done', (route) =>
        route.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(finishedDetail) })
      );
      await page.setViewportSize({ width: 320, height: 720 });
      await page.goto(`${LIVE}/agent`, { waitUntil: 'networkidle' });
      await page.fill('#token', TOKEN);
      await page.click('#connect');
      await expect(page.locator('#auth-status')).toContainText('متصل');
      await page.click('#history-list .thread-open[data-thread-id="thr-a1"]');
      await expect(page.locator('#artifacts-badge')).toHaveText('2');

      // الرفض قبل الجلب: الزر معطّل وعليه السبب المسمّى، ولا طلب يخرج.
      let downloadCalls = 0;
      await page.route('**/api/agent/artifacts/**', (route) => {
        downloadCalls += 1;
        return route.continue();
      });
      const refused = page.locator('.preview-toggle[data-artifact-id="art-html"]');
      await expect(refused).toBeDisabled();
      await expect(refused).toHaveText('لا معاينة');
      await expect(refused).toHaveAttribute('data-reason', 'html_not_rendered');

      // المسموح يُعرض داخل الصفحة عبر الرابط الموقّع نفسه.
      await page.click('.preview-toggle[data-artifact-id="art-md"]');
      await expect(page.locator('#artifact-preview')).toBeVisible();
      await expect(page.locator('#preview-body h4')).toHaveText('عنوان التقرير');
      await expect(page.locator('#preview-body strong')).toHaveText('عريض');
      await expect(page.locator('#preview-body code')).toHaveText('شفرة');
      await expect(page.locator('#preview-note')).toContainText('Markdown subset مغلق');
      expect(await page.locator('#preview-body h1, #preview-body h2, #preview-body h3').count()).toBe(0);
      expect(downloadCalls, 'the signed download route is the only byte source').toBe(1);

      await page.click('#preview-close');
      await expect(page.locator('#artifact-preview')).toBeHidden();

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow).toBeLessThanOrEqual(1);
      await page.setViewportSize({ width: 1280, height: 900 });
      await expectNoA11yViolations(page);
      expect(diagnostics, diagnostics.join('\n')).toEqual([]);
    } finally {
      await flush(testInfo);
    }
  });

  test('النسخة الثابتة تعلن أن اللوحتين بلا خادم بدل «…» معلّقة توحي بجلب', async ({ page }, testInfo) => {
    const { diagnostics, flush } = attachChromiumDiagnostics(page);
    try {
      await page.setViewportSize({ width: 320, height: 720 });
      await page.goto(`${STATIC}/agent.html`, { waitUntil: 'networkidle' });
      await expect(page.locator('#history-badge')).toHaveText('نسخة ثابتة');
      await expect(page.locator('#inbox-badge')).toHaveText('نسخة ثابتة');
      await expect(page.locator('#history-list')).toContainText('لا سجل محادثات هنا');
      await expect(page.locator('#inbox-list')).toContainText('لا صندوق مهام هنا');
      await expect(page.locator('#inbox-summary')).toContainText('نسخة ثابتة بلا خادم');
      await expect(page.locator('#history-filter')).toBeDisabled();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow).toBeLessThanOrEqual(1);
      await expectNoA11yViolations(page);
      expect(diagnostics, diagnostics.join('\n')).toEqual([]);
    } finally {
      await flush(testInfo);
    }
  });
});
