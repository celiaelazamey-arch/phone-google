#!/usr/bin/env node
/**
 * Knowledge network CLI.
 *
 *   npm run kb -- status
 *   npm run kb -- verify
 *   npm run kb -- import            # dry-run (default)
 *   npm run kb -- import --apply [--full]
 *   npm run kb -- search "استعلام" [--limit 5]
 *   npm run kb -- entity tool celia_status
 *   npm run kb -- entities --type skill
 *   npm run kb -- stale [--days 90]
 *   npm run kb -- export --out knowledge.jsonl
 *   npm run kb -- restore --file knowledge.jsonl
 *
 * The CLI is the supported write path in production: remote import over HTTP stays
 * disabled unless explicitly enabled for a disposable environment.
 */
import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKnowledgeHost } from '../src/knowledge/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const command = argv[0] || 'status';
const flag = (name, fallback = undefined) => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : true;
};
const VALUE_FLAGS = new Set(['dir', 'db', 'limit', 'chars', 'type', 'days', 'out', 'file', 'kind']);
const positional = [];
for (let index = 1; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg.startsWith('--')) {
    if (VALUE_FLAGS.has(arg.slice(2))) index += 1;
    continue;
  }
  positional.push(arg);
}

const out = (value) => console.log(JSON.stringify(value, null, 2));

async function main() {
  const directory = path.resolve(root, String(flag('dir', 'data/kb')));
  const host = createKnowledgeHost({
    env: {
      ...process.env,
      CELIA_KB: 'sqlite',
      CELIA_KB_PATH: flag('db') || process.env.CELIA_KB_PATH || path.join(root, '.data', 'knowledge.sqlite3')
    },
    nodeEnv: process.env.NODE_ENV || 'development'
  });

  if (command === 'status') {
    out(await host.status());
    return;
  }
  if (command === 'verify') {
    const report = await host.importDirectory({ dryRun: true });
    out(report);
    if (report.totals.rejectedRows > 0) process.exitCode = 2;
    return;
  }
  if (command === 'import') {
    const apply = flag('apply', false) === true;
    const full = flag('full', false) === true;
    const kinds = flag('kind') ? [String(flag('kind'))] : undefined;
    const report = await host.importDirectory({ dryRun: !apply, full, kinds });
    out(report);
    if (report.totals.rejectedRows > 0) process.exitCode = 2;
    return;
  }
  if (command === 'search') {
    const query = positional.join(' ').trim();
    if (!query) throw new Error('usage: npm run kb -- search "استعلام"');
    out(await host.search({ query, limit: Number(flag('limit', 6)), maxChars: Number(flag('chars', 1200)) }));
    return;
  }
  if (command === 'entity') {
    const [type, key] = positional;
    if (!type || !key) throw new Error('usage: npm run kb -- entity <type> <key>');
    const detail = await host.entity(type, key);
    if (!detail) {
      console.error('entity_not_found');
      process.exitCode = 1;
      return;
    }
    out(detail);
    return;
  }
  if (command === 'entities') {
    out({ entities: await host.entities({ type: flag('type'), limit: Number(flag('limit', 100)) }) });
    return;
  }
  if (command === 'stale') {
    const days = flag('days');
    out(await host.stale(days === undefined ? {} : { days: Number(days) }));
    return;
  }
  if (command === 'export') {
    const target = flag('out');
    if (!target) throw new Error('usage: npm run kb -- export --out <file.jsonl>');
    const body = await host.exportJsonl();
    await writeFile(path.resolve(root, String(target)), body, 'utf8');
    out({ written: String(target), bytes: Buffer.byteLength(body) });
    return;
  }
  if (command === 'restore') {
    const source = flag('file');
    if (!source) throw new Error('usage: npm run kb -- restore --file <file.jsonl>');
    const text = await readFile(path.resolve(root, String(source)), 'utf8');
    const store = await host.store();
    out(store.importJsonl(text));
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode || 0));
