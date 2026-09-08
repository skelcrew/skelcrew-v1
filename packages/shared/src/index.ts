/**
 * @kanbot/shared — pure types shared by the board and the daemon.
 * No runtime dependencies, no I/O.
 */

export type MemberKind = "human" | "agent";

/** A lane that maps to a daemon stage carries a stage tag; the rest are review/parking lanes. */
export type Stage = "spec" | "develop" | "review";

export interface Member {
  id: string;
  name: string;
  kind: MemberKind;
  createdAt: number;
}

export interface Lane {
  id: string;
  name: string;
  pos: number;
  /** Non-null lanes are dispatchable by the daemon. */
  stage: Stage | null;
  /** Only human members may move a card *into* this lane (approval gate). */
  humanOnlyEntry: boolean;
}

/** References only — the board never stores repository contents. */
export interface CardRefs {
  branch?: string;
  prUrl?: string;
}

export interface Card {
  id: string;
  laneId: string;
  pos: number;
  title: string;
  body: string;
  spec: string | null;
  refs: CardRefs;
  claimedBy: string | null;
  claimExpiresAt: number | null;
  waitingOn: string | null;
  waitingNote: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ActivityType =
  | "member_joined"
  | "card_created"
  | "card_moved"
  | "comment"
  | "spec_posted"
  | "refs_updated"
  | "claimed"
  | "released"
  | "claim_expired"
  | "attention_requested"
  | "attention_cleared";

export interface Activity {
  seq: number;
  cardId: string | null;
  memberId: string;
  type: ActivityType;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface BoardSnapshot {
  lanes: Lane[];
  cards: Card[];
  members: Member[];
}

export interface CardDetail {
  card: Card;
  activity: Activity[];
}

/** Canonical lane names. The daemon resolves lane ids by these names. */
export const LANE_IDEAS = "Ideas";
export const LANE_SPECCING = "Spec'ing";
export const LANE_SPEC_REVIEW = "Spec review";
export const LANE_READY = "Ready";
export const LANE_DEVELOPING = "Developing";
export const LANE_AGENT_REVIEW = "Agent review";
export const LANE_PR_REVIEW = "PR review";
export const LANE_DONE = "Done";

/** Where a stage hands its card when the run finishes (review only on APPROVED). */
export const STAGE_HANDOFF: Record<Stage, string> = {
  spec: LANE_SPEC_REVIEW,
  develop: LANE_AGENT_REVIEW,
  review: LANE_PR_REVIEW,
};

/** CHANGES REQUESTED bounces beyond this go to the owner instead of back to Developing. */
export const REVIEW_CYCLE_BUDGET = 3;

export interface ApiError {
  error: string;
}
