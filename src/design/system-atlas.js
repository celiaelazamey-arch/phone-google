/**
 * System Atlas — the twelve domains, audited rather than announced (VFE-006 / DEC-087).
 *
 * The owner asked for one thing before any building: **audit what exists, then draw the coverage
 * map, then propose phases.** This module is that audit. Each domain declares the capabilities it
 * claims, and each capability cites real files. The status is never typed by hand:
 *
 *   - every cited file exists and a test names at least one of them  → 🟢 verified
 *   - every cited file exists, no test names them                    → 🟠 unverified
 *   - some files missing, some present                               → 🟡 partial
 *   - no cited file exists                                           → 🔴 not implemented
 *
 * A domain with an empty citation list is a domain the system does not have, and the atlas says so
 * in the owner's own words: «تعدد الوكلاء لا يعني أن جميع الوكلاء موجودون».
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { TRUTH, TRUTH_LABEL, TRUTH_MARK } from './architecture-map.js';

export const ATLAS_VERSION = 'celiaos-system-atlas-v1';

export { TRUTH, TRUTH_LABEL, TRUTH_MARK };

export const PRIORITY_MEANING = Object.freeze({
  P0: 'يُبنى أولًا: اكتشاف المعرفة، استمراريتها، منتج قابل للاستخدام، والربط بالعالم',
  P1: 'بعد أن تثبت الأساسات: الأتمتة، توجيه النماذج، التعافي، وتعدد الوكلاء',
  P2: 'تحسين وقياس: الموارد والتحليلات ودورة حياة المنتج'
});

/**
 * The twelve domains of the owner's directive, in his order. `artifact` is a page where the domain
 * can be seen today; `capabilities` are the claims, each with the files that must exist to make it.
 */
