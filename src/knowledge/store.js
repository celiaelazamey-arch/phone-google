import crypto from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { KNOWLEDGE_DDL, KNOWLEDGE_SCHEMA_VERSION, KNOWLEDGE_TABLES } from './schema.js';
import { expandTerms, normalize, queryTerms, snippet } from './normalize.js';

/**
 * Knowledge store over SQLite (`node:sqlite`, FTS5).
 *
 * Derived, rebuildable data: the registries and Drive are the source of truth.
 * Writes are explicit and transactional; reads never mutate. Nothing here talks to
 * the network, and no method deletes knowledge automatically.
 */

const TRUST_WEIGHT = Object.freeze({ T3: 1, T2: 0.7, T1: 0.4 });
const TRUST_RANK = Object.freeze({ T1: 1, T2: 2, T3: 3 });
const MAX_FTS_CANDIDATES = 60;

const toInt = (value) => (value ? 1 : 0);
const iso = (clock) => new Date(clock()).toISOString();

const termFrequencies = (text) => {
  const frequencies = new Map();
  for (const token of normalize(text).match(/[\p{L}\p{N}]+/gu) || []) {
    if (token.length < 2) continue;
    frequencies.set(token, (frequencies.get(token) || 0) + 1);
  }
  return frequencies;
};

function ftsQuery(terms, operator) {
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(` ${operator} `);
}

export class KnowledgeStore {
  constructor({ db, file, clock = Date.now, readOnly = false }) {
    this.db = db;
    this.file = file;
    this.clock = clock;
    this.readOnly = readOnly;
  }

  static async open({ file, clock = Date.now, readOnly = false, create = true }) {
    if (!file) throw new Error('knowledge store requires an explicit file path');
    const { DatabaseSync } = await import('node:sqlite');
    if (!readOnly && create && file !== ':memory:') {
      // A missing parent directory is a deployment detail, not a reason to refuse
      // the index: create it (the registry data, never the path, is the authority).
      await mkdir(path.dirname(path.resolve(file)), { recursive: true });
    }
    let db;
    try {
      db = new DatabaseSync(file);
    } catch (error) {
      throw new Error(`knowledge_store_open_failed: ${error?.message || 'unknown'}`);
    }
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 4000');
    if (!readOnly) db.exec('PRAGMA journal_mode = WAL');
    const store = new KnowledgeStore({ db, file, clock, readOnly });
    store.assertFts5();
    if (create && !readOnly) store.migrate();
    else store.assertSchema();
    return store;
  }

  assertFts5() {
    try {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS __fts_probe USING fts5(x)");
      this.db.exec('DROP TABLE IF EXISTS __fts_probe');
    } catch {
      throw new Error('knowledge_store_requires_fts5: this SQLite build lacks FTS5');
    }
  }

  migrate() {
    for (const statement of KNOWLEDGE_DDL) this.db.exec(statement);
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('schema_version', String(KNOWLEDGE_SCHEMA_VERSION));
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('created_at', this.getMeta('created_at') || iso(this.clock));
    return KNOWLEDGE_SCHEMA_VERSION;
  }

  assertSchema() {
    const rows = this.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all();
    const existing = new Set(rows.map((row) => row.name));
    const missing = KNOWLEDGE_TABLES.filter((name) => !existing.has(name));
    if (missing.length) throw new Error(`knowledge_schema_missing: ${missing.join(', ')}`);
    const version = Number(this.getMeta('schema_version') || 0);
    if (version !== KNOWLEDGE_SCHEMA_VERSION) {
      throw new Error(`knowledge_schema_mismatch: found ${version}, expected ${KNOWLEDGE_SCHEMA_VERSION}`);
    }
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row?.value ?? null;
  }

  transaction(fn, { rollback = false } = {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec(rollback ? 'ROLLBACK' : 'COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* rollback best effort */
      }
      throw error;
    }
  }

  upsertSource(source) {
    const at = iso(this.clock);
    this.db
      .prepare(
        `INSERT INTO sources (id, kind, uri, license, trust, stale_after_days, last_sync_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, uri = excluded.uri, license = excluded.license,
           trust = excluded.trust, stale_after_days = excluded.stale_after_days,
           last_sync_at = excluded.last_sync_at, updated_at = excluded.updated_at`
      )
      .run(
        source.id,
        source.kind,
        source.uri,
        source.license,
        source.trust,
        source.staleAfterDays ?? 180,
        source.lastSyncAt ?? null,
        at,
        at
      );
    return this.getSource(source.id);
  }

