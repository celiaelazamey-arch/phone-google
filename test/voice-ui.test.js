import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const appJs = read('public/app.js');
const indexHtml = read('public/index.html');
const stylesCss = read('public/styles.css');
const mcpJs = read('src/celia-mcp.js');

test('T3-01 both voice surfaces exist: chat button and outbound WhatsApp bubble button', () => {
  assert.match(appJs, /async function playCeliaVoice\(/);
  assert.match(appJs, /🔊 استماع بصوت سيليا/);
  assert.match(appJs, /className = 'voice-speak-btn'/);
  assert.match(appJs, /className = 'wa-voice-btn'/);
  assert.match(appJs, /direction === 'outbound'/);
  assert.match(stylesCss, /\.voice-speak-btn\s*\{/);
  assert.match(stylesCss, /\.wa-voice-btn\s*\{/);
});

test('T3-02 the browser never holds an ElevenLabs secret and uses the free ar-EG fallback', () => {
  assert.equal(appJs.includes('ELEVENLABS_API_KEY'), false);
  assert.equal(appJs.includes('xi-api-key'), false);
  assert.equal(appJs.includes('CELIA_VOICE_ID'), false);
  assert.match(appJs, /celia_voice_speak/);
  assert.match(appJs, /web-speech-ar-EG/);
  assert.match(appJs, /utterance\.lang = 'ar-EG'/);
  assert.match(appJs, /celia_voice_quota/);
});

test('T3-03 the audio data URL is allowed by CSP and tool counts match the 13 registered tools', () => {
  assert.match(mcpJs, /'media-src':\s*\[[^\]]*'data:'/);
  assert.match(indexHtml, /id="nav-tools-count">15</);
  assert.match(indexHtml, /data-cat="all">الكل \(15\)/);
  assert.match(indexHtml, /data-cat="ai">الذكاء والصوت وFigma \(7\)/);
  assert.match(indexHtml, /data-cat="whatsapp">واتساب للأعمال \(3\)/);
  assert.match(indexHtml, /data-cat="google">خدمات Google \(5\)/);
  assert.match(appJs, /case 'celia_voice_speak':/);
  assert.match(appJs, /case 'celia_voice_quota':/);
});

test('T3-04 the voice button is attached to every finished agent reply, not only one hardcoded view', () => {
  const finishBody = appJs.slice(appJs.indexOf('function finish({'), appJs.indexOf('return { addStep, finish };'));
  assert.match(finishBody, /voiceBtn/);
  assert.match(finishBody, /playCeliaVoice\(prose\)/);
  assert.match(finishBody, /agentDiv\.appendChild\(voiceBtn\)/);
});
