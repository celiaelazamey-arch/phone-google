/**
 * The single source of truth for governed issue triage (AGENT-006).
 *
 * The rule the whole module enforces: an agent suggestion is only ever an *input* to a decision. What may be
 * changed, by how much confidence, how often, and how it is undone live in this file — not in a prompt — so a
 * change here is a code review, and a change in a model's mood is not.
 *
 * Scope is deliberately boring: issues only. Code edits, branches, pull requests, workflows, secrets, releases
 * and deployments are listed as blocked effects and are refused by `assertInScope`, so a future caller cannot
 * "just add" a write path without editing policy.
 */

export const TRIAGE_POLICY_VERSION = 'issue-triage-v1';

/** Confidence bands from the design: >= 0.90 auto, 0.60–0.89 a human decides, < 0.60 the suggestion is dropped. */
export const THRESHOLDS = Object.freeze({ auto: 0.9, human: 0.6 });

/** `propose` never changes an issue; `cautious` may apply allowlisted labels above the auto threshold. */
export const MODES = Object.freeze(['propose', 'cautious']);

export const EFFECT_SCOPE = Object.freeze({
  allowed: ['labels', 'assignee', 'comment'],
  /** Named so that `assertInScope` can explain exactly what is out of bounds, not merely "denied". */
  blocked: ['code_edit', 'branch', 'pull_request', 'workflow', 'secret', 'deploy', 'release']
});

/** Closed label vocabulary. A proposal naming anything else is downgraded to human review, never applied. */
export const LABELS = Object.freeze({
  type: Object.freeze({
    bug: 'bug',
    feature: 'enhancement',
    docs: 'documentation',
    question: 'question',
    security: 'security'
  }),
  priority: Object.freeze({
    critical: 'priority:critical',
    high: 'priority:high',
    medium: 'priority:medium',
    low: 'priority:low'
  }),
  route: Object.freeze({
    auto: 'triage:auto',
    human: 'triage:human'
  }),
  ledger: 'triage:ledger'
});

export const ALLOWED_LABELS = Object.freeze(
  new Set([
    ...Object.values(LABELS.type),
    ...Object.values(LABELS.priority),
    ...Object.values(LABELS.route),
    LABELS.ledger
  ])
);

/** Label appearance, created on demand so a fresh repository does not reject a valid proposal with HTTP 422. */
export const LABEL_COLORS = Object.freeze({
  bug: 'd73a4a',
  enhancement: 'a2eeef',
  documentation: '0075ca',
  question: 'd876e3',
  security: 'b60205',
  'priority:critical': 'b60205',
  'priority:high': 'e99695',
  'priority:medium': 'fbca04',
  'priority:low': 'c2e0c6',
  'triage:auto': '0e8a16',
  'triage:human': 'fbca04',
  'triage:ledger': '5319e7'
});

/**
 * Assignees are opt-in by name. Empty by default: assigning is a notification to a real person, so the agent may
 * propose one but a human applies it until the owner lists who is allowed to be pinged automatically.
 */
export const ASSIGNEE_ALLOWLIST = Object.freeze([]);

/** Blast-radius controls: a runaway classifier cannot relabel a repository all day, and every change is undoable. */
export const DAILY_AUTO_APPLY_CAP = 10;
export const ROLLBACK_WINDOW_DAYS = 7;

/** Ledger issue identity (one per repository, comments are the append-only log). */
export const LEDGER_TITLE = 'Triage audit ledger';
export const LEDGER_LABEL = LABELS.ledger;

/** Terms are matched case-insensitively; Arabic is matched without diacritics by normalising first. */
export const TYPE_SIGNALS = Object.freeze({
  security: {
    strong: ['ثغرة', 'اختراق', 'تسريب', 'تسريب اسرار', 'كشف اسرار', 'vulnerability', 'cve', 'secret leak', 'credential leak'],
    weak: ['أمن', 'امن', 'security', 'unauthorized', 'صلاحيات']
  },
  bug: {
    strong: ['لا يعمل', 'لايعمل', 'تعطل', 'انهيار', 'يتعطل', 'خطا في', 'فشل', 'crash', 'traceback', 'exception', 'regression'],
    weak: ['bug', 'error', 'broken', 'issue', 'مشكلة', 'مشكله', 'خطا', '500']
  },
  feature: {
    strong: ['اقتراح ميزة', 'اضف ميزة', 'feature request', 'would be nice', 'دعم اضافي'],
    weak: ['اضف', 'اقترح', 'ميزة', 'ميزه', 'enhancement', 'feature', 'support', 'add']
  },
  docs: {
    strong: ['توثيق', 'documentation', 'readme', 'دليل الاستخدام'],
    weak: ['شرح', 'docs', 'explain', 'document']
  },
  question: {
    strong: ['كيف يمكنني', 'كيف اسوي', 'how do i', 'how can i', 'كيف يعمل'],
    weak: ['سؤال', 'سوال', 'question', 'why', 'لماذا', 'how']
  }
});

export const PRIORITY_SIGNALS = Object.freeze({
  critical: ['تسريب', 'اختراق', 'فقدان بيانات', 'data loss', 'secret leak', 'cve', 'vulnerability', 'ثغرة', 'down', 'توقف كامل'],
  high: ['لا يعمل', 'تعطل', 'انهيار', 'blocker', 'crash', 'regression', 'عاجل', 'urgent', 'production'],
  low: ['اقتراح', 'ميزة', 'ميزه', 'توثيق', 'documentation', 'سؤال', 'question', 'تحسين', 'typo', 'docs']
});

/** Signals strong enough to raise priority on their own when the type is not security. */
export const TYPE_TO_PRIORITY = Object.freeze({ security: 'critical', bug: 'high', feature: 'low', docs: 'low', question: 'low' });

export function assertInScope(effect) {
  const name = String(effect);
  if (EFFECT_SCOPE.allowed.includes(name)) return true;
  if (EFFECT_SCOPE.blocked.includes(name)) {
    throw new Error(`out_of_scope:${name} — this loop is issues-only; deploy, workflow and code changes are blocked by policy`);
  }
  throw new Error(`unknown_effect:${name}`);
}

export function resolveMode(value, fallback = 'propose') {
  const mode = String(value ?? '').trim().toLowerCase();
  return MODES.includes(mode) ? mode : fallback;
}
