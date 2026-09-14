/**
 * The merge poll: the last arc of Idea → Spec → Code → PR → Done, turned by the owner's own
 * merge on the forge. One tick asks the forge about the pull request of every unarchived card
 * in PR that carries one, and a merge of *that card's work* lands the card in Done.
 *
 * In `sweep.ts`'s shape — a timer the daemon owns, not a member action — with five differences
 * the spec names, and this is where all five are recorded.
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
 * is not one of those things. **020 is the first spec to argue against it and decline the
 * exception**: a conflicting pull request has exactly the shape of a case for bouncing the card
 * to Code as the owner, and it fails the first test — the gesture that moved the base was the
 * owner merging *another card's* pull request, which is not a gesture about this card. So the
 * move is offered in the request below (`moves: ["code"]`) and the owner makes it; see point 6.
 *
 * **2. The branch compared is the one a run or a human recorded, not `refs.branch`.** `setRefs`
 * has no actor restriction, so `crew` writes `branch` as well as `prUrl`: comparing the forge's
 * head branch against `refs.branch` would compare two fields one member controls, and review
 * round 1 walked a card into Done with two `crew` writes through the real CLI. `recordedBranch`
 * reads the last `refs_set` on the card whose `set` names `branch` and whose actor is the
 * `runner` member or a human member — the write the runner makes at run start, or the owner's own
 * by hand, which binds because that human can `skelcrew mv <id> done` anyway and the hand-driven
 * card must still be able to land. A card no such write exists on is a mismatch.
 *
 * What this binds, stated without the overclaim round 1 made: a wrong, stale or copied `prUrl`,
 * and an agent that keeps the identity the runner gave it. It does **not** bind a caller that
 * asserts `runner` over the socket. Round 1's fix claimed such a caller was bound; review rounds 2
 * and 3 both walked `skelcrew --as runner refs <id> --branch <other>` live, and each time it
 * joined the `runner` member and wrote the very event this check reads — names are not
 * credentials (`allowlist.ts` has recorded that since 016, and `hello` reserves none). Nothing is
 * lost by it: that caller can drop `--as` and be the owner, who moves cards to Done by typing.
 * A real bind would be `hello` refusing the reserved names, which is its own finding.
 *
 * **3. The tick acts on the card as it is now, not as it listed it.** Each card costs a `gh`
 * round-trip, and the owner can move a card back to Code inside that window — with a run
 * claiming it. So every write below is preceded by a re-read: still in PR, still unarchived,
 * still carrying the `prUrl` the forge answered about, or the tick does nothing and says nothing.
 * Each of those waits is bounded, too: an unbounded one held the tick guard below for the life of
 * the process when `gh` hung (review round 2), so a forge that does not answer inside
 * `timeoutMs` is "cannot answer" — the same path a logged-out `gh` takes — and `forge.ts` kills
 * the child it spawned.
 *
 * **4. What must not repeat is derived from the card, not remembered here.** A mismatch, a
 * closed-without-merge and a merge are each posted only when the card does not already carry
 * that exact comment by the runner since it last entered PR, so a tick every minute does not
 * fill the feed, and a card the owner sends back and approves again is told afresh. Which open
 * request the poll may replace is derived the same way — the one it would raise itself, by the
 * runner with that note, and no other. The only state this module keeps between ticks is whether
 * it has already said that `gh` could not answer, or that a tick was skipped: one flag per cause,
 * not about any card, which the spec asks to be said once per process.
 *
 * **5. The `prUrl`'s host is compared before `gh` is ever run against it.** `gh pr view <url>`
 * sends a request to the host the URL names — review round 3 ran it against a URL on
 * `example.com` and got that host's `HTTP 405` back — and the poll asks again every interval. So
 * a card whose `prUrl` is on another host would make the owner's daemon contact a host `crew`
 * chose (016: `crew` can set any card's refs) once a minute for as long as the card sat in PR,
 * long after the run that wrote it ended. `visit` therefore compares the `prUrl`'s origin to the
 * repository's own before asking anything, and a card that fails it is a mismatch recorded
 * through the once-rule with nothing dialled. The origin only, not the whole slug: a renamed or
 * redirecting repository is still on this forge, and which repository the pull request is in is
 * what the comparison in `mismatch` then reads off `gh`'s canonical `url`. No repository URL — or
 * one with no origin to read — is the warned-once path, and nothing is dialled there either.
 *
 * **6. An open pull request that conflicts is offered back to Code, never sent** (020). When the
 * owner merges one card's pull request the default branch moves, and another card's can stop
 * being mergeable; the forge says so in `mergeable`, on the call this poll already makes. What
 * the card gets is an attention request to the owner carrying the move (`moves: ["code"]`) and
 * the fix spelled out, and the card stays in PR. The daemon does not make that move itself, and
 * point 1 above is the paragraph that says why: the only gesture behind it is the owner merging
 * *another* card's work, which is not a gesture about this one. One gesture on the owner's side —
 * `skelcrew mv <id> code` — resolves the request as `moved` and starts the fix run, which merges
 * the base in (`allowlist.ts` grants that run those two commands) and pushes to the same pull
 * request.
 *
 * Three things this path does not do. It never speaks about a pull request that is not this
 * card's own work by point 2's check, so `mismatch` decides here as it decides the merge, and an
 * open answer that fails it is nothing on the card — not even the mismatch comment, which says
 * "is merged" and would be false. It says nothing about `unknown`, which is not "no": GitHub
 * computes mergeability lazily and answers `UNKNOWN` until it has, so the next tick asks again.
 * And when the conflict clears while the request is open it comments once and leaves the request
 * standing, because the core refuses a non-human actor resolving a request addressed to the
 * owner — so the card says what changed and the owner still decides.
 *
 * Which branch name the note uses is the pull request's `baseRefName`, because that is what the
 * forge merged it against. The grant in `allowlist.ts` uses the *runner's* default branch,
 * because that is what the runner knows before any forge is asked. In a repository where the two
 * differ the note and the grant disagree and the fix run's two commands ask like anything else:
 * recorded as a limit, not handled.
 */
