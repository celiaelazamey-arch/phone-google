/**
 * CeliaOS 2026 — access policy, as code (GOV-002 / DEC-084).
 *
 * The owner asked for one thing: the full permission set a CeliaOS operating agent needs to
 * build, run and govern every pillar — GitHub, the six in-product pillars, and the external
 * services — *without* handing over the account. This module is that answer in a form the
 * system can enforce and a test can falsify:
 *
 *   1. Deny by default. A grant that is not named here is refused (`unknown_grant_default_deny`).
 *   2. Tiers are a lattice, not a ladder. `admin` (repository) does not imply `infra_admin`
 *      (cloud, database, deploy), and neither implies `system_operator` (running agents and the
 *      browser/computer adapters). Each axis is granted on its own evidence.
 *   3. Some grants are `ownerOnly` and no tier can satisfy them — secrets, environments,
 *      webhooks, repository settings, rulesets, Pages settings, the WhatsApp app secret and the
 *      model keys. The agent administers the repository; it does not hold the keys to it.
 *   4. Some grants are `selfGovernance`: the policy engine, the approval gate and the workflow
 *      definitions. Touching them requires an explicit owner authorisation and an approval, and
 *      is never executable by the agent alone.
 *   5. Nothing here is wired. `wired` is `false` for every grant; `decideAccess` returns the
 *      policy verdict *and* `executable: false`. A permission matrix that cannot say "not yet"
 *      is a claim, not a control — and this repository does not publish claims.
 *
 * Evidence paths are checked by `test/access-policy.test.js`: a grant whose evidence file does
 * not exist cannot be declared here, so the table cannot drift away from the code that backs it.
 */

export const ACCESS_POLICY_VERSION = 'celiaos-access-policy-2026-v1';

/** The network default is a fact of the sandbox, not a preference (AGENT-003). */
export const NETWORK_DEFAULT = 'DENY';

/** What the agent may never hold, whatever tier it is granted. */
export const ACCOUNT_ACCESS = Object.freeze({
  githubOwner: 'forbidden',
  githubOrganisation: 'forbidden',
  personalKeys: 'forbidden',
  paymentMethods: 'forbidden'
});

export const VERDICT = Object.freeze({
  allow: 'allow',
  approval: 'approval_required',
  deny: 'deny'
});

export const REASON = Object.freeze({
  allowed: 'allowed',
  approvalRequired: 'approval_required',
  approvalFingerprintMismatch: 'approval_fingerprint_mismatch',
  unknownGrant: 'unknown_grant_default_deny',
  ownerOnly: 'owner_only_no_agent_access',
  selfGovernance: 'policy_self_modification_forbidden',
  immutableRelease: 'immutable_release_cannot_be_rewritten',
  insufficientTier: 'insufficient_tier',
  killSwitch: 'kill_switch_engaged'
});

/**
 * Tiers, with the exact names the owner proposed: Read · Write · Execute · Admin ·
 * Infrastructure Admin · System Operator.
 *
 * `implies` is what makes the lattice real: `admin` reaches repository writes and executions,
 * `infra_admin` and `system_operator` reach execution and reads but **not** repository writes.
 */
export const TIERS = Object.freeze([
  Object.freeze({ id: 'read', rank: 1, axis: 'repository', ar: 'قراءة', en: 'Read', implies: [] }),
  Object.freeze({ id: 'write', rank: 2, axis: 'repository', ar: 'كتابة', en: 'Write', implies: ['read'] }),
  Object.freeze({ id: 'execute', rank: 2, axis: 'execution', ar: 'تنفيذ', en: 'Execute', implies: ['read'] }),
  Object.freeze({
    id: 'admin',
    rank: 3,
    axis: 'repository',
    ar: 'إدارة المستودع',
    en: 'Admin',
    implies: ['write', 'execute', 'read']
  }),
  Object.freeze({
    id: 'infra_admin',
    rank: 3,
    axis: 'infrastructure',
    ar: 'إدارة البنية التحتية',
    en: 'Infrastructure Admin',
    implies: ['execute', 'read']
  }),
  Object.freeze({
    id: 'system_operator',
    rank: 3,
    axis: 'operation',
    ar: 'مشغّل النظام',
    en: 'System Operator',
    implies: ['execute', 'read']
  })
]);

