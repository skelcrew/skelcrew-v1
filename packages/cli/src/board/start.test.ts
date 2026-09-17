/**
 * 030's criteria 4, 5, 9 and 10: the screen's start, driven against the real daemon's entry
 * file with a fake terminal. No pty, no `script`, and no coding agent — every daemon started
 * here has the runner off, `SKELCREW_AGENT=none`, and nothing to notify anyone with, and every
 * setting the daemon reads is dropped from the inherited environment first, as
 * `daemon/src/server/process.test.ts` does it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, VERSION } from "@skelcrew/shared";
import { openCore } from "../../../daemon/src/core/core";
import { startServer } from "../../../daemon/src/server/server";
import { CURSOR_HOME } from "./ansi";
import { type BoardDeps, type KeyInput, runBoard, type Screen } from "./board";
import {
  type DaemonProcess,
  reportDaemon,
  type StartOptions,
  spawnDaemon,
  startForScreen,
} from "./start";

let dir: string;
let socketPath: string;
const started: DaemonProcess[] = [];
const clients: Client[] = [];
const servers: Array<{ stop(): void }> = [];

beforeEach(() => {
  // Real path: the daemon names the path it resolved, and macOS's temp dir is a symlink.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "skc-start-")));
  socketPath = join(dir, "skelcrew.sock");
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) server.stop();
  // By the pid the start recorded, never by pattern: the owner may have a daemon of their own.
  for (const daemon of started.splice(0)) {
    if (daemon.exitCode === null) daemon.kill();
    await daemon.exited;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** The owner's environment as these tests need it: nothing of the developer's shell survives. */
function daemonEnv(
  dataDir: string,
  over: Record<string, string> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.SKELCREW_RUNS;
  delete env.SKELCREW_RUN_MINUTES;
  delete env.SKELCREW_MERGE_POLL_SECONDS;
  delete env.SKELCREW_AS;
  env.SKELCREW_DIR = dataDir;
  env.SKELCREW_RUNNER = "0";
  env.SKELCREW_AGENT = "none";
  env.SKELCREW_NOTIFY = "none";
  return { ...env, ...over };
}

/** The real spawn, against the real entry file, recorded so nothing is left running. */
function realSpawn(dataDir: string, over: Record<string, string> = {}): () => DaemonProcess {
  return () => {
    const daemon = spawnDaemon({ dataDir, env: daemonEnv(dataDir, over), cwd: dataDir });
    started.push(daemon);
    return daemon;
  };
}

/** The screen's start against a data directory of its own. */
function startIn(
  dataDir: string,
  over: Partial<StartOptions> = {},
): Promise<{ client: Client; daemon?: DaemonProcess }> {
  return startForScreen({
    socketPath: join(dataDir, "skelcrew.sock"),
    dataDir,
    hello: { kind: "human" },
    spawn: realSpawn(dataDir),
    ...over,
  });
}

function start(
  over: Partial<StartOptions> = {},
): Promise<{ client: Client; daemon?: DaemonProcess }> {
  return startIn(dir, over);
}

interface FakeTerminal {
  input: KeyInput;
  screen: Screen;
  frames(): string[];
  type(keys: string): void;
}

/** The terminal, faked as in `board.test.ts`: no real one is ever opened. */
function fakeTerminal(): FakeTerminal {
  const handlers = new Set<(chunk: unknown) => void>();
  const out: string[] = [];
  return {
    input: {
      setRawMode: () => {},
      on: (handler) => {
        handlers.add(handler);
      },
      off: (handler) => {
        handlers.delete(handler);
      },
      resume: () => {},
      pause: () => {},
    },
    screen: { write: (text) => out.push(text), columns: 100, rows: 24 },
    frames: () => out.filter((text) => text.startsWith(CURSOR_HOME)),
    type: (keys) => {
      for (const handler of [...handlers]) handler(keys);
    },
  };
}

