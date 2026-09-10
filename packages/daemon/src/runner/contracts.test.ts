/**
 * The artefact contracts and the endings, as a member sees them on the card: against a
 * scripted fake driver and real temporary git repositories. No test here spawns a coding
 * agent or calls a model — the driver is the boundary, and the script is the whole agent.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Activity, type Member, type Phase, worktreesDir } from "@skelcrew/shared";
import { type Core, openCore } from "../core/core";
import type { AgentDriver, AgentEvent, AgentRunOptions } from "./agent";
import { createGit, type Git } from "./git";
import { loadPlaybooks } from "./playbooks";
import { type Runner, startRunner } from "./runner";

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

const PR_URL = "https://example.invalid/skelcrew/pull/1";

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
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "skr-contract-")));
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

/** A commit in the worktree the agent was given, the way a real Code run would make one. */
async function commitIn(cwd: string, name: string): Promise<void> {
  writeFileSync(join(cwd, name), `${name}\n`);
  await sh(cwd, "add", name);
  await sh(cwd, "commit", "-q", "-m", `add ${name}`);
}

/** The agent, scripted: whatever the test's generator does is the whole run. */
function fakeDriver(script: (options: AgentRunOptions) => AsyncGenerator<AgentEvent>): AgentDriver {
  return { run: (options) => script(options) };
}