export const TIER_IDS = Object.freeze(TIERS.map((tier) => tier.id));

/** Level of a single grant. `execute` runs something; `admin` changes how it is governed. */
export const LEVELS = Object.freeze(['read', 'write', 'execute', 'admin']);

export const DOMAINS = Object.freeze({
  github: 'GitHub',
  frontend: 'الواجهة الأمامية',
  core: 'النواة والمنطق',
  ai: 'الذكاء الاصطناعي والوكلاء',
  data: 'البيانات والذاكرة',
  security: 'الأمان والحوكمة',
  infrastructure: 'البنية التحتية والنشر',
  service: 'الخدمات الخارجية'
});

const G = (grant) =>
  Object.freeze({
    approval: 'never',
    ownerOnly: false,
    selfGovernance: false,
    wired: false,
    level: 'write',
    tier: 'write',
    ...grant
  });

/**
 * §1 — GitHub, the nineteen rows the owner specified. `level` is the owner's level; `tier` is
 * what a CeliaOS agent would need. Six of the nineteen are owner-only: they are the difference
 * between administering a repository and owning it.
 */
export const GITHUB_GRANTS = Object.freeze([
  G({ id: 'github.contents.read', domain: 'github', ar: 'قراءة المستودع والملفات', level: 'read', tier: 'read', evidence: 'src/agent/access-policy.js' }),
  G({ id: 'github.contents.write', domain: 'github', ar: 'تعديل وإنشاء الملفات', evidence: 'src/agent/access-policy.js' }),
  G({ id: 'github.commit.push', domain: 'github', ar: 'الالتزام والدفع إلى فرع', evidence: '.github/workflows/celia-mcp.yml' }),
  G({ id: 'github.branches.manage', domain: 'github', ar: 'إنشاء الفروع وحذفها', evidence: 'src/agent/access-policy.js' }),
  G({ id: 'github.pull_requests.manage', domain: 'github', ar: 'إدارة طلبات الدمج ومراجعتها', evidence: 'src/agent/access-policy.js' }),
  G({
    id: 'github.pull_requests.merge',
    domain: 'github',
    ar: 'دمج طلبات الدمج',
    approval: 'always',
    evidence: 'docs/continuity/STATE.md'
  }),
  G({ id: 'github.issues.manage', domain: 'github', ar: 'إدارة المشكلات', evidence: '.github/workflows/issue-triage.yml' }),
  G({ id: 'github.labels_milestones.manage', domain: 'github', ar: 'إدارة اللصائق والمراحل', evidence: '.github/workflows/issue-triage.yml' }),
  G({
    id: 'github.releases.manage',
    domain: 'github',
    ar: 'إدارة الإصدارات والوسوم',
    approval: 'always',
    evidence: '.github/workflows/release.yml'
  }),
  G({ id: 'github.projects.manage', domain: 'github', ar: 'إدارة المشاريع', evidence: 'src/agent/access-policy.js' }),
  G({ id: 'github.discussions.manage', domain: 'github', ar: 'إدارة المناقشات', evidence: 'src/agent/access-policy.js' }),
  G({ id: 'github.actions.manage', domain: 'github', ar: 'إدارة سير العمل وتشغيله', evidence: '.github/workflows/celia-mcp.yml' }),
  G({
    id: 'github.workflows.manage',
    domain: 'github',
    ar: 'إدارة ملفات سير العمل',
    approval: 'always',
    selfGovernance: true,
    evidence: 'test/workflows-static.test.js'
  }),
  G({ id: 'github.secrets_variables.manage', domain: 'github', ar: 'إدارة الأسرار والمتغيرات', level: 'admin', tier: 'admin', ownerOnly: true, evidence: 'src/secrets-hub.js' }),
  G({ id: 'github.environments.manage', domain: 'github', ar: 'إدارة البيئات', level: 'admin', tier: 'admin', ownerOnly: true, evidence: '.github/workflows/release.yml' }),
  G({ id: 'github.webhooks.manage', domain: 'github', ar: 'إدارة الويب هوكس', level: 'admin', tier: 'admin', ownerOnly: true, evidence: 'src/app.js' }),
  G({ id: 'github.settings.manage', domain: 'github', ar: 'إدارة إعدادات المستودع', level: 'admin', tier: 'admin', ownerOnly: true, evidence: 'docs/continuity/STATE.md' }),
  G({ id: 'github.rulesets.manage', domain: 'github', ar: 'إدارة حماية الفروع وقواعد الفحص', level: 'admin', tier: 'admin', ownerOnly: true, selfGovernance: true, evidence: 'docs/continuity/STATE.md' }),
  G({ id: 'github.pages.manage', domain: 'github', ar: 'إدارة النشر عبر Pages', level: 'admin', tier: 'admin', ownerOnly: true, evidence: '.github/workflows/pages.yml' })
]);

