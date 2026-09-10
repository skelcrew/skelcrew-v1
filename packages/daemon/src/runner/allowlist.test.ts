import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowlistFor, allowsTool, FIXED_ALLOWLIST } from "./allowlist";

/** The list, entry by entry: a change to it is a change to what an agent may do unprompted. */
test("the fixed list is exactly what the spec names, in its order", () => {
  expect(FIXED_ALLOWLIST).toEqual([
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
    "Bash(gh repo view *)",
  ]);
});

/**
 * The literal assertion the spec's *Tests* section asks for beside the behavioural one: a
 * wildcard before the subcommand re-added to the list fails here even if the model below is
 * imperfect, because such an entry pre-allows `git -c <anything> log` and `gh pr merge`.
 */
test("no entry puts a wildcard before the subcommand", () => {
  for (const entry of FIXED_ALLOWLIST) {
    expect(entry).not.toBe("Bash(git *)");
    expect(entry).not.toBe("Bash(gh *)");
    expect(entry).not.toBe("Bash(gh pr *)");
    expect(entry).not.toBe("Bash(skelcrew *)");
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
    ["Edit", { file_path: "/repo/x.ts" }],
    ["Write", { file_path: "/repo/x.ts", content: "x" }],
    ["MultiEdit", { file_path: "/repo/x.ts" }],
    ["Agent", { description: "review" }],
    ["TodoWrite", { todos: [] }],
    bash("skelcrew show 1"),
    bash("skelcrew comment 1 'on it'"),
    bash("skelcrew body 1 --file spec.md"),
    bash("skelcrew refs 1 --pr https://example.invalid/pr/1"),
    bash("skelcrew attention 1 'which base branch?'"),
    bash("git status --porcelain"),
    bash("git log --oneline -5"),
    bash("git diff main"),
    bash("git show HEAD"),
    bash("git merge-base main HEAD"),
    bash("git rev-parse refs/heads/main"),
    bash("git branch --show-current"),
    bash("git add -A"),
    bash("git commit -m 'work'"),
    bash("git push -u origin HEAD"),
    bash("git push"),
    bash("gh pr create --fill"),
    bash("gh pr view 42"),
    bash("gh pr diff 42"),
    bash("gh pr comment 42 -b 'ready'"),
    bash("gh repo view --json name"),
  ];
  for (const [tool, input] of allowed) {
    expect([tool, input, allowsTool(tool, input)]).toEqual([tool, input, true]);
  }
  // One call per entry, so an entry cannot be dropped without a case here failing.
  expect(allowed).toHaveLength(FIXED_ALLOWLIST.length);
});

/** Each negative in criterion 8, one case each: these are what the narrowing is for. */
test("git push origin HEAD:main is not on the list", () => {
  expect(allowsTool(...bash("git push origin HEAD:main"))).toBe(false);
});

test("git push --force is not on the list", () => {
  expect(allowsTool(...bash("git push --force"))).toBe(false);
});

test("git -c core.pager=x log is not on the list: an option before the subcommand is arbitrary execution", () => {
  expect(allowsTool(...bash("git -c core.pager=x log"))).toBe(false);
});

test("gh pr merge 42 --squash is not on the list: merging is the owner's alone", () => {
  expect(allowsTool(...bash("gh pr merge 42 --squash"))).toBe(false);
});

test("gh pr close 42 is not on the list", () => {
  expect(allowsTool(...bash("gh pr close 42"))).toBe(false);
});

test("skelcrew mv 1 code is not on the list", () => {
  expect(allowsTool(...bash("skelcrew mv 1 code"))).toBe(false);
});

test("skelcrew release 1 is not on the list", () => {
  expect(allowsTool(...bash("skelcrew release 1"))).toBe(false);
});

test("skelcrew claim 1 is not on the list", () => {
  expect(allowsTool(...bash("skelcrew claim 1"))).toBe(false);
});

test("skelcrew archive 1 is not on the list", () => {
  expect(allowsTool(...bash("skelcrew archive 1"))).toBe(false);
});

test("skelcrew resolve 1 -m allow is not on the list: an agent may not answer its own question", () => {
  expect(allowsTool(...bash("skelcrew resolve 1 -m allow"))).toBe(false);
});

