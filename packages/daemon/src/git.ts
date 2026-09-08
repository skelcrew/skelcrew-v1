/**
 * Worktree plumbing. Code lives in the user's repository and the daemon's worktrees —
 * never on the board.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", repo, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export async function tryGit(repo: string, args: string[]): Promise<string | null> {
  try {
    return await git(repo, args);
  } catch {
    return null;
  }
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 44)
    .replace(/-+$/g, "");
  return slug || "card";
}

export interface Worktree {
  slug: string;
  branch: string;
  path: string;
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await tryGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) !== null;
}

/**
 * `git worktree add <repo>/.kanbot/worktrees/<slug> -b kanbot/<slug>`, suffixing the slug
 * until both the branch and the directory are free.
 */
export async function createWorktree(repo: string, title: string): Promise<Worktree> {
  const base = slugify(title);
  for (let n = 0; n < 50; n++) {
    const slug = n === 0 ? base : `${base}-${n + 1}`;
    const branch = `kanbot/${slug}`;
    const path = join(repo, ".kanbot", "worktrees", slug);
    if (existsSync(path) || (await branchExists(repo, branch))) continue;
    await git(repo, ["worktree", "add", path, "-b", branch]);
    return { slug, branch, path };
  }
  throw new Error(`could not find a free worktree slot for "${title}"`);
}

/**
 * A read-only worktree, detached at the tip of an existing branch — used by the review
 * stage so it never collides with a checkout of that branch elsewhere.
 */
export async function createReviewWorktree(
  repo: string,
  title: string,
  branch: string,
): Promise<Worktree> {
  const base = `review-${slugify(title)}`;
  for (let n = 0; n < 50; n++) {
    const slug = n === 0 ? base : `${base}-${n + 1}`;
    const path = join(repo, ".kanbot", "worktrees", slug);
    if (existsSync(path)) continue;
    await git(repo, ["worktree", "add", "--detach", path, branch]);
    return { slug, branch, path };
  }
  throw new Error(`could not find a free review worktree slot for "${title}"`);
}

/**
 * A worktree checked out on an existing branch — used when a bounced card returns to
 * Developing, so fixes continue the same branch instead of starting a fresh one.
 * Fails clearly if the branch is checked out somewhere else (git refuses, correctly).
 */
export async function continueBranchWorktree(
  repo: string,
  title: string,
  branch: string,
): Promise<Worktree> {
  const base = slugify(title);
  for (let n = 0; n < 50; n++) {
    const slug = n === 0 ? base : `${base}-${n + 1}`;
    const path = join(repo, ".kanbot", "worktrees", slug);
    if (existsSync(path)) continue;
    await git(repo, ["worktree", "add", path, branch]);
    return { slug, branch, path };
  }
  throw new Error(`could not find a free worktree slot for "${title}"`);
}

/** Spec runs leave nothing behind; develop runs keep the branch for review. */
export async function removeWorktree(
  repo: string,
  worktree: Worktree,
  deleteBranch: boolean,
): Promise<void> {
  await tryGit(repo, ["worktree", "remove", "--force", worktree.path]);
  await tryGit(repo, ["worktree", "prune"]);
  if (deleteBranch) await tryGit(repo, ["branch", "-D", worktree.branch]);
}

export async function originUrl(repo: string): Promise<string | null> {
  return tryGit(repo, ["remote", "get-url", "origin"]);
}

export async function pushBranch(repo: string, branch: string): Promise<void> {
  await git(repo, ["push", "-u", "origin", branch]);
}

/** Opens a GitHub PR via the gh CLI; returns the PR URL. Base = the repo's default branch. */
export async function createPullRequest(
  repo: string,
  branch: string,
  title: string,
  body: string,
): Promise<string> {
  const { stdout } = await exec(
    "gh",
    ["pr", "create", "--head", branch, "--title", title, "--body", body],
    { cwd: repo, maxBuffer: 1024 * 1024 },
  );
  const url = stdout.trim().split("\n").pop() ?? "";
  if (!url.startsWith("http")) throw new Error(`gh pr create returned no URL: ${stdout.slice(0, 200)}`);
  return url;
}

export async function hasCommits(repo: string): Promise<boolean> {
  return (await tryGit(repo, ["rev-parse", "--verify", "--quiet", "HEAD"])) !== null;
}

export async function currentBranch(dir: string): Promise<string | null> {
  return tryGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function isDirty(dir: string): Promise<boolean> {
  const status = await tryGit(dir, ["status", "--porcelain"]);
  return status !== null && status.length > 0;
}