/**
 * §2 — the six CeliaOS pillars. The owner listed what the agent must be able to develop inside
 * each pillar; every row here is a grant with the same shape as GitHub, so one resolver decides
 * both and the audit table reads the same way.
 */
export const PILLAR_GRANTS = Object.freeze([
  // Frontend
  G({ id: 'frontend.code.write', domain: 'frontend', ar: 'إنشاء HTML وCSS وJavaScript وتعديلها', evidence: 'public/', level: 'write' }),
  G({ id: 'frontend.dashboard.write', domain: 'frontend', ar: 'تطوير لوحة التحكم', evidence: 'public/system.html' }),
  G({ id: 'frontend.design.write', domain: 'frontend', ar: 'إدارة التصميم ورموز الألوان', evidence: 'public/theme.css' }),
  G({ id: 'frontend.rtl.write', domain: 'frontend', ar: 'ضبط الاتجاه RTL وإتاحة الوصول', evidence: 'e2e/system.spec.js' }),
  G({ id: 'frontend.pages.execute', domain: 'frontend', ar: 'اختبار الصفحات والاستجابة', level: 'execute', tier: 'execute', evidence: 'scripts/run-browser-tests.mjs' }),

  // Core & kernel
  G({ id: 'core.kernel.write', domain: 'core', ar: 'إدارة Kernel Manager', evidence: 'src/agent/harness.js' }),
  G({ id: 'core.event_bus.write', domain: 'core', ar: 'إدارة ناقل الأحداث', evidence: 'src/agent/runtime.js' }),
  G({ id: 'core.tool_registry.write', domain: 'core', ar: 'إدارة سجل الأدوات', evidence: 'src/knowledge/tool-policy.js' }),
  G({ id: 'core.workflow_engine.write', domain: 'core', ar: 'إدارة محرّك سير العمل', evidence: 'src/agent/automation/index.js' }),
  G({ id: 'core.agent_runtime.write', domain: 'core', ar: 'تطوير وقت تشغيل الوكيل', evidence: 'src/agent/runtime.js' }),
  G({ id: 'core.model_router.write', domain: 'core', ar: 'إدارة موجّه النماذج', evidence: 'src/agent/model-router.js' }),

  // AI & agents
  G({ id: 'ai.planner.write', domain: 'ai', ar: 'إدارة المخطِّط', evidence: 'src/agent/planner.js' }),
  G({ id: 'ai.executor.write', domain: 'ai', ar: 'إدارة المنفّذ', evidence: 'src/agent/runtime.js' }),
  G({ id: 'ai.critic.write', domain: 'ai', ar: 'إدارة الناقد والمتحقِّق', evidence: 'src/agent/verifier.js' }),
  G({ id: 'ai.memory.write', domain: 'ai', ar: 'إدارة الذاكرة والسياق', evidence: 'src/agent/memory.js' }),
  G({ id: 'ai.tools.write', domain: 'ai', ar: 'إدارة الأدوات والوكلاء', evidence: 'src/agent/tools.js' }),
  G({ id: 'ai.browser_adapter.write', domain: 'ai', ar: 'إدارة محوّل المتصفح', tier: 'system_operator', approval: 'always', evidence: 'src/agent/web-fetch.js' }),
  G({ id: 'ai.computer_adapter.write', domain: 'ai', ar: 'إدارة محوّل Computer Use', tier: 'system_operator', approval: 'always', evidence: 'src/agent/computer-policy.js' }),

  // Data & memory
  G({ id: 'data.store.write', domain: 'data', ar: 'إدارة SQLite وD1', evidence: 'src/db.js' }),
  G({ id: 'data.schema.write', domain: 'data', ar: 'إدارة المخطط والهجرات', tier: 'infra_admin', approval: 'always', evidence: 'src/schema-migrations.js' }),
  G({ id: 'data.memory.write', domain: 'data', ar: 'إدارة محرّك الذاكرة', evidence: 'src/agent/memory.js' }),
  G({ id: 'data.evidence.write', domain: 'data', ar: 'إدارة مخزن الأدلة', evidence: 'src/agent/evidence.js' }),
  G({ id: 'data.backup.write', domain: 'data', ar: 'النسخ الاحتياطي والاستعادة', tier: 'infra_admin', approval: 'always', evidence: 'scripts/deploy-release.mjs' }),
  G({ id: 'data.knowledge.write', domain: 'data', ar: 'إدارة المعرفة وRAG', evidence: 'src/knowledge/manifest.js' }),

  // Security & governance
  G({ id: 'security.policy.write', domain: 'security', ar: 'محرّك السياسة', level: 'admin', tier: 'admin', approval: 'always', selfGovernance: true, evidence: 'src/agent/access-policy.js' }),
  G({ id: 'security.approval.write', domain: 'security', ar: 'بوابة الموافقة', level: 'admin', tier: 'admin', approval: 'always', selfGovernance: true, evidence: 'src/agent/harness.js' }),
  G({ id: 'security.sandbox.write', domain: 'security', ar: 'العزل التنفيذي', level: 'admin', tier: 'admin', approval: 'always', selfGovernance: true, evidence: 'src/agent/sandbox-policy.js' }),
  G({ id: 'security.evidence.write', domain: 'security', ar: 'التحقق من الأدلة', evidence: 'src/agent/verifier.js' }),
  G({ id: 'security.audit.read', domain: 'security', ar: 'سجلات التدقيق', level: 'read', tier: 'read', evidence: 'src/agent/evidence.js' }),
  G({ id: 'security.identity.write', domain: 'security', ar: 'إدارة الصلاحيات والهويات', level: 'admin', tier: 'admin', ownerOnly: true, evidence: 'src/auth.js' }),

  // Infrastructure
  G({ id: 'infra.ci.write', domain: 'infrastructure', ar: 'التكامل والنشر المستمر', level: 'admin', tier: 'admin', approval: 'always', evidence: '.github/workflows/celia-mcp.yml' }),
  G({ id: 'infra.pages.write', domain: 'infrastructure', ar: 'GitHub Pages', level: 'admin', tier: 'admin', approval: 'always', evidence: '.github/workflows/pages.yml' }),
  G({ id: 'infra.workers.write', domain: 'infrastructure', ar: 'Cloudflare Workers', tier: 'infra_admin', approval: 'always', evidence: '.github/workflows/cloudflare-deploy.yml' }),
  G({ id: 'infra.d1.write', domain: 'infrastructure', ar: 'قاعدة D1', tier: 'infra_admin', approval: 'always', evidence: 'workers/celia-edge/wrangler.toml' }),
  G({ id: 'infra.render.write', domain: 'infrastructure', ar: 'خدمات Render', tier: 'infra_admin', approval: 'always', evidence: 'render.yaml' }),
  G({ id: 'infra.publish.execute', domain: 'infrastructure', ar: 'النشر إلى الإنتاج — بموافقة صريحة مربوطة ببصمة الطلب، بلا تجاوز للتوقيعات أو المراجعات المطلوبة', level: 'execute', tier: 'admin', approval: 'always', evidence: 'src/agent/publish-gate.js' }),
  G({ id: 'infra.monitoring.read', domain: 'infrastructure', ar: 'مراقبة الخدمات والنشر', level: 'read', tier: 'read', evidence: 'scripts/service-reality.mjs' })
]);

