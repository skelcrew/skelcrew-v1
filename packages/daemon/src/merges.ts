/**
 * The merge poll: the last arc of Idea → Spec → Code → PR → Done, turned by the owner's own
 * merge on the forge. One tick asks the forge about the pull request of every unarchived card
 * in PR that carries one, and a merge of *that card's work* lands the card in Done.
 *
 * In `sweep.ts`'s shape — a timer the daemon owns, not a member action — with four differences
 * the spec names, and this is where all four are recorded.
 *
 * **1. The move into Done is made as the owner.** `core.moveCard(id, "done", ownerId())` below
 * is the one place in skelcrew where the daemon records a member's *decision* without that
 * member typing it. (Not the only place it writes an event naming a member: the claim sweep
 * records `run_interrupted` attributed to the lapsed claim's holder — but a lapse is something
 * that happened to that member, not something they chose.) It is not an exemption: since 016
 * every phase's exit is the owner's, and the core refuses `runner` and `crew` alike — that
 * refusal standing is exactly what makes acting as the owner the only way this move can happen,
 * and it is confined by construction to this one call site and this one transition.
 *
 * The attribution is honest because of what precedes it: the comment on the line above says
 * `pull request <url> merged at <time>`, by `runner`, so a reader of the feed sees the runner
 * report the merge and then the owner's decision follow from it. "Done is a human's call, the
 * way merging is" (`CLAUDE.md`) — and the merge *was* the call; Done is its record. The card
 * never reaches Done without a merge the forge confirms, of a pull request in this repository
 * whose head is the branch a run recorded for this card, so nothing here is a gate the daemon
 * can walk past on its own.
 *
 * **This is a precedent, and a later spec that wants the daemon to act as the owner elsewhere
 * must argue against this paragraph.** What it has to establish is what is established here: a
 * gesture the owner has already made, somewhere the daemon can verify it; one transition, one
 * call site; and a record of the cause on the card immediately before the action. Convenience
 * is not one of those things.
 *
 * **2. The branch compared is the one the runner recorded, not `refs.branch`.** `setRefs` has no
 * actor restriction, so `crew` writes `branch` as well as `prUrl`: comparing the forge's head
 * branch against `refs.branch` would compare two fields one member controls, and review round 1
 * walked a card into Done with two `crew` writes through the real CLI. `recordedBranch` reads the
 * last `refs_set` on the card whose actor is `runner` and whose `set` names `branch` — the write
 * the runner makes at run start, which `crew` cannot forge because it cannot act as `runner`. A
 * card no run has recorded a branch on is a mismatch. What this binds, without overclaiming: a
 * wrong, stale or copied `prUrl`, and `crew` acting as `crew`. What it does not bind is a caller
 * asserting another identity over the socket — that caller is the owner and can `skelcrew mv <id>
 * done` outright, which is 016's recorded limit.
 *
 * **3. The tick acts on the card as it is now, not as it listed it.** Each card costs a `gh`
 * round-trip, and the owner can move a card back to Code inside that window — with a run
 * claiming it. So every write below is preceded by a re-read: still in PR, still unarchived,
 * still carrying the `prUrl` the forge answered about, or the tick does nothing and says nothing.
 *
 * **4. What must not repeat is derived from the card, not remembered here.** A mismatch, a
 * closed-without-merge and a merge are each posted only when the card does not already carry
 * that exact comment by the runner since it last entered PR, so a tick every minute does not
 * fill the feed, and a card the owner sends back and approves again is told afresh. The only
 * state this module keeps between ticks is whether it has already said that `gh` could not
 * answer — one flag per cause, not about any card, which the spec asks to be said once per
 * process.
 */
import type { Card, CardDetail } from "@skelcrew/shared";
import type { Core } from "./core/core";
import { postingCore, runAttention, runQuestion } from "./runner/ending";
import type { Forge, PullRequest } from "./runner/forge";

/** How often the daemon asks the forge about the pull requests of the cards in PR. */
export const MERGE_POLL_INTERVAL_MS = 60_000;

/**
 * The poll interval, overridden by `SKELCREW_MERGE_POLL_SECONDS` the way `SKELCREW_RUN_MINUTES`
 * overrides the run limit: a value that is not a positive number of seconds stops the daemon
 * rather than falling back to the default.
 */
