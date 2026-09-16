import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  type Activity,
  COMMENT_MAX_BYTES,
  connect,
  type Member,
  worktreesDir,
} from "@skelcrew/shared";
import { type Core, openCore } from "../core/core";
import { nothingNeedsTheDaemon } from "../idle";
import { startServer } from "../server/server";
import type { AgentDriver, AgentEvent, AgentRunOptions } from "./agent";
import { createGit, type Git } from "./git";
import { loadPlaybooks } from "./playbooks";
import { type Runner, runsFromEnv, startRunner } from "./runner";

/** Hermetic git: no user config, no hooks, a fixed identity. */
const GIT_ENV: Record<string, string | undefined> = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

let tmp: string;
let repo: string;
let dataDir: string;
let core: Core;
let owner: Member;
let runnerMember: Member;
let runner: Runner | undefined;
let git: Git;
const events: Activity[] = [];
const warnings: string[] = [];

beforeEach(() => {
  // Real path: git prints worktree paths resolved, and macOS's temp dir is a symlink.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "skr-")));
  repo = join(tmp, "repo");
  dataDir = join(tmp, "data");
  mkdirSync(repo);
  mkdirSync(dataDir);
  core = openCore(":memory:", { owner: "simon" });
  owner = core.listMembers()[0] as Member;
  runnerMember = core.ensureMember("runner", "agent");
  git = createGit({ env: GIT_ENV });
  events.length = 0;
  warnings.length = 0;
  core.subscribe((event) => events.push(event));
});

