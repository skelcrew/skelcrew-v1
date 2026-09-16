import type { Phase } from "./phases";

export type MemberKind = "human" | "agent";

export interface Member {
  id: number;
  name: string;
  kind: MemberKind;
  createdAt: number;
}

/** References into the target repository. Never contents. */
export interface CardRefs {
  branch?: string;
  /** Where the spec lives in the target repository: a path relative to its root. */
  specPath?: string;
  commits?: string[];
  prUrl?: string;
}

/**
 * A pending decision: the card is handed to `to` with a note and the phases the raiser
 * suggests as resolutions. A card has at most one; raising again replaces it.
 */
export interface Attention {
  to: number;
  note: string;
  moves: Phase[];
  raisedBy: number;
  raisedAt: number;
}

/** An open request as `listAttention` returns it: the request plus the card it is on. */
export interface OpenAttention extends Attention {
  cardId: number;
}

/**
 * A lease on the card: who is working on it, since when, and until when unless renewed.
 * A card has at most one. It is live while `expiresAt` is in the future; a lapsed claim
 * stays visible until the next claim or sweep clears it, so a reader can tell "lapsed, not
 * yet swept" from "live". `ttlSeconds` is what a heartbeat extends it by.
 */
export interface Claim {
  by: number;
  claimedAt: number;
  expiresAt: number;
  ttlSeconds: number;
}

export interface Card {
  id: number;
  title: string;
  /** One markdown text — the spec. The core never inspects it. */
  body: string;
  phase: Phase;
  refs: CardRefs;
  /** Who the card is waiting on, or null. "Waiting" is this being non-null. */
  attention: Attention | null;
  /** Who holds the card, or null. "Running" is this being live. */
  claim: Claim | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** A card with its full activity, oldest first. */
export interface CardDetail extends Card {
  activity: Activity[];
}

/** Largest member name, in UTF-8 bytes. Clients may validate before sending. */
export const MEMBER_NAME_MAX_BYTES = 256;
/** Largest title, in UTF-8 bytes. */
export const TITLE_MAX_BYTES = 256;
/** Largest body, in UTF-8 bytes. */
export const BODY_MAX_BYTES = 64 * 1024;
/** Largest comment, in UTF-8 bytes. A log excerpt stays an excerpt. */
export const COMMENT_MAX_BYTES = 16 * 1024;
/** Largest branch name in a card's refs, in UTF-8 bytes. */
export const BRANCH_MAX_BYTES = 256;
/** Most commit shas a card's refs may carry. A list of commits is never a file. */
export const COMMITS_MAX_COUNT = 256;
/** Largest PR URL in a card's refs, in UTF-8 bytes. A URL is a reference, never a payload. */
export const PR_URL_MAX_BYTES = 256;
/** Largest spec path in a card's refs, in UTF-8 bytes. A path is a reference, never contents. */
export const SPEC_PATH_MAX_BYTES = 256;
/** A claim's lease when no TTL is given, in seconds. */
export const CLAIM_TTL_DEFAULT_SECONDS = 120;
/** The shortest lease a claim may ask for; a smaller TTL is raised to this. */
export const CLAIM_TTL_MIN_SECONDS = 10;
/** The longest lease a claim may ask for; a larger TTL is lowered to this. */
export const CLAIM_TTL_MAX_SECONDS = 3600;

/**
 * What a review run — or any member — concluded about the work on a card. `approved` means no
 * Critical and no Important findings; `changes_requested` carries them as its text.
 */
export type ReviewVerdict = "approved" | "changes_requested";

export type ActivityEvent =
  | { type: "member_joined"; data: { name: string; kind: MemberKind } }
  | { type: "card_created"; data: { title: string } }
  | { type: "card_moved"; data: { from: Phase; to: Phase } }
  | { type: "move_rejected"; data: { from: Phase; to: Phase; reason: string } }
  | { type: "body_set"; data: { bytes: number } }
  | { type: "comment"; data: { text: string } }
  /**
   * A verdict on the work, recorded by whoever reviewed it. The text is the findings: required
   * with `changes_requested`, and empty or the Minor findings with `approved`. It is a record
   * like a comment — it moves nothing by itself; the runner's review loop is what acts on one.
   */
  | { type: "review_recorded"; data: { verdict: ReviewVerdict; text: string } }
  /**
   * The card's refs after the call, and the keys the call itself set — in `CardRefs`
   * declaration order, empty when it set nothing. `set` is absent on events recorded before
   * 011, which captured only the merged result: absent means unknown, never "nothing".
   */
  | { type: "refs_set"; data: { refs: CardRefs; set?: (keyof CardRefs)[] } }
  | { type: "card_archived"; data: Record<string, never> }
  /** The same fields as `Card.attention`, so an event can be matched to the open request. */
  | { type: "attention_requested"; data: Attention }
  | { type: "attention_resolved"; data: AttentionResolution }
  /** A new claim by the actor. Renewals and heartbeats record nothing. */
  | { type: "claimed"; data: { ttlSeconds: number; expiresAt: number } }
  /** The actor released the claim; `"moved"` and `"archived"` are the core's own reasons. */
  | { type: "released"; data: { reason: string | null } }
  /** The claim lapsed. Attributed to the former holder, `by`; the sweep is not a member. */
  | { type: "run_interrupted"; data: { by: number; expiresAt: number } };

/**
 * How an open request went away. The resolving actor is the event's `actorId`.
 *
 * `interrupted` is the sweep's: a request raised by a claim's holder goes with the claim when
 * the lease lapses, because nothing can answer a question the run that asked it no longer
 * exists to hear. Attributed to the former holder, as `run_interrupted` is.
 */
export type AttentionResolution =
  | { how: "moved"; phase: Phase }
  | { how: "archived" }
  | { how: "answered" }
  | { how: "interrupted" };

export type ActivityType = ActivityEvent["type"];

export type Activity = ActivityEvent & {
  seq: number;
  /** Null only for `member_joined`. */
  cardId: number | null;
  actorId: number;
  createdAt: number;
};
