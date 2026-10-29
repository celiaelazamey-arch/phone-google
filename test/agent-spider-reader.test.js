/**
 * تفعيل الخيوط العنكبوتية — اختبارات قارئ فهرس Celia Google Spider.
 *
 * الفهرس الثابت يُبنى هنا بنفس مخطط `celia_spider/store.py` حرفيًا (documents/
 * terms/document_terms/meta)، والتوكيدات تتحقق من أن القارئ مرآة أمينة لدلالات
 * Python: التطبيع العربي، ترتيب البحث، الدرجة، المقتطف. كلها محلية بلا شبكة.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSpiderReader, defaultSpiderDbPath, makeSnippet, normalizeToken, tokenize } from '../src/agent/spider-reader.js';
import { createToolRegistry, defaultToolDefinitions, RISK } from '../src/agent/tools.js';
import { createAgentHost } from '../src/agent/index.js';

const SCHEMA = `
CREATE TABLE documents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, mime_type TEXT NOT NULL, source TEXT NOT NULL,
  web_view_link TEXT, size INTEGER, modified_time TEXT, content_hash TEXT, content TEXT, indexed_at TEXT NOT NULL
);
CREATE TABLE terms (id INTEGER PRIMARY KEY AUTOINCREMENT, term TEXT NOT NULL UNIQUE);
CREATE TABLE document_terms (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  freq INTEGER NOT NULL, PRIMARY KEY (document_id, term_id)
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`;

function buildFixtureIndex(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-spider-fixture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'knowledge.sqlite3');
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  const insertDoc = db.prepare(
    "INSERT INTO documents (id, name, mime_type, source, web_view_link, content, indexed_at) VALUES (?, ?, 'text/plain', 'drive', ?, ?, '2026-10-29T00:00:00+00:00')"
  );
  insertDoc.run('doc-plan', 'خطة الإطلاق', 'https://drive.example/plan', 'خطة إطلاق المتجر: المنتجات الجلدية تُشحن أولًا ثم الحملة التسويقية.');
  insertDoc.run('doc-costs', 'تقرير التكاليف', 'https://drive.example/costs', 'تقرير التكاليف الشهرية للمتجر والحملة.');
  insertDoc.run('doc-en', 'inventory notes', null, 'leather bags inventory and shipping notes for the store.');
  const term = db.prepare('INSERT INTO terms (term) VALUES (?)');
  const link = db.prepare('INSERT INTO document_terms (document_id, term_id, freq) VALUES (?, ?, ?)');
  const termId = new Map();
  const addTerm = (value) => {
    if (!termId.has(value)) termId.set(value, Number(term.run(value).lastInsertRowid));
    return termId.get(value);
  };
  // المصطلحات مطبَّعة كما يفهرسها العنكبوت (ة→ه، أ→ا).
  link.run('doc-plan', addTerm('خطه'), 3);
  link.run('doc-plan', addTerm('اطلاق'), 2);
  link.run('doc-plan', addTerm('المتجر'), 1);
  link.run('doc-costs', addTerm('تقرير'), 4);
  link.run('doc-costs', addTerm('المتجر'), 2);
  link.run('doc-en', addTerm('leather'), 2);
  link.run('doc-en', addTerm('store'), 1);
  db.prepare("INSERT INTO meta (key, value) VALUES ('last_indexed_at', '2026-10-29T00:00:00+00:00')").run();
  db.close();
  return file;
}

test('SPD-01: normalization mirrors text_utils.py — hamza/teh-marbuta/alef-maqsura unification, diacritics and Hindi digits', () => {
  assert.equal(normalizeToken('أُسْبُوعِيَّة'), 'اسبوعيه');
  assert.equal(normalizeToken('إطلاق'), 'اطلاق');
  assert.equal(normalizeToken('مُسْتَشْفَى'), 'مستشفي');
  assert.equal(normalizeToken('٢٠٢٦'), '2026');
  assert.equal(normalizeToken('REPORT'), 'report');
  assert.deepEqual(tokenize('خطة الإطلاق! v2'), ['خطه', 'الاطلاق', 'v2']);
  assert.deepEqual(tokenize('a ب 7'), ['7'], 'single letters drop, lone digits stay — same rule as tokenize()');
});

test('SPD-02: search ranks by matched terms then frequency and scores matched*10+min(freq,90) — the Python contract', (t) => {
  const reader = createSpiderReader({ dbPath: buildFixtureIndex(t) });
  t.after(() => reader.close());
  const results = reader.search('خطة إطلاق المتجر');
  assert.equal(results.length, 2);
  assert.equal(results[0].id, 'doc-plan', 'three matched terms beat one');
  assert.equal(results[0].matchedTerms, 3);
  assert.equal(results[0].score, 3 * 10 + 6);
  assert.equal(results[1].id, 'doc-costs');
  assert.equal(results[1].score, 1 * 10 + 2);
  assert.ok(results[0].snippet.includes('خطة إطلاق المتجر'), 'the snippet quotes the original text, not the normalized form');
  const english = reader.search('Leather Store');
  assert.equal(english[0].id, 'doc-en');
  assert.equal(reader.search('؟!').length, 0, 'an empty normalized query returns nothing and hits no table');
});

test('SPD-03: stats mirror graph_stats and the missing index refuses loudly — never a silent empty network', (t) => {
  const reader = createSpiderReader({ dbPath: buildFixtureIndex(t) });
  t.after(() => reader.close());
  const stats = reader.stats();
  assert.equal(stats.documents, 3);
  assert.equal(stats.terms, 6);
  assert.equal(stats.links, 7);
  assert.equal(stats.lastIndexedAt, '2026-10-29T00:00:00+00:00');
  assert.ok(stats.indexBytes > 0);
  assert.throws(
    () => createSpiderReader({ dbPath: path.join(os.tmpdir(), 'no-such-dir', 'knowledge.sqlite3') }),
    (error) => error.code === 'spider_index_unavailable'
  );
  assert.ok(defaultSpiderDbPath({ CELIA_SPIDER_DATA_DIR: '/x/y' }).endsWith(path.join('x', 'y', 'knowledge.sqlite3')));
});

test('SPD-04: spider tools exist only when the reader is wired — read-only, deterministic, and absent by default', (t) => {
  const bare = createToolRegistry(defaultToolDefinitions({ statusProvider: () => ({}) }));
  assert.equal(bare.list().some((tool) => tool.name.startsWith('spider.')), false);
  const reader = createSpiderReader({ dbPath: buildFixtureIndex(t) });
  t.after(() => reader.close());
  const registry = createToolRegistry(defaultToolDefinitions({ statusProvider: () => ({}), spider: reader }));
  for (const name of ['spider.search_knowledge', 'spider.graph_stats']) {
    const tool = registry.get(name);
    assert.equal(tool.risk, RISK.read);
    assert.equal(tool.deterministic, true);
    assert.equal(registry.executable(name), true);
  }
  assert.equal(registry.validateInput('spider.search_knowledge', { query: 'متجر' }).ok, true);
});

test('SPD-05: CELIA_AGENT_SPIDER gate — off by default, invalid value fails boot, read without an index fails boot', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-spider-gate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const baseEnv = { CELIA_AGENT_RUNTIME: 'sqlite', CELIA_AGENT_SQLITE_PATH: path.join(directory, 'agent.sqlite3') };
  const config = { userId: 'owner', gemini: {} };
  const host = (env) => createAgentHost({ config, env, statusProvider: () => ({}), logger: { error() {} } });

  await assert.rejects(host({ ...baseEnv, CELIA_AGENT_SPIDER: 'sync' }).get(), (e) => e.code === 'agent_spider_misconfigured');
  await assert.rejects(
    host({ ...baseEnv, CELIA_AGENT_SPIDER: 'read', CELIA_SPIDER_DB_PATH: path.join(directory, 'absent.sqlite3') }).get(),
    (e) => e.code === 'spider_index_unavailable'
  );

  const indexFile = buildFixtureIndex(t);
  const enabled = host({ ...baseEnv, CELIA_AGENT_SPIDER: 'read', CELIA_SPIDER_DB_PATH: indexFile });
  const runtime = await enabled.get();
  t.after(() => runtime.shutdown().catch(() => {}));
  const names = runtime.status().tools.map((tool) => tool.name);
  assert.ok(names.includes('spider.search_knowledge') && names.includes('spider.graph_stats'));

  const offHost = host({ ...baseEnv, CELIA_AGENT_SQLITE_PATH: path.join(directory, 'agent-off.sqlite3') });
  const offRuntime = await offHost.get();
  t.after(() => offRuntime.shutdown().catch(() => {}));
  assert.equal(offRuntime.status().tools.some((tool) => tool.name.startsWith('spider.')), false, 'default stays off');
});
