/**
 * One run: a coding agent in the card's worktree with the phase's playbook and the card,
 * streamed back to the card as excerpts — every assistant turn a comment, tool calls
 * batched, the full stream in a log under the data directory — and answered from the
 * card: comments reach the agent as user messages, a tool outside the allowlist becomes an
 * attention request whose answer is the decision. The run ends when the session ends,
 * when the time limit fires, when the daemon stops, or when the claim is lost; then the
 * phase's artefact contract decides whether the card is handed off or the run failed.
 * Nothing is posted after an await without the claim still being this run's.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Activity,
  type Attention,
  type Card,
  COMMENT_MAX_BYTES,
  COMMITS_MAX_COUNT,
  type Member,
  type Phase,
} from "@skelcrew/shared";
import type { Core } from "../core/core";
import type { AgentDriver, AgentEvent, ToolDecision } from "./agent";
import { raiseAttention } from "./attention";
import type { Git } from "./git";

/** The default time limit; `SKELCREW_RUN_MINUTES` overrides it. */
export const RUN_LIMIT_MINUTES_DEFAULT = 60;
/** After the run tells the agent to stop, how long it waits for it before going on without it. */
export const ABORT_GRACE_MS_DEFAULT = 5000;
/** A text turn longer than this is posted cut, with a marker. */
export const TEXT_EXCERPT_BYTES = 2 * 1024;
/** Tool calls are posted as one summary per window. */
export const TOOL_SUMMARY_MS = 30_000;
/** One-line renderings of a tool's input are cut here. */
const INPUT_LINE_MAX = 200;
const COMMAND_IN_SUMMARY_MAX = 60;
const ALLOW_WORDS = new Set(["allow", "yes", "ok"]);
export const RUNS_DIR_NAME = "runs";

/** The run's claim went away: the card is someone else's now, and nothing more is posted. */
export class RunAbandoned extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RunAbandoned";
  }
}

export interface RunInput {
  core: Core;
  git: Git;
  member: Member;
  ownerId: number;
  warn: (line: string) => void;
  card: Card;
  /** The card's worktree, branch, and the base branch it forked from. */
  path: string;
  branch: string;
  base: { name: string; sha: string };
  repoRoot: string;
  driver: AgentDriver;
  playbook: string;
  env: Record<string, string>;
  allowedTools: string[];
  /** This run's log, already created by `createRunLog`; events are appended, never truncated. */
  logPath: string;
  limitMs: number;
  /** How long the agent gets to end after being told to, before the run goes on without it. */
  graceMs: number;
  /** The window tool calls are batched into one comment over. */
  summaryMs: number;
  /** Fires when the daemon is stopping: the run is aborted and fails as such. */
  stop: AbortSignal;
  /** Throws `RunAbandoned` when the claim is no longer this run's, live. */
  stillHeld(): void;
  /** Why the claim is no longer this run's, or undefined while it is. */
  lost(): string | undefined;
}

export function runsDir(dataDir: string): string {
  return join(dataDir, RUNS_DIR_NAME);
}

/** `SKELCREW_RUN_MINUTES`, or the default; anything that is not a positive number is an error. */
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
 * `nth` above 1 is the `-<nth>` that tells them apart, and `createRunLog` is what picks it.
 */