afterEach(async () => {
  await runner?.stop();
  runner = undefined;
  core.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function sh(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}: ${stderr}`);
  return stdout.trim();
}

async function initRepo(branch = "main"): Promise<void> {
  await sh(repo, "init", "-q", "-b", branch);
  await sh(repo, "commit", "-q", "--allow-empty", "-m", "init");
}

async function head(ref: string): Promise<string> {
  return sh(repo, "rev-parse", "--verify", ref);
}

async function branchExists(name: string): Promise<boolean> {
  const out = await sh(repo, "branch", "--list", name);
  return out.length > 0;
}

async function worktreePaths(): Promise<string[]> {
  const out = await sh(repo, "worktree", "list", "--porcelain");
  return out
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function start(
  overrides: { git?: Git; slots?: number; driver?: AgentDriver; onRunSettled?: () => void } = {},
): Runner {
  runner = startRunner({
    core,
    dataDir,
    repoRoot: repo,
    git: overrides.git ?? git,
    member: runnerMember,
    crew: core.ensureMember("crew", "agent"),
    warn: (line) => warnings.push(line),
    ...(overrides.slots === undefined ? {} : { slots: overrides.slots }),
    ...(overrides.onRunSettled === undefined ? {} : { onRunSettled: overrides.onRunSettled }),
    ...(overrides.driver === undefined
      ? {}
      : { agent: { driver: overrides.driver, playbooks: loadPlaybooks() } }),
  });
  return runner;
}

/** Resolves with the first event matching `match`, within the two seconds the spec allows. */
function untilEvent(match: (event: Activity) => boolean, timeoutMs = 2000): Promise<Activity> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`no matching event within ${timeoutMs} ms; saw ${describe(events)}`));
    }, timeoutMs);
    const unsubscribe = core.subscribe((event) => {
      if (!match(event)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}

function released(cardId: number, reason: string): (event: Activity) => boolean {
  return (e) => e.cardId === cardId && e.type === "released" && e.data.reason === reason;
}

function commentContaining(cardId: number, text: string): (event: Activity) => boolean {
  return (e) => e.cardId === cardId && e.type === "comment" && e.data.text.includes(text);
}

function describe(list: Activity[]): string {
  return list.map((e) => `${e.cardId ?? "-"}:${e.type}`).join(" ");
}

function cardEvents(cardId: number): Activity[] {
  return events.filter((e) => e.cardId === cardId);
}

function types(list: Activity[]): string[] {
  return list.map((e) => e.type);
}

function comments(cardId: number): string[] {
  return core
    .getCard(cardId)
    .activity.filter((e) => e.type === "comment")
    .map((e) => (e.data as { text: string }).text);
}

function worktreePath(id: number): string {
  return join(worktreesDir(dataDir), String(id));
}

/** Files a card as the owner and moves it into `spec`, then waits for the run to end. */
async function runCard(title: string, phase: "spec" | "code" = "spec"): Promise<number> {
  const card = core.createCard({ title }, owner.id);
  const done = untilEvent((e) => e.cardId === card.id && e.type === "released");
  core.moveCard(card.id, phase, owner.id);
  await done;
  return card.id;
}

// --- a run with no playbook ---

test("a card moved into spec is claimed, gets a branch and a worktree, and ends waiting on the owner, in order", async () => {
  await initRepo();
  start();
  core.createCard({ title: "Add login page" }, owner.id);
  const done = untilEvent(released(1, "no playbook"));
  core.moveCard(1, "spec", owner.id);
  await done;

  const branch = "skelcrew/1-add-login-page";
  const path = worktreePath(1);
  const card = core.getCard(1);
  const afterMove = card.activity.slice(
    card.activity.findIndex((e) => e.type === "card_moved") + 1,
  );
  expect(types(afterMove)).toEqual([
    "claimed",
    "refs_set",
    "comment",
    "attention_requested",
    "released",
  ]);
  expect(afterMove.every((e) => e.actorId === runnerMember.id)).toBe(true);
  expect(afterMove[0]?.data).toMatchObject({ ttlSeconds: 120 });
  expect(afterMove[4]?.data).toEqual({ reason: "no playbook" });

  expect(await head(`refs/heads/${branch}`)).toBe(await head("refs/heads/main"));
  expect(await worktreePaths()).toContain(path);
  expect(existsSync(join(path, ".git"))).toBe(true);
  expect(await sh(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);

  expect(card.refs).toEqual({ branch });
  expect(card.claim).toBeNull();
  const comment = comments(1)[0] as string;
  expect(comment).toContain(path);
  expect(comment).toContain(branch);
  expect(comment).toContain("from main");
  expect(card.attention).toMatchObject({ to: owner.id, raisedBy: runnerMember.id, moves: [] });
  expect(card.attention?.note).toContain("no playbook for spec");
  expect(card.attention?.note).toContain(path);
  expect(core.listAttention({ to: owner.id }).map((r) => r.cardId)).toEqual([1]);
  expect(warnings).toEqual([]);
});

test("spec to code reuses the branch and the worktree and raises a new request", async () => {
  await initRepo();
  start();
  await runCard("Reuse me");
  const branch = "skelcrew/1-reuse-me";
  const path = worktreePath(1);
  const before = await sh(repo, "branch", "--list");

  const done = untilEvent(released(1, "no playbook"));
  core.moveCard(1, "code", owner.id);
  await done;

  expect(await sh(repo, "branch", "--list")).toBe(before);
  expect((await worktreePaths()).filter((p) => p === path)).toHaveLength(1);
  expect(existsSync(path)).toBe(true);
  const card = core.getCard(1);
  expect(card.refs).toEqual({ branch });
  expect(card.attention?.note).toContain("no playbook for code");
  expect(card.attention?.note).toContain(path);
  const second = card.activity.slice(card.activity.findLastIndex((e) => e.type === "card_moved"));
  expect(types(second)).toEqual([
    "card_moved",
    "attention_resolved",
    "claimed",
    "refs_set",
    "comment",
    "attention_requested",
    "released",
  ]);
  expect(comments(1)).toHaveLength(2);
  expect(comments(1)[1]).toContain(`${path} on ${branch} (from main)`);
});

// --- the base branch ---

test("origin/HEAD names the base: the branch forks from trunk's local head and the comment says so", async () => {
  await initRepo();
  await sh(repo, "checkout", "-q", "-b", "trunk");
  await sh(repo, "commit", "-q", "--allow-empty", "-m", "on trunk");
  // Parked on main, so a branch from HEAD would be wrong.
  await sh(repo, "checkout", "-q", "main");
  await sh(repo, "update-ref", "refs/remotes/origin/trunk", "refs/heads/trunk");
  await sh(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  expect(await head("trunk")).not.toBe(await head("main"));

  start();
  await runCard("From trunk");
  expect(await head("refs/heads/skelcrew/1-from-trunk")).toBe(await head("trunk"));
  expect(comments(1)[0]).toContain("from trunk");
  expect(core.getCard(1).attention?.note).toContain("no playbook");
});

test("with no remote and no main, master is the base", async () => {
  await initRepo("master");
  start();
  await runCard("From master");
  expect(await head("refs/heads/skelcrew/1-from-master")).toBe(await head("master"));
  expect(comments(1)[0]).toContain("from master");
});

test("with none of origin/HEAD, main, or master the run fails naming the missing base", async () => {
  await initRepo("develop");
  start();
  core.createCard({ title: "No base" }, owner.id);
  const done = untilEvent(released(1, "failed"));
  core.moveCard(1, "spec", owner.id);
  await done;

  const card = core.getCard(1);
  const afterMove = card.activity.slice(
    card.activity.findIndex((e) => e.type === "card_moved") + 1,
  );
  expect(types(afterMove)).toEqual(["claimed", "comment", "attention_requested", "released"]);
  const text = comments(1)[0] as string;
  expect(text).toContain("base branch");
  expect(text).toContain("main");
  expect(text).toContain("master");
  expect(text).toContain("origin/HEAD");
  expect(card.attention).toMatchObject({ to: owner.id, note: text, moves: [] });
  expect(card.refs).toEqual({});
  expect(await branchExists("skelcrew/1-no-base")).toBe(false);
  expect(existsSync(worktreePath(1))).toBe(false);

  // Nothing is retried: the card waits on the owner and the runner is idle.
  await Bun.sleep(200);
  expect(types(cardEvents(1)).filter((t) => t === "claimed")).toHaveLength(1);
});

// --- teardown ---

test("moving to pr keeps a dirty worktree with its changed paths, and removes a clean one", async () => {
  await initRepo();
  start();
  await runCard("Dirty one");
  await runCard("Clean one");
  const dirty = worktreePath(1);
  const clean = worktreePath(2);
  writeFileSync(join(dirty, "wip.txt"), "half-written\n");

  const kept = untilEvent(commentContaining(1, "kept"));
  core.moveCard(1, "pr", owner.id);
  const keptText = (await kept).data as { text: string };
  expect(keptText.text).toContain(dirty);
  expect(keptText.text).toContain("wip.txt");
  expect(existsSync(join(dirty, "wip.txt"))).toBe(true);
  expect(await worktreePaths()).toContain(dirty);

  const removed = untilEvent(commentContaining(2, "worktree removed"));
  core.moveCard(2, "pr", owner.id);
  await removed;
  expect(existsSync(clean)).toBe(false);
  expect(await worktreePaths()).not.toContain(clean);
  expect(await branchExists("skelcrew/2-clean-one")).toBe(true);
  expect(await branchExists("skelcrew/1-dirty-one")).toBe(true);
  expect(core.getCard(2).refs).toEqual({ branch: "skelcrew/2-clean-one" });
});

test("a dirty worktree lists at most twenty changed paths", async () => {
  await initRepo();
  start();
  await runCard("Many files");
  const path = worktreePath(1);
  for (let i = 0; i < 25; i += 1)
    writeFileSync(join(path, `f${String(i).padStart(2, "0")}.txt`), "x");
  const kept = untilEvent(commentContaining(1, "kept"));
  core.moveCard(1, "pr", owner.id);
  const text = ((await kept).data as { text: string }).text;
  expect(text.match(/f\d\d\.txt/g)).toHaveLength(20);
  expect(text).toContain("f00.txt");
  expect(text).not.toContain("f24.txt");
  expect(existsSync(path)).toBe(true);
});

/**
 * Criterion 8a, the other trigger: the salvage note is built from filenames as git prints
 * them, and a file may be named anything but `/` and NUL. Posted raw, the core refuses the
 * comment and the record of what was kept is lost to a line on the daemon's stderr.
 */
test("a salvage note naming a file whose name carries an escape lands on the card, escaped", async () => {
  await initRepo();
  start();
  await runCard("Dirty with an escape");
  const path = worktreePath(1);
  const name = "wip\x1b[31m.txt";
  writeFileSync(join(path, name), "half-written\n");

  const kept = untilEvent(commentContaining(1, "kept"));
  core.moveCard(1, "pr", owner.id);
  const text = ((await kept).data as { text: string }).text;

  expect(text).toContain("wip\\x1b[31m.txt");
  expect(text).not.toContain("\x1b");
  expect(existsSync(join(path, name))).toBe(true);
});

test("archiving removes a clean worktree and keeps a dirty one with a comment", async () => {
  await initRepo();
  start();
  await runCard("Archive clean");
  await runCard("Archive dirty");
  const clean = worktreePath(1);
  const dirty = worktreePath(2);
  writeFileSync(join(dirty, "notes.md"), "keep me\n");

  const removed = untilEvent(commentContaining(1, "worktree removed"));
  core.archiveCard(1, owner.id);
  await removed;
  expect(existsSync(clean)).toBe(false);
  expect(await branchExists("skelcrew/1-archive-clean")).toBe(true);

  const kept = untilEvent(commentContaining(2, "kept"));
  core.archiveCard(2, owner.id);
  const text = ((await kept).data as { text: string }).text;
  expect(text).toContain(dirty);
  expect(text).toContain("notes.md");
  expect(existsSync(join(dirty, "notes.md"))).toBe(true);
  expect(core.getCard(2).archivedAt).not.toBeNull();
});

test("a move to a non-claimable phase without a worktree records nothing", async () => {
  await initRepo();
  start();
  core.createCard({ title: "Never ran" }, owner.id);
  core.moveCard(1, "pr", owner.id);
  await Bun.sleep(150);
  expect(types(cardEvents(1))).toEqual(["card_created", "card_moved"]);
  expect(warnings).toEqual([]);
});

// --- one at a time, in id order ---

test("two cards made ready together run in id order, one claim at a time, both ending on the owner", async () => {
  await initRepo();
  // One slot: 006's behaviour, which is what `SKELCREW_RUNS=1` promises (025).
  start({ slots: 1 });
  core.createCard({ title: "First" }, owner.id);
  core.createCard({ title: "Second" }, owner.id);
  let held = 0;
  let maxHeld = 0;
  core.subscribe((e) => {
    if (e.type === "claimed" && e.actorId === runnerMember.id) {
      held += 1;
      maxHeld = Math.max(maxHeld, held);
    }
    if (e.type === "released" && e.actorId === runnerMember.id) held -= 1;
  });
  const both = Promise.all([
    untilEvent(released(1, "no playbook")),
    untilEvent(released(2, "no playbook")),
  ]);
  // Card 2 first, so id order is not arrival order.
  core.moveCard(2, "spec", owner.id);
  core.moveCard(1, "spec", owner.id);
  await both;

  const runs = events.filter((e) => e.actorId === runnerMember.id);
  expect(types(runs)).toEqual([
    "claimed",
    "refs_set",
    "comment",
    "attention_requested",
    "released",
    "claimed",
    "refs_set",
    "comment",
    "attention_requested",
    "released",
  ]);
  expect(runs.map((e) => e.cardId)).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
  expect(maxHeld).toBe(1);
  expect(core.listAttention({ to: owner.id }).map((r) => r.cardId)).toEqual([1, 2]);
  expect(existsSync(worktreePath(1))).toBe(true);
  expect(existsSync(worktreePath(2))).toBe(true);
});

// --- how many run at once, as the daemon reads it (025) ---

test("SKELCREW_RUNS sets how many run at once; unset is two; anything else is refused", () => {
  expect(runsFromEnv({})).toBe(2);
  expect(runsFromEnv({ SKELCREW_RUNS: "" })).toBe(2);
  expect(runsFromEnv({ SKELCREW_RUNS: "1" })).toBe(1);
  expect(runsFromEnv({ SKELCREW_RUNS: "3" })).toBe(3);
  for (const bad of ["0", "-1", "1.5", "abc", " "]) {
    expect(() => runsFromEnv({ SKELCREW_RUNS: bad })).toThrow(/SKELCREW_RUNS/);
  }
});

// --- several at once (025) ---

/**
 * The agent, scripted: whatever the test's generator does is the whole session. No test here
 * spawns a coding agent or calls a model — the driver is that boundary, as in `run.test.ts`.
 */
function fakeDriver(script: (options: AgentRunOptions) => AsyncGenerator<AgentEvent>): AgentDriver {
  return { run: (options) => script(options) };
}

/** Which card a session belongs to: the run gives it that card's worktree as its cwd. */
function cardOf(options: AgentRunOptions): number {
  return Number(basename(options.cwd));
}

/** Holds every caller until `count` of them have arrived: what two sessions overlapping means. */
function barrier(count: number): () => Promise<void> {
  let release: () => void = () => {};
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived = 0;
  return () => {
    arrived += 1;
    if (arrived >= count) release();
    return open;
  };
}

/** A session per card that stays live until the test ends it. */
function holds(): { wait(id: number): Promise<void>; end(id: number): void } {
  const open = new Map<number, { wait: Promise<void>; end: () => void }>();
  const entry = (id: number): { wait: Promise<void>; end: () => void } => {
    const found = open.get(id);
    if (found !== undefined) return found;
    let end: () => void = () => {};
    const wait = new Promise<void>((resolve) => {
      end = resolve;
    });
    const made = { wait, end };
    open.set(id, made);
    return made;
  };
  return {
    wait: (id) => entry(id).wait,
    end: (id) => {
      entry(id).end();
    },
  };
}

/** Resolves when the run tells the agent to stop. */
function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Waits until `check` holds: what a scripted session having started is read with. */
async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${what} within ${timeoutMs} ms`);
    await Bun.sleep(10);
  }
}

