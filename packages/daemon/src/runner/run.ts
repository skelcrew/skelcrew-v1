/**
 * One run: a coding agent in the card's worktree with the phase's playbook and the card,
 * streamed back to the card as excerpts — every assistant turn a comment, tool calls
 * batched, the full stream in a log under the data directory — and answered from the card:
 * comments by other members reach the agent as user messages, and a tool outside the fixed
 * allowlist is denied with a reason the card also shows. The run ends when the session ends,
 * when the time limit fires, when the daemon stops, or when the claim is lost; in every case
 * the card is left in a state a member can act on, with the reason on it, and never with a
 * question the agent raised replaced by it. Nothing is posted after an await without the
 * claim still being this run's.
 *
 * A session that ended on its own is not by itself a finish: the phase's artefact contract
 * (`contracts.ts`) decides, and only a met contract carries the move into the next phase.
 * What kind of ending this is at all is derived from the card in `ending.ts`, never from
 * flags kept while the run was live.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Activity,
  type Card,
  COMMENT_MAX_BYTES,
  type Member,
  type Phase,
} from "@skelcrew/shared";
import type { AgentDriver, AgentEvent, ToolDecision } from "./agent";
import { checkContract } from "./contracts";
import { classifyEnding, endRun, type RunAttention, type RunCore } from "./ending";
import type { Git } from "./git";
import type { PlaybookPhase } from "./playbooks";

/** The default time limit; `SKELCREW_RUN_MINUTES` overrides it. */
export const RUN_LIMIT_MINUTES_DEFAULT = 60;
/** After the run tells the agent to stop, how long it waits before going on without it. */
export const ABORT_GRACE_MS_DEFAULT = 5000;
/** A text turn longer than this is posted cut, with a marker. */
export const TEXT_EXCERPT_BYTES = 2 * 1024;
/** Tool calls are posted as one summary per window. */
export const TOOL_SUMMARY_MS = 30_000;
/** One-line renderings of a tool's input are cut here. */
const INPUT_LINE_MAX = 200;
const COMMAND_IN_SUMMARY_MAX = 60;
/** A batch's summary is one comment, so it is cut like every other write to a card. */
const SUMMARY_MAX_BYTES = COMMENT_MAX_BYTES / 4;
const ELLIPSIS = "…";
const RUNS_DIR_NAME = "runs";

/** The run's claim went away: the card is someone else's now, and nothing more is posted. */
export class RunAbandoned extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RunAbandoned";
  }
}

export interface RunInput {
  /** No `requestAttention`: every raise a run makes goes through `attention`, by construction. */
  core: RunCore;
  member: Member;
  /** The one helper this run raises attention through. */
  attention: RunAttention;
  /** Who an ending hands the card to; resolved by `ending.ts`, inside its own guard. */
  ownerId(): number;
  warn: (line: string) => void;
  card: Card;
  /** The phase claimed, narrowed to the phases a playbook and a contract exist for. */
  phase: PlaybookPhase;
  /** The last sequence number before the run began: what "during this run" means. */
  sinceSeq: number;
  /** The clock the card's claim is read against; the runner's, so the two agree. */
  now(): number;
  /** The target repository and its git, for the phase's artefact contract. */
  git: Git;
  repoRoot: string;
  /** The card's worktree, the branch it is on, and the base branch that forked from. */
  path: string;
  branch: string;
  base: string;
  driver: AgentDriver;
  playbook: string;
  env: Record<string, string>;
  allowedTools: string[];
  /** This run's log, already created by `createRunLog`; appended to, never truncated. */
  logPath: string;
  limitMs: number;
  /** How long the agent gets to end after being told to, before the run goes on without it. */
  graceMs: number;
  /** The window tool calls are batched into one comment over. */
  summaryMs: number;
  /** Fires when the daemon is stopping: the run is told to stop and ends as such. */
  stop: AbortSignal;
  /** Throws `RunAbandoned` when the claim is no longer this run's, live. */
  stillHeld(): void;
  /** Why the claim is no longer this run's, or undefined while it is. */
  lost(): string | undefined;
}

function runsDir(dataDir: string): string {
  return join(dataDir, RUNS_DIR_NAME);
}

/** `SKELCREW_RUN_MINUTES`, or the default; anything not a positive number is an error. */
export function runLimitFromEnv(env: Record<string, string | undefined>): number {
  const value = env.SKELCREW_RUN_MINUTES;
  if (value === undefined || value === "") return RUN_LIMIT_MINUTES_DEFAULT * 60_000;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`SKELCREW_RUN_MINUTES must be a positive number of minutes, not "${value}"`);
  }
  return minutes * 60_000;
}

