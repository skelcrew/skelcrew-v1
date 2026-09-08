/**
 * The daemon's side of the data directory. Discovery — the repo-root walk, `SKELCREW_DIR`,
 * the socket and database paths — lives in `@skelcrew/shared` so clients resolve the same
 * socket from the same code; what stays here is what only the daemon may do: create the
 * directory, and remove a socket file nobody answers on.
 */
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";

export {
  DATA_DIR_NAME,
  DB_FILE,
  dataPaths,
  findRepoRoot,
  resolveDataDir,
  SOCKET_FILE,
} from "@skelcrew/shared";

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
