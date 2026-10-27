#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = ["playwright.config.js"];
for (const directory of ["src", "test", "public", "scripts", "e2e"]) {
  for (const entry of await readdir(path.join(root, directory), {
    withFileTypes: true,
  })) {
    if (entry.isFile() && /\.(m?js)$/.test(entry.name))
      files.push(path.join(directory, entry.name));
  }
}
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error(
      result.stderr || result.error?.message || `Syntax check failed: ${file}`,
    );
    process.exit(1);
  }
}
console.log(`Syntax verified: ${files.length} JavaScript files.`);