/**
 * `<data dir>/runs/<id>-<started>.jsonl`, the timestamp compact UTC so the name is a path
 * anywhere. The stamp is second-resolution, so two runs of one card can want the same name;
 * `nth` above 1 is the `-<nth>` that tells them apart, and `createRunLog` picks it.
 */
function runLogPath(dataDir: string, cardId: number, startedAt: number, nth = 1): string {
  const stamp = new Date(startedAt)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const suffix = nth > 1 ? `-${nth}` : "";
  return join(runsDir(dataDir), `${cardId}-${stamp}${suffix}.jsonl`);
}

/**
 * Creates this run's log and returns the path, which is then this run's alone: the file is
 * opened exclusively, so an existing log — an earlier run of the same card, started in the
 * same second, whose path is on that card — is never truncated; the next free `-<nth>` is
 * taken instead. Resolution would only narrow the window; exclusivity closes it.
 */
export function createRunLog(dataDir: string, cardId: number, startedAt: number): string {
  mkdirSync(runsDir(dataDir), { recursive: true });
  for (let nth = 1; ; nth += 1) {
    const path = runLogPath(dataDir, cardId, startedAt, nth);
    try {
      writeFileSync(path, "", { flag: "wx" });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/** The first user message: the card, and where its work goes. */
function cardPrompt(
  card: Pick<Card, "id" | "title" | "body">,
  branch: string,
  base: string,
): string {
  return `Card ${card.id}: ${card.title}\nBranch: ${branch} (from ${base})\n\n${card.body}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The longest prefix of `text` within `budget` bytes, cut on a character boundary. */
function cutBytes(text: string, budget: number): string {
  let bytes = 0;
  let cut = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > budget) break;
    bytes += size;
    cut += char.length;
  }
  return text.slice(0, cut);
}

/** `text` within `budget` bytes, marked when there was more of it. */
function cutMarked(text: string, budget: number): string {
  if (Buffer.byteLength(text, "utf8") <= budget) return text;
  return `${cutBytes(text, budget - Buffer.byteLength(ELLIPSIS, "utf8"))}${ELLIPSIS}`;
}

/** A text turn as the card shows it: whole under the limit, else cut with a marker. */
function excerpt(text: string, logPath: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= TEXT_EXCERPT_BYTES) return text;
  return `${cutBytes(text, TEXT_EXCERPT_BYTES)}\n… [truncated: ${bytes} bytes; the full turn is in the run log at ${logPath}]`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s*\n\s*/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** What a tool call is called on the card: the command for Bash, the path for file tools. */
function describeInput(tool: string, input: Record<string, unknown>): string {
  const command = input.command;
  if (tool === "Bash" && typeof command === "string") return oneLine(command, INPUT_LINE_MAX);
  const path = input.file_path ?? input.path;
  if (typeof path === "string") return oneLine(path, INPUT_LINE_MAX);
  return oneLine(JSON.stringify(input) ?? "", INPUT_LINE_MAX);
}

/**
 * "ran 4 tools: Read ×2, Bash `bun test`, Edit": Bash calls named, the rest counted. A
 * window can hold more distinct commands than a comment does, and a summary over the cap is
 * rejected by the core — so it is cut and marked here rather than dropped from the card.
 */
function summarizeTools(calls: Array<{ name: string; input: Record<string, unknown> }>): string {
  const parts = new Map<string, { label: string; count: number }>();
  calls.forEach((call, i) => {
    if (call.name === "Bash" && typeof call.input.command === "string") {
      const command = oneLine(call.input.command, COMMAND_IN_SUMMARY_MAX).replaceAll("`", "'");
      parts.set(`Bash:${i}`, { label: `Bash \`${command}\``, count: 1 });
      return;
    }
    const part = parts.get(call.name);
    if (part === undefined) parts.set(call.name, { label: call.name, count: 1 });
    else part.count += 1;
  });
  const listed = [...parts.values()].map((p) => (p.count > 1 ? `${p.label} ×${p.count}` : p.label));
  const summary = `ran ${calls.length} tool${calls.length === 1 ? "" : "s"}: ${listed.join(", ")}`;
  return cutMarked(summary, SUMMARY_MAX_BYTES);
}

