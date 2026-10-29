import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeStore } from '../src/knowledge/store.js';
import { ingestDirectory } from '../src/knowledge/ingest.js';
import {
  CLAIM_TYPES,
  PLANNER_KB_POLICY,
  plannerEligibility,
  reviewStatus
} from '../src/knowledge/governance.js';

const registryDir = path.resolve(import.meta.dirname, '..', 'data', 'kb');
const NOW = Date.parse('2026-10-29T12:00:00.000Z');

async function seeded(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-kb-governance-'));
  const file = path.join(directory, 'kb.sqlite3');
  const store = await KnowledgeStore.open({ file, clock: () => NOW });
  await ingestDirectory({ store, directory: registryDir, dryRun: false, full: true, clock: () => NOW });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, directory };
}

test('knowledge governance: claim types and review deadlines have closed, explicit semantics', () => {
  assert.deepEqual([...CLAIM_TYPES], [
    'operational_guidance',
    'historical_report',
    'unverified_recommendation',
    'deprecated_security_practice'
  ]);
  assert.equal(reviewStatus('2026-10-29', NOW), 'current', 'a date-only deadline includes its UTC day');
  assert.equal(reviewStatus('2026-10-28', NOW), 'expired');
  assert.equal(reviewStatus(null, NOW), 'missing');
  assert.equal(reviewStatus('not-a-date', NOW), 'invalid');
  assert.equal(reviewStatus('2027-02-30', NOW), 'invalid');

  const safe = {
    kind: 'doc',
    trust: 'T1',
    claimType: 'operational_guidance',
    reviewDue: '2027-01-27'
  };
  assert.deepEqual(plannerEligibility(safe, NOW), { eligible: true, reviewStatus: 'current', reasons: [] });
  assert.equal(plannerEligibility({ ...safe, trust: 'T2' }, NOW).eligible, true);
  for (const claimType of CLAIM_TYPES.filter((type) => type !== 'operational_guidance')) {
    const result = plannerEligibility({ ...safe, claimType }, NOW);
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.includes('claim_type_not_operational'));
  }
  for (const [change, reason] of [
    [{ kind: 'concept' }, 'kind_not_document'],
    [{ trust: 'T3' }, 'trust_not_planner_allowed'],
    [{ reviewDue: '2026-10-28' }, 'review_expired'],
    [{ reviewDue: null }, 'review_missing']
  ]) {
    const result = plannerEligibility({ ...safe, ...change }, NOW);
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.includes(reason), `${reason} is reported`);
  }
  assert.equal(PLANNER_KB_POLICY.profile, 'planner-safe-v1');
});

