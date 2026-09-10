/**
 * What a member sees on a card while an agent works it, against a scripted fake driver.
 * No test here spawns a coding agent or calls a model: the driver is the boundary, and the
 * script is the whole agent.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Activity, COMMENT_MAX_BYTES, type Member, worktreesDir } from "@skelcrew/shared";
import { type Core, openCore } from "../core/core";
import type { AgentDriver, AgentEvent, AgentRunOptions, ToolDecision } from "./agent";
import { FIXED_ALLOWLIST } from "./allowlist";
import { createGit, type Git } from "./git";
import { loadPlaybooks } from "./playbooks";
import { createRunLog, runLimitFromEnv, TEXT_EXCERPT_BYTES } from "./run";
import { type Runner, startRunner } from "./runner";
import { agentEnvironment } from "./shim";

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
const warnings: string[] = [];
const playbooks = loadPlaybooks();

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "skr-run-")));
  repo = join(tmp, "repo");
  dataDir = join(tmp, "data");
  mkdirSync(repo);
  mkdirSync(dataDir);
  core = openCore(":memory:", { owner: "simon" });
  owner = core.listMembers()[0] as Member;
  runnerMember = core.ensureMember("runner", "agent");
  git = createGit({ env: GIT_ENV });
  warnings.length = 0;
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

/** The agent, scripted: whatever the test's generator does is the whole run. */
function fakeDriver(script: (options: AgentRunOptions) => AsyncGenerator<AgentEvent>): AgentDriver {
  return { run: (options) => script(options) };
}

interface StartOptions {
  driver: AgentDriver;
  summaryMs?: number;
  runLimitMs?: number;
  abortGraceMs?: number;
  now?: () => number;
}

