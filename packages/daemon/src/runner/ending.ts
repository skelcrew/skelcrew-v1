/**
 * How a run hands its card back: the one place a run raises attention, and the one place an
 * ending is decided. Both are constructions rather than conventions, because the spike proved
 * the conventions do not hold — see `docs/plans/007-spike-retrospective.md` §3, where the same
 * two rules were half-implemented five times between them.
 *
 * **Every raise goes through `runAttention`.** The rule cannot be phrased as "do not replace
 * another member's request": the agent raises `skelcrew attention` as the `runner` member too,
 * so `raisedBy` cannot tell its question from the run's own note. Only the run knows which
 * request is its own, from what the core recorded when it raised it — which is why this lives
 * at the runner boundary and not in the core. `run.ts` and this module see the core as
 * `RunCore`, which has no `requestAttention` at all, so a future ending path that tried to
 * raise around the helper would not compile.
 *
 * **The ending is derived from the card's state at completion** (`classifyEnding`), not from
 * flags an event handler accumulates as events arrive: a handler must remember to update them
 * for every event kind, and the spike's fifth case — a new claim after a release — was still
 * wrong after four corrections. The recorded events are consulted only for the *reason*, and
 * for the one thing the card cannot report: what the agent itself did, since the state the
 * card is in is then the agent's own doing.
 *
 * Every way a run can end goes through `endRun`: `run.ts`'s endings — the contract met or
 * unmet, the time limit, the daemon stopping, a driver error, no result, an error result, a
 * self-action, a stop on an explicit release — and `runner.ts`'s failed step, which is where a
 * throw out of a run that had already escalated lands.
 *
 * One call site raises attention without this guard: 006's no-playbook handoff
 * (`runner.ts`), which is not an ending — no agent has run in the worktree when it fires.
 * Note what that exemption rests on: *nothing has run*, not *nothing can be waiting*. Three
 * awaits in git sit between the claim and that point, so an owner who raises their own request
 * in that window would have it replaced. Anything added to that path that could follow an
 * agent — or any use of it after work has happened — adopts the guard here rather than
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

export interface RunAttention {
  /**
   * Raises this run's request, and answers whether it did. Refused — and nothing written —
   * when a request the run did not raise itself is open (the agent's own question, which the
   * owner must answer before anything else makes sense), when the card is archived, or when
   * another member holds it.
   */
  raise(cardId: number, request: { to: number; note: string; moves: Phase[] }): boolean;
}

/** What a run's own request looks like when it comes back off the card. */
function fingerprint(attention: Attention): string {
  return `${attention.raisedBy}:${attention.raisedAt}:${attention.note}`;
}

export function runAttention(core: Core, memberId: number): RunAttention {
  const mine = new Set<string>();
  return {
    raise(cardId, request) {
      const card = core.getCard(cardId);
      if (card.archivedAt !== null) return false;
      if (card.claim !== null && card.claim.by !== memberId) return false;
      if (card.attention !== null && !mine.has(fingerprint(card.attention))) return false;
      const after = core.requestAttention(cardId, request, memberId);
      if (after.attention !== null) mine.add(fingerprint(after.attention));
      return true;
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
  memberId: number;
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
  phase,
  sinceSeq,
  now,
}: EndingInput): RunOutcome {
  const card = core.getCard(cardId);
  const since = during(card.activity, sinceSeq);
  const byRun = (event: Activity): boolean => event.actorId === memberId;

  // What the agent itself did comes first, because the card cannot report it: the state the
  // card is in is the agent's own doing, and a phase whose card the agent moved has skipped
  // the artefact check the phase exists for.
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
}: RunEnding): void {
  let raised = false;
  try {
    core.comment(cardId, note, memberId);
    raised = attention.raise(cardId, { to: ownerId(), note, moves });
  } catch (error) {
    warn(`skelcrew runner: card ${cardId}: ${note}; and could not say so: ${message(error)}`);
  }
  try {
    // A card whose claim is no longer this run's is not this run's to release; the core would
    // refuse it anyway, and a warning about it says nothing a member needs.
    if (core.getCard(cardId).claim?.by !== memberId) return;
    // A question of the agent's still standing is what the card waits on, whatever this run
    // made of its own work: it is blocked behind the answer rather than finished or failed.
    core.releaseCard(cardId, { reason: raised ? reason : "blocked" }, memberId);
  } catch (error) {
    warn(`skelcrew runner: card ${cardId} not released: ${message(error)}`);
  }
}
