/**
 * Creates a local .env with cryptographically random secrets.
 * Nothing is printed to the console, nothing is committed: .env is gitignored.
 * Usage: npm run setup [-- --force]
 */
import crypto from 'node:crypto';
import { chmod, copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const examplePath = `${root}.env.example`;
const envPath = `${root}.env`;

const exists = async (path) => {
  try { await stat(path); return true; } catch { return false; }
};

if (await exists(envPath) && !process.argv.includes('--force')) {
  console.log('.env already exists — leaving it untouched. Use `npm run setup -- --force` to regenerate (a backup is kept).');
  process.exit(0);
}
if (await exists(envPath)) {
  const backup = `${root}.env.backup.${Date.now()}`;
  await copyFile(envPath, backup);
  console.log(`Existing .env backed up to ${backup}`);
}

const random = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const replacements = new Map([
  ['APP_API_TOKEN', random(36)],
  ['TOKEN_ENCRYPTION_KEY', crypto.randomBytes(32).toString('base64')],
  ['WHATSAPP_VERIFY_TOKEN', random(24)]
]);

const template = await readFile(examplePath, 'utf8');
const lines = template.split('\n').map((line) => {
  const match = /^([A-Z0-9_]+)=/.exec(line);
  return match && replacements.has(match[1]) ? `${match[1]}=${replacements.get(match[1])}` : line;
});
await writeFile(envPath, lines.join('\n'), { mode: 0o600 });
await chmod(envPath, 0o600);

console.log('Created .env (mode 0600) with 3 freshly generated random secrets.');
console.log('Still required from YOU (never share them in chat or commit them):');
console.log('  MYSQL_PASSWORD, MYSQL_ROOT_PASSWORD, GOOGLE_CLIENT_ID/SECRET,');
console.log('  WHATSAPP_APP_SECRET / ACCESS_TOKEN / PHONE_NUMBER_ID, GEMINI_API_KEY.');
console.log('Then: docker compose up -d mysql && npm run db:init && npm test && npm start');
