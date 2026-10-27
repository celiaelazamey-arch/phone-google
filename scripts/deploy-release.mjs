#!/usr/bin/env node
/** Operator-only CLI. Never exposed as an HTTP endpoint; no shell interpolation. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import crypto from "node:crypto";
import dotenv from "dotenv";
import {
  emptyDeploymentState,
  recoverDeployment,
  transitionRelease,
  validateTarget,
} from "../src/deployment.js";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE = path.join(ROOT, "compose.release.yml");

export async function saveState(file, state) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readState(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return emptyDeploymentState();
    throw new Error("Invalid deployment state; restore an operator backup");
  }
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!["status", "switch", "rollback", "recover"].includes(command))
    throw new Error(
      "Usage: npm run deploy:release -- status|switch --image ghcr.io/owner/repo@sha256:… --version 0.2.0|rollback|recover [--allow-memory]",
    );
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--allow-memory") {
      options.allowMemory = true;
      continue;
    }
    if (
      !["--image", "--version"].includes(args[i]) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      throw new Error("Unknown or incomplete CLI option");
    options[args[i].slice(2)] = args[++i];
  }
  const directory = path.resolve(
    process.env.CELIA_DEPLOY_STATE_DIR || path.join(ROOT, ".celia-deploy"),
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "state.json");
  if (command === "status") {
    console.log(JSON.stringify(await readState(file), null, 2));
    return;
  }
  const lockFile = path.join(directory, "deploy.lock");
  let lock;
  try {
    lock = await open(lockFile, "wx", 0o600);
  } catch {
    throw new Error(
      "Deployment locked. If the operator process died, verify no deploy is running before removing deploy.lock and using recover.",
    );
  }
  let candidate;
  let adapter;
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    const state = await readState(file);
    const target =
      command === "rollback"
        ? state.previous
        : { image: options.image, version: options.version };
    if (command !== "recover") validateTarget(target);
    const envFile = path.resolve(
      process.env.CELIA_ENV_FILE || path.join(ROOT, ".env.production"),
    );
    const info = await stat(envFile);
    if (
      !info.isFile() ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    )
      throw new Error("Production env file must be operator-only (chmod 600)");
    const env = dotenv.parse(await readFile(envFile));
    if (!["true", "false"].includes(env.CELIA_MCP_DISABLE_MYSQL))
      throw new Error(
        "Explicit CELIA_MCP_DISABLE_MYSQL=true|false is required in the production env file",
      );
    if (
      !env.CELIA_MCP_API_TOKEN ||
      env.CELIA_MCP_API_TOKEN.length < 32 ||
      env.CELIA_MCP_API_TOKEN.startsWith("replace-with-")
    )
      throw new Error(
        "Configure a non-placeholder CELIA_MCP_API_TOKEN in the production env file",
      );
    if (env.CELIA_MCP_DISABLE_MYSQL === "true" && !options.allowMemory)
      throw new Error(
        "Memory-only deployment requires --allow-memory and is not durable",
      );
    const project = process.env.CELIA_COMPOSE_PROJECT || "celia-production";
    if (!/^[a-z0-9][a-z0-9_-]{0,50}$/.test(project))
      throw new Error("Invalid compose project name");
    const network = process.env.CELIA_DOCKER_NETWORK || "bridge";
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(network))
      throw new Error("Invalid Docker network name");
    const docker = async (parameters, extraEnv = {}) => {
      try {
        const result = await run("docker", parameters, {
          cwd: ROOT,
          env: { ...process.env, ...extraEnv },
          timeout: 180000,
          maxBuffer: 2 * 1024 * 1024,
        });
        return result.stdout.trim();
      } catch {
        // docker errors can include environment paths or application logs; do not dump them.
        throw new Error(`Docker operation failed: ${parameters[0]}`);
      }
    };
    const compose = (image, parameters) =>
      docker(
        [
          "compose",
          "--project-name",
          project,
          "--file",
          COMPOSE,
          ...parameters,
        ],
        {
          CELIA_IMAGE: image,
          CELIA_ENV_FILE: envFile,
          CELIA_DOCKER_NETWORK: network,
        },
      );
    const probeContainer = async (id) => {
      const code =
        "fetch('http://127.0.0.1:3010/readyz',{signal:AbortSignal.timeout(4000)}).then(async r=>{const j=await r.json();if(!r.ok)process.exit(1);console.log(JSON.stringify(j))}).catch(()=>process.exit(1))";
      const deadline = Date.now() + 45000;
      do {
        try {
          return JSON.parse(await docker(["exec", id, "node", "-e", code]));
        } catch {
          if (Date.now() >= deadline)
            throw new Error("Release readiness did not pass within 45 seconds");
          await delay(750);
        }
      } while (true);
    };
    const existingImage =
      state.active?.image || target?.image || state.pending?.target.image;
    const existing = await compose(existingImage, [
      "ps",
      "--all",
      "--quiet",
      "celia",
    ]);
    if (!state.pending && existing) {
      const actual = await docker([
        "inspect",
        "--format",
        "{{.Config.Image}}",
        existing,
      ]);
      if (!state.active || actual !== state.active.image)
        throw new Error(
          "Running container differs from managed state; refusing to overwrite an unmanaged deployment",
        );
    } else if (!state.pending && state.active && !existing) {
      throw new Error(
        "Managed container is missing; reconcile the deployment before switching",
      );
    }
    adapter = {
      stage: async (release) => {
        await docker(["pull", release.image]);
        candidate = `${project}-candidate-${crypto.randomBytes(5).toString("hex")}`;
        await docker([
          "run",
          "--detach",
          "--name",
          candidate,
          "--network",
          network,
          "--init",
          "--read-only",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,size=16m",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges:true",
          "--env-file",
          envFile,
          "-e",
          "NODE_ENV=production",
          "-e",
          "CELIA_MCP_HOST=0.0.0.0",
          "-e",
          "CELIA_MCP_PORT=3010",
          "-e",
          "PORT=3010",
          release.image,
        ]);
        return probeContainer(candidate);
      },
      activate: async (release) => {
        await compose(release.image, [
          "up",
          "--detach",
          "--no-deps",
          "--force-recreate",
          "--pull",
          "never",
          "celia",
        ]);
      },
      probeActive: async () => {
        const id = await compose(existingImage, ["ps", "--quiet", "celia"]);
        if (!id) throw new Error("Active container missing");
        return probeContainer(id);
      },
      deactivate: async () => {
        await compose(existingImage, ["rm", "--stop", "--force", "celia"]);
      },
      discard: async () => {
        if (candidate) {
          await docker(["rm", "--force", candidate]);
          candidate = null;
        }
      },
      save: (next) => saveState(file, next),
    };
    const result =
      command === "recover"
        ? await recoverDeployment({
            state,
            adapter,
            requireDurable: !options.allowMemory,
          })
        : await transitionRelease({
            state,
            target,
            adapter,
            requireDurable: !options.allowMemory,
          });
    console.log(
      JSON.stringify(
        {
          status: "healthy",
          active: result.active,
          previous: result.previous,
          stateFile: file,
        },
        null,
        2,
      ),
    );
  } finally {
    await lock.close();
    await rm(lockFile, { force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
