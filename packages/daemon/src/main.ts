import { VERSION } from "@skelcrew/shared";
import { openCore } from "./core/core";
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

function shutdown(): void {
  clearInterval(sweeper);
  server.stop();
  core.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
