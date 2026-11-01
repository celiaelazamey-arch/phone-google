// VFE-006 / DEC-087 — the System Atlas. The owner asked for an audit before construction, so these
// tests hold the audit to its own rules: twelve domains, every claim cited, every status derived, and
// a page that cannot drift from the findings. A domain with nothing behind it must say so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ATLAS_VERSION,
  DOMAINS,
  DOMAIN_IDS,
  PRIORITY_MEANING,
  TRUTH,
  TRUTH_MARK,
  buildAtlas,
  capabilityStatus,
  phasesOf
} from '../src/design/system-atlas.js';
import { PAGE_PATH, buildHtml } from '../scripts/render-system-atlas.mjs';

const root = path.resolve(import.meta.dirname, '..');
const atlas = buildAtlas({ root });

test('twelve domains, in the owner\'s order, each with a priority he chose', () => {
  assert.equal(DOMAINS.length, 12);
  assert.deepEqual(DOMAIN_IDS, [
    'cognitive_knowledge',
    'memory_context',
    'user_experience',
    'multi_agent',
    'integrations',
    'automation',
    'model_intelligence',
    'reliability',
    'product_lifecycle',
    'resource_operations',
    'analytics_observability',
    'security_governance'
  ]);
  for (const domain of atlas.domains) {
    assert.ok(['P0', 'P1', 'P2'].includes(domain.priority), `${domain.id} has no priority`);
    assert.ok(domain.ar && domain.en, `${domain.id} needs a readable name`);
    assert.ok(domain.capabilities.length >= 4, `${domain.id} lists fewer than four capabilities`);
    assert.ok(domain.coverage >= 0 && domain.coverage <= 100);
  }
  assert.deepEqual(atlas.domains.filter((domain) => domain.priority === 'P0').map((domain) => domain.id), [
    'cognitive_knowledge',
    'memory_context',
    'user_experience',
    'integrations',
    'security_governance'
  ]);
});

test('every cited anchor exists; an empty citation list is the only allowed way to say "absent"', () => {
  for (const domain of atlas.domains) {
    for (const capability of domain.capabilities) {
      for (const anchor of capability.anchors) {
        assert.ok(existsSync(path.join(root, anchor)), `${domain.id}/${capability.id} cites ${anchor}, which is missing`);
      }
      if (capability.status === TRUTH.missing) {
        assert.equal(capability.anchors.length, 0, `${capability.id} claims absence while citing files`);
      } else {
        assert.ok(capability.anchors.length > 0, `${capability.id} claims presence without a file`);
      }
    }
  }
});

test('status is derived from files and tests, not chosen', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'atlas-'));
  writeFileSync(path.join(dir, 'thing.js'), 'export const x = 1;\n');
  const corpusWith = 'test/thing.test.js: import { x } from "../src/thing.js";';
  assert.equal(capabilityStatus({ anchors: [] }, { root: dir, corpus: '' }).status, TRUTH.missing);
  assert.equal(capabilityStatus({ anchors: ['thing.js'] }, { root: dir, corpus: '' }).status, TRUTH.unverified);
  assert.equal(capabilityStatus({ anchors: ['thing.js'] }, { root: dir, corpus: corpusWith }).status, TRUTH.verified);
  assert.equal(capabilityStatus({ anchors: ['thing.js', 'gone.js'] }, { root: dir, corpus: corpusWith }).status, TRUTH.partial);
  assert.equal(capabilityStatus({ anchors: ['gone.js'] }, { root: dir, corpus: corpusWith }).status, TRUTH.missing);
  mkdirSync(path.join(dir, 'nested'), { recursive: true });
  writeFileSync(path.join(dir, 'nested', 'deep.js'), '');
  assert.equal(capabilityStatus({ anchors: ['nested/deep.js'] }, { root: dir, corpus: corpusWith }).status, TRUTH.unverified);
});

test('the audit admits what the system does not have — no domain is painted complete', () => {
  const counts = atlas.capabilityCounts;
  assert.ok(counts[TRUTH.missing] >= 4, 'the audit must find real gaps');
  assert.ok(counts[TRUTH.verified] > counts[TRUTH.missing], 'most declared capabilities are backed by code');
  assert.ok(atlas.stats.partial >= 5, 'most domains are partly there, and the atlas says so');
  const multi = atlas.domains.find((domain) => domain.id === 'multi_agent');
  assert.notEqual(multi.status, TRUTH.verified, 'one agent is not a multi-agent system');
  assert.ok(multi.tally[TRUTH.missing] >= 3, 'delegation, collaboration and conflict resolution are absent');
  const cognitive = atlas.domains.find((domain) => domain.id === 'cognitive_knowledge');
  assert.ok(cognitive.tally[TRUTH.missing] >= 1, 'conflict detection is absent');
});

test('the seven states are reused, not reinvented', () => {
  assert.deepEqual(Object.values(TRUTH_MARK), ['🟢', '🟠', '🟡', '🔵', '🔴', '⚪', '⛔']);
  assert.equal(Object.keys(TRUTH).length, 7);
  assert.equal(ATLAS_VERSION, 'celiaos-system-atlas-v1');
});

test('the phases follow P0 → P1 → P2 and partition the twelve domains', () => {
  const phases = phasesOf(atlas);
  assert.deepEqual(phases.map((phase) => phase.priority), ['P0', 'P1', 'P2']);
  const covered = phases.flatMap((phase) => phase.domains);
  assert.equal(covered.length, 12);
  assert.deepEqual([...covered].sort(), [...DOMAIN_IDS].sort());
  for (const phase of phases) assert.ok(phase.rule && phase.rule.length > 20, `${phase.priority} needs a rule`);
  assert.match(PRIORITY_MEANING.P0, /المعرفة|الذاكرة/);
});

test('the atlas page is generated from the audit and cannot drift', () => {
  assert.ok(existsSync(PAGE_PATH));
  const page = readFileSync(PAGE_PATH, 'utf8');
  assert.equal(page, buildHtml(), 'the atlas is stale — run `npm run atlas`');
  assert.match(page, /<html lang="ar" dir="rtl">/);
  assert.match(page, /name="celia-visual"/);
  assert.match(page, /public\/fonts\//, 'fonts stay local');
  for (const domain of atlas.domains) {
    const escaped = domain.ar.replace(/&/g, '&amp;');
    assert.ok(page.includes(escaped), `the atlas omits ${domain.id}`);
  }
  assert.match(page, /المراحل/, 'the atlas prints the phases the owner asked for');
});

test('the permanent rule names the atlas and the audit-first order', () => {
  const agents = readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(agents, /System Atlas/);
  assert.match(agents, /npm run atlas:check/);
  assert.match(agents, /audit/i, 'the rule must start with the audit, not the build');
});
