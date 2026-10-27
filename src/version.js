import { readFileSync } from "node:fs";

const readJson = (relative) =>
  JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));
const manifest = readJson("../releases/current.json");
const pkg = readJson("../package.json");
if (manifest.version !== pkg.version)
  throw new Error("Release manifest and package version must match");
if (!/^\d+\.\d+\.\d+$/.test(manifest.version))
  throw new Error("Release version must be stable SemVer");

export const RELEASE = Object.freeze({
  ...manifest,
  database: Object.freeze(manifest.database),
  rollback: Object.freeze(manifest.rollback),
});
export const RELEASE_HISTORY = Object.freeze(
  readJson("../releases/history.json"),
);
export const SERVER_INFO = Object.freeze({
  name: "celia-phone-google-mcp",
  version: RELEASE.version,
});

export function releaseInfo(env = process.env) {
  const candidate = [env.CELIA_BUILD_SHA, env.RENDER_GIT_COMMIT, env.GITHUB_SHA].find((value) => /^[a-f0-9]{40}$/i.test(value || "")) || "";
  return {
    ...RELEASE,
    commit: /^[a-f0-9]{40}$/i.test(candidate) ? candidate.toLowerCase() : null,
  };
}
