import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Activity, connect, VERSION } from "@skelcrew/shared";

const MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));

let dir: string;
const running: Daemon[] = [];

beforeEach(() => {
  // Real path: the child reports its cwd resolved, and macOS's temp dir is a symlink.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "skc-")));
});

afterEach(async () => {
  for (const daemon of running.splice(0)) {
    if (daemon.proc.exitCode === null && daemon.proc.signalCode === null)
      daemon.proc.kill("SIGKILL");
    await daemon.proc.exited;
  }
  rmSync(dir, { recursive: true, force: true });
});

interface Daemon {
  proc: ReturnType<typeof Bun.spawn>;
  /** The first stdout line, without its newline. */
  firstLine(): Promise<string>;
  /** Everything stdout produced, once the process has exited. */
  stdout(): Promise<string>;
  stderr(): Promise<string>;
}

function collect(stream: ReadableStream<Uint8Array>) {
  let text = "";
  let done = false;
  const waiters: Array<() => void> = [];
  const decoder = new TextDecoder();
  (async () => {
    for await (const chunk of stream) {
      text += decoder.decode(chunk, { stream: true });
      for (const waiter of waiters.splice(0)) waiter();
    }
    done = true;
    for (const waiter of waiters.splice(0)) waiter();
  })();
  const wait = () => new Promise<void>((resolve) => waiters.push(resolve));
  return {
    async firstLine(): Promise<string> {
      while (!text.includes("\n") && !done) await wait();
      const newline = text.indexOf("\n");
      return newline >= 0 ? text.slice(0, newline) : text;
    },
    async all(): Promise<string> {
      while (!done) await wait();
      return text;
    },
  };
}