function ended(cardId: number): (event: Activity) => boolean {
  return (e) => e.cardId === cardId && e.type === "released";
}

function asked(cardId: number): (event: Activity) => boolean {
  return (e) => e.cardId === cardId && e.type === "attention_requested";
}

/** The run log named by a run-start comment. */
function logPathFrom(comment: string): string {
  const at = comment.indexOf("run log at ");
  expect(at).toBeGreaterThanOrEqual(0);
  return comment.slice(at + "run log at ".length).trim();
}

test("with two slots, three cards ready together: two run at once and the third fills the freed slot", async () => {
  await initRepo();
  const gated = gatedGit();
  start({ git: gated.git, slots: 2 });
  core.createCard({ title: "First" }, owner.id);
  core.createCard({ title: "Second" }, owner.id);
  core.createCard({ title: "Third" }, owner.id);
  let held = 0;
  let maxHeld = 0;
  core.subscribe((e) => {
    if (e.type === "claimed" && e.actorId === runnerMember.id) {
      held += 1;
      maxHeld = Math.max(maxHeld, held);
    }
    if (e.type === "released" && e.actorId === runnerMember.id) held -= 1;
  });
  const secondClaimed = untilEvent((e) => e.cardId === 2 && e.type === "claimed");
  const all = Promise.all([
    untilEvent(released(1, "no playbook")),
    untilEvent(released(2, "no playbook")),
    untilEvent(released(3, "no playbook")),
  ]);
  core.moveCard(3, "spec", owner.id);
  core.moveCard(2, "spec", owner.id);
  core.moveCard(1, "spec", owner.id);

  // Both runs are held inside git: two claims at once, and the third card still queued.
  await secondClaimed;
  expect(core.getCard(1).claim?.by).toBe(runnerMember.id);
  expect(core.getCard(3).claim).toBeNull();
  expect(types(events.filter((e) => e.actorId === runnerMember.id))).not.toContain("released");

  gated.open();
  await all;
  expect(maxHeld).toBe(2);
  const runs = events.filter((e) => e.actorId === runnerMember.id);
  const firstRelease = types(runs).indexOf("released");
  const claimedThird = runs.findIndex((e) => e.cardId === 3 && e.type === "claimed");
  expect(runs.findIndex((e) => e.cardId === 2 && e.type === "claimed")).toBeLessThan(firstRelease);
  expect(claimedThird).toBeGreaterThan(firstRelease);
  expect(core.listAttention({ to: owner.id }).map((r) => r.cardId)).toEqual([1, 2, 3]);
  for (const id of [1, 2, 3]) expect(existsSync(join(worktreePath(id), ".git"))).toBe(true);
  expect(warnings).toEqual([]);
});

