/**
 * The board core. EVERY mutation goes through this module and appends an activity
 * row — that log is the SSE feed and the card's run record. Silent mutations are defects.
 *
 * The core also owns the rules the UI must not be trusted with: human-only lane entry
 * (approval gates) and claim leases.
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  Activity,
  ActivityType,
  BoardSnapshot,
  Card,
  CardDetail,
  CardRefs,
  Lane,
  Member,
  MemberKind,
  Stage,
} from "@kanbot/shared";
import { openDb } from "./db.js";

export class BoardError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "BoardError";
    this.status = status;
  }
}

type Row = Record<string, unknown>;

const db: DatabaseSync = openDb();

/** In-process fan-out of activity rows to SSE clients. */
export const events = new EventEmitter<{ activity: [Activity] }>();
events.setMaxListeners(0);

/* ------------------------------------------------------------------ mapping */

function toMember(r: Row): Member {
  return {
    id: r.id as string,
    name: r.name as string,
    kind: r.kind as MemberKind,
    createdAt: Number(r.created_at),
  };
}

function toLane(r: Row): Lane {
  return {
    id: r.id as string,
    name: r.name as string,
    pos: Number(r.pos),
    stage: (r.stage as Stage | null) ?? null,
    humanOnlyEntry: Number(r.human_only_entry) === 1,
  };
}

