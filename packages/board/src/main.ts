import * as core from "./core.js";
import { createApp } from "./server.js";
import { DB_PATH } from "./db.js";

const port = Number(process.env.PORT ?? 4777);

core.startSweeper(5000);

const app = createApp();
const server = app.listen(port, () => {
  const owner = core.getOwner();
  console.log(`kanbot board  http://localhost:${port}`);
  console.log(`  owner:  ${owner.name} (${owner.id})`);
  console.log(`  db:     ${DB_PATH}`);
  console.log(`  mcp:    http://localhost:${port}/mcp`);
});

function shutdown(signal: string): void {
  console.log(`\n${signal} — closing board`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