/**
 * Real git, recording when each call that takes the repository's lock is entered and left.
 * `holdBranchMs` keeps `createBranch` inside its call that much longer, which is how a test
 * says "while this run is in setup" without depending on how long git takes.
 */
function recordingGit(base: Git, calls: string[], holdBranchMs = 0): Git {
  const around =
    <A extends unknown[]>(name: string, call: (...args: A) => Promise<void>, holdMs = 0) =>
    async (...args: A): Promise<void> => {
      calls.push(`enter ${name}`);
      try {
        await call(...args);
        if (holdMs > 0) await Bun.sleep(holdMs);
      } finally {
        calls.push(`exit ${name}`);
      }
    };
  return {
    ...base,
    createBranch: around("createBranch", base.createBranch, holdBranchMs),
    worktreeAdd: around("worktreeAdd", base.worktreeAdd),
    worktreePrune: around("worktreePrune", base.worktreePrune),
    worktreeRemove: around("worktreeRemove", base.worktreeRemove),
  };
}

/** The calls that were still in flight when the next one began; none, when nothing overlapped. */
function overlapping(calls: string[]): string[] {
  return calls.filter((entry, index) => {
    if (index % 2 === 1) return false;
    return calls[index + 1] !== `exit ${entry.slice("enter ".length)}`;
  });
}

test("with two slots the branch and worktree calls never overlap, while the two sessions do", async () => {
  await initRepo();
  const calls: string[] = [];
  const sessions: string[] = [];
  const both = barrier(2);
  start({
    git: recordingGit(git, calls),
    slots: 2,
    driver: fakeDriver(async function* (options) {
      sessions.push(`live ${cardOf(options)}`);
      await both();
      sessions.push(`done ${cardOf(options)}`);
      yield { type: "result", ok: true };
    }),
  });
  core.createCard({ title: "First" }, owner.id);
  core.createCard({ title: "Second" }, owner.id);
  const done = Promise.all([untilEvent(ended(1), 5000), untilEvent(ended(2), 5000)]);
  core.moveCard(1, "spec", owner.id);
  core.moveCard(2, "spec", owner.id);
  await done;

  // One card in setup at a time: every entry is closed before the next is made.
  expect(calls).toEqual([
    "enter createBranch",
    "exit createBranch",
    "enter worktreeAdd",
    "exit worktreeAdd",
    "enter createBranch",
    "exit createBranch",
    "enter worktreeAdd",
    "exit worktreeAdd",
  ]);
  // And the sessions overlapped: neither could pass the barrier until both were live.
  expect(sessions.slice(0, 2).sort()).toEqual(["live 1", "live 2"]);
  expect(sessions.slice(2).sort()).toEqual(["done 1", "done 2"]);
});

test("a teardown's removal waits for a run's setup: the two never hold the repository at once", async () => {
  await initRepo();
  const calls: string[] = [];
  const hold = holds();
  const live: number[] = [];
  start({
    // Card 3's branch is held long enough that a removal running beside it would show.
    git: recordingGit(git, calls, 300),
    slots: 2,
    driver: fakeDriver(async function* (options) {
      const id = cardOf(options);
      live.push(id);
      await Promise.race([hold.wait(id), aborted(options.signal)]);
      yield { type: "result", ok: true };
    }),
  });
  core.createCard({ title: "Torn down later" }, owner.id);
  core.createCard({ title: "Holds the pump" }, owner.id);
  core.createCard({ title: "Starts next" }, owner.id);

  // Card 1 runs and ends on the owner, leaving its worktree.
  const first = untilEvent(ended(1), 5000);
  core.moveCard(1, "spec", owner.id);
  await until(() => live.includes(1), "card 1's session live");
  hold.end(1);
  await first;
  expect(existsSync(join(worktreePath(1), ".git"))).toBe(true);

  // Card 2's run is live; moving it away parks the pump in its teardown, which waits for
  // that run. The three jobs behind it are queued in one turn: a scan (card 3 is ready) and
  // then card 1's teardown.
  core.moveCard(2, "spec", owner.id);
  await until(() => live.includes(2), "card 2's session live");
  core.moveCard(2, "pr", owner.id);
  core.moveCard(3, "spec", owner.id);
  core.archiveCard(1, owner.id);

  // The scan starts card 3's run, and card 1's removal is the job behind it.
  const removed = untilEvent(commentContaining(1, "worktree removed"), 5000);
  await removed;
  await until(() => live.includes(3), "card 3's session live");
  expect(overlapping(calls)).toEqual([]);
  expect(existsSync(worktreePath(1))).toBe(false);
  expect(existsSync(join(worktreePath(3), ".git"))).toBe(true);
});

test("a teardown whose card came back does not hold the pump for that card's new run", async () => {
  await initRepo();
  const hold = holds();
  const live: number[] = [];
  start({
    slots: 2,
    driver: fakeDriver(async function* (options) {
      const id = cardOf(options);
      live.push(id);
      await Promise.race([hold.wait(id), aborted(options.signal)]);
      yield { type: "result", ok: true };
    }),
  });
  core.createCard({ title: "Holds the pump" }, owner.id);
  core.createCard({ title: "Out and back" }, owner.id);
  core.createCard({ title: "Still queued" }, owner.id);
  core.moveCard(1, "spec", owner.id);
  await until(() => live.includes(1), "card 1's session live");

  // In one turn, while the pump waits in card 1's teardown for card 1's run: card 2 out of a
  // claimable phase and back, so a scan is queued with card 2's teardown behind it.
  core.moveCard(1, "pr", owner.id);
  core.moveCard(2, "spec", owner.id);
  core.moveCard(2, "pr", owner.id);
  core.moveCard(2, "spec", owner.id);

  // That scan starts card 2's new run, and the teardown behind it is card 2's own: it has
  // nothing to remove and must not wait for the run it found.
  await until(() => live.includes(2), "card 2's session live");
  const claimed = untilEvent((e) => e.cardId === 3 && e.type === "claimed", 5000);
  core.moveCard(3, "spec", owner.id);
  await claimed;
  expect(existsSync(join(worktreePath(2), ".git"))).toBe(true);
  expect(comments(2).some((text) => text.includes("worktree removed"))).toBe(false);
});