test('knowledge store: planner profile excludes unsafe claims and unsafe direct entity matches', async (t) => {
  const { store } = await seeded(t);
  store.upsertSource({
    id: 'src-governance-test',
    kind: 'csv',
    uri: 'repo://governance-test.csv',
    license: 'internal-owner',
    trust: 'T2',
    staleAfterDays: 365,
    lastSyncAt: '2026-10-29'
  });
  const cases = [
    { id: 'gov-safe-t1', trust: 'T1', claimType: 'operational_guidance', reviewDue: '2027-01-27' },
    { id: 'gov-safe-t2', trust: 'T2', claimType: 'operational_guidance', reviewDue: '2027-01-27' },
    { id: 'gov-historical', trust: 'T1', claimType: 'historical_report', reviewDue: '2027-01-27' },
    { id: 'gov-unverified', trust: 'T2', claimType: 'unverified_recommendation', reviewDue: '2027-01-27' },
    { id: 'gov-deprecated', trust: 'T1', claimType: 'deprecated_security_practice', reviewDue: '2027-01-27' },
    { id: 'gov-expired', trust: 'T1', claimType: 'operational_guidance', reviewDue: '2026-10-28' },
    { id: 'gov-low-trust', trust: 'T3', claimType: 'operational_guidance', reviewDue: '2027-01-27' },
    { id: 'gov-concept', kind: 'concept', trust: 'T1', claimType: 'operational_guidance', reviewDue: '2027-01-27' },
    { id: 'gov-legacy', trust: 'T1', claimType: null, reviewDue: null }
  ];
  for (const entry of cases) {
    store.putItem({
      id: entry.id,
      sourceId: 'src-governance-test',
      kind: entry.kind || 'doc',
      title: `اختبارحوكمة ${entry.id}`,
      body: `نص اختبارحوكمة للسياسة ${entry.id}`,
      contentHash: `hash-${entry.id}`,
      trust: entry.trust,
      uri: `https://example.test/${entry.id}`,
      sourceUpdatedAt: '2026-10-29',
      claimType: entry.claimType,
      reviewDue: entry.reviewDue
    });
  }
  store.putEntity({
    id: 'ent-gov-safe',
    type: 'tool',
    key: 'gov_safe_tool',
    title: 'اختبارحوكمة الأداة الآمنة',
    evidenceItemId: 'gov-safe-t1',
    trust: 'T1',
    risk: 'read',
    wired: true
  });
  store.putEntity({
    id: 'ent-gov-unsafe',
    type: 'tool',
    key: 'gov_unsafe_tool',
    title: 'اختبارحوكمة الأداة التاريخية',
    evidenceItemId: 'gov-historical',
    trust: 'T1',
    risk: 'read',
    wired: true
  });

  const ordinary = store.search({ query: 'اختبارحوكمة', limit: 20, maxChars: 6000 });
  assert.equal(ordinary.items.length, cases.length);
  assert.equal(ordinary.governance, undefined);
  assert.ok(ordinary.items.some((item) => item.id === 'gov-historical'));
  assert.ok(ordinary.entities.some((entity) => entity.key === 'gov_unsafe_tool'));

  const planner = store.search({ query: 'اختبارحوكمة', limit: 20, maxChars: 6000, profile: 'planner' });
  assert.deepEqual(planner.items.map((item) => item.id).sort(), ['gov-safe-t1', 'gov-safe-t2']);
  assert.equal(planner.governance.profile, PLANNER_KB_POLICY.profile);
  assert.equal(planner.governance.excluded, cases.length - 2);
  assert.equal(planner.reason, null);
  assert.deepEqual(planner.entities.map((entity) => entity.key), ['gov_safe_tool']);
  assert.equal(planner.edges.length, 0, 'planner does not receive graph edges from ungoverned neighbours');
  for (const item of planner.items) {
    assert.equal(item.claimType, 'operational_guidance');
    assert.equal(item.reviewStatus, 'current');
    assert.equal(item.plannerEligible, true);
    assert.ok(['T1', 'T2'].includes(item.trust));
  }

  store.putItem({
    id: 'gov-only-historical',
    sourceId: 'src-governance-test',
    kind: 'doc',
    title: 'منعتاريخي',
    body: 'نص منعتاريخي وحده',
    contentHash: 'hash-gov-only-historical',
    trust: 'T1',
    uri: 'https://example.test/gov-only-historical',
    claimType: 'historical_report',
    reviewDue: '2027-01-27'
  });
  const historicalByText = store.search({ query: 'منعتاريخي', profile: 'planner' });
  assert.equal(historicalByText.items.length, 0);
  assert.equal(historicalByText.reason, 'no_planner_eligible_knowledge');
});

test('knowledge store: additive v1 upgrade and backup round-trip preserve governance fields', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-kb-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'kb.sqlite3');
  const initial = await KnowledgeStore.open({ file, clock: () => NOW });
  initial.db.exec('ALTER TABLE items DROP COLUMN claim_type');
  initial.db.exec('ALTER TABLE items DROP COLUMN review_due');
  initial.db.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
  initial.close();

  const upgraded = await KnowledgeStore.open({ file, clock: () => NOW });
  t.after(() => upgraded.close());
  assert.equal(upgraded.stats().schemaVersion, 2);
  const columns = upgraded.db.prepare('PRAGMA table_info(items)').all().map((column) => column.name);
  assert.ok(columns.includes('claim_type'));
  assert.ok(columns.includes('review_due'));
  upgraded.upsertSource({
    id: 'src-backup-governance',
    kind: 'csv',
    uri: 'repo://backup-governance.csv',
    license: 'internal-owner',
    trust: 'T1',
    staleAfterDays: 365
  });
  upgraded.putItem({
    id: 'kb-backup-governance',
    sourceId: 'src-backup-governance',
    kind: 'doc',
    title: 'سجل قابل للاستعادة',
    body: 'نص سجل قابل للاستعادة',
    contentHash: 'backup-governance-hash',
    trust: 'T1',
    uri: 'https://example.test/governance',
    claimType: 'operational_guidance',
    reviewDue: '2027-01-27'
  });
  const backup = upgraded.exportJsonl();
  const restored = await KnowledgeStore.open({ file: path.join(directory, 'restored.sqlite3'), clock: () => NOW });
  t.after(() => restored.close());
  restored.importJsonl(backup);
  const item = restored.getItem('kb-backup-governance');
  assert.equal(item.claim_type, 'operational_guidance');
  assert.equal(item.review_due, '2027-01-27');
  assert.equal(restored.search({ query: 'للاستعادة', profile: 'planner' }).items[0].plannerEligible, true);
});
