/**
 * Criterion 10: the refused set is defined once and the three packages share it. This test
 * reads source rather than behaviour, because that is what the criterion is about — a second
 * list somewhere would pass every other test in the repository while drifting from this one.
 *
 * Test files are not scanned: they spell control characters out by necessity, which is the
 * point of them.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** The workspace's `packages/` directory, whatever the checkout is called. */
const PACKAGES = fileURLToPath(new URL("../..", import.meta.url));

/** The one file allowed to spell the set out. */
const DEFINITION = "shared/src/text.ts";

/**
 * How a set of control characters has to be written: escape sequences, code-point bounds, or
 * a read of a character's code. A second definition needs at least one of them.
 */
const SET_SYNTAX = /\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}|0x[0-9a-fA-F]{2}\b|charCodeAt|codePointAt/;

function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sources(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

test("the refused set is defined once, in @skelcrew/shared, and all three packages use it", () => {
  const files = ["shared", "daemon", "cli"].flatMap((pkg) => sources(join(PACKAGES, pkg, "src")));
  expect(files.length).toBeGreaterThan(20);

  const spelling = files
    .filter((path) => SET_SYNTAX.test(readFileSync(path, "utf8")))
    .map((path) => relative(PACKAGES, path));
  expect(spelling).toEqual([DEFINITION]);

  // And each package reaches the definition through the shared package's exports.
  for (const [path, used] of [
    ["daemon/src/core/core.ts", "findControlCharacter"],
    ["cli/src/main.ts", "escapeControlCharacters"],
    ["daemon/src/runner/run.ts", "escapeControlCharacters"],
  ] as const) {
    const source = readFileSync(join(PACKAGES, path), "utf8");
    expect(source).toContain(used);
    expect(source).toContain('from "@skelcrew/shared"');
  }
});
