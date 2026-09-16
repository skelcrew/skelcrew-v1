/**
 * One run: a coding agent in the card's worktree with the phase's playbook and the card,
 * streamed back to the card as excerpts — every assistant turn a comment, tool calls
 * batched, the full stream in a log under the data directory — and answered from the card:
 * comments by other members reach the agent as user messages, and a tool the list does not
 * pre-allow becomes a question to the owner, one at a time, whose answer the agent is told
 * and whose outcome the card shows. The run ends when the session ends,
 * when the time limit fires, when the daemon stops, or when the claim is lost; in every case
 * the card is left in a state a member can act on, with the reason on it, and never with a
 * question the agent raised replaced by it.
 *
 * While the run is live, nothing is posted after an await without the claim still being this
 * run's: that is what `post` enforces, and an abandonment writes nothing at all beyond the one
 * comment saying so. **Two endings are deliberate exceptions**, and they use `record` rather
 * than `post` for exactly that reason: the stop on an explicit release, and the agent having
 * acted on its own card. Both write to a card this run no longer holds, because the spec wants
 * the record where the card ended up — a stop must leave the owner something to act on, and a
 * self-action is an accountability record. `endRun` comments unconditionally for the same
 * reason, so the tool summary those endings flush goes the same way its reason does rather
 * than being silently dropped beside it.
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
  escapeControlCharacters,
  type Member,
  type Phase,
} from "@skelcrew/shared";
import type { AgentDriver, AgentEvent, ToolDecision } from "./agent";
import { type ContractOutcome, checkContract } from "./contracts";
import {
  classifyEnding,
  endRun,
  type RunAttention,
  type RunCore,
  type RunQuestion,
} from "./ending";
import type { Git } from "./git";
import type { PlaybookKind, PlaybookPhase } from "./playbooks";

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
/** The agent's reason for a question is one line of the note, and is cut here. */
const WHY_LINE_MAX = 200;
const COMMAND_IN_SUMMARY_MAX = 60;
/** A batch's summary is one comment, so it is cut like every other write to a card. */
const SUMMARY_MAX_BYTES = COMMENT_MAX_BYTES / 4;
const ELLIPSIS = "…";
const RUNS_DIR_NAME = "runs";
/** The words that allow a tool. Anything else the owner writes — or writes nothing — denies. */
const ALLOWING_ANSWERS = new Set(["allow", "yes", "ok"]);

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
  /** The `runner` member: the claim's holder, and who everything this module writes is. */
  member: Member;
  /**
   * The `crew` member the agent speaks as. Its writes are what the phase's contract counts as
   * this run's, and its activity is no more fed back to the agent than the runner's own is.
   */
  crew: Member;
  /** The one helper this run raises attention through. */
  attention: RunAttention;
  /** Who an ending hands the card to; resolved by `ending.ts`, inside its own guard. */
  ownerId(): number;
  warn: (line: string) => void;
  card: Card;
  /** The phase claimed, narrowed to the phases a playbook and a contract exist for. */
  phase: PlaybookPhase;
  /**
   * What kind of run this is: the claimed phase, or the review the Code phase's loop runs
   * between its Code runs. It chooses the playbook above and the contract below; `phase` stays
   * the card's, which is what an ending is judged against.
   */
  kind: PlaybookKind;
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
  /** Where the branch stood before the agent started: what "moved during this run" is read against. */
  branchHead: string;
  base: string;
  driver: AgentDriver;
  playbook: string;
  env: Record<string, string>;
  allowedTools: string[];
  /** Paths no file tool may touch, however `allowedTools` reads: deny outranks allow. */
  deniedTools: string[];
  /** This run's log, already created by `createRunLog`; appended to, never truncated. */
  logPath: string;
  limitMs: number;
  /** How long the agent gets to end after being told to, before the run goes on without it. */
  graceMs: number;
  /** The window tool calls are batched into one comment over. */
  summaryMs: number;
  /** Fires when the daemon is stopping: the run is told to stop and ends as such. */
  stop: AbortSignal;
  /**
   * Where this run records its own permission question, so that every ending — the ones
   * below and the runner's, for a throw that gets past them — replaces that request and no
   * other. The runner owns it: see `ending.ts`.
   */
  question: RunQuestion;
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

/**
 * `text` with every line prefixed `> `, an empty one becoming `>`. What this is for is the
 * question's payload: the agent chooses that text, so unquoted it can be laid out to read as
 * the frame around it, and a blank line in it manufactures the separator the CLI's queue view
 * splits real requests on. Quoted, no line of it is either.
 */
function quoted(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
}