test("with two live runs a card moved to done is abandoned, torn down after its run, and the other goes on", async () => {
  await initRepo();
  const hold = holds();
  const live: number[] = [];
  const returned: number[] = [];
  start({
    slots: 2,
    driver: fakeDriver(async function* (options) {
      const id = cardOf(options);
      live.push(id);
      await Promise.race([hold.wait(id), aborted(options.signal)]);
      // A session that does not vanish the instant it is told to stop, so that a teardown
      // which did not wait for the run would reach the worktree first rather than merely
      // lose a race with git. Well inside the abort grace.
      if (options.signal.aborted) await Bun.sleep(150);
      returned.push(id);
      yield { type: "result", ok: true };
    }),
  });
  core.createCard({ title: "Moved to done" }, owner.id);
  core.createCard({ title: "Carries on" }, owner.id);
  core.moveCard(1, "spec", owner.id);
  core.moveCard(2, "spec", owner.id);
  await until(() => live.length === 2, "two sessions live");

  const abandoned = untilEvent(commentContaining(1, "run abandoned"), 5000);
  const removed = untilEvent(commentContaining(1, "worktree removed"), 5000);
  core.moveCard(1, "done", owner.id);
  await abandoned;
  await removed;

  // The teardown followed the abandonment, and the session it waited for had returned.
  const said = comments(1);
  const abandonedAt = said.findIndex((text) => text.startsWith("run abandoned"));
  expect(abandonedAt).toBeGreaterThanOrEqual(0);
  expect(said[abandonedAt + 1]).toBe("worktree removed");
  expect(returned).toEqual([1]);
  expect(existsSync(worktreePath(1))).toBe(false);

  // Card 2's run is untouched: its own comment, its own claim, its session still live.
  expect(comments(2)).toHaveLength(1);
  expect(core.getCard(2).claim?.by).toBe(runnerMember.id);
  expect(types(cardEvents(2))).not.toContain("released");

  const done = untilEvent(ended(2), 5000);
  hold.end(2);
  await done;
  expect(returned).toEqual([1, 2]);
  expect(existsSync(join(worktreePath(2), ".git"))).toBe(true);
});

test("stop() ends both live runs as 'daemon stopping' and resolves only once both sessions have returned", async () => {
  await initRepo();
  const live: number[] = [];
  const returned: number[] = [];
  start({
    slots: 2,
    driver: fakeDriver(async function* (options) {
      live.push(cardOf(options));
      await aborted(options.signal);
      returned.push(cardOf(options));
      yield { type: "result", ok: true };
    }),
  });
  core.createCard({ title: "First" }, owner.id);
  core.createCard({ title: "Second" }, owner.id);
  core.moveCard(1, "spec", owner.id);
  core.moveCard(2, "spec", owner.id);
  await until(() => live.length === 2, "two sessions live");

  await (runner as Runner).stop();
  runner = undefined;
  expect([...returned].sort()).toEqual([1, 2]);
  for (const id of [1, 2]) {
    expect(comments(id).some((text) => text.includes("run aborted: daemon stopping"))).toBe(true);
    expect(core.getCard(id).claim).toBeNull();
    expect(types(cardEvents(id))).toContain("released");
  }
});

test("two live runs keep their own run log and their own permission question", async () => {
  await initRepo();
  const live: number[] = [];
  const decided: string[] = [];
  start({
    slots: 2,
    driver: fakeDriver(async function* (options) {
      const id = cardOf(options);
      live.push(id);
      const decision = await options.canUseTool("Bash", { command: `rm -rf build-${id}` });
      decided.push(`${id}:${decision.behavior}`);
      yield { type: "result", ok: true };
    }),
  });
  core.createCard({ title: "Asks first" }, owner.id);
  core.createCard({ title: "Asks too" }, owner.id);
  const questions = Promise.all([untilEvent(asked(1), 5000), untilEvent(asked(2), 5000)]);
  core.moveCard(1, "spec", owner.id);
  core.moveCard(2, "spec", owner.id);
  await questions;

  const first = core.getCard(1).attention?.note as string;
  const second = core.getCard(2).attention?.note as string;
  expect(first).toContain("rm -rf build-1");
  expect(first).not.toContain("rm -rf build-2");
  expect(second).toContain("rm -rf build-2");
  expect(second).not.toContain("rm -rf build-1");

  const logs = [1, 2].map((id) => logPathFrom(comments(id)[0] as string));
  expect(logs[0]).not.toBe(logs[1]);
  expect(basename(logs[0] as string).startsWith("1-")).toBe(true);
  expect(basename(logs[1] as string).startsWith("2-")).toBe(true);
  expect(existsSync(logs[0] as string)).toBe(true);
  expect(existsSync(logs[1] as string)).toBe(true);

  const done = Promise.all([untilEvent(ended(1), 5000), untilEvent(ended(2), 5000)]);
  core.resolveAttention(1, "allow", owner.id);
  core.resolveAttention(2, "no", owner.id);
  await done;
  expect([...decided].sort()).toEqual(["1:allow", "2:deny"]);
});

// --- the not-ready rule ---

test("a card with an open attention request is not run until the request resolves", async () => {
  await initRepo();
  core.createCard({ title: "Held" }, owner.id);
  core.moveCard(1, "spec", owner.id);
  core.requestAttention(1, { to: owner.id, note: "hold on" }, owner.id);
  start();
  await Bun.sleep(250);
  expect(types(cardEvents(1))).not.toContain("claimed");
  expect(existsSync(worktreePath(1))).toBe(false);

  const done = untilEvent(released(1, "no playbook"));
  core.resolveAttention(1, undefined, owner.id);
  await done;
  expect(existsSync(worktreePath(1))).toBe(true);
  expect(core.getCard(1).attention?.note).toContain("no playbook for spec");
});

// --- startup reconciliation ---

test("at startup a clean worktree of an archived card is removed and a dirty one is kept with a comment", async () => {
  await initRepo();
  start();
  await runCard("Left clean");
  await runCard("Left dirty");
  await (runner as Runner).stop();
  runner = undefined;
  // With the runner gone nobody tears down.
  core.archiveCard(1, owner.id);
  core.archiveCard(2, owner.id);
  writeFileSync(join(worktreePath(2), "salvage.txt"), "x");
  expect(existsSync(worktreePath(1))).toBe(true);

  const removed = untilEvent(commentContaining(1, "worktree removed"));
  const kept = untilEvent(commentContaining(2, "kept"));
  start();
  await removed;
  const text = ((await kept).data as { text: string }).text;
  expect(existsSync(worktreePath(1))).toBe(false);
  expect(existsSync(join(worktreePath(2), "salvage.txt"))).toBe(true);
  expect(text).toContain(worktreePath(2));
  expect(text).toContain("salvage.txt");
  expect(await branchExists("skelcrew/1-left-clean")).toBe(true);
});

test("at startup a worktree of a card in a non-claimable phase is torn down before any run", async () => {
  await initRepo();
  start();
  await runCard("Moved on");
  await (runner as Runner).stop();
  runner = undefined;
  core.moveCard(1, "pr", owner.id);
  core.createCard({ title: "Waiting to run" }, owner.id);
  core.moveCard(2, "spec", owner.id);

  const removed = untilEvent(commentContaining(1, "worktree removed"));
  const ran = untilEvent(released(2, "no playbook"));
  const restart = events.length;
  start();
  await removed;
  await ran;
  const runnerEvents = events.slice(restart).filter((e) => e.actorId === runnerMember.id);
  expect(runnerEvents[0]?.cardId).toBe(1);
  expect(runnerEvents[0]?.type).toBe("comment");
  expect(existsSync(worktreePath(1))).toBe(false);
  expect(existsSync(worktreePath(2))).toBe(true);
});

