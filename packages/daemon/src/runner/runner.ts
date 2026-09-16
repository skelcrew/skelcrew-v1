/**
 * The execution half. A client of the core like the socket is: it watches the activity
 * stream for cards becoming ready, claims up to `slots` of them as the `runner` member,
 * prepares a branch and a worktree for each, and runs the phase's playbook in it through a
 * driver (`run.ts`) — or, with no driver, hands the card to the owner as 006 did. Every step
 * lands on the card; nothing here reaches into the database or the target repository except
 * through `git` and the agent.
 *
 * **The agent it spawns is a member of its own, `crew`, and the claim stays the runner's.**
 * Everything the runner does as itself — the claim, the heartbeat, the branch it records, the
 * run-start comment, the permission question, the ending — is `runner`'s; everything the agent
 * does through the CLI is `crew`'s. That split is what makes the gates hold: the core already
 * refuses a non-human actor acting on another member's live claim, and the agent is now on the
 * other side of those refusals whatever process it calls from.
 *
 * **Jobs stay serial; runs do not.** The pump still performs one job at a time (006), but a
 * scan no longer *is* a run: it claims ready cards in id order until `slots` are held and
 * starts each run detached, so the next job — a teardown, a later scan — happens at once. Up
 * to `slots` cards therefore move together, each in its own worktree with its own agent,
 * claim, heartbeat, permission question, review budget, run log and endings; nothing in a run
 * reads runner-wide state another run writes, and the claim is what makes that safe, since a
 * card one run claimed is not ready for the next scan.
 *
 * **`SKELCREW_RUNS=1` is 006's dispatch, not the whole of 006.** One slot holds one claim at a
 * time, as it did — `slots` gates nothing else — but runs are detached at every slot count, so
 * the pump goes on while that one run is live: a teardown of another card lands during the run
 * rather than behind it, where 006's serial pump made it wait. What keeps that safe is the
 * mutex below, not the pump. Anyone setting it to 1 to get a strictly serial daemon back should
 * know that much of the change stays.
 *
 * Two things are shared and are handled here rather than in a run. **The repository is touched
 * by one card at a time**: a run's setup — resolving the base branch, creating the branch,
 * adding the worktree, reading the allowlist, opening the run log and posting the run-start
 * comment — and a teardown's removal both go through one mutex (`exclusive`), because git takes
 * the repository's lock for ref and worktree writes and two at once can fail on it. The
 * collision would be the runner's own doing, so it is serialised rather than retried, and it is
 * serialised at every slot count: under 006 the serial pump kept these apart for free, and with
 * runs outside the pump it no longer does. `reconcile` takes the same mutex and calls the inner
 * form of a teardown, since `exclusive` is not reentrant. The agent sessions, where the minutes
 * go, overlap freely outside all of it. And **teardown waits for the live run** before it takes
 * that mutex: a worktree is never removed under a live session, and a run being waited on needs
 * the mutex itself. A teardown whose card is back in a claimable phase returns before either
 * wait — its worktree is the next run's, and holding the pump for a run it will not touch would
 * stop every scan behind it.
 */
import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  type Activity,
  type Card,
  COMMENT_MAX_BYTES,
  type Member,
  PHASES,
  type Phase,
  worktreesDir,
} from "@skelcrew/shared";
import type { Core } from "../core/core";
import type { AgentDriver } from "./agent";
import { allowlistFor } from "./allowlist";
import type { ContractOutcome } from "./contracts";
import { endRun, postingCore, runAttention, runQuestion } from "./ending";
import type { Git, WorktreeEntry } from "./git";
import type { PlaybookKind, Playbooks } from "./playbooks";
import {
  ABORT_GRACE_MS_DEFAULT,
  createRunLog,
  RUN_LIMIT_MINUTES_DEFAULT,
  RunAbandoned,
  runPlaybook,
  TOOL_SUMMARY_MS,
} from "./run";
import { agentEnvironment, writeShim } from "./shim";
import { branchName } from "./slug";

export const RUNNER_MEMBER_NAME = "runner";
/**
 * The member a spawned agent speaks as, distinct from the runner so that the claim's holder
 * and the agent's identity are two members: with the claim held by `runner`, the core's own
 * refusals bite on every gate `crew` tries, whatever process is calling. Durable rather than
 * one member per run — runs are disposable, identity is durable — so the crew's history across
 * runs is attributable to one name.
 */
