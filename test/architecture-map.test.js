// VFE-003 / DEC-086 — the Living Architecture Map. These tests exist because a map that is drawn by
// hand lies within a week: the graph must come from the imports, the status must come from the tests,
// the activation must come from the switches, and the page must be a function of the map.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  ARCH_MAP_VERSION,
  COMPONENTS,
  LAYERS,
  TRUTH,
  TRUTH_LABEL,
  TRUTH_MARK,
  buildArchitectureMap,
  extractImports,
  impactOf,
  resolveSpecifier,
  scanModules
} from '../src/design/architecture-map.js';
import { PAGE_PATH, buildHtml, buildImpactReport, layout } from '../scripts/render-architecture-map.mjs';

const root = path.resolve(import.meta.dirname, '..');
const map = buildArchitectureMap({ root });

test('the map comes from the source: every module and edge exists on disk', () => {
  const modules = scanModules(root);
  assert.ok(modules.size > 90, `expected a real module graph, found ${modules.size}`);
  for (const module of modules.values()) {
    assert.ok(existsSync(path.join(root, module.path)), `${module.path} does not exist`);
    for (const dependency of module.dependencies) {
      assert.ok(existsSync(path.join(root, dependency)), `${module.path} imports ${dependency}, which is missing`);
    }
  }
  assert.ok([...modules.values()].reduce((sum, module) => sum + module.dependencies.length, 0) > 150, 'the graph has real edges');
});

test('the sixteen named components are real files, and none is a phantom', () => {
  assert.ok(COMPONENTS.length >= 15, 'the owner named fifteen or more');
  assert.equal(map.components.length, COMPONENTS.length);
  for (const component of map.components) {
    assert.ok(component.files.length > 0, `${component.id} has no file at all`);
    for (const file of component.files) assert.ok(existsSync(path.join(root, file)), `${component.id}: ${file} is missing`);
    assert.ok(LAYERS[component.layer], `${component.id} sits in an unknown layer`);
  }
  for (const required of ['kernel', 'event_bus', 'tool_registry', 'memory_engine', 'workflow_engine', 'agent_runtime', 'model_router', 'planner', 'critic', 'data_layer', 'policy_approval', 'sandbox', 'evidence', 'deployment']) {
    assert.ok(map.components.some((component) => component.id === required), `the map omits ${required}`);
  }
});

test('status is derived, never typed: verified requires a test that names the module file', () => {
  for (const component of map.components) {
    if (component.status === TRUTH.verified) {
      assert.equal(component.tested.length, component.files.length, `${component.id} claims verification without a test for every file`);
      assert.ok(component.files.length > 0);
    }
    if (component.status === TRUTH.partial) assert.ok(component.missing.length > 0 || component.tested.length < component.files.length);
    if (component.status === TRUTH.missing) assert.equal(component.files.length, 0);
  }
  assert.ok(map.stats.verified >= 10, 'most of the runtime is measured as verified');
  assert.ok(map.stats.counts[TRUTH.unverified] + map.stats.counts[TRUTH.partial] > 0, 'the map admits partial coverage');
});

test('activation is read from the code, so "implemented" never means "running"', () => {
  const runtime = map.components.find((component) => component.id === 'agent_runtime');
  assert.equal(runtime.status, TRUTH.verified);
  assert.equal(runtime.activation.state, 'off_by_default', 'the runtime is implemented, tested, and off');
  assert.match(runtime.activation.evidence, /CELIA_AGENT_RUNTIME/);
  const computer = map.components.find((component) => component.id === 'browser_computer_mcp');
  assert.equal(computer.activation.state, 'off_by_default');
  const evidence = map.components.find((component) => component.id === 'evidence');
  assert.equal(evidence.activation.state, 'on');
});

