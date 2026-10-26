import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLiveArtifact,
  escapeHtml,
  inspectDesign,
  loadFigmaConfig,
  parseFigmaReference,
  sanitizeFigmaTree
} from '../src/figma.js';

const TOKEN = 'figma-secret-abcdef123456';
const FILE_KEY = 'AbCdEfGhIjKlMnOpQrStUv';
const ENV = { FIGMA_ACCESS_TOKEN: TOKEN };

function config(overrides = {}) {
  return loadFigmaConfig({ ...ENV, ...overrides });
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function sampleDocument() {
  return {
    name: 'Celia Design',
    lastModified: '2026-10-20T10:00:00Z',
    // حقول حساسة يجب ألا تظهر أبدًا في المخرجات.
    editorType: 'figma',
    owner: { email: 'owner@private.example', handle: 'private-user' },
    document: {
      id: '0:0',
      name: 'Page 1',
      type: 'CANVAS',
      absoluteBoundingBox: { width: 1440, height: 900 },
      fills: [{ type: 'SOLID', color: { r: 0.388, g: 0.4, b: 0.945 } }],
      children: [
        {
          id: '1:2',
          name: 'Hero <script>alert(1)</script>',
          type: 'FRAME',
          absoluteBoundingBox: { width: 640, height: 320 },
          fills: [{ type: 'SOLID', color: { r: 0.055, g: 0.647, b: 0.914 } }],
          style: { fontFamily: 'Cairo' },
          children: [
            { id: '1:3', name: 'Primary Button', type: 'COMPONENT', style: { fontFamily: 'Tajawal' } },
            { id: '1:4', name: 'Title', type: 'TEXT', fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] }
          ]
        }
      ]
    }
  };
}

test('T4-01 parseFigmaReference accepts URLs and raw keys while blocking SSRF/invalid inputs', () => {
  assert.deepEqual(parseFigmaReference(FILE_KEY), { fileKey: FILE_KEY, nodeId: null, source: 'file_key' });
  assert.deepEqual(parseFigmaReference(`https://www.figma.com/file/${FILE_KEY}/MyDesign?node-id=12-34`), {
    fileKey: FILE_KEY,
    nodeId: '12:34',
    source: 'url'
  });
  assert.equal(parseFigmaReference(`https://www.figma.com/design/${FILE_KEY}/App`).fileKey, FILE_KEY);
  assert.throws(() => parseFigmaReference(''), /figma_reference_required/);
  assert.throws(() => parseFigmaReference('http://www.figma.com/file/AbCdEfGhIjKlMnOpQrStUv/x'), /https_figma_url/);
  assert.throws(() => parseFigmaReference(`https://evil.example.com/file/${FILE_KEY}/x`), /https_figma_url/);
  assert.throws(() => parseFigmaReference('https://www.figma.com/file/../../etc/passwd'), /file_key_is_invalid/);
  assert.throws(() => parseFigmaReference(`https://www.figma.com/file/${FILE_KEY}/x?node-id=${'X'.repeat(90)}`), /node_id_is_invalid/);
});

test('T4-02 loadFigmaConfig applies defaults and strips wrapping quotes', () => {
  const cfg = config();
  assert.equal(cfg.accessToken, TOKEN);
  assert.equal(cfg.baseUrl, 'https://api.figma.com/v1/');
  assert.equal(cfg.maxNodes, 40);
  assert.equal(cfg.maxDepth, 4);
  assert.equal(config({ FIGMA_ACCESS_TOKEN: '"quoted-figma-123456"' }).accessToken, 'quoted-figma-123456');
  assert.throws(() => config({ FIGMA_BASE_URL: 'http://evil.example.com/v1' }), /HTTPS/);
});

test('T4-03 sanitizeFigmaTree extracts colors/fonts/components and enforces node and depth limits', () => {
  const result = sanitizeFigmaTree(sampleDocument().document, { maxNodes: 40, maxDepth: 4 });
  assert.equal(result.nodeCount, 4);
  assert.ok(result.colors.includes('#6366F1'));
  assert.ok(result.colors.includes('#0EA5E9'));
  assert.ok(result.colors.includes('#FFFFFF'));
  assert.deepEqual(result.fonts, ['Cairo', 'Tajawal']);
  assert.deepEqual(result.components, ['Primary Button']);
  assert.equal(result.truncated, false);
  const dump = JSON.stringify(result);
  assert.equal(dump.includes('owner@private.example'), false);
  assert.equal(dump.includes('private-user'), false);
  assert.equal(dump.includes('editorType'), false);

  const limited = sanitizeFigmaTree(sampleDocument().document, { maxNodes: 2, maxDepth: 1 });
  assert.equal(limited.nodeCount, 2);
  assert.equal(limited.truncated, true);
});

