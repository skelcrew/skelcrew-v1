import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowlistFor, allowsTool, deniedTools, editsIn, FIXED_ALLOWLIST } from "./allowlist";
import { createGit, type Git } from "./git";

/** The list, entry by entry: a change to it is a change to what an agent may do unprompted. */
test("the fixed list is exactly what the spec names, in its order", () => {
  expect(FIXED_ALLOWLIST).toEqual([
    "Read",
    "Glob",
    "Grep",
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

/**
 * The file tools carry no entry of their own: a bare `Write` reaches every path the daemon's
 * user can write, the git common directory included, and no choice of scan base survives
 * that. What a run gets instead is one anchored `Edit(…)` entry, which the harness reads as
 * covering Edit, Write and MultiEdit — a path rule spelled for any of those three is accepted
 * and never consulted.
 */
test("no file tool is on the fixed list bare", () => {
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
    expect(FIXED_ALLOWLIST).not.toContain(tool);
  }
});

test("a run's file-tool entry is one Edit rule anchored at its own worktree", () => {
  expect(editsIn("/data/skelcrew/worktrees/7")).toBe("Edit(//data/skelcrew/worktrees/7/**)");
  expect(deniedTools("/data/skelcrew/worktrees/7")).toEqual([
    "Edit(//data/skelcrew/worktrees/7/.git)",
    "Edit(//data/skelcrew/worktrees/7/.git/**)",
  ]);
});

// --- what the file-tool entry reaches, and what it does not ---

const WT = "/data/skelcrew/worktrees/7";
const anchored: string[] = [...FIXED_ALLOWLIST, editsIn(WT)];
const denied: string[] = deniedTools(WT);
const writes = (path: string): boolean =>
  allowsTool("Write", { file_path: path, content: "x" }, anchored, denied);

test("a write inside the run's worktree is pre-allowed, whichever file tool makes it", () => {
  expect(writes(`${WT}/src/x.ts`)).toBe(true);
  expect(writes(`${WT}/AGENTS.md`)).toBe(true);
  expect(allowsTool("Edit", { file_path: `${WT}/a/b/c.ts` }, anchored, denied)).toBe(true);
  expect(allowsTool("MultiEdit", { file_path: `${WT}/a/b/c.ts` }, anchored, denied)).toBe(true);
});

test("a write to the worktree's own .git is not pre-allowed: it repoints the worktree", () => {
  expect(writes(`${WT}/.git`)).toBe(false);
  expect(writes(`${WT}/.git/config`)).toBe(false);
  // A neighbour whose name merely starts the same way is not the denied path.
  expect(writes(`${WT}/.gitignore`)).toBe(true);
});

test("a write outside the worktree is not pre-allowed, however near it sits", () => {
  expect(writes("/etc/hosts")).toBe(false);
  expect(writes("/repo/.git/config")).toBe(false);
  expect(writes("/repo/.git/refs/remotes/origin/main")).toBe(false);
  expect(writes("/repo/.git/packed-refs")).toBe(false);
  // The worktree's path as a prefix of a longer name is a different directory.
  expect(writes("/data/skelcrew/worktrees/70/x.ts")).toBe(false);
});

// --- what the list matches ---

const bash = (command: string): [string, Record<string, unknown>] => ["Bash", { command }];

test("every entry on the list matches the call it is there for", () => {
  const allowed: Array<[string, Record<string, unknown>]> = [
    ["Read", { file_path: "/repo/AGENTS.md" }],
    ["Glob", { pattern: "**/*.ts" }],
    ["Grep", { pattern: "startRunner" }],
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

/**
 * Criterion 10b's second half. `refs/heads/` is shared by the main checkout and every linked
 * worktree, so `git branch` writes the owner's repository — including the name a later run's
 * base is resolved from. No playbook runs it; every form of it asks, read-only ones included.
 */
test("git branch is not on the list, in any form", () => {
  for (const command of [
    "git branch",
    "git branch --show-current",
    "git branch -m main trunk",
    "git branch main HEAD",
    "git branch -D main",
    "git branch -f main HEAD",
  ]) {
    expect([command, allowsTool(...bash(command))]).toEqual([command, false]);
  }
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

/** Hermetic git: no user config, no hooks, a fixed identity. */
const GIT_ENV: Record<string, string | undefined> = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

let repo: string;
let origin: string;
let git: Git;
/** The repository's default branch, whose *remote-tracking* head is what the scan reads. */
const DEFAULT_BRANCH = "main";

async function sh(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: repo, env: GIT_ENV, stdout: "pipe" });
  const [stdout, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}`);
  return stdout.trim();
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "skr-allow-"));
  origin = mkdtempSync(join(tmpdir(), "skr-origin-"));
  git = createGit({ env: GIT_ENV });
  await sh("init", "-q", "--bare", "-b", DEFAULT_BRANCH, origin);
  await sh("init", "-q", "-b", DEFAULT_BRANCH);
  await sh("commit", "-q", "--allow-empty", "-m", "init");
  await sh("remote", "add", "origin", origin);
  await sh("push", "-q", "origin", DEFAULT_BRANCH);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(origin, { recursive: true, force: true });
});

/** Into the working tree only — where a run can write, and the scan may not read. */
function write(name: string, text: string): void {
  writeFileSync(join(repo, name), text);
}

/** Committed on the local default branch — which the scan does not read either. */
async function commitLocally(name: string, text: string): Promise<void> {
  write(name, text);
  await sh("add", name);
  await sh("commit", "-q", "-m", `document ${name}`);
}

/** On the remote's default branch, which is the only way an instruction file grants anything. */
async function commit(name: string, text: string): Promise<void> {
  await commitLocally(name, text);
  await sh("push", "-q", "origin", DEFAULT_BRANCH);
}

/** The worktree a run in this repository would work in; the anchor of its file-tool entry. */
function worktree(): string {
  return join(repo, ".worktree");
}

/** The whole list a run in this repository would be spawned with. */
async function list(): Promise<string[]> {
  return (await allowlistFor(git, repo, DEFAULT_BRANCH, worktree())).tools;
}

/** The fixed list plus the run's own anchored file-tool entry: what the scan adds to. */
function floor(): string[] {
  return [...FIXED_ALLOWLIST, editsIn(worktree())];
}

/** What the scan added, in order: everything past the fixed list. */
async function scanned(): Promise<string[]> {
  return (await list()).slice(floor().length);
}

test("a repository with neither instruction file yields exactly the fixed list", async () => {
  expect(await list()).toEqual(floor());
});

test("a check command in a fenced block in AGENTS.md is pre-allowed", async () => {
  await commit("AGENTS.md", "# Repo\n\nRun this:\n\n```\nbun run check\n```\n");
  expect(await scanned()).toEqual(["Bash(bun run check *)"]);
  // The repository's own check command runs unprompted; the fixed list alone would ask.
  expect(allowsTool("Bash", { command: "bun run check" }, await list())).toBe(true);
  expect(allowsTool(...bash("bun run check"))).toBe(false);
});

test("the scan grants the line it found, not its first word: `bun -e` still asks", async () => {
  await commit("AGENTS.md", "```\nbun run check\n```\n");
  expect(await list()).not.toContain("Bash(bun *)");
  // `Bash(bun *)` would pre-allow arbitrary execution from a file the target repo controls.
  expect(allowsTool("Bash", { command: "bun -e 'console.log(1)'" }, await list())).toBe(false);
  expect(allowsTool("Bash", { command: "bun run checkout" }, await list())).toBe(false);
});

test("CLAUDE.md is scanned too, and a shell info string and a leading $ are read", async () => {
  await commit("CLAUDE.md", "```bash\n$ make test\n```\n\n```console\npnpm lint\n```\n");
  expect(await scanned()).toEqual(["Bash(make test *)", "Bash(pnpm lint *)"]);
});

test("both instruction files contribute, once each", async () => {
  await commit("AGENTS.md", "```sh\nbun run check\n```\n");
  await commit("CLAUDE.md", "```\nbun run check\n```\n\n```zsh\ncargo test\n```\n");
  expect(await scanned()).toEqual(["Bash(bun run check *)", "Bash(cargo test *)"]);
});

/**
 * A repository with CRLF endings is a repository like any other: the fence closes, and the
 * command it documents runs unprompted. Reading the `\r` as part of the fence line made every
 * block look unterminated, so the agent asked for the repository's own check command every
 * time, with nothing on the card saying why.
 */
test("an instruction file with CRLF line endings is scanned the same", async () => {
  await commit("AGENTS.md", "# Repo\r\n\r\nRun this:\r\n\r\n```\r\nbun run check\r\n```\r\n");
  expect(await scanned()).toEqual(["Bash(bun run check *)"]);
});

test("a fenced block in another language contributes nothing", async () => {
  await commit("AGENTS.md", "```ts\nbun.spawn(['rm', '-rf', '/'])\n```\n\n```json\n{}\n```\n");
  expect(await scanned()).toEqual([]);
});

test("a fence that is never closed contributes nothing", async () => {
  await commit(
    "AGENTS.md",
    "```\nbun run check\n\nand then some prose that never closes the block\n",
  );
  expect(await scanned()).toEqual([]);
});

/**
 * Each narrowed command with a scannable one beside it, so the case tells "the scan refused
 * to widen this" apart from "the scan did nothing at all".
 */
test("a scanned command may not widen git, which the fixed list narrows verb by verb", async () => {
  await commit("AGENTS.md", "```\ngit status\n```\n\n```\nbun run check\n```\n");
  expect(await scanned()).toEqual(["Bash(bun run check *)"]);
  expect(await list()).not.toContain("Bash(git *)");
  expect(allowsTool("Bash", { command: "git -c core.pager=x log" }, await list())).toBe(false);
});

/**
 * The rule reads the line's first word, so a documented `git` line contributes nothing
 * whatever follows it — including the push forms the fixed list is careful to leave off.
 */
test("a scanned git line the fixed list does not cover is dropped whole, not granted", async () => {
  await commit("AGENTS.md", "```\ngit push --force\n```\n\n```\ngit status && rm -rf /\n```\n");
  expect(await scanned()).toEqual([]);
  expect(allowsTool("Bash", { command: "git push --force" }, await list())).toBe(false);
});

test("a scanned command may not widen gh", async () => {
  await commit("AGENTS.md", "```\ngh pr view\n```\n\n```\nbun run check\n```\n");
  expect(await scanned()).toEqual(["Bash(bun run check *)"]);
  expect(await list()).not.toContain("Bash(gh *)");
  expect(allowsTool("Bash", { command: "gh pr merge 42" }, await list())).toBe(false);
});

test("a scanned command may not widen skelcrew", async () => {
  await commit("CLAUDE.md", "```\nskelcrew show 1\n```\n\n```\nbun run check\n```\n");
  expect(await scanned()).toEqual(["Bash(bun run check *)"]);
  expect(await list()).not.toContain("Bash(skelcrew *)");
  expect(allowsTool("Bash", { command: "skelcrew mv 1 code" }, await list())).toBe(false);
});

/**
 * Criterion 10a. The harness compiles `*` in a rule to `.*`, so a metacharacter surviving
 * into an entry is a wildcard the *repository* chose: `Bash(bun * *)` matches
 * `bun -e '<any code>'` there — verified against the shipped binary's own matcher — which the
 * model in `allowsTool`, a literal prefix comparison, cannot see. The assertion that carries
 * this case is therefore on the entries, with the behavioural one beside it.
 */
test("a fenced line with a wildcard in it contributes nothing: `bun *` does not pre-allow `bun -e`", async () => {
  await commit("AGENTS.md", "```\nbun *\n```\n\n```\nbun run check\n```\n");
  expect(await scanned()).toEqual(["Bash(bun run check *)"]);
  expect(await list()).not.toContain("Bash(bun * *)");
  expect(allowsTool("Bash", { command: "bun -e 'console.log(1)'" }, await list())).toBe(false);
});

test("a fenced line containing ?, [ or an escaped * contributes nothing either", async () => {
  await commit(
    "AGENTS.md",
    "```\nmake -f ?.mk all\n```\n\n```\nbun test [a-z]\n```\n\n```\nbun \\* x\n```\n",
  );
  expect(await scanned()).toEqual([]);
});

test("a first word that is not a command word contributes nothing", async () => {
  await commit("AGENTS.md", "```\n* not a command\n```\n\n```\n\n```\n\n```\nbun run check\n```\n");
  expect(await scanned()).toEqual(["Bash(bun run check *)"]);
});

/**
 * Criterion 10a's second half. A run may write its own worktree freely, the repository's own
 * instructions included; reading the working tree would make that a standing grant for every
 * later run.
 */
test("an instruction file that is only in the working tree contributes nothing", async () => {
  write("AGENTS.md", "```\nbun run evil\n```\n");
  expect(await scanned()).toEqual([]);
});

test("a block added to an instruction file since the base commit contributes nothing", async () => {
  await commit("AGENTS.md", "```\nbun run check\n```\n");
  write("AGENTS.md", "```\nbun run check\n```\n\n```\nbun run evil\n```\n");
  expect(await scanned()).toEqual(["Bash(bun run check *)"]);
});

/**
 * Criterion 10b. The scan's base is `refs/remotes/origin/<default>`, not the local branch of
 * that name: `refs/heads/` is shared by every worktree, so a run that could commit and then
 * move the local default branch would otherwise be choosing its successor's list.
 */
test("an instruction file committed locally but not on the remote contributes nothing", async () => {
  await commitLocally("AGENTS.md", "```\nbun run evil\n```\n");
  expect(await scanned()).toEqual([]);
  expect(await list()).not.toContain("Bash(bun run evil *)");
});

test("a default branch with no remote-tracking head contributes nothing rather than failing", async () => {
  await commit("AGENTS.md", "```\nbun run check\n```\n");
  const list = await allowlistFor(git, repo, "no-such-branch", worktree());
  expect(list.tools).toEqual(floor());
});