  getSource(id) {
    return this.db.prepare('SELECT * FROM sources WHERE id = ?').get(id) || null;
  }

  listSources() {
    return this.db.prepare('SELECT * FROM sources ORDER BY id').all();
  }

  startRun({ sourceId, kind, mode }) {
    const id = crypto.randomUUID();
    this.db
      .prepare('INSERT INTO ingest_runs (id, source_id, kind, mode, started_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, sourceId, kind, mode, iso(this.clock));
    return id;
  }

  reject(runId, { line, code, field = null }) {
    this.db.prepare('INSERT INTO ingest_rejections (run_id, line, code, field) VALUES (?, ?, ?, ?)').run(runId, line, code, field);
  }

  finishRun(runId, counts, { errorCode = null } = {}) {
    this.db
      .prepare(
        `UPDATE ingest_runs SET finished_at = ?, added = ?, updated = ?, deduplicated = ?, unchanged = ?,
          rejected = ?, marked_absent = ?, error_code = ? WHERE id = ?`
      )
      .run(
        iso(this.clock),
        counts.added ?? 0,
        counts.updated ?? 0,
        counts.deduplicated ?? 0,
        counts.unchanged ?? 0,
        counts.rejected ?? 0,
        counts.markedAbsent ?? 0,
        errorCode,
        runId
      );
    return this.db.prepare('SELECT * FROM ingest_runs WHERE id = ?').get(runId);
  }

  /** Inserts or updates one item; identical content is a no-op, a hash clash is an alias. */
  putItem(item) {
    const hash = item.contentHash;
    const sameHash = this.db.prepare('SELECT id FROM items WHERE content_hash = ? AND id <> ?').get(hash, item.id);
    if (sameHash) {
      this.addAlias({ itemId: sameHash.id, sourceId: item.sourceId, uri: item.uri });
      return { status: 'deduplicated', itemId: sameHash.id };
    }
    const existing = this.db.prepare('SELECT * FROM items WHERE id = ?').get(item.id);
    const at = iso(this.clock);
    if (existing) {
      if (existing.content_hash === hash) {
        this.db
          .prepare('UPDATE items SET title = ?, uri = ?, source_updated_at = ?, absent_since = NULL WHERE id = ?')
          .run(item.title, item.uri, item.sourceUpdatedAt ?? null, item.id);
        return { status: 'unchanged', itemId: item.id };
      }
      this.db
        .prepare(
          `UPDATE items SET source_id = ?, kind = ?, title = ?, body = ?, content_hash = ?, lang = ?, trust = ?,
            uri = ?, source_updated_at = ?, indexed_at = ?, absent_since = NULL WHERE id = ?`
        )
        .run(
          item.sourceId,
          item.kind,
          item.title,
          item.body,
          hash,
          item.lang || 'mixed',
          item.trust,
          item.uri,
          item.sourceUpdatedAt ?? null,
          at,
          item.id
        );
      this.indexItem(item);
      return { status: 'updated', itemId: item.id };
    }
    this.db
      .prepare(
        `INSERT INTO items (id, source_id, kind, title, body, content_hash, lang, trust, uri,
          source_updated_at, indexed_at, absent_since) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        item.id,
        item.sourceId,
        item.kind,
        item.title,
        item.body,
        hash,
        item.lang || 'mixed',
        item.trust,
        item.uri,
        item.sourceUpdatedAt ?? null,
        at
      );
    this.indexItem(item);
    return { status: 'added', itemId: item.id };
  }

  indexItem(item) {
    this.db.prepare('DELETE FROM items_fts WHERE item_id = ?').run(item.id);
    this.db.prepare('DELETE FROM item_terms WHERE item_id = ?').run(item.id);
    this.db
      .prepare('INSERT INTO items_fts (item_id, title_norm, body_norm) VALUES (?, ?, ?)')
      .run(item.id, normalize(item.title), normalize(item.body));
    const terms = termFrequencies(`${item.title} ${item.body}`);
    const insert = this.db.prepare('INSERT INTO item_terms (item_id, term, freq) VALUES (?, ?, ?)');
    for (const [term, freq] of terms) insert.run(item.id, term, freq);
  }

  addAlias({ itemId, sourceId, uri }) {
    this.db
      .prepare('INSERT INTO item_aliases (item_id, source_id, uri, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING')
      .run(itemId, sourceId, uri, iso(this.clock));
  }

  putEntity(entity) {
    const at = iso(this.clock);
    this.db
      .prepare(
        `INSERT INTO entities (id, type, key, title, key_norm, title_norm, status, risk, requires_approval,
          wired, evidence_item_id, trust, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(type, key) DO UPDATE SET title = excluded.title, key_norm = excluded.key_norm,
           title_norm = excluded.title_norm, status = excluded.status, risk = excluded.risk,
           requires_approval = excluded.requires_approval, wired = excluded.wired,
           evidence_item_id = excluded.evidence_item_id, trust = excluded.trust, updated_at = excluded.updated_at`
      )
      .run(
        entity.id,
        entity.type,
        entity.key,
        entity.title,
        normalize(entity.key),
        normalize(entity.title),
        entity.status || 'active',
        entity.risk ?? null,
        toInt(entity.requiresApproval),
        toInt(entity.wired),
        entity.evidenceItemId,
        entity.trust,
        at,
        at
      );
    if (entity.attrs) {
      const remove = this.db.prepare('DELETE FROM entity_attrs WHERE entity_id = ? AND key = ?');
      const upsert = this.db.prepare(
        'INSERT INTO entity_attrs (entity_id, key, value) VALUES (?, ?, ?) ON CONFLICT(entity_id, key) DO UPDATE SET value = excluded.value'
      );
      for (const [key, value] of Object.entries(entity.attrs)) {
        remove.run(entity.id, key);
        if (value !== undefined && value !== null && value !== '') upsert.run(entity.id, key, String(value));
      }
    }
    return this.db.prepare('SELECT * FROM entities WHERE type = ? AND key = ?').get(entity.type, entity.key);
  }

  putEdge(edge) {
    const id = crypto.createHash('sha256').update(JSON.stringify(edge)).digest('hex').slice(0, 32);
    this.db
      .prepare(
        `INSERT INTO edges (id, src_type, src_id, dst_type, dst_id, rel, weight, evidence_item_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`
      )
      .run(
        id,
        edge.srcType,
        edge.srcId,
        edge.dstType,
        edge.dstId,
        edge.rel,
        edge.weight ?? 1,
        edge.evidenceItemId,
        iso(this.clock)
      );
    return id;
  }

  /** Explicit full re-import only: marks absence, never deletes. */
  markAbsent({ sourceId, kind, seenIds }) {
    const seen = new Set(seenIds);
    const rows = this.db.prepare('SELECT id FROM items WHERE source_id = ? AND kind = ? AND absent_since IS NULL').all(sourceId, kind);
    const mark = this.db.prepare('UPDATE items SET absent_since = ? WHERE id = ?');
    const clear = this.db.prepare('UPDATE items SET absent_since = NULL WHERE id = ?');
    let marked = 0;
    for (const row of rows) {
      if (seen.has(row.id)) clear.run(row.id);
      else {
        mark.run(iso(this.clock), row.id);
        marked += 1;
      }
    }
    return marked;
  }

  getItem(id) {
    return this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) || null;
  }

  getEntity(type, key) {
    return this.db.prepare('SELECT * FROM entities WHERE type = ? AND key = ?').get(type, key) || null;
  }

  /** Registry ids are globally unique by convention (`tool-`, `skill-`, `proj-`). */
  getEntityByKey(key) {
    return this.db.prepare('SELECT * FROM entities WHERE key = ? LIMIT 1').get(key) || null;
  }

  entityDetail(type, key) {
    const entity = this.getEntity(type, key);
    if (!entity) return null;
    const attrs = this.db.prepare('SELECT key, value FROM entity_attrs WHERE entity_id = ? ORDER BY key').all(entity.id);
    const evidence = this.getItem(entity.evidence_item_id);
    const source = evidence ? this.getSource(evidence.source_id) : null;
    const outgoing = this.db
      .prepare(
        `SELECT e.*, d.title AS dst_title FROM edges e
         LEFT JOIN entities d ON d.type = e.dst_type AND d.key = e.dst_id
         WHERE e.src_type = ? AND e.src_id = ? ORDER BY e.rel, e.dst_id LIMIT 50`
      )
      .all(entity.type, entity.key);
    const incoming = this.db
      .prepare(
        `SELECT e.*, s.title AS src_title FROM edges e
         LEFT JOIN entities s ON s.type = e.src_type AND s.key = e.src_id
         WHERE e.dst_type = ? AND e.dst_id = ? ORDER BY e.rel, e.src_id LIMIT 50`
      )
      .all(entity.type, entity.key);
    return {
      entity: {
        id: entity.id,
        type: entity.type,
        key: entity.key,
        title: entity.title,
        status: entity.status,
        risk: entity.risk,
        requiresApproval: Boolean(entity.requires_approval),
        wired: Boolean(entity.wired),
        trust: entity.trust,
        updatedAt: entity.updated_at
      },
      attrs: Object.fromEntries(attrs.map((attr) => [attr.key, attr.value])),
      evidence: evidence
        ? { id: evidence.id, title: evidence.title, uri: evidence.uri, licence: source?.license || null, trust: evidence.trust }
        : null,
      outgoing: outgoing.map((edge) => ({
        rel: edge.rel,
        type: edge.dst_type,
        key: edge.dst_id,
        title: edge.dst_title || edge.dst_id,
        weight: edge.weight
      })),
      incoming: incoming.map((edge) => ({
        rel: edge.rel,
        type: edge.src_type,
        key: edge.src_id,
        title: edge.src_title || edge.src_id,
        weight: edge.weight
      }))
    };
  }

  /**
   * Hybrid search: FTS5 lexical candidates + trust + freshness + one-hop graph
   * proximity, assembled into a bounded evidence pack that always carries source,
   * licence and trust with every result.
   */
  search({ query, limit = 6, maxChars = 1200, minTrust = 'T1', expandGraph = true } = {}) {
    const startedAt = process.hrtime.bigint();
    const terms = queryTerms(query || '');
    const result = {
      query: String(query || ''),
      terms,
      items: [],
      entities: [],
      edges: [],
      candidates: 0,
      omitted: 0,
      truncated: false,
      tookMs: 0,
      reason: null
    };
    if (!terms.length) {
      result.reason = 'empty_query';
      result.tookMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      return result;
    }
    const candidates = this.ftsCandidates(terms);
    result.candidates = candidates.total;
    if (!candidates.rows.length) {
      result.reason = 'no_match';
      result.tookMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      return result;
    }

    const candidateIds = candidates.rows.map((row) => row.id);
    const matchedEntities = this.matchEntities(terms, candidateIds);
    const entityEvidence = new Set(matchedEntities.map((entity) => entity.evidence_item_id));
    const neighbors = this.neighborEntities(matchedEntities);
    const neighborEvidence = new Map(neighbors.map((entity) => [entity.evidence_item_id, entity]));

    const maxLexical = Math.max(...candidates.rows.map((row) => row.lexical), 0.000001);
    const scored = [];
    for (const row of candidates.rows) {
      if (TRUST_RANK[row.trust] < TRUST_RANK[minTrust]) continue;
      const lexical = row.lexical / maxLexical;
      const trust = TRUST_WEIGHT[row.trust] ?? 0.4;
      const fresh = freshness(row.source_updated_at || row.indexed_at, row.stale_after_days, this.clock());
      const proximity = entityEvidence.has(row.id) ? 1 : neighborEvidence.has(row.id) ? 0.5 : 0;
      const score = 0.55 * lexical + 0.2 * trust + 0.15 * fresh + 0.1 * (expandGraph ? proximity : 0);
      scored.push({ row, score, breakdown: { lexical, trust, fresh, proximity } });
    }
    scored.sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));

    const budget = Math.max(1, limit);
    let chars = 0;
    for (const entry of scored) {
      if (result.items.length >= budget) break;
      const text = snippet(entry.row.body || entry.row.title, terms, { width: Math.min(220, Math.max(80, maxChars - chars)) });
      if (result.items.length > 0 && chars + text.length > maxChars) {
        result.truncated = true;
        break;
      }
      chars += text.length;
      result.items.push({
        id: entry.row.id,
        title: entry.row.title,
        uri: entry.row.uri,
        kind: entry.row.kind,
        trust: entry.row.trust,
        licence: entry.row.license,
        sourceId: entry.row.source_id,
        sourceKind: entry.row.source_kind,
        snippet: text,
        score: Number(entry.score.toFixed(4)),
        breakdown: Object.fromEntries(Object.entries(entry.breakdown).map(([key, value]) => [key, Number(value.toFixed(3))]))
      });
    }
    result.omitted = Math.max(0, scored.length - result.items.length);
    result.entities = matchedEntities.slice(0, 8).map((entity) => ({
      type: entity.type,
      key: entity.key,
      title: entity.title,
      risk: entity.risk,
      requiresApproval: Boolean(entity.requires_approval),
      wired: Boolean(entity.wired),
      trust: entity.trust
    }));
    if (expandGraph) {
      const allowed = new Set(matchedEntities.map((entity) => `${entity.type}:${entity.key}`));
      result.edges = this.db
        .prepare(
          `SELECT src_type, src_id, rel, dst_type, dst_id, weight FROM edges
           WHERE src_type = 'tool' OR src_type = 'skill' OR src_type = 'project'
           ORDER BY rel, src_id LIMIT 400`
        )
        .all()
        .filter((edge) => allowed.has(`${edge.src_type}:${edge.src_id}`) || allowed.has(`${edge.dst_type}:${edge.dst_id}`))
        .slice(0, 12)
        .map((edge) => ({
          from: `${edge.src_type}:${edge.src_id}`,
          rel: edge.rel,
          to: `${edge.dst_type}:${edge.dst_id}`
        }));
    }
    result.tookMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    return result;
  }

  ftsCandidates(terms) {
    const select = `SELECT f.item_id AS id, i.title, i.body, i.kind, i.uri, i.trust, i.source_id,
        i.source_updated_at, i.indexed_at, s.license, s.kind AS source_kind,
        COALESCE(s.stale_after_days, 180) AS stale_after_days, f.rank AS rank
      FROM (SELECT item_id, bm25(items_fts, 0.0, 3.0, 1.0) AS rank FROM items_fts
            WHERE items_fts MATCH ? ORDER BY rank LIMIT ${MAX_FTS_CANDIDATES}) f
      JOIN items i ON i.id = f.item_id
      JOIN sources s ON s.id = i.source_id
      WHERE i.absent_since IS NULL
      ORDER BY f.rank`;
    const andRows = this.db.prepare(select).all(ftsQuery(terms, 'AND'));
    if (andRows.length >= 3) return { rows: andRows.map((row) => ({ ...row, lexical: -row.rank })), total: andRows.length };
    const expanded = expandTerms(terms);
    const orRows = this.db.prepare(select).all(ftsQuery(expanded, 'OR'));
    return {
      rows: orRows.map((row) => ({ ...row, lexical: -row.rank })),
      total: orRows.length
    };
  }

  /**
   * Entities reached from the query: direct name matches plus the entities whose
   * evidence item matched lexically, so an Arabic query that finds "إنشاء موعد"
   * also surfaces the tool entity with its risk and approval flag.
   */
  matchEntities(terms, candidateIds = []) {
    const rows = new Map();
    const statement = this.db.prepare(
      `SELECT * FROM entities WHERE status = 'active' AND (key_norm LIKE ? OR title_norm LIKE ?) LIMIT 25`
    );
    for (const term of terms) {
      const like = `%${term}%`;
      for (const row of statement.all(like, like)) rows.set(`${row.type}:${row.key}`, row);
    }
    if (candidateIds.length) {
      const placeholders = candidateIds.map(() => '?').join(',');
      const linked = this.db
        .prepare(
          `SELECT * FROM entities WHERE status = 'active' AND evidence_item_id IN (${placeholders}) ORDER BY type, key LIMIT 25`
        )
        .all(...candidateIds);
      for (const row of linked) rows.set(`${row.type}:${row.key}`, row);
    }
    return [...rows.values()];
  }

  neighborEntities(matchedEntities) {
    const out = new Map();
    const statement = this.db.prepare(
      `SELECT * FROM entities WHERE (type = ? AND key = ?) AND status = 'active' LIMIT 1`
    );
    for (const entity of matchedEntities.slice(0, 8)) {
      const edges = this.db
        .prepare('SELECT dst_type, dst_id FROM edges WHERE src_type = ? AND src_id = ? LIMIT 12')
        .all(entity.type, entity.key);
      for (const edge of edges) {
        const neighbor = statement.get(edge.dst_type, edge.dst_id);
        if (neighbor) out.set(neighbor.id, neighbor);
      }
    }
    return [...out.values()];
  }

  listEntities({ type, limit = 50 } = {}) {
    const rows = type
      ? this.db.prepare('SELECT * FROM entities WHERE type = ? ORDER BY key LIMIT ?').all(type, limit)
      : this.db.prepare('SELECT * FROM entities ORDER BY type, key LIMIT ?').all(limit);
    return rows.map((row) => ({
      type: row.type,
      key: row.key,
      title: row.title,
      status: row.status,
      risk: row.risk,
      requiresApproval: Boolean(row.requires_approval),
      wired: Boolean(row.wired),
      trust: row.trust
    }));
  }

  stale({ days, now = this.clock() } = {}) {
    const rows = this.db
      .prepare(
        `SELECT i.id, i.title, i.uri, i.source_id, s.trust, s.license, s.stale_after_days,
                COALESCE(i.source_updated_at, i.indexed_at) AS updated_at
         FROM items i JOIN sources s ON s.id = i.source_id
         WHERE i.absent_since IS NULL
         ORDER BY updated_at ASC`
      )
      .all();
    const out = [];
    for (const row of rows) {
      const threshold = days ?? row.stale_after_days ?? 180;
      const age = ageDays(row.updated_at, now);
      if (age !== null && age > threshold) {
        out.push({ id: row.id, title: row.title, uri: row.uri, sourceId: row.source_id, trust: row.trust, licence: row.license, ageDays: Math.round(age), threshold });
      }
    }
    const absent = this.db.prepare('SELECT COUNT(*) AS total FROM items WHERE absent_since IS NOT NULL').get();
    return { items: out, absentCount: Number(absent?.total || 0), checked: rows.length };
  }

  stats() {
    const count = (sql) => Number(this.db.prepare(sql).get()?.total || 0);
    const lastRun = this.db.prepare('SELECT * FROM ingest_runs ORDER BY started_at DESC, rowid DESC LIMIT 1').get() || null;
    const lastRejections = lastRun
      ? this.db.prepare('SELECT line, code, field FROM ingest_rejections WHERE run_id = ? ORDER BY line LIMIT 20').all(lastRun.id)
      : [];
    return {
      schemaVersion: Number(this.getMeta('schema_version') || 0),
      items: count('SELECT COUNT(*) AS total FROM items WHERE absent_since IS NULL'),
      absentItems: count('SELECT COUNT(*) AS total FROM items WHERE absent_since IS NOT NULL'),
      sources: count('SELECT COUNT(*) AS total FROM sources'),
      entities: count('SELECT COUNT(*) AS total FROM entities'),
      edges: count('SELECT COUNT(*) AS total FROM edges'),
      aliases: count('SELECT COUNT(*) AS total FROM item_aliases'),
      lastRun: lastRun
        ? {
            id: lastRun.id,
            sourceId: lastRun.source_id,
            kind: lastRun.kind,
            mode: lastRun.mode,
            startedAt: lastRun.started_at,
            finishedAt: lastRun.finished_at,
            counts: {
              added: lastRun.added,
              updated: lastRun.updated,
              deduplicated: lastRun.deduplicated,
              unchanged: lastRun.unchanged,
              rejected: lastRun.rejected,
              markedAbsent: lastRun.marked_absent
            },
            errorCode: lastRun.error_code
          }
        : null,
      lastRejections
    };
  }

  exportRecords() {
    // `recordType` is the discriminator: the entities table has its own `type`
    // column (tool/skill/project), which must not be confused with the record kind.
    const records = [];
    records.push({
      recordType: 'manifest',
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      exportedAt: iso(this.clock),
      counts: this.stats()
    });
    for (const row of this.db.prepare('SELECT * FROM sources ORDER BY id').all()) {
      records.push({ recordType: 'source', ...row });
    }
    for (const row of this.db.prepare('SELECT * FROM items ORDER BY id').all()) {
      records.push({ recordType: 'item', ...row });
    }
    for (const row of this.db.prepare('SELECT * FROM item_aliases ORDER BY item_id, uri').all()) {
      records.push({ recordType: 'alias', ...row });
    }
    for (const row of this.db.prepare('SELECT * FROM entities ORDER BY id').all()) {
      records.push({ recordType: 'entity', ...row });
    }
    for (const row of this.db.prepare('SELECT entity_id, key, value FROM entity_attrs ORDER BY entity_id, key').all()) {
      records.push({ recordType: 'attr', ...row });
    }
    for (const row of this.db.prepare('SELECT * FROM edges ORDER BY id').all()) {
      records.push({ recordType: 'edge', ...row });
    }
    return records;
  }

  exportJsonl() {
    return `${this.exportRecords().map((record) => JSON.stringify(record)).join('\n')}\n`;
  }

  /** Restores an export into an empty store. Refuses to merge into a non-empty one. */
  importJsonl(text) {
    const lines = String(text || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) throw new Error('backup_empty');
    const records = lines.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error('backup_invalid_json');
      }
    });
    const kindOf = (record) => record?.recordType || record?.type;
    const manifest = records[0];
    if (kindOf(manifest) !== 'manifest') throw new Error('backup_missing_manifest');
    if (manifest.schemaVersion !== KNOWLEDGE_SCHEMA_VERSION) throw new Error('backup_schema_mismatch');
    const existing = this.stats();
    if (existing.items || existing.entities || existing.sources) throw new Error('backup_target_not_empty');
    const counts = { sources: 0, items: 0, aliases: 0, entities: 0, attrs: 0, edges: 0 };
    this.transaction(() => {
      for (const record of records.slice(1)) {
        const kind = kindOf(record);
        if (kind === 'source') {
          this.db
            .prepare(
              `INSERT INTO sources (id, kind, uri, license, trust, stale_after_days, last_sync_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(record.id, record.kind, record.uri, record.license, record.trust, record.stale_after_days, record.last_sync_at, record.created_at, record.updated_at);
          counts.sources += 1;
        } else if (kind === 'item') {
          this.db
            .prepare(
              `INSERT INTO items (id, source_id, kind, title, body, content_hash, lang, trust, uri, source_updated_at, indexed_at, absent_since)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              record.id,
              record.source_id,
              record.kind,
              record.title,
              record.body,
              record.content_hash,
              record.lang,
              record.trust,
              record.uri,
              record.source_updated_at,
              record.indexed_at,
              record.absent_since
            );
          this.indexItem({ id: record.id, title: record.title, body: record.body });
          counts.items += 1;
        } else if (kind === 'alias') {
          this.db
            .prepare('INSERT INTO item_aliases (item_id, source_id, uri, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING')
            .run(record.item_id, record.source_id, record.uri, record.seen_at);
          counts.aliases += 1;
        } else if (kind === 'entity') {
          this.db
            .prepare(
              `INSERT INTO entities (id, type, key, title, key_norm, title_norm, status, risk, requires_approval, wired,
                evidence_item_id, trust, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              record.id,
              record.type,
              record.key,
              record.title,
              record.key_norm,
              record.title_norm,
              record.status,
              record.risk,
              record.requires_approval,
              record.wired,
              record.evidence_item_id,
              record.trust,
              record.created_at,
              record.updated_at
            );
          counts.entities += 1;
        } else if (kind === 'attr') {
          this.db.prepare('INSERT INTO entity_attrs (entity_id, key, value) VALUES (?, ?, ?)').run(record.entity_id, record.key, record.value);
          counts.attrs += 1;
        } else if (kind === 'edge') {
          this.db
            .prepare(
              `INSERT INTO edges (id, src_type, src_id, dst_type, dst_id, rel, weight, evidence_item_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(record.id, record.src_type, record.src_id, record.dst_type, record.dst_id, record.rel, record.weight, record.evidence_item_id, record.created_at);
          counts.edges += 1;
        }
      }
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('restored_at', iso(this.clock));
    });
    return counts;
  }

  fingerprint() {
    const row = this.db
      .prepare("SELECT COUNT(*) AS total, COALESCE(SUM(LENGTH(id) + LENGTH(content_hash)), 0) AS size FROM items")
      .get();
    return `${Number(row?.total || 0)}:${Number(row?.size || 0)}`;
  }
}

function ageDays(value, now) {
  if (!value) return null;
  const time = Date.parse(String(value));
  if (Number.isNaN(time)) return null;
  return (now - time) / 86_400_000;
}

function freshness(value, staleAfterDays, now) {
  const age = ageDays(value, now);
  if (age === null) return 0.5;
  const window = Number(staleAfterDays) > 0 ? Number(staleAfterDays) : 180;
  if (age <= 0) return 1;
  return Math.max(0, 1 - age / window);
}
