/**
 * `skelcrew` on the agent's `PATH`: a script under `<data dir>/bin/` that runs this
 * daemon's own CLI with the daemon's own `bun` (`process.execPath`, so a daemon started by
 * launchd with a minimal `PATH` still works), so a playbook can say `skelcrew …` in any
 * target repository.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The CLI's entry point in this checkout. */
export const CLI_MAIN = fileURLToPath(new URL("../../../cli/src/main.ts", import.meta.url));

export function shimDir(dataDir: string): string {
  return join(dataDir, "bin");
}

function quoted(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

/** Writes the shim once — rewritten only when its content would differ — and returns its path. */
export function writeShim(dataDir: string, cliMain: string = CLI_MAIN): string {
  const dir = shimDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "skelcrew");
  const script = `#!/bin/sh\nexec ${quoted(process.execPath)} ${quoted(cliMain)} "$@"\n`;
  if (!existsSync(path) || readFileSync(path, "utf8") !== script) writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

/**
 * The environment a spawned agent gets: the daemon's, with the shim first on `PATH`,
 * speaking as `runner`, and pointed at this daemon's data directory so its CLI calls
 * cannot reach another one.
 */
export function agentEnvironment(
  base: Record<string, string | undefined>,
  dataDir: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  const path = base.PATH;
  env.PATH =
    path === undefined || path === "" ? shimDir(dataDir) : `${shimDir(dataDir)}${delimiter}${path}`;
  env.SKELCREW_AS = "runner";
  env.SKELCREW_DIR = dataDir;
  return env;
}