/** A file that may not be there yet, as text. */
function readOr(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

async function until(what: string, ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (ready()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The screen over that client, opened and then closed with `q`, as the owner would. */
async function screen(client: Client, terminal: FakeTerminal): Promise<void> {
  const deps: BoardDeps = {
    client,
    socketPath,
    dataDir: dir,
    input: terminal.input,
    screen: terminal.screen,
    redrawMs: 0,
    spawnShell: () => {
      throw new Error("this test must not start a shell");
    },
  };
  const running = runBoard(deps);
  await until("the first frame", () => terminal.frames().length > 0);
  terminal.type("q");
  await running;
}

test("with nothing listening the screen starts a daemon, and its log holds the listening line", async () => {
  const opened = await start();
  clients.push(opened.client);
  expect(opened.daemon).toBeDefined();

  // The screen is up over the daemon that was just started, and it answers.
  const terminal = fakeTerminal();
  await opened.client.call("createCard", { title: "Filed through the screen's own daemon" });
  await screen(opened.client, terminal);
  expect(terminal.frames().join("")).toContain("Filed through the screen's own daemon");

  const log = readFileSync(join(dir, "daemon.log"), "utf8");
  expect(log.split("\n")[0]).toBe(`skelcrew daemon ${VERSION} listening on ${socketPath}`);
  expect(existsSync(socketPath)).toBe(true);

  // And the exit line, after the screen closed: the daemon it started ends with it.
  await opened.client.close();
  const printed: string[] = [];
  await reportDaemon(opened.daemon, (line) => printed.push(line));
  expect(printed).toEqual(["daemon stopped"]);
  expect(opened.daemon?.exitCode).toBe(0);
});

test("with a daemon already listening the screen attaches: nothing is started, no log, nothing said", async () => {
  const core = openCore(":memory:", { owner: "simon" });
  const server = startServer({ core, socketPath, reserved: [] });
  servers.push({
    stop() {
      server.stop();
      core.close();
    },
  });

  let spawned = 0;
  const opened = await start({
    spawn: () => {
      spawned += 1;
      throw new Error("the screen must not start a daemon when one is listening");
    },
  });
  clients.push(opened.client);
  expect(spawned).toBe(0);
  expect(opened.daemon).toBeUndefined();
  expect(existsSync(join(dir, "daemon.log"))).toBe(false);

  const terminal = fakeTerminal();
  await screen(opened.client, terminal);
  const printed: string[] = [];
  await reportDaemon(opened.daemon, (line) => printed.push(line));
  expect(printed).toEqual([]);
});

test("a daemon still running when the screen closes is said to be running", async () => {
  const printed: string[] = [];
  const running: DaemonProcess = {
    exited: new Promise(() => {}),
    exitCode: null,
    logPath: join(dir, "daemon.log"),
    output: () => "",
    kill: () => {},
  };
  await reportDaemon(running, (line) => printed.push(line), 50);
  expect(printed).toEqual(["daemon running; it stops when its runs finish"]);
});

test("a daemon that cannot start is its own error line, and nothing is left running", async () => {
  let caught: unknown;
  try {
    await start({ spawn: realSpawn(dir, { SKELCREW_AGENT: "bogus" }) });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toContain(
    'SKELCREW_AGENT must be "claude" or "none", not "bogus"',
  );
  // Nothing is listening and nothing is running: the daemon stopped before it created either.
  expect(existsSync(socketPath)).toBe(false);
  expect(started.map((daemon) => daemon.exitCode)).toEqual([1]);
});

/**
 * The log is opened before the daemon runs, so the CLI is what makes the data directory when
 * there is none — and a directory that does not ignore itself is a directory a target
 * repository shows in `git status`. It must hold the same ignore file the daemon's own
 * `prepareDataDir` writes, whether or not the daemon ever got as far as writing it.
 */
test("the data directory the screen made ignores itself, even when the daemon could not start", async () => {
  try {
    await start({ spawn: realSpawn(dir, { SKELCREW_AGENT: "bogus" }) });
  } catch {
    // The failure itself is the test above.
  }
  expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("*\n");
});

/**
 * A daemon that dies without a word of its own — an uncaught error rather than the one line
 * `stop()` prints — leaves a crash dump in the log whose last line is the harness's version
 * footer. That is not "the daemon's own error line", so the CLI says where to look instead.
 */
test("a daemon that crashes without a word of its own names the log rather than its last line", async () => {
  // A database that cannot be opened: the daemon throws where nothing catches it.
  mkdirSync(join(dir, "skelcrew.db"));
  let caught: unknown;
  try {
    await start();
  } catch (error) {
    caught = error;
  }
  const message = caught instanceof Error ? caught.message : String(caught);
  expect(message).toContain(join(dir, "daemon.log"));
  expect(message).not.toContain("Bun v");
  expect(existsSync(socketPath)).toBe(false);
});

/**
 * Two `skelcrew` in two terminals, on a data directory neither has ever started a daemon in:
 * both spawn, both find no socket, and both go on to make the same database. One daemon wins
 * the socket and both screens end up on it — the spec's "a child that exits because a daemon
 * was already listening is not an error". Repeated, because the race is a race: a start that
 * is not serialised loses both screens about two rounds in three.
 */
test("two screens starting at once on a fresh data directory both end up on one daemon", async () => {
  for (let round = 0; round < 5; round += 1) {
    const data = join(dir, `round-${round}`);
    mkdirSync(data);
    const [first, second] = await Promise.all([startIn(data), startIn(data)]);
    clients.push(first.client, second.client);

    // One board, seen from both: a card filed through one is on the other.
    const card = await first.client.call("createCard", { title: `Round ${round}` });
    expect((await second.client.call("listCards", {})).map((each) => each.id)).toEqual([card.id]);

    // And the one that lost says what it found, in the daemon's own words — the same line a
    // second daemon prints on a socket that was already answering — rather than dying in a
    // crash dump the owner cannot read.
    const log = join(data, "daemon.log");
    await until("the daemon that lost to say so", () =>
      readOr(log).includes("a daemon is already running"),
    );
    expect(readOr(log)).toContain(
      `skelcrew daemon: a daemon is already running on ${join(data, "skelcrew.sock")}`,
    );
    expect(readOr(log)).not.toContain("Bun v");
    // Exactly one daemon is left, listening on that directory.
    expect(existsSync(join(data, "skelcrew.sock"))).toBe(true);
    expect(started.filter((daemon) => daemon.exitCode === null)).toHaveLength(1);

    for (const client of clients.splice(0)) await client.close();
    for (const daemon of started.splice(0)) {
      if (daemon.exitCode === null) daemon.kill();
      await daemon.exited;
    }
  }
}, 60_000);
