import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const appJs = read('public/app.js');
const indexHtml = read('public/index.html');

test('T6-01 the fifth mission card is present and wired to the Figma → live UI flow', () => {
  assert.match(indexHtml, /<!-- 5 Agentic Mission Cards -->/);
  assert.match(indexHtml, /data-mission="figma-live-ui"/);
  assert.match(indexHtml, /تحويل تصميم Figma إلى واجهة حية/);
  assert.match(appJs, /missionId === 'figma-live-ui'/);
  assert.match(appJs, /name: 'figma_inspect_design'/);
  assert.match(appJs, /name: 'figma_to_live_artifact'/);
});

test('T6-02 the generated artifact is rendered into the computer drawer, not executed as a script', () => {
  const branch = appJs.slice(appJs.indexOf("missionId === 'figma-live-ui'"), appJs.indexOf("missionId === 'free-stack-blueprint'"));
  assert.match(branch, /artifactHtml: artifact\.html/);
  assert.match(branch, /openDrawer\('preview'\)/);
  assert.equal(branch.includes('eval('), false);
  assert.equal(branch.includes('document.write'), false);
  assert.equal(branch.includes('innerHTML ='), false);
  assert.match(branch, /isError/);
});

test('T6-03 no Figma secret or provider URL is hardcoded in browser code', () => {
  assert.equal(appJs.includes('FIGMA_ACCESS_TOKEN'), false);
  assert.equal(appJs.includes('X-Figma-Token'), false);
  assert.equal(appJs.includes('figd_'), false);
  assert.equal(indexHtml.includes('FIGMA_ACCESS_TOKEN'), false);
});

test('T6-04 tool counts and sample arguments cover the two new Figma tools', () => {
  assert.match(indexHtml, /id="nav-tools-count">15</);
  assert.match(indexHtml, /data-cat="all">الكل \(15\)/);
  assert.match(appJs, /case 'figma_inspect_design':/);
  assert.match(appJs, /case 'figma_to_live_artifact':/);
});
