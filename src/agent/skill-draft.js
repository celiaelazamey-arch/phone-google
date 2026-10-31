/**
 * ASSUR-003 — اشتقاق مسوّدة مهارة من السجل الدائم، لا من شاشة المستخدم.
 *
 * الفكرة مأخوذة من `microsoft/skill-recorder` (MIT): تسجيل جلسة ← نية + خطوات
 * مرتبة ← `SKILL.md` قابل للمراجعة. **لكن المصدر مختلف تمامًا**: نظامنا يملك
 * `agent_steps` و`agent_tool_runs` ببصمات وسلسلة أدلة، فهي مصدر أدق وأصدق من
 * تصوير الشاشة. والأداة الأصلية ترسل عند التحليل عناوين نوافذ وURLs وأجزاء
 * حافظة ولقطات ومخرجات طرفية إلى السحابة؛ هذا المسار **لا يفعل شيئًا من ذلك**.
 *
 * ضمانات بنيوية (لا وعود):
 * - الوحدة **خالصة**: لا شبكة، لا نظام ملفات، لا ساعة، لا عشوائية. السجل نفسه
 *   يعيد نفس المسوّدة ونفس البصمة.
 * - كل نص يدخل المسوّدة يمرّ على `findSecret`. وجود سرّ ⇒ **رفض بكود**، لا
 *   تنقيح صامت ولا كتابة جزئية: المالك يقرر، لا الوحدة.
 * - المسار محروس: `.agents/skills/` **مرفوض** لأن `R0-04` يثبّت أربع مهارات
 *   إجرائية (الدرس المقاس في `DEC-078` حين كسر Hallmark ذلك الفعل).
 * - المسوّدة **مسوّدة**: لا تثبيت ولا تفعيل. المراجعة البشرية شرط معلن في
 *   الترويسة نفسها، ولا تدّعي المسوّدة أنها مهارة عاملة.
 */

import { findSecret } from '../knowledge/validate.js';
import { hashOf } from './evidence.js';
import { RUN_STATUS, TOOL_RUN_STATUS, isTerminalStatus } from './store.js';

export const SKILL_DRAFT_VERSION = 'skill-draft-v1';

/** مسار المسوّدات — خارج مسار الحوكمة بمسافة واضحة. */
export const SKILL_DRAFT_DIR = 'data/skill-drafts';

/** مسار لا يجوز الكتابة فيه أبدًا: المهارات الإجرائية المحكومة بـR0-04. */
const GOVERNED_SKILLS_DIR = '.agents/skills';

const SUMMARY_CHARS = 200;
const MAX_STEPS = 40;
const RUN_ID = /^[A-Za-z0-9_-]{8,64}$/;

function coded(code, details = []) {
  return { ok: false, code, details };
}

function clip(value, max = SUMMARY_CHARS) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * حارس المسار: يرفض أي مسار ينتهي داخل المهارات الإجرائية، بأي صيغة نسبية.
 * يُطبَّع الفاصل والمقطع `..` قبل الحكم لئلا يمرّ `data/../.agents/skills`.
 */
export function assertSafeDraftPath(target) {
  const raw = String(target ?? '');
  if (!raw) throw Object.assign(new Error('draft_path_required'), { code: 'draft_path_required' });
  const normalized = raw.replace(/\\/g, '/');
  // الجذر محفوظ: إسقاط الشرطة الأولى كان يحوّل `/tmp/x` إلى `tmp/x` فيكتب
  // داخل المستودع بدل المسار المطلق المطلوب. كشفه تشغيل الـCLI فعليًا.
  const absolute = normalized.startsWith('/');
  const parts = [];
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  const joined = `${absolute ? '/' : ''}${parts.join('/')}`;
  // الحكم على **مقطع** المسار لا على بادئته: بادئة وحدها تُمرّر مسارًا مطلقًا
  // مثل `/repo/.agents/skills/x`، وهو داخل المسار المحكوم فعلًا. كشفه SD-01.
  const governed = GOVERNED_SKILLS_DIR.split('/');
  const insideGoverned = parts.some((segment, index) =>
    segment === governed[0] && parts[index + 1] === governed[1]
  );
  if (insideGoverned) {
    throw Object.assign(new Error('governed_skills_path_refused'), { code: 'governed_skills_path_refused' });
  }
  return joined;
}

/** المسار المقترح لمسوّدة تشغيل — يبقى داخل `SKILL_DRAFT_DIR`. */
export function skillDraftPath(runId) {
  if (!RUN_ID.test(String(runId ?? ''))) {
    throw Object.assign(new Error('invalid_run_id'), { code: 'invalid_run_id' });
  }
  return assertSafeDraftPath(`${SKILL_DRAFT_DIR}/${runId}.md`);
}

