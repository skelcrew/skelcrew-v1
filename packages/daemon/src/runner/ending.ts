/**
 * How a run hands its card back: the one place a run raises attention, and the one place an
 * ending is decided. Both are constructions rather than conventions, because the spike proved
 * the conventions do not hold — see `docs/plans/007-spike-retrospective.md` §3, where the same
 * two rules were half-implemented five times between them.
 *
 * **Every raise goes through `runAttention`.** The reason a run ended is always posted as a
 * comment; the request is raised only when nothing the run may not replace is already waiting
 * on the owner. A card carries one attention record, and the playbooks tell a blocked agent to
 * escalate with `skelcrew attention` and stop, so an ending that raised its own over the
 * agent's would leave the owner's queue showing a generic "the session ended" note on the one
 * card with a real question on it. `run.ts` and this module see the core as `RunCore`, which
 * has no `requestAttention` at all, so a call site that tried to raise around the helper would
 * not compile.
 *
 * **Which request the run may replace is recorded, not inferred.** What the core recorded for
 * the run's own call is the mark, and nothing else is consulted. Since 016 the agent raises as
 * `crew` and the run as `runner`, so `raisedBy` would now agree — but a second signal that
 * agrees is not a reason to start deciding by it: the construction is the point, and it held
 * when identity could not decide this at all. The one request the rule does not protect is
 * the run's *own* permission question: a run that ends while waiting on the owner leaves a
 * question nothing will ever answer — `skelcrew resolve -m allow` then allows no tool, it only
 * clears the request — and the ending's reason would never reach the owner's queue. Which
 * request that is cannot be inferred here, so a run records it in a `RunQuestion` as it asks,
 * and every raise and every ending is handed that same value.
 *
 * `RunEnding.question` and `RunEnding.attention` are both **required**, and the runner makes
 * one of each per run before anything can end: `run.ts` and `runner.ts` share them rather than
 * each remembering the rule. An ending path added later cannot leave either out — there is
 * nothing to leave out, only values already in scope to pass. Half-implementing this rule has
 * been a review finding round after round, each time on the next path that lacked it; a
 * required parameter is what ends that.
 *
 * **The ending is derived from the card's state at completion** (`classifyEnding`), not from
 * flags an event handler accumulates as events arrive: a handler must remember to update them
 * for every event kind, and the spike's fifth case — a new claim after a release — was still
 * wrong after four corrections. The recorded events are consulted only for the *reason*, and
 * for the one thing the card cannot report: what the agent itself did, since the state the
 * card is in is then the agent's own doing.
 *
 * Every ending that hands the card to a member goes through `endRun`: `run.ts`'s endings — the
 * contract met or unmet, the time limit, the daemon stopping, a driver error, no result, an
 * error result, a self-action, a stop on an explicit release — and `runner.ts`'s failed step,
 * which is where a throw out of a run that had already escalated lands.
 *
 * The fourth outcome below, `abandoned`, is the one ending that does not, and cannot: its whole
 * observable is "one comment saying so, and nothing else" — no request, no release — so there
 * is nothing for `endRun` to do. `run.ts` throws `RunAbandoned` and `runner.ts` writes that one
 * comment. Anything added to that path that wanted to raise attention would stop being an
 * abandonment, and would come back through here.
 *
 * One call site raises attention without this guard: 006's `no playbook for <phase> yet`
 * handoff in `runner.ts`, which is not an ending — no agent has run in the worktree when it
 * fires. Note what that exemption rests on: *nothing has run*, not *nothing can be waiting*.
 * Three awaits in git sit between the claim and that point, so an owner who raises their own
 * request in that window would have it replaced. Anything added to that path that could follow
 * an agent — or any use of it after work has happened — adopts the guard here rather than
 * inheriting the exemption as settled.
 */
import type { Activity, Attention, Phase } from "@skelcrew/shared";
import type { Core } from "../core/core";

/**
 * The core as a run sees it: everything except raising attention, which only `runAttention`
 * may do. Narrowing the type is the construction — a call site that skips the helper is a
 * compile error rather than something a reviewer has to notice.
 */
export type RunCore = Omit<Core, "requestAttention">;

