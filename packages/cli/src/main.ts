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
  escapeControlCharacters,
  findControlCharacter,
  type HelloParams,
  RpcError,
  resolveDataDir,
  VERSION,
} from "@skelcrew/shared";
import { board } from "./board/board";
import { add } from "./commands/add";
import { archive } from "./commands/archive";
import { attention } from "./commands/attention";
import { body } from "./commands/body";
import { claim } from "./commands/claim";
import { type Args, type Command, UsageError, withLfLineEndings } from "./commands/command";
import { comment } from "./commands/comment";
import { heartbeat } from "./commands/heartbeat";
import { ls } from "./commands/ls";
import { mv } from "./commands/mv";
import { queue } from "./commands/queue";
import { refs } from "./commands/refs";
import { release } from "./commands/release";
import { resolve } from "./commands/resolve";
import { review } from "./commands/review";
import { show } from "./commands/show";
import { watch } from "./commands/watch";

const COMMANDS: Record<string, Command> = {
  queue,
  add,
  ls,
  show,
  comment,
  review,
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
    ...(name === undefined
      ? ["", "  skelcrew with no command is the board in a terminal, and the queue otherwise"]
      : []),
    "",
    "options:",
    "  --as <name>   speak as that agent member (or set SKELCREW_AS); default: the owner",
    "  --json        print the daemon's result as JSON",
    "  --version     print the version",
    "  -h, --help    print usage",
  ].join("\n");
}

/**
 * Nothing the CLI writes can act on the terminal: every control character is rendered as a
 * visible escape on the way out. Here rather than only in `render.ts`, because this is the one
 * place output cannot skip — a renderer added later, and an error message echoing what the
 * caller typed, both go through it. The kind is multi-line, so the line breaks a renderer laid
 * out survive; `render.ts` escapes single-line fields itself, before they reach a line, and
 * marks every line of a multi-line one, so a stored newline can neither be acted on nor pass
 * for a line the CLI composed.
 */
function safe(text: string): string {
  return escapeControlCharacters(text, "multi-line");
}

/**
 * A message the CLI writes about something rather than a field it laid out: an error, a
 * warning. It is one line by nature and is escaped as one, so a newline in a daemon message
 * that echoes stored text cannot put a second line on the terminal that reads as a record.
 */
function safeLine(text: string): string {
  return escapeControlCharacters(text, "single-line");
}

/**
 * The result as JSON, for a machine. `JSON.stringify` already writes every C0 control, `"` and
 * `\` as escapes, so the only characters of the shared set that survive it are DEL and C1:
 * those are rewritten as `\uNNNN` — the code point the shared predicate names, in JSON's own
 * notation — which a parser reads back as the same character. Lossless, and no second list.
 */
function safeJson(result: unknown): string {
  let rest = JSON.stringify(result);
  let out = "";
  for (
    let found = findControlCharacter(rest, "single-line");
    found !== undefined;
    found = findControlCharacter(rest, "single-line")
  ) {
    out += `${rest.slice(0, found.index)}\\u${found.codePoint.slice(2)}`;
    rest = rest.slice(found.index + 1);
  }
  return out + rest;
}

function fail(message: string, extra?: string): void {
  process.stderr.write(`error: ${safeLine(message)}\n`);
  // `extra` is the CLI's own usage block, laid out over lines it wrote itself.
  if (extra !== undefined) process.stderr.write(`${safe(extra)}\n`);
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
  // No command is the home view: the screen when stdout is a terminal, and what is waiting on
  // the invoking member otherwise, so a script or an agent that runs it bare gets the answer it
  // always got. `--json` is that answer too: a screen has no JSON.
  const screen = word === undefined && process.stdout.isTTY === true && loose.values.json !== true;
  const name = word ?? "queue";
  const command = screen ? board : COMMANDS[name];
  if (command === undefined) {
    fail(`unknown command "${name}"`, usage());
    return 2;
  }
  // The screen has no verb of its own, so a usage error under it prints the whole usage.
  const named = screen ? undefined : name;

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: { ...GLOBAL_OPTIONS, ...command.options },
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    fail(describe(error), usage(named));
    return 2;
  }
  if (parsed.values.help === true) {
    process.stdout.write(`${usage(named)}\n`);
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
      fail(error.message, usage(named));
      return 2;
    }
    fail(describe(error));
    return 1;
  }

  // Identity fails closed: only an absent flag and an unset variable mean the owner. An
  // empty flag is a usage error; an empty variable goes to the daemon, which refuses it.
  const asFlag = parsed.values.as;
  if (asFlag === "") {
    fail("--as needs a member name", usage(named));
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
        dataDir: dir,
        stdin: async () => withLfLineEndings(await Bun.stdin.text()),
        out: (line) => process.stdout.write(`${safe(line)}\n`),
        warn: (line) => process.stderr.write(`${safeLine(line)}\n`),
      },
      input,
    );
    const text = parsed.values.json === true ? safeJson(outcome.result) : safe(outcome.render());
    // Nothing to show (every bulk line failed) leaves stdout empty, not a bare newline.
    if (text.length > 0) process.stdout.write(`${text}\n`);
    return outcome.failed ? 1 : 0;
  } catch (error) {
    if (error instanceof UsageError) {
      fail(error.message, usage(named));
      return 2;
    }
    fail(describe(error));
    return 1;
  } finally {
    await client.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