/** The user messages the driver reads: pushed as comments arrive, closed when the run ends. */
function inbox(): AsyncIterable<string> & { push(text: string): void; close(): void } {
  const items: string[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  return {
    push(text) {
      if (closed) return;
      items.push(text);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = items.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
  };
}

function appendLog(path: string, entry: unknown): void {
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

function describeLimit(ms: number): string {
  const minutes = ms / 60_000;
  if (Number.isInteger(minutes)) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const seconds = ms / 1000;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

type Comment = Activity & { type: "comment" };

export async function runPlaybook(input: RunInput): Promise<void> {
  const { core, member, ownerId, warn, card, path, logPath } = input;
  const id = card.id;

  const abort = new AbortController();
  let timedOut = false;
  let stopping = false;
  const messages = inbox();
  messages.push(cardPrompt(card, input.branch, input.base));

  /** The claim, re-checked on every event that could have taken it: lost means stop. */
  const check = (): void => {
    if (!abort.signal.aborted && input.lost() !== undefined) abort.abort();
  };

  /** A comment on the card, only while the claim is still this run's; otherwise dropped. */
  const post = (text: string): void => {
    if (input.lost() !== undefined) return;
    try {
      core.comment(id, text, member.id);
    } catch (error) {
      warn(`skelcrew runner: card ${id}: could not comment: ${message(error)}`);
    }
  };

  // --- tool calls, batched ---
  const pendingTools: Array<{ name: string; input: Record<string, unknown> }> = [];
  let summaryTimer: ReturnType<typeof setTimeout> | undefined;
  const flushTools = (): void => {
    if (summaryTimer !== undefined) clearTimeout(summaryTimer);
    summaryTimer = undefined;
    if (pendingTools.length === 0) return;
    post(summarizeTools(pendingTools.splice(0)));
  };
  const noteTool = (call: { name: string; input: Record<string, unknown> }): void => {
    pendingTools.push(call);
    summaryTimer ??= setTimeout(flushTools, input.summaryMs);
  };

  // --- comments, forwarded ---
  /**
   * Comments seen in the current dispatch, forwarded on the next microtask. The core
   * delivers a mutation's events — and any raised from inside their delivery — back to
   * back, so several comments can arrive before the run gets the floor again; holding them
   * and flushing the held list keeps the agent reading them in the order posted.
   *
   * This is belt and braces, and is recorded as such rather than as the thing that makes the
   * order right: `dispatch` in `core.ts` already documents and enforces that "listeners see
   * events in `seq` order even when one of them mutates from inside its callback", so a
   * listener pushing straight into the inbox would see the same order and no ordering test
   * here can fail with the buffer removed. It stays because the spec names the mechanism and
   * because it leaves this side's ordering independent of the core's — but the guarantee it
   * doubles is the core's.
   */
  const held: Comment[] = [];
  const flushHeld = (): void => {
    for (const comment of held.splice(0)) messages.push(comment.data.text);
  };

  const onEvent = (event: Activity): void => {
    if (event.cardId !== id) return;
    switch (event.type) {
      case "comment":
        // Never the run's own: an agent must not be fed its own activity.
        if (event.actorId === member.id) return;
        held.push(event);
        if (held.length === 1) queueMicrotask(flushHeld);
        return;
      case "card_moved":
      case "card_archived":
      case "released":
      case "run_interrupted":
      case "claimed":
        check();
        return;
      default:
        return;
    }
  };
  const unsubscribe = core.subscribe(onEvent);

  const limit = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, input.limitMs);
  const onStop = (): void => {
    stopping = true;
    abort.abort();
  };
  if (input.stop.aborted) onStop();
  else input.stop.addEventListener("abort", onStop, { once: true });

  // The agent is told to stop, and gets `graceMs` to do it before the run goes on alone.
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const graceExpired = new Promise<"grace">((resolve) => {
    const onAbort = (): void => {
      graceTimer = setTimeout(() => resolve("grace"), input.graceMs);
    };
    // The daemon can have stopped before the run reached this point — a listener on a
    // signal that already fired never runs, and the loop would then wait on a driver that
    // ignores its own abort with nothing to end it.
    if (abort.signal.aborted) onAbort();
    else abort.signal.addEventListener("abort", onAbort, { once: true });
  });

  let result: Extract<AgentEvent, { type: "result" }> | undefined;
  let driverError: string | undefined;
  let events: AsyncIterator<AgentEvent> | undefined;
  try {
    events = input.driver
      .run({
        cwd: path,
        env: input.env,
        systemPrompt: input.playbook,
        allowedTools: input.allowedTools,
        canUseTool: (tool, toolInput) => {
          // 013 routes this to the owner; here the answer is always no, and visibly so.
          post(`denied ${tool}: ${describeInput(tool, toolInput)}`);
          const decision: ToolDecision = {
            behavior: "deny",
            message: `${tool} is not pre-allowed for this run, and there is no way to ask for it yet. Work with what is allowed, or raise the block with skelcrew attention ${id} "<what you needed>".`,
          };
          return Promise.resolve(decision);
        },
        input: messages,
        log: (entry) => appendLog(logPath, entry),
        signal: abort.signal,
      })
      [Symbol.asyncIterator]();
    for (;;) {
      const step = await Promise.race([events.next(), graceExpired]);
      if (step === "grace") {
        warn(`skelcrew runner: card ${id}: the agent did not stop within ${input.graceMs} ms`);
        break;
      }
      if (step.done) break;
      if (abort.signal.aborted) break;
      input.stillHeld();
      const event = step.value;
      switch (event.type) {
        case "text":
          post(excerpt(event.text, logPath));
          break;
        case "tool_use":
          noteTool({ name: event.name, input: event.input });
          break;
        case "tool_result":
          break;
        case "result":
          result = event;
          break;
      }
      if (result !== undefined) break;
    }
  } catch (error) {
    if (error instanceof RunAbandoned) throw error;
    if (!abort.signal.aborted) driverError = message(error);
  } finally {
    // Not awaited: a driver that ignores its signal must not hold the run either.
    events?.return?.(undefined)?.catch(() => {});
    clearTimeout(limit);
    if (summaryTimer !== undefined) clearTimeout(summaryTimer);
    summaryTimer = undefined;
    input.stop.removeEventListener("abort", onStop);
    unsubscribe();
    messages.close();
    abort.abort();
    if (graceTimer !== undefined) clearTimeout(graceTimer);
  }

  // What the agent did lands before why the run ended; both are dropped by `post` if the
  // claim went away, and the abandonment is then the runner's to report.
  flushTools();

  /** The run's last word: `ending.ts` holds what an ending does, for every run that ends. */
  const end = (note: string, moves: Phase[], reason: string): void => {
    endRun({
      core,
      attention: input.attention,
      cardId: id,
      memberId: member.id,
      ownerId,
      warn,
      // Marked, not merely cut: the one note that can reach the cap is a driver error, and
      // a harness message amputated mid-sentence with nothing saying so misleads the owner.
      note: cutMarked(note, COMMENT_MAX_BYTES / 4),
      moves,
      reason,
    });
  };
  const fail = (note: string): void => {
    end(note, [], "failed");
  };

  /** Why the run stopped short, or undefined when the agent's session ended on its own. */
  const cutShort = (): string | undefined => {
    if (stopping) return "run aborted: daemon stopping";
    if (timedOut) return `run aborted: time limit of ${describeLimit(input.limitMs)} reached`;
    if (driverError !== undefined) return `run failed: ${driverError}`;
    if (result === undefined) return "run failed: the agent ended without a result";
    if (!result.ok) return `run failed: ${result.error ?? "the agent reported an error"}`;
    return undefined;
  };

  // The contract is read-only, so it runs before the ending is settled and its git calls are
  // just another window the card can change in. What decides is the classification below it.
  const early = cutShort();
  const settled =
    early !== undefined
      ? { met: false, note: early, moves: [] as Phase[], refs: undefined }
      : await checkContract(input.phase, {
          core,
          git: input.git,
          repoRoot: input.repoRoot,
          worktreePath: path,
          branch: input.branch,
          base: input.base,
          cardId: id,
          memberId: member.id,
          sinceSeq: input.sinceSeq,
        });

  const outcome = classifyEnding({
    core,
    cardId: id,
    memberId: member.id,
    phase: input.phase,
    sinceSeq: input.sinceSeq,
    now: input.now(),
  });
  switch (outcome.kind) {
    case "self":
      // Recorded wherever the card ended up: `endRun` comments regardless, and raises only if
      // the card is still there to be handed over. This run's failure is not a new holder's
      // queue to fill.
      end(outcome.note, [], "failed");
      return;
    case "abandoned":
      throw new RunAbandoned(outcome.reason);
    case "released":
      // The card waits on the owner rather than going straight back into the queue for the
      // next scan to pick up a moment after they took it by hand.
      end(
        `run stopped: the card was released while the agent was working; the work is in ${path}`,
        [],
        "stopped",
      );
      return;
    case "held":
      break;
  }
  if (!settled.met) {
    fail(settled.note);
    return;
  }
  if (settled.refs !== undefined) core.setRefs(id, settled.refs, member.id);
  end(settled.note, settled.moves, "finished");
}
