/**
 * The one way the runner raises an attention request. The rule lives here rather than at
 * each call site: a request already open on the card that the caller did not raise for
 * itself is what the owner has to answer — a question the agent raised with `skelcrew
 * attention`, say — and a run's own note never replaces it. Written once because writing it
 * per call site is what left two of five raises without it, twice over.
 *
 * Nothing under `runner/` calls `core.requestAttention` directly.
 */
import type { Attention, Phase } from "@skelcrew/shared";
import type { Core } from "../core/core";

export interface AttentionRequest {
  to: number;
  note: string;
  moves?: Phase[];
}

/**
 * Raises `request` on the card and returns it, unless a request the owner must answer is
 * already open, in which case nothing is raised and the result is `undefined` — what the
 * caller reports instead is the caller's business. `mine` says which open request is the
 * caller's own to replace; without it, every open request is someone else's. Core errors
 * (an archived card refuses a request) are thrown, as `core.requestAttention` throws them.
 */
export function raiseAttention(
  core: Core,
  cardId: number,
  request: AttentionRequest,
  actorId: number,
  mine?: (open: Attention) => boolean,
): Attention | undefined {
  const open = core.getCard(cardId).attention;
  if (open !== null && !(mine?.(open) ?? false)) return undefined;
  return core.requestAttention(cardId, request, actorId).attention ?? undefined;
}