function start(options: StartOptions): Runner {
  runner = startRunner({
    core,
    dataDir,
    repoRoot: repo,
    git,
    member: runnerMember,
    warn: (line) => warnings.push(line),
    agent: { driver: options.driver, playbooks },
    env: { PATH: "/usr/bin", HOME: join(tmp, "home") },
    summaryMs: options.summaryMs ?? 60_000,
    runLimitMs: options.runLimitMs ?? 60_000,
    abortGraceMs: options.abortGraceMs ?? 1000,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return runner;
}

function untilEvent(match: (event: Activity) => boolean, timeoutMs = 5000): Promise<Activity> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`no matching event within ${timeoutMs} ms`));
    }, timeoutMs);
    const unsubscribe = core.subscribe((event) => {
      if (!match(event)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}

function released(cardId: number): (event: Activity) => boolean {
  return (e) => e.cardId === cardId && e.type === "released";
}

function commentContaining(cardId: number, text: string): (event: Activity) => boolean {
  return (e) => e.cardId === cardId && e.type === "comment" && e.data.text.includes(text);
}

function comments(cardId: number): string[] {
  return core
    .getCard(cardId)
    .activity.filter((e) => e.type === "comment")
    .map((e) => (e.data as { text: string }).text);
}

function types(cardId: number): string[] {
  const activity = core.getCard(cardId).activity;
  return activity
    .slice(activity.findLastIndex((e) => e.type === "card_moved") + 1)
    .map((e) => e.type);
}

function worktreePath(id: number): string {
  return join(worktreesDir(dataDir), String(id));
}

function logLines(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/** The run log named by the card's first comment. */
function logPathFrom(comment: string): string {
  const at = comment.indexOf("run log at ");
  expect(at).toBeGreaterThanOrEqual(0);
  return comment.slice(at + "run log at ".length).trim();
}

/** Files a card as the owner, moves it into spec, and waits for the run to end. */
async function runCard(title: string): Promise<number> {
  const card = core.createCard({ title }, owner.id);
  const done = untilEvent(released(card.id));
  core.moveCard(card.id, "spec", owner.id);
  await done;
  return card.id;
}

// --- a full run ---

test("a Spec run: the log path, the turn, the batched tools, and the handoff, in order", async () => {
  await initRepo();
  const seen: AgentRunOptions[] = [];
  const logged = [
    { type: "system", subtype: "init" },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "Reading the constraints." }] },
    },
    { type: "result", subtype: "success" },
  ];
  start({
    driver: fakeDriver(async function* (options) {
      seen.push(options);
      options.log(logged[0]);
      options.log(logged[1]);
      yield { type: "text", text: "Reading the constraints." };
      yield { type: "tool_use", name: "Read", input: { file_path: "/repo/AGENTS.md" } };
      yield { type: "tool_use", name: "Read", input: { file_path: "/repo/CLAUDE.md" } };
      yield { type: "tool_use", name: "Bash", input: { command: "git status --porcelain" } };
      options.log(logged[2]);
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Add login page");

  expect(types(1)).toEqual([
    "claimed",
    "refs_set",
    "comment",
    "comment",
    "comment",
    "comment",
    "attention_requested",
    "released",
  ]);
  const said = comments(1);
  const path = worktreePath(1);
  expect(said[0]).toContain(`worktree ready at ${path}`);
  expect(said[0]).toContain("run log at ");
  expect(said[1]).toBe("Reading the constraints.");
  expect(said[2]).toBe("ran 3 tools: Read ×2, Bash `git status --porcelain`");
  expect(said[3]).toContain("run finished");

  const card = core.getCard(1);
  expect(card.claim).toBeNull();
  expect(card.attention).toMatchObject({ to: owner.id, raisedBy: runnerMember.id });
  expect(warnings).toEqual([]);

  // The transcript is every message the driver logged, once each, in arrival order.
  const logPath = logPathFrom(said[0] as string);
  expect(logLines(logPath)).toEqual(logged);

  // What the agent was spawned with.
  const options = seen[0] as AgentRunOptions;
  expect(options.cwd).toBe(path);
  expect(options.systemPrompt).toBe(playbooks.spec);
  expect(options.allowedTools).toEqual([...FIXED_ALLOWLIST]);
  expect(options.env).toEqual(
    agentEnvironment({ PATH: "/usr/bin", HOME: join(tmp, "home") }, dataDir),
  );
});

test("the first user message is the card: id, title, branch, base and body", async () => {
  await initRepo();
  let first: string | undefined;
  start({
    driver: fakeDriver(async function* (options) {
      const reader = options.input[Symbol.asyncIterator]();
      first = (await reader.next()).value;
      yield { type: "result", ok: true };
    }),
  });
  const card = core.createCard({ title: "Add login page", body: "make it good" }, owner.id);
  const done = untilEvent(released(card.id));
  core.moveCard(card.id, "spec", owner.id);
  await done;

  expect(first).toContain("Card 1");
  expect(first).toContain("Add login page");
  expect(first).toContain("skelcrew/1-add-login-page");
  expect(first).toContain("main");
  expect(first).toContain("make it good");
});

// --- excerpting and batching ---

test("a turn over the excerpt limit is cut on a character boundary and points at the run log", async () => {
  await initRepo();
  // Four-byte characters: a turn far over the budget by bytes, not by characters.
  const long = "😀".repeat(TEXT_EXCERPT_BYTES);
  start({
    driver: fakeDriver(async function* () {
      yield { type: "text", text: long };
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Long turn");

  const said = comments(1);
  const excerpted = said[1] as string;
  expect(excerpted).not.toBe(long);
  expect(excerpted.includes("�")).toBe(false);
  expect(excerpted.startsWith("😀😀")).toBe(true);
  expect(excerpted).toContain("truncated");
  expect(excerpted).toContain(logPathFrom(said[0] as string));
  expect(Buffer.byteLength(excerpted, "utf8")).toBeLessThanOrEqual(COMMENT_MAX_BYTES);
});

test("a turn within the limit is posted whole", async () => {
  await initRepo();
  start({
    driver: fakeDriver(async function* () {
      yield { type: "text", text: "short enough" };
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Short turn");
  expect(comments(1)[1]).toBe("short enough");
});

test("tool calls are batched per window, and the batch still open at the end is posted", async () => {
  await initRepo();
  let firstBatch: Promise<Activity> | undefined;
  start({
    summaryMs: 30,
    driver: fakeDriver(async function* (options) {
      yield { type: "tool_use", name: "Grep", input: { pattern: "x" } };
      yield { type: "tool_use", name: "Glob", input: { pattern: "**/*.ts" } };
      // Wait for the window to close and its summary to land before the next call.
      await (firstBatch as Promise<Activity>);
      yield { type: "tool_use", name: "Read", input: { file_path: "/repo/x.ts" } };
      options.log({ done: true });
      yield { type: "result", ok: true };
    }),
  });
  const card = core.createCard({ title: "Two batches" }, owner.id);
  firstBatch = untilEvent(commentContaining(card.id, "ran 2 tools"));
  const done = untilEvent(released(card.id));
  core.moveCard(card.id, "spec", owner.id);
  await done;

  const said = comments(1);
  expect(said[1]).toBe("ran 2 tools: Grep, Glob");
  expect(said[2]).toBe("ran 1 tool: Read");
});

test("a tool batch too big for one comment is cut and marked, not dropped", async () => {
  await initRepo();
  start({
    driver: fakeDriver(async function* () {
      // One window, more distinct commands than a comment holds.
      for (let i = 0; i < 1000; i += 1) {
        yield {
          type: "tool_use",
          name: "Bash",
          input: { command: `git log --oneline --skip=${i}` },
        };
      }
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Many tools");

  const summary = comments(1)[1] as string;
  expect(summary.startsWith("ran 1000 tools: Bash `git log --oneline --skip=0`")).toBe(true);
  expect(Buffer.byteLength(summary, "utf8")).toBeLessThanOrEqual(COMMENT_MAX_BYTES);
  expect(summary.endsWith("…")).toBe(true);
  expect(warnings).toEqual([]);
});

// --- the run log ---

test("two runs of one card started in the same second get separate logs, and the first stays readable", () => {
  const startedAt = Date.parse("2026-09-10T12:00:00.500Z");
  const first = createRunLog(dataDir, 1, startedAt);
  writeFileSync(first, '{"run":1}\n');
  const second = createRunLog(dataDir, 1, startedAt + 400);
  writeFileSync(second, '{"run":2}\n');

  expect(second).not.toBe(first);
  expect(readFileSync(first, "utf8")).toBe('{"run":1}\n');
  expect(readFileSync(second, "utf8")).toBe('{"run":2}\n');
});

test("a second run of the same card writes its own log, and the card names both", async () => {
  await initRepo();
  // One frozen clock for the core and the runner, so both runs start in the same second.
  const at = Date.now();
  const now = (): number => at;
  core.close();
  core = openCore(":memory:", { owner: "simon", now });
  owner = core.listMembers()[0] as Member;
  runnerMember = core.ensureMember("runner", "agent");
  let run = 0;
  start({
    now,
    driver: fakeDriver(async function* (options) {
      run += 1;
      options.log({ run });
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Twice");
  const again = untilEvent(released(1));
  core.resolveAttention(1, undefined, owner.id);
  await again;

  const named = comments(1)
    .filter((text) => text.includes("run log at "))
    .map(logPathFrom);
  expect(named).toHaveLength(2);
  expect(named[0]).not.toBe(named[1]);
  expect(logLines(named[0] as string)).toEqual([{ run: 1 }]);
  expect(logLines(named[1] as string)).toEqual([{ run: 2 }]);
});

// --- comments reach the agent ---

test("a member's comments reach the running agent in order; the runner's own do not", async () => {
  await initRepo();
  const received: string[] = [];
  let ready: () => void = () => {};
  const reading = new Promise<void>((resolve) => {
    ready = resolve;
  });
  start({
    driver: fakeDriver(async function* (options) {
      const reader = options.input[Symbol.asyncIterator]();
      received.push((await reader.next()).value as string);
      ready();
      // The card, then the two comments the owner posts, and nothing else.
      received.push((await reader.next()).value as string);
      received.push((await reader.next()).value as string);
      yield { type: "result", ok: true };
    }),
  });
  const card = core.createCard({ title: "Talked to" }, owner.id);
  const done = untilEvent(released(card.id));
  core.moveCard(card.id, "spec", owner.id);
  await reading;

  // Two comments in one core dispatch: the second is posted from inside the first's
  // delivery, so both drain together. The order the agent reads them in is what criterion 7
  // asks for; the core's `dispatch` is what supplies it, and the run must not disturb it.
  const unsubscribe = core.subscribe((event) => {
    if (event.type === "comment" && event.data.text === "first") {
      core.comment(card.id, "second", owner.id);
    }
  });
  core.comment(card.id, "first", owner.id);
  unsubscribe();
  await done;

  expect(received[0]).toContain("Talked to");
  expect(received.slice(1)).toEqual(["first", "second"]);
  // The run's own comments are on the card, and were not fed back to the agent.
  expect(comments(1).length).toBeGreaterThan(2);
  expect(received.some((text) => text.includes("worktree ready"))).toBe(false);
});

test("the turn the run posts for the agent is not fed back to the agent", async () => {
  await initRepo();
  const received: string[] = [];
  let turned: () => void = () => {};
  const posted = new Promise<void>((resolve) => {
    turned = resolve;
  });
  start({
    driver: fakeDriver(async function* (options) {
      const reader = options.input[Symbol.asyncIterator]();
      received.push((await reader.next()).value as string);
      // The run posts this turn as a comment before it asks for the next event, so by the
      // time the generator resumes the comment is on the card and has been dispatched.
      yield { type: "text", text: "I have read CLAUDE.md." };
      turned();
      received.push((await reader.next()).value as string);
      yield { type: "result", ok: true };
    }),
  });
  const card = core.createCard({ title: "Its own voice" }, owner.id);
  const done = untilEvent(released(card.id));
  core.moveCard(card.id, "spec", owner.id);
  await posted;
  core.comment(card.id, "keep going", owner.id);
  await done;

  // The turn is on the card, and the next thing the agent read was the owner's, not its own.
  expect(comments(card.id)).toContain("I have read CLAUDE.md.");
  expect(received[1]).toBe("keep going");
});

// --- denial ---

test("a tool outside the fixed list is denied with a reason, and the card says which", async () => {
  await initRepo();
  let decision: ToolDecision | undefined;
  start({
    driver: fakeDriver(async function* (options) {
      decision = await options.canUseTool("Write", { file_path: "/repo/x.ts", content: "x" });
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Writes a file");

  expect(decision?.behavior).toBe("deny");
  const message = (decision as { behavior: "deny"; message: string }).message;
  expect(message).toContain("Write");
  expect(message.length).toBeGreaterThan(0);
  const denied = comments(1).find((text) => text.startsWith("denied "));
  expect(denied).toContain("Write");
  expect(denied).toContain("/repo/x.ts");
});

test("a denied Bash call names the command on the card", async () => {
  await initRepo();
  start({
    driver: fakeDriver(async function* (options) {
      await options.canUseTool("Bash", { command: "git push origin HEAD:main" });
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Pushes a branch");
  const denied = comments(1).find((text) => text.startsWith("denied ")) as string;
  expect(denied).toContain("git push origin HEAD:main");
});

// --- how a run ends ---

test("a run over its time limit is aborted: the agent's signal fires and the card waits on the owner", async () => {
  await initRepo();
  let aborted = false;
  start({
    runLimitMs: 50,
    abortGraceMs: 500,
    driver: fakeDriver(async function* (options) {
      yield { type: "text", text: "working" };
      await new Promise<void>((resolve) => {
        options.signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        });
      });
    }),
  });
  await runCard("Too slow");

  expect(aborted).toBe(true);
  const said = comments(1).at(-1) as string;
  expect(said).toContain("time limit");
  const card = core.getCard(1);
  expect(card.claim).toBeNull();
  expect(card.attention).toMatchObject({ to: owner.id, note: said });
});

test("stop() during a live run ends it quickly and leaves the card waiting, not re-runnable", async () => {
  await initRepo();
  start({
    abortGraceMs: 500,
    driver: fakeDriver(async function* (options) {
      yield { type: "text", text: "working" };
      await new Promise<void>((resolve) => {
        options.signal.addEventListener("abort", () => resolve());
      });
    }),
  });
  const card = core.createCard({ title: "Interrupted" }, owner.id);
  const working = untilEvent(commentContaining(card.id, "working"));
  core.moveCard(card.id, "spec", owner.id);
  await working;

  const began = Date.now();
  await (runner as Runner).stop();
  runner = undefined;
  expect(Date.now() - began).toBeLessThan(3000);

  const detail = core.getCard(1);
  expect(detail.claim).toBeNull();
  expect(detail.attention?.note).toContain("daemon stopping");
  expect(comments(1).at(-1)).toContain("daemon stopping");
});

test("an agent that ends with an error result fails the run on the card", async () => {
  await initRepo();
  start({
    driver: fakeDriver(async function* () {
      yield { type: "result", ok: false, error: "the model refused" };
    }),
  });
  await runCard("Errored");
  expect(comments(1).at(-1)).toContain("the model refused");
  expect(core.getCard(1).attention?.note).toContain("the model refused");
});

test("an agent whose stream ends without a result fails the run rather than handing off", async () => {
  await initRepo();
  start({
    driver: fakeDriver(async function* () {
      yield { type: "text", text: "half a thought" };
    }),
  });
  await runCard("No result");
  expect(comments(1).at(-1)).toContain("without a result");
  expect(core.getCard(1).attention).not.toBeNull();
});

test("a driver that throws is reported on the card and the runner keeps going", async () => {
  await initRepo();
  start({
    driver: fakeDriver(async function* () {
      yield { type: "text", text: "before" };
      throw new Error("the harness died");
    }),
  });
  await runCard("Thrown");
  expect(comments(1).at(-1)).toContain("the harness died");

  const second = core.createCard({ title: "Next one" }, owner.id);
  const done = untilEvent(released(second.id));
  core.moveCard(second.id, "spec", owner.id);
  await done;
  expect(core.getCard(second.id).attention).not.toBeNull();
});

test("a run whose card is moved on mid-run writes nothing more to it than 'run abandoned'", async () => {
  await initRepo();
  start({
    abortGraceMs: 500,
    driver: fakeDriver(async function* (options) {
      yield { type: "text", text: "working" };
      await new Promise<void>((resolve) => {
        options.signal.addEventListener("abort", () => resolve());
      });
    }),
  });
  const card = core.createCard({ title: "Moved away" }, owner.id);
  const working = untilEvent(commentContaining(card.id, "working"));
  core.moveCard(card.id, "spec", owner.id);
  await working;

  const abandoned = untilEvent(commentContaining(card.id, "run abandoned"));
  core.moveCard(card.id, "pr", owner.id);
  await abandoned;
  await Bun.sleep(150);

  const detail = core.getCard(1);
  expect(detail.attention).toBeNull();
  expect(detail.phase).toBe("pr");
  expect(comments(1).some((text) => text.includes("run finished"))).toBe(false);
});

// --- an ending never replaces a question the agent raised ---

/** What `skelcrew attention <id> "<the conflict>"` does from the worktree: the shim's CLI
 * speaks as the `runner` member, so the raiser is indistinguishable from the run itself. */
function agentAsks(cardId: number, question: string): void {
  core.requestAttention(cardId, { to: owner.id, note: question }, runnerMember.id);
}

test("a question the agent raised is still the card's request after the session ends", async () => {
  await initRepo();
  start({
    driver: fakeDriver(async function* () {
      agentAsks(1, "which base branch?");
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Blocked");

  const card = core.getCard(1);
  expect(card.attention).toMatchObject({ to: owner.id, note: "which base branch?" });
  // The reason the run ended is still on the card, beside the question.
  expect(comments(1).at(-1)).toContain("run finished");
  expect(card.claim).toBeNull();
});

test("an aborted run does not replace the agent's question either", async () => {
  await initRepo();
  start({
    runLimitMs: 50,
    abortGraceMs: 500,
    driver: fakeDriver(async function* (options) {
      agentAsks(1, "the repository has no check command");
      yield { type: "text", text: "waiting" };
      await new Promise<void>((resolve) => {
        options.signal.addEventListener("abort", () => resolve());
      });
    }),
  });
  await runCard("Blocked, then too slow");

  expect(core.getCard(1).attention?.note).toBe("the repository has no check command");
  expect(comments(1).at(-1)).toContain("time limit");
});

test("a throw out of the run does not replace the agent's question either", async () => {
  await initRepo();
  // A driver whose iterator throws when the run closes it: a throw out of the run itself,
  // past every ending the run handles, so the runner's failed-step handler is what ends the
  // card. It must hand the card over by the same rule.
  const brokenDriver: AgentDriver = {
    run: () => ({
      [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
        let sent = false;
        return {
          next(): Promise<IteratorResult<AgentEvent>> {
            if (sent) return Promise.resolve({ done: true, value: undefined });
            sent = true;
            agentAsks(1, "the spec contradicts CLAUDE.md");
            return Promise.resolve({ done: false, value: { type: "result", ok: true } });
          },
          return(): never {
            throw new Error("the harness died on cleanup");
          },
        };
      },
    }),
  };
  start({ driver: brokenDriver });
  await runCard("Blocked, then broken");

  expect(core.getCard(1).attention?.note).toBe("the spec contradicts CLAUDE.md");
  expect(comments(1).at(-1)).toContain("the harness died on cleanup");
});

test("a run that raises no question ends by handing the card over with its own note", async () => {
  await initRepo();
  start({
    driver: fakeDriver(async function* () {
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Nothing to ask");

  const card = core.getCard(1);
  expect(card.attention).toMatchObject({ to: owner.id, raisedBy: runnerMember.id });
  expect(card.attention?.note).toContain("run finished");
  expect(comments(1)[0]).toContain("run log at ");
});

// --- the time limit as the daemon reads it ---

test("SKELCREW_RUN_MINUTES sets the limit; unset is an hour; anything else is refused", () => {
  expect(runLimitFromEnv({})).toBe(60 * 60_000);
  expect(runLimitFromEnv({ SKELCREW_RUN_MINUTES: "" })).toBe(60 * 60_000);
  expect(runLimitFromEnv({ SKELCREW_RUN_MINUTES: "5" })).toBe(5 * 60_000);
  expect(runLimitFromEnv({ SKELCREW_RUN_MINUTES: "0.5" })).toBe(30_000);
  for (const bad of ["0", "-1", "soon", "NaN"]) {
    expect(() => runLimitFromEnv({ SKELCREW_RUN_MINUTES: bad })).toThrow(/SKELCREW_RUN_MINUTES/);
  }
});
