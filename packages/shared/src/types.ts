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
  commits?: string[];
  prUrl?: string;
}

export interface Card {
  id: number;
  title: string;
  /** One markdown text — the spec. The core never inspects it. */
  body: string;
  phase: Phase;
  refs: CardRefs;
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

export type ActivityEvent =
  | { type: "member_joined"; data: { name: string; kind: MemberKind } }
  | { type: "card_created"; data: { title: string } }
  | { type: "card_moved"; data: { from: Phase; to: Phase } }
  | { type: "move_rejected"; data: { from: Phase; to: Phase; reason: string } }
  | { type: "body_set"; data: { bytes: number } }
  | { type: "comment"; data: { text: string } }
  | { type: "refs_set"; data: { refs: CardRefs } }
  | { type: "card_archived"; data: Record<string, never> };

export type ActivityType = ActivityEvent["type"];

export type Activity = ActivityEvent & {
  seq: number;
  /** Null only for `member_joined`. */
  cardId: number | null;
  actorId: number;
  createdAt: number;
};
