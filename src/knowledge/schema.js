/**
 * Knowledge store DDL (SQLite). Derived data: rebuildable from the registries, so
 * it lives beside the app rather than inside the transactional MySQL schema.
 *
 * Invariants encoded here, not only in code:
 * - every item has a source and a licence;
 * - content hashes are unique (deduplication is a constraint, not a convention);
 * - every entity and every edge points to the item that evidences it;
 * - absence is recorded (`absent_since`), rows are never deleted automatically.
 */

export const KNOWLEDGE_SCHEMA_VERSION = 1;

export const KNOWLEDGE_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    uri TEXT NOT NULL,
    license TEXT NOT NULL,
    trust TEXT NOT NULL,
    stale_after_days INTEGER NOT NULL DEFAULT 180,
    last_sync_at TEXT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ingest_runs (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL,
    mode TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT NULL,
    added INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL DEFAULT 0,
    deduplicated INTEGER NOT NULL DEFAULT 0,
    unchanged INTEGER NOT NULL DEFAULT 0,
    rejected INTEGER NOT NULL DEFAULT 0,
    marked_absent INTEGER NOT NULL DEFAULT 0,
    error_code TEXT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ingest_rejections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES ingest_runs(id) ON DELETE CASCADE,
    line INTEGER NOT NULL,
    code TEXT NOT NULL,
    field TEXT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL,
    lang TEXT NOT NULL DEFAULT 'mixed',
    trust TEXT NOT NULL,
    uri TEXT NOT NULL,
    source_updated_at TEXT NULL,
    indexed_at TEXT NOT NULL,
    absent_since TEXT NULL,
    UNIQUE (content_hash)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_items_source ON items (source_id, kind)',
  'CREATE INDEX IF NOT EXISTS idx_items_absent ON items (absent_since)',
  `CREATE TABLE IF NOT EXISTS item_aliases (
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
    uri TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    PRIMARY KEY (item_id, uri)
  )`,
  `CREATE TABLE IF NOT EXISTS item_terms (
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    term TEXT NOT NULL,
    freq INTEGER NOT NULL,
    PRIMARY KEY (item_id, term)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_item_terms_term ON item_terms (term)',
  `CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    key TEXT NOT NULL,
    title TEXT NOT NULL,
    key_norm TEXT NOT NULL,
    title_norm TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    risk TEXT NULL,
    requires_approval INTEGER NOT NULL DEFAULT 0,
    wired INTEGER NOT NULL DEFAULT 0,
    evidence_item_id TEXT NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    trust TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (type, key)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_entities_type ON entities (type, status)',
  'CREATE INDEX IF NOT EXISTS idx_entities_key_norm ON entities (key_norm)',
  `CREATE TABLE IF NOT EXISTS entity_attrs (
    entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (entity_id, key)
  )`,
  `CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    src_type TEXT NOT NULL,
    src_id TEXT NOT NULL,
    dst_type TEXT NOT NULL,
    dst_id TEXT NOT NULL,
    rel TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 1.0,
    evidence_item_id TEXT NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    UNIQUE (src_type, src_id, rel, dst_type, dst_id, evidence_item_id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_edges_src ON edges (src_type, src_id)',
  'CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges (dst_type, dst_id)',
  `CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
    item_id UNINDEXED,
    title_norm,
    body_norm,
    tokenize = 'unicode61 remove_diacritics 2'
  )`
]);

export const KNOWLEDGE_TABLES = Object.freeze([
  'meta',
  'sources',
  'ingest_runs',
  'ingest_rejections',
  'items',
  'item_aliases',
  'item_terms',
  'entities',
  'entity_attrs',
  'edges',
  'items_fts'
]);
