/**
 * `skelcrew` on the agent's `PATH`: a script under `<data dir>/bin/` that runs this
 * daemon's own CLI with this daemon's own runtime (`process.execPath`, so a daemon started
 * by launchd with a minimal `PATH` still works — there may be no `bun` to find). The agent
 * reaches skelcrew through the same CLI a human uses, and needs no flags: `SKELCREW_AS` and
 * `SKELCREW_DIR` in its environment say who it speaks as and which daemon it reaches.
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

/** Writes the shim — rewritten only when its content would differ — and returns its path. */
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
 * The environment a spawned agent gets, and nothing else: the shim's directory first on
 * `PATH` so `skelcrew` is this daemon's CLI, `HOME` so the owner's own harness login is the
 * one that answers, and the two variables that say who the agent speaks as and which
 * daemon it reaches. The daemon's own environment is not passed on — skelcrew holds no
 * credentials, and what it does hold is none of the agent's business.
 */
export function agentEnvironment(
  base: Record<string, string | undefined>,
  dataDir: string,
): Record<string, string> {
  const dir = shimDir(dataDir);
  const path = base.PATH;
  const env: Record<string, string> = {
    PATH: path === undefined || path === "" ? dir : `${dir}${delimiter}${path}`,
  };
  if (base.HOME !== undefined) env.HOME = base.HOME;
  env.SKELCREW_AS = "runner";
  env.SKELCREW_DIR = dataDir;
  return env;
}