export const DOMAINS = Object.freeze([
  Object.freeze({
    id: 'cognitive_knowledge',
    ar: 'الإدراك والمعرفة والبحث',
    en: 'Cognitive & Knowledge',
    priority: 'P0',
    artifact: 'public/kb.html',
    capabilities: [
      { id: 'kb_search', ar: 'البحث الداخلي في شبكة المعرفة', anchors: ['src/knowledge/store.js', 'src/knowledge/index.js'] },
      { id: 'source_trust', ar: 'تحليل موثوقية المصادر', anchors: ['src/knowledge/governance.js', 'src/knowledge/validate.js'] },
      { id: 'citations', ar: 'الاستشهاد بالمراجع داخل الإجابات', anchors: ['src/knowledge/schema.js', 'src/kb-routes.js'] },
      { id: 'web_discovery', ar: 'البحث الخارجي واكتشاف المصادر', anchors: ['src/agent/web-fetch.js', 'src/agent/spider-reader.js'] },
      { id: 'conflict_detection', ar: 'اكتشاف المعلومات المتضاربة', anchors: ['src/knowledge/conflict.js', 'src/knowledge/index.js', 'scripts/kb-conflicts.mjs'] }
    ]
  }),
  Object.freeze({
    id: 'memory_context',
    ar: 'الذاكرة وإدارة السياق',
    en: 'Memory & Context',
    priority: 'P0',
    artifact: 'docs/agent-memory-deployment.md',
    capabilities: [
      { id: 'short_term', ar: 'ذاكرة قصيرة المدى داخل التشغيل', anchors: ['src/agent/memory.js'] },
      { id: 'long_term', ar: 'ذاكرة طويلة المدى دائمة', anchors: ['src/agent/store.js'] },
      { id: 'context_window', ar: 'إدارة حجم السياق واختياره', anchors: ['src/context-policy.js'] },
      { id: 'provenance', ar: 'تتبّع مصدر كل معلومة محفوظة', anchors: ['src/agent/evidence.js'] },
      { id: 'consolidation', ar: 'إزالة التكرار وتحديث المعلومات', anchors: ['src/agent/consolidation.js', 'src/knowledge/index.js', 'scripts/memory-consolidate.mjs'] }
    ]
  }),
  Object.freeze({
    id: 'user_experience',
    ar: 'تجربة المستخدم والتفاعل',
    en: 'User Experience',
    priority: 'P0',
    artifact: 'public/system.html',
    capabilities: [
      { id: 'arabic_rtl', ar: 'واجهة عربية RTL', anchors: ['public/system.html', 'e2e/system.spec.js'] },
      { id: 'conversations', ar: 'المحادثات والملفات', anchors: ['public/agent.html', 'src/agent-routes.js'] },
      { id: 'voice', ar: 'الأوامر الصوتية والنصية', anchors: ['public/agent.js'] },
      { id: 'notifications', ar: 'الإشعارات والتنبيهات', anchors: ['src/agent/attention.js', 'scripts/attention.mjs'] },
      { id: 'settings', ar: 'إعدادات المستخدم والتخصيص', anchors: ['public/system.html'] }
    ]
  }),
  Object.freeze({
    id: 'multi_agent',
    ar: 'الوكلاء والتعاون بينهم',
    en: 'Multi-Agent Collaboration',
    priority: 'P1',
    artifact: null,
    capabilities: [
      { id: 'single_agent_runtime', ar: 'وكيل واحد يعمل بالحزام', anchors: ['src/agent/runtime.js', 'src/agent/harness.js'] },
      { id: 'delegation', ar: 'تفويض المهام بين وكلاء', anchors: ['src/agent/delegation.js', 'scripts/delegation.mjs'] },
      { id: 'collaboration_bus', ar: 'قناة تواصل بين الوكلاء', anchors: ['src/agent/collaboration-bus.js'] },
      { id: 'conflict_resolution', ar: 'حل التعارض بين نتائج وكلاء', anchors: [] }
    ]
  }),
  Object.freeze({
    id: 'integrations',
    ar: 'الأدوات والتكاملات الخارجية',
    en: 'Integrations Ecosystem',
    priority: 'P0',
    artifact: 'public/deploy.html',
    capabilities: [
      { id: 'google', ar: 'Google — Gmail وDrive وCalendar', anchors: ['src/agent/gmail.js', 'src/agent/google-read.js'] },
      { id: 'whatsapp', ar: 'WhatsApp Business', anchors: ['src/whatsapp.js', 'workers/celia-edge/whatsapp-store.js'] },
      { id: 'mcp', ar: 'MCP — تصدير الأدوات', anchors: ['src/mcp-contract.js', 'src/celia-mcp.js'] },
      { id: 'hosting', ar: 'Cloudflare وRender', anchors: ['workers/celia-edge/worker.js', 'render.yaml'] },
      { id: 'github', ar: 'GitHub — المستودع وسير العمل', anchors: ['.github/workflows/celia-mcp.yml'] }
    ]
  }),
  Object.freeze({
    id: 'automation',
    ar: 'الأتمتة وإدارة المهام',
    en: 'Automation & Workflow',
    priority: 'P1',
    artifact: null,
    capabilities: [
      { id: 'scheduled', ar: 'المهام المجدولة', anchors: ['workers/celia-edge/cron.js'] },
      { id: 'triggers', ar: 'المشغلات والأحداث', anchors: ['src/agent/outbox.js'] },
      { id: 'retries', ar: 'إعادة المحاولة ومعالجة الفشل', anchors: ['src/resilience.js', 'src/idempotency.js'] },
      { id: 'workflow_engine', ar: 'محرّك تدفقات', anchors: ['src/agent/automation/index.js'] }
    ]
  }),
  Object.freeze({
    id: 'model_intelligence',
    ar: 'النماذج والذكاء والتكلفة',
    en: 'Model Intelligence & Routing',
    priority: 'P1',
    artifact: null,
    capabilities: [
      { id: 'routing', ar: 'اختيار النموذج وتوجيه المهمة', anchors: ['src/agent/model-router.js'] },
      { id: 'local_cloud', ar: 'نماذج محلية وسحابية', anchors: ['src/ollama.js', 'src/gemini.js'] },
      { id: 'latency', ar: 'قياس زمن الاستجابة', anchors: ['src/agent/timing.js'] },
      { id: 'fallback', ar: 'بدائل عند فشل النموذج', anchors: ['src/agent/planner-fallback.js'] },
      { id: 'cost', ar: 'قياس الاستهلاك والتكلفة', anchors: ['src/reply-metrics.js'] }
    ]
  }),
  Object.freeze({
    id: 'reliability',
    ar: 'الاستمرارية والتعافي',
    en: 'Reliability & Recovery',
    priority: 'P1',
    artifact: 'docs/releases-and-recovery.md',
    capabilities: [
      { id: 'backup', ar: 'النسخ الاحتياطي', anchors: ['scripts/deploy-release.mjs'] },
      { id: 'restore', ar: 'استعادة البيانات والإصدارات', anchors: ['docs/releases-and-recovery.md'] },
      { id: 'recovery', ar: 'استعادة المهام المتوقفة', anchors: ['src/agent/outbox.js', 'src/agent/runtime.js'] },
      { id: 'idempotency', ar: 'منع تنفيذ العمليات المكررة', anchors: ['src/idempotency.js'] }
    ]
  }),
  Object.freeze({
    id: 'product_lifecycle',
    ar: 'إدارة دورة حياة المنتج',
    en: 'Product Lifecycle',
    priority: 'P2',
    artifact: 'CHANGELOG.md',
    capabilities: [
      { id: 'roadmap', ar: 'خارطة طريق التطوير', anchors: ['docs/plan-100-percent.md'] },
      { id: 'releases', ar: 'إدارة الإصدارات', anchors: ['src/version.js', 'CHANGELOG.md'] },
      { id: 'decisions', ar: 'سجل القرارات الهندسية', anchors: ['docs/continuity/DECISIONS.md'] },
      { id: 'compatibility', ar: 'التوافق بين الإصدارات', anchors: ['docs/compatibility-contract.md'] }
    ]
  }),
  Object.freeze({
    id: 'resource_operations',
    ar: 'إدارة الموارد والعمليات',
    en: 'Resource & Operations',
    priority: 'P2',
    artifact: 'public/system.html',
    capabilities: [
      { id: 'service_health', ar: 'حالة الخدمات', anchors: ['scripts/service-reality.mjs'] },
      { id: 'queue', ar: 'إدارة طوابير المهام', anchors: ['src/agent/outbox.js'] },
      { id: 'usage', ar: 'استهلاك الموارد', anchors: ['src/memory-pool.js'] },
      { id: 'cost_tracking', ar: 'مراقبة التكاليف', anchors: ['src/reply-metrics.js'] }
    ]
  }),
  Object.freeze({
    id: 'analytics_observability',
    ar: 'التحليلات والمراقبة',
    en: 'Analytics & Observability',
    priority: 'P2',
    artifact: 'public/system.html',
    capabilities: [
      { id: 'evidence_trail', ar: 'سجل الأدلة', anchors: ['src/agent/evidence.js'] },
      { id: 'trace', ar: 'تتبّع الخطوات في اللوحة', anchors: ['public/agent.js'] },
      { id: 'test_metrics', ar: 'قياس الاختبارات والتغطية', anchors: ['scripts/test-reporter-gha.mjs'] },
      { id: 'dashboard', ar: 'لوحة حالة تشغيلية', anchors: ['public/system.html'] }
    ]
  }),
  Object.freeze({
    id: 'security_governance',
    ar: 'الأمان والحوكمة',
    en: 'Security & Governance',
    priority: 'P0',
    artifact: 'docs/access-policy/README.md',
    capabilities: [
      { id: 'policy', ar: 'محرّك السياسة والصلاحيات', anchors: ['src/agent/access-policy.js'] },
      { id: 'approval', ar: 'بوابة الموافقة المربوطة بالبصمة', anchors: ['src/agent/harness.js'] },
      { id: 'sandbox', ar: 'العزل التنفيذي', anchors: ['src/agent/sandbox-policy.js'] },
      { id: 'secrets', ar: 'حماية الأسرار', anchors: ['src/secrets-hub.js', 'src/security.js'] },
      { id: 'audit', ar: 'سجل تدقيق غير قابل للعبث', anchors: ['src/agent/evidence.js'] }
    ]
  })
]);