export function mergePollIntervalFromEnv(env: Record<string, string | undefined>): number {
  const value = env.SKELCREW_MERGE_POLL_SECONDS;
  if (value === undefined || value === "") return MERGE_POLL_INTERVAL_MS;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(
      `SKELCREW_MERGE_POLL_SECONDS must be a positive number of seconds, not "${value}"`,
    );
  }
  return seconds * 1000;
}

export interface MergePollOptions {
  core: Core;
  forge: Forge;
  /** The repository `gh` runs in, and the one a pull request must belong to. */
  repoRoot: string;
  /** The `runner` member every comment and request the poll writes is attributed to. */
  runnerId: number;
  /** Where what has no card to land on goes; the daemon's stderr, as the sweep's does. */
  warn: (line: string) => void;
}

export interface MergePoll {
  /** One tick. Never throws: a timer callback that did would take the daemon down. */
  tick(): Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Asked about: in PR, not archived, and carrying a pull request. Nothing else is polled. */
function watched(card: Card): boolean {
  return card.phase === "pr" && card.archivedAt === null && card.refs.prUrl !== undefined;
}

/** The sequence number at which the card last entered PR, or 0 when it never did. */
function enteredPr(card: CardDetail): number {
  const move = card.activity.findLast((e) => e.type === "card_moved" && e.data.to === "pr");
  return move?.seq ?? 0;
}

/**
 * The branch a run recorded for this card: the last `refs_set` by the `runner` member that
 * named `branch`. Not `refs.branch`, which `crew` can rewrite — see this module's doc, point 2.
 * `set` absent (an event from before 011, which recorded only the merged result) is "unknown",
 * never "branch", so such an event does not answer this.
 */
function recordedBranch(card: CardDetail, runnerId: number): string | undefined {
  const event = card.activity.findLast(
    (e) =>
      e.type === "refs_set" && e.actorId === runnerId && (e.data.set?.includes("branch") ?? false),
  );
  return event?.type === "refs_set" ? event.data.refs.branch : undefined;
}

/**
 * Why a merged pull request is not this card's work, naming every mismatch at once — the
 * repository before the branch, the way a Code run's unmet contract names its conditions in a
 * stable order — or nothing when it is the card's own.
 */
function mismatch(
  card: CardDetail,
  pr: PullRequest,
  repoUrl: string,
  runnerId: number,
): string | undefined {
  const reasons: string[] = [];
  if (pr.baseRepo !== repoUrl) reasons.push(`it is in ${pr.baseRepo}, not ${repoUrl}`);
  const branch = recordedBranch(card, runnerId);
  if (branch === undefined) {
    reasons.push(
      `its head branch is ${pr.headRefName}, and no run has recorded a branch on this card`,
    );
  } else if (pr.headRefName !== branch) {
    reasons.push(`its head branch is ${pr.headRefName}, not ${branch}`);
  }
  if (reasons.length === 0) return undefined;
  return `pull request ${pr.url} is merged, but it is not this card's work: ${reasons.join("; ")}`;
}

export function mergePoll({ core, forge, repoRoot, runnerId, warn }: MergePollOptions): MergePoll {
  // Everything this module writes to a card goes through 015's escape, so no text it builds can
  // be refused — a refused comment would be a card moved to Done with no reason on its feed.
  const posting = postingCore(core);
  /**
   * The one request-raising helper a run has, used here for its rule: never replace a request
   * this poll did not raise. The question it is handed records nothing, so *every* open request
   * is someone else's and the raise is refused — the poll has no question of its own to answer.
   */
  const attention = runAttention(posting, runnerId);
  const noQuestionOfItsOwn = runQuestion();
  /** Said once per process, per cause: the repository's own URL, and a pull request. */
  const said = { repoUrl: false, pullRequest: false };
  let running = false;

  function ownerId(): number {
    const owner = core.listMembers().find((m) => m.kind === "human");
    if (owner === undefined) throw new Error("no owner member");
    return owner.id;
  }

  /** `gh` could not answer about the repository itself: not a login guess, a repository one. */
  function cannotAnswerRepo(): void {
    if (said.repoUrl) return;
    said.repoUrl = true;
    warn(
      `skelcrew daemon: merge poll: gh could not say what repository ${repoRoot} is; cards stay in PR until it can`,
    );
  }

  /** `gh` could not answer about a pull request: absent, not logged in, or not a pull request. */
  function cannotAnswerPullRequest(url: string): void {
    if (said.pullRequest) return;
    said.pullRequest = true;
    warn(
      `skelcrew daemon: merge poll: gh could not answer about ${url}; cards stay in PR until it can (is gh installed and logged in?)`,
    );
  }

  /** Whether the card already carries `text`, by the runner, since it entered PR. */
  function saidSince(card: CardDetail, text: string): boolean {
    const since = enteredPr(card);
    return card.activity.some(
      (e) =>
        e.seq > since && e.type === "comment" && e.actorId === runnerId && e.data.text === text,
    );
  }

  /** Posts `text` unless the card already carries it. */
  function record(card: CardDetail, text: string): void {
    if (saidSince(card, text)) return;
    posting.comment(card.id, text, runnerId);
  }

  /**
   * The card as it is now, or nothing when this tick's answer is no longer about it: the owner
   * can move it back to Code, archive it, or have its pull request replaced while `gh` is being
   * asked. See this module's doc, point 3.
   */
  function stillWatched(cardId: number, url: string): CardDetail | undefined {
    const card = core.getCard(cardId);
    const current = card.phase === "pr" && card.archivedAt === null && card.refs.prUrl === url;
    return current ? card : undefined;
  }

  async function visit(listed: Card, repoUrl: string): Promise<void> {
    const url = listed.refs.prUrl;
    if (url === undefined) return;
    const pr = await forge.pullRequest(repoRoot, url);
    if (pr === undefined) {
      cannotAnswerPullRequest(url);
      return;
    }
    if (pr.state === "open") return;
    const card = stillWatched(listed.id, url);
    if (card === undefined) return;
    if (pr.state === "closed") {
      // Closed without merging: a judgement, not a move. Sending it back to Code or archiving
      // it is the owner's call, so the card is handed over with no move attached.
      const note = `pull request ${pr.url} closed without merging`;
      if (saidSince(card, note)) return;
      // The raise first, the comment only once it took: the comment is what the once-rule
      // reads, so a comment over a refused or failed raise would suppress the retry forever.
      if (
        attention.raise(card.id, { to: ownerId(), note, moves: [] }, noQuestionOfItsOwn) ===
        undefined
      ) {
        return;
      }
      posting.comment(card.id, note, runnerId);
      return;
    }
    const wrong = mismatch(card, pr, repoUrl, runnerId);
    if (wrong !== undefined) {
      record(card, wrong);
      return;
    }
    const at = pr.mergedAt === undefined ? "" : ` at ${pr.mergedAt}`;
    // Through the once-rule as well: a move that keeps failing would otherwise re-say the merge
    // every tick. The move is attempted either way, so a failure is retried, not abandoned.
    record(card, `pull request ${pr.url} merged${at}`);
    // The one place the daemon acts as the owner; see this module's doc comment.
    posting.moveCard(card.id, "done", ownerId());
  }

  return {
    async tick() {
      // A tick while a tick is in flight is not a second tick: the guard above the once-check,
      // which reads the card and so cannot see what a concurrent tick has not yet written.
      if (running) return;
      running = true;
      try {
        // Cards drive this: no unarchived card in PR with a pull request, and the forge is
        // never called at all.
        const cards = core.listCards().filter(watched);
        if (cards.length === 0) return;
        const repoUrl = await forge.repoUrl(repoRoot);
        if (repoUrl === undefined) {
          cannotAnswerRepo();
          return;
        }
        for (const card of cards) {
          // One card's failure is not the others': the tick goes on and says which card.
          try {
            await visit(card, repoUrl);
          } catch (error) {
            warn(`skelcrew daemon: merge poll: card ${card.id}: ${message(error)}`);
          }
        }
      } catch (error) {
        warn(`skelcrew daemon: merge poll failed: ${message(error)}`);
      } finally {
        running = false;
      }
    },
  };
}
