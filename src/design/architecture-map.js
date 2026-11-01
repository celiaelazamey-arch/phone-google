/**
 * Living Architecture Map — measured from the source, not drawn by hand (VFE-003 / DEC-086).
 *
 * The map answers three questions with evidence instead of prose:
 *   1. Which modules exist, and what imports what? (`scanModules`)
 *   2. Which of the fifteen components the owner named are actually backed by code, tested, and
 *      reachable from an entry point? (`buildArchitectureMap` computes this; nothing is asserted.)
 *   3. If I change this file, what else moves? (`impactOf` walks the reverse edges.)
 *
 * The status vocabulary is the owner's seven labels. A component is `verified` only when a test
 * file references one of its modules by path or by basename — a module that merely exists is
 * `implemented_unverified`, and an absent file is `not_implemented`. No hand-set status survives:
 * every value is derived on each run, so the picture cannot outlive the evidence.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const ARCH_MAP_VERSION = 'celiaos-architecture-map-v1';

export const TRUTH = Object.freeze({
  verified: 'implemented_verified',
  unverified: 'implemented_unverified',
  partial: 'partial',
  proposed: 'proposed',
  missing: 'not_implemented',
  disabled: 'disabled',
  blocked: 'blocked'
});

export const TRUTH_LABEL = Object.freeze({
  [TRUTH.verified]: 'منفّذ ومتحقق',
  [TRUTH.unverified]: 'منفّذ وغير متحقق',
  [TRUTH.partial]: 'جزئي',
  [TRUTH.proposed]: 'مقترح',
  [TRUTH.missing]: 'غير منفّذ',
  [TRUTH.disabled]: 'موجود ومعطّل',
  [TRUTH.blocked]: 'محجوب'
});

export const TRUTH_MARK = Object.freeze({
  [TRUTH.verified]: '🟢',
  [TRUTH.unverified]: '🟠',
  [TRUTH.partial]: '🟡',
  [TRUTH.proposed]: '🔵',
  [TRUTH.missing]: '🔴',
  [TRUTH.disabled]: '⚪',
  [TRUTH.blocked]: '⛔'
});

export const LAYERS = Object.freeze({
  entry: 'المدخل',
  runtime: 'التشغيل',
  intelligence: 'الذكاء',
  data: 'البيانات',
  security: 'الأمان والحوكمة',
  delivery: 'التسليم'
});

/**
 * The components the owner listed in §2, each pointing at real files. `optional` marks files a
 * component may legitimately lack (a declared capability that is not wired yet).
 */
export const COMPONENTS = Object.freeze([
  Object.freeze({ id: 'kernel', ar: 'Kernel', layer: 'runtime', files: ['src/agent/harness.js'] }),
  Object.freeze({ id: 'event_bus', ar: 'Event Bus', layer: 'runtime', files: ['src/agent/runtime.js'] }),
  Object.freeze({ id: 'tool_registry', ar: 'Tool Registry', layer: 'runtime', files: ['src/agent/tools.js', 'src/knowledge/tool-policy.js'] }),
  Object.freeze({ id: 'workflow_engine', ar: 'Workflow Engine', layer: 'runtime', files: ['src/agent/automation/index.js', 'src/agent/automation/schema.js'] }),
  Object.freeze({ id: 'agent_runtime', ar: 'Agent Runtime', layer: 'runtime', files: ['src/agent/runtime.js', 'src/agent/index.js'] }),
  Object.freeze({ id: 'memory_engine', ar: 'Memory Engine', layer: 'data', files: ['src/agent/memory.js', 'src/memory-pool.js'] }),
  Object.freeze({ id: 'model_router', ar: 'Model Router', layer: 'intelligence', files: ['src/agent/model-router.js'] }),
  Object.freeze({ id: 'planner', ar: 'Planner', layer: 'intelligence', files: ['src/agent/planner.js', 'src/agent/planner-fallback.js'] }),
  Object.freeze({ id: 'executor', ar: 'Executor', layer: 'intelligence', files: ['src/agent/outbox.js'] }),
  Object.freeze({ id: 'critic', ar: 'Critic / Verifier', layer: 'intelligence', files: ['src/agent/verifier.js'] }),
  Object.freeze({ id: 'browser_computer_mcp', ar: 'Browser · Computer Use · MCP', layer: 'intelligence', files: ['src/agent/web-fetch.js', 'src/agent/computer-policy.js', 'src/mcp-contract.js'] }),
  Object.freeze({ id: 'data_layer', ar: 'Data Layer', layer: 'data', files: ['src/db.js', 'src/mysql-config.js', 'src/schema-migrations.js'] }),
  Object.freeze({ id: 'policy_approval', ar: 'Policy & Approval', layer: 'security', files: ['src/agent/access-policy.js', 'src/agent/sandbox-policy.js'] }),
  Object.freeze({ id: 'sandbox', ar: 'Sandbox', layer: 'security', files: ['src/agent/sandbox.js'] }),
  Object.freeze({ id: 'evidence', ar: 'Evidence', layer: 'security', files: ['src/agent/evidence.js'] }),
  Object.freeze({ id: 'deployment', ar: 'Deployment', layer: 'delivery', files: ['workers/celia-edge/worker.js', 'render.yaml'], optional: ['.github/workflows/pages.yml'] })
]);

