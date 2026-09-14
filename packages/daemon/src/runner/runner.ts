/**
 * The execution half. A client of the core like the socket is: it watches the activity
 * stream for cards becoming ready, claims one at a time as the `runner` member, prepares a
 * branch and a worktree, and runs the phase's playbook in it through a driver (`run.ts`) —
 * or, with no driver, hands the card to the owner as 006 did. Every step lands on the card;
 * nothing here reaches into the database or the target repository except through `git` and
 * the agent.
 *
 * **The agent it spawns is a member of its own, `crew`, and the claim stays the runner's.**
 * Everything the runner does as itself — the claim, the heartbeat, the branch it records, the
 * run-start comment, the permission question, the ending — is `runner`'s; everything the agent
 * does through the CLI is `crew`'s. That split is what makes the gates hold: the core already
 * refuses a non-human actor acting on another member's live claim, and the agent is now on the
 * other side of those refusals whatever process it calls from.
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
   * Takes no further card and tells a live run to stop (it ends as `daemon stopping`);
   * resolves once the job in flight has finished.
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
  let pumping: Promise<void> | undefined;

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
    pumping ??= pump().finally(() => {
      pumping = undefined;
    });
  }

  /** One job at a time; a job that throws is reported and the next one still runs. */
  async function pump(): Promise<void> {
    while (!stopped) {
      const job = jobs.shift();
      if (job === undefined) return;
      try {
        await perform(job);
      } catch (error) {
        warn(`skelcrew runner: ${job.kind} failed: ${message(error)}`);
      }
    }
  }

  async function perform(job: Job): Promise<void> {
    switch (job.kind) {
      case "reconcile":
        await reconcile();
        break;
      case "scan":
        await scan();
        break;
      case "teardown":
        await teardown(job.cardId);
        break;
    }
  }

  // --- a run, with no playbook ---

  async function scan(): Promise<void> {
    const ids = core
      .listCards()
      .filter((card) => isReady(card, now()))
      .map((card) => card.id);
    for (const id of ids) {
      if (stopped) return;
      await run(id);
    }
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
      const base = await git.defaultBranch(repoRoot);
      stillHeld();
      step = "create branch";
      /**
       * Where the branch stood before the agent started. The Code contract compares its own
       * end against this: commits past the base are not this run's work unless the branch
       * moved, since a revision run that records the pull request and commits nothing would
       * otherwise hand the card on using the previous run's. A branch this run creates starts
       * at the base, so a run that commits nothing leaves it there and fails the same way.
       */
      let branchHead = await git.revParse(repoRoot, `refs/heads/${branch}`);
      if (branchHead === undefined) {
        await git.createBranch(repoRoot, branch, base.sha);
        branchHead = base.sha;
      }
      stillHeld();
      step = "add worktree";
      await ensureWorktree(path, branch);
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
        logPath = createRunLog(dataDir, id, now());
        core.comment(id, opening(logPath, allowlist.scanned), member.id);
        // Where this run's own record starts: everything past its opening comment is what
        // happened during it — the contracts' "recorded by this run", and the ending's reason.
        const sinceSeq = core.getCard(id).activity.at(-1)?.seq ?? 0;
        question = runQuestion();
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
          sinceSeq,
          now,
          git,
          repoRoot,
          path,
          branch,
          branchHead: head,
          base: base.name,
          driver: agent.driver,
          playbook: agent.playbooks[kind],
          env: agentEnvironment(baseEnv, dataDir, crew.name),
          allowedTools: allowlist.tools,
          deniedTools: allowlist.denied,
          question,
          logPath,
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
       * ending for a met artefact under a standing question: the artefact named, no move, the
       * question standing, released blocked — which is what `endRun` makes of this call, because
       * the raise it tries is refused for the same reason.
       *
       * What this reads is any open request that is not the run's *own* permission question.
       * That one is excluded on purpose: an ending replaces it (013), so a met contract under it
       * hands the card on with the offer, and widening this would let a run that triggered a
       * permission question and then finished skip the review. Whether the harness can end a
       * session with an ask still outstanding is unverified.
       *
       * Answers whether the loop ended here.
       */
      const endedUnderAStandingQuestion = (): boolean => {
        const standing = core.getCard(id).attention;
        if (standing === null || question.isOpen(standing)) return false;
        end(met.note, met.moves, "finished");
        return true;
      };
      for (let round = 1; round <= REVIEW_ROUNDS_MAX; round += 1) {
        stillHeld();
        // Before a review: the Code run that just met its contract may have asked something.
        if (endedUnderAStandingQuestion()) return;
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
        // `changes_requested` — both of which its playbook instructs — ends the loop here.
        if (endedUnderAStandingQuestion()) return;
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

  async function teardown(cardId: number): Promise<void> {
    // Queued by a move or an archive, run later: by now the card may be back in a
    // claimable phase (moved on and back while the pump was busy), and its worktree is
    // then the next run's, not something to remove.
    const card = find(cardId);
    if (card !== undefined && card.archivedAt === null && claimable(card.phase)) return;
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

  async function reconcile(): Promise<void> {
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
        await teardown(card.id);
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
      stopping.abort();
      await pumping;
    },
  };
}
