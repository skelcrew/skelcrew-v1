/**
 * The core: the only way state changes. Every mutation names an actor, runs in one
 * transaction (read, validate, write, append activity), and emits its events after the
 * commit — a subscriber never sees an event whose row could roll back. The owner's gates
 * are enforced here and nowhere else.
 */
import type { Database } from "bun:sqlite";
import { userInfo } from "node:os";
import {
  type Activity,
  type ActivityEvent,
  type Attention,
  BODY_MAX_BYTES,
  BRANCH_MAX_BYTES,
  type Card,
  type CardDetail,
  type CardRefs,
  COMMENT_MAX_BYTES,
  COMMITS_MAX_COUNT,
  MEMBER_NAME_MAX_BYTES,
  type Member,
  type MemberKind,
  type OpenAttention,
  PHASES,
  type Phase,
  type PhaseDef,
  PR_URL_MAX_BYTES,
  TITLE_MAX_BYTES,
} from "@skelcrew/shared";
import { openDb, SCHEMA_VERSION } from "./db";
import { CoreError } from "./errors";

export { SCHEMA_VERSION };

export interface Core {
  listMembers(): Member[];
  getMember(id: number): Member;
  /** Idempotent by (name, kind): joining twice is one member and one `member_joined`. */
  ensureMember(name: string, kind: MemberKind): Member;

  createCard(input: { title: string; body?: string }, actorId: number): Card;
  listCards(options?: { includeArchived?: boolean }): Card[];
  getCard(id: number): CardDetail;
  moveCard(id: number, phase: Phase, actorId: number): Card;
  setBody(id: number, body: string, actorId: number): Card;
  comment(id: number, text: string, actorId: number): Activity;
  setRefs(id: number, refs: CardRefs, actorId: number): Card;
  archiveCard(id: number, actorId: number): Card;

  /**
   * Hands the card to member `to` with a note and the phases suggested as resolutions.
   * Replaces an open request. Resolved by a move to another phase, by archiving, or by
   * `resolveAttention`; never by a comment alone.
   */
  requestAttention(
    id: number,
    request: { to: number; note: string; moves?: Phase[] },
    actorId: number,
  ): Card;
  /** Answers the open request. Only the addressee or the owner may; `text` is a comment first. */
  resolveAttention(id: number, text: string | undefined, actorId: number): Card;
  /** Open requests, oldest first, optionally only those addressed to `to`. */
  listAttention(options?: { to?: number }): OpenAttention[];

  /** Every event with `seq` greater than the given one, in `seq` order. */
  activitySince(seq: number): Activity[];
  /** Delivers every event as it is recorded, in `seq` order. Returns the unsubscribe. */
  subscribe(listener: (event: Activity) => void): () => void;

  close(): void;
}

interface MemberRow {
  id: number;
  name: string;
  kind: MemberKind;
  created_at: number;
}