/**
 * §3 — external services. The owner's warning is the rule: GitHub Admin grants nothing here.
 * Each row names its own credential boundary, and the ones that need a secret are owner-only.
 */
export const SERVICE_GRANTS = Object.freeze([
  G({ id: 'service.github.admin', domain: 'service', ar: 'GitHub — إدارة المستودع', level: 'admin', tier: 'admin', ownerOnly: true, evidence: 'docs/continuity/STATE.md' }),
  G({ id: 'service.cloudflare.scoped', domain: 'service', ar: 'Cloudflare — Workers وD1 وفق نطاق المشروع', tier: 'infra_admin', approval: 'always', evidence: 'workers/celia-edge/wrangler.toml' }),
  G({ id: 'service.render.scoped', domain: 'service', ar: 'Render — الخدمات والنشر', tier: 'infra_admin', approval: 'always', evidence: 'render.yaml' }),
  G({ id: 'service.whatsapp.meta', domain: 'service', ar: 'WhatsApp Business — التكامل', level: 'admin', tier: 'admin', ownerOnly: true, evidence: 'src/whatsapp.js' }),
  G({ id: 'service.google_ai.keys', domain: 'service', ar: 'Google AI — مفاتيح النماذج', level: 'admin', tier: 'admin', ownerOnly: true, evidence: 'src/gemini.js' }),
  G({ id: 'service.ollama.local', domain: 'service', ar: 'Ollama — النماذج المحلية', level: 'execute', tier: 'execute', evidence: 'src/ollama.js' }),
  G({ id: 'service.mcp.registry', domain: 'service', ar: 'MCP — إدارة الأدوات وتسجيلها', approval: 'always', evidence: 'src/mcp-contract.js' }),
  G({ id: 'service.browser', domain: 'service', ar: 'المتصفح — إجراءات مصرّح بها', tier: 'system_operator', approval: 'always', evidence: 'src/agent/web-tools.js' }),
  G({ id: 'service.computer_use', domain: 'service', ar: 'Computer Use — تحكم بموافقة المستخدم', tier: 'system_operator', approval: 'always', evidence: 'src/agent/computer-policy.js' }),
  G({ id: 'service.database', domain: 'service', ar: 'قاعدة البيانات — البيانات والمخططات', tier: 'infra_admin', approval: 'always', evidence: 'src/mysql-config.js' }),
  G({ id: 'service.monitoring', domain: 'service', ar: 'المراقبة — السجلات وحالة الخدمات', level: 'read', tier: 'read', evidence: 'scripts/service-reality.mjs' })
]);