test('T4-04 inspectDesign calls the API with the token in a header only and returns a sanitized summary', async () => {
  const calls = [];
  const design = await inspectDesign({
    config: config(),
    url: `https://www.figma.com/file/${FILE_KEY}/MyDesign`,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse(sampleDocument());
    }
  });
  assert.equal(design.provider, 'figma');
  assert.equal(design.fileKey, FILE_KEY);
  assert.equal(design.name, 'Celia Design');
  assert.equal(design.nodeCount, 4);
  assert.equal(design.httpStatus, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.figma.com/v1/files/${FILE_KEY}?depth=4`);
  assert.equal(calls[0].url.includes(TOKEN), false);
  assert.equal(calls[0].options.headers['X-Figma-Token'], TOKEN);
  assert.ok(calls[0].options.signal);
  const dump = JSON.stringify(design);
  for (const secret of [TOKEN, 'owner@private.example', 'private-user']) assert.equal(dump.includes(secret), false);
});

test('T4-05 a node-id is passed to the /nodes endpoint with a colon-separated id', async () => {
  const calls = [];
  const design = await inspectDesign({
    config: config(),
    url: `https://www.figma.com/file/${FILE_KEY}/MyDesign?node-id=12-34`,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return jsonResponse({ name: 'Celia Design', nodes: { '12:34': { document: sampleDocument().document } } });
    }
  });
  assert.equal(design.nodeId, '12:34');
  assert.equal(calls[0], `https://api.figma.com/v1/files/${FILE_KEY}/nodes?ids=12%3A34`);
});

test('T4-06 missing token, rejected token, and timeouts are handled without leaking data', async () => {
  await assert.rejects(
    inspectDesign({ config: loadFigmaConfig({}), url: FILE_KEY, fetchImpl: async () => jsonResponse({}) }),
    (error) => {
      assert.equal(error.code, 'not_configured');
      return true;
    }
  );
  await assert.rejects(
    inspectDesign({
      config: config(),
      url: FILE_KEY,
      fetchImpl: async () => jsonResponse({ err: `bad ${TOKEN}` }, 401)
    }),
    (error) => {
      assert.equal(error.code, 'token_rejected');
      assert.equal(error.status, 401);
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    }
  );
  await assert.rejects(
    inspectDesign({
      config: config(),
      url: FILE_KEY,
      fetchImpl: async () => {
        const error = new Error(`socket https://api.figma.com/v1/files/${FILE_KEY}?token=${TOKEN}`);
        error.name = 'TimeoutError';
        throw error;
      }
    }),
    (error) => {
      assert.equal(error.code, 'timeout');
      assert.equal(error.message.includes(TOKEN), false);
      assert.equal(error.message.includes('api.figma.com'), false);
      return true;
    }
  );
});

test('T4-07 buildLiveArtifact escapes hostile node names and emits a script-free standalone page', () => {
  const design = {
    name: 'تصميم <img src=x onerror=alert(1)>',
    nodeCount: 4,
    colors: ['#6366F1', '#0EA5E9'],
    fonts: ['Cairo'],
    ...sanitizeFigmaTree(sampleDocument().document)
  };
  const artifact = buildLiveArtifact(design);
  assert.equal(artifact.provider, 'figma-live-artifact');
  assert.equal(artifact.safe, true);
  assert.equal(artifact.scriptFree, true);
  assert.equal(artifact.html.includes('<script'), false);
  assert.equal(artifact.html.includes('<img'), false);
  // كل النصوص العدائية معقّمة: تظهر كنص فقط داخل سياق &lt;...&gt;، لا كعناصر/سمات قابلة للتنفيذ.
  assert.match(artifact.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(/<[a-z]+[^>]*\sonerror=/i.test(artifact.html), false);
  assert.equal(artifact.html.includes('http://'), false);
  assert.equal(artifact.html.includes('https://'), false);
  assert.equal(artifact.html.includes(TOKEN), false);
  assert.match(artifact.html, /&lt;script&gt;/);
  assert.match(artifact.css, /\.celia-figma-artifact/);
  assert.match(artifact.html, /<details class="cf-card"/);
  assert.equal(artifact.colors.length >= 2, true);
  assert.equal(escapeHtml(`<a href="x">'`), '&lt;a href=&quot;x&quot;&gt;&#39;');
});

test('T4-08 buildLiveArtifact works with an empty/minimal design without throwing', () => {
  const artifact = buildLiveArtifact({ name: '', colors: [], fonts: [], tree: null, nodeCount: 0 });
  assert.match(artifact.html, /cf-empty/);
  assert.equal(artifact.html.includes('<script>'), false);
  assert.equal(artifact.title.length > 0, true);
});
