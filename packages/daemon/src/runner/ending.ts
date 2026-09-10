/**
 * How a run hands its card back, and the one place a run raises attention — so the rule that
 * governs it is a property of endings rather than something each call site remembers. The
 * reason is always posted as a comment; the request is raised only when nothing is already
 * waiting on the owner. A card carries one attention record, and the playbooks tell a blocked
 * agent to escalate with `skelcrew attention` and stop, so an ending that raised its own over
 * the agent's would leave the owner's queue showing a generic "the session ended" note on the
 * one card with a real question on it.
 *
 * No identity check is involved or possible: the agent raises attention as the `runner` member
 * too, so `raisedBy` cannot tell its question from the run's own note — and does not need to,
 * because the runner claims only a card whose attention is `null`, so anything open at the end
 * of a run was raised during it.
 *
 * The one request the rule does not protect is the run's *own* permission question: a run that
 * ends while waiting on the owner leaves a question nothing will ever answer — `skelcrew
 * resolve -m allow` then allows no tool, it only clears the request — and the ending's reason
 * would never reach the owner's queue. Which request that is cannot be inferred here, so a run
 * records it in a `RunQuestion` as it asks, and every ending is handed that same value.
 *
 * `RunEnding.question` is **required**, and the runner makes one per run before anything can
 * end: `run.ts` and `runner.ts` share it rather than each remembering the rule. An ending path
 * added later cannot leave it out — there is nothing to leave out, only a value already in
 * scope to pass. This half-rule has been the finding of three review rounds across two specs;
 * a required parameter is what stops the next path from repeating it.
 *
 * Every way a run can end goes through here: `run.ts`'s endings — the agent's session ending,
 * the time limit, the daemon stopping, a driver error, no result, an error result — and
 * `runner.ts`'s failed step, which is where a throw out of a run that had already escalated
 * lands.
 *
 * One call site raises attention without this guard: 006's no-playbook handoff
 * (`runner.ts:283`), which is not an ending — no agent has run in the worktree when it fires.
 * Note what that exemption rests on: *nothing has run*, not *nothing can be waiting*. Three
 * awaits in git sit between the claim and that point, so an owner who raises their own request
 * in that window would have it replaced. Anything added to that path that could follow an
 * agent — or any use of it after work has happened — adopts the guard here rather than
 * inheriting the exemption as settled.
 */
import type { Attention } from "@skelcrew/shared";
import type { Core } from "../core/core";

/**
 * The run's own permission question, while it is the card's open request. Only the run can
 * know which request that is: the agent's `skelcrew attention` runs as the same `runner`
 * member, so `raisedBy` cannot tell the two apart, and what the core recorded for the run's
 * own call is the only mark. Held as a value so that the run and every ending read the same
 * one — an ending is never asked to remember a rule.
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

export interface RunEnding {
  core: Core;
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
  /** The release reason. */
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
  cardId,
  memberId,
  ownerId,
  warn,
  note,
  reason,
  question,
}: RunEnding): void {
  try {
    core.comment(cardId, note, memberId);
    const open = core.getCard(cardId).attention;
    if (open === null || question.isOpen(open)) {
      core.requestAttention(cardId, { to: ownerId(), note }, memberId);
    }
  } catch (error) {
    warn(`skelcrew runner: card ${cardId}: ${note}; and could not say so: ${message(error)}`);
  }
  try {
    core.releaseCard(cardId, { reason }, memberId);
  } catch (error) {
    warn(`skelcrew runner: card ${cardId} not released: ${message(error)}`);
  }
}
