import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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

/** Hermetic git for the daemon's runner and the repo the tests build. */
const GIT_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

/**
 * The runner is off unless a test turns it on: 003's tests are about the socket alone. No
 * test spawns a coding agent: `SKELCREW_AGENT=none` keeps the runner on 006's handoff.
 */
function spawnDaemon(options: {
  cwd: string;
  dataDir?: string;
  runner?: boolean;
  agent?: string;
  mergePollSeconds?: string;
}): Daemon {
  const env: Record<string, string | undefined> = { ...process.env, ...GIT_ENV };
  delete env.SKELCREW_DIR;
  if (options.dataDir) env.SKELCREW_DIR = options.dataDir;
  env.SKELCREW_RUNNER = options.runner ? "1" : "0";
  env.SKELCREW_AGENT = options.agent ?? "none";
  if (options.mergePollSeconds === undefined) delete env.SKELCREW_MERGE_POLL_SECONDS;
  else env.SKELCREW_MERGE_POLL_SECONDS = options.mergePollSeconds;
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

// --- the runner (006) ---

async function sh(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}: ${stderr}`);
  return stdout.trim();
}

/** A repository with one commit on `main`, separate from the data directory. */
async function tempRepo(): Promise<string> {
  const repo = join(dir, "repo");
  mkdirSync(repo);
  await sh(repo, "init", "-q", "-b", "main");
  await sh(repo, "commit", "-q", "--allow-empty", "-m", "init");
  return repo;
}

test("with a temp repo as cwd the runner takes a card moved into spec: a worktree under <dir>/worktrees/1 and a request to the owner", async () => {
  const repo = await tempRepo();
  const data = join(dir, "data");
  const daemon = spawnDaemon({ cwd: repo, dataDir: data, runner: true });
  expect(await daemon.firstLine()).toBe(
    `skelcrew daemon ${VERSION} listening on ${join(data, "skelcrew.sock")}`,
  );
  const client = await connect(join(data, "skelcrew.sock"), { kind: "human" });
  expect((await client.call("listMembers", {})).map((m) => [m.name, m.kind])).toContainEqual([
    "runner",
    "agent",
  ]);

  let sawRequest: (event: Activity) => void = () => {};
  const requested = new Promise<Activity>((resolve) => {
    sawRequest = resolve;
  });
  await client.subscribe((event) => {
    if (event.type === "attention_requested") sawRequest(event);
  });
  const card = await client.call("createCard", { title: "Add login page" });
  await client.call("moveCard", { id: card.id, phase: "spec" });
  const event = await Promise.race([
    requested,
    Bun.sleep(5000).then(() => {
      throw new Error("no attention_requested within 5 s");
    }),
  ]);
  const path = join(data, "worktrees", "1");
  expect(event.type === "attention_requested" && event.data.note).toContain(path);
  expect(event.data).toMatchObject({ to: client.member.id });

  const detail = await client.call("getCard", { id: card.id });
  expect(detail.refs).toEqual({ branch: "skelcrew/1-add-login-page" });
  expect(detail.claim).toBeNull();
  expect(detail.attention?.note).toContain("no playbook for spec");
  expect(existsSync(join(path, ".git"))).toBe(true);
  expect(await sh(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("skelcrew/1-add-login-page");
  expect(await sh(repo, "rev-parse", "skelcrew/1-add-login-page")).toBe(
    await sh(repo, "rev-parse", "main"),
  );
  // The repo's own checkout is untouched.
  expect(await sh(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(existsSync(join(repo, ".skelcrew"))).toBe(false);

  await client.close();
  expect(await stopped(daemon, "SIGTERM")).toBe(0);
  expect(await daemon.stderr()).toBe("");
});

test("with SKELCREW_RUNNER=0 nothing happens to a card moved into spec", async () => {
  const repo = await tempRepo();
  const data = join(dir, "data");
  const daemon = spawnDaemon({ cwd: repo, dataDir: data, runner: false });
  await daemon.firstLine();
  const client = await connect(join(data, "skelcrew.sock"), { kind: "human" });
  expect((await client.call("listMembers", {})).map((m) => m.kind)).toEqual(["human"]);
  const card = await client.call("createCard", { title: "Add login page" });
  await client.call("moveCard", { id: card.id, phase: "spec" });
  await Bun.sleep(500);
  const detail = await client.call("getCard", { id: card.id });
  expect(detail.activity.map((e) => e.type)).toEqual(["card_created", "card_moved"]);
  expect(detail.claim).toBeNull();
  expect(detail.attention).toBeNull();
  expect(existsSync(join(data, "worktrees"))).toBe(false);
  await client.close();
  expect(await stopped(daemon, "SIGTERM")).toBe(0);
});

test("with the data directory inside the repo, a run leaves git status clean: .skelcrew/ ignores itself", async () => {
  const repo = await tempRepo();
  const daemon = spawnDaemon({ cwd: repo, runner: true });
  const data = join(repo, ".skelcrew");
  expect(await daemon.firstLine()).toBe(
    `skelcrew daemon ${VERSION} listening on ${join(data, "skelcrew.sock")}`,
  );
  expect(readFileSync(join(data, ".gitignore"), "utf8")).toBe("*\n");
  const client = await connect(join(data, "skelcrew.sock"), { kind: "human" });
  let sawRequest: () => void = () => {};
  const requested = new Promise<void>((resolve) => {
    sawRequest = resolve;
  });
  await client.subscribe((event) => {
    if (event.type === "attention_requested") sawRequest();
  });
  const card = await client.call("createCard", { title: "Inside the repo" });
  await client.call("moveCard", { id: card.id, phase: "spec" });
  await Promise.race([
    requested,
    Bun.sleep(5000).then(() => {
      throw new Error("no attention_requested within 5 s");
    }),
  ]);
  const path = join(data, "worktrees", "1");
  expect(existsSync(join(path, ".git"))).toBe(true);
  // The owner's checkout sees none of it: not the socket, the database, or the worktree.
  expect(await sh(repo, "status", "--porcelain")).toBe("");
  expect(await sh(repo, "status", "--porcelain", "--ignored")).toContain(".skelcrew/");
  await client.close();
  expect(await stopped(daemon, "SIGTERM")).toBe(0);
});

test("with SKELCREW_DIR set but no repository around the cwd, the daemon serves without a runner and says so", async () => {
  const daemon = spawnDaemon({ cwd: dir, dataDir: dir, runner: true });
  await daemon.firstLine();
  const client = await connect(join(dir, "skelcrew.sock"), { kind: "human" });
  expect((await client.call("listMembers", {})).map((m) => m.kind)).toEqual(["human"]);
  await client.close();
  expect(await stopped(daemon, "SIGTERM")).toBe(0);
  expect(await daemon.stderr()).toContain("runner");
  expect(await daemon.stderr()).toContain("not inside a git repository");
});

// --- the merge poll's interval (018) ---

test("a SKELCREW_MERGE_POLL_SECONDS that is not seconds stops the daemon before it creates anything", async () => {
  const daemon = spawnDaemon({
    cwd: dir,
    dataDir: join(dir, "data"),
    mergePollSeconds: "every minute",
  });
  expect(await daemon.proc.exited).toBe(1);
  expect(await daemon.stderr()).toContain(
    'SKELCREW_MERGE_POLL_SECONDS must be a positive number of seconds, not "every minute"',
  );
  expect(await daemon.stdout()).toBe("");
  expect(existsSync(join(dir, "data"))).toBe(false);
});

// --- the driver selection (012) ---

test("an unknown SKELCREW_AGENT stops the daemon before it creates anything", async () => {
  const daemon = spawnDaemon({ cwd: dir, dataDir: join(dir, "data"), agent: "nope" });
  expect(await daemon.proc.exited).toBe(1);
  expect(await daemon.stderr()).toContain('SKELCREW_AGENT must be "claude" or "none", not "nope"');
  expect(await daemon.stdout()).toBe("");
  expect(existsSync(join(dir, "data"))).toBe(false);
});

test("with SKELCREW_AGENT=claude the daemon loads the driver and its playbooks and serves; with no card, nothing is spawned", async () => {
  const repo = await tempRepo();
  const data = join(dir, "data");
  const daemon = spawnDaemon({ cwd: repo, dataDir: data, runner: true, agent: "claude" });
  expect(await daemon.firstLine()).toBe(
    `skelcrew daemon ${VERSION} listening on ${join(data, "skelcrew.sock")}`,
  );
  const client = await connect(join(data, "skelcrew.sock"), { kind: "human" });
  // Two agent members: the runner, which claims, and the crew, which a spawned agent speaks
  // as. They are two so that the claim's holder and the agent's identity differ (016).
  const members = await client.call("listMembers", {});
  expect(members.filter((m) => m.kind === "agent").map((m) => m.name)).toEqual(["runner", "crew"]);
  expect(await client.call("listCards", {})).toEqual([]);
  await client.close();
  // The agent's `skelcrew` is in place before any run could need it.
  expect(mode(join(data, "bin", "skelcrew")) & 0o111).toBe(0o111);
  expect(await stopped(daemon, "SIGTERM")).toBe(0);
  expect(await daemon.stderr()).toBe("");
});