interface CardRow {
  id: number;
  title: string;
  body: string;
  phase: Phase;
  refs: string;
  attention: string | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ActivityRow {
  seq: number;
  card_id: number | null;
  actor_id: number;
  type: Activity["type"];
  data: string;
  created_at: number;
}

const COMMIT_SHA = /^[0-9a-f]{7,40}$/;
const REF_KEYS = new Set<keyof CardRefs>(["branch", "commits", "prUrl"]);

function toMember(row: MemberRow): Member {
  return { id: row.id, name: row.name, kind: row.kind, createdAt: row.created_at };
}

function toCard(row: CardRow): Card {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    phase: row.phase,
    refs: JSON.parse(row.refs) as CardRefs,
    attention: row.attention === null ? null : (JSON.parse(row.attention) as Attention),
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toActivity(row: ActivityRow): Activity {
  return {
    seq: row.seq,
    cardId: row.card_id,
    actorId: row.actor_id,
    type: row.type,
    data: JSON.parse(row.data),
    createdAt: row.created_at,
  } as Activity;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** A member name as stored: trimmed, non-empty, within the cap. Seeded owner and joiners alike. */
function memberName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new CoreError("invalid", "member name must not be empty");
  if (byteLength(trimmed) > MEMBER_NAME_MAX_BYTES) {
    throw new CoreError("invalid", `member name exceeds ${MEMBER_NAME_MAX_BYTES} bytes`);
  }
  return trimmed;
}

function phaseDef(phase: Phase): PhaseDef | undefined {
  return PHASES.find((p) => p.id === phase);
}

/**
 * Ids are integers, checked before they reach SQLite: its type affinity would otherwise
 * coerce `" 1"` or `"1e0"` to card 1, and a padded string could ride into an event message.
 */
function requireId(what: "card" | "member", id: number): void {
  if (typeof id !== "number" || !Number.isInteger(id)) {
    throw new CoreError("invalid", `${what} id must be an integer`);
  }
}

function isShaList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  // An index loop, not `every`: `every` skips holes, so a sparse array would pass with nulls.
  for (let i = 0; i < value.length; i += 1) {
    const sha: unknown = value[i];
    if (typeof sha !== "string" || !COMMIT_SHA.test(sha)) return false;
  }
  return true;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** The shape of a refs patch is checked here, before anything is merged or written. */
function validateRefs(refs: unknown): CardRefs {
  if (typeof refs !== "object" || refs === null || Array.isArray(refs)) {
    throw new CoreError("invalid", "refs must be an object");
  }
  const patch: CardRefs = {};
  for (const [key, value] of Object.entries(refs)) {
    if (!REF_KEYS.has(key as keyof CardRefs)) {
      throw new CoreError("invalid", `unknown ref "${key}"`);
    }
    if (value === undefined) continue;
    switch (key as keyof CardRefs) {
      case "branch":
        if (typeof value !== "string" || value.length === 0) {
          throw new CoreError("invalid", "ref branch must be a non-empty string");
        }
        if (byteLength(value) > BRANCH_MAX_BYTES) {
          throw new CoreError("invalid", `ref branch exceeds ${BRANCH_MAX_BYTES} bytes`);
        }
        patch.branch = value;
        break;
      case "commits":
        if (!isShaList(value)) {
          throw new CoreError(
            "invalid",
            "ref commits must be an array of lowercase hex shas of 7 to 40 characters",
          );
        }
        if (value.length > COMMITS_MAX_COUNT) {
          throw new CoreError("invalid", `ref commits exceeds ${COMMITS_MAX_COUNT} entries`);
        }
        patch.commits = value;
        break;
      case "prUrl":
        if (typeof value !== "string" || !isHttpsUrl(value)) {
          throw new CoreError("invalid", "ref prUrl must be an absolute https URL");
        }
        if (byteLength(value) > PR_URL_MAX_BYTES) {
          throw new CoreError("invalid", `ref prUrl exceeds ${PR_URL_MAX_BYTES} bytes`);
        }
        patch.prUrl = value;
        break;
    }
  }
  return patch;
}

export function openCore(path: string, options: { owner?: string } = {}): Core {
  // Validated before the database is touched, so a bad name opens nothing.
  const ownerName = memberName(options.owner ?? userInfo().username);
  const db: Database = openDb(path);
  const listeners = new Set<(event: Activity) => void>();

  const selectMember = db.query<MemberRow, [number]>("SELECT * FROM members WHERE id = ?");
  const selectMembers = db.query<MemberRow, []>("SELECT * FROM members ORDER BY id");
  const selectMemberByName = db.query<MemberRow, [string, MemberKind]>(
    "SELECT * FROM members WHERE name = ? AND kind = ?",
  );
  const selectOwner = db.query<MemberRow, []>("SELECT * FROM members WHERE kind = 'human'");
  const insertMember = db.query<{ id: number }, [string, MemberKind, number]>(
    "INSERT INTO members (name, kind, created_at) VALUES (?, ?, ?) RETURNING id",
  );

  const selectCard = db.query<CardRow, [number]>("SELECT * FROM cards WHERE id = ?");
  const selectCards = db.query<CardRow, []>("SELECT * FROM cards ORDER BY id");
  const selectLiveCards = db.query<CardRow, []>(
    "SELECT * FROM cards WHERE archived_at IS NULL ORDER BY id",
  );
  const insertCard = db.query<{ id: number }, [string, string, number, number]>(
    "INSERT INTO cards (title, body, phase, refs, created_at, updated_at) VALUES (?, ?, 'idea', '{}', ?, ?) RETURNING id",
  );
  const updatePhase = db.query<never, [Phase, number, number]>(
    "UPDATE cards SET phase = ?, updated_at = ? WHERE id = ?",
  );
  const updateBody = db.query<never, [string, number, number]>(
    "UPDATE cards SET body = ?, updated_at = ? WHERE id = ?",
  );
  const updateRefs = db.query<never, [string, number, number]>(
    "UPDATE cards SET refs = ?, updated_at = ? WHERE id = ?",
  );
  const updateArchived = db.query<never, [number, number, number]>(
    "UPDATE cards SET archived_at = ?, updated_at = ? WHERE id = ?",
  );
  const updateAttention = db.query<never, [string | null, number, number]>(
    "UPDATE cards SET attention = ?, updated_at = ? WHERE id = ?",
  );
  // Oldest first means raise order: the seq of the card's latest `attention_requested`,
  // which two raises in the same millisecond still tell apart.
  const RAISED_SEQ =
    "(SELECT MAX(seq) FROM activity WHERE activity.card_id = cards.id AND activity.type = 'attention_requested')";
  const selectOpenAttention = db.query<CardRow, []>(
    `SELECT * FROM cards WHERE attention IS NOT NULL ORDER BY ${RAISED_SEQ}`,
  );
  const selectOpenAttentionTo = db.query<CardRow, [number]>(
    `SELECT * FROM cards WHERE attention IS NOT NULL AND json_extract(attention, '$.to') = ? ORDER BY ${RAISED_SEQ}`,
  );

  const selectCardActivity = db.query<ActivityRow, [number]>(
    "SELECT * FROM activity WHERE card_id = ? ORDER BY seq",
  );
  const selectActivitySince = db.query<ActivityRow, [number]>(
    "SELECT * FROM activity WHERE seq > ? ORDER BY seq",
  );
  const insertActivity = db.query<
    { seq: number },
    [number | null, number, Activity["type"], string, number]
  >(
    "INSERT INTO activity (card_id, actor_id, type, data, created_at) VALUES (?, ?, ?, ?, ?) RETURNING seq",
  );

  function getMember(id: number): Member {
    requireId("member", id);
    const row = selectMember.get(id);
    if (!row) throw new CoreError("not_found", `member ${id} not found`);
    return toMember(row);
  }

  function readCard(id: number): Card {
    requireId("card", id);
    const row = selectCard.get(id);
    if (!row) throw new CoreError("not_found", `card ${id} not found`);
    return toCard(row);
  }

  function readMutableCard(id: number): Card {
    const card = readCard(id);
    if (card.archivedAt !== null) {
      throw new CoreError("invalid", `card ${id} is archived`);
    }
    return card;
  }

  /** The note as stored: non-empty and within the comment cap, like a comment. */
  function requireText(what: "comment" | "note", text: string): void {
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new CoreError("invalid", `${what} must not be empty`);
    }
    if (byteLength(text) > COMMENT_MAX_BYTES) {
      throw new CoreError("invalid", `${what} exceeds ${COMMENT_MAX_BYTES} bytes`);
    }
  }

  function validateMoves(moves: unknown): Phase[] {
    if (moves === undefined) return [];
    if (!Array.isArray(moves)) throw new CoreError("invalid", "moves must be an array of phases");
    for (let i = 0; i < moves.length; i += 1) {
      const move: unknown = moves[i];
      if (typeof move !== "string" || !phaseDef(move as Phase)) {
        throw new CoreError("invalid", `unknown phase "${String(move)}" in moves`);
      }
    }
    return moves as Phase[];
  }

  /**
   * One mutation: `fn` runs inside a transaction and records events through `log`; the
   * events are emitted after the commit. `fn` may return a `CoreError` instead of throwing
   * so that what it recorded (a rejected gate move) is kept and the error still surfaces.
   */
  function mutate<T>(
    fn: (
      log: (cardId: number | null, actorId: number, event: ActivityEvent) => Activity,
    ) => T | CoreError,
  ): T {
    const recorded: Activity[] = [];
    const log = (cardId: number | null, actorId: number, event: ActivityEvent): Activity => {
      const createdAt = Date.now();
      const row = insertActivity.get(
        cardId,
        actorId,
        event.type,
        JSON.stringify(event.data),
        createdAt,
      );
      if (!row) throw new Error("activity insert returned no row");
      const activity = { seq: row.seq, cardId, actorId, createdAt, ...event } as Activity;
      recorded.push(activity);
      return activity;
    };
    const result = db.transaction(() => fn(log))();
    dispatch(recorded);
    if (result instanceof CoreError) throw result;
    return result;
  }

  const pending: Activity[] = [];
  let dispatching = false;

  /**
   * Listeners see events in `seq` order even when one of them mutates from inside its
   * callback: a nested mutation's events queue behind the event being delivered and go out
   * once it has reached every listener. A listener that throws does not stop the others or
   * the drain; the first error is rethrown once the queue is empty.
   */
  function dispatch(events: Activity[]): void {
    pending.push(...events);
    if (dispatching) return;
    dispatching = true;
    let failure: { error: unknown } | undefined;
    try {
      for (let next = pending.shift(); next; next = pending.shift()) {
        for (const listener of [...listeners]) {
          try {
            listener(next);
          } catch (error) {
            failure ??= { error };
          }
        }
      }
    } finally {
      dispatching = false;
    }
    if (failure) throw failure.error;
  }

  function seedOwner(): void {
    if (selectOwner.get()) return;
    insertMember.get(ownerName, "human", Date.now());
  }

  seedOwner();

  return {
    listMembers() {
      return selectMembers.all().map(toMember);
    },

    getMember,

    ensureMember(name, kind) {
      const trimmed = memberName(name);
      return mutate((log) => {
        const existing = selectMemberByName.get(trimmed, kind);
        if (existing) return toMember(existing);
        if (kind === "human") {
          const owner = selectOwner.get() as MemberRow;
          throw new CoreError(
            "conflict",
            `there is one human member, ${owner.name}; ${trimmed} cannot join as a second`,
          );
        }
        const createdAt = Date.now();
        const row = insertMember.get(trimmed, kind, createdAt) as { id: number };
        const member: Member = { id: row.id, name: trimmed, kind, createdAt };
        log(null, member.id, { type: "member_joined", data: { name: trimmed, kind } });
        return member;
      });
    },

    createCard({ title, body = "" }, actorId) {
      return mutate((log) => {
        getMember(actorId);
        if (title.trim().length === 0) throw new CoreError("invalid", "title must not be empty");
        if (byteLength(title) > TITLE_MAX_BYTES) {
          throw new CoreError("invalid", `title exceeds ${TITLE_MAX_BYTES} bytes`);
        }
        if (byteLength(body) > BODY_MAX_BYTES) {
          throw new CoreError("invalid", `body exceeds ${BODY_MAX_BYTES} bytes`);
        }
        const now = Date.now();
        const row = insertCard.get(title, body, now, now) as { id: number };
        log(row.id, actorId, { type: "card_created", data: { title } });
        return readCard(row.id);
      });
    },

    listCards(options = {}) {
      const rows = options.includeArchived ? selectCards.all() : selectLiveCards.all();
      return rows.map(toCard);
    },

    getCard(id) {
      const card = readCard(id);
      return { ...card, activity: selectCardActivity.all(id).map(toActivity) };
    },

    moveCard(id, phase, actorId) {
      return mutate((log) => {
        const actor = getMember(actorId);
        const card = readMutableCard(id);
        if (!phaseDef(phase)) throw new CoreError("invalid", `unknown phase "${phase}"`);
        if (card.phase === phase) return card;
        const from = phaseDef(card.phase) as PhaseDef;
        if (from.exit === "owner" && actor.kind !== "human") {
          const error = new CoreError(
            "forbidden",
            `only the owner may move a card out of ${from.id}; ${actor.name} may not move card ${card.id} to ${phase}`,
          );
          log(id, actorId, {
            type: "move_rejected",
            data: { from: from.id, to: phase, reason: error.message },
          });
          return error;
        }
        const now = Date.now();
        updatePhase.run(phase, now, id);
        log(id, actorId, { type: "card_moved", data: { from: from.id, to: phase } });
        // The move is the decision: an open request resolves in the same transaction.
        if (card.attention !== null) {
          updateAttention.run(null, now, id);
          log(id, actorId, { type: "attention_resolved", data: { how: "moved", phase } });
        }
        return readCard(id);
      });
    },

    setBody(id, body, actorId) {
      return mutate((log) => {
        getMember(actorId);
        readMutableCard(id);
        const bytes = byteLength(body);
        if (bytes > BODY_MAX_BYTES) {
          throw new CoreError("invalid", `body exceeds ${BODY_MAX_BYTES} bytes`);
        }
        updateBody.run(body, Date.now(), id);
        log(id, actorId, { type: "body_set", data: { bytes } });
        return readCard(id);
      });
    },

    comment(id, text, actorId) {
      return mutate((log) => {
        getMember(actorId);
        readCard(id);
        requireText("comment", text);
        return log(id, actorId, { type: "comment", data: { text } });
      });
    },

    setRefs(id, refs, actorId) {
      return mutate((log) => {
        getMember(actorId);
        const card = readMutableCard(id);
        const merged: CardRefs = { ...card.refs, ...validateRefs(refs) };
        updateRefs.run(JSON.stringify(merged), Date.now(), id);
        log(id, actorId, { type: "refs_set", data: { refs: merged } });
        return readCard(id);
      });
    },

    archiveCard(id, actorId) {
      return mutate((log) => {
        getMember(actorId);
        const card = readCard(id);
        if (card.archivedAt !== null) return card;
        const now = Date.now();
        updateArchived.run(now, now, id);
        log(id, actorId, { type: "card_archived", data: {} });
        if (card.attention !== null) {
          updateAttention.run(null, now, id);
          log(id, actorId, { type: "attention_resolved", data: { how: "archived" } });
        }
        return readCard(id);
      });
    },

    requestAttention(id, request, actorId) {
      return mutate((log) => {
        getMember(actorId);
        readMutableCard(id);
        const to = getMember(request.to).id;
        requireText("note", request.note);
        const moves = validateMoves(request.moves);
        const now = Date.now();
        const attention: Attention = {
          to,
          note: request.note,
          moves,
          raisedBy: actorId,
          raisedAt: now,
        };
        updateAttention.run(JSON.stringify(attention), now, id);
        // The event carries the record itself, so a consumer can match it to the card's
        // open request by value rather than by comparing two clock reads.
        log(id, actorId, { type: "attention_requested", data: attention });
        return readCard(id);
      });
    },

    resolveAttention(id, text, actorId) {
      return mutate((log) => {
        const actor = getMember(actorId);
        const card = readCard(id);
        if (card.attention === null) {
          throw new CoreError("invalid", `card ${id} has no open attention request`);
        }
        // Fails closed: an agent cannot clear a request addressed to someone else.
        if (actor.kind !== "human" && actor.id !== card.attention.to) {
          throw new CoreError(
            "forbidden",
            `card ${id} is waiting on member ${card.attention.to}; ${actor.name} may not resolve it`,
          );
        }
        if (text !== undefined) {
          requireText("comment", text);
          log(id, actorId, { type: "comment", data: { text } });
        }
        updateAttention.run(null, Date.now(), id);
        log(id, actorId, { type: "attention_resolved", data: { how: "answered" } });
        return readCard(id);
      });
    },

    listAttention(options = {}) {
      let rows: CardRow[];
      if (options.to === undefined) {
        rows = selectOpenAttention.all();
      } else {
        requireId("member", options.to);
        rows = selectOpenAttentionTo.all(options.to);
      }
      return rows.map((row) => {
        const card = toCard(row);
        return { cardId: card.id, ...(card.attention as Attention) };
      });
    },

    activitySince(seq) {
      return selectActivitySince.all(seq).map(toActivity);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    close() {
      listeners.clear();
      db.close();
    },
  };
}
