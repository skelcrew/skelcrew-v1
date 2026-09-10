import { expect, test } from "bun:test";
import { allowsTool, FIXED_ALLOWLIST } from "./allowlist";

/** The list, entry by entry: a change to it is a change to what an agent may do unprompted. */
test("the fixed list is read-only tools plus the CLI verbs the playbooks use", () => {
  expect(FIXED_ALLOWLIST).toEqual([
    "Read",
    "Glob",
    "Grep",
    "Bash(skelcrew show *)",
    "Bash(skelcrew comment *)",
    "Bash(skelcrew body *)",
    "Bash(skelcrew attention *)",
    "Bash(git log *)",
    "Bash(git status *)",
    "Bash(git diff *)",
    "Bash(git show *)",
  ]);
});

test("no write, network, or history-editing tool is on the list", () => {
  for (const forbidden of ["Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch"]) {
    expect(FIXED_ALLOWLIST).not.toContain(forbidden);
  }
  for (const entry of FIXED_ALLOWLIST) {
    expect(entry).not.toContain("git commit");
    expect(entry).not.toContain("git push");
    expect(entry).not.toContain("gh ");
  }
});

test("the CLI verbs that move a card past a gate are absent", () => {
  for (const verb of ["mv", "claim", "release", "archive", "resolve"]) {
    expect(FIXED_ALLOWLIST).not.toContain(`Bash(skelcrew ${verb} *)`);
  }
});

// --- what the list matches ---

const bash = (command: string): [string, Record<string, unknown>] => ["Bash", { command }];

test("every entry on the list matches the call it is there for", () => {
  const allowed: Array<[string, Record<string, unknown>]> = [
    ["Read", { file_path: "/repo/AGENTS.md" }],
    ["Glob", { pattern: "**/*.ts" }],
    ["Grep", { pattern: "startRunner" }],
    bash("skelcrew show 1"),
    bash("skelcrew comment 1 'on it'"),
    bash("skelcrew body 1 --file spec.md"),
    bash("skelcrew attention 1 'which base branch?'"),
    bash("git log --oneline -5"),
    bash("git status --porcelain"),
    bash("git diff main"),
    bash("git show HEAD"),
  ];
  for (const [tool, input] of allowed) {
    expect([tool, input, allowsTool(tool, input)]).toEqual([tool, input, true]);
  }
});

/** Each negative in criterion 9, one case each: these are what the narrowing is for. */
test("git push origin HEAD:main is not on the list", () => {
  expect(allowsTool(...bash("git push origin HEAD:main"))).toBe(false);
});

test("git commit -m x is not on the list", () => {
  expect(allowsTool(...bash("git commit -m x"))).toBe(false);
});

test("git -c core.pager=x log is not on the list: an option before the subcommand is arbitrary execution", () => {
  expect(allowsTool(...bash("git -c core.pager=x log"))).toBe(false);
});

test("skelcrew mv 1 code is not on the list", () => {
  expect(allowsTool(...bash("skelcrew mv 1 code"))).toBe(false);
});

test("skelcrew release 1 is not on the list", () => {
  expect(allowsTool(...bash("skelcrew release 1"))).toBe(false);
});

test("gh pr create is not on the list", () => {
  expect(allowsTool(...bash("gh pr create"))).toBe(false);
});

test("Write is not on the list", () => {
  expect(allowsTool("Write", { file_path: "/repo/x.ts", content: "x" })).toBe(false);
});

test("Edit is not on the list", () => {
  expect(allowsTool("Edit", { file_path: "/repo/x.ts" })).toBe(false);
});

test("a wildcard entry matches the whole subcommand it names, not a longer word", () => {
  // `Bash(git log *)` covers `git log` and its arguments: `git logs` is neither.
  expect(allowsTool(...bash("git logs --all"))).toBe(false);
  expect(allowsTool(...bash("skelcrew showcase 1"))).toBe(false);
});

test("a wildcard entry covers the subcommand bare, the way the harness's comparator does", () => {
  // The harness compiles a rule ending in a single ` *` to `^<prefix>( .*)?$` — the
  // arguments are optional — so `Bash(git log *)` covers a bare `git log` there too.
  expect(allowsTool(...bash("git log"))).toBe(true);
  expect(allowsTool(...bash("git status"))).toBe(true);
});

test("a Bash call without a string command is not allowed", () => {
  expect(allowsTool("Bash", {})).toBe(false);
});