test('the seven truth labels are the owner\'s, with a mark each', () => {
  assert.deepEqual(Object.values(TRUTH_MARK), ['🟢', '🟠', '🟡', '🔵', '🔴', '⚪', '⛔']);
  assert.deepEqual(Object.values(TRUTH_LABEL), ['منفّذ ومتحقق', 'منفّذ وغير متحقق', 'جزئي', 'مقترح', 'غير منفّذ', 'موجود ومعطّل', 'محجوب']);
  assert.equal(Object.keys(TRUTH).length, 7);
  assert.equal(ARCH_MAP_VERSION, 'celiaos-architecture-map-v1');
});

test('imports are read as imports, not as text that looks like one', () => {
  assert.deepEqual(extractImports("import { a } from './a.js';\nimport './side.js';\nexport { b } from './b.js';").sort(), ['./a.js', './b.js', './side.js']);
  assert.deepEqual(extractImports("const x = await import('./dyn.js');"), ['./dyn.js']);
  assert.deepEqual(extractImports("// import { a } from './fake.js'\nconst s = \"import { b } from './nope.js'\";"), []);
  assert.equal(resolveSpecifier('src/agent/runtime.js', './tools.js'), 'src/agent/tools.js');
  assert.equal(resolveSpecifier('src/agent/runtime.js', 'node:fs'), null);
  assert.equal(resolveSpecifier('src/agent/runtime.js', 'dotenv'), null);
});

test('impact walks the real reverse edges and names what a change touches', () => {
  const { impact } = buildImpactReport(['src/agent/verifier.js'], { root });
  assert.ok(impact.components.includes('critic'), 'the verifier component itself');
  assert.ok(impact.components.includes('agent_runtime'), 'runtime imports the verifier');
  assert.ok(impact.modules.includes('src/agent/runtime.js'), 'the module that depends on it is reached');
  assert.ok(impact.modules.length > 2, 'a change reaches more than itself');
  assert.deepEqual(impact.unmapped, [], 'the changed file is inside the map');
  const outside = buildImpactReport(['README.md'], { root }).impact;
  assert.deepEqual(outside.components, []);
  assert.deepEqual(outside.unmapped, ['README.md']);
});

test('the impact closure follows chains, not one hop', () => {
  const synthetic = new Map([
    ['a.js', { path: 'a.js', dependencies: [] }],
    ['b.js', { path: 'b.js', dependencies: ['a.js'] }],
    ['c.js', { path: 'c.js', dependencies: ['b.js'] }]
  ]);
  const fakeMap = { components: [{ id: 'x', files: ['a.js', 'c.js'] }, { id: 'y', files: ['b.js'] }] };
  const result = impactOf(['a.js'], fakeMap, synthetic);
  assert.deepEqual(result.modules, ['a.js', 'b.js', 'c.js'], 'transitive, not one hop');
  assert.deepEqual(result.components, ['x', 'y']);
});

test('the page is generated from the map and cannot drift', () => {
  assert.ok(existsSync(PAGE_PATH));
  const page = readFileSync(PAGE_PATH, 'utf8');
  assert.equal(page, buildHtml(), 'the architecture map is stale — run `npm run arch:map`');
  assert.match(page, /<html lang="ar" dir="rtl">/);
  assert.match(page, /name="celia-visual"/);
  assert.match(page, /--bg:#080d24/);
  assert.match(page, /public\/fonts\//, 'fonts stay local');
  for (const component of map.components) {
    const escaped = component.ar.replace(/&/g, '&amp;');
    assert.ok(page.includes(escaped), `the page omits ${component.id}`);
  }
  assert.ok(page.includes(`data-id="runtime"`) === false, 'ids are component ids, not file names');
});

test('the drawing is laid out by layer, and every node has coordinates', () => {
  const { positions, width, height } = layout(map);
  assert.equal(positions.size, map.components.length);
  assert.ok(width > 1000 && height > 300);
  const xs = new Set([...positions.values()].map((position) => position.x));
  assert.equal(xs.size, new Set(map.components.map((component) => component.layer)).size, 'one column per layer');
  for (const edge of map.edges) {
    assert.ok(positions.has(edge.from) && positions.has(edge.to), `edge ${edge.from}->${edge.to} has no endpoints`);
  }
});