export const GRANTS = Object.freeze([...GITHUB_GRANTS, ...PILLAR_GRANTS, ...SERVICE_GRANTS]);
export const GRANT_IDS = Object.freeze(GRANTS.map((grant) => grant.id));

/**
 * §5 — the eight constraints the owner said must survive every grant. None of them is a promise:
 * each one names the code and the test that would fail if it were removed.
 */
export const LIMITS = Object.freeze([
  Object.freeze({ id: 'network_default_deny', ar: 'الشبكة ممنوعة افتراضيًا', en: 'NETWORK = DENY by default', evidence: 'src/agent/sandbox-policy.js' }),
  Object.freeze({ id: 'human_approval', ar: 'موافقة بشرية قبل العمليات الحساسة والخارجية', en: 'Human approval before sensitive and external effects', evidence: 'src/agent/harness.js' }),
  Object.freeze({ id: 'payload_fingerprint', ar: 'الموافقة مربوطة ببصمة الحمولة', en: 'Approval bound to the payload fingerprint', evidence: 'src/agent/harness.js' }),
  Object.freeze({ id: 'evidence_chain', ar: 'أدلة بسلسلة SHA-256', en: 'SHA-256 evidence chain', evidence: 'src/agent/evidence.js' }),
  Object.freeze({ id: 'independent_verify', ar: 'تحقق مستقل PASS / BLOCK / UNKNOWN', en: 'Independent verifier verdict', evidence: 'src/agent/verifier.js' }),
  Object.freeze({ id: 'no_secrets', ar: 'لا كشف للأسرار ولا تسجيلها', en: 'No secret in arguments or logs', evidence: 'src/agent/tools.js' }),
  Object.freeze({ id: 'kill_switch', ar: 'إيقاف الوكيل فورًا', en: 'Immediate stop', evidence: 'src/agent/runtime.js' }),
  Object.freeze({ id: 'no_self_policy', ar: 'لا تعديل لسياسات الأمان دون موافقة', en: 'No self-modification of security policy', evidence: 'src/agent/access-policy.js' })
]);

