import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Activity, type Member, VERSION, worktreesDir } from "@skelcrew/shared";
import { type Core, openCore } from "../core/core";
import type { AgentDriver, AgentEvent, AgentRunOptions } from "./agent";
import { FIXED_ALLOWLIST } from "./allowlist";
import { createGit, type Git } from "./git";
import { loadPlaybooks } from "./playbooks";
import { runLimitFromEnv } from "./run";
import { type Runner, type RunnerOptions, startRunner } from "./runner";

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

const PLAYBOOKS = { spec: "# spec playbook\n\nskelcrew attention", code: "# code playbook" };
const PR = "https://github.com/skelcrew/skelcrew/pull/42";

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
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "skp-")));
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

async function initRepo(): Promise<void> {
  await sh(repo, "init", "-q", "-b", "main");
  await sh(repo, "commit", "-q", "--allow-empty", "-m", "init");
}

function worktreePath(id: number): string {
  return join(worktreesDir(dataDir), String(id));
}

/** A driver whose events come from a script; records what it was started with. */
interface Scripted {
  driver: AgentDriver;
  runs: AgentRunOptions[];
}

function scripted(
  script: (options: AgentRunOptions) => AsyncIterable<AgentEvent> | Iterable<AgentEvent>,
): Scripted {
  const runs: AgentRunOptions[] = [];
  return {
    runs,
    driver: {
      async *run(options) {
        runs.push(options);
        // The transcript is the driver's, as it is for the real one: what this fake
        // receives is exactly the events it yields, so each is written once.
        for await (const event of script(options)) {
          options.log(event);
          yield event;
        }
      },
    },
  };
}

