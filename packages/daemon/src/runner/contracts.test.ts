/**
 * The artefact contracts and the endings, as a member sees them on the card: against a
 * scripted fake driver and real temporary git repositories. No test here spawns a coding
 * agent or calls a model — the driver is the boundary, and the script is the whole agent.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Activity, type Member, type Phase, worktreesDir } from "@skelcrew/shared";
import { type Core, openCore } from "../core/core";
import { mergePoll } from "../merges";
import type { AgentDriver, AgentEvent, AgentRunOptions } from "./agent";
import {
  baseBranchGrants,
  deniedTools,
  editsIn,
  FIXED_ALLOWLIST,
  REVIEW_ALLOWLIST,
  runsUnprompted,
} from "./allowlist";
import type { Forge } from "./forge";
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
/** The repository `PR_URL` lives in, as the faked forge of the merge test below reports it. */
const REPO_URL = "https://example.invalid/skelcrew";

let tmp: string;
let repo: string;
let dataDir: string;
let core: Core;
let owner: Member;
let runnerMember: Member;
let crewMember: Member;
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
  crewMember = core.ensureMember("crew", "agent");
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

type Script = (options: AgentRunOptions) => AsyncGenerator<AgentEvent>;

/** Whether this run is the review run: its system prompt is the review playbook. */
function reviewing(options: AgentRunOptions): boolean {
  return options.systemPrompt === playbooks.review;
}

/** A reviewer that approves and ends — what a Code run's met contract now has to pass. */
async function* approving(): AsyncGenerator<AgentEvent> {
  core.review(1, { verdict: "approved" }, crewMember.id);
  yield { type: "result", ok: true };
}

/**
 * The scripted agent for a Code card past 019, where one claim runs two kinds of run: the
 * driver branches on the system prompt, which is the only thing that tells it which it is in.
 * The review run approves unless a test hands in a reviewer of its own.
 */
function scripted(implement: Script, review: Script = approving): AgentDriver {
  return fakeDriver((options) => (reviewing(options) ? review(options) : implement(options)));
}

interface StartOptions {
  driver: AgentDriver;
  runLimitMs?: number;
  abortGraceMs?: number;
  now?: () => number;
  /** A core with one call replaced, for the failures the real one cannot be made to have. */
  core?: Core;
  /** A git with one call replaced, for the same reason. */
  git?: Git;
}

