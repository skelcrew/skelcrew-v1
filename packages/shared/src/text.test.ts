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
 * And the one file allowed to spell a few characters of it for the other reason there is: the
 * board drives a terminal, so it writes escape sequences rather than escaping them (026), and
 * it reads the bytes raw mode sends for the keys it has. It is not a second definition of the
 * set, which is what the exact list below checks — everything the screen draws is still escaped
 * through `render.ts` before the sequences are added.
 */
const TERMINAL = "cli/src/board/ansi.ts";
/**
 * The escape character, the byte raw mode sends for ctrl-c, and the two it sends for Backspace
 * (027's one text input takes both), as that file writes them.
 */
const INTERRUPT_SPELLING = "\\x03";
const ESCAPE_SPELLING = "\\x1b";
const BACKSPACE_SPELLINGS = ["\\x08", "\\x7f"];

/**
 * How a set of control characters gets written: escape sequences, a Unicode property class,
 * code-point bounds, or a read of a character's code. This is a tripwire for the common
 * spellings, not a proof — a determined second definition could be written some other way —
 * and it is the cheapest check that keeps the obvious ones from landing unnoticed.
 */
const SET_SYNTAX =
  /\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}|\\u\{|\\p\{C|0x[0-9a-fA-F]{2}\b|charCodeAt|codePointAt|fromCharCode/;

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
  expect(spelling).toEqual([DEFINITION, TERMINAL]);

  // What the screen may name: the escape character, and the bytes raw mode sends for the keys.
  const terminal = readFileSync(join(PACKAGES, TERMINAL), "utf8");
  const spelled = [...terminal.matchAll(new RegExp(SET_SYNTAX.source, "g"))].map((m) => m[0]);
  expect([...new Set(spelled)].sort()).toEqual(
    [INTERRUPT_SPELLING, ESCAPE_SPELLING, ...BACKSPACE_SPELLINGS].sort(),
  );

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