/** `text` within `budget` bytes, marked when there was more of it. */
function cutMarked(text: string, budget: number): string {
  if (Buffer.byteLength(text, "utf8") <= budget) return text;
  return `${cutBytes(text, budget - Buffer.byteLength(ELLIPSIS, "utf8"))}${ELLIPSIS}`;
}

/**
 * Text the run relays but did not write — a turn, a tool's input, a batch's summary — with
 * every control character rendered visible, by the same definition the core refuses them by.
 *
 * This is **not** what makes the guarantee: `postingCore` escapes everything the runner writes
 * to a card, so a relay that skipped this one would still land. What it buys is the byte caps
 * below — an excerpt, a note and a summary are each cut to fit a comment, and cutting before
 * escaping would measure a budget against text that is not what gets posted. `\n` and `\t`
 * stay: a comment and a note are multi-line. The run log is untouched by any of it; it records
 * the stream verbatim, and it is a file rather than a terminal.
 */
function relayed(text: string): string {
  return escapeControlCharacters(text, "multi-line");
}

/** A text turn as the card shows it: whole under the limit, else cut with a marker. */
function excerpt(raw: string, logPath: string): string {
  const text = relayed(raw);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= TEXT_EXCERPT_BYTES) return text;
  return `${cutBytes(text, TEXT_EXCERPT_BYTES)}\n… [truncated: ${bytes} bytes; the full turn is in the run log at ${logPath}]`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s*\n\s*/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A tool call's input, whole: the command for Bash, the path for file tools, else the lot. */
function inputOf(tool: string, input: Record<string, unknown>): string {
  const command = input.command;
  if (tool === "Bash" && typeof command === "string") return command;
  const path = input.file_path ?? input.path;
  if (typeof path === "string") return path;
  return JSON.stringify(input) ?? "";
}

/**
 * What a tool call is called on the card: `inputOf`, cut to one glanceable line. This is the
 * activity summary's rendering and the record of a decision already made — never the question
 * the owner answers, which carries the input whole (`questionFor`).
 */
function describeInput(tool: string, input: Record<string, unknown>): string {
  // Escaped first, like every other relay here, so the line's own cut is measured on what is
  // actually shown; `oneLine` then collapses the line breaks the escape kept.
  return oneLine(relayed(inputOf(tool, input)), INPUT_LINE_MAX);
}

/**
 * The agent's own reason for a call, as the note's `why:` line and the newline after it — or
 * nothing at all, which is what the question carries when no text turn preceded the ask.
 *
 * Escaped first, like every other relay here, so the cut is measured on what is actually shown.
 * Flattened next, and that is what makes it safe to interpolate unquoted: the party choosing
 * this text is the party being gated, and with every line break gone it cannot become a line of
 * its own — 015's reason, and the same one the input is quoted for. Then cut to its own budget,
 * which the caller's byte arithmetic counts as part of the note's fixed part, so a long reason
 * cannot push the input past the cap. `oneLine` cuts by character and `cutMarked` by byte, so
 * the budget is the tighter of the two and the line is marked wherever it bit.
 */
