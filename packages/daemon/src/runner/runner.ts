/**
 * The execution half, without a coding agent in it yet. A client of the core like the
 * socket is: it watches the activity stream for cards becoming ready, claims one at a time
 * as the `runner` member, prepares a branch and a worktree, and — having no playbook to
 * run — hands the card to the owner. Every step lands on the card; nothing here reaches
 * into the database or the target repository except through `git`.
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
import type { Git, WorktreeEntry } from "./git";
import { branchName } from "./slug";

export const RUNNER_MEMBER_NAME = "runner";
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
  /** The `runner` member every action is attributed to; joined by the daemon at startup. */
  member: Member;
  /** Where what has no card to land on goes. Defaults to stderr. */
  warn?: (line: string) => void;
  /** The clock readiness reads a claim's expiry against; the core's, so the two agree. */
  now?: () => number;
}

export interface Runner {
  /** Takes no further card; resolves once the job in flight has finished. */
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

/** The run's claim went away while it was inside git: the card is someone else's now. */
class RunAbandoned extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RunAbandoned";
  }
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
  const { core, dataDir, repoRoot, git, member } = options;
  const warn = options.warn ?? ((line: string) => console.error(line));
  const now = options.now ?? Date.now;
  const dir = worktreesDir(dataDir);
  mkdirSync(dir, { recursive: true });

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
    }, RUN_HEARTBEAT_MS);
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
    let step = "resolve base branch";
    try {
      const base = await git.defaultBranch(repoRoot);
      stillHeld();
      step = "create branch";
      if ((await git.revParse(repoRoot, `refs/heads/${branch}`)) === undefined) {
        await git.createBranch(repoRoot, branch, base.sha);
      }
      stillHeld();
      step = "add worktree";
      await ensureWorktree(path, branch);
      stillHeld();
      step = "update card";
      core.setRefs(id, { branch }, member.id);
      core.comment(id, `worktree ready at ${path} on ${branch} (from ${base.name})`, member.id);
      core.requestAttention(
        id,
        { to: ownerId(), note: `no playbook for ${card.phase} yet; work in ${path}` },
        member.id,
      );
      core.releaseCard(id, { reason: "no playbook" }, member.id);
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
      const text = within(`${step} failed: ${message(error)}`);
      try {
        core.comment(id, text, member.id);
        core.requestAttention(id, { to: ownerId(), note: text }, member.id);
      } catch (inner) {
        warn(`skelcrew runner: card ${id}: ${text}; and could not say so: ${message(inner)}`);
      }
      try {
        core.releaseCard(id, { reason: "failed" }, member.id);
      } catch (inner) {
        warn(`skelcrew runner: card ${id} not released: ${message(inner)}`);
      }
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
      await pumping;
    },
  };
}
