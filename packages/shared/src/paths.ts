/**
 * Where the daemon keeps its state: `<repo root>/.skelcrew/`, or `SKELCREW_DIR`. The repo
 * root is the nearest ancestor holding `.git`; when that `.git` is the file a linked
 * worktree has, pointing into `<main>/.git/worktrees/`, the root is `<main>`, so a shell
 * inside a runner worktree reaches the same daemon as one in the checkout. No `git`
 * subprocess. The daemon and every client resolve the socket from this one walk, so they
 * cannot drift.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const DATA_DIR_NAME = ".skelcrew";
export const DB_FILE = "skelcrew.db";
export const SOCKET_FILE = "skelcrew.sock";

export function findRepoRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    const marker = join(dir, ".git");
    if (existsSync(marker)) return linkedWorktreeMain(marker) ?? dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The main repository of a linked worktree: its `.git` is a file reading `gitdir:
 * <main>/.git/worktrees/<name>`. Only when that main repository exists; any other `.git`
 * file (a stale one, a submodule's, one that does not parse) keeps its own directory as
 * the root.
 */
function linkedWorktreeMain(marker: string): string | undefined {
  let text: string;
  try {
    if (!statSync(marker).isFile()) return undefined;
    text = readFileSync(marker, "utf8");
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (match === null) return undefined;
  const gitdir = resolve(dirname(marker), match[1] as string);
  const worktrees = dirname(gitdir);
  const dotGit = dirname(worktrees);
  if (basename(worktrees) !== "worktrees" || basename(dotGit) !== ".git") return undefined;
  const main = dirname(dotGit);
  return existsSync(join(main, ".git")) ? main : undefined;
}

/** The data directory, or `undefined` when there is neither an override nor a repository. */
export function resolveDataDir(
  env: Record<string, string | undefined>,
  cwd: string,
): string | undefined {
  if (env.SKELCREW_DIR) return resolve(cwd, env.SKELCREW_DIR);
  const root = findRepoRoot(cwd);
  return root === undefined ? undefined : join(root, DATA_DIR_NAME);
}

export function dataPaths(dir: string): { dbPath: string; socketPath: string } {
  return { dbPath: join(dir, DB_FILE), socketPath: join(dir, SOCKET_FILE) };
}

/**
 * Where the runner keeps its worktrees, one per card under `<data dir>/worktrees/<id>`.
 * Inside the gitignored data directory, so no target-repo tooling walks them.
 */
export function worktreesDir(dir: string): string {
  return join(dir, WORKTREES_DIR_NAME);
}

export const WORKTREES_DIR_NAME = "worktrees";
