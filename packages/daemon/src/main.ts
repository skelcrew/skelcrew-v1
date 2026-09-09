import { findRepoRoot, VERSION } from "@skelcrew/shared";
import { openCore } from "./core/core";
import type { AgentDriver } from "./runner/agent";
import { createGit } from "./runner/git";
import { selectAgent } from "./runner/none";
import { loadPlaybooks, type Playbooks } from "./runner/playbooks";
import { runLimitFromEnv } from "./runner/run";
import { RUNNER_MEMBER_NAME, type Runner, startRunner } from "./runner/runner";
import { daemonAnswers, dataPaths, prepareDataDir, resolveDataDir } from "./server/paths";
import { startServer } from "./server/server";
import { sweepTick } from "./sweep";

/** How often lapsed claims are expired into `run_interrupted` events while the daemon runs. */
const CLAIM_SWEEP_INTERVAL_MS = 5000;

const dir = resolveDataDir(process.env, process.cwd());
if (dir === undefined) {
  console.error("skelcrew daemon: not inside a git repository, and SKELCREW_DIR is not set");
  process.exit(1);
}

// A typo in the agent selection or the run limit must stop the daemon, not pick a default.
let agent: ReturnType<typeof selectAgent>;
let runLimitMs: number;
try {
  agent = selectAgent(process.env);
  runLimitMs = runLimitFromEnv(process.env);
} catch (error) {
  console.error(`skelcrew daemon: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
// The SDK and the playbooks are loaded only when they will be used — with `none` the daemon
// never touches them — and before the socket opens, so "listening" still means the runner
// is ready too; a missing or empty playbook stops the daemon like a bad variable does.
let driver: AgentDriver | undefined;
let playbooks: Playbooks | undefined;
if (agent === "claude" && process.env.SKELCREW_RUNNER !== "0") {
  try {
    driver = (await import("./runner/claude")).claudeDriver;
    playbooks = loadPlaybooks();
  } catch (error) {
    console.error(`skelcrew daemon: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
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
// Not a member action: the sweep only makes a lapse that already happened visible.
const sweeper = setInterval(
  () => sweepTick(core, (line) => console.error(line)),
  CLAIM_SWEEP_INTERVAL_MS,
);
console.log(`skelcrew daemon ${VERSION} listening on ${socketPath}`);

// The execution half: off with SKELCREW_RUNNER=0, and off when there is no repository to
// add worktrees to (a data directory given by SKELCREW_DIR outside any checkout).
let runner: Runner | undefined;
if (process.env.SKELCREW_RUNNER !== "0") {
  const repoRoot = findRepoRoot(process.cwd());
  if (repoRoot === undefined) {
    console.error("skelcrew daemon: runner disabled: not inside a git repository");
  } else {
    runner = startRunner({
      core,
      dataDir: dir,
      repoRoot,
      git: createGit(),
      member: core.ensureMember(RUNNER_MEMBER_NAME, "agent"),
      warn: (line) => console.error(line),
      driver,
      playbooks,
      runLimitMs,
    });
  }
}

async function shutdown(): Promise<void> {
  clearInterval(sweeper);
  await runner?.stop();
  server.stop();
  core.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
