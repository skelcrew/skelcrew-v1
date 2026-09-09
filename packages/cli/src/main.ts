#!/usr/bin/env bun
/**
 * The one client. Parse argv, resolve who is speaking and where the daemon is, connect, run
 * one command, print, exit. Nothing is stored client-side. Exit codes: 0 success, 1 the
 * daemon refused or could not be reached, 2 usage.
 */
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import {
  connect,
  dataPaths,
  type HelloParams,
  RpcError,
  resolveDataDir,
  VERSION,
} from "@skelcrew/shared";
import { add } from "./commands/add";
import { archive } from "./commands/archive";
import { attention } from "./commands/attention";
import { body } from "./commands/body";
import { claim } from "./commands/claim";
import { type Args, type Command, UsageError } from "./commands/command";
import { comment } from "./commands/comment";
import { heartbeat } from "./commands/heartbeat";
import { ls } from "./commands/ls";
import { mv } from "./commands/mv";
import { queue } from "./commands/queue";
import { refs } from "./commands/refs";
import { release } from "./commands/release";
import { resolve } from "./commands/resolve";
import { show } from "./commands/show";
import { watch } from "./commands/watch";

const COMMANDS: Record<string, Command> = {
  queue,
  add,
  ls,
  show,
  comment,
  mv,
  body,
  refs,
  archive,
  attention,
  resolve,
  claim,
  heartbeat,
  release,
  watch,
};

const GLOBAL_OPTIONS: ParseArgsOptionsConfig = {
  as: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
};

function usage(name?: string): string {
  const lines =
    name === undefined
      ? Object.values(COMMANDS).map((c) => `  skelcrew ${c.usage}`)
      : [`  skelcrew ${(COMMANDS[name] as Command).usage}`];
  return [
    "usage:",
    ...lines,
    ...(name === undefined ? ["", "  skelcrew with no command is: skelcrew queue"] : []),
    "",
    "options:",
    "  --as <name>   speak as that agent member (or set SKELCREW_AS); default: the owner",
    "  --json        print the daemon's result as JSON",
    "  --version     print the version",
    "  -h, --help    print usage",
  ].join("\n");
}

function fail(message: string, extra?: string): void {
  process.stderr.write(`error: ${message}\n`);
  if (extra !== undefined) process.stderr.write(`${extra}\n`);
}

/** The daemon's message, with its error code so `forbidden` and `not_found` are tellable apart. */
function describe(error: unknown): string {
  if (error instanceof RpcError) return `${error.message} (${error.data.code})`;
  return error instanceof Error ? error.message : String(error);
}

async function main(argv: string[]): Promise<number> {
  // A loose pass finds the command word; the strict pass knows that command's options.
  const loose = parseArgs({
    args: argv,
    options: GLOBAL_OPTIONS,
    strict: false,
    allowPositionals: true,
  });
  if (loose.values.version === true) {
    process.stdout.write(`skelcrew ${VERSION}\n`);
    return 0;
  }
  const word = loose.positionals[0];
  if (word === "help" || (word === undefined && loose.values.help === true)) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  // No command is the home view: what is waiting on the invoking member.
  const name = word ?? "queue";
  const command = COMMANDS[name];
  if (command === undefined) {
    fail(`unknown command "${name}"`, usage());
    return 2;
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: { ...GLOBAL_OPTIONS, ...command.options },
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    fail(describe(error), usage(name));
    return 2;
  }
  if (parsed.values.help === true) {
    process.stdout.write(`${usage(name)}\n`);
    return 0;
  }
  const args: Args = {
    positionals: parsed.positionals.slice(1),
    values: parsed.values as Args["values"],
    stdinIsTerminal: process.stdin.isTTY === true,
  };
  let input: unknown;
  try {
    input = command.parse(args);
  } catch (error) {
    if (error instanceof UsageError) {
      fail(error.message, usage(name));
      return 2;
    }
    fail(describe(error));
    return 1;
  }

  // Identity fails closed: only an absent flag and an unset variable mean the owner. An
  // empty flag is a usage error; an empty variable goes to the daemon, which refuses it.
  const asFlag = parsed.values.as;
  if (asFlag === "") {
    fail("--as needs a member name", usage(name));
    return 2;
  }
  const asName = typeof asFlag === "string" ? asFlag : process.env.SKELCREW_AS;
  const hello: HelloParams =
    asName === undefined ? { kind: "human" } : { kind: "agent", name: asName };
  const dir = resolveDataDir(process.env, process.cwd());
  if (dir === undefined) {
    fail("not inside a git repository, and SKELCREW_DIR is not set");
    return 1;
  }
  const { socketPath } = dataPaths(dir);
  let client: Awaited<ReturnType<typeof connect>>;
  try {
    client = await connect(socketPath, hello);
  } catch (error) {
    if (error instanceof RpcError) fail(describe(error));
    else
      fail(`no daemon is listening on ${socketPath}; run \`bun run daemon\` from the repository`);
    return 1;
  }

  try {
    const outcome = await command.run(
      {
        client,
        socketPath,
        stdin: () => Bun.stdin.text(),
        out: (line) => process.stdout.write(`${line}\n`),
        warn: (line) => process.stderr.write(`${line}\n`),
      },
      input,
    );
    const text = parsed.values.json === true ? JSON.stringify(outcome.result) : outcome.render();
    // Nothing to show (every bulk line failed) leaves stdout empty, not a bare newline.
    if (text.length > 0) process.stdout.write(`${text}\n`);
    return outcome.failed ? 1 : 0;
  } catch (error) {
    if (error instanceof UsageError) {
      fail(error.message, usage(name));
      return 2;
    }
    fail(describe(error));
    return 1;
  } finally {
    await client.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
