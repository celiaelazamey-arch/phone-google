import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUnreleased, unreleasedProgress, UNRELEASED_LIMITS } from "../src/progress.js";

const FIXTURE = `# Changelog

## Unreleased

### Added
- one
- two

### Fixed
* three

### Weird
- four

### Limits
- five

## 0.2.1 — Free Launch Runtime — 2026-10-27

### Added
- already released, must not be counted
`;

test("PRG-01: parseUnreleased counts only the Unreleased block and keeps closed section names (limits included)", () => {
  const parsed = parseUnreleased(FIXTURE);
  assert.equal(parsed.parsed, true);
  assert.equal(parsed.items, 5);
  assert.deepEqual(parsed.sections, {
    added: 2,
    changed: 0,
    fixed: 1,
    removed: 0,
    security: 0,
    deprecated: 0,
    limits: 1,
  });
  assert.equal(parsed.unknownSections, 1);
});

test("PRG-02: a changelog without Unreleased is a real zero, not a parse failure", () => {
  const parsed = parseUnreleased("# Changelog\n\n## 0.2.1\n- shipped\n");
  assert.equal(parsed.parsed, true);
  assert.equal(parsed.items, 0);
  assert.equal(parsed.unknownSections, 0);
});

test("PRG-03: unreadable input fails closed and never invents a count", () => {
  for (const bad of [null, undefined, 42, {}, "", "   "]) {
    const parsed = parseUnreleased(bad);
    assert.equal(parsed.parsed, false);
    assert.equal(parsed.items, 0);
  }
});

test("PRG-04: Unreleased at the end of the file, or above another version, is bounded correctly", () => {
  const tail = parseUnreleased("## 0.1.0\n### Added\n- old\n\n## Unreleased\n### Security\n- newer\n");
  assert.equal(tail.items, 1);
  assert.equal(tail.sections.security, 1);
  const last = parseUnreleased("## Unreleased\n### Changed\n- only\n");
  assert.equal(last.items, 1);
  assert.equal(last.sections.changed, 1);
});

test("PRG-05: item counting is capped so a hostile file cannot spin the request", () => {
  const body = Array.from({ length: UNRELEASED_LIMITS.MAX_ITEMS + 25 }, (_, i) => `- item ${i}`).join("\n");
  const parsed = parseUnreleased(`## Unreleased\n### Added\n${body}\n`);
  assert.equal(parsed.items, UNRELEASED_LIMITS.MAX_ITEMS);
  assert.equal(parsed.sections.added, UNRELEASED_LIMITS.MAX_ITEMS);
});

test("PRG-06: missing or oversized files degrade to parsed=false with a named reason", async () => {
  const dir = await mkdtemp(join(tmpdir(), "celia-progress-"));
  const missing = unreleasedProgress({ file: join(dir, "absent.md"), fresh: true });
  assert.equal(missing.parsed, false);
  assert.equal(missing.reason, "changelog_unavailable");
  assert.equal(missing.items, 0);

  const huge = join(dir, "huge.md");
  await writeFile(huge, "x".repeat(UNRELEASED_LIMITS.MAX_BYTES + 1));
  const oversized = unreleasedProgress({ file: huge, fresh: true });
  assert.equal(oversized.parsed, false);
  assert.equal(oversized.reason, "changelog_too_large");
  assert.equal(oversized.items, 0);
});

test("PRG-07: the real CHANGELOG.md is the progress signal the page renders", () => {
  const real = unreleasedProgress({ fresh: true });
  assert.equal(real.parsed, true, "the shipped CHANGELOG must be readable");
  assert.ok(real.items > 0, "the repository carries undocumented-in-release work");
  const summed = Object.values(real.sections).reduce((a, b) => a + b, 0);
  assert.ok(summed <= real.items);
  assert.ok(Number.isInteger(real.unknownSections) && real.unknownSections >= 0);
});