function whyLine(raw: string | undefined): string {
  if (raw === undefined) return "";
  const line = cutMarked(oneLine(relayed(raw), WHY_LINE_MAX), WHY_LINE_MAX);
  return line.length === 0 ? "" : `why: ${line}\n`;
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
  // Escaped before the cut, so the cap is measured on what is actually posted.
  return cutMarked(relayed(summary), SUMMARY_MAX_BYTES);
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

/**
 * One run. Returns the contract's outcome when it was met and the card is still this run's —
 * what the caller does with that is the caller's, because a Code run's met contract is the
 * start of a review rather than the end of the phase (`runner.ts`). Every other ending —
 * an unmet contract, a time limit, the daemon stopping, a driver error, a self-action, a stop —
 * is settled here through `endRun`, and answered with nothing, so the loop stops when it sees
 * one. An abandonment throws `RunAbandoned`, as before.
 */
export async function runPlaybook(input: RunInput): Promise<ContractOutcome | undefined> {
  const { core, member, crew, ownerId, warn, card, path, logPath } = input;
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

  /**
   * A comment on the card whatever the claim now is: what the endings that deliberately write
   * to a card this run no longer holds use, the way `endRun` writes their reason.
   */
  const record = (text: string): void => {
    try {
      core.comment(id, text, member.id);
    } catch (error) {
      warn(`skelcrew runner: card ${id}: could not comment: ${message(error)}`);
    }
  };

  /** A comment on the card, only while the claim is still this run's; otherwise dropped. */
  const post = (text: string): void => {
    if (input.lost() !== undefined) return;
    record(text);
  };

  // --- tool calls, batched ---
  const pendingTools: Array<{ name: string; input: Record<string, unknown> }> = [];
  let summaryTimer: ReturnType<typeof setTimeout> | undefined;
  /** `write` is `post` while the run is live; an ending picks the one its own comment uses. */
  const flushTools = (write: (text: string) => void = post): void => {
    if (summaryTimer !== undefined) clearTimeout(summaryTimer);
    summaryTimer = undefined;
    if (pendingTools.length === 0) return;
    write(summarizeTools(pendingTools.splice(0)));
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
   *
   * One thing about it is *not* belt and braces: `answerTo` splices the owner's answer out of
   * this list rather than reading it, which is what stops that comment also reaching the agent
   * as a message. The buffer is where that consumption happens, so removing it, or turning the
   * splice into a lookup, changes behaviour rather than only ordering.
   */
  const held: Comment[] = [];
  const flushHeld = (): void => {
    for (const comment of held.splice(0)) messages.push(comment.data.text);
  };

  // --- tools the list does not pre-allow: asked, one at a time ---

  /** One tool call waiting on the owner: what was asked, and how the agent is told. */
  interface Ask {
    tool: string;
    input: Record<string, unknown>;
    /** The agent's last text turn when the call was made, or undefined when there was none. */
    why: string | undefined;
    settle: (decision: ToolDecision) => void;
  }

  /**
   * The text of the agent's last turn, which is where it says what it is about to do — kept so
   * that a question raised in the same turn can carry it (022). Cleared when the session ends
   * and when this run's own question is answered, because the agent goes on in a new turn from
   * there: a sentence written before the answer describes a call the owner has already decided,
   * and beside the next command it would be true of nothing. Copied onto the ask when the call
   * is made rather than read when the question is raised, so a queued ask keeps its own turn's
   * sentence however long it waits behind another.
   */
  let turnText: string | undefined;

  /** Asked and not yet on the card, oldest first. */
  const queued: Ask[] = [];
  /** The ask the card's open request is for. */
  let asking: Ask | undefined;
  /**
   * The request the core recorded for this run's own question, while it is still the card's:
   * cleared when it is answered or replaced, and *not* when the ask it belongs to is settled,
   * because a run ending with its question still open is exactly when the ending needs to
   * know which request is its own to replace. The runner holds the same value, so its endings
   * read what this run recorded (`ending.ts`).
   */
  const question = input.question;

  /** What the tool is called on the card, in the question and in the answer's record. */
  const describeCall = (pending: Ask): string =>
    `${pending.tool}: ${describeInput(pending.tool, pending.input)}`;

  /**
   * The question, carrying the two commands that answer it — and the tool's input **whole**,
   * not the one-line rendering the activity summary uses. The party choosing the text is the
   * party being gated: a command whose first two hundred characters read `git log …` and whose
   * tail is `&& curl … | sh` is compound, so it is not pre-allowed and does reach here, and
   * approving it on the head alone approves a rendering rather than the thing. The only cut is
   * the note's own byte cap, which the core enforces; where that bites, it is marked and the
   * run log holds the whole of it.
   *
   * **The frame comes first and the payload is quoted**, for the same reason read the other
   * way round. Interpolated raw, the agent's own text laid the note out: an input beginning
   * `ls? (skelcrew resolve 1 -m allow | …)` and continuing, past a blank line, with what looks
   * like another card's request produced a note whose first line was a complete, benign
   * question and whose tail read as a second request — the CLI's queue view prints the note
   * verbatim and separates real requests with exactly one blank line. So both resolving
   * commands sit on the first line, the input goes last under its own label, and `quoted`
   * leaves no line of it that can be either. Same class as milestone 015, where control
   * characters repaint a rendered line rather than laying out a fake one; 015 is not this.
   *
   * **Between the two sits the agent's reason for the call**, when it wrote one in the same turn
   * (022): `whyLine` above, on one line, inside this function's byte arithmetic so that a long
   * reason costs the reason and never the input. A command the owner cannot read from their
   * phone is a run that waits until they are at a machine; the sentence is what they answer from.
   */
  const questionFor = (pending: Ask): string => {
    const frame = `allow ${pending.tool}? (skelcrew resolve ${id} -m allow | skelcrew resolve ${id} -m deny)\n${whyLine(pending.why)}input:\n`;
    // Escaped where it is composed, before it is quoted or measured: the payload is the
    // agent's text, and the note's cap below has to be measured on what is actually posted.
    // The sink escapes it in any case (`postingCore`); this is about the cut, not the safety.
    const raw = relayed(inputOf(pending.tool, pending.input));
    const text = quoted(raw);
    const fixed = Buffer.byteLength(frame, "utf8");
    if (fixed + Buffer.byteLength(text, "utf8") <= COMMENT_MAX_BYTES) return `${frame}${text}`;
    const bytes = Buffer.byteLength(raw, "utf8");
    const mark = `\n… [truncated: ${bytes} bytes; the whole input is in the run log at ${logPath}]`;
    const budget = COMMENT_MAX_BYTES - fixed - Buffer.byteLength(mark, "utf8");
    // The cut's own trailing newline would meet the marker's leading one and make the blank
    // line the quoting exists to prevent.
    return `${frame}${cutBytes(text, budget).replace(/\n+$/, "")}${mark}`;
  };

  /** Told to the agent when the run is over before the owner has answered. */
  const over = (pending: Ask): void => {
    pending.settle({
      behavior: "deny",
      message: `The run ended before the owner answered, so ${pending.tool} did not run.`,
    });
  };

  /**
   * Raises the oldest queued ask, if the card is free to carry it. A question the agent
   * asked itself is the owner's to answer first and is never replaced; the ask waits, and
   * comes back here when that question is resolved. Called from the ask and from inside the
   * `attention_resolved` dispatch, where the core queues the nested mutation so the next
   * question lands with the previous answer.
   */
  const raiseNext = (): void => {
    const next = queued[0];
    if (asking !== undefined || next === undefined) return;
    if (input.lost() !== undefined) return;
    try {
      if (core.getCard(id).attention !== null) return;
      // Through the one helper, like every other raise: a permission question offers the
      // owner no phase move, only the two commands that answer it.
      const raised = input.attention.raise(
        id,
        { to: ownerId(), note: questionFor(next), moves: [] },
        question,
      );
      if (raised === undefined) return;
      queued.shift();
      asking = next;
      question.raised(raised);
    } catch (error) {
      const failure = message(error);
      warn(`skelcrew runner: card ${id}: could not ask about ${next.tool}: ${failure}`);
      // Nothing retries a request the core refused: an ask left queued would wait for an
      // `attention_resolved` that cannot arrive, and the agent would block until the run's
      // limit fired with a line in the daemon's log as the only trace. It is denied instead,
      // naming the failure, and the card says so.
      queued.shift();
      next.settle({
        behavior: "deny",
        message: `${next.tool} could not be put to the owner: ${failure}`,
      });
      post(
        cutMarked(
          `could not ask the owner about ${describeCall(next)}: ${failure}`,
          COMMENT_MAX_BYTES / 4,
        ),
      );
      raiseNext();
    }
  };

  const ask = (tool: string, toolInput: Record<string, unknown>): Promise<ToolDecision> =>
    new Promise<ToolDecision>((resolve) => {
      const pending: Ask = { tool, input: toolInput, why: turnText, settle: resolve };
      if (abort.signal.aborted) {
        over(pending);
        return;
      }
      queued.push(pending);
      raiseNext();
    });

  /** Nothing is left waiting on an answer that is not coming. `question` outlives this: see it. */
  const settleAll = (): void => {
    const pending = asking === undefined ? [] : [asking];
    asking = undefined;
    for (const outstanding of [...pending, ...queued.splice(0)]) over(outstanding);
  };
  abort.signal.addEventListener("abort", settleAll, { once: true });

  /**
   * The owner's answer: the comment `resolveAttention` recorded immediately before the
   * resolution, by the same actor. It is consumed here as the decision and so is *not* also
   * forwarded to the agent, which would otherwise read its own answer twice.
   */
  const answerTo = (resolution: Activity): string | undefined => {
    const at = held.findIndex(
      (comment) => comment.seq === resolution.seq - 1 && comment.actorId === resolution.actorId,
    );
    if (at === -1) return undefined;
    return (held.splice(at, 1)[0] as Comment).data.text;
  };

  /**
   * `allow`, `yes` and `ok` allow; anything else, and nothing at all, denies. A resolution
   * of a question that is not this run's — the agent's own — decides nothing and leaves its
   * comment to reach the agent as a message; either way the next queued ask can be raised,
   * and is, from inside this dispatch.
   */
  const answered = (resolution: Activity): void => {
    const pending = asking;
    if (pending === undefined) {
      raiseNext();
      return;
    }
    const text = answerTo(resolution);
    asking = undefined;
    question.raised(undefined);
    // The answer resumes the agent in a new turn, so what it said before the answer is not the
    // reason for whatever it asks next.
    turnText = undefined;
    if (text !== undefined && ALLOWING_ANSWERS.has(text.trim().toLowerCase())) {
      pending.settle({ behavior: "allow" });
      post(`allowed ${describeCall(pending)}`);
    } else {
      pending.settle({
        behavior: "deny",
        message:
          text === undefined
            ? `The owner did not allow ${pending.tool}, and said nothing about why. Do not retry it: work with what is allowed, or say what you needed with skelcrew attention ${id} "<what you needed>".`
            : `The owner did not allow ${pending.tool}: ${text}`,
      });
      post(
        cutMarked(
          `denied ${describeCall(pending)}${text === undefined ? "" : ` — ${text}`}`,
          COMMENT_MAX_BYTES / 4,
        ),
      );
    }
    raiseNext();
  };

  const onEvent = (event: Activity): void => {
    if (event.cardId !== id) return;
    switch (event.type) {
      case "comment":
        // Never the run's own, and never the agent's: an agent must not be fed its own
        // activity, and after 016 its own comments are `crew`'s rather than the runner's.
        if (event.actorId === member.id || event.actorId === crew.id) return;
        held.push(event);
        if (held.length === 1) queueMicrotask(flushHeld);
        return;
      case "attention_requested":
        // Raised over this run's question — by the agent, most likely. The card's request is
        // not the run's any more, so the ask goes back in the queue and waits its turn.
        if (asking !== undefined && !question.isOpen(event.data)) {
          queued.unshift(asking);
          asking = undefined;
          question.raised(undefined);
        }
        return;
      case "attention_resolved":
        // Only an answer is an answer: a move or an archive clears the request on its way to
        // ending the run, and `check` is what notices that.
        if (event.data.how === "answered") answered(event);
        else check();
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
        disallowedTools: input.deniedTools,
        canUseTool: ask,
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
          turnText = event.text;
          post(excerpt(event.text, logPath));
          break;
        case "tool_use":
          noteTool({ name: event.name, input: event.input });
          break;
        case "tool_result":
          break;
        case "result":
          result = event;
          turnText = undefined;
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
      logPath,
      // The one open request an ending may replace is this run's own question, which nothing
      // will answer now: the owner's queue must show why the run ended, not a resolve command
      // that allows no tool. A question the agent raised is left exactly where it is.
      question,
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
  const settled: ContractOutcome =
    early !== undefined
      ? { met: false, note: early, moves: [] }
      : await checkContract(input.kind, {
          core,
          git: input.git,
          repoRoot: input.repoRoot,
          worktreePath: path,
          branch: input.branch,
          branchHead: input.branchHead,
          base: input.base,
          cardId: id,
          // The artefact is the agent's to produce, and the agent is `crew`.
          memberId: crew.id,
          sinceSeq: input.sinceSeq,
        });

  const outcome = classifyEnding({
    core,
    cardId: id,
    memberId: member.id,
    crewId: crew.id,
    phase: input.phase,
    sinceSeq: input.sinceSeq,
    now: input.now(),
  });
  /**
   * What the agent did lands before why the run ended, written the way that ending writes its
   * own reason: `post` while the card is still this run's, and `record` on the two endings
   * that deliberately write to a card it no longer holds — the stop and the self-action.
   * Dropping the batch there while their comment lands would be a silent mutation. An
   * abandonment is the exception, and the only one: one comment saying so, and nothing else.
   */
  if (outcome.kind !== "abandoned") flushTools(outcome.kind === "held" ? post : record);

  switch (outcome.kind) {
    case "self":
      // Recorded wherever the card ended up: `endRun` comments regardless, and raises only if
      // the card is still there to be handed over. This run's failure is not a new holder's
      // queue to fill.
      end(outcome.note, [], "failed");
      return undefined;
    case "abandoned":
      throw new RunAbandoned(outcome.reason);
    case "released":
      // The card waits on the owner rather than going straight back into the queue for the
      // next scan to pick up a moment after they took it by hand. The release that stopped
      // this run is the card's only one — `endRun` releases nothing it does not hold, and
      // this ending is reached precisely because the claim is already gone — so the reason
      // passed here is never recorded. It says what the ending is, and the criterion 10 test
      // asserts that the card's one release is the owner's, so nothing rests on it landing.
      end(
        `run stopped: the card was released while the agent was working; the work is in ${path}`,
        [],
        "stopped",
      );
      return undefined;
    case "held":
      break;
  }
  if (!settled.met) {
    fail(settled.note);
    return undefined;
  }
  // The run's own work, recorded before it is handed back: a Code run's commits are this run's
  // whatever the review that follows makes of them.
  if (settled.refs !== undefined) core.setRefs(id, settled.refs, member.id);
  return settled;
}