import type { Attention, Card, CardDetail } from "@skelcrew/shared";
import type { Core } from "./core/core";
import { postingCore, type RunQuestion, runAttention } from "./runner/ending";
import { FORGE_TIMEOUT_MS, type Forge, type PullRequest } from "./runner/forge";

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
  /**
   * How long one forge call may take before it counts as no answer. The forge bounds its own
   * spawn; this is the poll's own guarantee that a tick ends, which is the invariant a hanging
   * `gh` broke. Defaults to `FORGE_TIMEOUT_MS`.
   */
  timeoutMs?: number;
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
 * The branch recorded for this card by a run or by a human: the last `refs_set` naming `branch`
 * whose actor `binds` accepts. Not `refs.branch`, which `crew` can rewrite — see this module's
 * doc, point 2. `set` absent (an event from before 011, which recorded only the merged result) is
 * "unknown", never "branch", so such an event does not answer this.
 */
function recordedBranch(card: CardDetail, binds: (actorId: number) => boolean): string | undefined {
  const event = card.activity.findLast(
    (e) => e.type === "refs_set" && binds(e.actorId) && (e.data.set?.includes("branch") ?? false),
  );
  return event?.type === "refs_set" ? event.data.refs.branch : undefined;
}

/** The scheme and host a URL names, or nothing when it names neither. See the doc, point 5. */
function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Why a `prUrl` is not this card's work before the forge is asked anything: it is not on this
 * repository's forge at all, so `gh pr view` is never run against it (doc, point 5). Said in
 * `mismatch`'s shape but without its "is merged" — nothing has been asked, so the pull request's
 * state is unknown, and the card says only what is known.
 */