/**
 * يشتق مسوّدة من سجل تشغيل منتهٍ.
 *
 * @param {{run:object, steps:Array, toolRuns:Array, objective?:string}} ledger
 * @returns {{ok:true, markdown:string, digest:string, path:string, tools:string[], failures:string[]}
 *          | {ok:false, code:string, details:string[]}}
 */
export function buildSkillDraft({ run, steps = [], toolRuns = [], objective = null } = {}) {
  if (!run || typeof run !== 'object') return coded('run_required');
  if (!isTerminalStatus(run.status)) return coded('run_not_finished', [`status:${run.status ?? 'unknown'}`]);
  if (!Array.isArray(steps) || steps.length === 0) return coded('no_steps_to_derive');

  const ordered = [...steps].sort((a, b) => Number(a.index) - Number(b.index)).slice(0, MAX_STEPS);
  const runs = Array.isArray(toolRuns) ? toolRuns : [];

  // الأدوات بترتيب أول ظهور — حتمي ولا يعتمد على ترتيب صفوف المخزن.
  const tools = [];
  for (const step of ordered) {
    const name = clip(step.toolName, 64);
    if (name && !tools.includes(name)) tools.push(name);
  }
  const failures = [];
  for (const toolRun of runs) {
    if (toolRun.status !== TOOL_RUN_STATUS.failed) continue;
    const label = clip(toolRun.toolName, 64);
    if (label && !failures.includes(label)) failures.push(label);
  }

  const succeeded = run.status === RUN_STATUS.succeeded;
  const intent = clip(objective, 300) || 'تشغيل مسجّل بلا نص هدف محفوظ';
  const slug = `run-${String(run.id).slice(0, 8)}`;

  const lines = [
    '---',
    `name: ${slug}`,
    `description: مسوّدة مهارة مشتقة من تشغيل مسجّل — تحتاج مراجعة بشرية قبل أي استخدام`,
    `version: ${SKILL_DRAFT_VERSION}`,
    'status: draft',
    'review: required',
    'installed: false',
    `source_run: ${run.id}`,
    `source_status: ${run.status}`,
    '---',
    '',
    `# مسوّدة مهارة: ${slug}`,
    '',
    '> مسوّدة للمراجعة فقط. لم تُثبَّت ولم تُفعَّل، ولا يجوز نسخها إلى',
    '> `.agents/skills/` لأن ذلك المسار محكوم بأربع مهارات إجرائية (R0-04).',
    '',
    '## النية',
    '',
    intent,
    '',
    '## الخطوات المرتبة',
    ''
  ];

  for (const step of ordered) {
    const summary = clip(step.summary);
    const head = `${Number(step.index)}. [${clip(step.kind, 24)}] ${clip(step.title, 120)}`;
    lines.push(summary ? `${head} — ${summary}` : head);
  }

  lines.push('', '## الأدوات المستخدمة', '');
  lines.push(tools.length ? tools.map((name) => `- ${name}`).join('\n') : '- لا أداة مسجلة');

  lines.push('', '## شروط الفشل المشاهدة', '');
  if (failures.length) {
    lines.push(failures.map((name) => `- فشلت \`${name}\` في هذا التشغيل؛ أعد النظر قبل إعادة استخدامها.`).join('\n'));
  } else {
    lines.push('- لا فشل أداة مسجّل في هذا التشغيل.');
  }

  lines.push('', '## حدود هذه المسوّدة', '');
  lines.push(`- نتيجة التشغيل المصدر: \`${run.status}\`${succeeded ? '' : ' — لم ينجح، فالمسوّدة ليست إجراءً موصى به'}.`);
  lines.push('- المشتق وقائع السجل فقط: لا تصوير شاشة، لا حافظة، لا رفع سحابي.');
  lines.push('- الصلاحية غير مُتحقَّق منها: نجاح تشغيل واحد لا يثبت إجراءً قابلًا للتعميم.');

  const markdown = `${lines.join('\n')}\n`;

  // بوابة الأسرار على النص النهائي كله: أي نص دخل المسوّدة مشمول، بما فيه
  // ملخصات الخطوات التي قد تحمل مخرج أداة. الرفض يسبق أي كتابة.
  const secret = findSecret(markdown);
  if (secret) return coded('secret_detected', [`kind:${secret}`]);

  return {
    ok: true,
    markdown,
    digest: hashOf(markdown),
    path: skillDraftPath(run.id),
    tools,
    failures
  };
}
