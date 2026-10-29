import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSqliteDriver } from './drivers.js';
import { createAgentStore } from './store.js';
import { createAgentRuntime } from './runtime.js';
import { createToolRegistry, defaultToolDefinitions } from './tools.js';
import { createArtifactStore } from './artifact-store.js';
import { renderTemplate } from './output-templates.js';

/**
 * M-B/B3 — بوابة المهام الذهبية الثلاث لقوالب المخرجات.
 *
 * كل مهمة تمر عبر الحلقة الحقيقية كاملة (مخزن SQLite دائم مؤقت، سجل أدوات حقيقي،
 * مخزن artifacts حقيقي، سلسلة أدلة حقيقية) — لا تصيير مباشر خارج الحلقة.
 * القبول ببصمة SHA-256 **مثبتة حرفيًا** لكل مخرج: أي انحراف بايت واحد في القالب
 * يُفشل البوابة. (مجموعة AI-001 المجمّدة ببصمتها تبقى كما هي عمدًا — هذه بوابة
 * مستقلة لنوع مخرجات مختلف، لا تعديل على `eval:ai` القائم.)
 */

export const TEMPLATE_GOLDEN_TASKS = Object.freeze([
  {
    id: 'B3-G1',
    title: 'تقرير Markdown→HTML',
    tool: 'template.render',
    args: {
      kind: 'markdown_report',
      name: 'weekly-report.html',
      spec: {
        title: 'التقرير الأسبوعي للعمليات',
        sections: [
          {
            heading: 'الملخص التنفيذي',
            body: 'أُنجزت **12 مهمة** هذا الأسبوع عبر الحلقة المحكومة.\n\n- صفر كتابات خارجية بلا موافقة\n- سلسلة الأدلة سليمة في كل تشغيل'
          },
          {
            heading: 'المقاييس',
            body: '## الأرقام\nالوسيط `p50` ثابت تحت الحد.\n\n- نجاح: 12/12\n- إعادة إرسال عمياء: 0'
          }
        ]
      }
    }
  },
  {
    id: 'B3-G2',
    title: 'جدول CSV',
    tool: 'template.render',
    args: {
      kind: 'csv_table',
      name: 'products.csv',
      spec: {
        columns: ['sku', 'الاسم', 'السعر', 'المخزون'],
        rows: [
          ['P-100', 'حقيبة جلدية', '450', '7'],
          ['P-200', 'قميص قطني, مقاس L', '120', '31'],
          ['P-300', 'كوب "سيليا"', '60', '0']
        ]
      }
    }
  },
  {
    id: 'B3-G3',
    title: 'صفحة ويب ثابتة واحدة',
    tool: 'template.render',
    args: {
      kind: 'static_page',
      name: 'launch.html',
      spec: {
        title: 'إطلاق المتجر',
        body: '# العرض\nافتتاح المتجر **السبت** القادم.\n\n## ماذا ستجد\n- منتجات جلدية يدوية\n- شحن لكل المحافظات\n\nللتواصل: `celia.store`'
      }
    }
  }
]);

/** البصمات الذهبية تُشتق حتميًا من القوالب نفسها وتُثبَّت في بوابة CI المرافقة. */
export function goldenDigests() {
  return TEMPLATE_GOLDEN_TASKS.map((task) => ({
    id: task.id,
    sha256: renderTemplate(task.args.kind, task.args.spec).sha256
  }));
}

function scriptedPlanner(task) {
  return {
    name: `golden-${task.id}`,
    async plan(context) {
      const done = (context.toolRuns || []).find(
        (item) => item.toolName === task.tool && item.status === 'succeeded'
      );
      if (!done) return { action: 'call', tool: task.tool, args: task.args, reason: `مهمة ذهبية ${task.id}` };
      return { action: 'finish', summary: `أُنتج ${task.args.name} مبصومًا.` };
    }
  };
}

export async function runTemplateGoldenTasks({ expected = null } = {}) {
  const expectations = new Map((expected || goldenDigests()).map((item) => [item.id, item.sha256]));
  const tasks = [];
  for (const task of TEMPLATE_GOLDEN_TASKS) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'celia-template-eval-'));
    const driver = await createSqliteDriver({ path: path.join(directory, 'agent.sqlite3') });
    const store = createAgentStore({ driver });
    const artifacts = createArtifactStore({
      store,
      rootDir: path.join(directory, 'artifacts'),
      signingKey: crypto.randomBytes(32).toString('hex')
    });
    try {
      const tools = createToolRegistry(defaultToolDefinitions({ statusProvider: () => ({ ok: true }), artifacts }));
      const runtime = createAgentRuntime({
        store,
        tools,
        planner: scriptedPlanner(task),
        artifacts,
        limits: { maxSteps: 8, maxCostMicros: 100_000 },
        workerId: `template-eval-${task.id}`,
        logger: { error() {} }
      });
      const thread = await store.createThread({ ownerId: 'owner', title: task.title });
      const { run } = await runtime.submit({ threadId: thread.id, message: task.title });
      const finished = await runtime.runToCompletion(run.id);
      const listing = await runtime.listRunArtifacts(run.id, 'owner');
      const record = listing.artifacts[0] || null;
      let downloadedSha = null;
      if (record) {
        const url = new URL(`http://x${record.download.path}`);
        const opened = await artifacts.open({
          id: url.pathname.split('/')[4],
          exp: url.searchParams.get('exp'),
          sig: url.searchParams.get('sig')
        });
        downloadedSha = crypto.createHash('sha256').update(opened.content).digest('hex');
      }
      const chain = await store.verifyEvidenceChain(run.id);
      const evidence = await store.listEvidence(run.id);
      const expectedSha = expectations.get(task.id) || null;
      const checks = {
        runSucceeded: finished.status === 'succeeded',
        artifactListed: Boolean(record),
        digestMatchesGolden: Boolean(downloadedSha) && downloadedSha === expectedSha,
        publishedInEvidence: evidence.some((entry) => entry.kind === 'artifact_published'),
        evidenceChainOk: chain.ok === true
      };
      tasks.push({
        id: task.id,
        title: task.title,
        name: task.args.name,
        kind: task.args.kind,
        runStatus: finished.status,
        expectedSha256: expectedSha,
        downloadedSha256: downloadedSha,
        checks,
        pass: Object.values(checks).every(Boolean)
      });
    } finally {
      await store.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  }
  return {
    suite: 'B3-TEMPLATES',
    generatedAt: new Date().toISOString(),
    totalTasks: tasks.length,
    passedTasks: tasks.filter((task) => task.pass).length,
    pass: tasks.length === TEMPLATE_GOLDEN_TASKS.length && tasks.every((task) => task.pass),
    tasks
  };
}