const IMPORT_PATTERNS = [
  /(?:^|\n)\s*import\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*export\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*(?:const|let|var)\s+[^=]+?=\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)/g
];

export function extractImports(source) {
  const found = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of String(source).matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

/** Resolve a relative specifier to a repository-relative file path, or null for bare/URL imports. */
export function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}/index.js`];
  return candidates.find((candidate) => candidate.endsWith('.js') || candidate.endsWith('.mjs')) || null;
}

function walk(dir, root, acc) {
  for (const name of readdirSync(path.join(root, dir)).sort()) {
    const relative = dir ? `${dir}/${name}` : name;
    const stats = statSync(path.join(root, relative));
    if (stats.isDirectory()) {
      if (['node_modules', '.git', 'coverage', 'dist', 'vendor'].includes(name)) continue;
      walk(relative, root, acc);
    } else if (name.endsWith('.js') || name.endsWith('.mjs')) {
      acc.push(relative);
    }
  }
  return acc;
}

/** Every JavaScript module under `roots`, with its resolved relative imports. */
export function scanModules(root, roots = ['src', 'workers']) {
  const files = roots.flatMap((dir) => (existsSync(path.join(root, dir)) ? walk(dir, root, []) : []));
  const modules = new Map();
  for (const file of files) {
    const relative = file;
    const source = readFileSync(path.join(root, relative), 'utf8');
    const imports = extractImports(source);
    modules.set(relative, {
      path: relative,
      imports,
      dependencies: imports
        .map((specifier) => resolveSpecifier(relative, specifier))
        .filter((target) => target && existsSync(path.join(root, target)))
    });
  }
  return modules;
}

function testCorpus(root) {
  const dir = path.join(root, 'test');
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => readFileSync(path.join(dir, name), 'utf8'))
    .join('\n');
}

const basename = (file) => path.basename(file).replace(/\.(m?js)$/, '');


/**
 * Activation is a second question, not a status: a module can be implemented, tested and still be
 * off by default. The two facts this reads are declared in code — the runtime switch in
 * `src/agent/index.js` and the "nothing is wired" summary in the computer policy — so the page
 * cannot claim a capability is running while the switch says otherwise.
 */
export function activationOf(component, root) {
  const reads = (file, pattern) => {
    if (!existsSync(path.join(root, file))) return false;
    return pattern.test(readFileSync(path.join(root, file), 'utf8'));
  };
  if (component.files.includes('src/agent/index.js') && reads('src/agent/index.js', /CELIA_AGENT_RUNTIME\s*\|\|\s*'off'/)) {
    return { state: 'off_by_default', evidence: "src/agent/index.js — CELIA_AGENT_RUNTIME defaults to 'off'" };
  }
  if (component.files.includes('src/agent/computer-policy.js') && reads('src/agent/computer-policy.js', /wired:\s*false/)) {
    return { state: 'off_by_default', evidence: 'src/agent/computer-policy.js — no capability is wired' };
  }
  if (component.files.includes('src/agent/sandbox.js')) {
    return { state: 'off_by_default', evidence: 'src/agent/sandbox-policy.js — NETWORK=DENY, sandbox is opt-in' };
  }
  return { state: 'on', evidence: null };
}

/**
 * Build the map: per component, its real files, whether a test references them, whether an entry
 * point imports them, and the measured status. Then the component-level edges from module imports.
 */
export function buildArchitectureMap({ root = path.resolve(import.meta.dirname, '../..') } = {}) {
  const modules = scanModules(root);
  const tests = testCorpus(root);
  const entrySource = ['src/server.js', 'src/agent/index.js', 'workers/celia-edge/index.js']
    .filter((file) => existsSync(path.join(root, file)))
    .map((file) => readFileSync(path.join(root, file), 'utf8'))
    .join('\n');

  const entryFiles = ['src/server.js', 'src/agent/index.js', 'workers/celia-edge/worker.js'].filter((file) =>
    existsSync(path.join(root, file))
  );
  const reachable = new Set(entryFiles);
  let grew = true;
  while (grew) {
    grew = false;
    for (const file of [...reachable]) {
      const module = modules.get(file);
      if (!module) continue;
      for (const dependency of module.dependencies) {
        if (!reachable.has(dependency)) {
          reachable.add(dependency);
          grew = true;
        }
      }
    }
  }

  const components = COMPONENTS.map((component) => {
    const present = component.files.filter((file) => existsSync(path.join(root, file)));
    const missing = component.files.filter((file) => !existsSync(path.join(root, file)));
    const testedFiles = present.filter((file) => {
      // A test must name the module *file*, not a word that happens to appear somewhere in a test.
      const pattern = new RegExp(`(?:^|[^A-Za-z0-9_.-])${basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(?:m?js)`);
      return pattern.test(tests);
    });
    const wired = present.some((file) => reachable.has(file) || entrySource.includes(file));
    const status = !present.length
      ? TRUTH.missing
      : missing.length || (testedFiles.length > 0 && testedFiles.length < present.length)
        ? TRUTH.partial
        : testedFiles.length === present.length
          ? TRUTH.verified
          : TRUTH.unverified;
    return {
      id: component.id,
      ar: component.ar,
      layer: component.layer,
      files: present,
      missing,
      tested: testedFiles,
      wired,
      status,
      activation: activationOf(component, root)
    };
  });

  const ownerOf = new Map();
  for (const component of components) {
    for (const file of component.files) ownerOf.set(file, component.id);
  }
  const edgeSet = new Map();
  for (const module of modules.values()) {
    const from = ownerOf.get(module.path);
    if (!from) continue;
    for (const dependency of module.dependencies) {
      const to = ownerOf.get(dependency);
      if (!to || to === from) continue;
      const key = `${from}->${to}`;
      if (!edgeSet.has(key)) edgeSet.set(key, { from, to, count: 0, files: [] });
      const edge = edgeSet.get(key);
      edge.count += 1;
      if (!edge.files.includes(module.path)) edge.files.push(module.path);
    }
  }

  const counts = Object.fromEntries(Object.values(TRUTH).map((status) => [status, 0]));
  for (const component of components) counts[component.status] += 1;

  return {
    version: ARCH_MAP_VERSION,
    components,
    edges: [...edgeSet.values()].sort((a, b) => `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`)),
    stats: {
      modules: modules.size,
      edges: modules.values().reduce((sum, module) => sum + module.dependencies.length, 0),
      components: components.length,
      counts,
      verified: counts[TRUTH.verified],
      unverified: counts[TRUTH.unverified],
      partial: counts[TRUTH.partial],
      missing: counts[TRUTH.missing]
    }
  };
}

/**
 * Impact of a change: the given files, the components that own them, and every component that
 * reaches them through imports (reverse transitive closure over module edges).
 */
export function impactOf(changedFiles, map, modules) {
  const ownerOf = new Map();
  for (const component of map.components) for (const file of component.files) ownerOf.set(file, component.id);
  const seeds = new Map();
  for (const file of changedFiles) {
    const owner = ownerOf.get(file);
    if (owner) seeds.set(file, owner);
  }
  const affectedComponents = new Set(seeds.values());
  const affectedModules = new Set(seeds.keys());
  if (modules) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const module of modules.values()) {
        if (affectedModules.has(module.path)) continue;
        if (module.dependencies.some((dependency) => affectedModules.has(dependency))) {
          affectedModules.add(module.path);
          const owner = ownerOf.get(module.path);
          if (owner) affectedComponents.add(owner);
          changed = true;
        }
      }
    }
  }
  return {
    files: [...seeds.keys()].sort(),
    components: [...affectedComponents].sort(),
    modules: [...affectedModules].sort(),
    unmapped: changedFiles.filter((file) => !ownerOf.has(file)).sort()
  };
}
