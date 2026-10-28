/**
 * Service retirements — the honest alternative to a dead "configured" secret.
 *
 * A service whose credential is proven dead (no balance, card required, product never enabled) must not keep
 * parading as part of the product. The owner has two levers, both explicit and reversible:
 *   1. a repository variable `CELIA_DISABLE_<SERVICE>=true` (outside Git, owner console), or
 *   2. an entry in `docs/deployment-profile.json` → `serviceRetirements` (inside Git, reviewed in the PR).
 * Both resolve to the same feature flags that `loadFeatures()` already understands, so the audit, the edge
 * Worker bindings and the Render blueprint all tell the same story. An environment value always wins over the
 * manifest; an empty environment value (unset repository variable) does not.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PROFILE_PATH = path.join(ROOT, 'docs', 'deployment-profile.json');

/** Feature names loadFeatures() knows; anything else in the manifest is a typo and is rejected loudly. */
export const RETIRABLE_FEATURES = Object.freeze([
  'gemini', 'ai_gateway', 'deepseek', 'agentrouter', 'elevenlabs', 'figma', 'codata', 'cronjob', 'cloudflare', 'cloudflare_r2', 'ollama'
]);

export function flagNameFor(feature) {
  return `CELIA_DISABLE_${String(feature).toUpperCase()}`;
}

/** Validate a raw `serviceRetirements` object; returns a frozen map feature → { reason, decidedOn, decision, evidence, reversal }. */
export function normalizeRetirements(raw) {
  if (raw === undefined || raw === null) return Object.freeze({});
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('serviceRetirements must be an object keyed by feature name');
  const out = {};
  for (const [feature, entry] of Object.entries(raw)) {
    if (!RETIRABLE_FEATURES.includes(feature)) throw new Error(`serviceRetirements: unknown feature "${feature}" (allowed: ${RETIRABLE_FEATURES.join(', ')})`);
    if (!entry || typeof entry !== 'object') throw new Error(`serviceRetirements.${feature} must be an object`);
    const reason = String(entry.reason || '').trim();
    const decidedOn = String(entry.decidedOn || '').trim();
    if (!reason) throw new Error(`serviceRetirements.${feature}.reason is required`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(decidedOn)) throw new Error(`serviceRetirements.${feature}.decidedOn must be YYYY-MM-DD`);
    out[feature] = Object.freeze({
      reason,
      decidedOn,
      decision: String(entry.decision || '').trim() || null,
      evidence: String(entry.evidence || '').trim() || null,
      reversal: String(entry.reversal || '').trim() || 'delete this entry (and any CELIA_DISABLE_* variable) once the account works again'
    });
  }
  return Object.freeze(out);
}

export function loadServiceRetirements(profilePath = DEFAULT_PROFILE_PATH) {
  let profile;
  try {
    profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({});
    throw error;
  }
  return normalizeRetirements(profile?.serviceRetirements);
}

/** `{ CELIA_DISABLE_X: 'true', … }` for every retired feature. */
export function retirementFlags(retirements) {
  return Object.freeze(Object.fromEntries(Object.keys(retirements || {}).map((feature) => [flagNameFor(feature), 'true'])));
}

/**
 * Merge manifest retirements into an environment: a non-empty environment value is authoritative (the owner's
 * console beats Git); an absent or empty one takes the manifest's `true`.
 */
export function applyRetirementsToEnv(env, retirements) {
  const merged = { ...env };
  for (const [flag, value] of Object.entries(retirementFlags(retirements))) {
    if (!String(merged[flag] ?? '').trim()) merged[flag] = value;
  }
  return merged;
}

/** Which feature a `CELIA_DISABLE_*` flag or feature name is retired by the manifest, with its reason (or null). */
export function retirementOf(retirements, feature) {
  return retirements?.[feature] || null;
}
