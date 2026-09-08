import { VERSION } from "@skelcrew/shared";
import { openCore } from "./core/core";
import { daemonAnswers, dataPaths, prepareDataDir, resolveDataDir } from "./server/paths";
import { startServer } from "./server/server";

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
console.log(`skelcrew daemon ${VERSION} listening on ${socketPath}`);

function shutdown(): void {
  server.stop();
  core.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
