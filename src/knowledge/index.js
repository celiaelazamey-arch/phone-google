import { statSync } from 'node:fs';
import path from 'node:path';
import { KnowledgeStore } from './store.js';
import { ingestDirectory } from './ingest.js';

/**
 * Explicit knowledge-network host.
 *
 * `CELIA_KB=off` (default) → nothing opens, `/api/kb/*` answers 503 and the agent
 * simply has no `kb.*` tools. `CELIA_KB=sqlite` → a local durable file store.
 *
 * Durability is stated, not assumed: the index is derived data that can be rebuilt
 * from the registries and Drive, and on an ephemeral host the status says so.
 */

export const KB_MODES = Object.freeze(['off', 'sqlite']);

export function readKbMode(env = process.env) {
  const raw = String(env.CELIA_KB || 'off').trim().toLowerCase() || 'off';
  if (!KB_MODES.includes(raw)) throw new Error('CELIA_KB must be off or sqlite');
  return raw;
}

export function readKbPath(env = process.env) {
  const raw = String(env.CELIA_KB_PATH || '').trim();
  return raw || path.join('.data', 'knowledge.sqlite3');
}

const fileSize = (file) => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

export function createKnowledgeHost({
  env = process.env,
  nodeEnv = 'development',
  logger = console,
  clock = Date.now,
  directory = 'data/kb'
} = {}) {
  let mode = 'off';
  let configError = null;
  try {
    mode = readKbMode(env);
  } catch (error) {
    configError = error.message;
  }
  const file = readKbPath(env);
  const persistent = env.CELIA_KB_PERSISTENT === 'true';
  let opening = null;
  const store = () => {
    if (configError) return Promise.reject(new Error(configError));
    if (mode === 'off') return Promise.reject(new Error('knowledge_disabled'));
    if (!opening) {
      opening = KnowledgeStore.open({ file, clock }).catch((error) => {
        opening = null;
        throw error;
      });
    }
    return opening;
  };

  const unsupported = (reason) => ({
    enabled: false,
    mode,
    path: file,
    reason,
    required: 'CELIA_KB=sqlite',
    note: 'المعرفة المشتقة لا تُفتح تلقائيًا ولا تُستبدل بذاكرة مؤقتة.'
  });

  return {
    mode,
    path: file,
    store,
    async status() {
      if (configError) return unsupported('invalid_kb_mode');
      if (mode === 'off') return unsupported('knowledge_disabled');
      try {
        const opened = await store();
        const stats = opened.stats();
        const stale = opened.stale();
        return {
          enabled: true,
          mode,
          path: file,
          bytes: fileSize(file),
          schemaVersion: stats.schemaVersion,
          stats: {
            items: stats.items,
            absentItems: stats.absentItems,
            sources: stats.sources,
            entities: stats.entities,
            edges: stats.edges,
            aliases: stats.aliases
          },
          lastRun: stats.lastRun,
          lastRejections: stats.lastRejections,
          stale: { count: stale.items.length, absent: stale.absentCount },
          durability: {
            kind: 'file',
            persistent: persistent && nodeEnv === 'production',
            warning:
              nodeEnv === 'production' && !persistent
                ? 'index file may be ephemeral on this host; set CELIA_KB_PERSISTENT=true only with a mounted disk, otherwise re-run npm run kb -- import --apply after deploys'
                : null
          },
          note: 'فهرس مشتق قابل لإعادة البناء من السجلات وDrive؛ لا أسرار ولا شبكة أثناء البحث.'
        };
      } catch (error) {
        return unsupported(error?.message?.split(':')[0] || 'knowledge_unavailable');
      }
    },
    async search(options) {
      const opened = await store();
      return opened.search(options);
    },
    async entity(type, key) {
      const opened = await store();
      return opened.entityDetail(type, key);
    },
    async entities(options) {
      const opened = await store();
      return opened.listEntities(options);
    },
    async stale(options) {
      const opened = await store();
      return opened.stale(options);
    },
    async exportJsonl() {
      const opened = await store();
      return opened.exportJsonl();
    },
    async importDirectory({ dryRun = true, full = false, kinds } = {}) {
      const opened = await store();
      return ingestDirectory({ store: opened, directory, dryRun, full, clock, kinds });
    }
  };
}