export const CREW_MEMBER_NAME = "crew";
/**
 * How many times a review may ask for changes before the card goes to the owner anyway.
 *
 * **The count is the runner's, held for the life of the claim.** It lives in `run(id)`'s own
 * frame, so nothing the agent writes can reach it: a count derived from the card's activity
 * would be read from events any member can record, and names are not credentials (016, 018).
 * Three is `/develop`'s number and the milestone's, and it is not configurable.
 *
 * A daemon restart releases the claim as `daemon restarted` and the next run begins a new loop
 * with a new budget. That is a recorded limit of 019 rather than a feature.
 */
export const REVIEW_ROUNDS_MAX = 3;
/**
 * How many cards the runner moves at once. Two, because two is a team and one is today: the
 * owner's queue fills from several cards rather than one. `SKELCREW_RUNS` overrides it.
 */
export const RUNS_DEFAULT = 2;
/** `SKELCREW_RUNS`, or the default; anything but a positive whole number is an error. */
export function runsFromEnv(env: Record<string, string | undefined>): number {
  const value = env.SKELCREW_RUNS;
  if (value === undefined || value === "") return RUNS_DEFAULT;
  const runs = Number(value);
  if (!Number.isInteger(runs) || runs <= 0) {
    throw new Error(`SKELCREW_RUNS must be a positive whole number of runs, not "${value}"`);
  }
  return runs;
}

/** The lease a run holds, and how often it is renewed while the run lasts. */
export const RUN_CLAIM_TTL_SECONDS = 120;
export const RUN_HEARTBEAT_MS = 30_000;
/** How many changed paths a "worktree kept" comment lists. */
export const KEPT_PATHS_MAX = 20;

export interface RunnerOptions {
  core: Core;
  dataDir: string;
  repoRoot: string;
  git: Git;
  /** The `runner` member every action of the runner's own is attributed to; joined at startup. */
  member: Member;
  /**
   * The `crew` member the spawned agent speaks as, and whose writes the phase's contract counts
   * as this run's. Joined at startup beside `member`, and never the holder of the claim.
   */
  crew: Member;
  /** Where what has no card to land on goes. Defaults to stderr. */
  warn?: (line: string) => void;
  /** The clock readiness reads a claim's expiry against; the core's, so the two agree. */
  now?: () => number;
  /**
   * What runs a phase in the worktree, and the playbooks it is given — one or neither, so a
   * driver can never arrive without them. Without it a run ends in 006's no-playbook handoff.
   */
  agent?: { driver: AgentDriver; playbooks: Playbooks };
  /** The environment the agent inherits from. Defaults to the daemon's own. */
  env?: Record<string, string | undefined>;
  /** How many cards run at once. Defaults to `RUNS_DEFAULT`; `SKELCREW_RUNS` is where it comes from. */
  slots?: number;
  /** A run's time limit. Defaults to 60 minutes. */
  runLimitMs?: number;
  /** How long an aborted agent gets to end before the run goes on without it. Defaults to 5 s. */
  abortGraceMs?: number;
  /** The window a run batches tool calls into one comment over. Defaults to 30 s. */
  summaryMs?: number;
  /** How often a live run renews its lease. Defaults to 30 s. */
  heartbeatMs?: number;
}

export interface Runner {
  /**
   * Takes no further card and tells every live run to stop (each ends as `daemon stopping` on
   * its own card); resolves once the job in flight and the last of those runs have finished.
   */
  stop(): Promise<void>;
}

type Job = { kind: "reconcile" } | { kind: "scan" } | { kind: "teardown"; cardId: number };

function claimable(phase: Phase): boolean {
  return PHASES.find((p) => p.id === phase)?.claimable ?? false;
}

/** Ready: claimable phase, not archived, no live claim, no open attention request. */
function isReady(card: Card, at: number): boolean {
  return (
    claimable(card.phase) &&
    card.archivedAt === null &&
    (card.claim === null || card.claim.expiresAt <= at) &&
    card.attention === null
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A worktree entry the runner can act on: registered, and its directory still a checkout. */
function usable(entry: WorktreeEntry | undefined): entry is WorktreeEntry {
  return entry !== undefined && !entry.prunable;
}

/** Git prints worktree paths resolved; ours is compared the same way when it exists. */
function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const ELLIPSIS = "…";

/** The comment cap is a byte cap; a git error or a path listing is cut well inside it, by bytes. */
function within(text: string): string {
  const limit = COMMENT_MAX_BYTES / 4;
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  const budget = limit - Buffer.byteLength(ELLIPSIS, "utf8");
  let bytes = 0;
  let cut = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > budget) break;
    bytes += size;
    cut += char.length;
  }
  return `${text.slice(0, cut)}${ELLIPSIS}`;
}

