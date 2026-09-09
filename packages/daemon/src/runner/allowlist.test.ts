import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowlistFor, commandsInFences, FIXED_ALLOWLIST } from "./allowlist";

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "ska-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const FIXED = [
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "MultiEdit",
  "Agent",
  "TodoWrite",
  "Bash(skelcrew show *)",
  "Bash(skelcrew comment *)",
  "Bash(skelcrew body *)",
  "Bash(skelcrew refs *)",
  "Bash(skelcrew attention *)",
  "Bash(git status *)",
  "Bash(git log *)",
  "Bash(git diff *)",
  "Bash(git show *)",
  "Bash(git merge-base *)",
  "Bash(git rev-parse *)",
  "Bash(git branch *)",
  "Bash(git add *)",
  "Bash(git commit *)",
  "Bash(git push -u origin HEAD)",
  "Bash(git push)",
  "Bash(gh pr create *)",
  "Bash(gh pr view *)",
  "Bash(gh pr diff *)",
  "Bash(gh pr comment *)",
  "Bash(gh repo view*)",
];

/**
 * What Claude Code pre-allows with these patterns, as it matches them: a Bash rule becomes
 * an anchored regular expression with `*` as `.*`, and a single trailing ` *` as `( .*)?` —
 * so `Bash(gh pr view *)` covers `gh pr view` and `gh pr view 42`, and nothing else that
 * merely starts with those letters. A rule with no `*` matches that command exactly.
 * (`Bash(x:*)` is the legacy prefix form; these entries use the wildcard form.)
 */
function preAllows(command: string): boolean {
  return FIXED_ALLOWLIST.some((entry) => {
    const match = /^Bash\((.*)\)$/.exec(entry);
    if (match === null) return false;
    const pattern = match[1] as string;
    const stars = (pattern.match(/\*/g) ?? []).length;
    let source = pattern.replace(/[.+?^${}()|[\]\\'"]/g, "\\$&").replaceAll("*", ".*");
    if (stars === 1 && source.endsWith(" .*")) source = `${source.slice(0, -3)}( .*)?`;
    return new RegExp(`^${source}$`, "s").test(command);
  });
}

test("the fixed entries: the playbooks' CLI verbs only, so mv, release, claim, archive, and resolve ask", () => {
  expect([...FIXED_ALLOWLIST]).toEqual(FIXED);
  expect(FIXED_ALLOWLIST).not.toContain("Bash(skelcrew *)");
  for (const verb of ["mv", "release", "claim", "archive", "resolve"]) {
    expect(FIXED_ALLOWLIST.some((entry) => entry.includes(`skelcrew ${verb}`))).toBe(false);
  }
});

test("git is named verb by verb: no wildcard before the subcommand, and only the playbook's push", () => {
  expect(FIXED_ALLOWLIST).not.toContain("Bash(git *)");
  expect(preAllows("git status")).toBe(true);
  expect(preAllows("git status --short")).toBe(true);
  expect(preAllows('git commit -m "spec 007: the runner runs the playbooks"')).toBe(true);
  expect(preAllows("git diff main...HEAD")).toBe(true);
  expect(preAllows("git push -u origin HEAD")).toBe(true);
  // Landing work on the default branch, rewriting a remote, and running arbitrary code
  // through git's own options are the ones that have to ask.
  expect(preAllows("git push origin HEAD:main")).toBe(false);
  expect(preAllows("git push --force")).toBe(false);
  expect(preAllows("git -c foo=bar log")).toBe(false);
});

test("the PR verbs are named one by one, so `gh pr merge` and `gh pr close` ask", () => {
  expect(FIXED_ALLOWLIST).not.toContain("Bash(gh pr *)");
  expect(preAllows("gh pr create --fill")).toBe(true);
  expect(preAllows("gh pr view 42 --json state")).toBe(true);
  expect(preAllows("gh pr merge 42 --squash")).toBe(false);
  expect(preAllows("gh pr close 42")).toBe(false);
});

test("a repo with neither AGENTS.md nor CLAUDE.md gets only the fixed entries", () => {
  expect(allowlistFor(repo)).toEqual(FIXED);
});

test("a fenced block starting with `bun run check` in AGENTS.md adds Bash(bun *)", () => {
  writeFileSync(
    join(repo, "AGENTS.md"),
    "# Repo\n\n## Definition of done\n\n```\nbun run check\n```\n\nwhich runs lint and tests.\n",
  );
  expect(allowlistFor(repo)).toEqual([...FIXED, "Bash(bun *)"]);
});

test("CLAUDE.md is scanned too, and a command the fixed list narrows is not widened back", () => {
  writeFileSync(join(repo, "CLAUDE.md"), "```sh\nnpm test\n```\n\n```bash\ngit status\n```\n");
  // `Bash(git *)` from a target repo's own instructions would undo the narrowing above.
  expect(allowlistFor(repo)).toEqual([...FIXED, "Bash(npm *)"]);
});

test("both files are read; a CLAUDE.md that links to AGENTS.md adds nothing twice", () => {
  writeFileSync(join(repo, "AGENTS.md"), "```\nbun run check\n```\n");
  symlinkSync("AGENTS.md", join(repo, "CLAUDE.md"));
  expect(allowlistFor(repo)).toEqual([...FIXED, "Bash(bun *)"]);
});

test("only the first line of each shell block counts; other languages are skipped", () => {
  const markdown = [
    "```",
    "make check",
    "make lint",
    "```",
    "```ts",
    "cargo.run()",
    "```",
    "```console",
    "$ cargo test",
    "```",
    "~~~shell",
    "  pytest -q",
    "~~~",
    "```json",
    '{ "npm": true }',
    "```",
  ].join("\n");
  expect(commandsInFences(markdown)).toEqual(["make", "cargo", "pytest"]);
});

test("a block that opens and never closes, an empty block, and a non-command first line add nothing", () => {
  expect(commandsInFences("```\n\n```\n\n```\n# just a comment\n```\n\n```\n")).toEqual([]);
});
