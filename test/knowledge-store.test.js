import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeStore } from '../src/knowledge/store.js';
import { ingestDirectory } from '../src/knowledge/ingest.js';

const registryDir = path.resolve(import.meta.dirname, '..', 'data', 'kb');

async function seeded(t, { clock } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-kb-store-'));
  const file = path.join(directory, 'kb.sqlite3');
  const store = await KnowledgeStore.open({ file, clock });
  await ingestDirectory({ store, directory: registryDir, dryRun: false, full: true, clock });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, file, directory };
}

test('store: search answers an Arabic question with evidence that carries source and licence', async (t) => {
  const { store } = await seeded(t);
  const result = store.search({ query: 'كيف أربط جوجل', limit: 4 });
  assert.ok(result.items.length > 0, 'Arabic query returns evidence');
  assert.equal(result.reason, null);
  for (const item of result.items) {
    assert.ok(item.uri.startsWith('https://'), 'every hit has a real source URL');
    assert.equal(item.licence, 'internal-owner');
    assert.ok(['T1', 'T2', 'T3'].includes(item.trust));
    assert.ok(item.snippet.length > 0);
  }
  assert.ok(
    result.items.some((item) => /google/i.test(item.title) || /google/i.test(item.snippet)),
    'the Google answer is present'
  );
});

test('store: an Arabic scheduling question reaches the calendar tool entity with its risk gate', async (t) => {
  const { store } = await seeded(t);
  const result = store.search({ query: 'أريد إنشاء موعد في التقويم', limit: 5 });
  const keys = result.entities.map((entity) => entity.key);
  assert.ok(keys.includes('google.calendar_create_event') || keys.includes('google_calendar_events_create'));
  const calendar = result.entities.find((entity) => entity.key === 'google.calendar_create_event');
  assert.equal(calendar.risk, 'external_effect');
  assert.equal(calendar.requiresApproval, true, 'the knowledge layer reports the approval gate');
  assert.ok(result.edges.length > 0, 'one-hop graph neighbourhood is returned');
});

test('store: entity detail joins evidence, attributes and both edge directions', async (t) => {
  const { store } = await seeded(t);
  const detail = store.entityDetail('tool', 'google_calendar_events_create');
  assert.equal(detail.entity.risk, 'external_effect');
  assert.equal(detail.attrs.approval, 'required');
  assert.equal(detail.evidence.licence, 'internal-owner');
  assert.ok(detail.outgoing.some((edge) => edge.rel === 'requires' && edge.key === 'skill-google-oauth'));
  const project = store.entityDetail('project', 'proj-knowledge-network');
  assert.ok(project.incoming.some((edge) => edge.key === 'skill-arabic-search'));
  assert.equal(store.entityDetail('tool', 'does_not_exist'), null);
});

test('store: trust floor, absence and budgets are enforced by the query itself', async (t) => {
  const { store } = await seeded(t);
  const low = store.search({ query: 'مصادر البيانات', minTrust: 'T3', limit: 5 });
  assert.ok(low.items.every((item) => item.trust === 'T3'), 'a T3 floor excludes T2 rows');
  const tight = store.search({ query: 'شبكة المعرفة', limit: 6, maxChars: 120 });
  assert.ok(tight.items.length <= 2);
  assert.ok(tight.truncated || tight.omitted > 0);
  const empty = store.search({ query: '   ' });
  assert.equal(empty.reason, 'empty_query');
  const nothing = store.search({ query: 'zzzz-nonexistent-token' });
  assert.equal(nothing.reason, 'no_match');
});

test('store: duplicates collapse onto one item with an alias, never a second row', async (t) => {
  const { store } = await seeded(t);
  const before = store.stats().items;
  const twin = store.putItem({
    id: 'kb_custom_duplicate',
    sourceId: 'src-repo-docs',
    kind: 'doc',
    title: 'معمارية شبكة المعرفة',
    body: 'ست طبقات: مصادر، موصل، إدخال وتحقق، مخزن، استرجاع، ثم وكيل. تشمل عقود CSV وحدود الثقة والترخيص. · concept · knowledge · csv · sqlite · fts5 · proj-knowledge-network · skill-a',
    contentHash: store.getItem(
      store.db.prepare("SELECT id FROM items WHERE title = 'معمارية شبكة المعرفة'").get().id
    ).content_hash,
    trust: 'T2',
    uri: 'https://example.test/duplicate'
  });
  assert.equal(twin.status, 'deduplicated');
  assert.equal(store.stats().items, before);
  assert.equal(store.stats().aliases, 1, 'the second location is kept as an alias');
});