interface StartOptions {
  driver: AgentDriver;
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
    summaryMs: 60_000,
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

function ended(cardId: number): (event: Activity) => boolean {
  return (e) => e.cardId === cardId && e.type === "released";
}

function comments(cardId: number): string[] {
  return core
    .getCard(cardId)
    .activity.filter((e) => e.type === "comment")
    .map((e) => (e.data as { text: string }).text);
}

/** The reason of the card's last release: how the run handed the card back. */
function lastRelease(cardId: number): string | null | undefined {
  const releases = core.getCard(cardId).activity.filter((e) => e.type === "released");
  return releases.at(-1)?.data.reason;
}

function worktreePath(id: number): string {
  return join(worktreesDir(dataDir), String(id));
}

/** Files a card, moves it into `phase`, and waits for the run there to hand it back. */
async function runCard(title: string, phase: Phase, body?: string): Promise<number> {
  const card = core.createCard(body === undefined ? { title } : { title, body }, owner.id);
  const done = untilEvent(ended(card.id));
  core.moveCard(card.id, phase, owner.id);
  await done;
  return card.id;
}

// --- the Spec contract ---

test("a Spec run that writes a body hands the card on with the move into Code", async () => {
  await initRepo();
  start({
    driver: fakeDriver(async function* () {
      core.setBody(1, "# 1 — the spec\n\nGoal: ship it.", runnerMember.id);
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Write me a spec", "spec");

  const card = core.getCard(1);
  expect(comments(1).at(-1)).toBe("spec ready");
  expect(card.attention).toMatchObject({ to: owner.id, note: "spec ready", moves: ["code"] });
  expect(lastRelease(1)).toBe("finished");
  expect(card.phase).toBe("spec");
});

test("a Spec run that writes no body fails, and the request offers no move", async () => {
  await initRepo();
  start({
    driver: fakeDriver(async function* () {
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Nothing written", "spec");

  const card = core.getCard(1);
  expect(comments(1).at(-1)).toBe("run finished without a spec");
  expect(card.attention).toMatchObject({ note: "run finished without a spec", moves: [] });
  expect(card.phase).toBe("spec");
  expect(lastRelease(1)).toBe("failed");
});

test("a body that was on the card before the run is not this run's spec", async () => {
  await initRepo();
  start({
    driver: fakeDriver(async function* () {
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Already had a body", "spec", "# an older spec\n");

  expect(comments(1).at(-1)).toBe("run finished without a spec");
  expect(core.getCard(1).body).toBe("# an older spec\n");
});

test("a Spec run that writes an empty body has written no spec", async () => {
  await initRepo();
  start({
    driver: fakeDriver(async function* () {
      core.setBody(1, "   \n", runnerMember.id);
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Whitespace", "spec");

  expect(comments(1).at(-1)).toBe("run finished without a spec");
});

// --- the Code contract ---

test("a Code run that commits, leaves the worktree clean and records its PR hands the card on", async () => {
  await initRepo();
  start({
    driver: fakeDriver(async function* (options) {
      await commitIn(options.cwd, "feature.ts");
      core.setRefs(1, { prUrl: PR_URL }, runnerMember.id);
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Build it", "code");

  const card = core.getCard(1);
  const head = await sh(repo, "rev-parse", "refs/heads/skelcrew/1-build-it");
  expect(card.refs.commits).toEqual([head]);
  // Nothing was exported, so nothing was bookmarked — and the contract never asked.
  expect(card.refs.specPath).toBeUndefined();
  expect(comments(1).at(-1)).toBe(`ready for review: ${PR_URL}`);
  expect(card.attention).toMatchObject({
    to: owner.id,
    note: `ready for review: ${PR_URL}`,
    moves: ["pr"],
  });
  expect(lastRelease(1)).toBe("finished");
  expect(card.phase).toBe("code");
});

test("a Code run with no commits fails, names the condition, and keeps the worktree", async () => {
  await initRepo();
  start({
    driver: fakeDriver(async function* () {
      core.setRefs(1, { prUrl: PR_URL }, runnerMember.id);
      yield { type: "result", ok: true };
    }),
  });
  await runCard("No commits", "code");

  const said = comments(1).at(-1) as string;
  expect(said).toContain("no commits on skelcrew/1-no-commits past main");
  expect(said).not.toContain("uncommitted changes");
  expect(said).not.toContain("no pull request recorded");
  expect(core.getCard(1).phase).toBe("code");
  expect(core.getCard(1).attention?.moves).toEqual([]);
  expect(await sh(repo, "worktree", "list", "--porcelain")).toContain(worktreePath(1));
});

test("a Code run that leaves the worktree dirty fails and names that condition", async () => {
  await initRepo();
  start({
    driver: fakeDriver(async function* (options) {
      await commitIn(options.cwd, "feature.ts");
      writeFileSync(join(options.cwd, "scratch.txt"), "left behind\n");
      core.setRefs(1, { prUrl: PR_URL }, runnerMember.id);
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Dirty", "code");

  const said = comments(1).at(-1) as string;
  expect(said).toContain("uncommitted changes in the worktree");
  expect(said).not.toContain("no commits on");
  expect(said).not.toContain("no pull request recorded");
  expect(core.getCard(1).phase).toBe("code");
  expect(await sh(repo, "worktree", "list", "--porcelain")).toContain(worktreePath(1));
});

test("a Code run that records no PR fails and names that condition", async () => {
  await initRepo();
  start({
    driver: fakeDriver(async function* (options) {
      await commitIn(options.cwd, "feature.ts");
      yield { type: "result", ok: true };
    }),
  });
  await runCard("No PR", "code");

  const said = comments(1).at(-1) as string;
  expect(said).toContain("no pull request recorded during this run");
  expect(said).not.toContain("no commits on");
  expect(said).not.toContain("uncommitted changes");
  expect(core.getCard(1).phase).toBe("code");
  expect(await sh(repo, "worktree", "list", "--porcelain")).toContain(worktreePath(1));
});

test("a Code run failing two conditions names both, in a stable order", async () => {
  await initRepo();
  start({
    driver: fakeDriver(async function* (options) {
      // Committed work, but left dirty and never recorded: two of the three unmet.
      await commitIn(options.cwd, "feature.ts");
      writeFileSync(join(options.cwd, "scratch.txt"), "never committed\n");
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Two unmet", "code");

  const said = comments(1).at(-1) as string;
  expect(said).not.toContain("no commits on");
  expect(said).toContain("uncommitted changes in the worktree");
  expect(said).toContain("no pull request recorded during this run");
  expect(said.indexOf("uncommitted changes")).toBeLessThan(said.indexOf("no pull request"));
});

test("all three unmet are named at once, in a stable order", async () => {
  await initRepo();
  start({
    driver: fakeDriver(async function* (options) {
      writeFileSync(join(options.cwd, "scratch.txt"), "never committed\n");
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Nothing at all", "code");

  const said = comments(1).at(-1) as string;
  expect(said).toContain("no commits on skelcrew/1-nothing-at-all past main");
  expect(said).toContain("uncommitted changes in the worktree");
  expect(said).toContain("no pull request recorded during this run");
  expect(said.indexOf("no commits on")).toBeLessThan(said.indexOf("uncommitted changes"));
  expect(said.indexOf("uncommitted changes")).toBeLessThan(said.indexOf("no pull request"));
});

// --- revisions: the same PR, recorded again ---

test("a revision run that re-records the same PR and makes new commits passes", async () => {
  await initRepo();
  let run = 0;
  start({
    driver: fakeDriver(async function* (options) {
      run += 1;
      await commitIn(options.cwd, `feature-${run}.ts`);
      core.setRefs(1, { prUrl: PR_URL }, runnerMember.id);
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Revised", "code");
  expect(comments(1).at(-1)).toBe(`ready for review: ${PR_URL}`);

  // The owner sends it back: same branch, same pull request, another round of work.
  const again = untilEvent(ended(1));
  core.moveCard(1, "pr", owner.id);
  core.moveCard(1, "code", owner.id);
  await again;

  expect(run).toBe(2);
  expect(comments(1).at(-1)).toBe(`ready for review: ${PR_URL}`);
  expect(core.getCard(1).refs.commits).toHaveLength(2);
  expect(lastRelease(1)).toBe("finished");
});

test("a revision run that records nothing fails, though the card carries a PR and the branch commits", async () => {
  await initRepo();
  let run = 0;
  start({
    driver: fakeDriver(async function* (options) {
      run += 1;
      if (run === 1) {
        await commitIn(options.cwd, "feature.ts");
        core.setRefs(1, { prUrl: PR_URL }, runnerMember.id);
      }
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Idle revision", "code");
  expect(comments(1).at(-1)).toBe(`ready for review: ${PR_URL}`);

  const again = untilEvent(ended(1));
  core.moveCard(1, "pr", owner.id);
  core.moveCard(1, "code", owner.id);
  await again;

  expect(run).toBe(2);
  const card = core.getCard(1);
  expect(card.refs.prUrl).toBe(PR_URL);
  expect(comments(1).at(-1)).toContain("no pull request recorded during this run");
  expect(card.phase).toBe("code");
});

// --- a tag that shadows a branch name ---

test("a tag named after the base branch does not make an empty branch look like work", async () => {
  await initRepo();
  await sh(repo, "commit", "-q", "--allow-empty", "-m", "second");
  // The tag is one commit behind main, so `main..<branch>` through the tag reports one
  // commit where the truth is zero.
  await sh(repo, "tag", "main", "HEAD~1");
  start({
    driver: fakeDriver(async function* () {
      core.setRefs(1, { prUrl: PR_URL }, runnerMember.id);
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Shadowed base", "code");

  expect(comments(1).at(-1)).toContain("no commits on skelcrew/1-shadowed-base past main");
});

test("a tag named after the card's branch does not make an empty branch look like work", async () => {
  await initRepo();
  await sh(repo, "commit", "-q", "--allow-empty", "-m", "second");
  // A tag sharing the card's branch name, one commit ahead of where the branch will be cut.
  await sh(repo, "tag", "skelcrew/1-shadowed-branch", "HEAD");
  await sh(repo, "update-ref", "refs/heads/main", "HEAD~1");
  start({
    driver: fakeDriver(async function* () {
      core.setRefs(1, { prUrl: PR_URL }, runnerMember.id);
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Shadowed branch", "code");

  expect(comments(1).at(-1)).toContain("no commits on skelcrew/1-shadowed-branch past main");
});

// --- the endings ---

/** A driver that works until the run tells it to stop, then ends its session. */
function abortableDriver(): AgentDriver {
  return fakeDriver(async function* (options) {
    yield { type: "text", text: "working" };
    await new Promise<void>((resolve) => {
      if (options.signal.aborted) resolve();
      else options.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
}

/**
 * What `skelcrew attention <id> "<the question>"` does from the worktree: the shim's CLI
 * speaks as the `runner` member, so the raiser is indistinguishable from the run itself.
 */
function agentAsks(cardId: number, question: string): void {
  core.requestAttention(cardId, { to: owner.id, note: question }, runnerMember.id);
}

function commentContaining(cardId: number, text: string): (event: Activity) => boolean {
  return (e) => e.cardId === cardId && e.type === "comment" && e.data.text.includes(text);
}

/** Starts a run and resolves once the agent has spoken, so the test can act mid-run. */
async function whileWorking(driver: AgentDriver, phase: Phase = "spec"): Promise<void> {
  start({ driver });
  core.createCard({ title: "Live run" }, owner.id);
  const working = untilEvent(commentContaining(1, "working"));
  core.moveCard(1, phase, owner.id);
  await working;
}

test("a card another member claims mid-run ends the run as an abandonment", async () => {
  await initRepo();
  const crew = core.ensureMember("crew-1", "agent");
  await whileWorking(abortableDriver());

  const abandoned = untilEvent(commentContaining(1, "run abandoned"));
  core.releaseCard(1, { reason: "taking it by hand" }, owner.id);
  core.claimCard(1, {}, crew.id);
  await abandoned;
  await Bun.sleep(200);

  const card = core.getCard(1);
  expect(card.claim?.by).toBe(crew.id);
  expect(card.attention).toBeNull();
  expect(comments(1).filter((text) => text.includes("run abandoned"))).toHaveLength(1);
  expect(comments(1).some((text) => text.includes("run stopped"))).toBe(false);
  // Once the card was taken, the run wrote the one comment and nothing else.
  const taken = card.activity.findLastIndex((e) => e.type === "claimed");
  expect(card.activity.slice(taken).filter((e) => e.actorId === runnerMember.id)).toHaveLength(1);
});

test("a card moved mid-run ends the run as an abandonment, and a move supersedes a release", async () => {
  await initRepo();
  await whileWorking(abortableDriver());

  const abandoned = untilEvent(commentContaining(1, "run abandoned"));
  core.releaseCard(1, { reason: "by hand" }, owner.id);
  core.moveCard(1, "pr", owner.id);
  await abandoned;
  await Bun.sleep(200);

  const card = core.getCard(1);
  expect(card.phase).toBe("pr");
  expect(card.attention).toBeNull();
  expect(comments(1).some((text) => text.includes("run stopped"))).toBe(false);
});

test("a card archived mid-run ends the run as an abandonment, and an archive supersedes a release", async () => {
  await initRepo();
  await whileWorking(abortableDriver());

  const abandoned = untilEvent(commentContaining(1, "run abandoned"));
  core.releaseCard(1, { reason: "by hand" }, owner.id);
  core.archiveCard(1, owner.id);
  await abandoned;
  await Bun.sleep(200);

  const card = core.getCard(1);
  expect(card.archivedAt).not.toBeNull();
  expect(card.attention).toBeNull();
  expect(comments(1).some((text) => text.includes("run stopped"))).toBe(false);
  expect(warnings).toEqual([]);
});

test("a card moved away and back mid-run is still an abandonment, not a release", async () => {
  await initRepo();
  await whileWorking(abortableDriver());

  const abandoned = untilEvent(commentContaining(1, "run abandoned"));
  core.moveCard(1, "pr", owner.id);
  core.moveCard(1, "spec", owner.id);
  await abandoned;

  expect(comments(1).some((text) => text.includes("run stopped"))).toBe(false);
});

test("an explicit release stops the run with a comment and a request, and no second run starts", async () => {
  await initRepo();
  let runs = 0;
  await whileWorking(
    fakeDriver(async function* (options) {
      runs += 1;
      yield { type: "text", text: "working" };
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }),
  );

  const stopped = untilEvent((e) => e.cardId === 1 && e.type === "attention_requested");
  core.releaseCard(1, { reason: "taking it by hand" }, owner.id);
  await stopped;
  await Bun.sleep(300);

  const card = core.getCard(1);
  expect(runs).toBe(1);
  expect(card.claim).toBeNull();
  expect(card.phase).toBe("spec");
  expect(comments(1).at(-1)).toContain("run stopped");
  expect(card.attention?.note).toContain("run stopped");
  expect(card.attention?.moves).toEqual([]);
  expect(comments(1).some((text) => text.includes("run abandoned"))).toBe(false);
});

test("a lapsed lease abandons the run and returns the card to its queue as run_interrupted", async () => {
  await initRepo();
  let at = Date.now();
  const now = (): number => at;
  core.close();
  core = openCore(":memory:", { owner: "simon", now });
  owner = core.listMembers()[0] as Member;
  runnerMember = core.ensureMember("runner", "agent");

  let runs = 0;
  start({
    now,
    driver: fakeDriver(async function* (options) {
      runs += 1;
      if (runs > 1) {
        yield { type: "result", ok: true };
        return;
      }
      yield { type: "text", text: "working" };
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }),
  });
  core.createCard({ title: "Slept through it" }, owner.id);
  const working = untilEvent(commentContaining(1, "working"));
  core.moveCard(1, "spec", owner.id);
  await working;

  const abandoned = untilEvent(commentContaining(1, "run abandoned"));
  at += 10 * 60_000;
  core.sweepClaims();
  await abandoned;

  expect(core.getCard(1).activity.map((e) => e.type)).toContain("run_interrupted");
  expect(comments(1).some((text) => text.includes("run stopped"))).toBe(false);
  // The card went back to its queue: the next run picked it up and ended normally.
  await untilEvent((e) => e.cardId === 1 && e.type === "attention_requested");
  expect(runs).toBe(2);
});

// --- the agent acting on its own card ---

test("an agent that moves its own card fails the run, naming what it did", async () => {
  await initRepo();
  start({
    driver: fakeDriver(async function* () {
      core.moveCard(1, "pr", runnerMember.id);
      yield { type: "result", ok: true };
    }),
  });
  const done = untilEvent(commentContaining(1, "moved its own card from code to pr"));
  core.createCard({ title: "Moved itself" }, owner.id);
  core.moveCard(1, "code", owner.id);
  await done;
  await Bun.sleep(200);

  const card = core.getCard(1);
  expect(card.phase).toBe("pr");
  expect(card.attention?.note).toContain("moved its own card");
  expect(comments(1).some((text) => text.includes("ready for review"))).toBe(false);
});

test("an agent that releases its own card fails the run, naming what it did", async () => {
  await initRepo();
  start({
    driver: fakeDriver(async function* () {
      core.setBody(1, "# a whole spec", runnerMember.id);
      core.releaseCard(1, { reason: "done here" }, runnerMember.id);
      yield { type: "result", ok: true };
    }),
  });
  const done = untilEvent((e) => e.cardId === 1 && e.type === "attention_requested");
  core.createCard({ title: "Released itself" }, owner.id);
  core.moveCard(1, "spec", owner.id);
  await done;

  const card = core.getCard(1);
  expect(comments(1).at(-1)).toContain("released its own card");
  expect(card.attention?.note).toContain("released its own card");
  expect(card.attention?.moves).toEqual([]);
  // The artefact check never ran: a card the agent released has skipped it.
  expect(comments(1).some((text) => text === "spec ready")).toBe(false);
});

test("an agent that archives its own card fails the run, and nothing is raised on it", async () => {
  await initRepo();
  start({
    driver: fakeDriver(async function* () {
      core.archiveCard(1, runnerMember.id);
      yield { type: "result", ok: true };
    }),
  });
  const done = untilEvent(commentContaining(1, "archived its own card"));
  core.createCard({ title: "Archived itself" }, owner.id);
  core.moveCard(1, "spec", owner.id);
  await done;
  await Bun.sleep(200);

  const card = core.getCard(1);
  expect(card.archivedAt).not.toBeNull();
  expect(card.attention).toBeNull();
  expect(warnings).toEqual([]);
});

test("a self-action after another member takes the card lands as a comment and nothing else", async () => {
  await initRepo();
  const crew = core.ensureMember("crew-1", "agent");
  start({
    driver: fakeDriver(async function* () {
      core.releaseCard(1, { reason: "done here" }, runnerMember.id);
      core.claimCard(1, {}, crew.id);
      yield { type: "result", ok: true };
    }),
  });
  const done = untilEvent(commentContaining(1, "released its own card"));
  core.createCard({ title: "Handed over" }, owner.id);
  core.moveCard(1, "spec", owner.id);
  await done;
  await Bun.sleep(200);

  const card = core.getCard(1);
  expect(card.claim?.by).toBe(crew.id);
  expect(card.attention).toBeNull();
  expect(warnings).toEqual([]);
});

// --- a question the agent raised is never replaced, on any path ---

test("a question stands when the artefact is complete: the run says so, offers no move, releases blocked", async () => {
  await initRepo();
  let runs = 0;
  start({
    driver: fakeDriver(async function* () {
      runs += 1;
      if (runs === 1) {
        core.setBody(1, "# the spec, with one open question", runnerMember.id);
        agentAsks(1, "should this replace the old flow, or sit beside it?");
      }
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Complete but blocked", "spec");

  const card = core.getCard(1);
  expect(comments(1).at(-1)).toBe("spec ready");
  expect(card.attention?.note).toBe("should this replace the old flow, or sit beside it?");
  expect(card.attention?.moves).toEqual([]);
  expect(lastRelease(1)).toBe("blocked");

  // Answering the question makes the card ready again, and the phase runs afresh.
  const again = untilEvent(ended(1));
  core.resolveAttention(1, "beside it", owner.id);
  await again;
  expect(runs).toBe(2);
});

test("a question stands when the contract is unmet: the failure is a comment, not a new request", async () => {
  await initRepo();
  start({
    driver: fakeDriver(async function* () {
      agentAsks(1, "there is no check command in this repository");
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Blocked and empty", "spec");

  const card = core.getCard(1);
  expect(comments(1).at(-1)).toBe("run finished without a spec");
  expect(card.attention?.note).toBe("there is no check command in this repository");
  expect(lastRelease(1)).toBe("blocked");
});

test("a question stands when the daemon stops mid-run", async () => {
  await initRepo();
  await whileWorking(
    fakeDriver(async function* (options) {
      agentAsks(1, "the spec contradicts CLAUDE.md");
      yield { type: "text", text: "working" };
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }),
  );
  await (runner as Runner).stop();
  runner = undefined;

  expect(core.getCard(1).attention?.note).toBe("the spec contradicts CLAUDE.md");
  expect(comments(1).at(-1)).toContain("daemon stopping");
});

test("a question stands when the run is abandoned", async () => {
  await initRepo();
  const crew = core.ensureMember("crew-1", "agent");
  await whileWorking(
    fakeDriver(async function* (options) {
      agentAsks(1, "which base branch?");
      yield { type: "text", text: "working" };
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }),
  );

  const abandoned = untilEvent(commentContaining(1, "run abandoned"));
  core.releaseCard(1, { reason: "by hand" }, owner.id);
  core.claimCard(1, {}, crew.id);
  await abandoned;

  expect(core.getCard(1).attention?.note).toBe("which base branch?");
});

test("a question stands when an explicit release stops the run", async () => {
  await initRepo();
  await whileWorking(
    fakeDriver(async function* (options) {
      agentAsks(1, "the fixture data disagrees with the spec");
      yield { type: "text", text: "working" };
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }),
  );

  const said = untilEvent(commentContaining(1, "run stopped"));
  core.releaseCard(1, { reason: "taking it by hand" }, owner.id);
  await said;

  expect(core.getCard(1).attention?.note).toBe("the fixture data disagrees with the spec");
});

test("a question stands when the agent acted on its own card", async () => {
  await initRepo();
  start({
    driver: fakeDriver(async function* () {
      agentAsks(1, "the card contradicts the repository's constraints");
      core.releaseCard(1, { reason: "done here" }, runnerMember.id);
      yield { type: "result", ok: true };
    }),
  });
  const done = untilEvent(commentContaining(1, "released its own card"));
  core.createCard({ title: "Asked, then let go" }, owner.id);
  core.moveCard(1, "spec", owner.id);
  await done;

  expect(core.getCard(1).attention?.note).toBe("the card contradicts the repository's constraints");
});
