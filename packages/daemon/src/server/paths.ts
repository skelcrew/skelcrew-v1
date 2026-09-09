/**
 * The daemon's side of the data directory. Discovery — the repo-root walk, `SKELCREW_DIR`,
 * the socket and database paths — lives in `@skelcrew/shared` so clients resolve the same
 * socket from the same code; what stays here is what only the daemon may do: create the
 * directory, and remove a socket file nobody answers on.
 */
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export {
  DATA_DIR_NAME,
  DB_FILE,
  dataPaths,
  findRepoRoot,
  resolveDataDir,
  SOCKET_FILE,
} from "@skelcrew/shared";

/**
 * Creates the directory if missing and makes it private either way: it holds the socket.
 * The directory also ignores itself (`*`, which covers the ignore file too), so a target
 * repository with no `.skelcrew/` entry of its own never sees the socket, the database, or
 * a runner worktree in `git status` or in tooling that honours ignore files.
 */
export function prepareDataDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
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
