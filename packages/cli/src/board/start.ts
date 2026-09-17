/**
 * How the screen gets a daemon (030). `skelcrew` in a terminal is the product running: when a
 * daemon answers on the socket the screen opens over it, and when none does, the CLI starts one,
 * waits until it is listening, and opens the screen over that.
 *
 * **The daemon is a child process and never this process's code.** Nothing of the daemon's is
 * imported here — only the path to its entry file — because "one headless daemon, thin clients"
 * and 012's SDK isolation both depend on the two halves staying in separate processes. The child
 * gets this process's own `cwd` and environment, so `resolveDataDir` gives it the directory the
 * CLI just resolved and every setting is read from the shell the owner typed in.
 *
 * The spawn is injected into `startForScreen` the way 027 injects the shell, so no test starts a
 * daemon it did not mean to.
 */
import { closeSync, existsSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Client, connect, type HelloParams, prepareDataDir, RpcError } from "@skelcrew/shared";

/**
 * The daemon's entry file, as a path relative to this file: `bun run skelcrew` from any
 * directory inside the repository finds it, and nothing is loaded from it here.
 */
export const DAEMON_ENTRY = fileURLToPath(new URL("../../../daemon/src/main.ts", import.meta.url));

/**
 * The argument that tells the daemon it was started by the screen, and is the whole of what
 * that changes: it ignores SIGHUP and ends when nothing needs it. One fixed entry in a list of
 * arguments — never a shell line — so it composes into no syntax.
 */
export const STOP_WHEN_IDLE = "--stop-when-idle";

/**
 * The daemon's console, under the screen. The data directory is private and ignores itself, so
 * the listening line and every warning land where nothing renders them; `cat`ing the file in a
 * terminal has the exposure 015 recorded for the daemon's own stderr.
 */
export const DAEMON_LOG_FILE = "daemon.log";

/** How long the CLI waits for a daemon it started to answer, and how often it asks. */
export const START_TIMEOUT_MS = 15_000;
export const START_RETRY_MS = 100;
/** How long the exit line waits for the daemon to be gone before it says it is still running. */
export const EXIT_WAIT_MS = 2000;

/** The daemon this CLI started, as much of it as the screen's start needs. */
export interface DaemonProcess {
  /** Resolves with its exit code once it has exited. */
  readonly exited: Promise<number>;
  /** Its exit code, or `null` while it runs. */
  readonly exitCode: number | null;
  /** Where its output went. */
  readonly logPath: string;
  /** Everything it has written since it was started. */
  output(): string;
  /** Stops it. For a caller that must not leave one behind; the owner's `q` never needs it. */
  kill(): void;
}

export interface StartOptions {
  socketPath: string;
  dataDir: string;
  hello: HelloParams;
  /** Starts the daemon. Injected, so a test drives this without a process being started. */
  spawn(): DaemonProcess;
  timeoutMs?: number;
  retryMs?: number;
}

export interface ScreenDaemon {
  client: Client;
  /** The daemon this call started, and `undefined` when it attached to one already listening. */
  daemon?: DaemonProcess;
}

/** The bytes written to `path` past `from`, as text; nothing when it cannot be read. */
function readFrom(path: string, from: number): string {
  try {
    return readFileSync(path).subarray(from).toString("utf8");
  } catch {
    return "";
  }
}

function sizeOf(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

/**
 * The real spawn: the daemon's entry file with this process's `cwd` and environment, its stdout
 * and stderr appended to `<data dir>/daemon.log`, and the argument that makes its life its own.
 * Unreferenced, so this process is free to exit while the daemon runs on.
 */
export function spawnDaemon(options: {
  dataDir: string;
  env: Record<string, string | undefined>;
  cwd: string;
}): DaemonProcess {
  const logPath = join(options.dataDir, DAEMON_LOG_FILE);
  // The log is open before the daemon that writes it exists, so this is where the data
  // directory is made when there is none: private, and ignoring itself from the first byte —
  // a daemon that then fails to start leaves nothing a target repository would show. The same
  // call the daemon makes at startup, so there is one answer to what that directory is.
  prepareDataDir(options.dataDir);
  const from = sizeOf(logPath);
  const fd = openSync(logPath, "a", 0o600);
  try {
    const proc = Bun.spawn([process.execPath, DAEMON_ENTRY, STOP_WHEN_IDLE], {
      cwd: options.cwd,
      env: options.env,
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
    });
    proc.unref();
    return {
      exited: proc.exited,
      get exitCode() {
        return proc.exitCode;
      },
      logPath,
      output: () => readFrom(logPath, from),
      kill: () => proc.kill(),
    };
  } finally {
    // The child has a descriptor of its own for the file; this one has done its work.
    closeSync(fd);
  }
}

/** How the daemon prefixes what it says about itself, including every line it stops on. */
const DAEMON_SAYS = "skelcrew daemon:";

/**
 * Why the daemon is gone, in one line. The last line it wrote *about itself* — a bad setting, a
 * data directory it will not have, a socket already answering — and not simply the last line in
 * the log: a daemon that dies of an uncaught error ends its crash dump with the harness's
 * version footer, which tells the owner nothing and is not the daemon talking. Then the log
 * itself is the answer, and this says where it is.
 */
function whyItIsGone(daemon: DaemonProcess): string {
  const said = daemon
    .output()
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith(DAEMON_SAYS))
    .at(-1);
  return (
    said ??
    `the daemon exited ${daemon.exitCode} without a word of its own; its output is in ${daemon.logPath}`
  );
}

/**
 * A client of the daemon on `socketPath`, starting one when nothing answers. Retries the
 * connection until it answers, the child exits, or the deadline passes. A child that exits
 * because a daemon was already listening — two screens started at once — is not an error: the
 * screen attaches to the one that won, and that daemon is not this CLI's to report on.
 */
export async function startForScreen(options: StartOptions): Promise<ScreenDaemon> {
  const { socketPath, hello } = options;
  const timeoutMs = options.timeoutMs ?? START_TIMEOUT_MS;
  const retryMs = options.retryMs ?? START_RETRY_MS;

  async function attach(): Promise<Client | undefined> {
    try {
      return await connect(socketPath, hello);
    } catch (error) {
      // A daemon that answered and refused this member is not a daemon to start over.
      if (error instanceof RpcError) throw error;
      return undefined;
    }
  }

  const listening = await attach();
  if (listening !== undefined) return { client: listening };

  const daemon = options.spawn();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await Bun.sleep(retryMs);
    const client = await attach();
    if (client !== undefined) {
      return daemon.exitCode === null ? { client, daemon } : { client };
    }
    if (daemon.exitCode !== null) throw new Error(whyItIsGone(daemon));
    if (Date.now() >= deadline) {
      throw new Error(
        `the daemon did not start within ${Math.round(timeoutMs / 1000)} s; its output is in ${daemon.logPath}`,
      );
    }
  }
}

/**
 * The one line the CLI prints after the screen closes, and only when it started the daemon:
 * `q` with nothing running takes the daemon with the screen, and `q` with runs in flight leaves
 * them to finish. No count of runs — which claims are runs is the daemon's knowledge (024).
 */
export async function reportDaemon(
  daemon: DaemonProcess | undefined,
  out: (line: string) => void,
  waitMs = EXIT_WAIT_MS,
): Promise<void> {
  if (daemon === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gone = await Promise.race([
    daemon.exited.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), waitMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  out(gone ? "daemon stopped" : "daemon running; it stops when its runs finish");
}
