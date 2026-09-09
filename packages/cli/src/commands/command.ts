/**
 * What every command is: a usage line, its own `parseArgs` options, a `parse` that turns
 * the parsed argv into its input (throwing `UsageError` before anything connects), and a
 * `run` that talks to the daemon and hands back the result with a renderer for it.
 * `--json` prints the result as it came and never calls the renderer.
 */
import { readFileSync } from "node:fs";
import type { ParseArgsOptionsConfig } from "node:util";
import { type Client, PHASES, type Phase } from "@skelcrew/shared";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface Args {
  /** Positionals after the command word. */
  positionals: string[];
  values: Record<string, string | boolean | string[] | undefined>;
  stdinIsTerminal: boolean;
}

export interface Context {
  client: Client;
  /** Where the daemon was reached, for messages about losing it. */
  socketPath: string;
  /** All of stdin, read once. */
  stdin(): Promise<string>;
  /** One line to stdout, as it happens; for a command that streams rather than returns. */
  out(line: string): void;
  /** One line to stderr, as it happens. */
  warn(line: string): void;
}

export interface Outcome<R> {
  /** Exactly what the daemon returned; `--json` prints this. */
  result: R;
  render(): string;
  /** Something was skipped: the output stands, but the exit code is 1. */
  failed?: boolean;
}

export interface Command<P = unknown, R = unknown> {
  usage: string;
  options: ParseArgsOptionsConfig;
  parse(args: Args): P;
  run(ctx: Context, input: P): Promise<Outcome<R>>;
}

/** A card id as typed: `12` or `#12`. */
export function parseId(raw: string | undefined): number {
  if (raw === undefined) throw new UsageError("missing <id>");
  const digits = raw.startsWith("#") ? raw.slice(1) : raw;
  if (!/^\d+$/.test(digits)) throw new UsageError(`"${raw}" is not a card id`);
  return Number(digits);
}

/** A phase id as typed, case-insensitively. Anything else is a usage error listing the ids. */
export function parsePhase(raw: string | undefined): Phase {
  if (raw === undefined) throw new UsageError("missing <phase>");
  const phase = PHASES.find((p) => p.id === raw.toLowerCase());
  if (!phase) {
    const ids = PHASES.map((p) => p.id).join(", ");
    throw new UsageError(`unknown phase "${raw}"; expected one of ${ids}`);
  }
  return phase.id;
}

/** A file named by a flag. An unreadable one is a usage error naming the path and the reason. */
export function readFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    // Node's message ends in `, open '<path>'`; the path is already named once.
    const reason = (error instanceof Error ? error.message : String(error)).replace(
      /, open '.*'$/,
      "",
    );
    throw new UsageError(`cannot read ${path}: ${reason}`);
  }
}

export function noExtraPositionals(args: Args, expected: number): void {
  const extra = args.positionals[expected];
  if (extra !== undefined) throw new UsageError(`unexpected argument "${extra}"`);
}

export function string(args: Args, name: string): string | undefined {
  const value = args.values[name];
  return typeof value === "string" ? value : undefined;
}

export function strings(args: Args, name: string): string[] {
  const value = args.values[name];
  return Array.isArray(value) ? value : [];
}

export function flag(args: Args, name: string): boolean {
  return args.values[name] === true;
}