function spawnDaemon(options: { cwd: string; dataDir?: string }): Daemon {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.SKELCREW_DIR;
  if (options.dataDir) env.SKELCREW_DIR = options.dataDir;
  const proc = Bun.spawn([process.execPath, MAIN], {
    cwd: options.cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = collect(proc.stdout as ReadableStream<Uint8Array>);
  const err = collect(proc.stderr as ReadableStream<Uint8Array>);
  const daemon: Daemon = {
    proc,
    firstLine: () => out.firstLine(),
    stdout: () => out.all(),
    stderr: () => err.all(),
  };
  running.push(daemon);
  return daemon;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

async function stopped(daemon: Daemon, signal: "SIGTERM" | "SIGINT" | "SIGKILL"): Promise<number> {
  daemon.proc.kill(signal);
  return daemon.proc.exited;
}

test("starts on SKELCREW_DIR, prints one line, sets modes, and cleans up on SIGTERM", async () => {
  const socketPath = join(dir, "skelcrew.sock");
  const dbPath = join(dir, "skelcrew.db");
  const daemon = spawnDaemon({ cwd: dir, dataDir: dir });
  expect(await daemon.firstLine()).toBe(`skelcrew daemon ${VERSION} listening on ${socketPath}`);
  expect(existsSync(dbPath)).toBe(true);
  expect(existsSync(socketPath)).toBe(true);
  expect(mode(socketPath)).toBe(0o600);
  expect(mode(dir)).toBe(0o700);

  const client = await connect(socketPath, { kind: "human" });
  const card = await client.call("createCard", { title: "from a real daemon" });
  expect(card.phase).toBe("idea");
  await client.close();

  expect(await stopped(daemon, "SIGTERM")).toBe(0);
  expect(existsSync(socketPath)).toBe(false);
  expect(existsSync(dbPath)).toBe(true);
  expect(await daemon.stdout()).toBe(`skelcrew daemon ${VERSION} listening on ${socketPath}\n`);
});

test("SIGINT stops it the same way", async () => {
  const daemon = spawnDaemon({ cwd: dir, dataDir: dir });
  await daemon.firstLine();
  expect(await stopped(daemon, "SIGINT")).toBe(0);
  expect(existsSync(join(dir, "skelcrew.sock"))).toBe(false);
});

test("a second daemon on the same directory exits 1 naming the socket; the first is unaffected", async () => {
  const socketPath = join(dir, "skelcrew.sock");
  const first = spawnDaemon({ cwd: dir, dataDir: dir });
  await first.firstLine();

  const second = spawnDaemon({ cwd: dir, dataDir: dir });
  expect(await second.proc.exited).toBe(1);
  const stderr = await second.stderr();
  expect(stderr).toContain(socketPath);
  expect(stderr).toContain("already running");
  expect(await second.stdout()).toBe("");

  const client = await connect(socketPath, { kind: "human" });
  expect((await client.call("listMembers", {})).map((m) => m.kind)).toEqual(["human"]);
  await client.close();
  expect(await stopped(first, "SIGTERM")).toBe(0);
});

test("a stale socket left behind by SIGKILL is replaced by the next daemon", async () => {
  const socketPath = join(dir, "skelcrew.sock");
  const first = spawnDaemon({ cwd: dir, dataDir: dir });
  await first.firstLine();
  await stopped(first, "SIGKILL");
  expect(existsSync(socketPath)).toBe(true);

  const second = spawnDaemon({ cwd: dir, dataDir: dir });
  expect(await second.firstLine()).toBe(`skelcrew daemon ${VERSION} listening on ${socketPath}`);
  const client = await connect(socketPath, { kind: "human" });
  expect(await client.call("listCards", {})).toEqual([]);
  await client.close();
  expect(await stopped(second, "SIGTERM")).toBe(0);
  expect(existsSync(socketPath)).toBe(false);
});

test("from a subdirectory of a git repository the data directory is <repo root>/.skelcrew/", async () => {
  mkdirSync(join(dir, ".git"));
  const nested = join(dir, "a", "b");
  mkdirSync(nested, { recursive: true });
  const daemon = spawnDaemon({ cwd: nested });
  const socketPath = join(dir, ".skelcrew", "skelcrew.sock");
  expect(await daemon.firstLine()).toBe(`skelcrew daemon ${VERSION} listening on ${socketPath}`);
  expect(mode(join(dir, ".skelcrew"))).toBe(0o700);
  expect(mode(socketPath)).toBe(0o600);
  expect(existsSync(join(dir, ".skelcrew", "skelcrew.db"))).toBe(true);
  expect(existsSync(join(nested, ".skelcrew"))).toBe(false);
  expect(await stopped(daemon, "SIGTERM")).toBe(0);
});

test("a .git file (a worktree) marks the repo root too", async () => {
  writeFileSync(join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
  const nested = join(dir, "sub");
  mkdirSync(nested);
  const daemon = spawnDaemon({ cwd: nested });
  expect(await daemon.firstLine()).toBe(
    `skelcrew daemon ${VERSION} listening on ${join(dir, ".skelcrew", "skelcrew.sock")}`,
  );
  expect(await stopped(daemon, "SIGTERM")).toBe(0);
});

test("outside a git repository with no override it exits 1 and creates nothing", async () => {
  const daemon = spawnDaemon({ cwd: dir });
  expect(await daemon.proc.exited).toBe(1);
  expect(await daemon.stderr()).toContain("not inside a git repository");
  expect(await daemon.stdout()).toBe("");
  expect(readdirSync(dir)).toEqual([]);
});

test("the daemon sweeps a lapsed claim on its own: run_interrupted reaches a subscriber and the claim clears", async () => {
  const socketPath = join(dir, "skelcrew.sock");
  const daemon = spawnDaemon({ cwd: dir, dataDir: dir });
  await daemon.firstLine();
  const ownerClient = await connect(socketPath, { kind: "human" });
  const worker = await connect(socketPath, { kind: "agent", name: "crew-1" });
  const card = await ownerClient.call("createCard", { title: "swept" });
  await ownerClient.call("moveCard", { id: card.id, phase: "spec" });

  let sawInterrupted: (event: Activity) => void = () => {};
  const interrupted = new Promise<Activity>((resolve) => {
    sawInterrupted = resolve;
  });
  await ownerClient.subscribe((event) => {
    if (event.type === "run_interrupted") sawInterrupted(event);
  });

  const claimed = await worker.call("claimCard", { id: card.id, ttlSeconds: 10 });
  const expiresAt = claimed.claim?.expiresAt as number;
  expect(claimed.claim?.ttlSeconds).toBe(10);
  // The worker goes away without releasing: nobody heartbeats, and no client acts.
  await worker.close();

  // Bounded: the lapse plus the 20 s the spec allows the sweep, never longer.
  const budget = expiresAt - Date.now() + 20_000;
  const event = await Promise.race([
    interrupted,
    Bun.sleep(budget).then(() => {
      throw new Error(`no run_interrupted within ${budget} ms`);
    }),
  ]);
  expect(Date.now()).toBeGreaterThanOrEqual(expiresAt);
  expect(event).toMatchObject({
    type: "run_interrupted",
    cardId: card.id,
    actorId: worker.member.id,
    data: { by: worker.member.id, expiresAt },
  });

  const detail = await ownerClient.call("getCard", { id: card.id });
  expect(detail.claim).toBeNull();
  expect(detail.phase).toBe("spec");
  expect(detail.activity.map((e) => e.type)).toEqual([
    "card_created",
    "card_moved",
    "claimed",
    "run_interrupted",
  ]);
  await ownerClient.close();
  expect(await stopped(daemon, "SIGTERM")).toBe(0);
}, 45_000);
