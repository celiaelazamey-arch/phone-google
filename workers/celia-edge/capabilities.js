// MAN-001/MAN-003 — one declarative source for "what this runtime can do, and what each
// capability needs before it can actually serve a user".
//
// Why this file exists: `EDGE_CAPABILITIES` used to be a frozen object of literal `true`
// values. It reported `googleOAuth: true` even with no OAuth client configured, which is the
// same class of defect DEC-071 fixed for WhatsApp onboarding: a capability flag that asserts
// readiness it never checked. Production then answered `configured=false` for linking while
// the neighbouring flags still claimed everything was available.
//
// The contract keeps BOTH facts, because they are different questions:
//   mounted    — is the code/route present in this bundle? (structural, build-time)
//   configured — are the settings it needs actually present? (environment, deploy-time)
//
// Existing clients read `capabilities.googleOAuth === true`; that boolean keeps its original
// "mounted" meaning so no client breaks (AGENTS.md: preserve old clients). The derived truth
// is additive under `capabilities.readiness`.
//
// Privacy: requirements are SETTING NAMES ONLY. No value, id, or secret is ever returned.
// This module is imported by both the Worker and scripts/build-manifest.mjs, so the manifest
// and the runtime can never disagree about what a capability requires.

/** Names are operator-facing labels, never values (same rule as DEC-071). */
export const CAPABILITY_REQUIREMENTS = Object.freeze([
  Object.freeze({
    id: 'mcp',
    label: 'MCP',
    requires: Object.freeze([]),
    note: 'tools/list and tools/call are served by the bundle itself.'
  }),
  Object.freeze({
    id: 'stateStore',
    label: 'Durable state (D1)',
    requires: Object.freeze(['DB']),
    labels: Object.freeze({ DB: 'D1' })
  }),
  Object.freeze({
    id: 'googleOAuth',
    label: 'Google account linking',
    requires: Object.freeze(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'DB']),
    labels: Object.freeze({
      GOOGLE_CLIENT_ID: 'Google OAuth client id',
      GOOGLE_CLIENT_SECRET: 'Google OAuth client secret',
      DB: 'D1'
    })
  }),
  Object.freeze({
    id: 'whatsappWebhook',
    label: 'WhatsApp inbound webhook',
    requires: Object.freeze(['WHATSAPP_APP_SECRET', 'DB']),
    labels: Object.freeze({ WHATSAPP_APP_SECRET: 'Meta app secret', DB: 'D1' })
  }),
  Object.freeze({
    id: 'whatsappOnboarding',
    label: 'WhatsApp self-service linking',
    // Mirrors whatsappOnboardingConfig() in whatsapp-store.js. A test asserts the two agree,
    // so this list cannot silently drift from the code that actually gates the flow.
    requires: Object.freeze([
      'WHATSAPP_APP_ID',
      'WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID',
      'WHATSAPP_APP_SECRET',
      'TOKEN_ENCRYPTION_KEY',
      'DB'
    ]),
    labels: Object.freeze({
      WHATSAPP_APP_ID: 'Meta app',
      WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: 'Embedded Signup configuration',
      WHATSAPP_APP_SECRET: 'Meta app secret',
      TOKEN_ENCRYPTION_KEY: 'encryption key',
      DB: 'D1'
    })
  }),
  Object.freeze({
    id: 'aiReply',
    label: 'Cloud AI reply',
    requires: Object.freeze([]),
    // Any one provider is enough. With none configured the local Arabic rules guard still
    // answers, so the route stays mounted and useful — `configured:false` means "no cloud
    // provider", never "the endpoint is broken".
    anyOf: Object.freeze(['GEMINI_API_KEY', 'AI_GATEWAY_API_KEY', 'DEEPSEEK_API_KEY', 'AGENETROUTERAPI_KEY']),
    labels: Object.freeze({
      GEMINI_API_KEY: 'a cloud AI provider key (Gemini / AI Gateway / DeepSeek / AgentRouter)'
    })
  }),
  Object.freeze({
    id: 'cronScheduler',
    label: 'Governed cron scheduler',
    requires: Object.freeze(['CELIAOS_CRONJOB_ORG_API_KEY']),
    labels: Object.freeze({ CELIAOS_CRONJOB_ORG_API_KEY: 'cron-job.org API key' })
  })
]);

/** Same placeholder rule the Worker already uses for tracked secrets. */
function present(env, name) {
  if (name === 'DB') return Boolean(env?.DB);
  const value = String(env?.[name] ?? '').trim();
  return Boolean(value && !/^replace-with-/i.test(value));
}

function labelFor(requirement, name) {
  return requirement.labels?.[name] || name;
}

/**
 * Derive readiness for every declared capability.
 * Returns names of missing settings only — never values (DEC-071, check:secrets).
 */
export function deriveCapabilityReadiness(env = {}) {
  const readiness = {};
  for (const requirement of CAPABILITY_REQUIREMENTS) {
    const missing = requirement.requires.filter((name) => !present(env, name)).map((name) => labelFor(requirement, name));
    if (requirement.anyOf?.length && !requirement.anyOf.some((name) => present(env, name))) {
      // One human-readable label for the whole group, not four secret names.
      missing.push(labelFor(requirement, requirement.anyOf[0]));
    }
    readiness[requirement.id] = { configured: missing.length === 0, missing };
  }
  return readiness;
}

/** Setting names a capability needs, for the manifest and for deploy-workflow coverage tests. */
export function capabilitySettingNames() {
  const names = new Set();
  for (const requirement of CAPABILITY_REQUIREMENTS) {
    for (const name of requirement.requires) names.add(name);
    for (const name of requirement.anyOf || []) names.add(name);
  }
  names.delete('DB'); // a binding, not a secret/var
  return [...names].sort();
}
