/**
 * The daemon's startup: where the settings are read and where the two halves are joined.
 *
 * **A setting that crosses this file into a part is observed by a test that starts the daemon**
 * — `server/process.test.ts`, which spawns this file as a process — **or the comment beside its
 * handoff says why it cannot be.** Every part here is tested on its own with fakes, so a
 * handoff nobody observes through the real daemon can be deleted with `bun run check` still
 * green: 024 found that for the sweep's runner id and 025 for the count of runs, in this same
 * file. Each handoff below names the test that observes it; a new setting brings its own.
 */
import { findRepoRoot, VERSION } from "@skelcrew/shared";
import { startAnnouncing } from "./announce";
import { openCore } from "./core/core";
import { mergePoll, mergePollIntervalFromEnv } from "./merges";
import type { AgentDriver } from "./runner/agent";
import { createForge } from "./runner/forge";
import { createGit } from "./runner/git";
import { selectAgent } from "./runner/none";
import { loadPlaybooks, type Playbooks } from "./runner/playbooks";
import { runLimitFromEnv } from "./runner/run";
import {
  CREW_MEMBER_NAME,
  RUNNER_MEMBER_NAME,
  type Runner,
  runsFromEnv,
  startRunner,
} from "./runner/runner";
import { daemonAnswers, dataPaths, prepareDataDir, resolveDataDir } from "./server/paths";
import { startServer } from "./server/server";
import { sweepTick } from "./sweep";

/** How often lapsed claims are expired into `run_interrupted` events while the daemon runs. */
const CLAIM_SWEEP_INTERVAL_MS = 5000;