test("at startup a claim left by runner is released as 'daemon restarted' and the card then runs", async () => {
  await initRepo();
  core.createCard({ title: "Stale claim" }, owner.id);
  core.moveCard(1, "spec", owner.id);
  core.claimCard(1, {}, runnerMember.id);
  expect(core.getCard(1).claim?.by).toBe(runnerMember.id);

  const done = untilEvent(released(1, "no playbook"));
  start();
  await done;
  const runnerEvents = cardEvents(1).filter((e) => e.actorId === runnerMember.id);
  expect(types(runnerEvents)).toEqual([
    "claimed",
    "released",
    "claimed",
    "refs_set",
    "comment",
    "attention_requested",
    "released",
  ]);
  expect(runnerEvents[1]?.data).toEqual({ reason: "daemon restarted" });
  expect(existsSync(worktreePath(1))).toBe(true);
});

test("at startup an entry that is not a git worktree on a claimable card is reported and left alone; the next run fails on it", async () => {
  await initRepo();
  core.createCard({ title: "Occupied" }, owner.id);
  core.moveCard(1, "spec", owner.id);
  core.requestAttention(1, { to: owner.id, note: "hold" }, owner.id);
  const path = worktreePath(1);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "stray.txt"), "not ours\n");

  const reported = untilEvent(commentContaining(1, path));
  start();
  await reported;
  expect(existsSync(join(path, "stray.txt"))).toBe(true);
  expect(types(cardEvents(1))).not.toContain("claimed");

  const failed = untilEvent(released(1, "failed"));
  core.resolveAttention(1, undefined, owner.id);
  await failed;
  const text = comments(1).at(-1) as string;
  expect(text).toContain("worktree");
  expect(text).toContain(path);
  expect(core.getCard(1).attention?.note).toBe(text);
  expect(existsSync(join(path, "stray.txt"))).toBe(true);
  expect(await branchExists("skelcrew/1-occupied")).toBe(true);
});

test("at startup an entry whose card no longer exists is torn down with the outcome on stderr", async () => {
  await initRepo();
  start();
  await runCard("Gone");
  await (runner as Runner).stop();
  runner = undefined;
  // A fresh core: card 1 does not exist there, the worktree does.
  core.close();
  core = openCore(":memory:", { owner: "simon" });
  owner = core.listMembers()[0] as Member;
  runnerMember = core.ensureMember("runner", "agent");
  const path = worktreePath(1);
  expect(existsSync(path)).toBe(true);

  const second = start();
  await second.stop();
  runner = undefined;
  expect(existsSync(path)).toBe(false);
  expect(warnings.some((w) => w.includes(path) && w.includes("removed"))).toBe(true);
});

test("at startup an entry named '01' is not card 1's: it is handled as having no card, on stderr", async () => {
  await initRepo();
  core.createCard({ title: "Not zero-one" }, owner.id);
  core.moveCard(1, "spec", owner.id);
  core.requestAttention(1, { to: owner.id, note: "hold" }, owner.id);
  const stray = join(worktreesDir(dataDir), "01");
  mkdirSync(stray, { recursive: true });
  writeFileSync(join(stray, "stray.txt"), "not ours\n");

  const first = start();
  await first.stop();
  runner = undefined;
  expect(existsSync(join(stray, "stray.txt"))).toBe(true);
  expect(existsSync(worktreePath(1))).toBe(false);
  expect(comments(1)).toEqual([]);
  expect(cardEvents(1).some((e) => e.actorId === runnerMember.id)).toBe(false);
  expect(warnings.some((w) => w.includes(stray) && w.includes("not a git worktree"))).toBe(true);
});

// --- git failure ---

test("with git unavailable the run fails with a comment and a request, and the runner keeps going", async () => {
  await initRepo();
  const noGit = join(tmp, "empty-path");
  mkdirSync(noGit);
  start({ git: createGit({ env: { ...GIT_ENV, PATH: noGit } }) });
  core.createCard({ title: "No git" }, owner.id);
  const done = untilEvent(released(1, "failed"));
  core.moveCard(1, "spec", owner.id);
  await done;

  const text = comments(1)[0] as string;
  expect(text).toContain("git");
  expect(text.toLowerCase()).toContain("not found");
  expect(core.getCard(1).attention).toMatchObject({ to: owner.id, note: text });
  expect(existsSync(worktreePath(1))).toBe(false);

  // The next card is still processed.
  core.createCard({ title: "Also no git" }, owner.id);
  const again = untilEvent(released(2, "failed"));
  core.moveCard(2, "spec", owner.id);
  await again;
  expect(core.listAttention({ to: owner.id }).map((r) => r.cardId)).toEqual([1, 2]);
});

test("stop() waits for the run in flight and takes no further card", async () => {
  await initRepo();
  // One slot, so the second card is the one that never starts (025).
  start({ slots: 1 });
  core.createCard({ title: "In flight" }, owner.id);
  core.createCard({ title: "Never started" }, owner.id);
  const claimed = untilEvent((e) => e.cardId === 1 && e.type === "claimed");
  core.moveCard(1, "spec", owner.id);
  core.moveCard(2, "spec", owner.id);
  await claimed;
  await (runner as Runner).stop();
  runner = undefined;
  expect(core.getCard(1).claim).toBeNull();
  expect(core.getCard(1).attention?.note).toContain("no playbook");
  expect(types(cardEvents(2))).toEqual(["card_created", "card_moved"]);
  await Bun.sleep(100);
  expect(types(cardEvents(2))).toEqual(["card_created", "card_moved"]);
});

// --- review round 1 ---

/** The real git with `defaultBranch` held until the test opens the gate; `fail` makes it throw then. */
function gatedGit(options: { fail?: string } = {}): { git: Git; open(): void } {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    git: {
      ...git,
      async defaultBranch(root) {
        await gate;
        if (options.fail !== undefined) throw new Error(options.fail);
        return git.defaultBranch(root);
      },
    },
    open,
  };
}

test("a run whose claim is lost while it awaits git is abandoned: nothing is posted on the card", async () => {
  await initRepo();
  const gated = gatedGit();
  start({ git: gated.git });
  core.createCard({ title: "Moved on mid-run" }, owner.id);
  const claimed = untilEvent((e) => e.cardId === 1 && e.type === "claimed");
  core.moveCard(1, "spec", owner.id);
  await claimed;
  // The owner moves the card on while the run is inside git: the move releases the claim.
  core.moveCard(1, "pr", owner.id);
  const abandoned = untilEvent(commentContaining(1, "run abandoned"));
  gated.open();
  await abandoned;
  await Bun.sleep(150);

  const card = core.getCard(1);
  expect(card.refs).toEqual({});
  expect(card.attention).toBeNull();
  expect(card.claim).toBeNull();
  expect(types(card.activity)).toEqual([
    "card_created",
    "card_moved",
    "claimed",
    "card_moved",
    "released",
    "comment",
  ]);
  expect(card.activity[4]?.data).toEqual({ reason: "moved" });
  expect(existsSync(worktreePath(1))).toBe(false);
  expect(warnings).toEqual([]);
});

