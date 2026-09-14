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
 * What the agent inherits from the daemon's environment, verbatim and only when the daemon has
 * it, so that the owner's own harness login is one the spawned agent can use:
 *
 * - `USER` and `LOGNAME` — the names a macOS Keychain lookup reads a stored `claude login`
 *   under. `HOME` alone is not enough: a run given only `PATH` and `HOME` ends at
 *   `Not logged in · Please run /login`, which is how the first real card through a real daemon
 *   failed (021).
 * - `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` — the three
 *   variables the harness reads a login from, for an owner who authenticates in their shell
 *   rather than with a stored login.
 * - `ANTHROPIC_BASE_URL` — the endpoint the harness talks to, so an owner routing through a
 *   proxy has the agent route the same way.
 * - `CLAUDE_CONFIG_DIR` — where the harness keeps its configuration, for an owner who moved it
 *   off `~/.claude` and keeps their login there.
 *
 * **Skelcrew stores none of them.** Each is read from the process the owner started and written
 * into the process the owner's harness runs, and nowhere else; no credential is held, logged or
 * persisted. This list is deliberately enumerated rather than a blanket passthrough, which would
 * hand the agent whatever the owner's shell happened to hold.
 *
 * It is written against the pinned harness — `claude` 2.1.266, SDK 0.3.266 — and its documented
 * login and endpoint inputs, plus the two the Keychain needs. When the pin moves and a login
 * stops working, this list is the place to look; `claude.test.ts`'s version pin is what says the
 * pin moved. A Bedrock or Vertex login needs variables that are not here.
 */
export const INHERITED_VARIABLES = [
  "USER",
  "LOGNAME",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR",
] as const;

/**
 * The environment a spawned agent gets, and nothing else: the shim's directory first on
 * `PATH` so `skelcrew` is this daemon's CLI, `HOME` so the owner's own harness login is the
 * one that answers, `INHERITED_VARIABLES` where the daemon has them so that login can actually
 * be read, and the two variables that say who the agent speaks as and which daemon it reaches.
 * Nothing else from the daemon's own environment is passed on — a `SECRET`, an `AWS_PROFILE`,
 * an exported `SKELCREW_AS` — and a listed variable the daemon lacks, or exported empty, is
 * absent here rather than passed on as an empty string: an `ANTHROPIC_API_KEY=` left in a shell
 * profile is not a login, and `PATH` has always read `""` the same way.
 *
 * This supersedes criterion 13 of 012, which asked for exactly `PATH`, `HOME`, `SKELCREW_AS` and
 * `SKELCREW_DIR`: that environment cannot log in. It is still a gate rather than a boundary. For
 * a login the harness has **stored**, it hides nothing the agent could not already reach — with
 * `HOME` it can read `~/.claude` from a check command, which 016 records. For a credential that
 * lives only in the owner's shell it is new reach: before 021 the run could not see it, and now
 * `echo $ANTHROPIC_API_KEY` from any pre-allowed check command prints it. The playbooks' rule
 * against writing a credential into the repository, the card or a pull request is the only
 * mitigation, and it is a rule rather than a gate.
 *
 * `memberName` is who the agent is, and it is not the member holding the card's claim: the
 * runner claims as itself and spawns the agent as `crew`, so every gate the core keeps —
 * moving, releasing, claiming, resolving — is a refusal on the daemon's own facts rather than
 * a verb left off a list.
 */
export function agentEnvironment(
  base: Record<string, string | undefined>,
  dataDir: string,
  memberName: string,
): Record<string, string> {
  const dir = shimDir(dataDir);
  const path = base.PATH;
  const env: Record<string, string> = {
    PATH: path === undefined || path === "" ? dir : `${dir}${delimiter}${path}`,
  };
  if (base.HOME !== undefined) env.HOME = base.HOME;
  for (const name of INHERITED_VARIABLES) {
    const value = base[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  // What keeps an exported `SKELCREW_AS` out of the run is that it is not in
  // `INHERITED_VARIABLES`, so the copy above never writes it; these two lines are the runner's
  // own, and sit after the copy as belt-and-braces rather than as the thing that prevents it.
  env.SKELCREW_AS = memberName;
  env.SKELCREW_DIR = dataDir;
  return env;
}