export function runLogPath(dataDir: string, cardId: number, startedAt: number, nth = 1): string {
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
 * same second, whose path is on the card — is never truncated; the next free `-<nth>` is
 * taken instead.
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
export function cardPrompt(
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

/** A text turn as the card shows it: whole under 2 KiB, else cut with a marker. */
export function excerpt(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= TEXT_EXCERPT_BYTES) return text;
  return `${cutBytes(text, TEXT_EXCERPT_BYTES)}\n… [truncated: ${bytes} bytes; the full text is in the run log]`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s*\n\s*/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** What the owner is asked about: the command for Bash, the path for file tools, else the input. */
function describeInput(tool: string, input: Record<string, unknown>): string {
  const command = input.command;
  if (tool === "Bash" && typeof command === "string") return oneLine(command, INPUT_LINE_MAX);
  const path = input.file_path ?? input.path;
  if (typeof path === "string") return oneLine(path, INPUT_LINE_MAX);
  return oneLine(JSON.stringify(input), INPUT_LINE_MAX);
}

/** `resolve -m <text>`: allow on the recognised words; anything else denies with the text as the reason. */
export function decide(text: string | undefined): ToolDecision {
  const word = text?.trim().toLowerCase() ?? "";
  if (ALLOW_WORDS.has(word)) return { behavior: "allow" };
  return { behavior: "deny", message: text === undefined || text.trim() === "" ? "denied" : text };
}

/** "ran 4 tools: Read ×2, Bash `bun test`, Edit": Bash calls named, the rest counted. */
export function summarizeTools(
  calls: Array<{ name: string; input: Record<string, unknown> }>,
): string {
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
  return `ran ${calls.length} tool${calls.length === 1 ? "" : "s"}: ${listed.join(", ")}`;
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

type Comment = Activity & { type: "comment" };
type Ask = { note: string; resolve(decision: ToolDecision): void };

export async function runPlaybook(input: RunInput): Promise<void> {
  const { core, git, member, ownerId, warn, card, path, branch, base, driver, logPath } = input;
  const id = card.id;
  const atStart = core.getCard(id);
  const startSeq = atStart.activity.at(-1)?.seq ?? 0;

  const abort = new AbortController();
  let lostReason: string | undefined;
  let timedOut = false;
  let stopping = false;
  /** The agent moved, released, or archived its own card: the run is over, and failed. */
  let selfAction: string | undefined;
  /** Who released this run's claim, when someone else did: why the run stopped, not whether. */
  let releasedBy: string | undefined;
  /** The card left this phase, or was archived, at some point during the run. */
  let movedAway = false;
  const messages = inbox();
  messages.push(cardPrompt(card, branch, base.name));

  /** The claim, re-checked on every event that could have taken it: lost means abort. */
  const check = (): void => {
    if (lostReason !== undefined) return;
    lostReason = input.lost();
    if (lostReason !== undefined) abort.abort();
  };

  /** A comment that lands whether or not the claim survived; a card that refuses it is warned about. */
  const say = (text: string): void => {
    try {
      core.comment(id, text, member.id);
    } catch (error) {
      warn(`skelcrew runner: card ${id}: could not comment: ${message(error)}`);
    }
  };

  /** A comment on the card, only while the claim is still this run's; otherwise dropped. */
  const post = (text: string): void => {
    if (input.lost() !== undefined) return;
    say(text);
  };

  // --- tool calls, batched ---
  const pendingTools: Array<{ name: string; input: Record<string, unknown> }> = [];
  let summaryTimer: ReturnType<typeof setTimeout> | undefined;
  const flushTools = (evenWithoutTheClaim = false): void => {
    if (summaryTimer !== undefined) clearTimeout(summaryTimer);
    summaryTimer = undefined;
    if (pendingTools.length === 0) return;
    const summary = summarizeTools(pendingTools.splice(0));
    if (evenWithoutTheClaim) say(summary);
    else post(summary);
  };
  const noteTool = (call: { name: string; input: Record<string, unknown> }): void => {
    pendingTools.push(call);
    summaryTimer ??= setTimeout(flushTools, input.summaryMs);
  };

  // --- comments, forwarded ---
  /**
   * Comments seen in the current dispatch, forwarded on the next microtask — unless one is
   * the `resolve -m` answer to the run's own permission request, which is taken as the
   * decision instead. The core delivers a mutation's events back to back, so the comment
   * a `resolveAttention` records is still held when its `attention_resolved` arrives.
   */
  const held: Comment[] = [];
  const flushHeld = (): void => {
    for (const comment of held.splice(0)) messages.push(comment.data.text);
  };
  const takeAnswer = (resolved: Activity): string | undefined => {
    const at = held.findIndex((c) => c.seq === resolved.seq - 1 && c.actorId === resolved.actorId);
    if (at < 0) return undefined;
    const [answer] = held.splice(at, 1);
    return answer?.data.text;
  };

  // --- approvals through attention, one at a time ---
  const deny = (reason: string): ToolDecision => ({ behavior: "deny", message: reason });
  const asks: Ask[] = [];
  /** The run's own open request, identified by what the core recorded for it. */
  let current: (Ask & { raised: Attention }) | undefined;
  /**
   * Raises the next queued request — never over the run's own open one, and never over a
   * question the agent itself raised on the card (`skelcrew attention`), which the owner
   * must answer first. `raiseAttention` declines both, so the ask stays at the front of
   * the queue and is raised again when the card is free.
   */
  const raiseNext = (): void => {
    if (abort.signal.aborted) {
      for (const ask of asks.splice(0)) ask.resolve(deny("run aborted"));
      return;
    }
    while (current === undefined && asks.length > 0) {
      const ask = asks[0] as Ask;
      let raised: Attention | undefined;
      try {
        raised = raiseAttention(core, id, { to: ownerId, note: ask.note }, member.id);
      } catch (error) {
        asks.shift();
        ask.resolve(deny(`could not ask: ${message(error)}`));
        continue;
      }
      if (raised === undefined) return;
      asks.shift();
      current = { ...ask, raised };
    }
  };
  const isOwn = (open: Attention): boolean =>
    current !== undefined &&
    open.raisedAt === current.raised.raisedAt &&
    open.note === current.raised.note &&
    open.raisedBy === member.id;
  const canUseTool = (tool: string, toolInput: Record<string, unknown>): Promise<ToolDecision> => {
    check();
    if (abort.signal.aborted) return Promise.resolve(deny("run aborted"));
    const note = `allow ${tool} ${describeInput(tool, toolInput)}? (skelcrew resolve ${id} -m allow | skelcrew resolve ${id} -m deny)`;
    return new Promise<ToolDecision>((resolve) => {
      asks.push({ note, resolve });
      raiseNext();
    });
  };

  const onEvent = (event: Activity): void => {
    if (event.cardId !== id) return;
    switch (event.type) {
      case "comment":
        if (event.actorId === member.id) return;
        held.push(event);
        if (held.length === 1) queueMicrotask(flushHeld);
        return;
      case "attention_requested":
        // The agent's own question replaced the run's open request: ask again after it.
        if (current !== undefined && !isOwn(event.data)) {
          asks.unshift(current);
          current = undefined;
        }
        return;
      case "attention_resolved": {
        const open = current;
        current = undefined;
        if (open !== undefined) {
          if (event.data.how === "answered") open.resolve(decide(takeAnswer(event)));
          else {
            // Resolved by a move or an archive: the claim went with it.
            check();
            open.resolve(deny("run aborted"));
          }
        }
        raiseNext();
        return;
      }
      // The agent may never move, release, or archive its own card: the runner verifies the
      // artefact before any handoff, and a card the agent moved on has skipped that gate.
      case "card_moved":
        movedAway = true;
        if (event.actorId === member.id) selfAction ??= `moved its own card (to ${event.data.to})`;
        check();
        return;
      case "card_archived":
        movedAway = true;
        if (event.actorId === member.id) selfAction ??= "archived its own card";
        check();
        return;
      case "released":
        if (event.actorId === member.id) {
          selfAction ??= `released its own card (${event.data.reason ?? "no reason"})`;
        } else {
          // Someone else let the claim go. Whether that is still what the card shows is
          // decided at the end, from the card; this is only the name to report if it is.
          releasedBy = core.getMember(event.actorId).name;
        }
        check();
        return;
      case "run_interrupted":
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
  // The agent is told to stop; whoever is still waiting on the owner is answered no.
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const graceExpired = new Promise<"grace">((resolve) => {
    const onAbort = (): void => {
      current?.resolve(deny("run aborted"));
      for (const ask of asks.splice(0)) ask.resolve(deny("run aborted"));
      graceTimer = setTimeout(() => resolve("grace"), input.graceMs);
    };
    // The daemon can have stopped before the run reached this point — a listener on a
    // signal that already fired never runs, and the loop would then wait on a driver
    // that ignores its own abort with nothing to end it.
    if (abort.signal.aborted) onAbort();
    else abort.signal.addEventListener("abort", onAbort, { once: true });
  });

  let result: Extract<AgentEvent, { type: "result" }> | undefined;
  let driverError: string | undefined;
  try {
    const events = driver
      .run({
        cwd: path,
        env: input.env,
        systemPrompt: input.playbook,
        allowedTools: input.allowedTools,
        canUseTool,
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
      const event = step.value;
      if (abort.signal.aborted) break;
      input.stillHeld();
      switch (event.type) {
        case "text":
          post(excerpt(event.text));
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
    // Not awaited: a driver that ignores its signal must not hold the run either.
    events.return?.(undefined)?.catch(() => {});
  } catch (error) {
    if (error instanceof RunAbandoned) throw error;
    if (!abort.signal.aborted) driverError = message(error);
  } finally {
    clearTimeout(limit);
    if (summaryTimer !== undefined) clearTimeout(summaryTimer);
    summaryTimer = undefined;
    input.stop.removeEventListener("abort", onStop);
    unsubscribe();
    messages.close();
    abort.abort();
    if (graceTimer !== undefined) clearTimeout(graceTimer);
  }

  /**
   * The run's last word: `note` as a comment, whether or not the claim survived, and — when
   * `raise` — the card left waiting on the owner with it. Still waiting on the agent's
   * question instead, if one is open, since `raiseAttention` leaves that one alone. The two
   * effects are separate because they answer to different rules: the comment is the record of
   * what happened, which the card is owed either way, while a request is a claim on a
   * member's queue, which a run that no longer holds the card has no standing to make.
   */
  const stopWith = (note: string, raise: boolean): void => {
    try {
      core.comment(id, note, member.id);
      if (raise) raiseAttention(core, id, { to: ownerId, note }, member.id, isOwn);
    } catch (error) {
      warn(`skelcrew runner: card ${id}: ${note}; and could not say so: ${message(error)}`);
    }
  };
  /**
   * How the run ends, read off the card as it is now — who holds the claim, and where the
   * card is — rather than decided by what the run remembers happening to it. The events the
   * run saw supply the reason to report, never the outcome: an event kind this switch was
   * never taught about can then no longer end in a write to a card that is someone else's,
   * because the write needs the card itself to say the card is still free and still here.
   *
   * `stop` is the exception the card cannot be read for: the claim is gone, so nothing is
   * released, but the card must not become ready again silently, so the run says why it
   * stopped and — unless someone else now holds the card — leaves it waiting on the owner.
   */
  type Ending =
    | { kind: "held" }
    | { kind: "stop"; note: string; raise: boolean }
    | { kind: "gone" };
  const ending = ((): Ending => {
    // The one thing the card cannot answer: what this run's own agent did. A card the agent
    // moved, released, or archived is reported on wherever it ended up — an agent that
    // bypassed its gate is an accountability record, and the state it left behind is its
    // own doing, not evidence about who the card belongs to. What the card can answer is
    // whose queue a request would land in: once another member holds the claim, the record
    // is still owed but the request is theirs to be spared — preventing an immediate
    // re-dispatch is what it was for, and their claim already does that.
    if (selfAction !== undefined) {
      const atEnd = core.getCard(id);
      const takenOver = atEnd.claim !== null && atEnd.claim.by !== member.id;
      return { kind: "stop", note: `run failed: the agent ${selfAction}`, raise: !takenOver };
    }
    if (input.lost() === undefined) return { kind: "held" };
    const atEnd = core.getCard(id);
    // Free, still here, and never away: nobody has taken the card over, so an explicit
    // release — the owner's exit ramp — is reported and the card waits. Anything else, a
    // claim by another member included, is an abandonment: one comment and nothing more.
    const free =
      atEnd.claim === null && atEnd.archivedAt === null && atEnd.phase === card.phase && !movedAway;
    if (free && releasedBy !== undefined) {
      return { kind: "stop", note: `run stopped: released by ${releasedBy}`, raise: true };
    }
    return { kind: "gone" };
  })();
  // The tool calls of the window that was still open land with a stop: what the agent did is
  // visible on the card, or it happened invisibly.
  if (ending.kind === "stop") {
    flushTools(true);
    stopWith(ending.note, ending.raise);
    return;
  }

  // The session is over. Nothing below is posted unless the claim is still this run's.
  input.stillHeld();
  flushTools();

  const fail = (text: string): void => {
    const note = cutBytes(text, COMMENT_MAX_BYTES / 4);
    core.comment(id, note, member.id);
    // A question the agent raised on the card during the run outranks a generic failure:
    // it is what the owner has to answer, so it stays; only the run's own request is replaced.
    raiseAttention(core, id, { to: ownerId, note }, member.id, isOwn);
    core.releaseCard(id, { reason: "failed" }, member.id);
  };
  const finish = (note: string, moves: Phase[]): void => {
    // The same rule as `fail()`, and it binds harder here: a question the agent raised
    // outranks the handoff, because approving over an unanswered question is exactly what
    // the owner must not be offered. The artefact landed, so it is said as a comment; the
    // question stays as the card's request, which keeps the card out of the ready set until
    // the owner answers it — and answering it makes the card ready again, so the phase runs
    // afresh rather than advancing on the agent's word.
    if (raiseAttention(core, id, { to: ownerId, note, moves }, member.id, isOwn) === undefined) {
      core.comment(
        id,
        `${note}; not handed on while the agent's question is open — answering it runs the phase again`,
        member.id,
      );
      core.releaseCard(id, { reason: "blocked" }, member.id);
      return;
    }
    core.releaseCard(id, { reason: "finished" }, member.id);
  };

  if (stopping) {
    fail("run aborted: daemon stopping");
    return;
  }
  if (timedOut) {
    fail(`run aborted: time limit of ${describeLimit(input.limitMs)} reached`);
    return;
  }
  if (driverError !== undefined) {
    fail(`run failed: ${driverError}`);
    return;
  }
  if (result === undefined) {
    fail("run failed: the agent ended without a result");
    return;
  }
  if (!result.ok) {
    fail(`run failed: ${result.error ?? "the agent reported an error"}`);
    return;
  }

  const detail = core.getCard(id);
  const since = detail.activity.filter((e) => e.seq > startSeq && e.actorId === member.id);
  if (card.phase === "spec") {
    const wrote = since.some((e) => e.type === "body_set");
    if (wrote && detail.body.trim().length > 0) finish("spec ready", ["code"]);
    else fail("run finished without a spec");
    return;
  }

  // Code: commits past the base, a clean worktree, and a `prUrl` this run recorded. The
  // value may be the one already on the card — a card sent back from PR is pushed to the
  // same branch and GitHub keeps the same pull request — so what has to be new is the
  // recording, not the URL. Without that, a run that did nothing passes on the commits and
  // the URL an earlier run earned, and the card is handed on as ready for review again.
  const recorded = since.some((e) => e.type === "refs_set" && e.data.refs.prUrl !== undefined);
  // Both ends of the range are the branches themselves, spelled in full: git resolves a bare
  // name by precedence, and `refs/tags/<name>` outranks `refs/heads/<name>`, so a repository
  // that tags a release with a branch's name would have the gate compare against the tag —
  // and a run that committed nothing would pass on the base branch's own commits. This is
  // how the base branch is looked up in the first place (`git.ts`'s `defaultBranch`) and how
  // the card's branch is checked for before it is created (`runner.ts`).
  const commits = await git.revList(
    input.repoRoot,
    `refs/heads/${base.name}..refs/heads/${branch}`,
    COMMITS_MAX_COUNT,
  );
  input.stillHeld();
  const changed = await git.status(path);
  input.stillHeld();
  const prUrl = core.getCard(id).refs.prUrl;
  const unmet: string[] = [];
  if (commits.length === 0) unmet.push(`no commits on ${branch} past ${base.name}`);
  if (changed.length > 0) unmet.push(`uncommitted changes in the worktree at ${path}`);
  if (prUrl === undefined || !recorded) unmet.push("no prUrl ref set during the run");
  if (unmet.length > 0) {
    fail(`run finished with ${unmet.join("; ")}`);
    return;
  }
  core.setRefs(id, { commits }, member.id);
  finish(`ready for review: ${prUrl}`, ["pr"]);
}

function describeLimit(ms: number): string {
  const minutes = ms / 60_000;
  if (Number.isInteger(minutes)) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const seconds = ms / 1000;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}
