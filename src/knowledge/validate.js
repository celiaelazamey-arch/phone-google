import { CLAIM_TYPES, isValidReviewDate } from './governance.js';

/**
 * Registry contracts. A CSV row is data, never authority: risk levels must match
 * the canonical tool policy in code (`src/knowledge/tool-policy.js`), licenses are
 * an allow-list, and any value that looks like a credential rejects the row.
 */

export const ALLOWED_LICENSES = Object.freeze([
  'MIT',
  'Apache-2.0',
  'BSD-3-Clause',
  'MPL-2.0',
  'CC0-1.0',
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'ODbL-1.0',
  'PDDL-1.0',
  'OGL-3.0',
  'internal-owner',
  'public-domain',
  'reference-only'
]);

/**
 * Licences that only describe an EXTERNAL source we may link to and take our own notes
 * from (video, article, talk) — never content we may copy. They are valid on `sources`
 * rows only; a knowledge/skill/tool row carrying one is rejected (CELIA-LEARN-001).
 */
export const SOURCE_ONLY_LICENSES = Object.freeze(['reference-only']);

export const TRUST_LEVELS = Object.freeze(['T1', 'T2', 'T3']);
export const RISK_LEVELS = Object.freeze(['read', 'internal_write', 'external_effect', 'irreversible']);
export const SOURCE_KINDS = Object.freeze(['drive', 'sheet', 'csv', 'github', 'open_data', 'api', 'manual', 'video']);

const ID = /^[a-z0-9][a-z0-9_.-]{2,63}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?$/;
const HTTPS = /^https:\/\/[^\s]+$/;

