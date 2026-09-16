import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
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
const runningThroughShell: ShellDaemon[] = [];

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
  // A daemon under a pseudo-terminal is `script`'s grandchild: killing `script` would leave it
  // running, so every daemon started through a shell is signalled by the pid it recorded.
  for (const daemon of runningThroughShell.splice(0)) {
    daemon.killDaemon("SIGKILL");
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
  /** Merged last: a `PATH` with a shim on it, and whatever that shim needs. */
  env?: Record<string, string>;
}): Daemon {
  const env: Record<string, string | undefined> = { ...process.env, ...GIT_ENV };
  delete env.SKELCREW_DIR;
  if (options.dataDir) env.SKELCREW_DIR = options.dataDir;
  env.SKELCREW_RUNNER = options.runner ? "1" : "0";
  env.SKELCREW_AGENT = options.agent ?? "none";
  if (options.mergePollSeconds === undefined) delete env.SKELCREW_MERGE_POLL_SECONDS;
  else env.SKELCREW_MERGE_POLL_SECONDS = options.mergePollSeconds;
  Object.assign(env, options.env ?? {});
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

// --- an interrupted run's own question (024) ---

/**
 * The daemon's own wiring, not the core's: which member's claims are runs is known only here,
 * where the runner member is created, and `main.ts` hands it to the sweep. Nothing below is
 * faked — a real daemon with the runner on, a real lapse, and the daemon's own sweep timer.
 *
 * The card is set up the way the live runner sets it up: 006's handoff leaves a request the
 * runner member raised, on a card in Spec with no claim, and the runner leaves that card alone
 * while the request is open — so the claim taken here is uncontested. A client that says
 * `runner`/`agent` is that same member, because `ensureMember` is by name and kind.
 */
test("the daemon's sweep takes an interrupted run's own question with it, and the runner takes the card again", async () => {
  const repo = await tempRepo();
  const data = join(dir, "data");
  const socketPath = join(data, "skelcrew.sock");
  const daemon = spawnDaemon({ cwd: repo, dataDir: data, runner: true });
  expect(await daemon.firstLine()).toBe(`skelcrew daemon ${VERSION} listening on ${socketPath}`);
  const owner = await connect(socketPath, { kind: "human" });
  const events: Activity[] = [];
  await owner.subscribe((event) => events.push(event));

  const card = await owner.call("createCard", { title: "Add login page" });
  await owner.call("moveCard", { id: card.id, phase: "spec" });
  await until(
    () => events.find((e) => e.type === "attention_requested"),
    10_000,
    "the runner raised no request",
  );

  const runner = await connect(socketPath, { kind: "agent", name: "runner" });
  const members = await owner.call("listMembers", {});
  expect(members.find((m) => m.name === "runner" && m.kind === "agent")?.id).toBe(runner.member.id);
  const waiting = await owner.call("getCard", { id: card.id });
  expect(waiting.attention?.raisedBy).toBe(runner.member.id);

  // The run that asked goes away with its lease: claimed as the runner, at the shortest TTL
  // the core allows, and never heartbeated.
  const claimed = await runner.call("claimCard", { id: card.id, ttlSeconds: 10 });
  const expiresAt = claimed.claim?.expiresAt as number;
  await runner.close();

  // Bounded: the lapse plus the sweep's interval and some slack, never longer.
  const budget = expiresAt - Date.now() + 20_000;
  const resolved = await until(
    () => events.find((e) => e.type === "attention_resolved"),
    budget,
    "the daemon's sweep withdrew nothing",
  );
  expect(resolved).toMatchObject({
    type: "attention_resolved",
    cardId: card.id,
    actorId: runner.member.id,
    data: { how: "interrupted" },
  });

  // Free in its phase again, so the runner takes it on the next scan; with the request still
  // open it could not have, because a card with one is never ready.
  const retaken = await until(
    () => events.find((e) => e.type === "claimed" && e.seq > resolved.seq),
    10_000,
    "the runner did not take the card again",
  );
  expect(retaken.actorId).toBe(runner.member.id);

  const detail = await owner.call("getCard", { id: card.id });
  const types = detail.activity.map((e) => e.type);
  const lapse = types.indexOf("run_interrupted");
  expect(types[lapse + 1]).toBe("attention_resolved");
  await owner.close();
  expect(await stopped(daemon, "SIGTERM")).toBe(0);
}, 60_000);

test("with SKELCREW_RUNNER=0 a lapse withdraws nothing: there are no runs to withdraw", async () => {
  const socketPath = join(dir, "skelcrew.sock");
  const daemon = spawnDaemon({ cwd: dir, dataDir: dir, runner: false });
  await daemon.firstLine();
  const owner = await connect(socketPath, { kind: "human" });
  const events: Activity[] = [];
  await owner.subscribe((event) => events.push(event));
  // The same member name the daemon's runner would have, and the same shape of request: with
  // no runner the daemon names none, so no claim's holder is a run's.
  const runner = await connect(socketPath, { kind: "agent", name: "runner" });

  const card = await owner.call("createCard", { title: "nobody runs this" });
  await owner.call("moveCard", { id: card.id, phase: "spec" });
  const claimed = await runner.call("claimCard", { id: card.id, ttlSeconds: 10 });
  const expiresAt = claimed.claim?.expiresAt as number;
  await runner.call("requestAttention", {
    id: card.id,
    to: owner.member.id,
    note: "allow Bash(bun test)?",
  });
  await runner.close();

  const budget = expiresAt - Date.now() + 20_000;
  await until(
    () => events.find((e) => e.type === "run_interrupted"),
    budget,
    "the daemon's sweep did not expire the claim",
  );
  const detail = await owner.call("getCard", { id: card.id });
  expect(detail.claim).toBeNull();
  expect(detail.attention?.note).toBe("allow Bash(bun test)?");
  expect(detail.activity.map((e) => e.type)).toEqual([
    "card_created",
    "card_moved",
    "claimed",
    "attention_requested",
    "run_interrupted",
  ]);
  await owner.close();
  expect(await stopped(daemon, "SIGTERM")).toBe(0);
}, 60_000);

// --- the merge poll's interval (018) ---

/**
 * A `gh` of our own, first on `PATH`: it records what the daemon asked it and answers as the
 * real one does (verified field names and casing; `018`'s `forge.ts` records the version). No
 * test runs the real `gh` — this shim is that boundary, the way the fake driver is the agent's.
 */
const GH_SHIM = `#!/bin/sh
echo "$@" >> "$GH_LOG"
case "$1 $2" in
"repo view") echo '{"url":"https://example.invalid/o/r"}' ;;
"pr view") echo '{"baseRefName":"main","headRefName":"x","mergeable":"MERGEABLE","mergedAt":null,"state":"OPEN","url":"https://example.invalid/o/r/pull/1"}' ;;
*) exit 1 ;;
esac
`;

/** Whatever `read` returns first, polled every 50 ms; throws when the deadline passes. */
async function until<T>(read: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what} within ${timeoutMs} ms`);
    await Bun.sleep(50);
  }
}

test("the poll asks gh on its interval, and asks nothing while no card in PR carries a pull request", async () => {
  const repo = await tempRepo();
  const data = join(dir, "data");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "gh.log");
  writeFileSync(join(bin, "gh"), GH_SHIM);
  chmodSync(join(bin, "gh"), 0o755);

  const daemon = spawnDaemon({
    cwd: repo,
    dataDir: data,
    runner: true,
    mergePollSeconds: "1",
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, GH_LOG: log },
  });
  expect(await daemon.firstLine()).toBe(
    `skelcrew daemon ${VERSION} listening on ${join(data, "skelcrew.sock")}`,
  );
  const client = await connect(join(data, "skelcrew.sock"), { kind: "human" });

  // A board that holds the two shapes which must not be polled: a card in PR the owner moved
  // there by hand, and a card with a pull request that is not in PR.
  const byHand = await client.call("createCard", { title: "By hand" });
  await client.call("moveCard", { id: byHand.id, phase: "pr" });
  const elsewhere = await client.call("createCard", { title: "Not in PR" });
  await client.call("setRefs", {
    id: elsewhere.id,
    refs: { prUrl: "https://example.invalid/o/r/pull/9" },
  });

  // Two intervals of that board: no `gh` was ever spawned.
  await Bun.sleep(2200);
  expect(existsSync(log)).toBe(false);

  const card = await client.call("createCard", { title: "Merge me" });
  await client.call("setRefs", {
    id: card.id,
    refs: { prUrl: "https://example.invalid/o/r/pull/1" },
  });
  await client.call("moveCard", { id: card.id, phase: "pr" });

  // Both calls of one tick, in order: the repository first, then the card's pull request. The
  // wait is for the second, since the file exists as soon as the first is written.
  const asked = await until(
    () => {
      const text = existsSync(log) ? readFileSync(log, "utf8") : "";
      return text.includes("pr view") ? text : undefined;
    },
    5000,
    "gh was not asked about the pull request",
  );
  expect(asked).toContain("repo view --json url");
  expect(asked).toContain(
    "pr view https://example.invalid/o/r/pull/1 --json state,mergedAt,headRefName,url",
  );
  // The pull request is open, so nothing happened to the card and nothing was said.
  const detail = await client.call("getCard", { id: card.id });
  expect(detail.phase).toBe("pr");
  expect(detail.activity.filter((e) => e.type === "comment")).toEqual([]);
  await client.close();
  expect(await stopped(daemon, "SIGTERM")).toBe(0);
  expect(await daemon.stderr()).toBe("");
});

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

// --- how many run at once (025) ---

test("a SKELCREW_RUNS that is not a count stops the daemon before it creates anything", async () => {
  const daemon = spawnDaemon({
    cwd: dir,
    dataDir: join(dir, "data"),
    env: { SKELCREW_RUNS: "every" },
  });
  expect(await daemon.proc.exited).toBe(1);
  expect(await daemon.stderr()).toContain(
    'SKELCREW_RUNS must be a positive whole number of runs, not "every"',
  );
  expect(await daemon.stdout()).toBe("");
  expect(existsSync(join(dir, "data"))).toBe(false);
});

/** Every `claimed` and `released` a subscriber saw, in order, as `"<type> <card id>"`. */
function claimsAndReleases(events: Activity[]): string[] {
  return events
    .filter((event) => event.type === "claimed" || event.type === "released")
    .map((event) => `${event.type} ${event.cardId}`);
}

/**
 * The count itself, through the real daemon rather than through `startRunner`'s options: the
 * two tests below are what observes `main.ts` handing the parsed `SKELCREW_RUNS` on, and a
 * daemon that dropped it on the floor and ran with the default would pass every other check.
 *
 * What a slot is worth is on the cards. With `SKELCREW_AGENT=none` a run is 006's handoff —
 * claim, worktree, a request to the owner, release — and the scan claims synchronously while
 * the worktree setup that follows does not, so with two slots both claims land before either
 * run reaches its release, and with one the second card cannot be claimed until the first is
 * released.
 */
test("with SKELCREW_RUNS=1 the daemon claims the second card only after it has released the first", async () => {
  const repo = await tempRepo();
  const data = join(dir, "data");
  const socketPath = join(data, "skelcrew.sock");
  const daemon = spawnDaemon({
    cwd: repo,
    dataDir: data,
    runner: true,
    env: { SKELCREW_RUNS: "1" },
  });
  expect(await daemon.firstLine()).toBe(`skelcrew daemon ${VERSION} listening on ${socketPath}`);
  const owner = await connect(socketPath, { kind: "human" });
  const events: Activity[] = [];
  await owner.subscribe((event) => events.push(event));

  const first = await owner.call("createCard", { title: "Add login page" });
  const second = await owner.call("createCard", { title: "Add a logout button" });
  await owner.call("moveCard", { id: first.id, phase: "spec" });
  await owner.call("moveCard", { id: second.id, phase: "spec" });

  await until(
    () => (events.filter((event) => event.type === "released").length === 2 ? true : undefined),
    20_000,
    "the runner did not finish both cards",
  );
  expect(claimsAndReleases(events)).toEqual([
    `claimed ${first.id}`,
    `released ${first.id}`,
    `claimed ${second.id}`,
    `released ${second.id}`,
  ]);
  // Both were really run: each card is back with the owner, holding its own worktree.
  for (const card of [first, second]) {
    const detail = await owner.call("getCard", { id: card.id });
    expect(detail.attention?.note).toContain(join(data, "worktrees", String(card.id)));
  }

  await owner.close();
  expect(await stopped(daemon, "SIGTERM")).toBe(0);
  expect(await daemon.stderr()).toBe("");
}, 60_000);

test("with SKELCREW_RUNS unset the daemon claims both cards before either is released", async () => {
  const repo = await tempRepo();
  const data = join(dir, "data");
  const socketPath = join(data, "skelcrew.sock");
  const daemon = spawnDaemon({ cwd: repo, dataDir: data, runner: true });
  expect(await daemon.firstLine()).toBe(`skelcrew daemon ${VERSION} listening on ${socketPath}`);
  const owner = await connect(socketPath, { kind: "human" });
  const events: Activity[] = [];
  await owner.subscribe((event) => events.push(event));

  const first = await owner.call("createCard", { title: "Add login page" });
  const second = await owner.call("createCard", { title: "Add a logout button" });
  await owner.call("moveCard", { id: first.id, phase: "spec" });
  await owner.call("moveCard", { id: second.id, phase: "spec" });

  await until(
    () => (events.filter((event) => event.type === "released").length === 2 ? true : undefined),
    20_000,
    "the runner did not finish both cards",
  );
  const seen = claimsAndReleases(events);
  // The claims are in card order, because the scan takes ready cards in id order; which run
  // releases first is the two sessions' business, so only that both claims precede them is read.
  expect(seen.slice(0, 2)).toEqual([`claimed ${first.id}`, `claimed ${second.id}`]);
  expect(seen.slice(2).sort()).toEqual([`released ${first.id}`, `released ${second.id}`]);

  await owner.close();
  expect(await stopped(daemon, "SIGTERM")).toBe(0);
  expect(await daemon.stderr()).toBe("");
}, 60_000);

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

// --- a question is announced (023) ---

/** A notifier that records `(title, text)` pairs to a file instead of notifying anyone. */
function recordingNotifier() {
  const log = join(dir, "notify.log");
  const script = join(dir, "notify.sh");
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\t%s\\n' "$1" "$2" >> "${log}"\n`, { mode: 0o755 });
  return {
    script,
    entries(): string[][] {
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => l.split("\t"));
    },
  };
}

