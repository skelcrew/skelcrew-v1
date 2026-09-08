/**
 * Where the daemon keeps its state: `<repo root>/.skelcrew/`, or `SKELCREW_DIR`. The repo
 * root is the nearest ancestor holding `.git` (a directory, or the file a worktree has); no
 * `git` subprocess. The directory is the daemon's alone, so it and the socket are private.
 */
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
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

/** Creates the directory if missing and makes it private either way: it holds the socket. */
export function prepareDataDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/**
 * Whether a daemon answers on the socket. Detected by connecting, not by a pid file: a
 * refused connection means a file left behind by a crash, which is removed here so the
 * caller may listen.
 */
export async function daemonAnswers(socketPath: string): Promise<boolean> {
  if (!existsSync(socketPath)) return false;
  try {
    const socket = await Bun.connect({
      unix: socketPath,
      socket: { data() {}, connectError() {}, error() {} },
    });
    socket.end();
    return true;
  } catch {
    rmSync(socketPath, { force: true });
    return false;
  }
}