export const DOMAIN_IDS = Object.freeze(DOMAINS.map((domain) => domain.id));

function testCorpus(root) {
  const dir = path.join(root, 'test');
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => readFileSync(path.join(dir, name), 'utf8'))
    .join('\n');
}

const mention = (corpus, file) => {
  const base = path.basename(file).replace(/\.(m?js)$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9_.-])${base}\\.(?:m?js)`).test(corpus);
};

export function capabilityStatus(capability, { root, corpus }) {
  const anchors = capability.anchors || [];
  if (!anchors.length) return { status: TRUTH.missing, present: [], missing: [], tested: [] };
  const present = anchors.filter((file) => existsSync(path.join(root, file)));
  const missing = anchors.filter((file) => !existsSync(path.join(root, file)));
  const tested = present.filter((file) => mention(corpus, file));
  if (!present.length) return { status: TRUTH.missing, present, missing, tested };
  if (missing.length) return { status: TRUTH.partial, present, missing, tested };
  if (tested.length) return { status: TRUTH.verified, present, missing, tested };
  return { status: TRUTH.unverified, present, missing, tested };
}

/**
 * Audit every domain. The result is the coverage map the owner asked for before any construction:
 * what is proven, what exists unproven, what is half there, and what is absent.
 */
export function buildAtlas({ root = path.resolve(import.meta.dirname, '../..') } = {}) {
  const corpus = testCorpus(root);
  const counts = Object.fromEntries(Object.values(TRUTH).map((status) => [status, 0]));
  const domains = DOMAINS.map((domain) => {
    const capabilities = domain.capabilities.map((capability) => ({
      id: capability.id,
      ar: capability.ar,
      anchors: capability.anchors || [],
      ...capabilityStatus(capability, { root, corpus })
    }));
    const tally = Object.fromEntries(Object.values(TRUTH).map((status) => [status, 0]));
    for (const capability of capabilities) tally[capability.status] += 1;
    const status = tally[TRUTH.verified] === capabilities.length
      ? TRUTH.verified
      : tally[TRUTH.missing] === capabilities.length
        ? TRUTH.missing
        : TRUTH.partial;
    return {
      id: domain.id,
      ar: domain.ar,
      en: domain.en,
      priority: domain.priority,
      artifact: domain.artifact || null,
      artifactExists: Boolean(domain.artifact && existsSync(path.join(root, domain.artifact))),
      status,
      tally,
      capabilities,
      coverage: Math.round(((tally[TRUTH.verified] + tally[TRUTH.partial] * 0.5) / capabilities.length) * 100)
    };
  });
  for (const domain of domains) counts[domain.status] += 1;
  const capabilityCounts = Object.fromEntries(Object.values(TRUTH).map((status) => [status, 0]));
  for (const domain of domains) for (const capability of domain.capabilities) capabilityCounts[capability.status] += 1;
  return {
    version: ATLAS_VERSION,
    domains,
    capabilityCounts,
    stats: {
      domains: domains.length,
      capabilities: Object.values(capabilityCounts).reduce((sum, value) => sum + value, 0),
      domainCounts: counts,
      verified: counts[TRUTH.verified],
      partial: counts[TRUTH.partial],
      missing: counts[TRUTH.missing],
      byPriority: ['P0', 'P1', 'P2'].map((priority) => ({
        priority,
        domains: domains.filter((domain) => domain.priority === priority).map((domain) => domain.id)
      }))
    }
  };
}

/**
 * The facts an outside renderer is allowed to draw: the twelve domains, their verified coverage, the
 * capability states behind that coverage, and the phase tally. This is the only payload a drawing may
 * be built from, and it carries its own provenance.
 *
 * The fingerprint covers **every field below** — names, priorities, coverage, totals, phases and
 * capability states — because a fingerprint over states alone would let an edited percentage keep a
 * valid seal. `verifyFacts` adds the second guard: every number that *can* be derived is recomputed
 * and compared, so a forged coverage fails even if someone recomputes the hash afterwards.
 */
export function factsOf(atlas) {
  const facts = {
    version: atlas.version,
    totals: {
      domains: atlas.stats.domains,
      capabilities: atlas.stats.capabilities,
      verified: atlas.capabilityCounts[TRUTH.verified],
      unverified: atlas.capabilityCounts[TRUTH.unverified],
      missing: atlas.capabilityCounts[TRUTH.missing]
    },
    phases: atlas.stats.byPriority.map((bucket) => ({ priority: bucket.priority, domains: bucket.domains.length })),
    domains: atlas.domains.map((domain) => ({
      id: domain.id,
      ar: domain.ar,
      en: domain.en,
      priority: domain.priority,
      status: domain.status,
      coverage: domain.coverage,
      capabilities: domain.capabilities.map((capability) => ({ id: capability.id, ar: capability.ar, status: capability.status })),
      missing: domain.capabilities.filter((capability) => capability.status === TRUTH.missing).map((capability) => capability.ar)
    }))
  };
  return { fingerprint: fingerprintOfFacts(facts), ...facts };
}

/** Coverage is a published formula, not a number anyone types: verified 1, partial ½, missing 0. */
export function coverageFrom(capabilities) {
  const weight = { [TRUTH.verified]: 1, [TRUTH.partial]: 0.5 };
  const earned = capabilities.reduce((sum, capability) => sum + (weight[capability.status] ?? 0), 0);
  return capabilities.length === 0 ? 0 : Math.round((earned / capabilities.length) * 100);
}

/** SHA-256 of the canonical payload, first ten hex characters. Any edited field changes it. */
export function fingerprintOfFacts(facts) {
  const canonical = JSON.stringify({
    version: facts.version,
    totals: facts.totals,
    phases: facts.phases,
    domains: facts.domains
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 10);
}

/** The fingerprint of an audit, taken over the payload that would be published. */
export function fingerprintOf(atlas) {
  const { fingerprint, ...facts } = factsOf(atlas);
  return fingerprintOfFacts(facts);
}

/**
 * Re-derive every published number from the capability states and report each disagreement.
 * A seal proves the payload was not touched; this proves the payload was not invented.
 */
export function verifyFacts(facts) {
  const problems = [];
  const expect = (path, actual, expected) => {
    if (actual !== expected) problems.push(`${path}: published ${JSON.stringify(actual)} but the states say ${JSON.stringify(expected)}`);
  };
  const tally = Object.fromEntries(Object.values(TRUTH).map((status) => [status, 0]));
  for (const domain of facts.domains ?? []) {
    const local = Object.fromEntries(Object.values(TRUTH).map((status) => [status, 0]));
    for (const capability of domain.capabilities ?? []) {
      if (!Object.hasOwn(tally, capability.status)) problems.push(`${domain.id}/${capability.id}: unknown state ${JSON.stringify(capability.status)}`);
      else local[capability.status] += 1;
      tally[capability.status] = (Object.hasOwn(tally, capability.status) ? tally[capability.status] : 0) + 1;
    }
    expect(`${domain.id}.coverage`, domain.coverage, coverageFrom(domain.capabilities ?? []));
    const missing = (domain.capabilities ?? []).filter((capability) => capability.status === TRUTH.missing).map((capability) => capability.ar);
    if (JSON.stringify(domain.missing) !== JSON.stringify(missing)) {
      problems.push(`${domain.id}.missing: published ${JSON.stringify(domain.missing)} but the states say ${JSON.stringify(missing)}`);
    }
  }
  const totals = facts.totals ?? {};
  expect('totals.domains', totals.domains, (facts.domains ?? []).length);
  expect('totals.capabilities', totals.capabilities, Object.values(tally).reduce((sum, value) => sum + value, 0));
  expect('totals.verified', totals.verified, tally[TRUTH.verified]);
  expect('totals.unverified', totals.unverified, tally[TRUTH.unverified]);
  expect('totals.missing', totals.missing, tally[TRUTH.missing]);
  for (const phase of facts.phases ?? []) {
    expect(`phases.${phase.priority}`, phase.domains, (facts.domains ?? []).filter((domain) => domain.priority === phase.priority).length);
  }
  expect('fingerprint', facts.fingerprint, fingerprintOfFacts(facts));
  return problems;
}

/** The phases the owner asked for: audit → coverage map → staged construction. Never all twelve at once. */
export function phasesOf(atlas) {
  return atlas.stats.byPriority.map((bucket) => ({
    ...bucket,
    rule: bucket.priority === 'P0'
      ? 'الأساسات: تُثبت قبل أي توسّع — المعرفة والذاكرة والتجربة والتكامل والحوكمة.'
      : bucket.priority === 'P1'
        ? 'الطبقة التشغيلية: الأتمتة وتوجيه النماذج والتعافي وتعدد الوكلاء — كل واحد بدليل.'
        : 'القياس والإدارة: الموارد والتحليلات ودورة حياة المنتج.'
  }));
}
