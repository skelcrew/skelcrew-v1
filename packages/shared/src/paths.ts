/**
 * Where the daemon keeps its state: `<repo root>/.skelcrew/`, or `SKELCREW_DIR`. The repo
 * root is the nearest ancestor holding `.git` (a directory, or the file a worktree has); no
 * `git` subprocess. The daemon and every client resolve the socket from this one walk, so
 * they cannot drift.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const DATA_DIR_NAME = ".skelcrew";
export const DB_FILE = "skelcrew.db";
export const SOCKET_FILE = "skelcrew.sock";

export function findRepoRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
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