test("a run whose card another member claims mid-run leaves their card alone", async () => {
  await initRepo();
  const gated = gatedGit();
  start({ git: gated.git });
  const crew = core.ensureMember("crew-1", "agent");
  core.createCard({ title: "Taken over" }, owner.id);
  const claimed = untilEvent((e) => e.cardId === 1 && e.type === "claimed");
  core.moveCard(1, "spec", owner.id);
  await claimed;
  core.releaseCard(1, { reason: "taking it by hand" }, owner.id);
  core.claimCard(1, {}, crew.id);
  const abandoned = untilEvent(commentContaining(1, "run abandoned"));
  gated.open();
  await abandoned;
  await Bun.sleep(150);

  const card = core.getCard(1);
  expect(card.claim?.by).toBe(crew.id);
  expect(card.refs).toEqual({});
  expect(card.attention).toBeNull();
  const byRunner = card.activity.filter((e) => e.actorId === runnerMember.id);
  expect(types(byRunner)).toEqual(["claimed", "comment"]);
  expect(warnings).toEqual([]);
});

test("a run whose card is archived mid-run is abandoned and its worktree torn down", async () => {
  await initRepo();
  const gated = gatedGit();
  start({ git: gated.git });
  core.createCard({ title: "Archived mid-run" }, owner.id);
  const claimed = untilEvent((e) => e.cardId === 1 && e.type === "claimed");
  core.moveCard(1, "spec", owner.id);
  await claimed;
  core.archiveCard(1, owner.id);
  const abandoned = untilEvent(commentContaining(1, "run abandoned"));
  gated.open();
  await abandoned;
  await Bun.sleep(150);

  const card = core.getCard(1);
  expect(card.refs).toEqual({});
  expect(card.attention).toBeNull();
  expect(comments(1).some((text) => text.includes("failed"))).toBe(false);
  expect(existsSync(worktreePath(1))).toBe(false);
});

test("an existing directory whose worktree entry is prunable is not reused: the run fails on it", async () => {
  await initRepo();
  start();
  await runCard("Broken worktree");
  const path = worktreePath(1);
  rmSync(join(path, ".git"));
  writeFileSync(join(path, "left.txt"), "x");

  const failed = untilEvent(released(1, "failed"));
  core.moveCard(1, "code", owner.id);
  await failed;
  const text = comments(1).at(-1) as string;
  expect(text).toContain("add worktree failed");
  expect(text).toContain(path);
  expect(existsSync(join(path, "left.txt"))).toBe(true);
});

test("a kept-worktree comment with long paths stays within the comment cap", async () => {
  await initRepo();
  start();
  await runCard("Deep paths");
  const path = worktreePath(1);
  const deep = Array.from({ length: 6 }, (_, i) => `${String(i)}${"d".repeat(60)}`).join("/");
  mkdirSync(join(path, deep), { recursive: true });
  for (let i = 0; i < 20; i += 1) writeFileSync(join(path, deep, `f${i}.txt`), "x");

  const kept = untilEvent(commentContaining(1, "kept"));
  core.moveCard(1, "pr", owner.id);
  const text = ((await kept).data as { text: string }).text;
  expect(text.length).toBeLessThanOrEqual(COMMENT_MAX_BYTES / 4 + 1);
  expect(text).toContain(path);
  expect(comments(1).some((c) => c.includes("teardown failed"))).toBe(false);
  expect(existsSync(path)).toBe(true);
});

// --- review round 2 ---

test("a git failure after the claim was lost posts only 'run abandoned': no request, no release", async () => {
  await initRepo();
  const gated = gatedGit({ fail: "remote hung up" });
  start({ git: gated.git });
  core.createCard({ title: "Moved then failed" }, owner.id);
  const claimed = untilEvent((e) => e.cardId === 1 && e.type === "claimed");
  core.moveCard(1, "spec", owner.id);
  await claimed;
  core.moveCard(1, "pr", owner.id);
  const abandoned = untilEvent(commentContaining(1, "run abandoned"));
  gated.open();
  await abandoned;
  await Bun.sleep(150);

  const card = core.getCard(1);
  expect(card.attention).toBeNull();
  expect(card.phase).toBe("pr");
  expect(types(card.activity)).toEqual([
    "card_created",
    "card_moved",
    "claimed",
    "card_moved",
    "released",
    "comment",
  ]);
  expect(comments(1).some((c) => c.includes("failed"))).toBe(false);
  expect(warnings).toEqual([]);
});

test("a git failure after another member claimed the card leaves their card alone", async () => {
  await initRepo();
  const gated = gatedGit({ fail: "remote hung up" });
  start({ git: gated.git });
  const crew = core.ensureMember("crew-1", "agent");
  core.createCard({ title: "Taken then failed" }, owner.id);
  const claimed = untilEvent((e) => e.cardId === 1 && e.type === "claimed");
  core.moveCard(1, "spec", owner.id);
  await claimed;
  core.releaseCard(1, { reason: "by hand" }, owner.id);
  core.claimCard(1, {}, crew.id);
  const abandoned = untilEvent(commentContaining(1, "run abandoned"));
  gated.open();
  await abandoned;
  await Bun.sleep(150);

  const card = core.getCard(1);
  expect(card.claim?.by).toBe(crew.id);
  expect(card.attention).toBeNull();
  const byRunner = card.activity.filter((e) => e.actorId === runnerMember.id);
  expect(types(byRunner)).toEqual(["claimed", "comment"]);
  expect(warnings).toEqual([]);
});

test("a teardown queued behind a scan does nothing once the card is claimable again", async () => {
  await initRepo();
  const gated = gatedGit();
  start({ git: gated.git });
  core.createCard({ title: "Busy" }, owner.id);
  core.createCard({ title: "Back and forth" }, owner.id);
  const claimed = untilEvent((e) => e.cardId === 1 && e.type === "claimed");
  core.moveCard(1, "spec", owner.id);
  await claimed;
  // While the pump is inside card 1's run: card 2 into spec (a scan queues), out to pr (a
  // teardown queues behind it), and back into spec.
  core.moveCard(2, "spec", owner.id);
  core.moveCard(2, "pr", owner.id);
  core.moveCard(2, "spec", owner.id);
  const ran = untilEvent(released(2, "no playbook"));
  gated.open();
  await ran;
  await Bun.sleep(200);

  const card = core.getCard(2);
  expect(card.phase).toBe("spec");
  expect(card.attention?.note).toContain(worktreePath(2));
  expect(existsSync(join(worktreePath(2), ".git"))).toBe(true);
  expect(comments(2).some((c) => c.includes("removed"))).toBe(false);
  expect(warnings).toEqual([]);
});