/**
 * §6 — the owner's ten-step management loop, mapped onto the harness stages that actually exist.
 *
 * These are **not** new harness stages. `HARNESS_LIFECYCLE_STAGES` in `src/agent/harness.js` stays
 * the single source of stage names, and the test refuses any string here that is not one of the
 * ten literal stages. Step 8 (merge and publish) sits *outside* the harness on purpose: it is
 * governed by the repository's own gates and the owner's word, not by the agent's loop.
 */
export const MANAGEMENT_LOOP = Object.freeze([
  Object.freeze({ n: 1, ar: 'فهم المشروع', stage: 'Goal', note: 'عقد الهدف قبل أي خطوة' }),
  Object.freeze({ n: 2, ar: 'تحليل المشكلة', stage: 'Plan', note: 'الخطة بحالتها المسجّلة' }),
  Object.freeze({ n: 3, ar: 'تخطيط التغيير', stage: 'Plan', note: 'المراجعة والتعديل قبل التنفيذ' }),
  Object.freeze({ n: 4, ar: 'كتابة الكود', stage: 'Sandbox Execute', note: 'داخل التنفيذ المعزول' }),
  Object.freeze({ n: 5, ar: 'تشغيل الاختبارات', stage: 'Sandbox Execute', note: 'الفشل يُسمّى لا يُستهلك' }),
  Object.freeze({ n: 6, ar: 'التحقق من الأدلة', stage: 'Independently Verify', note: 'حكم مستقل لا تقييم ذاتي' }),
  Object.freeze({ n: 7, ar: 'طلب الموافقة', stage: 'Approval', note: 'مربوطة ببصمة الحمولة' }),
  Object.freeze({ n: 8, ar: 'الدمج والنشر', stage: null, note: 'بوابات المستودع وكلمة المالك' }),
  Object.freeze({ n: 9, ar: 'مراقبة النتائج', stage: 'Observe', note: 'ما جرى فعلًا لا ما قيل' }),
  Object.freeze({ n: 10, ar: 'تحديث المعرفة', stage: 'Update State', note: 'بعد حفظ الدليل' })
]);

/**
 * What only the owner can flip. The agent can name these; it cannot grant them.
 */
export const OWNER_ACTIONS = Object.freeze([
  Object.freeze({ id: 'owner.ruleset_bypass', ar: 'إبقاء تجاوز القاعدة على دور المالك وحده، وحذف أداة «مسؤول المستودع» التي لا تُنتج نتائج', evidence: 'docs/continuity/STATE.md' }),
  Object.freeze({ id: 'owner.secrets', ar: 'إدخال أسرار المنصات (Meta، مفاتيح النماذج، رموز النشر) — لا تُمنح للوكيل أبدًا', evidence: 'src/secrets-hub.js' }),
  Object.freeze({ id: 'owner.environments', ar: 'إنشاء البيئات وحمايتها واعتماد المراجعين', evidence: '.github/workflows/release.yml' }),
  Object.freeze({ id: 'owner.merge_word', ar: 'كلمة الدمج والدفع: لا دمج ولا نشر ولا إصدار بغيرها', evidence: 'docs/continuity/STATE.md' })
]);

