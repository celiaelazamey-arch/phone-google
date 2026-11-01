import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  DOMAINS,
  TRUTH,
  buildAtlas,
  coverageFrom,
  factsOf,
  fingerprintOf,
  verifyFacts
} from '../src/design/system-atlas.js';
import {
  DASHBOARD_PATH,
  averageCoverage,
  buildHtml,
  gapLine,
  nextGap
} from '../scripts/render-atlas-dashboard.mjs';

const root = path.resolve(import.meta.dirname, '..');
const atlas = buildAtlas({ root });
const facts = factsOf(atlas);
const html = readFileSync(DASHBOARD_PATH, 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));
const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const cardsOf = (source) =>
  [...source.matchAll(/<article class="card[^"]*" data-domain="([a-z_]+)" data-coverage="(\d+)" data-priority="([A-Z0-9]+)"[^>]*>([\s\S]*?)<\/article>/g)].map(
    (match) => ({ id: match[1], coverage: Number(match[2]), priority: match[3], body: match[4] })
  );

test('the dashboard on disk is exactly what the audit generates', () => {
  assert.equal(html, buildHtml(), 'stale dashboard — run `npm run atlas:dashboard`');
  assert.ok(html.startsWith('<!doctype html>') && html.includes('dir="rtl"') && html.includes('lang="ar"'));
});

test('twelve cards, in the owner\'s order, with the measured coverage — ready to compare with his drawing', () => {
  const cards = cardsOf(html);
  assert.equal(cards.length, 12);
  assert.deepEqual(cards.map((card) => card.id), facts.domains.map((domain) => domain.id));
  assert.deepEqual(cards.map((card) => card.coverage), [80, 100, 60, 25, 80, 100, 100, 75, 25, 100, 75, 100]);
  assert.deepEqual(cards.map((card) => card.priority), ['P0', 'P0', 'P0', 'P1', 'P0', 'P1', 'P1', 'P1', 'P2', 'P2', 'P2', 'P0']);
  for (const [index, card] of cards.entries()) {
    assert.equal(card.coverage, facts.domains[index].coverage);
    assert.equal(card.coverage, coverageFrom(facts.domains[index].capabilities), `${card.id} must follow the published formula`);
  }
  // The drawing the owner received labelled Integrations as P1 while its own roadmap counted five P0
  // domains. The audit says Integrations is P0, and the dashboard must say what the audit says.
  assert.equal(cards[4].id, 'integrations');
  assert.equal(cards[4].priority, 'P0');
});

test('every card is bilingual and names its state and its gap', () => {
  for (const domain of facts.domains) {
    const block = html.slice(html.indexOf(`data-domain="${domain.id}"`));
    const body = block.slice(0, block.indexOf('</article>'));
    assert.ok(body.includes(esc(domain.ar)), `${domain.id} needs its Arabic name`);
    assert.ok(body.includes(esc(domain.en)), `${domain.id} needs its English name`);
    assert.ok(body.includes('lang="en"'), `${domain.id} needs an English line`);
    const gap = gapLine(domain);
    assert.ok(body.includes(esc(gap.ar.slice(0, 18))), `${domain.id} must name its gap`);
    if (gap.kind === 'gap') {
      assert.ok(domain.coverage < 100, `${domain.id} has a gap and must not read 100%`);
      const missing = domain.capabilities.filter((capability) => capability.status === TRUTH.missing);
      for (const capability of missing) assert.ok(body.includes(capability.id), `${capability.id} must be named in English`);
    }
    if (domain.coverage === 100) assert.equal(gap.kind, 'done', `${domain.id} is complete and must say so`);
  }
});

test('the summary is the audit, not a retyped summary', () => {
  assert.deepEqual(facts.totals, {
    domains: 12,
    capabilities: 54,
    verified: 42,
    unverified: 9,
    missing: 3
  });
  for (const value of [42, 9, 3, 54]) assert.ok(html.includes(`<b>${value}</b>`), `missing total ${value}`);
  assert.equal(averageCoverage(facts), 77, 'the mean of 80,100,60,25,80,100,100,75,25,100,75,100 is 77');
  assert.ok(html.includes('<b>77%</b>'));
  assert.ok(html.includes('<b>71.67%</b>') === false, 'no unrounded average may leak into the page');
  const phases = html.match(/<strong>(\d+)<\/strong>/g) ?? [];
  assert.deepEqual(phases.map((value) => Number(value.replace(/\D/g, ''))).slice(0, 3), facts.phases.map((phase) => phase.domains));
  assert.deepEqual(facts.phases.map((phase) => phase.domains), [5, 4, 3]);
});

test('the next priority is derived from the audit — every P0 gap is closed, so it moved to P1', () => {
  const next = nextGap(facts);
  assert.equal(next.gap.id, 'delegation');
  assert.equal(next.domain.id, 'multi_agent');
  assert.equal(next.priority, 'P1');
  assert.ok(html.includes(next.gap.ar), 'the panel must name the new gap in the owner\'s words');
  assert.ok(html.includes('data-p0-clear="true"'), 'with no P0 gap left, the panel must say so');
  for (const closed of ['conflict_detection', 'consolidation', 'notifications']) {
    assert.ok(!html.includes(closed), `${closed} is closed and must not be advertised as next`);
  }
  const p0Gaps = facts.domains.filter((domain) => domain.priority === 'P0').flatMap((domain) => domain.missing);
  assert.deepEqual(p0Gaps, [], 'the audit itself must agree that no P0 capability is absent');
  const settled = clone(facts);
  for (const domain of settled.domains) for (const capability of domain.capabilities) if (capability.status === TRUTH.missing) capability.status = TRUTH.verified;
  assert.equal(nextGap(settled), null, 'when the gaps close, the panel must disappear');
});

test('no date, no impact claim, no capability the audit does not know', () => {
  assert.ok(!/آخر تحديث|أُحدث|تحديث:/.test(html));
  assert.ok(!/أكتوبر|نوفمبر|سبتمبر/.test(html));
  assert.ok(!/\b\d{4}-\d{2}-\d{2}\b/.test(html));
  assert.ok(!/الأثر|impact:|expected benefit/i.test(html));
  const known = new Set(DOMAINS.flatMap((domain) => domain.capabilities.map((capability) => capability.id)));
  const shown = new Set([...html.matchAll(/class="mono">([a-z][a-z0-9_]{3,})</g)].map((match) => match[1]));
  for (const id of shown) {
    if (id.includes('_')) assert.ok(known.has(id), `the dashboard names ${id}, which is not in the audit`);
  }
});

test('the seal is the audit seal, and a tampered payload cannot be drawn at all', () => {
  assert.equal(facts.fingerprint, fingerprintOf(atlas));
  assert.ok(html.includes(`<b class="mono">${facts.fingerprint}</b>`) || html.includes(`>${facts.fingerprint}<`));
  const tampered = clone(facts);
  tampered.domains[2].coverage = 88;
  assert.ok(verifyFacts(tampered).length > 0);
  assert.throws(() => buildHtml({ facts: tampered }), /refusing to draw/);
});
