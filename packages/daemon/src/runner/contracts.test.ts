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
  /** A core with one call replaced, for the failures the real one cannot be made to have. */
  core?: Core;
}

function start(options: StartOptions): Runner {
  runner = startRunner({
    core: options.core ?? core,
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
  expect(card.attention?.note).toContain("run finished without a spec");
  expect(card.attention?.moves).toEqual([]);
  expect(comments(1).at(-1)).toBe(card.attention?.note);
  expect(card.phase).toBe("spec");
  expect(lastRelease(1)).toBe("failed");
  // The owner's queue is where a failed run is read, so it says where to pick the work up.
  expect(card.attention?.note).toContain(`the work is in ${worktreePath(1)}`);
});

test("a body that was on the card before the run is not this run's spec", async () => {
  await initRepo();
  start({
    driver: fakeDriver(async function* () {
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Already had a body", "spec", "# an older spec\n");

  expect(comments(1).at(-1)).toContain("run finished without a spec");
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

  expect(comments(1).at(-1)).toContain("run finished without a spec");
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
  expect(said).toContain("no new commits on skelcrew/1-no-commits past main");
  expect(said).not.toContain("uncommitted changes");
  expect(said).not.toContain("no pull request recorded");
  expect(core.getCard(1).phase).toBe("code");
  expect(core.getCard(1).attention?.moves).toEqual([]);
  expect(await sh(repo, "worktree", "list", "--porcelain")).toContain(worktreePath(1));
  // The worktree is kept, so the note says where it is: that is the owner's exit ramp.
  expect(said).toContain(`the work is in ${worktreePath(1)}`);
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
  expect(said).not.toContain("no new commits on");
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
  expect(said).not.toContain("no new commits on");
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
  expect(said).not.toContain("no new commits on");
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
  expect(said).toContain("no new commits on skelcrew/1-nothing-at-all past main");
  expect(said).toContain("uncommitted changes in the worktree");
  expect(said).toContain("no pull request recorded during this run");
  expect(said.indexOf("no new commits on")).toBeLessThan(said.indexOf("uncommitted changes"));
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

/**
 * Criterion 6's third case. The playbook records the pull request on *every* run as
 * bookkeeping, so recording is not evidence of work: a revision run that does exactly what the
 * playbook says and commits nothing would otherwise meet all three conditions on the previous
 * run's commits, and hand the owner their own feedback back as "ready for review".
 */
test("a revision run that records the same PR but commits nothing fails: the branch did not move", async () => {
  await initRepo();
  let run = 0;
  start({
    driver: fakeDriver(async function* (options) {
      run += 1;
      if (run === 1) await commitIn(options.cwd, "feature.ts");
      // Every run records, first or revision — which is what the playbook prescribes.
      core.setRefs(1, { prUrl: PR_URL }, runnerMember.id);
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Idle but tidy", "code");
  expect(comments(1).at(-1)).toBe(`ready for review: ${PR_URL}`);

  const again = untilEvent(ended(1));
  core.moveCard(1, "pr", owner.id);
  core.moveCard(1, "code", owner.id);
  await again;

  expect(run).toBe(2);
  // The range past the base is not empty — the first run's commit is still on the branch —
  // and the worktree is clean and the PR recorded. Only the branch not having moved during
  // this run separates this from a finish.
  const range = "refs/heads/main..refs/heads/skelcrew/1-idle-but-tidy";
  expect(await sh(repo, "rev-list", "--count", range)).toBe("1");
  const card = core.getCard(1);
  expect(card.attention?.note).toContain("no new commits on skelcrew/1-idle-but-tidy past main");
  expect(card.attention?.moves).toEqual([]);
  expect(card.phase).toBe("code");
  expect(comments(1).at(-1)).not.toContain("ready for review");
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

  expect(comments(1).at(-1)).toContain("no new commits on skelcrew/1-shadowed-base past main");
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

  expect(comments(1).at(-1)).toContain("no new commits on skelcrew/1-shadowed-branch past main");
});

// --- the endings ---
//
// Every assertion below is derived from criteria 8-14 as the spec words them, and each case
// says which clause it is checking. That is worth stating because the code came first here:
// see "Red, then green" and "Re-deriving the ending assertions" in
// `docs/plans/014-a-phase-ends-in-a-verified-artefact.md`.
//
// The observable of an abandonment is the spec's own sentence — "the run abandons: one comment
// saying so, and nothing else" — so these check the comment, the absence of a request, and the
// absence of a release by the run. They deliberately do not check that the runner wrote nothing
// else at all: a move or an archive queues 006's teardown, whose "worktree removed" comment is
// not part of the ending.

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

/** "One comment saying so, and nothing else": no request, and no release by the run. */
function expectAbandoned(cardId: number): void {
  const card = core.getCard(cardId);
  expect(comments(cardId).filter((text) => text.includes("run abandoned"))).toHaveLength(1);
  expect(card.attention).toBeNull();
  expect(card.activity.some((e) => e.type === "released" && e.actorId === runnerMember.id)).toBe(
    false,
  );
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

  // Criterion 8: "one comment, no attention request, and the other member's claim intact".
  expectAbandoned(1);
  const card = core.getCard(1);
  expect(card.claim?.by).toBe(crew.id);
  // Nothing else was queued behind the takeover, so "nothing else" is checkable outright here.
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

  // Criterion 9: moved mid-run is an abandonment, and the move supersedes the release that
  // preceded it — so this is not the stop of criterion 10.
  expectAbandoned(1);
  expect(core.getCard(1).phase).toBe("pr");
});

test("a card archived mid-run ends the run as an abandonment, and an archive supersedes a release", async () => {
  await initRepo();
  await whileWorking(abortableDriver());

  const abandoned = untilEvent(commentContaining(1, "run abandoned"));
  core.releaseCard(1, { reason: "by hand" }, owner.id);
  core.archiveCard(1, owner.id);
  await abandoned;
  await Bun.sleep(200);

  // Criterion 9 again, with the archive superseding the release.
  expectAbandoned(1);
  expect(core.getCard(1).archivedAt).not.toBeNull();
  expect(warnings).toEqual([]);
});

test("a card moved away and back mid-run is still an abandonment, not a release", async () => {
  await initRepo();
  await whileWorking(abortableDriver());

  const abandoned = untilEvent(commentContaining(1, "run abandoned"));
  core.moveCard(1, "pr", owner.id);
  core.moveCard(1, "spec", owner.id);
  await abandoned;
  await Bun.sleep(200);

  // The card is free, unarchived and back in this run's phase, which is the shape criterion
  // 10's stop takes — but the spec's ending rule qualifies it with "and never moved away", so
  // this is an abandonment. Without that clause the card would look released to the run.
  expectAbandoned(1);
  expect(core.getCard(1).phase).toBe("spec");
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
  // Criterion 10, clause by clause. "Stops the run": the agent ran once and never resumed.
  expect(runs).toBe(1);
  // "With a comment and a request" — the request handed to the owner, which is what makes the
  // card wait rather than be picked up again: unclaimed and unarchived, it is only the open
  // request that keeps `isReady` false.
  expect(card.claim).toBeNull();
  expect(card.archivedAt).toBeNull();
  expect(card.attention?.to).toBe(owner.id);
  expect(comments(1).at(-1)).toBe(card.attention?.note);
  // "That is not superseded": the card is still in the phase this run was claimed in. A move
  // after the release supersedes it and the ending is an abandonment instead — the case above.
  expect(card.phase).toBe("spec");
  // The comment and the note say the run stopped: not that it was abandoned (which writes no
  // request at all), and not that anything was verified — no contract ran on this path, and
  // the spec attaches a phase move only to a met contract.
  expect(card.attention?.note).toContain("run stopped");
  expect(card.attention?.moves).toEqual([]);
  expect(comments(1).some((text) => text.includes("run abandoned"))).toBe(false);
  expect(comments(1).some((text) => text === "spec ready")).toBe(false);
  // "And no second run starts."
  expect(core.getCard(1).activity.filter((e) => e.type === "claimed")).toHaveLength(1);
  // The release on this path is the one that stopped the run, and it is the only one: the
  // card was free before the ending began, so the run records no release of its own.
  expect(card.activity.filter((e) => e.type === "released")).toHaveLength(1);
  expect(lastRelease(1)).toBe("taking it by hand");
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

  // Criterion 11: "abandons and returns the card to its queue as `run_interrupted`". The card
  // is free and in this run's phase, which is criterion 10's shape — the lapse is what tells
  // the two apart, and it is the reason, never the decision.
  expectAbandoned(1);
  expect(core.getCard(1).activity.map((e) => e.type)).toContain("run_interrupted");
  // Returned to its queue: the next run picked it up and ended normally.
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

  // Criterion 12: "fails the run with a comment naming what it did". Failing the run is
  // observable as the artefact never being handed on — the card carries no "ready for review"
  // and no move to PR was offered, because the contract never ran on a card the agent moved.
  const card = core.getCard(1);
  expect(card.phase).toBe("pr");
  expect(card.attention?.note).toContain("run failed");
  expect(card.attention?.note).toContain("moved its own card");
  expect(card.attention?.moves).toEqual([]);
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
  expect(card.attention?.note).toContain("run failed");
  expect(card.attention?.note).toContain("released its own card");
  expect(card.attention?.moves).toEqual([]);
  // The artefact check never ran, though the body this run wrote would have met it: a card the
  // agent released has skipped the check the phase exists for.
  expect(core.getCard(1).body).toBe("# a whole spec");
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

  // Criterion 12's second sentence: "If another member holds the card by then, the comment
  // lands and no attention request is raised" — this run's failure is not their queue to fill.
  const card = core.getCard(1);
  expect(card.claim?.by).toBe(crew.id);
  expect(comments(1).filter((text) => text.includes("run failed"))).toHaveLength(1);
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
  expect(comments(1).at(-1)).toContain("run finished without a spec");
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

test("a question stands when the lease lapses", async () => {
  await initRepo();
  let at = Date.now();
  const now = (): number => at;
  core.close();
  core = openCore(":memory:", { owner: "simon", now });
  owner = core.listMembers()[0] as Member;
  runnerMember = core.ensureMember("runner", "agent");
  start({
    now,
    driver: fakeDriver(async function* (options) {
      agentAsks(1, "the base branch has diverged since the spec was written");
      yield { type: "text", text: "working" };
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }),
  });
  core.createCard({ title: "Asked, then slept through it" }, owner.id);
  const working = untilEvent(commentContaining(1, "working"));
  core.moveCard(1, "spec", owner.id);
  await working;

  const abandoned = untilEvent(commentContaining(1, "run abandoned"));
  at += 10 * 60_000;
  core.sweepClaims();
  await abandoned;
  await Bun.sleep(200);

  expect(core.getCard(1).attention?.note).toBe(
    "the base branch has diverged since the spec was written",
  );
});

/**
 * A raise that throws is a harness failure, not the card waiting on an answer. The two look
 * the same from `endRun` unless they are told apart — and `ownerId()` is resolved inside the
 * `try` on purpose, so a member lookup that throws must not relabel a finished artefact.
 */
test("a raise that fails is not a standing question: the met artefact still releases finished", async () => {
  await initRepo();
  const refuses: Core = {
    ...core,
    requestAttention() {
      throw new Error("attention is down");
    },
  };
  start({
    core: refuses,
    driver: fakeDriver(async function* () {
      core.setBody(1, "# 1 — the spec", runnerMember.id);
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Raise fails", "spec");

  expect(comments(1).at(-1)).toBe("spec ready");
  expect(core.getCard(1).attention).toBeNull();
  expect(lastRelease(1)).toBe("finished");
  expect(warnings.some((line) => line.includes("attention is down"))).toBe(true);
});

/**
 * The batching window can still be open when the card goes. On an abandonment that is right —
 * "one comment saying so, and nothing else" — but the stop and the self-action both write to a
 * card the run no longer holds, and what the agent did is part of the record they write.
 * Dropping it there is a silent mutation.
 */
test("the tool calls still batched when a run is stopped land on the card with the ending", async () => {
  await initRepo();
  await whileWorking(
    fakeDriver(async function* (options) {
      yield { type: "text", text: "working" };
      yield { type: "tool_use", name: "Read", input: { file_path: "/repo/AGENTS.md" } };
      // Yielded after the tool call, so reaching the card means the call was batched first.
      yield { type: "text", text: "read it" };
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }),
  );
  await untilEvent(commentContaining(1, "read it"));

  const stopped = untilEvent(commentContaining(1, "run stopped"));
  core.releaseCard(1, { reason: "taking it by hand" }, owner.id);
  await stopped;

  const said = comments(1);
  expect(said).toContain("ran 1 tool: Read");
  expect(said.indexOf("ran 1 tool: Read")).toBeLessThan(
    said.findIndex((text) => text.includes("run stopped")),
  );
});

test("the tool calls still batched when the agent acts on its own card land with the ending", async () => {
  await initRepo();
  start({
    driver: fakeDriver(async function* () {
      yield { type: "tool_use", name: "Read", input: { file_path: "/repo/AGENTS.md" } };
      core.releaseCard(1, { reason: "done here" }, runnerMember.id);
      yield { type: "result", ok: true };
    }),
  });
  const done = untilEvent(commentContaining(1, "released its own card"));
  core.createCard({ title: "Tools, then let go" }, owner.id);
  core.moveCard(1, "spec", owner.id);
  await done;

  const said = comments(1);
  expect(said).toContain("ran 1 tool: Read");
  expect(said.indexOf("ran 1 tool: Read")).toBeLessThan(
    said.findIndex((text) => text.includes("released its own card")),
  );
});

test("an abandoned run writes nothing more, batched tool calls included", async () => {
  await initRepo();
  const crew = core.ensureMember("crew-1", "agent");
  await whileWorking(
    fakeDriver(async function* (options) {
      yield { type: "text", text: "working" };
      yield { type: "tool_use", name: "Read", input: { file_path: "/repo/AGENTS.md" } };
      yield { type: "text", text: "read it" };
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }),
  );
  await untilEvent(commentContaining(1, "read it"));

  const abandoned = untilEvent(commentContaining(1, "run abandoned"));
  core.releaseCard(1, { reason: "by hand" }, owner.id);
  core.claimCard(1, {}, crew.id);
  await abandoned;
  await Bun.sleep(200);

  // "One comment saying so, and nothing else" applies to the summary too.
  expectAbandoned(1);
  expect(comments(1)).not.toContain("ran 1 tool: Read");
});
