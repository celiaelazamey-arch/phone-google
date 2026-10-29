// Operator-only release switch (scripts/deploy-release.mjs). Docker is never touched here: every assertion
// below is about the guards that must fire BEFORE a container is created — the part that protects production.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main, saveState } from '../scripts/deploy-release.mjs';

const digest = 'a'.repeat(64);
const image = `ghcr.io/celiaelazamey-arch/phone-google@sha256:${digest}`;
const token = 't'.repeat(40);

const workspace = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'celia-deploy-'));
  const stateDir = path.join(directory, 'state');
  const envFile = path.join(directory, 'production.env');
  return { directory, stateDir, envFile };
};

async function withOperator(paths, body) {
  const previous = { dir: process.env.CELIA_DEPLOY_STATE_DIR, env: process.env.CELIA_ENV_FILE, project: process.env.CELIA_COMPOSE_PROJECT };
  process.env.CELIA_DEPLOY_STATE_DIR = paths.stateDir;
  process.env.CELIA_ENV_FILE = paths.envFile;
  try {
    return await body();
  } finally {
    for (const [key, value] of [['CELIA_DEPLOY_STATE_DIR', previous.dir], ['CELIA_ENV_FILE', previous.env], ['CELIA_COMPOSE_PROJECT', previous.project]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function productionEnv(paths, { mode = 0o600, body = `CELIA_MCP_DISABLE_MYSQL=false\nCELIA_MCP_API_TOKEN=${token}\n` } = {}) {
  await writeFile(paths.envFile, body, 'utf8');
  await chmod(paths.envFile, mode);
  return paths.envFile;
}

test('deploy-release: an unknown command prints the exact operator usage', async () => {
  await assert.rejects(main(['deploy']), /Usage: npm run deploy:release/);
});

test('deploy-release: an incomplete or unknown option is refused before anything runs', async () => {
  await assert.rejects(main(['switch', '--image']), /Unknown or incomplete CLI option/);
  await assert.rejects(main(['switch', '--image', '--version', '0.2.0']), /Unknown or incomplete CLI option/);
  await assert.rejects(main(['switch', '--force']), /Unknown or incomplete CLI option/);
});

test('deploy-release: status on a clean host reports the empty state and creates nothing', async () => {
  const paths = await workspace();
  const printed = [];
  const original = console.log;
  console.log = (line) => printed.push(String(line));
  try {
    await withOperator(paths, () => main(['status']));
  } finally {
    console.log = original;
  }
  const state = JSON.parse(printed.join('\n'));
  assert.deepEqual(state, { format: 1, active: null, previous: null, history: [] });
  const written = JSON.parse(await readFile(path.join(paths.stateDir, 'state.json'), 'utf8').catch(() => 'null'));
  assert.equal(written, null, 'status is read-only');
});

test('deploy-release: an existing lock blocks a second operator instead of corrupting state', async () => {
  const paths = await workspace();
  await withOperator(paths, async () => {
    // A previous operator process left the lock behind.
    await (await import('node:fs/promises')).mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(paths.stateDir, 'deploy.lock'), JSON.stringify({ pid: 1 }), { mode: 0o600 });
    await assert.rejects(main(['switch', '--image', image, '--version', '0.2.0']), /Deployment locked/);
  });
});

test('deploy-release: the production env file must exist and be operator-only', async () => {
  const paths = await workspace();
  await withOperator(paths, async () => {
    await assert.rejects(main(['switch', '--image', image, '--version', '0.2.0']), /ENOENT|no such file/i);
    await productionEnv(paths, { mode: 0o644 });
    await assert.rejects(main(['switch', '--image', image, '--version', '0.2.0']), /operator-only \(chmod 600\)/);
  });
});

test('deploy-release: an ambiguous or placeholder database mode is refused', async () => {
  const paths = await workspace();
  await withOperator(paths, async () => {
    await productionEnv(paths, { body: `CELIA_MCP_API_TOKEN=${token}\n` });
    await assert.rejects(main(['switch', '--image', image, '--version', '0.2.0']), /Explicit CELIA_MCP_DISABLE_MYSQL=true\|false is required/);

    await productionEnv(paths, { body: `CELIA_MCP_DISABLE_MYSQL=maybe\nCELIA_MCP_API_TOKEN=${token}\n` });
    await assert.rejects(main(['switch', '--image', image, '--version', '0.2.0']), /Explicit CELIA_MCP_DISABLE_MYSQL/);
  });
});

test('deploy-release: a placeholder or short owner token is refused', async () => {
  const paths = await workspace();
  await withOperator(paths, async () => {
    await productionEnv(paths, { body: 'CELIA_MCP_DISABLE_MYSQL=false\nCELIA_MCP_API_TOKEN=replace-with-owner-token\n' });
    await assert.rejects(main(['switch', '--image', image, '--version', '0.2.0']), /non-placeholder CELIA_MCP_API_TOKEN/);

    await productionEnv(paths, { body: 'CELIA_MCP_DISABLE_MYSQL=false\nCELIA_MCP_API_TOKEN=short\n' });
    await assert.rejects(main(['switch', '--image', image, '--version', '0.2.0']), /non-placeholder CELIA_MCP_API_TOKEN/);
  });
});

test('deploy-release: memory mode needs an explicit --allow-memory and never runs silently', async () => {
  const paths = await workspace();
  await withOperator(paths, async () => {
    await productionEnv(paths, { body: `CELIA_MCP_DISABLE_MYSQL=true\nCELIA_MCP_API_TOKEN=${token}\n` });
    await assert.rejects(main(['switch', '--image', image, '--version', '0.2.0']), /Memory-only deployment requires --allow-memory/);
  });
});

test('deploy-release: a compose project name that could escape the namespace is refused', async () => {
  const paths = await workspace();
  await withOperator(paths, async () => {
    await productionEnv(paths);
    const previous = process.env.CELIA_COMPOSE_PROJECT;
    process.env.CELIA_COMPOSE_PROJECT = 'Bad Name; rm -rf /';
    try {
      await assert.rejects(main(['switch', '--image', image, '--version', '0.2.0']), /Invalid compose project name/);
    } finally {
      if (previous === undefined) delete process.env.CELIA_COMPOSE_PROJECT;
      else process.env.CELIA_COMPOSE_PROJECT = previous;
    }
  });
});

test('deploy-release: a target that is not an immutable image@digest is refused', async () => {
  const paths = await workspace();
  await withOperator(paths, async () => {
    await productionEnv(paths);
    await assert.rejects(main(['switch', '--image', 'ghcr.io/owner/repo:latest', '--version', '0.2.0']), /immutable ghcr\.io image@sha256:digest/);
    await assert.rejects(main(['switch', '--image', image, '--version', 'v0.2.0']), /stable SemVer version/);
  });
});

test('deploy-release: state is written atomically with owner-only permissions', async () => {
  const paths = await workspace();
  const file = path.join(paths.directory, 'state.json');
  await saveState(file, { format: 1, active: { image, version: '0.2.0' }, previous: null, history: [] });
  const restored = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(restored.active.image, image);
  const { stat } = await import('node:fs/promises');
  const info = await stat(file);
  assert.equal(info.mode & 0o077, 0, 'the state file must not be group/world readable');
});