function start(options: StartOptions): Runner {
  runner = startRunner({
    core: options.core ?? core,
    dataDir,
    repoRoot: repo,
    git: options.git ?? git,
    member: runnerMember,
    crew: crewMember,
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
      core.setBody(1, "# 1 — the spec\n\nGoal: ship it.", crewMember.id);
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
      core.setBody(1, "   \n", crewMember.id);
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
    driver: scripted(async function* (options) {
      await commitIn(options.cwd, "feature.ts");
      core.setRefs(1, { prUrl: PR_URL }, crewMember.id);
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
      core.setRefs(1, { prUrl: PR_URL }, crewMember.id);
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
      core.setRefs(1, { prUrl: PR_URL }, crewMember.id);
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
    driver: scripted(async function* (options) {
      run += 1;
      await commitIn(options.cwd, `feature-${run}.ts`);
      core.setRefs(1, { prUrl: PR_URL }, crewMember.id);
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
    driver: scripted(async function* (options) {
      run += 1;
      if (run === 1) {
        await commitIn(options.cwd, "feature.ts");
        core.setRefs(1, { prUrl: PR_URL }, crewMember.id);
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
    driver: scripted(async function* (options) {
      run += 1;
      if (run === 1) await commitIn(options.cwd, "feature.ts");
      // Every run records, first or revision — which is what the playbook prescribes.
      core.setRefs(1, { prUrl: PR_URL }, crewMember.id);
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

// --- the owner's merge lands the card in Done ---

/**
 * 018's criterion 8, end to end: the merge poll's move as the owner composed with the runner,
 * and the send-back loop still turning from one phase further on. The forge is faked here as
 * the driver is — nothing in this file spawns `gh` or a coding agent.
 */
test("a merged pull request lands the card in Done; the owner can still send it back to Code", async () => {
  await initRepo();
  let run = 0;
  start({
    driver: scripted(async function* (options) {
      run += 1;
      await commitIn(options.cwd, `feature-${run}.ts`);
      core.setRefs(1, { prUrl: PR_URL }, crewMember.id);
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Merge me", "code");
  expect(comments(1).at(-1)).toBe(`ready for review: ${PR_URL}`);

  // The owner approves into PR, and merges on the forge.
  core.moveCard(1, "pr", owner.id);
  const asked: string[] = [];
  const forge: Forge = {
    async pullRequest(_repoRoot, url) {
      asked.push(url);
      return {
        url,
        state: "merged",
        mergedAt: "2026-09-09T08:44:11Z",
        headRefName: core.getCard(1).refs.branch as string,
        baseRepo: REPO_URL,
        baseRefName: "main",
        // What the real `gh` answers about a merged pull request (020).
        mergeable: "unknown",
      };
    },
    async repoUrl() {
      return REPO_URL;
    },
  };
  const poller = mergePoll({
    core,
    forge,
    repoRoot: repo,
    runnerId: runnerMember.id,
    warn: (line) => warnings.push(line),
  });
  await poller.tick();

  expect(core.getCard(1).phase).toBe("done");
  expect(asked).toEqual([PR_URL]);
  const landed = core.getCard(1).activity.slice(-2);
  expect(landed[0]).toMatchObject({ type: "comment", actorId: runnerMember.id });
  expect(landed[1]).toMatchObject({ type: "card_moved", actorId: owner.id });

  // Send-back from Done still works, and re-dispatches with history intact.
  const again = untilEvent(ended(1));
  core.moveCard(1, "code", owner.id);
  await again;

  expect(run).toBe(2);
  expect(core.getCard(1).phase).toBe("code");
  expect(core.getCard(1).refs.commits).toHaveLength(2);

  // And the daemon does not move it back: a card outside PR is not asked about.
  await poller.tick();
  expect(asked).toEqual([PR_URL]);
  expect(core.getCard(1).phase).toBe("code");
  expect(warnings).toEqual([]);
});

// --- a conflicting pull request offers the move back to Code (020) ---

/**
 * 020's criterion 8, end to end: the owner merges something else, the poll finds this card's
 * pull request conflicting and hands the card over with the move attached, and the owner's one
 * gesture — `skelcrew mv <id> code`, which is `moveCard` here — resolves the request as `moved`
 * and starts the fix run on the same branch, with the card in front of it.
 */
test("a conflicting pull request hands the card over, and the owner's move starts the fix run", async () => {
  await initRepo();
  const seen: AgentRunOptions[] = [];
  const messages: string[] = [];
  let run = 0;
  start({
    driver: scripted(async function* (options) {
      seen.push(options);
      messages.push(await firstMessage(options));
      run += 1;
      await commitIn(options.cwd, `feature-${run}.ts`);
      core.setRefs(1, { prUrl: PR_URL }, crewMember.id);
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Fix me up", "code");
  core.moveCard(1, "pr", owner.id);
  const branch = core.getCard(1).refs.branch as string;

  const forge: Forge = {
    async pullRequest(_repoRoot, url) {
      return {
        url,
        state: "open",
        headRefName: branch,
        baseRepo: REPO_URL,
        baseRefName: "main",
        mergeable: "conflicting",
      };
    },
    async repoUrl() {
      return REPO_URL;
    },
  };
  await mergePoll({
    core,
    forge,
    repoRoot: repo,
    runnerId: runnerMember.id,
    warn: (line) => warnings.push(line),
  }).tick();

  const note = `pull request ${PR_URL} conflicts with main; ${branch} needs refs/remotes/origin/main merged in`;
  const waiting = core.getCard(1);
  expect(waiting.phase).toBe("pr");
  expect(waiting.attention).toMatchObject({ to: owner.id, note, moves: ["code"] });
  expect(comments(1).at(-1)).toBe(note);

  // The owner takes the offered move. The request resolves as `moved`, the runner claims the
  // card, and the fix run works the same branch with the card — conflict note and all — on it.
  const fixed = untilEvent(ended(1));
  core.moveCard(1, "code", owner.id);
  await fixed;

  expect(run).toBe(2);
  expect(
    core
      .getCard(1)
      .activity.filter((e) => e.type === "attention_resolved")
      .at(-1),
  ).toMatchObject({ data: { how: "moved", phase: "code" } });
  expect(messages[1]).toContain("Card 1: Fix me up");
  expect((seen[1] as AgentRunOptions).cwd).toBe(worktreePath(1));
  expect(core.getCard(1).refs.branch).toBe(branch);
  // What the run reads the note from is the card itself, through `skelcrew show`.
  expect(comments(1)).toContain(note);
  // And the two commands its brief tells it to run do not stop to ask.
  for (const command of ["git fetch origin main", "git merge --no-edit refs/remotes/origin/main"]) {
    expect([
      command,
      runsUnprompted("Bash", { command }, (seen[1] as AgentRunOptions).allowedTools),
    ]).toEqual([command, true]);
  }
});

/**
 * Review round 1, Important 2, against a real run's refs: the branch the ownership check reads
 * is the one *this* run recorded as `runner` at run start, so `crew` rewriting both `branch` and
 * `prUrl` — two writes the core allows it — buys nothing.
 */
test("crew pointing a card's refs at another merged pull request leaves it in PR", async () => {
  await initRepo();
  start({
    driver: scripted(async function* (options) {
      await commitIn(options.cwd, "feature.ts");
      core.setRefs(1, { prUrl: PR_URL }, crewMember.id);
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Probe", "code");
  const recorded = core.getCard(1).refs.branch as string;
  expect(recorded).toBe("skelcrew/1-probe");

  core.moveCard(1, "pr", owner.id);
  // `crew`'s two writes: someone else's merged pull request, and a branch matching its head.
  const foreign = "https://example.invalid/skelcrew/pull/99";
  core.setRefs(1, { branch: "someone-elses", prUrl: foreign }, crewMember.id);

  const forge: Forge = {
    async pullRequest(_repoRoot, url) {
      return {
        url,
        state: "merged",
        mergedAt: "2026-09-09T08:44:11Z",
        headRefName: "someone-elses",
        baseRepo: REPO_URL,
        baseRefName: "main",
        mergeable: "unknown",
      };
    },
    async repoUrl() {
      return REPO_URL;
    },
  };
  await mergePoll({
    core,
    forge,
    repoRoot: repo,
    runnerId: runnerMember.id,
    warn: (line) => warnings.push(line),
  }).tick();

  expect(core.getCard(1).phase).toBe("pr");
  expect(comments(1).at(-1)).toBe(
    `pull request ${foreign} is merged, but it is not this card's work: its head branch is someone-elses, not ${recorded}`,
  );
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
      core.setRefs(1, { prUrl: PR_URL }, crewMember.id);
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
      core.setRefs(1, { prUrl: PR_URL }, crewMember.id);
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
 * What `skelcrew attention <id> "<the question>"` does from the worktree: the shim's CLI,
 * speaking as the `crew` member the run spawned the agent as. What tells this request from the
 * run's own permission question is still the value the run recorded when it raised, never the
 * raiser — see `ending.ts`.
 */
function agentAsks(cardId: number, question: string): void {
  core.requestAttention(cardId, { to: owner.id, note: question }, crewMember.id);
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
  crewMember = core.ensureMember("crew", "agent");

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

/**
 * 024, criteria 4 and 5. A run that lapsed while waiting on its own permission question used to
 * leave that question open and addressed to the owner, where nothing could answer it —
 * `resolve -m allow` allows no tool once the run is gone — so the card was neither running nor
 * queued until the owner cleared it by hand. The sweep now takes the question with the claim,
 * and only that one: a question anyone else raised can still be answered, so it stands.
 *
 * A core on a clock the test moves, so a lease lapses without anyone sleeping.
 */
function onAFakeClock(): { now: () => number; tick(ms: number): void } {
  let at = Date.now();
  const now = (): number => at;
  core.close();
  core = openCore(":memory:", { owner: "simon", now });
  owner = core.listMembers()[0] as Member;
  runnerMember = core.ensureMember("runner", "agent");
  crewMember = core.ensureMember("crew", "agent");
  return {
    now,
    tick(ms) {
      at += ms;
    },
  };
}

test("a lapsed lease takes the run's own question with it, and the card is claimed again", async () => {
  await initRepo();
  const clock = onAFakeClock();
  let runs = 0;
  start({
    now: clock.now,
    driver: fakeDriver(async function* (options) {
      runs += 1;
      if (runs > 1) {
        yield { type: "result", ok: true };
        return;
      }
      // A tool outside the fixed list: a question on the card, which this run waits for.
      void options.canUseTool("Bash", { command: "rm -rf build" });
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }),
  });
  core.createCard({ title: "Asked and slept" }, owner.id);
  const asked = untilEvent((e) => e.cardId === 1 && e.type === "attention_requested");
  core.moveCard(1, "spec", owner.id);
  await asked;
  expect(core.getCard(1).attention?.raisedBy).toBe(runnerMember.id);

  const seqBefore = core.getCard(1).activity.at(-1)?.seq ?? 0;
  const abandoned = untilEvent(commentContaining(1, "run abandoned"));
  clock.tick(10 * 60_000);
  expect(core.sweepClaims()).toEqual([1]);

  // The sweep is one synchronous mutation, so this is the card the moment it swept.
  expect(core.getCard(1).attention).toBeNull();
  expect(core.getCard(1).claim).toBeNull();
  expect(core.getCard(1).phase).toBe("spec");
  const swept = core.activitySince(seqBefore).filter((e) => e.cardId === 1);
  expect(swept.map((e) => [e.type, e.actorId])).toEqual([
    ["run_interrupted", runnerMember.id],
    ["attention_resolved", runnerMember.id],
  ]);
  expect(swept[1]).toMatchObject({ data: { how: "interrupted" } });

  await abandoned;
  // Free in a claimable phase: the next scan claims it, and the second run ends normally.
  await untilEvent((e) => e.cardId === 1 && e.type === "attention_requested");
  expect(runs).toBe(2);
  expect(core.getCard(1).activity.filter((e) => e.type === "claimed")).toHaveLength(2);
  expect(comments(1).filter((text) => text.includes("run abandoned"))).toHaveLength(1);
});

/**
 * Criterion 5, for each of the two raisers it names: a question the run did not raise can still
 * be answered, so the sweep leaves it, and the card stays out of the runner's queue until a
 * member answers it — which is `isReady`'s existing rule, unchanged.
 */
const OTHER_RAISERS = [
  {
    whose: "the agent's own",
    note: "which repository should I use?",
    // What `skelcrew attention` does from the worktree: the agent's question, as `crew`.
    raise: (): void => agentAsks(1, "which repository should I use?"),
    raisedBy: (): number => crewMember.id,
  },
  {
    whose: "the owner's",
    note: "have a look at this first",
    raise: (): void => {
      core.requestAttention(1, { to: owner.id, note: "have a look at this first" }, owner.id);
    },
    raisedBy: (): number => owner.id,
  },
] as const;

for (const raiser of OTHER_RAISERS) {
  test(`a lapsed lease leaves ${raiser.whose} question standing, and the card is not claimed again`, async () => {
    await initRepo();
    const clock = onAFakeClock();
    let runs = 0;
    start({
      now: clock.now,
      driver: fakeDriver(async function* (options) {
        runs += 1;
        yield { type: "text", text: "working" };
        await new Promise<void>((resolve) => {
          if (options.signal.aborted) resolve();
          else options.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }),
    });
    core.createCard({ title: "Asked by somebody else" }, owner.id);
    const working = untilEvent(commentContaining(1, "working"));
    core.moveCard(1, "spec", owner.id);
    await working;
    raiser.raise();

    const abandoned = untilEvent(commentContaining(1, "run abandoned"));
    clock.tick(10 * 60_000);
    expect(core.sweepClaims()).toEqual([1]);

    expect(core.getCard(1).attention).toMatchObject({
      raisedBy: raiser.raisedBy(),
      note: raiser.note,
    });
    await abandoned;
    await Bun.sleep(200);

    // Still waiting on a member, and so not ready: no second claim, and no second run.
    expect(core.getCard(1).attention?.raisedBy).toBe(raiser.raisedBy());
    expect(core.getCard(1).activity.filter((e) => e.type === "claimed")).toHaveLength(1);
    expect(core.getCard(1).activity.some((e) => e.type === "attention_resolved")).toBe(false);
    expect(runs).toBe(1);
  });
}

// --- the agent acting on its own card ---
//
// 014 drove all three self-actions as the `runner` member, because the agent spoke as the
// runner and the core let a holder move and archive its own card. 016 closed both of those at
// the core — every phase is the owner's to leave, and archiving is the owner's — and the two
// rules know nothing about which agent member is asking, so the *runner* is refused as well.
// The two cases below therefore assert the refusal where they used to assert the ending, and
// the release, which the holder may still make, keeps the ending covered as 014 wrote it.
// `classifyEnding` keeps its move and archive branches: nothing in the core can reach them now,
// and they cost nothing — defence in depth, not the boundary.

test("the core refuses even the runner's own move out of Code, and the run still ends on its contract", async () => {
  await initRepo();
  let refused: string | undefined;
  start({
    driver: scripted(async function* (options) {
      try {
        core.moveCard(1, "pr", runnerMember.id);
      } catch (error) {
        refused = (error as Error).message;
      }
      await commitIn(options.cwd, "feature.ts");
      core.setRefs(1, { prUrl: PR_URL }, crewMember.id);
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Tried to move itself", "code");

  expect(refused).toContain("only the owner may move a card out of code");
  const card = core.getCard(1);
  expect(card.phase).toBe("code");
  expect(card.activity.filter((e) => e.type === "move_rejected")).toMatchObject([
    { actorId: runnerMember.id, data: { from: "code", to: "pr" } },
  ]);
  // The gate held, so the phase ended the way it is supposed to: the artefact checked, and the
  // move into PR offered to the owner rather than taken.
  expect(comments(1).at(-1)).toBe(`ready for review: ${PR_URL}`);
  expect(card.attention?.moves).toEqual(["pr"]);
  expect(lastRelease(1)).toBe("finished");
});

test("an agent that releases its own card fails the run, naming what it did", async () => {
  await initRepo();
  start({
    driver: fakeDriver(async function* () {
      core.setBody(1, "# a whole spec", crewMember.id);
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

/**
 * The spec's own claim, end to end: the agent, speaking as itself, cannot cross the gate by any
 * call it can make. Each attempt is refused on the daemon's facts — the claim is the runner's —
 * and the run ends where it was always going to, with the artefact checked and the move offered.
 */
test("the agent as crew cannot move, release or archive the card it is working: the run ends on its contract", async () => {
  await initRepo();
  const refusals: string[] = [];
  start({
    driver: fakeDriver(async function* () {
      for (const attempt of [
        () => core.moveCard(1, "code", crewMember.id),
        () => core.releaseCard(1, { reason: "done here" }, crewMember.id),
        () => core.archiveCard(1, crewMember.id),
        () => core.claimCard(1, {}, crewMember.id),
      ]) {
        try {
          attempt();
        } catch (error) {
          refusals.push((error as Error).message);
        }
      }
      core.setBody(1, "# the spec", crewMember.id);
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Tries every gate", "spec");

  expect(refusals).toHaveLength(4);
  expect(refusals[0]).toContain("only the owner may move a card out of spec");
  expect(refusals[1]).toContain("may not release it");
  expect(refusals[2]).toContain("only the owner may archive a card");
  expect(refusals[3]).toContain("claimed by runner");

  const card = core.getCard(1);
  expect(card.phase).toBe("spec");
  expect(card.archivedAt).toBeNull();
  expect(comments(1).at(-1)).toBe("spec ready");
  expect(card.attention).toMatchObject({ to: owner.id, moves: ["code"] });
  expect(lastRelease(1)).toBe("finished");
  // The claim was the runner's from first to last, and the release is the run's own ending.
  expect(card.activity.filter((e) => e.type === "claimed").map((e) => e.actorId)).toEqual([
    runnerMember.id,
  ]);
  expect(card.activity.filter((e) => e.type === "released").map((e) => e.actorId)).toEqual([
    runnerMember.id,
  ]);
});

test("the core refuses even the runner's own archive, and the card is still there at the end", async () => {
  await initRepo();
  let refused: string | undefined;
  start({
    driver: fakeDriver(async function* () {
      try {
        core.archiveCard(1, runnerMember.id);
      } catch (error) {
        refused = (error as Error).message;
      }
      core.setBody(1, "# the spec", crewMember.id);
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Tried to archive itself", "spec");

  expect(refused).toContain("only the owner may archive a card");
  const card = core.getCard(1);
  expect(card.archivedAt).toBeNull();
  expect(card.activity.some((e) => e.type === "card_archived")).toBe(false);
  expect(comments(1).at(-1)).toBe("spec ready");
  expect(card.attention?.moves).toEqual(["code"]);
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
        core.setBody(1, "# the spec, with one open question", crewMember.id);
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
  crewMember = core.ensureMember("crew", "agent");
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
      core.setBody(1, "# 1 — the spec", crewMember.id);
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

// --- the review loop (019) ---
//
// One claim, two kinds of run: a met Code contract is reviewed before the owner is asked
// anything, and what the review records decides whether the card is handed on, fixed and
// reviewed again, or handed over with the budget spent. The scripted driver plays whichever
// run it is in by reading the system prompt it was given.

/** A Code run that meets its contract: one commit, and the pull request recorded. */
function implementing(name = "feature.ts"): Script {
  return async function* (options) {
    await commitIn(options.cwd, name);
    core.setRefs(1, { prUrl: PR_URL }, crewMember.id);
    yield { type: "result", ok: true };
  };
}

/** A reviewer that asks for changes, naming what it found. */
function requesting(text: string): Script {
  return async function* () {
    core.review(1, { verdict: "changes_requested", text }, crewMember.id);
    yield { type: "result", ok: true };
  };
}

/** The first user message a run was handed: the card, as `run.ts` composes it. */
async function firstMessage(options: AgentRunOptions): Promise<string> {
  for await (const message of options.input) return message;
  return "";
}

/** The run log a comment names. */
function logPathFrom(comment: string): string {
  const at = comment.indexOf("run log at ");
  expect(at).toBeGreaterThanOrEqual(0);
  return comment.slice(at + "run log at ".length).trim();
}

/** Every verdict on the card, in order, as `<actor>:<verdict>`. */
function verdicts(cardId: number): string[] {
  return core
    .getCard(cardId)
    .activity.filter((e) => e.type === "review_recorded")
    .map((e) => `${e.actorId}:${(e.data as { verdict: string }).verdict}`);
}

/** Whether the card's worktree is still registered: an unmet contract keeps it. */
async function worktreeKept(id: number): Promise<boolean> {
  return (await sh(repo, "worktree", "list", "--porcelain")).includes(worktreePath(id));
}

/**
 * Criteria 3 and 4. The Code run's activity, then the round the runner opened, then the
 * review run's — under one claim, in one worktree, with nothing handed to anyone in between.
 */
test("a met Code contract is reviewed under the same claim, and an approval hands the card on", async () => {
  await initRepo();
  const seen: AgentRunOptions[] = [];
  /** Who held the claim inside each run, read by the agent itself. */
  const held: Array<number | undefined> = [];
  start({
    driver: scripted(
      async function* (options) {
        seen.push(options);
        held.push(core.getCard(1).claim?.by);
        yield { type: "text", text: "implemented it" };
        await commitIn(options.cwd, "feature.ts");
        core.setRefs(1, { prUrl: PR_URL }, crewMember.id);
        yield { type: "result", ok: true };
      },
      async function* (options) {
        seen.push(options);
        held.push(core.getCard(1).claim?.by);
        yield { type: "text", text: "read the whole diff" };
        core.review(1, { verdict: "approved" }, crewMember.id);
        yield { type: "result", ok: true };
      },
    ),
  });
  await runCard("Reviewed first", "code");

  // The claim was the runner's inside both runs, not only at the ends.
  expect(held).toEqual([runnerMember.id, runnerMember.id]);

  const said = comments(1);
  const round = said.findIndex((text) => text.startsWith("review round 1 of 3 starting"));
  expect(round).toBeGreaterThanOrEqual(0);
  expect(said.indexOf("implemented it")).toBeLessThan(round);
  expect(round).toBeLessThan(said.indexOf("read the whole diff"));

  // Two runs, the second the reviewer's, in the same worktree, each with its own log file.
  expect(seen.map((options) => options.systemPrompt)).toEqual([playbooks.code, playbooks.review]);
  expect(seen.map((options) => options.cwd)).toEqual([worktreePath(1), worktreePath(1)]);
  const logs = said.filter((text) => text.includes("run log at ")).map(logPathFrom);
  expect(logs).toHaveLength(2);
  expect(logs[0]).not.toBe(logs[1]);
  for (const log of logs) expect(existsSync(log)).toBe(true);

  // Nothing between the two runs: no release, no request, and one claim, the runner's.
  const card = core.getCard(1);
  const types = card.activity.map((e) => e.type);
  expect(types.filter((type) => type === "claimed")).toHaveLength(1);
  expect(types.filter((type) => type === "released")).toHaveLength(1);
  expect(types.filter((type) => type === "attention_requested")).toHaveLength(1);
  expect(types.slice(-3)).toEqual(["comment", "attention_requested", "released"]);
  expect(card.activity.find((e) => e.type === "claimed")?.actorId).toBe(runnerMember.id);

  // Criterion 4: 014's criterion 4 exactly, now behind a review.
  expect(said.at(-1)).toBe(`ready for review: ${PR_URL}`);
  expect(card.attention).toMatchObject({
    to: owner.id,
    note: `ready for review: ${PR_URL}`,
    moves: ["pr"],
  });
  expect(lastRelease(1)).toBe("finished");
  expect(card.phase).toBe("code");
  expect(verdicts(1)).toEqual([`${crewMember.id}:approved`]);
  expect(warnings).toEqual([]);
});

/**
 * *The loop runs under one claim*: a met Code contract starts a review **only when nothing is
 * waiting on the owner**. Here the agent asked its own question and then finished the artefact,
 * so the Code run ends there with 014's ending for that case — the artefact named, no move, the
 * question standing, released blocked — and no reviewer is spawned. A reviewer under that
 * request could raise no permission question of its own and would block until its time limit.
 */
test("a met Code contract under the agent's own standing question starts no review", async () => {
  await initRepo();
  const seen: AgentRunOptions[] = [];
  start({
    driver: scripted(async function* (options) {
      seen.push(options);
      agentAsks(1, "does the fix belong here or in a card of its own?");
      await commitIn(options.cwd, "feature.ts");
      core.setRefs(1, { prUrl: PR_URL }, crewMember.id);
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Asked, and finished anyway", "code");

  const said = comments(1);
  expect(said.some((text) => text.startsWith("review round 1 of 3 starting"))).toBe(false);
  // One run in the loop, and it was the Code run: the driver saw one system prompt.
  expect(seen.map((options) => options.systemPrompt)).toEqual([playbooks.code]);
  expect(verdicts(1)).toEqual([]);

  const card = core.getCard(1);
  expect(said.at(-1)).toBe(`ready for review: ${PR_URL}`);
  expect(card.attention?.note).toBe("does the fix belong here or in a card of its own?");
  expect(card.attention?.moves).toEqual([]);
  expect(lastRelease(1)).toBe("blocked");
  expect(card.phase).toBe("code");
});

/**
 * *The loop runs under one claim*: **the same rule binds the review → fix transition**. Here the
 * reviewer raised its own `skelcrew attention` question and then recorded `changes_requested` —
 * both of which its playbook instructs — and the loop ends there rather than starting a fix run
 * that could raise no permission question of its own and would block until its time limit.
 */
test("a reviewer's own standing question ends the loop: no fix run starts", async () => {
  await initRepo();
  const seen: AgentRunOptions[] = [];
  start({
    driver: scripted(
      async function* (options) {
        seen.push(options);
        await commitIn(options.cwd, "feature.ts");
        core.setRefs(1, { prUrl: PR_URL }, crewMember.id);
        yield { type: "result", ok: true };
      },
      async function* (options) {
        seen.push(options);
        agentAsks(1, "is the second half this card's, or a card of its own?");
        core.review(
          1,
          { verdict: "changes_requested", text: "Critical: the second half" },
          crewMember.id,
        );
        yield { type: "result", ok: true };
      },
    ),
  });
  await runCard("Reviewed, and asked", "code");

  const said = comments(1);
  expect(said.some((text) => text.startsWith("fix run starting"))).toBe(false);
  // Two runs in the loop, the Code run and the review: the driver saw two system prompts.
  expect(seen.map((options) => options.systemPrompt)).toEqual([playbooks.code, playbooks.review]);
  expect(verdicts(1)).toEqual([`${crewMember.id}:changes_requested`]);

  const card = core.getCard(1);
  // The reviewer has just said the work is not ready, so the Code run's note is not what the
  // card's last word may be: the comment says what the card is waiting on instead.
  expect(said.at(-1)).toBe(
    `changes requested; the reviewer is waiting on an answer; the work is in ${worktreePath(1)}`,
  );
  expect(said.some((text) => text.startsWith("ready for review"))).toBe(false);
  expect(card.attention?.note).toBe("is the second half this card's, or a card of its own?");
  expect(card.attention?.moves).toEqual([]);
  expect(lastRelease(1)).toBe("blocked");
  expect(card.phase).toBe("code");
});

/** Criterion 5. The findings are on the card, and the card is the fix run's brief. */
test("changes requested starts a fix run whose brief is the card, then a second review", async () => {
  await initRepo();
  const briefs: string[] = [];
  let codeRuns = 0;
  let reviews = 0;
  start({
    driver: scripted(
      async function* (options) {
        codeRuns += 1;
        briefs.push(await firstMessage(options));
        await commitIn(options.cwd, `feature-${codeRuns}.ts`);
        core.setRefs(1, { prUrl: PR_URL }, crewMember.id);
        yield { type: "result", ok: true };
      },
      async function* (options) {
        reviews += 1;
        if (reviews === 1)
          return yield* requesting("Critical: the note is composed, not fixed")(options);
        core.review(1, { verdict: "approved" }, crewMember.id);
        yield { type: "result", ok: true };
      },
    ),
  });
  await runCard("Sent back once", "code", "# the spec\n\nGoal: ship it.");

  expect([codeRuns, reviews]).toEqual([2, 2]);
  const said = comments(1);
  expect(said.some((text) => text.startsWith("review round 2 of 3 starting"))).toBe(true);
  // The fix run's first user message is the card: its id, title, branch and body.
  expect(briefs[1]).toContain("Card 1: Sent back once");
  expect(briefs[1]).toContain("Branch: skelcrew/1-sent-back-once (from main)");
  expect(briefs[1]).toContain("Goal: ship it.");
  // The card as it is now: nothing edited it here, so the body it carries is the one on the card.
  expect(briefs[1]).toContain(core.getCard(1).body);
  // The findings the fix run works from are on the card, as the last verdict.
  expect(verdicts(1)).toEqual([`${crewMember.id}:changes_requested`, `${crewMember.id}:approved`]);
  const card = core.getCard(1);
  expect(said.at(-1)).toBe(`ready for review: ${PR_URL}`);
  expect(card.attention?.moves).toEqual(["pr"]);
  expect(lastRelease(1)).toBe("finished");
  expect(card.refs.commits).toHaveLength(2);
  expect(card.activity.filter((e) => e.type === "claimed")).toHaveLength(1);
});

/**
 * Criterion 5's "whose first user message is the card", read as *the card*: every run in the
 * loop composes its brief from the card as it is then. The owner editing the body while the
 * review is live is the ordinary case — the claim is the runner's for the whole loop, and
 * `setBody` is the owner's to call throughout — and the fix run must work from what they wrote.
 */
test("a fix run's brief is the card as it is now, not as it was when the claim was taken", async () => {
  await initRepo();
  const briefs: string[] = [];
  let codeRuns = 0;
  let reviews = 0;
  start({
    driver: scripted(
      async function* (options) {
        codeRuns += 1;
        briefs.push(await firstMessage(options));
        await commitIn(options.cwd, `feature-${codeRuns}.ts`);
        core.setRefs(1, { prUrl: PR_URL }, crewMember.id);
        yield { type: "result", ok: true };
      },
      async function* (options) {
        reviews += 1;
        if (reviews === 1) {
          core.setBody(1, "# the spec\n\nGoal: ship it, and the second half too.", owner.id);
          return yield* requesting("Critical: the second half is missing")(options);
        }
        core.review(1, { verdict: "approved" }, crewMember.id);
        yield { type: "result", ok: true };
      },
    ),
  });
  await runCard("Edited mid-claim", "code", "# the spec\n\nGoal: ship it.");

  expect([codeRuns, reviews]).toEqual([2, 2]);
  expect(briefs[0]).toContain("Goal: ship it.");
  expect(briefs[0]).not.toContain("the second half too");
  // Still the card — id, title, branch, body — and the body is the one the owner left.
  expect(briefs[1]).toContain("Card 1: Edited mid-claim");
  expect(briefs[1]).toContain("Branch: skelcrew/1-edited-mid-claim (from main)");
  expect(briefs[1]).toContain("Goal: ship it, and the second half too.");
});

/**
 * Criterion 5's second half. The Code contract applies to a fix run unchanged, so a fix run
 * that concludes nothing should change fails the way any Code run with no commits does — and
 * the loop stops there rather than reviewing the same branch again.
 */
test("a fix run that commits nothing fails the Code contract, and no further review starts", async () => {
  await initRepo();
  let codeRuns = 0;
  let reviews = 0;
  start({
    driver: scripted(
      async function* (options) {
        codeRuns += 1;
        if (codeRuns === 1) await commitIn(options.cwd, "feature.ts");
        // The playbook records the pull request on every run, fix runs included.
        core.setRefs(1, { prUrl: PR_URL }, crewMember.id);
        yield { type: "result", ok: true };
      },
      async function* (options) {
        reviews += 1;
        yield* requesting("Critical: this needs a test")(options);
      },
    ),
  });
  await runCard("Nothing to fix", "code");

  expect([codeRuns, reviews]).toEqual([2, 1]);
  const said = comments(1).at(-1) as string;
  expect(said).toContain("no new commits on skelcrew/1-nothing-to-fix past main");
  expect(said).toContain(`the work is in ${worktreePath(1)}`);
  expect(comments(1).some((text) => text.startsWith("review round 2"))).toBe(false);
  const card = core.getCard(1);
  expect(card.phase).toBe("code");
  expect(card.attention?.moves).toEqual([]);
  expect(lastRelease(1)).toBe("failed");
  expect(await worktreeKept(1)).toBe(true);
});

/** Criterion 6. Three changes-requested is the budget, and the owner decides what follows. */
test("a third changes-requested ends the run: the budget is spent and the owner is handed the card", async () => {
  await initRepo();
  let codeRuns = 0;
  let reviews = 0;
  start({
    driver: scripted(
      async function* (options) {
        codeRuns += 1;
        await commitIn(options.cwd, `feature-${codeRuns}.ts`);
        core.setRefs(1, { prUrl: PR_URL }, crewMember.id);
        yield { type: "result", ok: true };
      },
      async function* (options) {
        reviews += 1;
        yield* requesting(`Critical: still wrong, round ${reviews}`)(options);
      },
    ),
  });
  await runCard("Never satisfied", "code");

  expect([codeRuns, reviews]).toEqual([3, 3]);
  const note = `review budget spent: changes requested 3 times; the last review names what is open; the work is in ${worktreePath(1)}`;
  const said = comments(1);
  expect(said.at(-1)).toBe(note);
  expect(said.some((text) => text.startsWith("review round 3 of 3 starting"))).toBe(true);
  expect(said.some((text) => text.startsWith("review round 4"))).toBe(false);
  const card = core.getCard(1);
  expect(card.attention).toMatchObject({ to: owner.id, note, moves: ["pr"] });
  expect(lastRelease(1)).toBe("finished");
  expect(card.phase).toBe("code");
  expect(verdicts(1)).toEqual(Array(3).fill(`${crewMember.id}:changes_requested`));
});

/** Criterion 7. A review run has a contract of its own, and each condition names itself. */
test("a review run that records no verdict fails, keeps the worktree, and leaves the card in Code", async () => {
  await initRepo();
  start({
    driver: scripted(implementing(), async function* () {
      yield { type: "text", text: "I read it and had nothing to say" };
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Silent reviewer", "code");

  const card = core.getCard(1);
  expect(comments(1).at(-1)).toBe(
    `review run ended without a verdict; the work is in ${worktreePath(1)}`,
  );
  expect(card.attention?.note).toBe(comments(1).at(-1));
  expect(card.attention?.moves).toEqual([]);
  expect(card.phase).toBe("code");
  expect(lastRelease(1)).toBe("failed");
  expect(await worktreeKept(1)).toBe(true);
  expect(comments(1).some((text) => text.includes("ready for review"))).toBe(false);
});

/**
 * A failed step names the step that failed. The read this fails is the branch head each run is
 * measured against, which the runner takes before it opens the run's log — so the note the owner
 * reads has to say the head could not be read, not that a file could not be opened.
 */
test("a branch head that cannot be read before the review run names that step, not the log", async () => {
  await initRepo();
  /** The head read for the *review* run: the first one after the Code run's work was recorded. */
  const failing: Git = {
    ...git,
    async revParse(root, ref) {
      const recorded = core
        .getCard(1)
        .activity.some(
          (e) =>
            e.type === "refs_set" &&
            e.actorId === runnerMember.id &&
            (e.data.set ?? []).includes("commits"),
        );
      if (recorded && ref.startsWith("refs/heads/skelcrew/")) {
        throw new Error("fatal: ambiguous argument");
      }
      return git.revParse(root, ref);
    },
  };
  start({ driver: scripted(implementing()), git: failing });
  await runCard("Unreadable head", "code");

  const said = comments(1).at(-1) as string;
  expect(said).toContain("read the review branch head failed");
  expect(said).toContain("fatal: ambiguous argument");
  expect(said).not.toContain("run log");
  expect(lastRelease(1)).toBe("failed");
});

/**
 * The same failure, parked: a run that ends before it has opened a log of its own must not name
 * the *previous* run's log. `logPath` is a value the loop reuses across rounds, and a parked note
 * pointing at the Code run's log would send the owner to a file holding none of this.
 */
test("a run that ends before its log exists parks the card without naming another run's log", async () => {
  await initRepo();
  const failing: Git = {
    ...git,
    async revParse(root, ref) {
      const recorded = core
        .getCard(1)
        .activity.some(
          (e) =>
            e.type === "refs_set" &&
            e.actorId === runnerMember.id &&
            (e.data.set ?? []).includes("commits"),
        );
      if (recorded && ref.startsWith("refs/heads/skelcrew/")) {
        throw new Error("fatal: ambiguous argument");
      }
      return git.revParse(root, ref);
    },
  };
  const failed = (text: string): boolean => text.startsWith("read the review branch head failed");
  const refuses: Core = {
    ...core,
    comment(id, text, actorId) {
      if (failed(text)) throw new Error("comment is down");
      return core.comment(id, text, actorId);
    },
    requestAttention(id, request, actorId) {
      if (failed(request.note)) throw new Error("attention is down");
      return core.requestAttention(id, request, actorId);
    },
  };
  start({ core: refuses, driver: scripted(implementing()), git: failing });
  await runCard("Parked before its log", "code");

  const card = core.getCard(1);
  const note = card.attention?.note as string;
  const codeRunLog = logPathFrom(
    comments(1).find((text) => text.includes("run log at ")) as string,
  );
  expect(note).not.toContain(codeRunLog);
  expect(note).toBe("run ended and could not record why");
  expect(card.attention?.moves).toEqual([]);
});

test("a review run that moved the branch fails naming it, and its verdict is ignored", async () => {
  await initRepo();
  start({
    driver: scripted(implementing(), async function* (options) {
      // Through a check command's subprocess is how this reaches the repository; the contract
      // is what catches it, whatever the verdict says.
      await commitIn(options.cwd, "reviewer-was-here.ts");
      core.review(1, { verdict: "approved" }, crewMember.id);
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Busy reviewer", "code");

  const said = comments(1).at(-1) as string;
  expect(said).toContain("the branch moved during the review run");
  expect(said).not.toContain("without a verdict");
  expect(said).not.toContain("uncommitted changes");
  expect(said).toContain(`the work is in ${worktreePath(1)}`);
  expect(verdicts(1)).toEqual([`${crewMember.id}:approved`]);
  const card = core.getCard(1);
  expect(card.attention?.moves).toEqual([]);
  expect(card.phase).toBe("code");
  expect(lastRelease(1)).toBe("failed");
  expect(comments(1).some((text) => text.includes("ready for review"))).toBe(false);
});

test("a review run that left the worktree dirty fails naming that, and its verdict is ignored", async () => {
  await initRepo();
  start({
    driver: scripted(implementing(), async function* (options) {
      writeFileSync(join(options.cwd, "notes.txt"), "my working notes\n");
      core.review(1, { verdict: "approved" }, crewMember.id);
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Untidy reviewer", "code");

  const said = comments(1).at(-1) as string;
  expect(said).toContain("uncommitted changes in the worktree");
  expect(said).not.toContain("without a verdict");
  expect(said).not.toContain("the branch moved");
  expect(core.getCard(1).phase).toBe("code");
  expect(lastRelease(1)).toBe("failed");
  expect(comments(1).some((text) => text.includes("ready for review"))).toBe(false);
});

/** Criterion 8, from the options the driver was handed, for both run kinds in one loop. */
test("the driver sees the review list for the review run and the Code list for the Code run", async () => {
  await initRepo();
  const seen: AgentRunOptions[] = [];
  start({
    driver: scripted(
      async function* (options) {
        seen.push(options);
        yield* implementing()(options);
      },
      async function* (options) {
        seen.push(options);
        yield* approving();
      },
    ),
  });
  await runCard("Two lists", "code");

  const [code, review] = seen as [AgentRunOptions, AgentRunOptions];
  // The Code run's list is 013's and 016's, plus the two entries composed from the base
  // branch's name (020) — which are a Code run's alone.
  expect(code.allowedTools).toEqual([
    ...FIXED_ALLOWLIST,
    editsIn(worktreePath(1)),
    ...baseBranchGrants("main"),
  ]);
  expect(code.disallowedTools).toEqual(deniedTools(worktreePath(1)));
  // The review run's is the review list exactly: no file-tool entry, and no write verb.
  expect(review.allowedTools).toEqual([...REVIEW_ALLOWLIST]);
  expect(review.disallowedTools).toEqual(["Edit", "Write", "NotebookEdit"]);
  for (const entry of review.allowedTools) expect(entry.startsWith("Edit(")).toBe(false);
  for (const absent of [
    "Bash(git add *)",
    "Bash(git commit *)",
    "Bash(git push -u origin HEAD)",
    "Bash(git push)",
    "Bash(gh pr create *)",
    "Bash(gh pr comment *)",
    "Bash(git fetch origin main)",
    "Bash(git merge --no-edit refs/remotes/origin/main)",
  ]) {
    expect(review.allowedTools).not.toContain(absent);
  }
});

/**
 * Criterion 9. The loop counts only what the review run itself recorded as `crew`: a verdict
 * the owner records is activity, and so is one the agent records during a Code run.
 */
test("verdicts recorded outside the review run do not decide it", async () => {
  await initRepo();
  let reviews = 0;
  let codeRuns = 0;
  start({
    driver: scripted(
      async function* (options) {
        codeRuns += 1;
        if (codeRuns === 1) {
          // The owner's own verdict, before the review run starts, and the agent's own during
          // the Code run — neither is the review run's.
          core.review(1, { verdict: "approved", text: "looks fine to me" }, owner.id);
          core.review(1, { verdict: "approved" }, crewMember.id);
        }
        yield* implementing(`feature-${codeRuns}.ts`)(options);
      },
      async function* (options) {
        reviews += 1;
        if (reviews === 1) return yield* requesting("Critical: not so fast")(options);
        core.review(1, { verdict: "approved" }, crewMember.id);
        yield { type: "result", ok: true };
      },
    ),
  });
  await runCard("Not decided early", "code");

  // The review run asked for changes, so a fix run followed — the two earlier approvals
  // changed nothing.
  expect([codeRuns, reviews]).toEqual([2, 2]);
  expect(verdicts(1)).toEqual([
    `${owner.id}:approved`,
    `${crewMember.id}:approved`,
    `${crewMember.id}:changes_requested`,
    `${crewMember.id}:approved`,
  ]);
  expect(comments(1).at(-1)).toBe(`ready for review: ${PR_URL}`);
});

test("a review run that records two verdicts is judged by the last", async () => {
  await initRepo();
  let reviews = 0;
  let codeRuns = 0;
  start({
    driver: scripted(
      async function* (options) {
        codeRuns += 1;
        yield* implementing(`feature-${codeRuns}.ts`)(options);
      },
      async function* () {
        reviews += 1;
        // Round 1 ends on changes requested; round 2 ends on approved.
        if (reviews === 1) {
          core.review(1, { verdict: "approved" }, crewMember.id);
          core.review(
            1,
            { verdict: "changes_requested", text: "Critical: on reflection" },
            crewMember.id,
          );
        } else {
          core.review(1, { verdict: "changes_requested", text: "Critical: wait" }, crewMember.id);
          core.review(1, { verdict: "approved" }, crewMember.id);
        }
        yield { type: "result", ok: true };
      },
    ),
  });
  await runCard("Two minds", "code");

  expect([codeRuns, reviews]).toEqual([2, 2]);
  expect(comments(1).at(-1)).toBe(`ready for review: ${PR_URL}`);
  expect(lastRelease(1)).toBe("finished");
});

// --- every existing ending, one run later (criterion 10) ---
//
// The time limit is per run; the daemon stopping, the owner releasing the card, another member
// claiming it and a question left open each end the loop on the run they happened in, with the
// ending 014 gives it. These are 014's criteria 8 through 14, moved to the review run.

/** A reviewer that reads and then waits: live until the run tells it to stop. */
const reviewerAtWork: Script = async function* (options) {
  yield { type: "text", text: "reading the diff" };
  await new Promise<void>((resolve) => {
    if (options.signal.aborted) resolve();
    else options.signal.addEventListener("abort", () => resolve(), { once: true });
  });
};

/**
 * A Code card whose first run meets its contract, resolved once the review run is live — so a
 * test can do to a review run what 014's cases did to the run before it.
 */
async function whileReviewing(
  review: Script,
  options: Omit<StartOptions, "driver"> = {},
): Promise<void> {
  start({ ...options, driver: scripted(implementing(), review) });
  core.createCard({ title: "Live review" }, owner.id);
  const live = untilEvent(commentContaining(1, "reading the diff"));
  core.moveCard(1, "code", owner.id);
  await live;
}

/**
 * The limit is per run, and the runner's is one number for every run in the loop — so the Code
 * run that must finish before the reviewer starts is bounded by it too. Its five git spawns
 * against a real repository are the slow part, and a budget tight enough to keep this case quick
 * is a budget a loaded machine can blow *there*, failing this case on the wrong run. The budget
 * is therefore generous and the case is given the wall-clock time to spend it.
 */
test("a review run over the time limit ends the loop with 014's time-limit note", async () => {
  await initRepo();
  await whileReviewing(reviewerAtWork, { runLimitMs: 3000, abortGraceMs: 500 });

  await untilEvent(ended(1), 10_000);
  const said = comments(1).at(-1) as string;
  expect(said).toContain("time limit");
  const card = core.getCard(1);
  expect(card.attention).toMatchObject({ to: owner.id, note: said, moves: [] });
  expect(card.activity.filter((e) => e.type === "released")).toHaveLength(1);
  expect(comments(1).some((text) => text.includes("ready for review"))).toBe(false);
  expect(card.phase).toBe("code");
}, 20_000);

test("the daemon stopping ends a live review run as daemon stopping", async () => {
  await initRepo();
  await whileReviewing(reviewerAtWork);

  await (runner as Runner).stop();
  runner = undefined;

  expect(comments(1).at(-1)).toContain("daemon stopping");
  const card = core.getCard(1);
  expect(card.attention?.note).toContain("daemon stopping");
  expect(card.attention?.moves).toEqual([]);
  expect(card.activity.filter((e) => e.type === "released")).toHaveLength(1);
  expect(comments(1).some((text) => text.includes("ready for review"))).toBe(false);
});

test("the owner releasing the card mid-review stops the run, and no second run starts", async () => {
  await initRepo();
  await whileReviewing(reviewerAtWork);

  const stopped = untilEvent(commentContaining(1, "run stopped"));
  core.releaseCard(1, { reason: "taking it by hand" }, owner.id);
  await stopped;
  await Bun.sleep(200);

  const card = core.getCard(1);
  expect(card.attention?.note).toContain("run stopped");
  expect(card.attention?.moves).toEqual([]);
  expect(comments(1).some((text) => text.includes("ready for review"))).toBe(false);
  // The card's one release is the owner's, and its one claim is this run's.
  expect(card.activity.filter((e) => e.type === "released")).toHaveLength(1);
  expect(lastRelease(1)).toBe("taking it by hand");
  expect(card.activity.filter((e) => e.type === "claimed")).toHaveLength(1);
});

test("another member claiming the card mid-review ends the run as an abandonment", async () => {
  await initRepo();
  const other = core.ensureMember("crew-1", "agent");
  await whileReviewing(reviewerAtWork);

  const abandoned = untilEvent(commentContaining(1, "run abandoned"));
  core.releaseCard(1, { reason: "taking it by hand" }, owner.id);
  core.claimCard(1, {}, other.id);
  await abandoned;
  await Bun.sleep(200);

  expectAbandoned(1);
  expect(core.getCard(1).claim?.by).toBe(other.id);
  expect(comments(1).some((text) => text.includes("ready for review"))).toBe(false);
});

/**
 * The last clause of criterion 10. The reviewer approved *and* asked the owner something; the
 * question is the card's open request and nothing an ending may replace, so the ending says
 * the artefact landed, offers no move, and releases as blocked.
 */
test("a review run that approves with its own question open comments, offers no move, releases blocked", async () => {
  await initRepo();
  start({
    driver: scripted(implementing(), async function* () {
      agentAsks(1, "is criterion 3 about ordering or about the claim?");
      core.review(1, { verdict: "approved" }, crewMember.id);
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Approved, and asked", "code");

  const card = core.getCard(1);
  expect(comments(1).at(-1)).toBe(`ready for review: ${PR_URL}`);
  expect(card.attention?.note).toBe("is criterion 3 about ordering or about the claim?");
  expect(card.attention?.moves).toEqual([]);
  expect(lastRelease(1)).toBe("blocked");
  expect(card.activity.filter((e) => e.type === "released")).toHaveLength(1);
});

/** Criterion 11. Comments reach the live run, whichever kind of run it is. */
test("a comment the owner posts while a review run is live reaches that run's agent", async () => {
  await initRepo();
  const heard: string[] = [];
  await whileReviewing(async function* (options) {
    yield { type: "text", text: "reading the diff" };
    for await (const message of options.input) {
      heard.push(message);
      if (message.includes("the ordering test")) break;
    }
    core.review(1, { verdict: "approved" }, crewMember.id);
    yield { type: "result", ok: true };
  });

  const done = untilEvent(ended(1));
  core.comment(1, "look at the ordering test too", owner.id);
  await done;

  // The card first, as every run's first user message, then the owner's comment.
  expect(heard[0]).toContain("Card 1: Live review");
  expect(heard).toContain("look at the ordering test too");
  expect(comments(1).at(-1)).toBe(`ready for review: ${PR_URL}`);
});

// --- an ending that cannot say why (criterion 12) ---

/** Waits for a warning naming `fragment`, so a test need not guess how long a failure takes. */
async function untilWarned(fragment: string, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (warnings.some((line) => line.includes(fragment))) return;
    await Bun.sleep(10);
  }
  throw new Error(`no warning naming "${fragment}" within ${timeoutMs} ms`);
}

test("an ending whose comment and request both throw parks the card with the run log", async () => {
  await initRepo();
  // The failure 015 measured: the core refuses the ending's own text, so neither the comment
  // nor the request lands. The parked note is the runner's own, and the core takes it.
  const refuses: Core = {
    ...core,
    comment(id, text, actorId) {
      if (text === "spec ready") throw new Error("comment is down");
      return core.comment(id, text, actorId);
    },
    requestAttention(id, request, actorId) {
      if (request.note === "spec ready") throw new Error("attention is down");
      return core.requestAttention(id, request, actorId);
    },
  };
  start({
    core: refuses,
    driver: fakeDriver(async function* () {
      core.setBody(1, "# 1 — the spec", crewMember.id);
      yield { type: "result", ok: true };
    }),
  });
  const parked = untilEvent((e) => e.cardId === 1 && e.type === "attention_requested");
  core.createCard({ title: "Cannot say why" }, owner.id);
  core.moveCard(1, "spec", owner.id);
  await parked;
  await Bun.sleep(200);

  const card = core.getCard(1);
  const note = card.attention?.note as string;
  expect(note).toMatch(/^run ended and could not record why; see the run log at \S+$/);
  expect(card.attention?.moves).toEqual([]);
  expect(existsSync(note.split("run log at ")[1] as string)).toBe(true);
  // The card waits on the owner rather than going back into the queue: one claim, one run.
  expect(card.activity.filter((e) => e.type === "claimed")).toHaveLength(1);
  expect(comments(1).some((text) => text === "spec ready")).toBe(false);
});

test("an ending that cannot park either releases nothing: the lease lapses instead", async () => {
  await initRepo();
  let at = Date.now();
  const now = (): number => at;
  core.close();
  core = openCore(":memory:", { owner: "simon", now });
  owner = core.listMembers()[0] as Member;
  runnerMember = core.ensureMember("runner", "agent");
  crewMember = core.ensureMember("crew", "agent");
  const refuses: Core = {
    ...core,
    comment(id, text, actorId) {
      if (text === "spec ready") throw new Error("comment is down");
      return core.comment(id, text, actorId);
    },
    requestAttention() {
      throw new Error("attention is down");
    },
  };
  let runs = 0;
  start({
    core: refuses,
    now,
    driver: fakeDriver(async function* () {
      runs += 1;
      core.setBody(1, "# 1 — the spec", crewMember.id);
      yield { type: "result", ok: true };
    }),
  });
  core.createCard({ title: "Cannot park either" }, owner.id);
  core.moveCard(1, "spec", owner.id);
  await untilWarned("not parked");

  // The claim is not released, so nothing is free to claim and no second run starts.
  const held = core.getCard(1);
  expect(held.claim?.by).toBe(runnerMember.id);
  expect(held.attention).toBeNull();
  expect(held.activity.filter((e) => e.type === "claimed")).toHaveLength(1);
  expect(runs).toBe(1);

  // And `run_interrupted` lands when the lease lapses, as 009 intends.
  at += 10 * 60_000;
  core.sweepClaims();
  expect(core.getCard(1).activity.map((e) => e.type)).toContain("run_interrupted");
});

/** Criterion 13. Reviewing specs is out of scope: a Spec run hands the card on as 014 built it. */
test("a Spec run that meets its contract hands the card to the owner with no review run", async () => {
  await initRepo();
  const prompts: string[] = [];
  start({
    driver: fakeDriver(async function* (options) {
      prompts.push(options.systemPrompt);
      core.setBody(1, "# 1 — the spec\n\nGoal: ship it.", crewMember.id);
      yield { type: "result", ok: true };
    }),
  });
  await runCard("Specs are not reviewed", "spec");

  expect(prompts).toEqual([playbooks.spec]);
  expect(comments(1).some((text) => text.startsWith("review round"))).toBe(false);
  expect(verdicts(1)).toEqual([]);
  const card = core.getCard(1);
  expect(comments(1).at(-1)).toBe("spec ready");
  expect(card.attention).toMatchObject({ to: owner.id, note: "spec ready", moves: ["code"] });
  expect(lastRelease(1)).toBe("finished");
});