/** Reachability over `implies`; `read` is reachable from every tier, and nothing else is reflexive-free. */
export function reachableTiers(tierId) {
  const byId = new Map(TIERS.map((tier) => [tier.id, tier]));
  const seen = new Set();
  const walk = (id) => {
    if (!byId.has(id) || seen.has(id)) return;
    seen.add(id);
    for (const next of byId.get(id).implies) walk(next);
  };
  walk(tierId);
  return seen;
}

export function grantById(grantId) {
  return GRANTS.find((grant) => grant.id === grantId) || null;
}

export function tierSatisfies(tierId, requiredTier) {
  if (!TIER_IDS.includes(requiredTier)) return false;
  return reachableTiers(tierId).has(requiredTier);
}

/**
 * Decide one access request.
 *
 * Order matters and is part of the contract: the kill switch outranks everything, an unknown
 * grant is denied before any tier is consulted, an owner-only grant is denied whatever the tier,
 * a self-governance grant stops at "approval" even with owner authorisation, and an immutable
 * release cannot be rewritten by anyone.
 */
export function decideAccess({ grantId = null, tier = null, context = {} } = {}) {
  const base = { grantId, verdict: VERDICT.deny, reason: null, requiredTier: null, executable: false, wired: false };
  if (context.suspended) return { ...base, reason: REASON.killSwitch };
  const grant = grantById(grantId);
  if (!grant) return { ...base, reason: REASON.unknownGrant };
  const shaped = { ...base, requiredTier: grant.tier, wired: grant.wired, ownerOnly: grant.ownerOnly, selfGovernance: grant.selfGovernance };
  if (grant.ownerOnly) return { ...shaped, reason: REASON.ownerOnly };
  const ownerAuthorised = context.ownerAuthorised === true;
  if (grant.selfGovernance && !ownerAuthorised) return { ...shaped, reason: REASON.selfGovernance };
  if (grant.id === 'github.releases.manage' && context.releaseImmutable) {
    return { ...shaped, reason: REASON.immutableRelease };
  }
  if (!tierSatisfies(tier, grant.tier)) return { ...shaped, reason: REASON.insufficientTier };
  if (grant.approval === 'always' || grant.selfGovernance) {
    const approval = context.approval || null;
    if (!approval || approval.decision !== 'approved') return { ...shaped, verdict: VERDICT.deny, reason: REASON.approvalRequired };
    const expected = approval.payloadHash || null;
    const actual = context.payloadHash || null;
    if (!expected || !actual || expected !== actual) {
      return { ...shaped, verdict: VERDICT.deny, reason: REASON.approvalFingerprintMismatch };
    }
    return { ...shaped, verdict: VERDICT.allow, reason: REASON.allowed, executable: grant.wired };
  }
  return { ...shaped, verdict: VERDICT.allow, reason: REASON.allowed, executable: grant.wired };
}

export function policySummary() {
  const byDomain = {};
  for (const domain of Object.keys(DOMAINS)) byDomain[domain] = 0;
  for (const grant of GRANTS) byDomain[grant.domain] += 1;
  return {
    version: ACCESS_POLICY_VERSION,
    total: GRANTS.length,
    byDomain,
    ownerOnly: GRANTS.filter((grant) => grant.ownerOnly).length,
    approvalAlways: GRANTS.filter((grant) => grant.approval === 'always').length,
    selfGovernance: GRANTS.filter((grant) => grant.selfGovernance).length,
    wired: GRANTS.filter((grant) => grant.wired).length,
    limits: LIMITS.length,
    tiers: TIERS.length,
    managementSteps: MANAGEMENT_LOOP.length,
    ownerActions: OWNER_ACTIONS.length
  };
}