function toCard(r: Row): Card {
  let refs: CardRefs = {};
  try {
    refs = JSON.parse((r.refs as string) || "{}") as CardRefs;
  } catch {
    refs = {};
  }
  return {
    id: r.id as string,
    laneId: r.lane_id as string,
    pos: Number(r.pos),
    title: r.title as string,
    body: (r.body as string) ?? "",
    spec: (r.spec as string | null) ?? null,
    refs,
    claimedBy: (r.claimed_by as string | null) ?? null,
    claimExpiresAt: r.claim_expires_at == null ? null : Number(r.claim_expires_at),
    waitingOn: (r.waiting_on as string | null) ?? null,
    waitingNote: (r.waiting_note as string | null) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function toActivity(r: Row): Activity {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse((r.data as string) || "{}") as Record<string, unknown>;
  } catch {
    data = {};
  }
  return {
    seq: Number(r.seq),
    cardId: (r.card_id as string | null) ?? null,
    memberId: r.member_id as string,
    type: r.type as ActivityType,
    data,
    createdAt: Number(r.created_at),
  };
}

/* ------------------------------------------------------------------- reads */

export function listMembers(): Member[] {
  return (db.prepare("SELECT * FROM members ORDER BY created_at").all() as Row[]).map(toMember);
}

export function listLanes(): Lane[] {
  return (db.prepare("SELECT * FROM lanes ORDER BY pos").all() as Row[]).map(toLane);
}

export function listCards(): Card[] {
  return (
    db.prepare("SELECT * FROM cards ORDER BY pos, created_at").all() as Row[]
  ).map(toCard);
}

export function getBoard(): BoardSnapshot {
  return { lanes: listLanes(), cards: listCards(), members: listMembers() };
}

export function getMember(id: string): Member {
  const r = db.prepare("SELECT * FROM members WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new BoardError(404, `no such member: ${id}`);
  return toMember(r);
}

export function findMember(id: string | undefined | null): Member | null {
  if (!id) return null;
  const r = db.prepare("SELECT * FROM members WHERE id = ?").get(id) as Row | undefined;
  return r ? toMember(r) : null;
}

/** Single-player first: exactly one human member, the owner. */
export function getOwner(): Member {
  const r = db
    .prepare("SELECT * FROM members WHERE kind = 'human' ORDER BY created_at LIMIT 1")
    .get() as Row | undefined;
  if (!r) throw new BoardError(500, "board has no owner");
  return toMember(r);
}

export function getLane(id: string): Lane {
  const r = db.prepare("SELECT * FROM lanes WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new BoardError(404, `no such lane: ${id}`);
  return toLane(r);
}

export function getLaneByName(name: string): Lane {
  const r = db.prepare("SELECT * FROM lanes WHERE name = ?").get(name) as Row | undefined;
  if (!r) throw new BoardError(404, `no such lane: ${name}`);
  return toLane(r);
}

export function getCard(id: string): Card {
  const r = db.prepare("SELECT * FROM cards WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new BoardError(404, `no such card: ${id}`);
  return toCard(r);
}

export function getCardDetail(id: string): CardDetail {
  const card = getCard(id);
  const activity = (
    db.prepare("SELECT * FROM activity WHERE card_id = ? ORDER BY seq").all(id) as Row[]
  ).map(toActivity);
  return { card, activity };
}

export function recentActivity(limit = 100): Activity[] {
  return (
    db.prepare("SELECT * FROM activity ORDER BY seq DESC LIMIT ?").all(limit) as Row[]
  )
    .map(toActivity)
    .reverse();
}

/* --------------------------------------------------------------- internals */

function log(
  cardId: string | null,
  memberId: string,
  type: ActivityType,
  data: Record<string, unknown> = {},
): Activity {
  const now = Date.now();
  const res = db
    .prepare(
      "INSERT INTO activity (card_id, member_id, type, data, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(cardId, memberId, type, JSON.stringify(data), now);
  const activity: Activity = {
    seq: Number(res.lastInsertRowid),
    cardId,
    memberId,
    type,
    data,
    createdAt: now,
  };
  events.emit("activity", activity);
  return activity;
}

function touch(cardId: string): void {
  db.prepare("UPDATE cards SET updated_at = ? WHERE id = ?").run(Date.now(), cardId);
}

function nextPos(laneId: string): number {
  const r = db
    .prepare("SELECT COALESCE(MAX(pos), -1) AS m FROM cards WHERE lane_id = ?")
    .get(laneId) as Row;
  return Number(r.m) + 1;
}

/** An attention request is answered by the card moving on, or by someone taking it. */
function clearAttention(card: Card, byMemberId: string): void {
  if (!card.waitingOn) return;
  db.prepare("UPDATE cards SET waiting_on = NULL, waiting_note = NULL WHERE id = ?").run(card.id);
  log(card.id, byMemberId, "attention_cleared", { was: card.waitingOn });
}

function claimIsActive(card: Card, now = Date.now()): boolean {
  return card.claimedBy !== null && card.claimExpiresAt !== null && card.claimExpiresAt > now;
}

/* -------------------------------------------------------------- mutations */

/** Idempotent by (name, kind) — re-running a daemon rejoins as the same member. */
export function upsertMember(name: string, kind: MemberKind): Member {
  const trimmed = name.trim();
  if (!trimmed) throw new BoardError(400, "member name is required");
  const existing = db
    .prepare("SELECT * FROM members WHERE name = ? AND kind = ?")
    .get(trimmed, kind) as Row | undefined;
  if (existing) return toMember(existing);

  const member: Member = {
    id: randomUUID(),
    name: trimmed,
    kind,
    createdAt: Date.now(),
  };
  db.prepare("INSERT INTO members (id, name, kind, created_at) VALUES (?, ?, ?, ?)").run(
    member.id,
    member.name,
    member.kind,
    member.createdAt,
  );
  log(null, member.id, "member_joined", { name: member.name, kind: member.kind });
  return member;
}

export function createCard(title: string, body: string, actorId?: string): Card {
  const t = title.trim();
  if (!t) throw new BoardError(400, "card title is required");
  const actor = findMember(actorId) ?? getOwner();
  const ideas = getLaneByName("Ideas");
  const now = Date.now();
  const id = randomUUID();

  db.prepare(
    `INSERT INTO cards (id, lane_id, pos, title, body, spec, refs, claimed_by,
                        claim_expires_at, waiting_on, waiting_note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, '{}', NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(id, ideas.id, nextPos(ideas.id), t, body ?? "", now, now);

  log(id, actor.id, "card_created", { title: t, laneId: ideas.id, lane: ideas.name });
  return getCard(id);
}

/**
 * Approval gates live here, not in the UI: an agent member may never move a card
 * *into* a human-only lane. Rejected with 403.
 */
export function moveCard(cardId: string, laneId: string, actorId: string): Card {
  const card = getCard(cardId);
  const lane = getLane(laneId);
  const actor = getMember(actorId);

  if (lane.humanOnlyEntry && actor.kind !== "human") {
    throw new BoardError(
      403,
      `lane "${lane.name}" is a human-only approval gate; agent "${actor.name}" cannot move cards into it`,
    );
  }
  if (card.laneId === lane.id) return card;

  const from = getLane(card.laneId);
  db.prepare("UPDATE cards SET lane_id = ?, pos = ?, updated_at = ? WHERE id = ?").run(
    lane.id,
    nextPos(lane.id),
    Date.now(),
    cardId,
  );
  log(cardId, actor.id, "card_moved", {
    from: from.name,
    fromLaneId: from.id,
    to: lane.name,
    toLaneId: lane.id,
  });
  clearAttention(card, actor.id);
  return getCard(cardId);
}

export function comment(cardId: string, text: string, actorId: string): Activity {
  const card = getCard(cardId);
  const actor = getMember(actorId);
  const t = (text ?? "").toString();
  if (!t.trim()) throw new BoardError(400, "comment text is required");
  touch(card.id);
  return log(card.id, actor.id, "comment", { text: t });
}

/** The card is the spec while it is drafted; the daemon commits it when development begins. */
export function setSpec(cardId: string, markdown: string, actorId: string): Card {
  const card = getCard(cardId);
  const actor = getMember(actorId);
  if (!markdown || !markdown.trim()) throw new BoardError(400, "spec markdown is required");
  db.prepare("UPDATE cards SET spec = ?, updated_at = ? WHERE id = ?").run(
    markdown,
    Date.now(),
    card.id,
  );
  log(card.id, actor.id, "spec_posted", { chars: markdown.length });
  return getCard(card.id);
}

/** References only — branch names and PR URLs, never a checkout. */
export function setRefs(cardId: string, refs: CardRefs, actorId: string): Card {
  const card = getCard(cardId);
  const actor = getMember(actorId);
  const next: CardRefs = { ...card.refs };
  if (refs.branch !== undefined) next.branch = refs.branch;
  if (refs.prUrl !== undefined) next.prUrl = refs.prUrl;
  db.prepare("UPDATE cards SET refs = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(next),
    Date.now(),
    card.id,
  );
  log(card.id, actor.id, "refs_updated", { ...next });
  return getCard(card.id);
}

/* ------------------------------------------------------------------ leases */

export interface ClaimResult {
  card: Card;
  expiresAt: number;
}

/**
 * Claims are leases. The UPDATE is the atomic test-and-set: it only matches when the
 * card is unclaimed, already ours, or the previous lease has expired.
 */
export function claimCard(cardId: string, actorId: string, ttlSec = 120): ClaimResult {
  const card = getCard(cardId);
  const actor = getMember(actorId);
  const now = Date.now();
  const ttl = Math.max(10, Math.min(3600, Math.floor(ttlSec)));
  const expiresAt = now + ttl * 1000;

  const res = db
    .prepare(
      `UPDATE cards SET claimed_by = ?, claim_expires_at = ?, updated_at = ?
       WHERE id = ?
         AND (claimed_by IS NULL OR claimed_by = ? OR claim_expires_at IS NULL OR claim_expires_at <= ?)`,
    )
    .run(actor.id, expiresAt, now, cardId, actor.id, now);

  if (Number(res.changes) === 0) {
    const holder = findMember(card.claimedBy);
    throw new BoardError(
      409,
      `card is claimed by ${holder ? holder.name : card.claimedBy} until ${new Date(
        card.claimExpiresAt ?? 0,
      ).toISOString()}`,
    );
  }

  if (card.claimedBy !== actor.id) {
    log(cardId, actor.id, "claimed", { ttlSec: ttl, expiresAt });
  }
  // Taking a card answers an outstanding attention request.
  clearAttention(card, actor.id);
  return { card: getCard(cardId), expiresAt };
}

export function heartbeat(cardId: string, actorId: string, ttlSec = 120): ClaimResult {
  const card = getCard(cardId);
  const actor = getMember(actorId);
  if (card.claimedBy !== actor.id) {
    throw new BoardError(409, "card is not claimed by you");
  }
  const ttl = Math.max(10, Math.min(3600, Math.floor(ttlSec)));
  const expiresAt = Date.now() + ttl * 1000;
  db.prepare("UPDATE cards SET claim_expires_at = ? WHERE id = ?").run(expiresAt, cardId);
  return { card: getCard(cardId), expiresAt };
}

export function releaseCard(cardId: string, actorId: string, reason?: string): Card {
  const card = getCard(cardId);
  const actor = getMember(actorId);
  if (card.claimedBy === null) return card;
  if (card.claimedBy !== actor.id && actor.kind !== "human") {
    throw new BoardError(403, "only the claimant or a human member may release a claim");
  }
  db.prepare(
    "UPDATE cards SET claimed_by = NULL, claim_expires_at = NULL, updated_at = ? WHERE id = ?",
  ).run(Date.now(), cardId);
  log(cardId, actor.id, "released", { reason: reason ?? null, was: card.claimedBy });
  return getCard(cardId);
}

/** A dead daemon's card returns to its lane instead of sticking in "claimed". */
export function sweepExpiredClaims(): number {
  const now = Date.now();
  const stale = (
    db
      .prepare(
        "SELECT * FROM cards WHERE claimed_by IS NOT NULL AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?",
      )
      .all(now) as Row[]
  ).map(toCard);
  for (const card of stale) {
    db.prepare(
      "UPDATE cards SET claimed_by = NULL, claim_expires_at = NULL, updated_at = ? WHERE id = ?",
    ).run(now, card.id);
    const holder = findMember(card.claimedBy);
    log(card.id, card.claimedBy ?? "system", "claim_expired", {
      was: card.claimedBy,
      wasName: holder?.name ?? null,
    });
  }
  return stale.length;
}

/* -------------------------------------------------------------- attention */

/** Attention requests are first-class: the owner's queue is the UI's home screen. */
export function requestAttention(
  cardId: string,
  toMemberId: string,
  note: string,
  actorId: string,
): Card {
  const card = getCard(cardId);
  const to = getMember(toMemberId);
  const actor = getMember(actorId);
  const n = (note ?? "").trim() || "needs your attention";
  db.prepare("UPDATE cards SET waiting_on = ?, waiting_note = ?, updated_at = ? WHERE id = ?").run(
    to.id,
    n,
    Date.now(),
    card.id,
  );
  log(card.id, actor.id, "attention_requested", { to: to.id, toName: to.name, note: n });
  return getCard(card.id);
}

export function isClaimActive(card: Card): boolean {
  return claimIsActive(card);
}

let sweeper: NodeJS.Timeout | null = null;
export function startSweeper(intervalMs = 5000): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    try {
      sweepExpiredClaims();
    } catch (err) {
      console.error("[sweeper]", err);
    }
  }, intervalMs);
  sweeper.unref();
}
