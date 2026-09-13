/**
 * The merge poll: the last arc of Idea → Spec → Code → PR → Done, turned by the owner's own
 * merge on the forge. One tick asks the forge about the pull request of every unarchived card
 * in PR that carries one, and a merge of *that card's work* lands the card in Done.
 *
 * In `sweep.ts`'s shape — a timer the daemon owns, not a member action — with two differences
 * the spec names, and this is where both are recorded.
 *
 * **1. The move into Done is made as the owner.** `core.moveCard(id, "done", ownerId())` below
 * is the one place in skelcrew where the daemon writes a member's action without that member
 * typing it. It is not an exemption: since 016 every phase's exit is the owner's, and the core
 * refuses `runner` and `crew` alike — that refusal standing is exactly what makes acting as the
 * owner the only way this move can happen, and it is confined by construction to this one call
 * site and this one transition.
 *
 * The attribution is honest because of what precedes it: the comment on the line above says
 * `pull request <url> merged at <time>`, by `runner`, so a reader of the feed sees the runner
 * report the merge and then the owner's decision follow from it. "Done is a human's call, the
 * way merging is" (`CLAUDE.md`) — and the merge *was* the call; Done is its record. The card
 * never reaches Done without a merge the forge confirms, of a pull request in this repository
 * from this card's own branch, so nothing here is a gate the daemon can walk past on its own.
 *
 * **This is a precedent, and a later spec that wants the daemon to act as the owner elsewhere
 * must argue against this paragraph.** What it has to establish is what is established here: a
 * gesture the owner has already made, somewhere the daemon can verify it; one transition, one
 * call site; and a record of the cause on the card immediately before the action. Convenience
 * is not one of those things.
 *
 * **2. What must not repeat is derived from the card, not remembered here.** A mismatch and a
 * closed-without-merge are posted only when the card does not already carry that exact comment
 * by the runner since it last entered PR, so a tick every minute does not fill the feed, and a
 * card the owner sends back and approves again is told afresh. The only state this module keeps
 * between ticks is whether it has already said that `gh` cannot answer — which is not about any
 * card, and which the spec asks to be said once per process.
 */
import type { Card, CardDetail } from "@skelcrew/shared";
import type { Core } from "./core/core";
import { postingCore } from "./runner/ending";
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
 * Why a merged pull request is not this card's work, naming every mismatch at once — the
 * repository before the branch, the way a Code run's unmet contract names its conditions in a
 * stable order — or nothing when it is the card's own.
 */
function mismatch(card: Card, pr: PullRequest, repoUrl: string): string | undefined {
  const reasons: string[] = [];
  if (pr.baseRepo !== repoUrl) reasons.push(`it is in ${pr.baseRepo}, not ${repoUrl}`);
  if (card.refs.branch === undefined) {
    reasons.push(`its head branch is ${pr.headRefName}, and this card records no branch`);
  } else if (pr.headRefName !== card.refs.branch) {
    reasons.push(`its head branch is ${pr.headRefName}, not ${card.refs.branch}`);
  }
  if (reasons.length === 0) return undefined;
  return `pull request ${pr.url} is merged, but it is not this card's work: ${reasons.join("; ")}`;
}

export function mergePoll({ core, forge, repoRoot, runnerId, warn }: MergePollOptions): MergePoll {
  // Everything this module writes to a card goes through 015's escape, so no text it builds can
  // be refused — a refused comment would be a card moved to Done with no reason on its feed.
  const posting = postingCore(core);
  let said = false;
  let running = false;

  function ownerId(): number {
    const owner = core.listMembers().find((m) => m.kind === "human");
    if (owner === undefined) throw new Error("no owner member");
    return owner.id;
  }

  /** Said once per process, whatever cannot be answered about: `gh` is the owner's to fix. */
  function cannotAnswer(about: string): void {
    if (said) return;
    said = true;
    warn(
      `skelcrew daemon: merge poll: gh could not answer about ${about}; cards stay in PR until it can (is gh installed and logged in?)`,
    );
  }

  /** Posts `text` unless the card already carries it, by the runner, since it entered PR. */
  function record(cardId: number, text: string): boolean {
    const card = core.getCard(cardId);
    const since = enteredPr(card);
    const already = card.activity.some(
      (e) =>
        e.seq > since && e.type === "comment" && e.actorId === runnerId && e.data.text === text,
    );
    if (already) return false;
    posting.comment(cardId, text, runnerId);
    return true;
  }

  async function visit(card: Card, repoUrl: string): Promise<void> {
    const url = card.refs.prUrl;
    if (url === undefined) return;
    const pr = await forge.pullRequest(repoRoot, url);
    if (pr === undefined) {
      cannotAnswer(url);
      return;
    }
    if (pr.state === "open") return;
    if (pr.state === "closed") {
      // Closed without merging: a judgement, not a move. Sending it back to Code or archiving
      // it is the owner's call, so the card is handed over with no move attached.
      const note = `pull request ${pr.url} closed without merging`;
      if (record(card.id, note)) {
        posting.requestAttention(card.id, { to: ownerId(), note, moves: [] }, runnerId);
      }
      return;
    }
    const wrong = mismatch(card, pr, repoUrl);
    if (wrong !== undefined) {
      record(card.id, wrong);
      return;
    }
    const at = pr.mergedAt === undefined ? "" : ` at ${pr.mergedAt}`;
    posting.comment(card.id, `pull request ${pr.url} merged${at}`, runnerId);
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
          cannotAnswer("this repository");
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