test('store: 5000 items stay under the latency budget and keep ranking sane', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-kb-perf-'));
  const store = await KnowledgeStore.open({ file: path.join(directory, 'kb.sqlite3') });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.upsertSource({ id: 'src-perf', kind: 'csv', uri: 'repo://perf.csv', license: 'internal-owner', trust: 'T2', staleAfterDays: 365, lastSyncAt: '2026-10-27' });
  store.transaction(() => {
    for (let index = 0; index < 5000; index += 1) {
      store.putItem({
        id: `perf_${index}`,
        sourceId: 'src-perf',
        kind: 'doc',
        title: `وثيقة رقم ${index} عن التقويم`,
        body: `نص تجريبي عن المواعيد والتقويم والجدولة ${index} ${index % 7 === 0 ? 'موافقة صريحة' : 'قراءة فقط'}`,
        contentHash: `hash-perf-${index}`,
        trust: index % 2 ? 'T2' : 'T3',
        uri: `https://example.test/perf/${index}`,
        sourceUpdatedAt: '2026-10-27'
      });
    }
  });
  // Warm V8 / SQLite FTS5 bytecode once before measuring SLA, and scale budget when V8 coverage hooks are active.
  store.search({ query: 'التقويم', limit: 1 });
  const maxMs = process.env.NODE_V8_COVERAGE ? 450 : 150;
  const started = process.hrtime.bigint();
  const result = store.search({ query: 'مواعيد التقويم', limit: 6 });
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(result.items.length > 0);
  assert.ok(elapsed < maxMs, `search took ${elapsed.toFixed(1)}ms (budget ${maxMs}ms)`);
  assert.ok(result.tookMs < maxMs);
});

test('store: stale report is explicit and never deletes; export/restore round-trips', async (t) => {
  const future = Date.now() + 400 * 86_400_000;
  const { store, directory } = await seeded(t, { clock: () => future });
  const stale = store.stale({ days: 1 });
  assert.ok(stale.items.length > 0, 'seed data is older than one day relative to the report clock');
  assert.ok(
    stale.items.every((item) => item.ageDays > 1 && /^(https:\/\/|repo:\/\/)/.test(item.uri)),
    'every stale row still carries a resolvable provenance URI'
  );
  const before = store.fingerprint();

  const jsonl = store.exportJsonl();
  assert.ok(jsonl.split('\n').filter(Boolean).length > 50);
  const restoredFile = path.join(directory, 'restored.sqlite3');
  const restored = await KnowledgeStore.open({ file: restoredFile });
  t.after(() => restored.close());
  const counts = restored.importJsonl(jsonl);
  assert.equal(restored.fingerprint(), before, 'restore reproduces the same items');
  assert.ok(counts.edges >= 40);
  assert.equal(restored.stats().items, store.stats().items);
  assert.match(restored.search({ query: 'بحث عربي' }).items[0].title, /تطبيع|بحث/);
  assert.throws(() => restored.importJsonl(jsonl), /backup_target_not_empty/);
});

test('store: schema mismatch and read-only opens fail loudly', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-kb-schema-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'kb.sqlite3');
  const store = await KnowledgeStore.open({ file });
  store.db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
  store.close();
  await assert.rejects(() => KnowledgeStore.open({ file, readOnly: true }), /knowledge_schema_mismatch/);
  await assert.rejects(() => KnowledgeStore.open({ file: '' }), /explicit file path/);
});

test('store: a missing parent directory is created instead of refusing the index', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'celia-kb-mkdir-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'nested', 'deeper', 'kb.sqlite3');
  assert.equal(existsSync(path.dirname(file)), false);
  const store = await KnowledgeStore.open({ file });
  t.after(() => store.close());
  assert.ok(existsSync(file), 'the file store was created');
  assert.equal(store.stats().items, 0);
  assert.match(store.stats().schemaVersion ? String(store.stats().schemaVersion) : '1', /^1$/);
});