/**
 * The run's own permission question, while it is the card's open request. What the core
 * recorded for the run's own call is the mark — the construction 013 built when the agent's
 * `skelcrew attention` ran as the same member and `raisedBy` could not tell the two apart.
 * Since 016 it could, and the recorded value stays what decides. Held as a value so that the
 * run and every ending read the same one — an ending is never asked to remember a rule.
 */
export interface RunQuestion {
  /** What the core recorded for the run's own `requestAttention`, or nothing once it is gone. */
  raised(request: Attention | undefined): void;
  /** Whether the card's open request is that one, and so the ending's to replace. */
  isOpen(request: Attention): boolean;
}

export function runQuestion(): RunQuestion {
  let own: Attention | undefined;
  return {
    raised(request) {
      own = request;
    },
    isOpen(request) {
      return (
        own !== undefined &&
        request.to === own.to &&
        request.note === own.note &&
        request.raisedBy === own.raisedBy &&
        request.raisedAt === own.raisedAt
      );
    },
  };
}

export interface RunAttention {
  /**
   * Raises a request for this run, and returns what the core recorded — or nothing when the
   * raise was refused and the card was left exactly as it was. It is refused when an open
   * request is not this run's own question (the agent's, which the owner must answer before
   * anything else makes sense), when the card is archived, and when another member holds it:
   * this run's ending is not a new holder's queue to fill.
   */
  raise(
    cardId: number,
    request: { to: number; note: string; moves: Phase[] },
    question: RunQuestion,
  ): Attention | undefined;
}

export function runAttention(core: Core, memberId: number): RunAttention {
  return {
    raise(cardId, request, question) {
      const card = core.getCard(cardId);
      if (card.archivedAt !== null) return undefined;
      if (card.claim !== null && card.claim.by !== memberId) return undefined;
      if (card.attention !== null && !question.isOpen(card.attention)) return undefined;
      return core.requestAttention(cardId, request, memberId).attention ?? undefined;
    },
  };
}

/**
 * How a run ended, as the card reports it at completion:
 * - `self` — the agent moved, released or archived its own card, so the phase never reached
 *   its artefact check. Recorded wherever the card ended up.
 * - `held` — the claim is still this run's, so the phase's contract decides.
 * - `released` — the card was released and nothing has superseded that, so the run stops and
 *   the card waits rather than being picked up again a moment later.
 * - `abandoned` — a move, an archive, another member's claim, or a lapsed lease: one comment
 *   saying so, and nothing else.
 */
export type RunOutcome =
  | { kind: "self"; note: string }
  | { kind: "held" }
  | { kind: "released" }
  | { kind: "abandoned"; reason: string };

export interface EndingInput {
  core: RunCore;
  cardId: number;
  /** The `runner` member: the claim's holder. */
  memberId: number;
  /**
   * The `crew` member the agent spoke as. A self-action is looked for by either member: since
   * 016 the core refuses `crew` every one of them, and refuses the runner all but its own
   * release, so this branch is defence in depth — it costs nothing and it is not the boundary.
   */
  crewId: number;
  /** The phase the run was claimed in. */
  phase: Phase;
  /** The last sequence number before the run began: what "during this run" means. */
  sinceSeq: number;
  /** The clock the claim's expiry is read against; the core's, so the two agree. */
  now: number;
}

function during(activity: Activity[], sinceSeq: number): Activity[] {
  return activity.filter((event) => event.seq > sinceSeq);
}