export function startRunner(options: RunnerOptions): Runner {
  const { dataDir, repoRoot, git, member, crew, agent } = options;
  /**
   * Everything the runner half writes to a card goes through this one core, which escapes what
   * it posts (`postingCore` in `./ending`): the runner's own comments here, every ending, and
   * the run's stream of excerpts, questions and summaries. Reads and refs are untouched.
   */
  const core = postingCore(options.core);
  const warn = options.warn ?? ((line: string) => console.error(line));
  const now = options.now ?? Date.now;
  const slots = options.slots ?? RUNS_DEFAULT;
  const runLimitMs = options.runLimitMs ?? RUN_LIMIT_MINUTES_DEFAULT * 60_000;
  const abortGraceMs = options.abortGraceMs ?? ABORT_GRACE_MS_DEFAULT;
  const summaryMs = options.summaryMs ?? TOOL_SUMMARY_MS;
  const heartbeatMs = options.heartbeatMs ?? RUN_HEARTBEAT_MS;
  const baseEnv = options.env ?? process.env;
  /** Fired by `stop()`: a live run is told to stop rather than waited out. */
  const stopping = new AbortController();
  /** The one helper every raise a run makes goes through; see `ending.ts`. */
  const attention = runAttention(core, member.id);
  const worktrees = worktreesDir(dataDir);
  mkdirSync(worktrees, { recursive: true });
  /**
   * Spelled the way the filesystem spells it, because a run's cwd and the file-tool rules
   * anchored at it have to agree: `resolveDataDir` absolutises `SKELCREW_DIR` lexically, so a
   * data directory reached through a link (`/tmp` and `/var` on macOS) otherwise leaves the two
   * spelled differently — where the harness maps one spelling to the other when it looks a
   * write up against an allow rule and does not when it looks the same write up against a deny
   * rule. See `anchor` in `./allowlist`. This is also the spelling git prints back.
   */
  const dir = realpath(worktrees);
  // The agent's `skelcrew`: written once, before any run could need it.
  if (agent !== undefined) writeShim(dataDir);

  const jobs: Job[] = [];
  let stopped = false;
  /** The last pump started: what `stop()` waits for. */
  let pumping: Promise<void> | undefined;
  /**
   * Whether a pump is live. `pump` clears it the moment it finds no job left rather than a turn
   * later, so a job enqueued in that turn starts a new pump instead of queueing behind one that
   * has already ended. With runs in the pump that turn never came; with runs detached from it,
   * the pump empties between two events all the time.
   */
  let draining = false;
  /** The runs in flight, by card: what a slot is, what a teardown waits for, what `stop` awaits. */
  const live = new Map<number, Promise<void>>();
  /**
   * The setup mutex. Whatever is handed here waits for everything handed here before it, so at
   * most one card is creating a branch or adding a worktree — the git calls that take the
   * repository's lock — however many runs are live. A step that throws frees it like any other.
   * A step that finds it free starts at once rather than a turn later, because the first job of
   * the runner's life goes through it and a `stop()` in that same turn must not overtake it.
   */
  let setupBusy = false;
  const setupWaiting: Array<() => void> = [];
  async function exclusive<T>(step: () => Promise<T>): Promise<T> {
    if (setupBusy) {
      await new Promise<void>((resolve) => {
        setupWaiting.push(resolve);
      });
    }
    setupBusy = true;
    try {
      return await step();
    } finally {
      // Handed straight on rather than released: a caller arriving while the next in line is
      // still being woken queues behind it instead of jumping it.
      const next = setupWaiting.shift();
      if (next === undefined) setupBusy = false;
      else next();
    }
  }

  function worktreePath(cardId: number): string {
    return join(dir, String(cardId));
  }

  function ownerId(): number {
    const owner = core.listMembers().find((m) => m.kind === "human");
    if (owner === undefined) throw new Error("no owner member");
    return owner.id;
  }

  function enqueue(job: Job): void {
    if (stopped) return;
    const duplicate = jobs.some(
      (queued) =>
        queued.kind === job.kind &&
        (queued.kind !== "teardown" || job.kind !== "teardown" || queued.cardId === job.cardId),
    );
    if (!duplicate) jobs.push(job);
    if (draining) return;
    draining = true;
    pumping = pump();
  }

  /** One job at a time; a job that throws is reported and the next one still runs. */
  async function pump(): Promise<void> {
    try {
      while (!stopped) {
        const job = jobs.shift();
        if (job === undefined) return;
        try {
          await perform(job);
        } catch (error) {
          warn(`skelcrew runner: ${job.kind} failed: ${message(error)}`);
        }
      }
    } finally {
      draining = false;
    }
  }

  async function perform(job: Job): Promise<void> {
    switch (job.kind) {
      case "reconcile":
        await reconcile();
        break;
      case "scan":
        scan();
        break;
      case "teardown":
        await teardown(job.cardId);
        break;
    }
  }

  // --- a run, with no playbook ---

  /**
   * Claims ready cards in id order until the slots are full, and starts each run detached: the
   * scan is a job, a run is not, so the pump goes on to its next job at once. A card claimed
   * here is not ready for the next scan, which is what keeps one card to one run.
   */
  function scan(): void {
    const ids = core
      .listCards()
      .filter((card) => isReady(card, now()))
      .map((card) => card.id);
    for (const id of ids) {
      if (stopped || live.size >= slots) return;
      // A card whose run is still live is never taken again, whatever its claim now says: a
      // claim that lapsed or was swept under a working run reads as ready here, and a second
      // run would then be *this* member's too — so the first would find the claim its own and
      // end on a card that is no longer its own. Names are not credentials (016), least of
      // all our own name. The slot such a run frees is filled when it settles, below.
      if (live.has(id)) continue;
      begin(id);
    }
  }

  function begin(id: number): void {
    const running = run(id)
      .catch((error) => {
        warn(`skelcrew runner: card ${id}: run failed: ${message(error)}`);
      })
      .finally(() => {
        live.delete(id);
        // The slot is free only now — the `released` event that ends a run fires from inside
        // it, while the run still holds its slot — so the scan that fills it is queued here.
        // Unless the card still carries a claim of ours: that is a lease that lapsed under a
        // run, which the sweep reports as `run_interrupted`, and scanning over it here would
        // start a second run of the same card a moment after the first gave up on it.
        if (find(id)?.claim?.by !== member.id) enqueue({ kind: "scan" });
      });
    live.set(id, running);
  }

  async function run(id: number): Promise<void> {
    const card = core.getCard(id);
    if (!isReady(card, now())) return;
    try {
      core.claimCard(id, { ttlSeconds: RUN_CLAIM_TTL_SECONDS }, member.id);
    } catch (error) {
      // Someone else took it between the check and the claim; theirs now.
      warn(`skelcrew runner: card ${id} not claimed: ${message(error)}`);
      return;
    }
    const heartbeat = setInterval(() => {
      try {
        core.heartbeat(id, member.id);
      } catch (error) {
        warn(`skelcrew runner: heartbeat on card ${id} failed: ${message(error)}`);
      }
    }, heartbeatMs);
    const path = worktreePath(id);
    const branch = branchName(id, card.title);
    /**
     * Every await is a window in which the owner may move, archive, or release the card,
     * another member may claim it, or the lease may lapse. Nothing is posted after such a
     * window — success or failure — without the claim still being this run's, live: a
     * card that moved on is not written to.
     */
    const lost = (): string | undefined => {
      const current = core.getCard(id);
      if (current.claim?.by === member.id) {
        return current.claim.expiresAt > now()
          ? undefined
          : `claim lapsed; card is in ${current.phase}`;
      }
      if (current.archivedAt !== null) return "card archived";
      const holder = current.claim === null ? "" : ` to member ${current.claim.by}`;
      return `claim lost${holder}; card is in ${current.phase}`;
    };
    const stillHeld = (): void => {
      const reason = lost();
      if (reason !== undefined) throw new RunAbandoned(reason);
    };
    const abandon = (reason: string): void => {
      // The claim is already gone, so there is nothing to release; a teardown queued by
      // the move or archive handles whatever worktree exists.
      try {
        core.comment(id, `run abandoned: ${reason}`, member.id);
      } catch (inner) {
        warn(`skelcrew runner: card ${id}: run abandoned; and could not say so: ${message(inner)}`);
      }
    };
    /**
     * The live run's own permission question, so that the run and every ending share one
     * value: the run records what it asked, and an ending — `run.ts`'s or the failed step
     * below — replaces that request and leaves any other standing (`ending.ts`). One per run
     * in the loop, not one per claim: the ending that matters is the ending of the run that
     * asked, and a round that is over answers nothing.
     */
    let question = runQuestion();
    /** The live run's log, for the same reason: an ending names the log of its own run. */
    let logPath: string | undefined;
    /** The loop's own endings, through the one place an ending is decided (`ending.ts`). */
    const end = (note: string, moves: Phase[], reason: string): void => {
      endRun({
        core,
        attention,
        cardId: id,
        memberId: member.id,
        ownerId,
        warn,
        note: within(note),
        moves,
        reason,
        question,
        logPath,
      });
    };
    let step = "resolve base branch";
    try {
      /**
       * The branch and the worktree, one card at a time: these are the calls that take the
       * repository's lock, so however many runs are live, only one is here. `branchHead` is
       * where the branch stood before the agent started — the Code contract compares its own
       * end against this: commits past the base are not this run's work unless the branch
       * moved, since a revision run that records the pull request and commits nothing would
       * otherwise hand the card on using the previous run's. A branch this run creates starts
       * at the base, so a run that commits nothing leaves it there and fails the same way.
       */
      const { base, branchHead } = await exclusive(async () => {
        const resolved = await git.defaultBranch(repoRoot);
        stillHeld();
        step = "create branch";
        let head = await git.revParse(repoRoot, `refs/heads/${branch}`);
        if (head === undefined) {
          await git.createBranch(repoRoot, branch, resolved.sha);
          head = resolved.sha;
        }
        stillHeld();
        step = "add worktree";
        await ensureWorktree(path, branch);
        return { base: resolved, branchHead: head };
      });
      stillHeld();
      step = "update card";
      core.setRefs(id, { branch }, member.id);
      // Narrowed here, not in the run: a phase with a playbook is a phase with a contract,
      // and a new claimable phase without either does not compile into a run.
      const phase = card.phase === "spec" || card.phase === "code" ? card.phase : undefined;
      const playbook =
        agent !== undefined && phase !== undefined ? agent.playbooks[phase] : undefined;
      if (agent === undefined || playbook === undefined || phase === undefined) {
        // 006's handoff, kept verbatim: nothing has run in the worktree, so this is not the
        // ending of a run and does not go through `ending.ts`. Every ending does.
        core.comment(id, `worktree ready at ${path} on ${branch} (from ${base.name})`, member.id);
        core.requestAttention(
          id,
          { to: ownerId(), note: `no playbook for ${card.phase} yet; work in ${path}` },
          member.id,
        );
        core.releaseCard(id, { reason: "no playbook" }, member.id);
        return;
      }
      /**
       * One run of the loop, with everything that is a *run's* rather than the claim's: the
       * list its kind gets, a log of its own, its own permission question, the sequence number
       * its record starts at, and the branch head "moved during this run" is read against.
       * Answers the contract's outcome when it was met, and nothing when the run ended on the
       * card — `run.ts` settles every other ending, so the loop stops when it sees one.
       */
      const runOnce = async (
        kind: PlaybookKind,
        opening: (log: string, scanned: string) => string,
      ): Promise<ContractOutcome | undefined> => {
        // The previous round's log is not this run's: a step below that throws before this run
        // opens one would otherwise park the card pointing at a file holding none of this.
        logPath = undefined;
        step = `read the ${kind} allowlist`;
        // The rest of this run's setup, one card at a time like the branch and the worktree
        // above: the session below is what overlaps with other runs, not this.
        const prepared = await exclusive(async () => {
          // Read from the remote-tracking head of the default branch — a ref no *tool call* on
          // the fixed list can write — so an instruction file a run writes, commits, or points a
          // branch at grants nothing to it or to the next run. The file tools are anchored at
          // this worktree, which is what puts that ref beyond them. A subprocess is not a tool
          // call and is not bound by any of it, and neither is a command the target repository's
          // own instructions pre-allow for it; see *What a subprocess reaches* and
          // `narrowedCommands` in `./allowlist`. What keeps the base commit meaningful is that
          // the owner merged it.
          const allowlist = await allowlistFor(git, repoRoot, base.name, path, kind);
          stillHeld();
          step = `read the ${kind} branch head`;
          // Re-read per run: the previous run's commits are where this one starts, so "the
          // branch moved during this run" is about this round and not about the claim.
          const head = (await git.revParse(repoRoot, `refs/heads/${branch}`)) ?? branchHead;
          stillHeld();
          step = `open the ${kind} run log`;
          const log = createRunLog(dataDir, id, now());
          logPath = log;
          core.comment(id, opening(log, allowlist.scanned), member.id);
          // Where this run's own record starts: everything past its opening comment is what
          // happened during it — the contracts' "recorded by this run", and the ending's reason.
          const sinceSeq = core.getCard(id).activity.at(-1)?.seq ?? 0;
          question = runQuestion();
          return { allowlist, head, log, sinceSeq };
        });
        step = `run the ${kind} playbook`;
        return await runPlaybook({
          core,
          member,
          crew,
          attention,
          ownerId,
          warn,
          // The card as it is *now*, not as it was when the claim was taken: the loop holds one
          // claim across several runs, and `setBody` is the owner's to call throughout — so a
          // fix run's brief is what the owner left on the card, not what the first run read.
          card: core.getCard(id),
          phase,
          kind,
          sinceSeq: prepared.sinceSeq,
          now,
          git,
          repoRoot,
          path,
          branch,
          branchHead: prepared.head,
          base: base.name,
          driver: agent.driver,
          playbook: agent.playbooks[kind],
          env: agentEnvironment(baseEnv, dataDir, crew.name),
          allowedTools: prepared.allowlist.tools,
          deniedTools: prepared.allowlist.denied,
          question,
          logPath: prepared.log,
          limitMs: runLimitMs,
          graceMs: abortGraceMs,
          summaryMs,
          stop: stopping.signal,
          stillHeld,
          lost,
        });
      };

      const first = await runOnce(
        phase,
        (log, scanned) =>
          `worktree ready at ${path} on ${branch} (from ${base.name}); ${scanned}; run log at ${log}`,
      );
      if (first === undefined) return;
      // A Spec run's met contract is the end of its phase: reviewing specs is out of scope.
      if (phase !== "code") {
        end(first.note, first.moves, "finished");
        return;
      }
      /**
       * The review loop. **The count is the runner's, held for the life of this claim**, and
       * nothing the agent does can reach it: it is a number in this frame rather than
       * something read back off the card, where a verdict recorded by anyone — names are not
       * credentials — would be counted. A daemon restart releases the claim as
       * `daemon restarted` (`reconcile`) and the next run begins a new loop with a new budget;
       * that is a recorded limit of this spec, not a feature.
       */
      let met = first;
      /**
       * **The next run starts only when nothing is waiting on the owner.** A request the run
       * that just ended may not replace — an agent's own `skelcrew attention` question, from
       * either kind of run — is answered before anything else makes sense, and the next run
       * could raise no permission question of its own under it (`raiseNext` refuses over a
       * foreign request) and would block until its time limit. So the loop ends here with 014's
       * ending for a met artefact under a standing question: no move, the question standing,
       * released blocked — which is what `endRun` makes of this call, because the raise it tries
       * is refused for the same reason.
       *
       * The note is the caller's, because what the card's last word should be depends on where
       * the loop stopped: before a review the Code run's own note says the artefact landed
       * (014), while before a fix run the reviewer has just said the work is *not* ready, so
       * repeating `ready for review` there would have the card's last comment contradict the
       * verdict above it.
       *
       * What this reads is any open request that is not the run's *own* permission question.
       * That one is excluded on purpose: an ending replaces it (013), so a met contract under it
       * hands the card on with the offer, and widening this would let a run that triggered a
       * permission question and then finished skip the review. Whether the harness can end a
       * session with an ask still outstanding is unverified.
       *
       * Answers whether the loop ended here.
       */
      const endedUnderAStandingQuestion = (note: string, moves: Phase[]): boolean => {
        const standing = core.getCard(id).attention;
        if (standing === null || question.isOpen(standing)) return false;
        end(note, moves, "finished");
        return true;
      };
      for (let round = 1; round <= REVIEW_ROUNDS_MAX; round += 1) {
        stillHeld();
        // Before a review: the Code run that just met its contract may have asked something,
        // and its own note is what 014 has the card say — the artefact landed.
        if (endedUnderAStandingQuestion(met.note, met.moves)) return;
        const reviewed = await runOnce(
          "review",
          (log) => `review round ${round} of ${REVIEW_ROUNDS_MAX} starting; run log at ${log}`,
        );
        if (reviewed === undefined) return;
        if (reviewed.verdict === "approved") {
          // 014's criterion 4, now behind a review: the artefact the Code run produced, with
          // the move into PR offered to the owner.
          end(met.note, met.moves, "finished");
          return;
        }
        if (round === REVIEW_ROUNDS_MAX) {
          // The owner decides: approve into PR as it stands, or comment and resolve, which
          // makes the card ready and starts a fresh run with a fresh budget.
          end(
            `review budget spent: changes requested ${REVIEW_ROUNDS_MAX} times; the last review names what is open; the work is in ${path}`,
            ["pr"],
            "finished",
          );
          return;
        }
        stillHeld();
        // And before a fix run: a review run that raised its own question and recorded
        // `changes_requested` — both of which its playbook instructs — ends the loop here,
        // saying what the card is waiting on rather than repeating the Code run's note.
        if (
          endedUnderAStandingQuestion(
            `changes requested; the reviewer is waiting on an answer; the work is in ${path}`,
            [],
          )
        ) {
          return;
        }
        // The fix run's brief is the card: the findings are on it as the last verdict. The
        // Code contract applies to it unchanged, so a fix run that commits nothing fails the
        // way any Code run does and the loop ends there.
        const fixed = await runOnce("code", (log) => `fix run starting; run log at ${log}`);
        if (fixed === undefined) return;
        met = fixed;
      }
    } catch (error) {
      if (error instanceof RunAbandoned) {
        abandon(error.message);
        return;
      }
      // A failure inside git after the claim went away is not this run's to report either.
      const gone = lost();
      if (gone !== undefined) {
        abandon(gone);
        return;
      }
      // A throw out of a run that had already escalated ends the card here rather than in
      // `run.ts`, so this ending goes through the same one in `ending.ts`.
      end(`${step} failed: ${message(error)}`, [], "failed");
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function registered(path: string): Promise<WorktreeEntry | undefined> {
    const entries = await git.worktreeList(repoRoot);
    const wanted = realpath(path);
    return entries.find((entry) => realpath(entry.path) === wanted);
  }

  /** The card's worktree at `path`, on `branch`: reused when it is already that, else added. */
  async function ensureWorktree(path: string, branch: string): Promise<void> {
    const entry = await registered(path);
    if (existsSync(path)) {
      // A prunable entry means the directory is there but its `.git` file is not: not a
      // worktree any more, and not something to add over.
      if (!usable(entry)) throw new Error(`${path} exists and is not a git worktree`);
      if (entry.branch !== `refs/heads/${branch}`) {
        throw new Error(
          `${path} is a worktree on ${entry.branch ?? "a detached HEAD"}, not ${branch}`,
        );
      }
      return;
    }
    // Registered but gone: git refuses to add over it until the entry is forgotten.
    if (entry !== undefined) await git.worktreePrune(repoRoot);
    await git.worktreeAdd(repoRoot, path, branch);
  }

  // --- teardown ---

  /**
   * Removes the worktree at `path` when it is clean; keeps it, saying which paths changed,
   * when it is not. A dirty worktree is never removed. `report` is where the outcome goes:
   * a comment on the card, or stderr when there is no card.
   */
  async function teardownPath(path: string, report: (text: string) => void): Promise<void> {
    if (!existsSync(path)) return;
    const entry = await registered(path);
    if (!usable(entry)) {
      report(`worktree kept at ${path}: not a git worktree of this repository`);
      return;
    }
    const changed = await git.status(path);
    if (changed.length > 0) {
      const listed = changed.slice(0, KEPT_PATHS_MAX).map((p) => `  ${p}`);
      const more =
        changed.length > KEPT_PATHS_MAX ? [`  … and ${changed.length - KEPT_PATHS_MAX} more`] : [];
      report(
        within([`worktree kept at ${path}: uncommitted changes`, ...listed, ...more].join("\n")),
      );
      return;
    }
    await git.worktreeRemove(repoRoot, path);
    report("worktree removed");
  }

  /**
   * The card is back in a claimable phase and not archived, so its worktree is the next run's
   * rather than something to remove: it was moved on and back while the pump was busy.
   */
  function reusable(cardId: number): boolean {
    const card = find(cardId);
    return card !== undefined && card.archivedAt === null && claimable(card.phase);
  }

  async function teardown(cardId: number): Promise<void> {
    // Read before the wait as well as after it. A scan ahead of this job may already have
    // started a fresh run of the card that came back, and waiting for *that* run — a run this
    // teardown will not touch — would hold the pump, and with it every scan, for as long as it
    // lasts. The pump is serial and a run is not: the two are no longer the same wait.
    if (reusable(cardId)) return;
    // A worktree is never removed under a live session: the run that holds it ends first —
    // as an abandonment, when the move that queued this teardown took its claim. The serial
    // pump gave that ordering for free until runs left it; now it is said here. Waited for
    // before the mutex is taken and never while holding it, since that run needs the mutex
    // itself to finish its own setup.
    await live.get(cardId);
    // The wait is a window like any other: the owner may have moved the card back during it.
    if (reusable(cardId)) return;
    // Under the same mutex as a run's setup: `worktreeRemove` takes the repository's lock that
    // `worktreeAdd` takes, and the pump — which used to keep every teardown and every run's git
    // apart by being serial — no longer runs the runs.
    await exclusive(() => teardownCard(cardId));
  }

  /** The card's worktree, removed or kept, with the outcome on the card. Holds no mutex. */
  async function teardownCard(cardId: number): Promise<void> {
    const path = worktreePath(cardId);
    try {
      await teardownPath(path, (text) => core.comment(cardId, text, member.id));
    } catch (error) {
      const text = within(`teardown failed: ${message(error)}`);
      try {
        core.comment(cardId, text, member.id);
      } catch (inner) {
        warn(`skelcrew runner: card ${cardId}: ${text}; and could not say so: ${message(inner)}`);
      }
    }
  }

  // --- startup ---

  /**
   * Under the setup mutex, so a startup prune or removal cannot cross a first run's
   * `worktreeAdd`. It is still the pump's first job, before any scan, as it was in 006.
   */
  function reconcile(): Promise<void> {
    return exclusive(reconcileAll);
  }

  async function reconcileAll(): Promise<void> {
    // A claim by this member that survived a restart belongs to a run that no longer exists.
    for (const card of core.listCards()) {
      if (card.claim === null || card.claim.by !== member.id) continue;
      try {
        core.releaseCard(card.id, { reason: "daemon restarted" }, member.id);
      } catch (error) {
        warn(`skelcrew runner: card ${card.id} not released: ${message(error)}`);
      }
    }
    for (const name of readdirSync(dir).sort()) {
      if (stopped) return;
      const path = join(dir, name);
      // Only the name a card id is written as: `01`, `1e0`, and ` 1` are not card 1's entry.
      const id = /^\d+$/.test(name) && String(Number(name)) === name ? Number(name) : undefined;
      const card = id === undefined ? undefined : find(id);
      if (card === undefined) {
        // No card to comment on: the outcome goes to stderr.
        try {
          await teardownPath(path, (text) => warn(`skelcrew runner: ${path}: ${text}`));
        } catch (error) {
          warn(`skelcrew runner: ${path}: teardown failed: ${message(error)}`);
        }
        continue;
      }
      if (card.archivedAt !== null || !claimable(card.phase)) {
        // The inner form: this is `teardown`'s own two conditions, and the mutex it would take
        // is already held here — `exclusive` is not reentrant. Nothing is live to wait for
        // either: reconcile is the pump's first job and no run has been started.
        await teardownCard(card.id);
        continue;
      }
      // Claimable: the next run reuses it, unless it is not a worktree at all.
      try {
        if (!usable(await registered(path))) {
          core.comment(
            card.id,
            `worktree at ${path} is not a git worktree of this repository; left alone`,
            member.id,
          );
        }
      } catch (error) {
        warn(`skelcrew runner: ${path}: ${message(error)}`);
      }
    }
  }

  function find(id: number): Card | undefined {
    try {
      return core.getCard(id);
    } catch {
      return undefined;
    }
  }

  // --- the watch ---

  function onEvent(event: Activity): void {
    if (event.cardId === null) return;
    switch (event.type) {
      case "card_moved":
        if (claimable(event.data.to)) enqueue({ kind: "scan" });
        else enqueue({ kind: "teardown", cardId: event.cardId });
        break;
      case "card_archived":
        enqueue({ kind: "teardown", cardId: event.cardId });
        break;
      case "released":
      case "run_interrupted":
      case "attention_resolved":
        enqueue({ kind: "scan" });
        break;
      default:
        break;
    }
  }

  const unsubscribe = core.subscribe(onEvent);
  enqueue({ kind: "reconcile" });
  enqueue({ kind: "scan" });

  return {
    async stop() {
      stopped = true;
      unsubscribe();
      jobs.length = 0;
      // One signal every live run listens to: each ends as `daemon stopping` on its own card
      // and releases its own claim, and this resolves after the last of them.
      stopping.abort();
      await pumping;
      await Promise.all(live.values());
    },
  };
}