const SECRET_PATTERNS = [
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['aws_key', /\bAKIA[0-9A-Z]{16}\b/],
  ['github_token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/],
  ['github_pat', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['openai_key', /\bsk-[A-Za-z0-9_-]{16,}\b/],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ['slack_token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['generic_secret', /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[=:]\s*\S{4,}/i],
  ['bearer', /\bBearer\s+[A-Za-z0-9._-]{20,}\b/]
];

/** Returns the credential kind found in a value, or null. */
export function findSecret(value) {
  const text = String(value ?? '');
  if (!text) return null;
  for (const [kind, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return null;
}

export const SCHEMAS = Object.freeze({
  knowledge: {
    required: ['id', 'title', 'type', 'description', 'source_url', 'license', 'updated_at', 'trust_level', 'claim_type', 'review_due'],
    optional: ['related', 'tags', 'lang', 'aliases']
  },
  tools: {
    required: ['id', 'name', 'category', 'risk_level', 'requires_approval', 'api_endpoint', 'docs_url', 'owner'],
    optional: ['skills', 'data_egress', 'notes', 'aliases']
  },
  skills: {
    required: ['id', 'name', 'level', 'category', 'source', 'evidence_url'],
    optional: ['projects', 'tools', 'notes', 'aliases']
  },
  projects: {
    required: ['id', 'name', 'domain', 'status', 'priority', 'owner', 'repo_url'],
    optional: ['related', 'notes', 'aliases']
  },
  sources: {
    required: ['id', 'name', 'kind', 'uri', 'license', 'last_sync', 'trust_level', 'stale_after_days'],
    optional: ['notes', 'aliases']
  }
});

export const KNOWLEDGE_TYPES = Object.freeze(['tool', 'skill', 'project', 'person', 'dataset', 'concept', 'source', 'doc']);

const fail = (code, field) => ({ ok: false, code, field });

/**
 * Structural check before reading any row: required columns present, unknown
 * columns reported as warnings (a typo in a header must be visible, not silent).
 */
export function checkHeader(kind, header) {
  const schema = SCHEMAS[kind];
  if (!schema) return { ok: false, code: 'unknown_kind' };
  const missing = schema.required.filter((column) => !header.includes(column));
  if (missing.length) return { ok: false, code: 'missing_columns', missing };
  const unknown = header.filter((column) => !schema.required.includes(column) && !schema.optional.includes(column));
  return { ok: true, warnings: unknown.map((column) => ({ code: 'unknown_column', field: column })) };
}

const parseBool = (value) => {
  const text = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(text)) return true;
  if (['false', '0', 'no', 'n'].includes(text)) return false;
  return null;
};

const splitList = (value) =>
  String(value ?? '')
    .split(/[;,|]/)
    .map((item) => item.trim())
    .filter(Boolean);

function baseChecks(values) {
  for (const [key, value] of Object.entries(values)) {
    const secret = findSecret(value);
    if (secret) return fail(`secret_${secret}`, key);
  }
  return null;
}

/** Validates and normalizes one registry row. Returns {ok, record} or {ok:false, code, field}. */
export function validateRow(kind, values, { canonicalRisk } = {}) {
  const secretHit = baseChecks(values);
  if (secretHit) return secretHit;
  const id = values.id || '';
  if (!ID.test(id)) return fail('invalid_id', 'id');
  if (!values.license && SCHEMAS[kind].required.includes('license')) return fail('license_missing', 'license');
  if (values.license && !ALLOWED_LICENSES.includes(values.license)) return fail('license_not_allowed', 'license');
  if (values.license && SOURCE_ONLY_LICENSES.includes(values.license) && kind !== 'sources') {
    return fail('license_not_allowed', 'license');
  }
  if (values.trust_level && !TRUST_LEVELS.includes(values.trust_level)) return fail('invalid_trust_level', 'trust_level');

  if (kind === 'knowledge') {
    if (!KNOWLEDGE_TYPES.includes(values.type) && !['doc'].includes(values.type)) return fail('invalid_type', 'type');
    if (!HTTPS.test(values.source_url)) return fail('invalid_source_url', 'source_url');
    if (!ISO_DATE.test(values.updated_at)) return fail('invalid_updated_at', 'updated_at');
    if (!values.claim_type) return fail('claim_type_required', 'claim_type');
    if (!CLAIM_TYPES.includes(values.claim_type)) return fail('invalid_claim_type', 'claim_type');
    if (!values.review_due) return fail('review_due_required', 'review_due');
    if (!isValidReviewDate(values.review_due)) return fail('invalid_review_due', 'review_due');
    if (String(values.review_due).slice(0, 10) < String(values.updated_at).slice(0, 10)) {
      return fail('review_due_before_update', 'review_due');
    }
    return {
      ok: true,
      record: {
        id,
        title: values.title,
        type: values.type,
        description: values.description || values.title,
        sourceUrl: values.source_url,
        license: values.license,
        updatedAt: values.updated_at,
        trust: values.trust_level,
        claimType: values.claim_type,
        reviewDue: values.review_due,
        related: splitList(values.related),
        tags: splitList(values.tags),
        aliases: splitList(values.aliases),
        lang: values.lang || 'mixed'
      }
    };
  }

  if (kind === 'tools') {
    if (!RISK_LEVELS.includes(values.risk_level)) return fail('invalid_risk_level', 'risk_level');
    const canonical = typeof canonicalRisk === 'function' ? canonicalRisk(id) : null;
    if (canonical) {
      if (canonical.risk !== values.risk_level) return fail('registry_risk_mismatch', 'risk_level');
      if (canonical.requiresApproval !== parseBool(values.requires_approval)) {
        return fail('registry_approval_mismatch', 'requires_approval');
      }
    } else if (values.risk_level !== 'read' && parseBool(values.requires_approval) !== true) {
      // Catalog-only tools may not claim an unguarded write path.
      return fail('catalog_tool_requires_approval', 'requires_approval');
    }
    const approval = parseBool(values.requires_approval);
    if (approval === null) return fail('invalid_boolean', 'requires_approval');
    if (!values.api_endpoint.startsWith('/') && !HTTPS.test(values.api_endpoint)) return fail('invalid_api_endpoint', 'api_endpoint');
    if (!HTTPS.test(values.docs_url)) return fail('invalid_docs_url', 'docs_url');
    const egress = values.data_egress ? parseBool(values.data_egress) : false;
    if (egress === null) return fail('invalid_boolean', 'data_egress');
    return {
      ok: true,
      record: {
        id,
        title: values.name,
        category: values.category,
        risk: values.risk_level,
        requiresApproval: approval,
        apiEndpoint: values.api_endpoint,
        docsUrl: values.docs_url,
        owner: values.owner,
        wired: Boolean(canonical),
        dataEgress: egress,
        skills: splitList(values.skills),
        aliases: splitList(values.aliases),
        notes: values.notes || ''
      }
    };
  }

  if (kind === 'skills') {
    if (!values.name || !values.level || !values.category) return fail('missing_field', 'name');
    if (!HTTPS.test(values.evidence_url)) return fail('invalid_evidence_url', 'evidence_url');
    return {
      ok: true,
      record: {
        id,
        title: values.name,
        level: values.level,
        category: values.category,
        source: values.source,
        evidenceUrl: values.evidence_url,
        projects: splitList(values.projects),
        tools: splitList(values.tools),
        aliases: splitList(values.aliases),
        notes: values.notes || ''
      }
    };
  }

  if (kind === 'projects') {
    if (!values.name || !values.domain) return fail('missing_field', 'name');
    if (!HTTPS.test(values.repo_url)) return fail('invalid_repo_url', 'repo_url');
    if (!['active', 'paused', 'archived', 'planned'].includes(values.status)) return fail('invalid_status', 'status');
    return {
      ok: true,
      record: {
        id,
        title: values.name,
        domain: values.domain,
        status: values.status,
        priority: values.priority,
        owner: values.owner,
        repoUrl: values.repo_url,
        related: splitList(values.related),
        aliases: splitList(values.aliases),
        notes: values.notes || ''
      }
    };
  }

  if (kind === 'sources') {
    if (!SOURCE_KINDS.includes(values.kind)) return fail('invalid_source_kind', 'kind');
    if (!values.uri || (!HTTPS.test(values.uri) && !values.uri.startsWith('repo://'))) return fail('invalid_uri', 'uri');
    if (!ISO_DATE.test(values.last_sync)) return fail('invalid_last_sync', 'last_sync');
    const stale = Number(values.stale_after_days);
    if (!Number.isInteger(stale) || stale < 1 || stale > 3650) return fail('invalid_stale_after_days', 'stale_after_days');
    return {
      ok: true,
      record: {
        id,
        title: values.name,
        kind: values.kind,
        uri: values.uri,
        license: values.license,
        lastSync: values.last_sync,
        trust: values.trust_level,
        staleAfterDays: stale,
        aliases: splitList(values.aliases),
        notes: values.notes || ''
      }
    };
  }

  return fail('unknown_kind');
}