test("a wildcard entry matches the whole subcommand it names, not a longer word", () => {
  // `Bash(git log *)` covers `git log` and its arguments: `git logs` is neither.
  expect(allowsTool(...bash("git logs --all"))).toBe(false);
  expect(allowsTool(...bash("skelcrew showcase 1"))).toBe(false);
  // Every entry has the space before the `*`, including this one: `Bash(gh repo view*)`
  // would compile to `^gh repo view.*$`, a prefix with no separator.
  expect(allowsTool(...bash("gh repo viewer --json name"))).toBe(false);
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

// --- the scan of the target repository's own instructions ---

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "skr-allow-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function write(name: string, text: string): void {
  writeFileSync(join(repo, name), text);
}

/** What the scan added, in order: everything past the fixed list. */
function scanned(): string[] {
  return allowlistFor(repo).slice(FIXED_ALLOWLIST.length);
}

test("a repository with neither instruction file yields exactly the fixed list", () => {
  expect(allowlistFor(repo)).toEqual([...FIXED_ALLOWLIST]);
});

test("a check command in a fenced block in AGENTS.md is pre-allowed", () => {
  write("AGENTS.md", "# Repo\n\nRun this:\n\n```\nbun run check\n```\n");
  expect(scanned()).toEqual(["Bash(bun run check *)"]);
  // The repository's own check command runs unprompted; the fixed list alone would ask.
  expect(allowsTool("Bash", { command: "bun run check" }, allowlistFor(repo))).toBe(true);
  expect(allowsTool(...bash("bun run check"))).toBe(false);
});

test("the scan grants the line it found, not its first word: `bun -e` still asks", () => {
  write("AGENTS.md", "```\nbun run check\n```\n");
  expect(allowlistFor(repo)).not.toContain("Bash(bun *)");
  // `Bash(bun *)` would pre-allow arbitrary execution from a file the target repo controls.
  expect(allowsTool("Bash", { command: "bun -e 'console.log(1)'" }, allowlistFor(repo))).toBe(
    false,
  );
  expect(allowsTool("Bash", { command: "bun run checkout" }, allowlistFor(repo))).toBe(false);
});

test("CLAUDE.md is scanned too, and a shell info string and a leading $ are read", () => {
  write("CLAUDE.md", "```bash\n$ make test\n```\n\n```console\npnpm lint\n```\n");
  expect(scanned()).toEqual(["Bash(make test *)", "Bash(pnpm lint *)"]);
});

test("both instruction files contribute, once each", () => {
  write("AGENTS.md", "```sh\nbun run check\n```\n");
  write("CLAUDE.md", "```\nbun run check\n```\n\n```zsh\ncargo test\n```\n");
  expect(scanned()).toEqual(["Bash(bun run check *)", "Bash(cargo test *)"]);
});

test("a fenced block in another language contributes nothing", () => {
  write("AGENTS.md", "```ts\nbun.spawn(['rm', '-rf', '/'])\n```\n\n```json\n{}\n```\n");
  expect(scanned()).toEqual([]);
});

test("a fence that is never closed contributes nothing", () => {
  write("AGENTS.md", "```\nbun run check\n\nand then some prose that never closes the block\n");
  expect(scanned()).toEqual([]);
});

/**
 * Each narrowed command with a scannable one beside it, so the case tells "the scan refused
 * to widen this" apart from "the scan did nothing at all".
 */
test("a scanned command may not widen git, which the fixed list narrows verb by verb", () => {
  write("AGENTS.md", "```\ngit status\n```\n\n```\nbun run check\n```\n");
  expect(scanned()).toEqual(["Bash(bun run check *)"]);
  expect(allowlistFor(repo)).not.toContain("Bash(git *)");
  expect(allowsTool("Bash", { command: "git -c core.pager=x log" }, allowlistFor(repo))).toBe(
    false,
  );
});

/**
 * The rule reads the line's first word, so a documented `git` line contributes nothing
 * whatever follows it — including the push forms the fixed list is careful to leave off.
 */
test("a scanned git line the fixed list does not cover is dropped whole, not granted", () => {
  write("AGENTS.md", "```\ngit push --force\n```\n\n```\ngit status && rm -rf /\n```\n");
  expect(scanned()).toEqual([]);
  expect(allowsTool("Bash", { command: "git push --force" }, allowlistFor(repo))).toBe(false);
});

test("a scanned command may not widen gh", () => {
  write("AGENTS.md", "```\ngh pr view\n```\n\n```\nbun run check\n```\n");
  expect(scanned()).toEqual(["Bash(bun run check *)"]);
  expect(allowlistFor(repo)).not.toContain("Bash(gh *)");
  expect(allowsTool("Bash", { command: "gh pr merge 42" }, allowlistFor(repo))).toBe(false);
});

test("a scanned command may not widen skelcrew", () => {
  write("CLAUDE.md", "```\nskelcrew show 1\n```\n\n```\nbun run check\n```\n");
  expect(scanned()).toEqual(["Bash(bun run check *)"]);
  expect(allowlistFor(repo)).not.toContain("Bash(skelcrew *)");
  expect(allowsTool("Bash", { command: "skelcrew mv 1 code" }, allowlistFor(repo))).toBe(false);
});

/**
 * Criterion 10a. The harness compiles `*` in a rule to `.*`, so a metacharacter surviving
 * into an entry is a wildcard the *repository* chose: `Bash(bun * *)` matches
 * `bun -e '<any code>'` there — verified against the shipped binary's own matcher — which the
 * model in `allowsTool`, a literal prefix comparison, cannot see. The assertion that carries
 * this case is therefore on the entries, with the behavioural one beside it.
 */
test("a fenced line with a wildcard in it contributes nothing: `bun *` does not pre-allow `bun -e`", () => {
  write("AGENTS.md", "```\nbun *\n```\n\n```\nbun run check\n```\n");
  expect(scanned()).toEqual(["Bash(bun run check *)"]);
  expect(allowlistFor(repo)).not.toContain("Bash(bun * *)");
  expect(allowsTool("Bash", { command: "bun -e 'console.log(1)'" }, allowlistFor(repo))).toBe(
    false,
  );
});

test("a fenced line containing ?, [ or an escaped * contributes nothing either", () => {
  write(
    "AGENTS.md",
    "```\nmake -f ?.mk all\n```\n\n```\nbun test [a-z]\n```\n\n```\nbun \\* x\n```\n",
  );
  expect(scanned()).toEqual([]);
});

test("a first word that is not a command word contributes nothing", () => {
  write("AGENTS.md", "```\n* not a command\n```\n\n```\n\n```\n\n```\nbun run check\n```\n");
  expect(scanned()).toEqual(["Bash(bun run check *)"]);
});