export function classifyEnding({
  core,
  cardId,
  memberId,
  crewId,
  phase,
  sinceSeq,
  now,
}: EndingInput): RunOutcome {
  const card = core.getCard(cardId);
  const since = during(card.activity, sinceSeq);
  // Either member: what the run did, and what the agent it spawned did.
  const byRun = (event: Activity): boolean =>
    event.actorId === memberId || event.actorId === crewId;

  // What the agent itself did comes first, because the card cannot report it: the state the
  // card is in is the agent's own doing, and a phase whose card the agent moved has skipped
  // the artefact check the phase exists for.
  //
  // **The next two branches are unreachable since 016**, which made every phase the owner's to
  // leave and archiving the owner's: the core refuses `crew` and the runner alike, so nothing
  // can record a `card_archived` or a `card_moved` by either. They are kept as defence in
  // depth. Their notes say "the agent", which was true when the agent and the runner were one
  // member; if either rule is ever relaxed and a branch revives, the note has to say which of
  // the two acted, because only the runner could have reached it.
  if (since.some((event) => event.type === "card_archived" && byRun(event))) {
    return { kind: "self", note: "run failed: the agent archived its own card" };
  }
  const moved = since.findLast((event) => event.type === "card_moved" && byRun(event));
  if (moved !== undefined && moved.type === "card_moved") {
    return {
      kind: "self",
      note: `run failed: the agent moved its own card from ${moved.data.from} to ${moved.data.to}`,
    };
  }
  // A move and an archive each emit their own `released` by the same actor; both are already
  // answered above, so what is left here is a release the agent made on its own.
  if (since.some((event) => event.type === "released" && byRun(event))) {
    return { kind: "self", note: "run failed: the agent released its own card" };
  }

  // Then the card itself, which cannot be wrong about an event kind nobody thought of.
  if (card.claim !== null && card.claim.by === memberId) {
    if (card.claim.expiresAt > now) return { kind: "held" };
    return { kind: "abandoned", reason: `claim lapsed; card is in ${card.phase}` };
  }
  if (card.archivedAt !== null) return { kind: "abandoned", reason: "card archived" };
  if (card.claim !== null) {
    return {
      kind: "abandoned",
      reason: `claim lost to member ${card.claim.by}; card is in ${card.phase}`,
    };
  }
  if (card.phase !== phase) return { kind: "abandoned", reason: `card is in ${card.phase}` };
  // Free and back in this run's phase, so the card alone cannot say how it got here. Two
  // questions it cannot answer, both asked as "did this ever happen", never as a flag to
  // clear: a move away and back, and a lease that lapsed rather than a member releasing.
  if (since.some((event) => event.type === "card_moved")) {
    return { kind: "abandoned", reason: `card was moved away from ${phase} and back` };
  }
  if (since.some((event) => event.type === "run_interrupted" && event.data.by === memberId)) {
    return { kind: "abandoned", reason: `claim lapsed; card is in ${card.phase}` };
  }
  return { kind: "released" };
}

export interface RunEnding {
  core: RunCore;
  /** The one helper a run raises through. Required: there is no other way to raise. */
  attention: RunAttention;
  cardId: number;
  /** The `runner` member the comment, the request and the release are attributed to. */
  memberId: number;
  /**
   * Who the card is handed to when nothing is already waiting — resolved here rather than
   * passed in, so that a lookup that throws is caught below and the release still happens.
   */
  ownerId(): number;
  warn: (line: string) => void;
  /** Why the run ended, already within the comment cap: the comment, and the request's note. */
  note: string;
  /**
   * What the request offers the owner. Required, and empty on every ending but a met
   * contract: an ending that hands a card on without its artefact would have to say so here.
   */
  moves: Phase[];
  /** The release reason, when this run's own request was the one raised. */
  reason: string;
  /**
   * This run's own permission question, the one open request an ending may replace: nothing
   * answers it once the run is over. Every other open request stands and the ending is a
   * comment alone, which is the rule above.
   */
  question: RunQuestion;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Posts the reason, hands the card over unless something is already waiting, and releases. */
export function endRun({
  core,
  attention,
  cardId,
  memberId,
  ownerId,
  warn,
  note,
  moves,
  reason,
  question,
}: RunEnding): void {
  /**
   * Set only where the helper itself refused: a request this run may not replace is standing.
   * A *throw* out of the block below is not that — `ownerId()` is resolved inside it on
   * purpose, and a member lookup or a comment that fails is a harness failure, not the card
   * waiting on an answer. Conflating the two would release a finished artefact as `blocked`.
   */
  let refused = false;
  try {
    core.comment(cardId, note, memberId);
    refused = attention.raise(cardId, { to: ownerId(), note, moves }, question) === undefined;
  } catch (error) {
    warn(`skelcrew runner: card ${cardId}: ${note}; and could not say so: ${message(error)}`);
  }
  try {
    // A card whose claim is no longer this run's is not this run's to release; the core would
    // refuse it anyway, and a warning about it says nothing a member needs.
    if (core.getCard(cardId).claim?.by !== memberId) return;
    // A question of the agent's still standing is what the card waits on, whatever this run
    // made of its own work: it is blocked behind the answer rather than finished or failed.
    core.releaseCard(cardId, { reason: refused ? "blocked" : reason }, memberId);
  } catch (error) {
    warn(`skelcrew runner: card ${cardId} not released: ${message(error)}`);
  }
}
