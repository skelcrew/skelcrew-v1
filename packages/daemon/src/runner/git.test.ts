import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGit, type Git, GitError, parseWorktreeList } from "./git";

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
let repo: string;
let git: Git;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "skg-")));
  repo = join(tmp, "repo");
  mkdirSync(repo);
  git = createGit({ env: GIT_ENV });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function sh(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}: ${stderr}`);
  return stdout.trim();
}

async function initRepo(branch: string): Promise<void> {
  await sh(repo, "init", "-q", "-b", branch);
  await sh(repo, "commit", "-q", "--allow-empty", "-m", "init");
}

test("defaultBranch: origin/HEAD's local head, else main, else master, else an error naming all three", async () => {
  await initRepo("develop");
  await expect(git.defaultBranch(repo)).rejects.toThrow(/origin\/HEAD.*main.*master/);

  await sh(repo, "branch", "master");
  expect(await git.defaultBranch(repo)).toEqual({
    name: "master",
    sha: await sh(repo, "rev-parse", "master"),
  });

  await sh(repo, "branch", "main");
  await sh(repo, "commit", "-q", "--allow-empty", "-m", "ahead on develop");
  expect((await git.defaultBranch(repo)).name).toBe("main");
  expect((await git.defaultBranch(repo)).sha).toBe(await sh(repo, "rev-parse", "main"));

  await sh(repo, "update-ref", "refs/remotes/origin/develop", "refs/heads/develop");
  await sh(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
  expect(await git.defaultBranch(repo)).toEqual({
    name: "develop",
    sha: await sh(repo, "rev-parse", "develop"),
  });

  // origin/HEAD names a branch with no local head: named, not silently replaced by main.
  await sh(repo, "update-ref", "refs/remotes/origin/trunk", "refs/heads/develop");
  await sh(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  await expect(git.defaultBranch(repo)).rejects.toThrow(/trunk/);
});

test("revParse is undefined for a missing ref and a GitError outside a repository", async () => {
  await initRepo("main");
  expect(await git.revParse(repo, "refs/heads/nope")).toBeUndefined();
  expect(await git.revParse(repo, "refs/heads/main")).toMatch(/^[0-9a-f]{40}$/);
  const bare = join(tmp, "not-a-repo");
  mkdirSync(bare);
  await expect(git.revParse(bare, "HEAD")).rejects.toBeInstanceOf(GitError);
});

test("a failing command is a GitError naming the command and git's own message", async () => {
  await initRepo("main");
  const error = await git.createBranch(repo, "main", "main").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(GitError);
  expect((error as Error).message).toContain("git branch main main failed");
  expect((error as Error).message).toContain("already exists");
});

test("with git missing from PATH every call is a GitError saying so", async () => {
  const empty = join(tmp, "empty");
  mkdirSync(empty);
  const noGit = createGit({ env: { ...GIT_ENV, PATH: empty } });
  const error = await noGit.worktreeList(repo).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(GitError);
  expect((error as Error).message).toContain("git worktree list --porcelain failed");
  expect((error as Error).message.toLowerCase()).toContain("not found");
});

test("worktree add, list, status, and remove round-trip; remove refuses a dirty worktree", async () => {
  await initRepo("main");
  await git.createBranch(repo, "skelcrew/1-x", await sh(repo, "rev-parse", "main"));
  const path = join(tmp, "wt", "1");
  mkdirSync(join(tmp, "wt"));
  await git.worktreeAdd(repo, path, "skelcrew/1-x");

  const entries = await git.worktreeList(repo);
  expect(entries.map((e) => e.path)).toEqual([repo, path]);
  expect(entries[1]).toEqual({
    path,
    head: await sh(repo, "rev-parse", "main"),
    branch: "refs/heads/skelcrew/1-x",
    prunable: false,
  });
  expect(await git.status(path)).toEqual([]);

  writeFileSync(join(path, "new.txt"), "x");
  mkdirSync(join(path, "dir"));
  writeFileSync(join(path, "dir", "deep.txt"), "y");
  expect((await git.status(path)).sort()).toEqual(["dir/deep.txt", "new.txt"]);
  await expect(git.worktreeRemove(repo, path)).rejects.toThrow(/untracked/);
  expect(await git.status(path)).toHaveLength(2);

  rmSync(join(path, "new.txt"));
  rmSync(join(path, "dir"), { recursive: true });
  await git.worktreeRemove(repo, path);
  expect((await git.worktreeList(repo)).map((e) => e.path)).toEqual([repo]);
});

test("a registered worktree whose directory is gone is prunable, and prune forgets it", async () => {
  await initRepo("main");
  await sh(repo, "branch", "gone");
  const path = join(tmp, "gone");
  await git.worktreeAdd(repo, path, "gone");
  rmSync(path, { recursive: true });
  const entry = (await git.worktreeList(repo)).find((e) => e.path === path);
  expect(entry?.prunable).toBe(true);
  await git.worktreePrune(repo);
  expect((await git.worktreeList(repo)).map((e) => e.path)).toEqual([repo]);
});

test("parseWorktreeList reads paths, heads, branches, detached entries, and prunable flags", () => {
  const text = [
    "worktree /r",
    "HEAD aaaa",
    "branch refs/heads/main",
    "",
    "worktree /r/wt/1",
    "HEAD bbbb",
    "detached",
    "",
    "worktree /r/wt/2",
    "HEAD cccc",
    "branch refs/heads/x",
    "prunable gitdir file points to non-existent location",
    "",
  ].join("\n");
  expect(parseWorktreeList(text)).toEqual([
    { path: "/r", head: "aaaa", branch: "refs/heads/main", prunable: false },
    { path: "/r/wt/1", head: "bbbb", branch: null, prunable: false },
    { path: "/r/wt/2", head: "cccc", branch: "refs/heads/x", prunable: true },
  ]);
  expect(parseWorktreeList("")).toEqual([]);
});