function start(overrides: Partial<RunnerOptions> = {}): Runner {
  runner = startRunner({
    core,
    dataDir,
    repoRoot: repo,
    git,
    member: runnerMember,
    warn: (line) => warnings.push(line),
    playbooks: PLAYBOOKS,
    ...overrides,
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

function attentionOn(cardId: number): (event: Activity) => boolean {
  return (e) => e.cardId === cardId && e.type === "attention_requested";
}

function describe(list: Activity[]): string {
  return list.map((e) => `${e.cardId ?? "-"}:${e.type}`).join(" ");
}

function types(list: Activity[]): string[] {
  return list.map((e) => e.type);
}

function textOf(event: Activity | undefined): string {
  if (event?.type !== "comment") throw new Error(`not a comment: ${event?.type ?? "none"}`);
  return event.data.text;
}

function comments(cardId: number): string[] {
  return core
    .getCard(cardId)
    .activity.filter((e) => e.type === "comment")
    .map(textOf);
}

/** The card's activity after its last move. */
function afterLastMove(cardId: number): Activity[] {
  const activity = core.getCard(cardId).activity;
  return activity.slice(activity.findLastIndex((e) => e.type === "card_moved") + 1);
}

const RUN_LOG_IN_COMMENT = /run log at (\S+\.jsonl)/;

function runLogPath(cardId: number): string {
  const first = comments(cardId)[0] as string;
  const match = RUN_LOG_IN_COMMENT.exec(first);
  if (match === null) throw new Error(`no run log path in first comment: ${first}`);
  return match[1] as string;
}

/** Every run log path the card's comments announce: one per run, in the order they ran. */
function runLogPaths(cardId: number): string[] {
  return comments(cardId).flatMap((text) => {
    const match = RUN_LOG_IN_COMMENT.exec(text);
    return match === null ? [] : [match[1] as string];
  });
}

function eventsIn(path: string): AgentEvent[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AgentEvent);
}

function runLog(cardId: number): AgentEvent[] {
  return eventsIn(runLogPath(cardId));
}

/** Files a card as the owner, moves it into `phase`, and waits for the run to end with `reason`. */
async function runCard(title: string, phase: "spec" | "code", reason: string): Promise<void> {
  core.createCard({ title }, owner.id);
  const done = untilEvent(released(1, reason));
  core.moveCard(1, phase, owner.id);
  await done;
}

// --- the spec contract ---

test("a spec run: log path in the first comment, one comment per text turn, then `spec ready` and `finished`", async () => {
  await initRepo();
  const { driver } = scripted(function* () {
    yield { type: "text", text: "Reading the card." };
    core.setBody(1, "# Spec\n\nGoal.", runnerMember.id);
    yield { type: "text", text: "Spec written." };
    yield { type: "result", ok: true };
  });
  start({ driver });
  core.createCard({ title: "Add login page" }, owner.id);
  const done = untilEvent(released(1, "finished"));
  core.moveCard(1, "spec", owner.id);
  await done;

  const card = core.getCard(1);
  const after = afterLastMove(1);
  expect(types(after)).toEqual([
    "claimed",
    "refs_set",
    "comment",
    "comment",
    "body_set",
    "comment",
    "attention_requested",
    "released",
  ]);
  expect(after.every((e) => e.actorId === runnerMember.id)).toBe(true);
  const path = worktreePath(1);
  const texts = comments(1);
  expect(texts[0]).toContain(`worktree ready at ${path} on skelcrew/1-add-login-page (from main)`);
  expect(texts[0]).toContain(`run log at ${join(dataDir, "runs")}/1-`);
  expect(texts.slice(1)).toEqual(["Reading the card.", "Spec written."]);
  expect(card.body).toBe("# Spec\n\nGoal.");
  expect(card.phase).toBe("spec");
  expect(card.attention).toMatchObject({ to: owner.id, note: "spec ready", moves: ["code"] });
  expect(card.claim).toBeNull();
  expect(after.at(-1)?.data).toEqual({ reason: "finished" });

  expect(existsSync(runLogPath(1))).toBe(true);
  expect(runLog(1)).toEqual([
    { type: "text", text: "Reading the card." },
    { type: "text", text: "Spec written." },
    { type: "result", ok: true },
  ]);
  expect(warnings).toEqual([]);
});

test("the same script without the body write: `run finished without a spec`, no moves, `failed`, still in spec", async () => {
  await initRepo();
  const { driver } = scripted(function* () {
    yield { type: "text", text: "Reading the card." };
    yield { type: "text", text: "Done, I think." };
    yield { type: "result", ok: true };
  });
  start({ driver });
  // A body from before the run does not count: the run itself must set it.
  core.createCard({ title: "Stale body", body: "old idea" }, owner.id);
  const done = untilEvent(released(1, "failed"));
  core.moveCard(1, "spec", owner.id);
  await done;

  const card = core.getCard(1);
  expect(types(afterLastMove(1))).toEqual([
    "claimed",
    "refs_set",
    "comment",
    "comment",
    "comment",
    "comment",
    "attention_requested",
    "released",
  ]);
  expect(comments(1).at(-1)).toBe("run finished without a spec");
  expect(card.attention).toMatchObject({
    to: owner.id,
    note: "run finished without a spec",
    moves: [],
  });
  expect(card.phase).toBe("spec");
  expect(card.body).toBe("old idea");
  expect(card.claim).toBeNull();
});

test("a body set by the owner during the run is not the runner's spec", async () => {
  await initRepo();
  const { driver } = scripted(function* () {
    core.setBody(1, "# the owner typed this", owner.id);
    yield { type: "result", ok: true };
  });
  start({ driver });
  await runCard("Owner writes", "spec", "failed");
  expect(comments(1).at(-1)).toBe("run finished without a spec");
});

// --- the code contract ---

test("a code run that commits, leaves the worktree clean, and records a PR: commits on the refs, `ready for review`, `finished`", async () => {
  await initRepo();
  const { driver } = scripted(async function* () {
    const path = worktreePath(1);
    writeFileSync(join(path, "feature.ts"), "export const x = 1;\n");
    await sh(path, "add", "feature.ts");
    await sh(path, "commit", "-q", "-m", "feat: one");
    await sh(path, "commit", "-q", "--allow-empty", "-m", "feat: two");
    core.setRefs(1, { prUrl: PR }, runnerMember.id);
    yield { type: "text", text: "PR opened." };
    yield { type: "result", ok: true };
  });
  start({ driver });
  await runCard("Ship it", "code", "finished");

  const branch = "skelcrew/1-ship-it";
  const newest = await sh(repo, "rev-parse", branch);
  const older = await sh(repo, "rev-parse", `${branch}~1`);
  const card = core.getCard(1);
  expect(card.refs).toEqual({ branch, prUrl: PR, commits: [newest, older] });
  expect(card.attention).toMatchObject({
    to: owner.id,
    note: `ready for review: ${PR}`,
    moves: ["pr"],
  });
  expect(card.phase).toBe("code");
  expect(card.claim).toBeNull();
  // The playbook's prUrl, its comment, then the runner's commits, the handoff, the release.
  expect(types(afterLastMove(1)).slice(-5)).toEqual([
    "refs_set",
    "comment",
    "refs_set",
    "attention_requested",
    "released",
  ]);
  expect(warnings).toEqual([]);
});

test("a code run with no commits fails naming that condition; the worktree stays", async () => {
  await initRepo();
  const { driver } = scripted(function* () {
    core.setRefs(1, { prUrl: PR }, runnerMember.id);
    yield { type: "result", ok: true };
  });
  start({ driver });
  await runCard("Nothing committed", "code", "failed");

  const card = core.getCard(1);
  const last = comments(1).at(-1) as string;
  expect(last).toBe("run finished with no commits on skelcrew/1-nothing-committed past main");
  expect(card.attention).toMatchObject({ to: owner.id, note: last, moves: [] });
  expect(card.refs.commits).toBeUndefined();
  expect(card.phase).toBe("code");
  expect(existsSync(join(worktreePath(1), ".git"))).toBe(true);
});

test("a code run with uncommitted changes fails naming that condition; the dirty worktree is left in place", async () => {
  await initRepo();
  const { driver } = scripted(async function* () {
    const path = worktreePath(1);
    await sh(path, "commit", "-q", "--allow-empty", "-m", "feat");
    writeFileSync(join(path, "half-done.ts"), "// wip\n");
    core.setRefs(1, { prUrl: PR }, runnerMember.id);
    yield { type: "result", ok: true };
  });
  start({ driver });
  await runCard("Half done", "code", "failed");

  const path = worktreePath(1);
  const last = comments(1).at(-1) as string;
  expect(last).toBe(`run finished with uncommitted changes in the worktree at ${path}`);
  expect(core.getCard(1).attention?.note).toBe(last);
  expect(existsSync(join(path, "half-done.ts"))).toBe(true);
  expect(core.getCard(1).refs.commits).toBeUndefined();
});

test("a code run without a prUrl ref fails naming that condition", async () => {
  await initRepo();
  const { driver } = scripted(async function* () {
    await sh(worktreePath(1), "commit", "-q", "--allow-empty", "-m", "feat");
    yield { type: "result", ok: true };
  });
  start({ driver });
  await runCard("No PR", "code", "failed");
  const last = comments(1).at(-1) as string;
  expect(last).toBe("run finished with no prUrl ref set during the run");
  expect(core.getCard(1).attention?.note).toBe(last);
  expect(core.getCard(1).refs).toEqual({ branch: "skelcrew/1-no-pr" });
});

test("every unmet condition is named, and a prUrl carried onto the card is not one this run set", async () => {
  await initRepo();
  const { driver } = scripted(function* () {
    writeFileSync(join(worktreePath(1), "half-done.ts"), "// wip\n");
    yield { type: "result", ok: true };
  });
  start({ driver });
  core.createCard({ title: "Old PR" }, owner.id);
  core.setRefs(1, { prUrl: PR }, owner.id);
  const done = untilEvent(released(1, "failed"));
  core.moveCard(1, "code", owner.id);
  await done;
  expect(comments(1).at(-1)).toBe(
    `run finished with no commits on skelcrew/1-old-pr past main; uncommitted changes in the worktree at ${worktreePath(1)}; no prUrl ref set during the run`,
  );
});

// --- excerpts ---

test("a text turn over 2 KiB is posted cut with a marker; five tool events make one summary; the log has all", async () => {
  await initRepo();
  const long = `${"x".repeat(2047)}é${"y".repeat(1000)}`;
  const { driver } = scripted(function* () {
    yield { type: "text", text: long };
    yield { type: "tool_use", name: "Read", input: { file_path: "a.ts" } };
    yield { type: "tool_use", name: "Bash", input: { command: "bun test" } };
    yield { type: "tool_result", text: "ok" };
    yield { type: "tool_use", name: "Read", input: { file_path: "b.ts" } };
    yield { type: "tool_use", name: "Edit", input: { file_path: "a.ts" } };
    yield { type: "tool_use", name: "Grep", input: { pattern: "x" } };
    yield { type: "result", ok: true };
  });
  start({ driver });
  await runCard("Chatty", "spec", "failed");

  const posted = comments(1);
  // The 2048th byte would split `é`, so the cut lands before it: 2047 bytes, then the marker.
  expect(posted[1]).toBe(
    `${"x".repeat(2047)}\n… [truncated: ${Buffer.byteLength(long, "utf8")} bytes; the full text is in the run log]`,
  );
  expect(posted[2]).toBe("ran 5 tools: Read ×2, Bash `bun test`, Edit, Grep");
  expect(posted).toHaveLength(4);
  const log = runLog(1);
  expect(log.filter((e) => e.type === "tool_use")).toHaveLength(5);
  expect(log[0]).toEqual({ type: "text", text: long });
  expect(log).toHaveLength(8);
});

// --- comments reach the agent ---

test("a comment by the owner during a live run reaches the driver as a user message; one by runner does not", async () => {
  await initRepo();
  const { driver } = scripted(async function* (options) {
    const input = options.input[Symbol.asyncIterator]();
    const first = await input.next();
    yield { type: "text", text: `prompt: ${first.value}` };
    const second = await input.next();
    yield { type: "text", text: `heard: ${second.value}` };
    yield { type: "result", ok: true };
  });
  start({ driver });
  core.createCard({ title: "Talk to me", body: "the idea" }, owner.id);
  const started = untilEvent(commentContaining(1, "prompt:"));
  core.moveCard(1, "spec", owner.id);
  await started;
  core.comment(1, "runner's own note", runnerMember.id);
  core.comment(1, "please also cover logout", owner.id);
  const heard = await untilEvent(commentContaining(1, "heard:"));
  expect(heard.data).toEqual({ text: "heard: please also cover logout" });
  expect(comments(1)[1]).toBe(
    "prompt: Card 1: Talk to me\nBranch: skelcrew/1-talk-to-me (from main)\n\nthe idea",
  );
  await untilEvent(released(1, "failed"));
});

// --- approvals ---

/** A driver that asks once and reports the decision it got, then what (if anything) came next. */
function asking(command: string): Scripted {
  return scripted(async function* (options) {
    const decision = await options.canUseTool("Bash", { command });
    if (options.signal.aborted) return;
    yield { type: "text", text: `decision: ${JSON.stringify(decision)}` };
    const input = options.input[Symbol.asyncIterator]();
    await input.next(); // the card
    const next = await Promise.race([
      input.next().then((r) => (r.done ? "closed" : r.value)),
      Bun.sleep(100).then(() => "nothing"),
    ]);
    yield { type: "text", text: `next: ${next}` };
    yield { type: "result", ok: true };
  });
}

test("a tool outside the allowlist asks the owner; `resolve -m allow` allows and the run continues; the answer is not forwarded", async () => {
  await initRepo();
  const { driver } = asking("rm -rf build\nls");
  start({ driver, heartbeatMs: 50 });
  core.createCard({ title: "Ask" }, owner.id);
  const asked = untilEvent(attentionOn(1));
  core.moveCard(1, "spec", owner.id);
  const request = await asked;
  expect(request.data).toMatchObject({
    to: owner.id,
    note: "allow Bash rm -rf build ls? (skelcrew resolve 1 -m allow | skelcrew resolve 1 -m deny)",
    moves: [],
  });
  expect(core.getCard(1).attention?.note.startsWith("allow Bash")).toBe(true);

  // Waiting, the run keeps its claim alive: the expiry moves forward.
  const before = core.getCard(1).claim?.expiresAt as number;
  await Bun.sleep(120);
  expect(core.getCard(1).claim?.expiresAt).toBeGreaterThan(before);
  expect(core.getCard(1).claim?.by).toBe(runnerMember.id);

  core.resolveAttention(1, "allow", owner.id);
  await untilEvent(released(1, "failed"));
  const posted = comments(1);
  expect(posted).toContain('decision: {"behavior":"allow"}');
  expect(posted).toContain("next: nothing");
  expect(posted).toContain("allow");
});

test("`resolve -m no` denies with `no` as the reason", async () => {
  await initRepo();
  const { driver } = asking("curl evil");
  start({ driver });
  core.createCard({ title: "Ask" }, owner.id);
  const asked = untilEvent(attentionOn(1));
  core.moveCard(1, "spec", owner.id);
  await asked;
  core.resolveAttention(1, "no", owner.id);
  await untilEvent(released(1, "failed"));
  expect(comments(1)).toContain('decision: {"behavior":"deny","message":"no"}');
});

test("any other answer denies with the text as the reason; no text denies too", async () => {
  await initRepo();
  const { driver } = asking("make deploy");
  start({ driver });
  core.createCard({ title: "Ask" }, owner.id);
  const asked = untilEvent(attentionOn(1));
  core.moveCard(1, "spec", owner.id);
  await asked;
  core.resolveAttention(1, "not on this branch, use the script", owner.id);
  await untilEvent(released(1, "failed"));
  expect(comments(1)).toContain(
    'decision: {"behavior":"deny","message":"not on this branch, use the script"}',
  );

  const second = asking("make deploy");
  await runner?.stop();
  start({ driver: second.driver });
  core.createCard({ title: "Ask again" }, owner.id);
  const askedAgain = untilEvent(attentionOn(2));
  core.moveCard(2, "spec", owner.id);
  await askedAgain;
  core.resolveAttention(2, undefined, owner.id);
  await untilEvent(released(2, "failed"));
  expect(comments(2)).toContain('decision: {"behavior":"deny","message":"denied"}');
});

test("resolving the question by moving the card aborts the run: one `run abandoned` comment, the claim released by the move", async () => {
  await initRepo();
  const { driver } = asking("bun x thing");
  start({ driver });
  core.createCard({ title: "Move instead" }, owner.id);
  const asked = untilEvent(attentionOn(1));
  core.moveCard(1, "spec", owner.id);
  await asked;
  const abandoned = untilEvent(commentContaining(1, "run abandoned"));
  core.moveCard(1, "idea", owner.id);
  await abandoned;
  await Bun.sleep(150);

  const card = core.getCard(1);
  const afterMove = afterLastMove(1);
  expect(types(afterMove).slice(0, 2)).toEqual(["released", "attention_resolved"]);
  expect(afterMove[0]?.data).toEqual({ reason: "moved" });
  const runPosts = afterMove.filter((e) => e.actorId === runnerMember.id);
  expect(runPosts.map((e) => e.type)).toEqual(["comment", "comment"]);
  expect(textOf(runPosts[0])).toContain("run abandoned");
  expect(textOf(runPosts[1])).toBe("worktree removed");
  expect(card.attention).toBeNull();
  expect(card.claim).toBeNull();
  expect(card.phase).toBe("idea");
  expect(comments(1).some((c) => c.startsWith("decision:"))).toBe(false);
});

// --- the time limit, and the claim ---

/** A driver that never ends on its own: it returns only when its signal fires. */
function endless(): Scripted & { aborted: () => boolean } {
  let fired = false;
  const script = scripted(async function* (options) {
    yield { type: "text", text: "working…" };
    await new Promise<void>((resolve) => {
      if (options.signal.aborted) resolve();
      else options.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    fired = true;
  });
  return { ...script, aborted: () => fired };
}

test("with the limit at one second and a driver that never ends, the run is aborted, says so, and the card waits on the owner", async () => {
  await initRepo();
  const driver = endless();
  start({ driver: driver.driver, runLimitMs: 1000 });
  core.createCard({ title: "Forever" }, owner.id);
  const done = untilEvent(released(1, "failed"), 4000);
  core.moveCard(1, "spec", owner.id);
  await done;
  expect(driver.aborted()).toBe(true);
  const card = core.getCard(1);
  const note = "run aborted: time limit of 1 second reached";
  expect(comments(1).at(-1)).toBe(note);
  expect(card.attention).toMatchObject({ to: owner.id, note, moves: [] });
  expect(card.phase).toBe("spec");
  expect(card.claim).toBeNull();
});

test("moving the card as the owner during a live run aborts the driver: one `run abandoned` comment and nothing else from the run", async () => {
  await initRepo();
  const driver = endless();
  start({ driver: driver.driver });
  core.createCard({ title: "Moved on" }, owner.id);
  const working = untilEvent(commentContaining(1, "working…"));
  core.moveCard(1, "spec", owner.id);
  await working;
  const abandoned = untilEvent(commentContaining(1, "run abandoned"));
  core.moveCard(1, "pr", owner.id);
  await abandoned;
  await Bun.sleep(150);

  expect(driver.aborted()).toBe(true);
  const card = core.getCard(1);
  const afterMove = afterLastMove(1);
  expect(types(afterMove)).toEqual(["released", "comment", "comment"]);
  expect(afterMove[0]?.data).toEqual({ reason: "moved" });
  expect(textOf(afterMove[1])).toBe("run abandoned: claim lost; card is in pr");
  expect(textOf(afterMove[2])).toBe("worktree removed");
  expect(card.attention).toBeNull();
  expect(card.claim).toBeNull();
  expect(warnings).toEqual([]);
});

// --- error results ---

test("an error result is a failed run carrying the error; a driver that throws, or ends without a result, likewise", async () => {
  await initRepo();
  const { driver } = scripted(function* () {
    yield { type: "result", ok: false, error: "error_max_turns" };
  });
  start({ driver });
  await runCard("Errs", "spec", "failed");
  expect(comments(1).at(-1)).toBe("run failed: error_max_turns");
  expect(core.getCard(1).attention?.note).toBe("run failed: error_max_turns");
  expect(core.getCard(1).phase).toBe("spec");

  await runner?.stop();
  start({
    driver: {
      // biome-ignore lint/correctness/useYield: a driver that fails before its first event
      async *run() {
        throw new Error("claude not found");
      },
    },
  });
  core.createCard({ title: "Throws" }, owner.id);
  const threw = untilEvent(released(2, "failed"));
  core.moveCard(2, "spec", owner.id);
  await threw;
  expect(comments(2).at(-1)).toBe("run failed: claude not found");

  await runner?.stop();
  start({ driver: scripted(function* () {}).driver });
  core.createCard({ title: "Silent" }, owner.id);
  const silent = untilEvent(released(3, "failed"));
  core.moveCard(3, "spec", owner.id);
  await silent;
  expect(comments(3).at(-1)).toBe("run failed: the agent ended without a result");
});

// --- what the driver is given ---

test("the driver gets the playbook for the phase, the card as its first message, the allowlist, and the runner's environment", async () => {
  await initRepo();
  writeFileSync(join(repo, "AGENTS.md"), "```\nbun run check\n```\n");
  const playbooks = loadPlaybooks();
  expect(playbooks.spec.length).toBeGreaterThan(0);
  expect(playbooks.code.length).toBeGreaterThan(0);
  expect(playbooks.spec).toContain("skelcrew attention");
  expect(playbooks.code).toContain("skelcrew attention");

  // The card is one message, the first of the stream the driver reads — not a second copy
  // alongside it.
  const firstMessages: string[] = [];
  const { driver, runs } = scripted(async function* (options) {
    const first = await options.input[Symbol.asyncIterator]().next();
    firstMessages.push(String(first.value));
    yield { type: "result", ok: true };
  });
  start({ driver, playbooks, env: { PATH: "/usr/bin", HOME: "/home/simon" } });
  core.createCard({ title: "Inputs", body: "## Goal\n\nSomething." }, owner.id);
  const spec = untilEvent(released(1, "failed"));
  core.moveCard(1, "spec", owner.id);
  await spec;
  const code = untilEvent(released(1, "failed"));
  core.moveCard(1, "code", owner.id);
  await code;

  expect(runs).toHaveLength(2);
  const [first, second] = runs as [AgentRunOptions, AgentRunOptions];
  expect(first.systemPrompt).toBe(playbooks.spec);
  expect(second.systemPrompt).toBe(playbooks.code);
  const card = "Card 1: Inputs\nBranch: skelcrew/1-inputs (from main)\n\n## Goal\n\nSomething.";
  expect(firstMessages).toEqual([card, card]);
  expect(first.cwd).toBe(worktreePath(1));
  expect(first.allowedTools).toEqual([...FIXED_ALLOWLIST, "Bash(bun *)"]);
  expect(first.env).toEqual({
    PATH: `${join(dataDir, "bin")}:/usr/bin`,
    HOME: "/home/simon",
    SKELCREW_AS: "runner",
    SKELCREW_DIR: dataDir,
  });
  const shim = join(first.env.PATH?.split(":")[0] as string, "skelcrew");
  expect(statSync(shim).mode & 0o111).toBe(0o111);
  const proc = Bun.spawn([shim, "--version"], { stdout: "pipe", stderr: "pipe" });
  expect(await new Response(proc.stdout as ReadableStream<Uint8Array>).text()).toBe(
    `skelcrew ${VERSION}\n`,
  );
  expect(await proc.exited).toBe(0);
});

test("a runner with a driver but no playbooks does not start", () => {
  expect(() => start({ driver: scripted(function* () {}).driver, playbooks: undefined })).toThrow(
    "playbooks",
  );
});

test("SKELCREW_RUN_MINUTES: unset is sixty minutes, a number is minutes, anything else is an error", () => {
  expect(runLimitFromEnv({})).toBe(60 * 60_000);
  expect(runLimitFromEnv({ SKELCREW_RUN_MINUTES: "" })).toBe(60 * 60_000);
  expect(runLimitFromEnv({ SKELCREW_RUN_MINUTES: "5" })).toBe(5 * 60_000);
  expect(runLimitFromEnv({ SKELCREW_RUN_MINUTES: "0.5" })).toBe(30_000);
  expect(() => runLimitFromEnv({ SKELCREW_RUN_MINUTES: "soon" })).toThrow('"soon"');
  expect(() => runLimitFromEnv({ SKELCREW_RUN_MINUTES: "0" })).toThrow();
});

// --- review round 1 ---

/** The agent raises a question on the card as `runner` would with `skelcrew attention`. */
function askOwner(cardId: number, note: string): void {
  core.requestAttention(cardId, { to: owner.id, note }, runnerMember.id);
}

function requests(cardId: number): Activity[] {
  return afterLastMove(cardId).filter((e) => e.type === "attention_requested");
}

test("a question the agent raised survives a failed spec run: the failure is a comment and a release, not a new request", async () => {
  await initRepo();
  const { driver } = scripted(function* () {
    askOwner(1, "spec conflict: the card asks for X but AGENTS.md forbids it");
    yield { type: "result", ok: true };
  });
  start({ driver });
  await runCard("Conflicted", "spec", "failed");
  const card = core.getCard(1);
  expect(comments(1).at(-1)).toBe("run finished without a spec");
  expect(card.attention).toMatchObject({
    to: owner.id,
    raisedBy: runnerMember.id,
    note: "spec conflict: the card asks for X but AGENTS.md forbids it",
  });
  expect(requests(1)).toHaveLength(1);
  expect(card.claim).toBeNull();
});

test("the same for a failed code run", async () => {
  await initRepo();
  const { driver } = scripted(function* () {
    askOwner(1, "which base branch?");
    yield { type: "result", ok: true };
  });
  start({ driver });
  await runCard("Asks", "code", "failed");
  const card = core.getCard(1);
  expect(comments(1).at(-1)).toContain("run finished with no commits");
  expect(card.attention?.note).toBe("which base branch?");
  expect(requests(1)).toHaveLength(1);
});

test("a permission request waits behind the agent's open question and is raised once the owner answers it", async () => {
  await initRepo();
  const { driver } = scripted(async function* (options) {
    askOwner(1, "may I drop the table?");
    const decision = await options.canUseTool("Bash", { command: "make migrate" });
    yield { type: "text", text: `decision: ${JSON.stringify(decision)}` };
    yield { type: "result", ok: true };
  });
  start({ driver });
  core.createCard({ title: "Question first" }, owner.id);
  const asked = untilEvent(attentionOn(1));
  core.moveCard(1, "spec", owner.id);
  await asked;
  await Bun.sleep(150);
  expect(core.getCard(1).attention?.note).toBe("may I drop the table?");
  expect(requests(1)).toHaveLength(1);

  const permission = untilEvent(attentionOn(1));
  core.resolveAttention(1, "no, rename it", owner.id);
  const request = await permission;
  expect(request.type === "attention_requested" && request.data.note).toStartWith("allow Bash");
  core.resolveAttention(1, "allow", owner.id);
  await untilEvent(released(1, "failed"));
  expect(comments(1)).toContain('decision: {"behavior":"allow"}');
});

test("two permission requests in flight are raised one at a time and answered in order", async () => {
  await initRepo();
  const { driver } = scripted(async function* (options) {
    const decisions = await Promise.all([
      options.canUseTool("Bash", { command: "one" }),
      options.canUseTool("Bash", { command: "two" }),
    ]);
    yield { type: "text", text: `decisions: ${JSON.stringify(decisions)}` };
    yield { type: "result", ok: true };
  });
  start({ driver });
  core.createCard({ title: "Two at once" }, owner.id);
  const first = untilEvent(attentionOn(1));
  core.moveCard(1, "spec", owner.id);
  const one = await first;
  expect(one.type === "attention_requested" && one.data.note).toContain("allow Bash one?");
  await Bun.sleep(150);
  expect(core.getCard(1).attention?.note).toContain("allow Bash one?");
  expect(requests(1)).toHaveLength(1);

  const second = untilEvent(attentionOn(1));
  core.resolveAttention(1, "allow", owner.id);
  const two = await second;
  expect(two.type === "attention_requested" && two.data.note).toContain("allow Bash two?");
  core.resolveAttention(1, "no", owner.id);
  await untilEvent(released(1, "failed"));
  expect(comments(1)).toContain(
    'decisions: [{"behavior":"allow"},{"behavior":"deny","message":"no"}]',
  );
});

test("two comments posted in one synchronous dispatch both reach the agent, in order", async () => {
  await initRepo();
  const { driver } = scripted(async function* (options) {
    const input = options.input[Symbol.asyncIterator]();
    await input.next(); // the card
    yield { type: "text", text: "listening" };
    const a = await input.next();
    const b = await input.next();
    yield { type: "text", text: `heard: ${a.value} | ${b.value}` };
    yield { type: "result", ok: true };
  });
  start({ driver });
  core.createCard({ title: "Pipelined" }, owner.id);
  const listening = untilEvent(commentContaining(1, "listening"));
  core.moveCard(1, "spec", owner.id);
  await listening;
  // Two mutations back to back with no await between them: one dispatch on the subscriber.
  core.comment(1, "first", owner.id);
  core.comment(1, "second", owner.id);
  const heard = await untilEvent(commentContaining(1, "heard:"));
  expect(heard.data).toEqual({ text: "heard: first | second" });
  await untilEvent(released(1, "failed"));
});

test("stop() aborts a live run within a bounded time: `run aborted: daemon stopping`, released `failed`", async () => {
  await initRepo();
  const driver = endless();
  const active = start({ driver: driver.driver });
  core.createCard({ title: "Stopped" }, owner.id);
  const working = untilEvent(commentContaining(1, "working…"));
  core.moveCard(1, "spec", owner.id);
  await working;
  const began = Date.now();
  await active.stop();
  expect(Date.now() - began).toBeLessThan(3000);
  expect(driver.aborted()).toBe(true);
  const card = core.getCard(1);
  expect(comments(1).at(-1)).toBe("run aborted: daemon stopping");
  expect(card.attention).toMatchObject({ to: owner.id, note: "run aborted: daemon stopping" });
  expect(card.claim).toBeNull();
  expect(afterLastMove(1).at(-1)?.data).toEqual({ reason: "failed" });
});

test("a driver that ignores its signal is left behind after a grace period: the run still fails on time", async () => {
  await initRepo();
  const { driver } = scripted(async function* () {
    yield { type: "text", text: "ignoring you" };
    await new Promise<void>(() => {});
  });
  start({ driver, runLimitMs: 300, abortGraceMs: 300 });
  core.createCard({ title: "Deaf" }, owner.id);
  const done = untilEvent(released(1, "failed"), 3000);
  core.moveCard(1, "spec", owner.id);
  await done;
  expect(comments(1).at(-1)).toBe("run aborted: time limit of 0.3 seconds reached");
  expect(core.getCard(1).claim).toBeNull();
});

// --- review round 2 ---

function claims(cardId: number): Activity[] {
  return events.filter((e) => e.cardId === cardId && e.type === "claimed");
}

test("an agent that moves its own card fails the run: the driver is aborted, the failure is a comment and a request, no handoff", async () => {
  await initRepo();
  const driver = endless();
  start({ driver: driver.driver });
  core.createCard({ title: "Self move" }, owner.id);
  const working = untilEvent(commentContaining(1, "working…"));
  core.moveCard(1, "code", owner.id);
  await working;
  const failed = untilEvent(commentContaining(1, "run failed"));
  // The agent's `skelcrew mv 1 pr`: the claim holder may leave Code.
  core.moveCard(1, "pr", runnerMember.id);
  await failed;
  await Bun.sleep(150);

  expect(driver.aborted()).toBe(true);
  const card = core.getCard(1);
  const note = "run failed: the agent moved its own card (to pr)";
  expect(comments(1).filter((c) => c.startsWith("run "))).toEqual([note]);
  expect(card.attention).toMatchObject({ to: owner.id, note, moves: [] });
  expect(card.phase).toBe("pr");
  expect(card.claim).toBeNull();
});

test("an agent that releases its own card fails the run and the card waits: no second run starts", async () => {
  await initRepo();
  const driver = endless();
  start({ driver: driver.driver });
  core.createCard({ title: "Self release" }, owner.id);
  const working = untilEvent(commentContaining(1, "working…"));
  core.moveCard(1, "spec", owner.id);
  await working;
  const failed = untilEvent(commentContaining(1, "run failed"));
  core.releaseCard(1, { reason: "done, I think" }, runnerMember.id);
  await failed;
  await Bun.sleep(300);

  expect(driver.aborted()).toBe(true);
  const card = core.getCard(1);
  const note = "run failed: the agent released its own card (done, I think)";
  expect(comments(1).at(-1)).toBe(note);
  expect(card.attention).toMatchObject({ to: owner.id, note, moves: [] });
  expect(card.phase).toBe("spec");
  expect(card.claim).toBeNull();
  expect(claims(1)).toHaveLength(1);
});

test("an agent that archives its own card fails the run: the comment lands, no request, no second run", async () => {
  await initRepo();
  const driver = endless();
  start({ driver: driver.driver });
  core.createCard({ title: "Self archive" }, owner.id);
  const working = untilEvent(commentContaining(1, "working…"));
  core.moveCard(1, "spec", owner.id);
  await working;
  const failed = untilEvent(commentContaining(1, "run failed"));
  core.archiveCard(1, runnerMember.id);
  await failed;
  await Bun.sleep(300);

  expect(driver.aborted()).toBe(true);
  const card = core.getCard(1);
  expect(comments(1).filter((c) => c.startsWith("run "))).toEqual([
    "run failed: the agent archived its own card",
  ]);
  // An archived card refuses an attention request: the comment is all the owner gets, and
  // the runner says why in its log rather than throwing.
  expect(card.attention).toBeNull();
  expect(events.filter((e) => e.cardId === 1 && e.type === "attention_requested")).toEqual([]);
  expect(card.archivedAt).not.toBeNull();
  expect(card.claim).toBeNull();
  expect(claims(1)).toHaveLength(1);
  expect(warnings.filter((line) => line.includes("could not say so"))).toHaveLength(1);
});

test("the owner releasing a running card stops the run and the card waits on them: `run stopped: released by <name>`", async () => {
  await initRepo();
  const driver = endless();
  start({ driver: driver.driver });
  core.createCard({ title: "Taken back" }, owner.id);
  const working = untilEvent(commentContaining(1, "working…"));
  core.moveCard(1, "spec", owner.id);
  await working;
  const stopped = untilEvent(commentContaining(1, "run stopped"));
  core.releaseCard(1, { reason: "I'll take it from here" }, owner.id);
  await stopped;
  await Bun.sleep(300);

  expect(driver.aborted()).toBe(true);
  const card = core.getCard(1);
  const note = "run stopped: released by simon";
  expect(comments(1).at(-1)).toBe(note);
  expect(card.attention).toMatchObject({ to: owner.id, note, moves: [] });
  expect(card.claim).toBeNull();
  expect(claims(1)).toHaveLength(1);
  expect(comments(1).some((c) => c.startsWith("run abandoned"))).toBe(false);
});

test("a lapsed claim still re-queues the card: the run is abandoned and a fresh run starts", async () => {
  await initRepo();
  let offsetMs = 0;
  const now = () => Date.now() + offsetMs;
  core.close();
  core = openCore(":memory:", { owner: "simon", now });
  owner = core.listMembers()[0] as Member;
  runnerMember = core.ensureMember("runner", "agent");
  core.subscribe((event) => events.push(event));
  const driver = endless();
  start({ driver: driver.driver, now });
  core.createCard({ title: "Lapsed" }, owner.id);
  const working = untilEvent(commentContaining(1, "working…"));
  core.moveCard(1, "spec", owner.id);
  await working;
  // The daemon slept through the lease: the sweep records the interruption.
  offsetMs = 130_000;
  const abandoned = untilEvent(commentContaining(1, "run abandoned"));
  const again = untilEvent((e) => e.cardId === 1 && e.type === "claimed" && e.seq > 4);
  expect(core.sweepClaims()).toEqual([1]);
  await abandoned;
  await again;
  expect(driver.aborted()).toBe(true);
  expect(claims(1)).toHaveLength(2);
  expect(core.getCard(1).attention).toBeNull();
});

test("the revision loop: a card sent back to Code with its prUrl still on it finishes on new commits", async () => {
  await initRepo();
  const { driver } = scripted(async function* () {
    // Sent back from PR: the agent pushes to the same branch, so GitHub keeps the same PR
    // and there is no new URL — but it reads it off the PR and records it again, which is
    // what the playbook tells it to do and what the contract asks for.
    await sh(worktreePath(1), "commit", "-q", "--allow-empty", "-m", "revision");
    core.setRefs(1, { prUrl: PR }, runnerMember.id);
    yield { type: "result", ok: true };
  });
  start({ driver });
  core.createCard({ title: "Revision" }, owner.id);
  core.setRefs(1, { prUrl: PR }, owner.id);
  const done = untilEvent(released(1, "finished"));
  core.moveCard(1, "code", owner.id);
  await done;
  const card = core.getCard(1);
  expect(card.attention).toMatchObject({
    to: owner.id,
    note: `ready for review: ${PR}`,
    moves: ["pr"],
  });
  expect(card.refs.commits).toEqual([await sh(repo, "rev-parse", "skelcrew/1-revision")]);
});

test("a revision run that records nothing fails: the first run's commits and PR are not this run's artefact", async () => {
  await initRepo();
  let started = 0;
  const { driver } = scripted(async function* () {
    started += 1;
    // The first run does the work; the second, sent back with feedback, does nothing at all.
    if (started === 1) {
      await sh(worktreePath(1), "commit", "-q", "--allow-empty", "-m", "feat");
      core.setRefs(1, { prUrl: PR }, runnerMember.id);
    }
    yield { type: "result", ok: true };
  });
  start({ driver });
  core.createCard({ title: "Sent back" }, owner.id);
  const first = untilEvent(released(1, "finished"));
  core.moveCard(1, "code", owner.id);
  await first;
  // The owner reviews it, then sends it back to Code with feedback: the card keeps the
  // branch, the commits, and the PR URL of the run that earned them.
  core.moveCard(1, "pr", owner.id);
  const second = untilEvent(released(1, "failed"));
  core.moveCard(1, "code", owner.id);
  await second;

  expect(started).toBe(2);
  const card = core.getCard(1);
  expect(comments(1).at(-1)).toBe("run finished with no prUrl ref set during the run");
  expect(card.attention).toMatchObject({
    to: owner.id,
    note: "run finished with no prUrl ref set during the run",
    moves: [],
  });
  expect(card.phase).toBe("code");
  expect(card.refs.prUrl).toBe(PR);
});

test("a new prUrl recorded in the same run as the commits satisfies it", async () => {
  await initRepo();
  const { driver } = scripted(async function* () {
    const path = worktreePath(1);
    await sh(path, "commit", "-q", "--allow-empty", "-m", "revision");
    core.setRefs(1, { prUrl: `${PR}3` }, runnerMember.id);
    yield { type: "result", ok: true };
  });
  start({ driver });
  core.createCard({ title: "Revision" }, owner.id);
  core.setRefs(1, { prUrl: PR }, owner.id);
  const done = untilEvent(released(1, "finished"));
  core.moveCard(1, "code", owner.id);
  await done;
  expect(core.getCard(1).attention?.note).toBe(`ready for review: ${PR}3`);
});

test("tool calls are summarised once per window: two windows make two comments", async () => {
  await initRepo();
  const { driver } = scripted(async function* () {
    yield { type: "tool_use", name: "Read", input: { file_path: "a.ts" } };
    yield { type: "tool_use", name: "Grep", input: { pattern: "x" } };
    await Bun.sleep(250);
    yield { type: "tool_use", name: "Edit", input: { file_path: "a.ts" } };
    yield { type: "result", ok: true };
  });
  start({ driver, summaryMs: 100 });
  await runCard("Windows", "spec", "failed");
  const posted = comments(1);
  expect(posted[1]).toBe("ran 2 tools: Read, Grep");
  expect(posted[2]).toBe("ran 1 tool: Edit");
  expect(posted[3]).toBe("run finished without a spec");
});

// --- review round 4 ---

test("stop() while the run is still in its git steps ends it too, deaf agent and all", async () => {
  await initRepo();
  let reached = (): void => {};
  const atGate = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const slow: Git = {
    ...git,
    async worktreeAdd(repoRoot, path, branch) {
      await git.worktreeAdd(repoRoot, path, branch);
      reached();
      await gate;
    },
  };
  // Never yields, never returns: only the grace timer can end this run.
  const { driver } = scripted(async function* () {
    await new Promise<void>(() => {});
  });
  const active = start({ driver, git: slow, abortGraceMs: 100 });
  core.createCard({ title: "Stopping already" }, owner.id);
  core.moveCard(1, "spec", owner.id);
  await atGate;
  // The daemon stops between the run's git steps, before the agent is spawned: the run
  // starts with its signal already fired, and must still end rather than wait forever.
  const stopping = active.stop();
  open();
  const outcome = await Promise.race([
    stopping.then(() => "stopped"),
    Bun.sleep(2000).then(() => "hung"),
  ]);
  expect(outcome).toBe("stopped");
  expect(comments(1).at(-1)).toBe("run aborted: daemon stopping");
  expect(core.getCard(1).attention?.note).toBe("run aborted: daemon stopping");
  expect(core.getCard(1).claim).toBeNull();
});

test("the last window of tool activity still lands when the owner takes the run back", async () => {
  await initRepo();
  const { driver } = scripted(async function* (options) {
    yield { type: "tool_use", name: "Read", input: { file_path: "a.ts" } };
    yield { type: "text", text: "working…" };
    await new Promise<void>((resolve) => {
      if (options.signal.aborted) resolve();
      else options.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  // The default summary window has not elapsed: the summary exists only as pending work.
  start({ driver });
  core.createCard({ title: "Taken back mid-tool" }, owner.id);
  const working = untilEvent(commentContaining(1, "working…"));
  core.moveCard(1, "spec", owner.id);
  await working;
  const stopped = untilEvent(commentContaining(1, "run stopped"));
  core.releaseCard(1, { reason: "I'll take it from here" }, owner.id);
  await stopped;

  const posted = comments(1);
  expect(posted.at(-2)).toBe("ran 1 tool: Read");
  expect(posted.at(-1)).toBe("run stopped: released by simon");
});

// --- external review (Codex) ---

test("a question the agent raised survives a successful spec run: the spec lands as a comment, not a handoff", async () => {
  await initRepo();
  const { driver } = scripted(function* () {
    core.setBody(1, "# Spec\n\nGoal.", runnerMember.id);
    askOwner(1, "spec conflict: the card asks for X but AGENTS.md forbids it");
    yield { type: "result", ok: true };
  });
  start({ driver });
  core.createCard({ title: "Written but blocked" }, owner.id);
  const done = untilEvent((e) => e.cardId === 1 && e.type === "released");
  core.moveCard(1, "spec", owner.id);
  const release = await done;

  const card = core.getCard(1);
  expect(release.type === "released" && release.data.reason).toBe("blocked");
  expect(comments(1).at(-1)).toContain("spec ready");
  expect(card.attention).toMatchObject({
    to: owner.id,
    raisedBy: runnerMember.id,
    note: "spec conflict: the card asks for X but AGENTS.md forbids it",
    moves: [],
  });
  expect(requests(1)).toHaveLength(1);
  expect(card.phase).toBe("spec");
  expect(card.body).toBe("# Spec\n\nGoal.");
  expect(card.claim).toBeNull();
});

test("the same on the code path: the pull request is a comment and the question still holds the card", async () => {
  await initRepo();
  const { driver } = scripted(async function* () {
    await sh(worktreePath(1), "commit", "-q", "--allow-empty", "-m", "feat");
    core.setRefs(1, { prUrl: PR }, runnerMember.id);
    askOwner(1, "the spec's schema does not match the migration; which wins?");
    yield { type: "result", ok: true };
  });
  start({ driver });
  core.createCard({ title: "Shipped but blocked" }, owner.id);
  const done = untilEvent((e) => e.cardId === 1 && e.type === "released");
  core.moveCard(1, "code", owner.id);
  const release = await done;

  const card = core.getCard(1);
  expect(release.type === "released" && release.data.reason).toBe("blocked");
  expect(comments(1).at(-1)).toContain(`ready for review: ${PR}`);
  expect(card.attention).toMatchObject({
    note: "the spec's schema does not match the migration; which wins?",
    moves: [],
  });
  expect(requests(1)).toHaveLength(1);
  expect(card.phase).toBe("code");
  expect(card.refs.commits).toEqual([
    await sh(repo, "rev-parse", "skelcrew/1-shipped-but-blocked"),
  ]);
});

test("answering the question runs the phase again, and that run hands the card on", async () => {
  await initRepo();
  let runs = 0;
  const { driver } = scripted(function* () {
    runs += 1;
    core.setBody(1, `# Spec\n\nGoal, take ${runs}.`, runnerMember.id);
    if (runs === 1) askOwner(1, "which base branch?");
    yield { type: "result", ok: true };
  });
  start({ driver });
  core.createCard({ title: "Answered" }, owner.id);
  const blocked = untilEvent(released(1, "blocked"));
  core.moveCard(1, "spec", owner.id);
  await blocked;

  const finished = untilEvent(released(1, "finished"));
  core.resolveAttention(1, "main", owner.id);
  await finished;

  expect(runs).toBe(2);
  const card = core.getCard(1);
  expect(card.body).toBe("# Spec\n\nGoal, take 2.");
  expect(card.attention).toMatchObject({ to: owner.id, note: "spec ready", moves: ["code"] });
});

// --- external review (Codex), round 2 ---

test("two runs of one card in the same second get separate logs, and the first run's stays readable", async () => {
  await initRepo();
  // A clock the runner reads as one instant: both runs start within the same second.
  const frozen = Date.parse("2020-01-01T00:00:00.500Z");
  let runs = 0;
  const { driver } = scripted(function* () {
    runs += 1;
    yield { type: "text", text: `run ${runs}` };
    core.setBody(1, `# Spec\n\nGoal, take ${runs}.`, runnerMember.id);
    if (runs === 1) askOwner(1, "which base branch?");
    yield { type: "result", ok: true };
  });
  start({ driver, now: () => frozen });
  core.createCard({ title: "Twice in one second" }, owner.id);
  const blocked = untilEvent(released(1, "blocked"));
  core.moveCard(1, "spec", owner.id);
  await blocked;
  const finished = untilEvent(released(1, "finished"));
  core.resolveAttention(1, "main", owner.id);
  await finished;

  expect(runs).toBe(2);
  const paths = runLogPaths(1);
  expect(paths).toHaveLength(2);
  expect(paths[0]).not.toBe(paths[1]);
  // The path the first run put on the card still holds the first run's transcript.
  expect(eventsIn(paths[0] as string)).toEqual([
    { type: "text", text: "run 1" },
    { type: "result", ok: true },
  ]);
  expect(eventsIn(paths[1] as string)).toEqual([
    { type: "text", text: "run 2" },
    { type: "result", ok: true },
  ]);
  expect(warnings).toEqual([]);
});

// --- external review (Codex), round 3 ---

test("a git failure while verifying the code contract keeps the agent's question: the error is a comment and a failed release", async () => {
  await initRepo();
  const { driver } = scripted(async function* () {
    await sh(worktreePath(1), "commit", "-q", "--allow-empty", "-m", "feat");
    core.setRefs(1, { prUrl: PR }, runnerMember.id);
    askOwner(1, "Which schema is correct?");
    yield { type: "result", ok: true };
  });
  start({
    driver,
    git: {
      ...git,
      revList: () => Promise.reject(new Error("git unavailable during verification")),
    },
  });
  await runCard("Verification broke", "code", "failed");

  const card = core.getCard(1);
  expect(comments(1).at(-1)).toBe("run playbook failed: git unavailable during verification");
  expect(card.attention).toMatchObject({ to: owner.id, note: "Which schema is correct?" });
  expect(requests(1)).toHaveLength(1);
  expect(card.claim).toBeNull();
});

test("a run stopped by the agent's own hand keeps the agent's question too: the comment lands, the request does not", async () => {
  await initRepo();
  const { driver } = scripted(function* () {
    askOwner(1, "Which schema is correct?");
    core.releaseCard(1, { reason: "done, I think" }, runnerMember.id);
    yield { type: "result", ok: true };
  });
  start({ driver });
  core.createCard({ title: "Asked then let go" }, owner.id);
  const failed = untilEvent(commentContaining(1, "run failed"));
  core.moveCard(1, "spec", owner.id);
  await failed;
  await Bun.sleep(150);

  const card = core.getCard(1);
  expect(comments(1).at(-1)).toBe("run failed: the agent released its own card (done, I think)");
  expect(card.attention).toMatchObject({ to: owner.id, note: "Which schema is correct?" });
  expect(requests(1)).toHaveLength(1);
  expect(card.claim).toBeNull();
});

test("a move that follows a release supersedes it: the run is abandoned and the moved card is left alone", async () => {
  await initRepo();
  const driver = endless();
  start({ driver: driver.driver });
  core.createCard({ title: "Taken back then moved" }, owner.id);
  const working = untilEvent(commentContaining(1, "working…"));
  core.moveCard(1, "spec", owner.id);
  await working;
  const abandoned = untilEvent(commentContaining(1, "run abandoned"));
  core.releaseCard(1, { reason: "I'll take it from here" }, owner.id);
  core.moveCard(1, "idea", owner.id);
  await abandoned;
  await Bun.sleep(300);

  expect(driver.aborted()).toBe(true);
  const card = core.getCard(1);
  expect(card.phase).toBe("idea");
  expect(card.attention).toBeNull();
  expect(comments(1).filter((c) => c.startsWith("run "))).toEqual([
    "run abandoned: claim lost; card is in idea",
  ]);
});

test("a tag shadowing the base branch does not pass a run with no commits: the range is the branch's, not the tag's", async () => {
  await initRepo();
  // A release tagged with the base branch's own name. `refs/tags/main` outranks
  // `refs/heads/main` when git resolves the bare name, so a range built from short names
  // counts the base's own commits as this branch's work.
  await sh(repo, "tag", "main");
  await sh(repo, "commit", "-q", "--allow-empty", "-m", "base work after the tag");
  const { driver } = scripted(function* () {
    core.setRefs(1, { prUrl: PR }, runnerMember.id);
    yield { type: "result", ok: true };
  });
  start({ driver });
  await runCard("Tagged base", "code", "failed");

  const card = core.getCard(1);
  const last = comments(1).at(-1) as string;
  expect(last).toBe("run finished with no commits on skelcrew/1-tagged-base past main");
  expect(card.attention).toMatchObject({ to: owner.id, note: last, moves: [] });
  expect(card.refs.commits).toBeUndefined();
  expect(card.phase).toBe("code");
});

test("a claim that follows a release supersedes it: the run is abandoned and the new holder's card is left alone", async () => {
  await initRepo();
  const driver = endless();
  start({ driver: driver.driver });
  core.createCard({ title: "Taken over" }, owner.id);
  const working = untilEvent(commentContaining(1, "working…"));
  core.moveCard(1, "spec", owner.id);
  await working;
  const abandoned = untilEvent(commentContaining(1, "run abandoned"));
  // The owner takes the card back and holds it: the run's stop request would land on a
  // card that is the owner's now.
  core.releaseCard(1, { reason: "I'll take it from here" }, owner.id);
  core.claimCard(1, {}, owner.id);
  await abandoned;
  await Bun.sleep(300);

  expect(driver.aborted()).toBe(true);
  const card = core.getCard(1);
  expect(card.claim?.by).toBe(owner.id);
  expect(card.attention).toBeNull();
  expect(comments(1).filter((c) => c.startsWith("run "))).toEqual([
    `run abandoned: claim lost to member ${owner.id}; card is in spec`,
  ]);
});

test("an archive that follows a release supersedes it too: the run is abandoned and the archived card is left alone", async () => {
  await initRepo();
  const driver = endless();
  start({ driver: driver.driver });
  core.createCard({ title: "Taken back then archived" }, owner.id);
  const working = untilEvent(commentContaining(1, "working…"));
  core.moveCard(1, "spec", owner.id);
  await working;
  const abandoned = untilEvent(commentContaining(1, "run abandoned"));
  core.releaseCard(1, { reason: "I'll take it from here" }, owner.id);
  core.archiveCard(1, owner.id);
  await abandoned;
  await Bun.sleep(300);

  expect(driver.aborted()).toBe(true);
  const card = core.getCard(1);
  expect(card.archivedAt).not.toBeNull();
  expect(card.attention).toBeNull();
  expect(comments(1).filter((c) => c.startsWith("run "))).toEqual(["run abandoned: card archived"]);
});