function stop(error: unknown): never {
  console.error(`skelcrew daemon: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const dir = resolveDataDir(process.env, process.cwd());
if (dir === undefined) {
  console.error("skelcrew daemon: not inside a git repository, and SKELCREW_DIR is not set");
  process.exit(1);
}

// A typo in the agent selection, the run limit, how many run at once, or the poll interval
// stops the daemon; it does not pick a default.
let agentKind: ReturnType<typeof selectAgent>;
let runLimitMs: number;
let runs: number;
let mergePollMs: number;
try {
  agentKind = selectAgent(process.env);
  runLimitMs = runLimitFromEnv(process.env);
  runs = runsFromEnv(process.env);
  mergePollMs = mergePollIntervalFromEnv(process.env);
} catch (error) {
  stop(error);
}
// The SDK and the playbooks are loaded only when they will be used — with `none` the daemon
// never touches them — and before the socket opens, so "listening" means the runner is ready
// too; a missing or empty playbook stops the daemon the way a bad variable does.
//
// Observed by "with SKELCREW_AGENT=claude the daemon loads the driver and its playbooks and
// serves" and "an unknown SKELCREW_AGENT stops the daemon before it creates anything".
let agent: { driver: AgentDriver; playbooks: Playbooks } | undefined;
if (agentKind === "claude" && process.env.SKELCREW_RUNNER !== "0") {
  try {
    agent = {
      driver: (await import("./runner/claude")).claudeDriver,
      playbooks: loadPlaybooks(),
    };
  } catch (error) {
    stop(error);
  }
}

const { dbPath, socketPath } = dataPaths(dir);
if (await daemonAnswers(socketPath)) {
  console.error(`skelcrew daemon: a daemon is already running on ${socketPath}`);
  process.exit(1);
}

prepareDataDir(dir);
const core = openCore(dbPath);
const server = startServer({ core, socketPath });
// The member whose claims are runs, once the execution half below has joined as it. The sweep
// takes a lapsed run's own question with it and needs to know which claims are runs; a claim
// made by hand is not one, whoever made it. Assigned below, before the first tick five seconds
// from now, and left unset when the runner is off — then no request is ever withdrawn.
//
// Observed by "the daemon's sweep takes an interrupted run's own question with it, and the
// runner takes the card again", and unset by "with SKELCREW_RUNNER=0 a lapse withdraws
// nothing: there are no runs to withdraw".
let runnerId: number | undefined;
// Not a member action: the sweep only makes a lapse that already happened visible.
const sweeper = setInterval(
  () => sweepTick(core, (line) => console.error(line), runnerId),
  CLAIM_SWEEP_INTERVAL_MS,
);
// A question the owner never hears about is a run lost to a sleeping laptop, so a daemon the
// owner started in a terminal rings that terminal and sends one notification per request
// raised to a human. Only in a terminal: a daemon under launchd, or with its output
// redirected, has nobody beside it, and `watch` is the ping for that owner — it notifies
// wherever it is run, which is where the owner actually is. An owner running both hears twice;
// 023 took that over a handshake between client and daemon.
const stopAnnouncing = startAnnouncing({
  core,
  env: process.env,
  platform: process.platform,
  isTerminal: process.stdout.isTTY === true,
  out: (text) => process.stdout.write(text),
  warn: (line) => console.error(line),
});
console.log(`skelcrew daemon ${VERSION} listening on ${socketPath}`);

// The execution half: off with SKELCREW_RUNNER=0, and off when there is no repository to
// add worktrees to (a data directory given by SKELCREW_DIR outside any checkout). Off is
// observed by "with SKELCREW_RUNNER=0 nothing happens to a card moved into spec", and no
// repository by "with SKELCREW_DIR set but no repository around the cwd, the daemon serves
// without a runner and says so".
let runner: Runner | undefined;
// The merge poll sits here rather than beside the sweep because it spawns `gh` against the
// repository: it belongs to the half that runs subprocesses, and a state-only daemon spawns
// nothing. It ticks only while a card is in PR with a pull request on it — no such card, no
// `gh` call — so the timer costs a database read a minute and nothing else.
//
// The interval is observed by "the poll asks gh on its interval, and asks nothing while no card
// in PR carries a pull request", which starts the daemon with SKELCREW_MERGE_POLL_SECONDS=1.
let merges: ReturnType<typeof setInterval> | undefined;
if (process.env.SKELCREW_RUNNER !== "0") {
  const repoRoot = findRepoRoot(process.cwd());
  if (repoRoot === undefined) {
    console.error("skelcrew daemon: runner disabled: not inside a git repository");
  } else {
    // Two members, because the mechanism is that the claim's holder and the agent's identity
    // differ: the runner claims as itself and the agent it spawns speaks as the crew.
    const member = core.ensureMember(RUNNER_MEMBER_NAME, "agent");
    runnerId = member.id;
    runner = startRunner({
      core,
      dataDir: dir,
      repoRoot,
      git: createGit(),
      member,
      crew: core.ensureMember(CREW_MEMBER_NAME, "agent"),
      warn: (line) => console.error(line),
      // Observed by "with SKELCREW_RUNS=1 the daemon claims the second card only after it has
      // released the first", against its control "with SKELCREW_RUNS unset the daemon claims
      // both cards before either is released".
      slots: runs,
      // No test here observes this one: under SKELCREW_AGENT=none a run has no agent session,
      // so the limit can never fire, and a driver that exists only to be timed out would be a
      // switch in production code for a test's sake. It is observed against the run instead,
      // in runner/run.test.ts — "SKELCREW_RUN_MINUTES sets the limit; unset is an hour;
      // anything else is refused" for the parsing, and "a run over its time limit is aborted:
      // the agent's signal fires and the card waits on the owner" for what the limit does.
      runLimitMs,
      ...(agent === undefined ? {} : { agent }),
    });
    const poll = mergePoll({
      core,
      forge: createForge(),
      repoRoot,
      runnerId: member.id,
      warn: (line) => console.error(line),
    });
    merges = setInterval(() => void poll.tick(), mergePollMs);
  }
}

async function shutdown(): Promise<void> {
  clearInterval(sweeper);
  stopAnnouncing();
  if (merges !== undefined) clearInterval(merges);
  await runner?.stop();
  server.stop();
  core.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