test("a claim that lapsed by the injected clock during git is treated as lost: the run is abandoned", async () => {
  await initRepo();
  let offsetMs = 0;
  const now = () => Date.now() + offsetMs;
  core.close();
  core = openCore(":memory:", { owner: "simon", now });
  owner = core.listMembers()[0] as Member;
  runnerMember = core.ensureMember("runner", "agent");
  core.subscribe((event) => events.push(event));
  const gated = gatedGit();
  runner = startRunner({
    core,
    dataDir,
    repoRoot: repo,
    git: gated.git,
    member: runnerMember,
    crew: core.ensureMember("crew", "agent"),
    warn: (line) => warnings.push(line),
    now,
  });
  core.createCard({ title: "Lapsed mid-run" }, owner.id);
  const claimed = untilEvent((e) => e.cardId === 1 && e.type === "claimed");
  core.moveCard(1, "spec", owner.id);
  await claimed;
  offsetMs = 121_000;
  const abandoned = untilEvent(commentContaining(1, "run abandoned"));
  gated.open();
  const text = ((await abandoned).data as { text: string }).text;
  await Bun.sleep(150);
  expect(text).toContain("lapsed");
  const card = core.getCard(1);
  expect(card.refs).toEqual({});
  expect(card.attention).toBeNull();
  expect(types(card.activity)).toEqual(["card_created", "card_moved", "claimed", "comment"]);
});

test("a kept-worktree comment is bounded in bytes, with the ellipsis inside the budget", async () => {
  await initRepo();
  start();
  await runCard("Wide names");
  const path = worktreePath(1);
  // Four-byte characters: a listing far over the budget by bytes, not by characters.
  for (let i = 0; i < 20; i += 1) writeFileSync(join(path, `${i}-${"😀".repeat(60)}.txt`), "x");
  const kept = untilEvent(commentContaining(1, "kept"));
  core.moveCard(1, "pr", owner.id);
  const text = ((await kept).data as { text: string }).text;
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(COMMENT_MAX_BYTES / 4);
  expect(text.endsWith("…")).toBe(true);
  expect(text.includes("�")).toBe(false);
  // The path as it is on disk, not git's C-quoted rendering of it (`"0-\360\237\230\200…"`).
  expect(text).toContain(`0-${"😀".repeat(60)}.txt`);
  expect(comments(1).some((c) => c.includes("teardown failed"))).toBe(false);
});

test("readiness uses the injected clock: a claim lapsed by that clock is claimed over", async () => {
  await initRepo();
  let offsetMs = 0;
  const now = () => Date.now() + offsetMs;
  core.close();
  core = openCore(":memory:", { owner: "simon", now });
  owner = core.listMembers()[0] as Member;
  runnerMember = core.ensureMember("runner", "agent");
  core.subscribe((event) => events.push(event));
  const crew = core.ensureMember("crew-1", "agent");
  core.createCard({ title: "Lapsed" }, owner.id);
  core.moveCard(1, "spec", owner.id);
  core.claimCard(1, { ttlSeconds: 10 }, crew.id);
  // Eleven seconds later by the shared clock, no sweep yet: the claim is lapsed but visible.
  offsetMs = 11_000;
  expect(core.getCard(1).claim?.by).toBe(crew.id);

  const done = untilEvent(released(1, "no playbook"));
  runner = startRunner({
    core,
    dataDir,
    repoRoot: repo,
    git,
    member: runnerMember,
    crew: core.ensureMember("crew", "agent"),
    warn: (line) => warnings.push(line),
    now,
  });
  await done;
  const runnerEvents = cardEvents(1).filter(
    (e) => e.type === "run_interrupted" || e.type === "claimed",
  );
  expect(types(runnerEvents)).toEqual(["claimed", "run_interrupted", "claimed"]);
  expect(runnerEvents[1]?.actorId).toBe(crew.id);
  expect(runnerEvents[2]?.actorId).toBe(runnerMember.id);
});

// --- the daemon the screen started, while a run is live (030) ---

/**
 * "`q` with runs in flight leaves them to finish, and the daemon exits when the last one ends
 * with nobody connected" — over the real socket, the real runner, and `nothingNeedsTheDaemon`
 * between them, the way `main.ts` joins them.
 *
 * Here the run is held open *at its agent session*, which is the shape a spawned daemon cannot
 * be put into: no test spawns a coding agent, and a driver that exists only for a test would be
 * a switch in production code. A run held open in git — a real run of a daemon started as the
 * owner starts it — is `server/process.test.ts`, and that is what observes `main.ts`'s own
 * wiring of this rule.
 */
test("with a run live the idle rule holds the daemon through the last client leaving, and fires when the run ends", async () => {
  await initRepo();
  const socketPath = join(tmp, "skelcrew.sock");
  /** Why the rule fired, each time it did — what `main.ts` turns into `shutdown()`. */
  const stops: string[] = [];
  let clients = () => 0;
  let clientsEver = () => 0;
  let runs = () => 0;
  const stopIfIdle = (when: string): void => {
    const counts = { clients: clients(), clientsEver: clientsEver(), runs: runs() };
    if (nothingNeedsTheDaemon(counts)) stops.push(when);
  };
  const server = startServer({
    core,
    socketPath,
    reserved: [runnerMember.name],
    onClientClosed: () => stopIfIdle("a client left"),
  });
  clients = () => server.clients();
  clientsEver = () => server.clientsEver();
  const hold = holds();
  const live: number[] = [];
  const running = start({
    driver: fakeDriver(async function* (options) {
      const id = cardOf(options);
      live.push(id);
      await Promise.race([hold.wait(id), aborted(options.signal)]);
      yield { type: "result", ok: true };
    }),
    onRunSettled: () => stopIfIdle("a run ended"),
  });
  runs = () => running.liveRuns();

  try {
    const screen = await connect(socketPath, { kind: "human" });
    core.createCard({ title: "Left running" }, owner.id);
    expect(running.liveRuns()).toBe(0);

    const done = untilEvent(ended(1), 5000);
    core.moveCard(1, "spec", owner.id);
    await until(() => live.includes(1), "card 1's session live");
    expect(running.liveRuns()).toBe(1);

    // `q` over a live run: the screen goes, the run stays, and so does the daemon.
    await screen.close();
    await until(() => server.clients() === 0, "the screen's connection to be gone");
    expect(stops).toEqual([]);
    expect(running.liveRuns()).toBe(1);

    // And when the last run ends with nobody connected, nothing needs the daemon.
    hold.end(1);
    await done;
    await until(() => stops.length > 0, "the rule to fire");
    expect(stops).toEqual(["a run ended"]);
    expect(running.liveRuns()).toBe(0);
  } finally {
    server.stop();
  }
});