interface ShellDaemon {
  /** The shell the daemon `exec`s into — or `script`, when it holds the pseudo-terminal. */
  proc: ReturnType<typeof Bun.spawn>;
  /** Everything the daemon has written to its standard output so far. */
  stdout(): string;
  /** Everything it has written to its standard error so far. */
  stderr(): string;
  killDaemon(signal: "SIGTERM" | "SIGKILL"): void;
  /** SIGTERM to the daemon; resolves with what the spawned process exits. */
  stop(): Promise<number>;
}

/** Whatever the stream has carried so far, as it arrives. */
function accumulate(stream: ReadableStream<Uint8Array>): () => string {
  let text = "";
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  })();
  return () => text;
}

function readOr(path: string, fallback: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : fallback;
}

/**
 * The same daemon, started through a shell so that its standard output is what the owner's
 * would be: on a pseudo-terminal (`terminal: true`, which is the condition for announcing) or
 * redirected to a file. `script` allocates the terminal; the shell records the daemon's pid
 * (`exec` makes it the shell's own) so a test can signal the daemon rather than `script`; the
 * daemon's stderr goes to a file of its own so the two streams stay apart inside the one
 * terminal. `SKELCREW_NOTIFY` is dropped from the inherited environment first: no test may
 * fire a real notification because the terminal running it had the variable set.
 */