function elsewhere(url: string, host: string | undefined, home: string): string {
  const on = host === undefined ? "on no host that can be read" : `on ${host}`;
  return `pull request ${url} is not this card's work: it is ${on}, not ${home}, so the forge was not asked about it`;
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
  binds: (actorId: number) => boolean,
): string | undefined {
  const reasons: string[] = [];
  if (pr.baseRepo !== repoUrl) reasons.push(`it is in ${pr.baseRepo}, not ${repoUrl}`);
  const branch = recordedBranch(card, binds);
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

/**
 * What the card is told about a conflict, and what the request offers the move for: the pull
 * request, the base it no longer merges into, and the one thing that fixes it. The branch named
 * is the forge's `headRefName`, which is the branch a run recorded for this card — the caller
 * has already established that through `mismatch`.
 */
function conflictNote(pr: PullRequest): string {
  return `pull request ${pr.url} conflicts with ${pr.baseRefName}; ${pr.headRefName} needs refs/remotes/origin/${pr.baseRefName} merged in`;
}

/** And what it is told when the conflict is gone; the request itself is not the poll's to clear. */
function clearedNote(pr: PullRequest): string {
  return `pull request ${pr.url} no longer conflicts with ${pr.baseRefName}`;
}

export function mergePoll({
  core,
  forge,
  repoRoot,
  runnerId,
  warn,
  timeoutMs = FORGE_TIMEOUT_MS,
}: MergePollOptions): MergePoll {
  // Everything this module writes to a card goes through 015's escape, so no text it builds can
  // be refused — a refused comment would be a card moved to Done with no reason on its feed.
  const posting = postingCore(core);
  /** The one request-raising helper a run has, used here for its rule; see `ownRequest`. */
  const attention = runAttention(posting, runnerId);
  /** Said once per process, per cause. */
  const said = { repoUrl: false, pullRequest: false, skipped: false };
  let running = false;

  function ownerId(): number {
    const owner = core.listMembers().find((m) => m.kind === "human");
    if (owner === undefined) throw new Error("no owner member");
    return owner.id;
  }

  /** Whether a `refs_set` by this member is a record of the card's branch; doc, point 2. */
  function binds(actorId: number): boolean {
    return actorId === runnerId || core.getMember(actorId).kind === "human";
  }

  /**
   * The open request the poll may replace: the one it would raise itself, by the runner with this
   * note. Derived from the card rather than remembered, so a request the poll made and failed to
   * finish is replaceable while nobody else's ever is. `raised` records nothing for the same
   * reason — there is nothing between ticks to record it in.
   */
  function ownRequest(note: string): RunQuestion {
    return {
      raised(): void {},
      isOpen(request: Attention): boolean {
        return request.raisedBy === runnerId && request.note === note;
      },
    };
  }

  /**
   * Awaits the forge, or gives up: the poll's own guarantee that a tick ends. `forge.ts` bounds
   * its spawn too, and this is the layer whose invariant it is — a hang here held the tick guard
   * for the life of the process (doc, point 3).
   */
  async function bounded<T>(answer: Promise<T | undefined>): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
    });
    try {
      return await Promise.race([answer, expiry]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * `gh` could not answer about the repository itself. `gh repo view` is every tick's first call,
   * so this is the line an owner with no `gh` at all sees — which is why it asks about the
   * install as well as naming what it could not read.
   */
  function cannotAnswerRepo(): void {
    if (said.repoUrl) return;
    said.repoUrl = true;
    warn(
      `skelcrew daemon: merge poll: gh could not say what repository ${repoRoot} is; cards stay in PR until it can — is gh installed and logged in?`,
    );
  }

  /** A tick this one overlapped, said once: silence is what a hang looked like before. */
  function skipped(): void {
    if (said.skipped) return;
    said.skipped = true;
    warn(
      "skelcrew daemon: merge poll: a tick is still in flight; this one is skipped (is gh hanging?)",
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

  /**
   * An open pull request of this card's own work (doc, point 6). Conflicting: the owner is asked,
   * once per entry into PR, with the move to Code attached — in the closed path's shape, and for
   * its reasons. Mergeable while the poll's own conflict request is open: one comment saying so,
   * and the request stands. `unknown`: nothing, and the next tick asks again.
   */
  function conflict(card: CardDetail, pr: PullRequest): void {
    if (pr.mergeable === "conflicting") {
      const note = conflictNote(pr);
      // The comment is what the once-rule reads, so it comes after a raise that took.
      if (saidSince(card, note)) return;
      const raised = attention.raise(
        card.id,
        { to: ownerId(), note, moves: ["code"] },
        ownRequest(note),
      );
      if (raised === undefined) return;
      posting.comment(card.id, note, runnerId);
      return;
    }
    if (pr.mergeable !== "mergeable") return;
    // The conflict cleared. Only over the poll's own request for this pull request, and only as a
    // comment: `resolveAttention` refuses the runner clearing what is addressed to the owner, so
    // what the card can carry is what changed.
    const open = card.attention;
    if (open === null || !ownRequest(conflictNote(pr)).isOpen(open)) return;
    record(card, clearedNote(pr));
  }

  async function visit(listed: Card, repoUrl: string, home: string): Promise<void> {
    const url = listed.refs.prUrl;
    if (url === undefined) return;
    const host = originOf(url);
    if (host !== home) {
      // Another forge entirely, and `gh pr view` would dial it every interval (doc, point 5):
      // a mismatch before it is a question, recorded through the same once-rule.
      const other = stillWatched(listed.id, url);
      if (other === undefined) return;
      record(other, elsewhere(url, host, home));
      return;
    }
    const pr = await bounded(forge.pullRequest(repoRoot, url));
    if (pr === undefined) {
      cannotAnswerPullRequest(url);
      return;
    }
    const card = stillWatched(listed.id, url);
    if (card === undefined) return;
    // Whether this pull request is this card's own work, by point 2's check. Asked for every
    // state: only its answer is read here, never its text, which says "is merged".
    const wrong = mismatch(card, pr, repoUrl, binds);
    if (pr.state === "open") {
      if (wrong === undefined) conflict(card, pr);
      return;
    }
    if (pr.state === "closed") {
      // Closed without merging: a judgement, not a move. Sending it back to Code or archiving
      // it is the owner's call, so the card is handed over with no move attached.
      const note = `pull request ${pr.url} closed without merging`;
      // The comment is what the once-rule reads, so it comes after a raise that took: over a
      // refused or failed raise it would suppress the retry forever. A raise that took and a
      // comment that then failed is the other half — the next tick may replace the poll's own
      // request (`ownRequest`) and post the comment it owes.
      if (saidSince(card, note)) return;
      if (
        attention.raise(card.id, { to: ownerId(), note, moves: [] }, ownRequest(note)) === undefined
      ) {
        return;
      }
      posting.comment(card.id, note, runnerId);
      return;
    }
    if (wrong !== undefined) {
      record(card, wrong);
      return;
    }
    // The time is best-effort: every merged pull request the installed `gh` was asked about
    // carried one, and whether it can answer `MERGED` with `mergedAt: null` is unverified — so
    // the comment says what is known and the merge lands either way.
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
      // which reads the card and so cannot see what a concurrent tick has not yet written. It is
      // said, once, because a run of skipped ticks is how a hanging `gh` used to look from
      // outside — which was nothing at all.
      if (running) {
        skipped();
        return;
      }
      running = true;
      try {
        // Cards drive this: no unarchived card in PR with a pull request, and the forge is
        // never called at all.
        const cards = core.listCards().filter(watched);
        if (cards.length === 0) return;
        const repoUrl = await bounded(forge.repoUrl(repoRoot));
        // No answer about the repository, or an answer with no origin to compare against: either
        // way nothing is dialled, and it is the same warned-once line (doc, point 5).
        const home = repoUrl === undefined ? undefined : originOf(repoUrl);
        if (repoUrl === undefined || home === undefined) {
          cannotAnswerRepo();
          return;
        }
        for (const card of cards) {
          // One card's failure is not the others': the tick goes on and says which card.
          try {
            await visit(card, repoUrl, home);
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
