import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepoRoot, resolveDataDir } from "./paths";

const GIT_ENV: Record<string, string | undefined> = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

let tmp: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "skp-")));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function sh(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, env: GIT_ENV, stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
    throw new Error(`git ${args.join(" ")} exited ${code}: ${stderr}`);
  }
}

test("a directory .git marks the root; the walk stops at the filesystem root", () => {
  const repo = join(tmp, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const nested = join(repo, "a", "b");
  mkdirSync(nested, { recursive: true });
  expect(findRepoRoot(nested)).toBe(repo);
  expect(findRepoRoot(repo)).toBe(repo);
  expect(findRepoRoot(tmp)).toBeUndefined();
});

test("a linked worktree resolves to its main repository, from its root and from inside it", async () => {
  const repo = join(tmp, "repo");
  mkdirSync(repo);
  await sh(repo, "init", "-q", "-b", "main");
  await sh(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const worktree = join(repo, ".skelcrew", "worktrees", "1");
  mkdirSync(join(repo, ".skelcrew", "worktrees"), { recursive: true });
  await sh(repo, "worktree", "add", "-q", worktree, "-b", "skelcrew/1-x");
  const nested = join(worktree, "src", "deep");
  mkdirSync(nested, { recursive: true });

  expect(findRepoRoot(worktree)).toBe(repo);
  expect(findRepoRoot(nested)).toBe(repo);
  expect(resolveDataDir({}, nested)).toBe(join(repo, ".skelcrew"));

  // A linked worktree elsewhere on disk resolves to the same main repository.
  const outside = join(tmp, "elsewhere");
  await sh(repo, "worktree", "add", "-q", outside, "-b", "other");
  expect(findRepoRoot(outside)).toBe(repo);
});

test("a .git file that is not a linked worktree of an existing repository keeps marking its own directory", () => {
  const stale = join(tmp, "stale");
  mkdirSync(stale);
  writeFileSync(join(stale, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
  expect(findRepoRoot(stale)).toBe(stale);

  const odd = join(tmp, "odd");
  mkdirSync(odd);
  writeFileSync(join(odd, ".git"), "gitdir: ../somewhere/else\n");
  expect(findRepoRoot(odd)).toBe(odd);

  const garbage = join(tmp, "garbage");
  mkdirSync(garbage);
  writeFileSync(join(garbage, ".git"), "not a gitdir line\n");
  expect(findRepoRoot(garbage)).toBe(garbage);
});