function spawnShellDaemon(options: {
  cwd: string;
  dataDir: string;
  terminal: boolean;
  env?: Record<string, string>;
}): ShellDaemon {
  const env: Record<string, string | undefined> = { ...process.env, ...GIT_ENV };
  env.SKELCREW_DIR = options.dataDir;
  env.SKELCREW_RUNNER = "0";
  env.SKELCREW_AGENT = "none";
  delete env.SKELCREW_MERGE_POLL_SECONDS;
  delete env.SKELCREW_NOTIFY;
  Object.assign(env, options.env ?? {});
  const pidFile = join(dir, "daemon.pid");
  const outFile = join(dir, "daemon.out");
  const errFile = join(dir, "daemon.err");
  const redirect = options.terminal ? "" : `> "${outFile}" `;
  const command = `echo $$ > "${pidFile}"; exec "${process.execPath}" "${MAIN}" ${redirect}2> "${errFile}"`;
  const argv = options.terminal
    ? ["script", "-q", "/dev/null", "/bin/sh", "-c", command]
    : ["/bin/sh", "-c", command];
  const proc = Bun.spawn(argv, {
    cwd: options.cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const fromTerminal = accumulate(proc.stdout as ReadableStream<Uint8Array>);
  const daemon: ShellDaemon = {
    proc,
    stdout: () => (options.terminal ? fromTerminal() : readOr(outFile, "")),
    stderr: () => readOr(errFile, ""),
    killDaemon(signal) {
      if (!existsSync(pidFile)) return;
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      if (!Number.isInteger(pid)) return;
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    },
    async stop() {
      daemon.killDaemon("SIGTERM");
      return proc.exited;
    },
  };
  runningThroughShell.push(daemon);
  return daemon;
}

/** The daemon's `listening on` line, once its standard output has carried it. */
async function listening(daemon: ShellDaemon): Promise<string> {
  return until(
    () => (daemon.stdout().includes("listening on") ? daemon.stdout() : undefined),
    10_000,
    "the daemon did not say it was listening",
  );
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function nonEmpty(line: string): boolean {
  return line.trim().length > 0;
}

test("a daemon in a terminal rings the bell and announces a request raised to the owner", async () => {
  const rec = recordingNotifier();
  const socketPath = join(dir, "skelcrew.sock");
  const daemon = spawnShellDaemon({
    cwd: dir,
    dataDir: dir,
    terminal: true,
    env: { SKELCREW_NOTIFY: rec.script },
  });
  await listening(daemon);

  const owner = await connect(socketPath, { kind: "human" });
  const crew = await connect(socketPath, { kind: "agent", name: "crew-1" });
  const card = await owner.call("createCard", { title: "Add login page" });
  await crew.call("requestAttention", {
    id: card.id,
    to: owner.member.id,
    note: "why: the push needs your say-so\nshall I push the branch?",
  });

  const entries = await until(
    () => (rec.entries().length > 0 ? rec.entries() : undefined),
    5000,
    "the notifier was not invoked",
  );
  expect(entries).toHaveLength(1);
  expect(entries[0]?.[0]).toBe("skelcrew");
  const text = entries[0]?.[1] as string;
  expect(text).toContain(`#${card.id}`);
  expect(text).toContain("Add login page");
  expect(text).toContain("why: the push needs your say-so");
  // One line: what follows the note's first line is on the card, not in the banner.
  expect(text).not.toContain("shall I push the branch?");
  expect(daemon.stdout()).toContain("\x07");

  // A request raised to an agent is not a question for the owner. The one raised after it is,
  // so the absence is read at a point the daemon has demonstrably passed.
  const theirs = await owner.call("createCard", { title: "Theirs" });
  await owner.call("requestAttention", { id: theirs.id, to: crew.member.id, note: "your turn" });
  // A request replacing the card's open one is a new thing to answer, so it is announced again.
  await crew.call("requestAttention", { id: card.id, to: owner.member.id, note: "and now this" });
  const after = await until(
    () => (rec.entries().length > 1 ? rec.entries() : undefined),
    5000,
    "the second request to the owner was not announced",
  );
  expect(after).toHaveLength(2);
  expect(after[1]?.[1]).toContain("and now this");
  expect(after.map((entry) => entry[1]).join("\n")).not.toContain("your turn");

  await owner.close();
  await crew.close();
  expect(await daemon.stop()).toBe(0);
  expect(daemon.stderr()).toBe("");
}, 30_000);

test("a daemon whose stdout is redirected to a file announces nothing: watch is that owner's ping", async () => {
  const rec = recordingNotifier();
  const socketPath = join(dir, "skelcrew.sock");
  const daemon = spawnShellDaemon({
    cwd: dir,
    dataDir: dir,
    terminal: false,
    env: { SKELCREW_NOTIFY: rec.script },
  });
  await listening(daemon);
  const owner = await connect(socketPath, { kind: "human" });
  const crew = await connect(socketPath, { kind: "agent", name: "crew-1" });
  // Whatever is raised: to the owner, which in a terminal would be announced, and to an agent.
  const mine = await owner.call("createCard", { title: "Headless" });
  await crew.call("requestAttention", { id: mine.id, to: owner.member.id, note: "a question" });
  const theirs = await owner.call("createCard", { title: "Theirs" });
  await owner.call("requestAttention", { id: theirs.id, to: crew.member.id, note: "your turn" });

  await Bun.sleep(500);
  expect(rec.entries()).toEqual([]);
  // The request is on the card either way.
  expect((await owner.call("getCard", { id: mine.id })).attention?.note).toBe("a question");

  await owner.close();
  await crew.close();
  expect(await daemon.stop()).toBe(0);
  // No bell, and nothing in the file beside the one line it always prints.
  expect(daemon.stdout()).toBe(`skelcrew daemon ${VERSION} listening on ${socketPath}\n`);
  expect(daemon.stderr()).toBe("");
}, 30_000);

test("SKELCREW_NOTIFY=none turns the announcement off in a terminal too", async () => {
  const socketPath = join(dir, "skelcrew.sock");
  const daemon = spawnShellDaemon({
    cwd: dir,
    dataDir: dir,
    terminal: true,
    env: { SKELCREW_NOTIFY: "none" },
  });
  const started = await listening(daemon);
  const owner = await connect(socketPath, { kind: "human" });
  const crew = await connect(socketPath, { kind: "agent", name: "crew-1" });
  const card = await owner.call("createCard", { title: "Quiet" });
  await crew.call("requestAttention", { id: card.id, to: owner.member.id, note: "a question" });

  await Bun.sleep(500);
  expect((await owner.call("getCard", { id: card.id })).attention?.note).toBe("a question");
  // No bell, which is the daemon's own half of the switch: the shared notifier is off under
  // `none` on its own, but only this file decides whether the terminal rings.
  expect(daemon.stdout()).not.toContain("\x07");
  expect(daemon.stdout().slice(started.length)).toBe("");
  expect(daemon.stderr()).toBe("");

  await owner.close();
  await crew.close();
  expect(await daemon.stop()).toBe(0);
}, 30_000);

test("a notifier that cannot be spawned warns once for the process and keeps the requests", async () => {
  const missing = join(dir, "no-such-notifier.sh");
  const socketPath = join(dir, "skelcrew.sock");
  const daemon = spawnShellDaemon({
    cwd: dir,
    dataDir: dir,
    terminal: true,
    env: { SKELCREW_NOTIFY: missing },
  });
  await listening(daemon);
  const owner = await connect(socketPath, { kind: "human" });
  const crew = await connect(socketPath, { kind: "agent", name: "crew-1" });

  const first = await owner.call("createCard", { title: "First" });
  await crew.call("requestAttention", { id: first.id, to: owner.member.id, note: "one" });
  await until(
    () => (daemon.stderr().includes(missing) ? daemon.stderr() : undefined),
    5000,
    "the failing notifier was not reported",
  );

  const second = await owner.call("createCard", { title: "Second" });
  await crew.call("requestAttention", { id: second.id, to: owner.member.id, note: "two" });
  // Two bells: the daemon has handled both requests, so a second warning would be out by now.
  await until(
    () => (occurrences(daemon.stdout(), "\x07") >= 2 ? true : undefined),
    5000,
    "the second request did not ring the bell",
  );
  await Bun.sleep(300);
  // One line, not one per question: the notifier is missing for every request after the first.
  const warnings = daemon.stderr().split("\n").filter(nonEmpty);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(missing);

  expect((await owner.call("getCard", { id: first.id })).attention?.note).toBe("one");
  expect((await owner.call("getCard", { id: second.id })).attention?.note).toBe("two");

  await owner.close();
  await crew.close();
  expect(await daemon.stop()).toBe(0);
}, 30_000);

test("a notifier that runs and fails is a warning too, and the request is still on the card", async () => {
  const failing = join(dir, "failing-notifier.sh");
  writeFileSync(failing, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  const socketPath = join(dir, "skelcrew.sock");
  const daemon = spawnShellDaemon({
    cwd: dir,
    dataDir: dir,
    terminal: true,
    env: { SKELCREW_NOTIFY: failing },
  });
  await listening(daemon);
  const owner = await connect(socketPath, { kind: "human" });
  const crew = await connect(socketPath, { kind: "agent", name: "crew-1" });

  const card = await owner.call("createCard", { title: "Unpingable" });
  await crew.call("requestAttention", { id: card.id, to: owner.member.id, note: "a question" });
  const warning = await until(
    () => (daemon.stderr().includes(failing) ? daemon.stderr() : undefined),
    5000,
    "the failing notifier was not reported",
  );
  expect(warning).toContain("3");
  expect((await owner.call("getCard", { id: card.id })).attention?.note).toBe("a question");

  await owner.close();
  await crew.close();
  expect(await daemon.stop()).toBe(0);
}, 30_000);
