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
  CLAIM_TTL_DEFAULT_SECONDS,
  CLAIM_TTL_MAX_SECONDS,
  CLAIM_TTL_MIN_SECONDS,
  type Claim,
  COMMENT_MAX_BYTES,
  COMMITS_MAX_COUNT,
  findControlCharacter,
  MEMBER_NAME_MAX_BYTES,
  type Member,
  type MemberKind,
  type OpenAttention,
  PHASES,
  type Phase,
  type PhaseDef,
  PR_URL_MAX_BYTES,
  type ReviewVerdict,
  SPEC_PATH_MAX_BYTES,
  type TextKind,
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
  /**
   * Records a verdict on the card. A member primitive like `comment`: any member may record
   * one, it moves nothing, and the text is a multi-line field under the comment cap. Findings
   * are required with `changes_requested`; with `approved` the text is optional.
   */
  review(id: number, review: { verdict: ReviewVerdict; text?: string }, actorId: number): Activity;
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

  /**
   * Takes the card as a lease, or renews the actor's own. Succeeds when the card is
   * claimable (phase claimable, not archived, no live claim) or the actor already holds
   * it; `conflict` when someone else does, naming them and the expiry. A lapsed claim
   * counts as absent: claiming over it records `run_interrupted` for its holder first.
   */
  claimCard(id: number, options: { ttlSeconds?: number }, actorId: number): Card;
  /** Extends the actor's live claim by its TTL, recording nothing. Otherwise `conflict`. */
  heartbeat(id: number, actorId: number): Card;
  /** Clears the claim; the holder or the owner may. Unclaimed is a no-op recording nothing. */
  releaseCard(id: number, options: { reason?: string }, actorId: number): Card;
  /**
   * Expires every lapsed claim, recording `run_interrupted` attributed to its former
   * holder, and withdrawing that holder's own open request as `interrupted` — a question
   * nothing can answer once the run is gone. A request raised by any other member stands.
   * The daemon's periodic call, not a member action. Returns the affected ids.
   */
  sweepClaims(): number[];

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
  claim: string | null;
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
/** The verdicts a review may record; anything else is not one. */
const REVIEW_VERDICTS = new Set<ReviewVerdict>(["approved", "changes_requested"]);
/** In `CardRefs` declaration order: what a `refs_set` event records as the keys it set. */
const REF_KEYS = new Set<keyof CardRefs>(["branch", "specPath", "commits", "prUrl"]);

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
    claim: row.claim === null ? null : (JSON.parse(row.claim) as Claim),
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

/**
 * A string the core stores carries no control character: one that reaches a terminal can
 * overwrite the line it is printed on, so an entry could be made to read as something it is
 * not. The set is `@skelcrew/shared`'s, the same one the CLI and the runner escape by; a
 * single-line field refuses `\n` and `\t` with the rest, a multi-line one keeps those two.
 * Checked before the field's own rules, so what the caller is told is the character.
 */
function requireNoControl(what: string, kind: TextKind, value: string): void {
  const found = findControlCharacter(value, kind);
  if (found !== undefined) {
    throw new CoreError(
      "invalid",
      `${what} must not contain the control character ${found.codePoint}`,
    );
  }
}

/** A member name as stored: trimmed, non-empty, within the cap. Seeded owner and joiners alike. */
function memberName(raw: string): string {
  requireNoControl("member name", "single-line", raw);
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

/**
 * A path inside the target repository, as given. Rejects an absolute path, a `..` segment, a
 * leading `./`, a trailing `/`, and any NUL or newline; nothing here is normalised, resolved
 * against a filesystem, or read. Whether the file exists is the runner's business.
 */
function isRepoRelativePath(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("./") || value.endsWith("/")) return false;
  if (value.includes("\0") || value.includes("\n")) return false;
  return !value.split("/").includes("..");
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
        requireNoControl("ref branch", "single-line", value);
        if (byteLength(value) > BRANCH_MAX_BYTES) {
          throw new CoreError("invalid", `ref branch exceeds ${BRANCH_MAX_BYTES} bytes`);
        }
        patch.branch = value;
        break;
      case "specPath":
        // Before the path rule, which has a `\0`/`\n` check of its own: a control character is
        // named as one, and `isRepoRelativePath` stays what it is — a rule about paths.
        if (typeof value === "string") requireNoControl("ref specPath", "single-line", value);
        if (typeof value !== "string" || value.length === 0 || !isRepoRelativePath(value)) {
          throw new CoreError(
            "invalid",
            "ref specPath must be a non-empty path inside the repository, relative to its root",
          );
        }
        if (byteLength(value) > SPEC_PATH_MAX_BYTES) {
          throw new CoreError("invalid", `ref specPath exceeds ${SPEC_PATH_MAX_BYTES} bytes`);
        }
        patch.specPath = value;
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
        // Before the parse: the WHATWG parser strips tab, LF and CR before parsing, so
        // `https://x/\r\ny` is a valid URL to it and the raw string is what would be stored.
        if (typeof value === "string") requireNoControl("ref prUrl", "single-line", value);
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

/**
 * `now` is the clock every timestamp and every expiry check reads. The daemon passes
 * nothing; tests pass one they can move, so a lease lapses without anyone sleeping.
 */
export function openCore(path: string, options: { owner?: string; now?: () => number } = {}): Core {
  // Validated before the database is touched, so a bad name opens nothing.
  const ownerName = memberName(options.owner ?? userInfo().username);
  const now = options.now ?? Date.now;
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
  // Conditional on the card being claimable by this actor at the moment of the write:
  // unclaimed, lapsed, or already theirs. The row count says whether the claim took.
  const updateClaimIfFree = db.query<never, [string, number, number, number, number]>(
    `UPDATE cards SET claim = ?, updated_at = ? WHERE id = ?
       AND (claim IS NULL OR json_extract(claim, '$.expiresAt') <= ? OR json_extract(claim, '$.by') = ?)`,
  );
  const updateClaim = db.query<never, [string | null, number, number]>(
    "UPDATE cards SET claim = ?, updated_at = ? WHERE id = ?",
  );
  const selectLapsedClaims = db.query<CardRow, [number]>(
    "SELECT * FROM cards WHERE claim IS NOT NULL AND json_extract(claim, '$.expiresAt') <= ? ORDER BY id",
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

  /**
   * The note or reason as stored: non-empty and within the comment cap, like a comment, and
   * carrying no control character. The kind is the caller's: a note and a comment are
   * multi-line — they carry excerpts and the runner's laid-out questions — and a release
   * reason is single-line, because the renderer shows it inline in one activity line.
   */
  function requireText(what: "comment" | "note" | "reason", kind: TextKind, text: string): void {
    if (typeof text === "string") requireNoControl(what, kind, text);
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

  /** The lease length as stored: an integer, clamped to the bounds. */
  function claimTtl(ttlSeconds: number | undefined): number {
    if (ttlSeconds === undefined) return CLAIM_TTL_DEFAULT_SECONDS;
    if (typeof ttlSeconds !== "number" || !Number.isInteger(ttlSeconds)) {
      throw new CoreError("invalid", "ttlSeconds must be an integer");
    }
    return Math.min(CLAIM_TTL_MAX_SECONDS, Math.max(CLAIM_TTL_MIN_SECONDS, ttlSeconds));
  }

  /** A claim is live while its expiry is in the future; at or past it, the lease has lapsed. */
  function liveClaim(card: Card, at: number): Claim | null {
    return card.claim !== null && card.claim.expiresAt > at ? card.claim : null;
  }

  function claimConflict(card: Card, claim: Claim): CoreError {
    const holder = selectMember.get(claim.by);
    const who = holder ? holder.name : `member ${claim.by}`;
    return new CoreError(
      "conflict",
      `card ${card.id} is claimed by ${who} until ${new Date(claim.expiresAt).toISOString()}`,
    );
  }

  /**
   * Clears a stored claim as part of a move or an archive. A live claim is released by
   * the actor, whose action ended the work in this phase. A lapsed one was already over:
   * it records the interruption the sweep would have, attributed to the former holder, so
   * a run that died is never written up as a clean handoff.
   */
  function releaseOn(
    card: Card,
    reason: "moved" | "archived",
    at: number,
    actorId: number,
    log: (cardId: number | null, actorId: number, event: ActivityEvent) => Activity,
  ): void {
    if (card.claim === null) return;
    updateClaim.run(null, at, card.id);
    if (card.claim.expiresAt > at) {
      log(card.id, actorId, { type: "released", data: { reason } });
    } else {
      log(card.id, card.claim.by, {
        type: "run_interrupted",
        data: { by: card.claim.by, expiresAt: card.claim.expiresAt },
      });
    }
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
      const createdAt = now();
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
    insertMember.get(ownerName, "human", now());
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
        const createdAt = now();
        const row = insertMember.get(trimmed, kind, createdAt) as { id: number };
        const member: Member = { id: row.id, name: trimmed, kind, createdAt };
        log(null, member.id, { type: "member_joined", data: { name: trimmed, kind } });
        return member;
      });
    },

    createCard({ title, body = "" }, actorId) {
      return mutate((log) => {
        getMember(actorId);
        requireNoControl("title", "single-line", title);
        requireNoControl("body", "multi-line", body);
        if (title.trim().length === 0) throw new CoreError("invalid", "title must not be empty");
        if (byteLength(title) > TITLE_MAX_BYTES) {
          throw new CoreError("invalid", `title exceeds ${TITLE_MAX_BYTES} bytes`);
        }
        if (byteLength(body) > BODY_MAX_BYTES) {
          throw new CoreError("invalid", `body exceeds ${BODY_MAX_BYTES} bytes`);
        }
        const at = now();
        const row = insertCard.get(title, body, at, at) as { id: number };
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
        const at = now();
        // Someone else's live claim is their half-done work: an agent may not hand it off.
        // Unreachable while every phase's exit is the owner's — a non-human actor is turned
        // away above — and kept because it is the rule, not the phase table, that says so. It
        // re-arms the moment a phase is declared `exit: "any"`, and it has no coverage today:
        // see `PhaseDef.exit` in `@skelcrew/shared`, which says the same from that side.
        const live = liveClaim(card, at);
        if (live !== null && live.by !== actorId && actor.kind !== "human") {
          throw claimConflict(card, live);
        }
        updatePhase.run(phase, at, id);
        log(id, actorId, { type: "card_moved", data: { from: from.id, to: phase } });
        // The move ends the work in this phase and is the decision: the claim is released
        // and an open request resolves, all in the same transaction.
        releaseOn(card, "moved", at, actorId, log);
        if (card.attention !== null) {
          updateAttention.run(null, at, id);
          log(id, actorId, { type: "attention_resolved", data: { how: "moved", phase } });
        }
        return readCard(id);
      });
    },

    setBody(id, body, actorId) {
      return mutate((log) => {
        getMember(actorId);
        readMutableCard(id);
        requireNoControl("body", "multi-line", body);
        const bytes = byteLength(body);
        if (bytes > BODY_MAX_BYTES) {
          throw new CoreError("invalid", `body exceeds ${BODY_MAX_BYTES} bytes`);
        }
        updateBody.run(body, now(), id);
        log(id, actorId, { type: "body_set", data: { bytes } });
        return readCard(id);
      });
    },

    comment(id, text, actorId) {
      return mutate((log) => {
        getMember(actorId);
        readCard(id);
        requireText("comment", "multi-line", text);
        return log(id, actorId, { type: "comment", data: { text } });
      });
    },

    review(id, { verdict, text = "" }, actorId) {
      return mutate((log) => {
        getMember(actorId);
        readMutableCard(id);
        if (!REVIEW_VERDICTS.has(verdict)) {
          throw new CoreError(
            "invalid",
            `verdict must be one of ${[...REVIEW_VERDICTS].join(", ")}`,
          );
        }
        // The control-character check first, like every other field: what the caller is told is
        // the character. The text is multi-line — findings are a list, not a line.
        requireNoControl("review", "multi-line", text);
        if (byteLength(text) > COMMENT_MAX_BYTES) {
          throw new CoreError("invalid", `review exceeds ${COMMENT_MAX_BYTES} bytes`);
        }
        // A verdict nobody can act on is not a verdict: changes requested carries its findings.
        // `approved` may carry Minor findings, or nothing at all.
        if (verdict === "changes_requested" && text.trim().length === 0) {
          throw new CoreError("invalid", "changes requested must carry its findings");
        }
        return log(id, actorId, { type: "review_recorded", data: { verdict, text } });
      });
    },

    setRefs(id, refs, actorId) {
      return mutate((log) => {
        getMember(actorId);
        const card = readMutableCard(id);
        const patch = validateRefs(refs);
        const merged: CardRefs = { ...card.refs, ...patch };
        // The keys of the validated patch, so the record can never name one the core rejected.
        const set = [...REF_KEYS].filter((key) => patch[key] !== undefined);
        updateRefs.run(JSON.stringify(merged), now(), id);
        log(id, actorId, { type: "refs_set", data: { refs: merged, set } });
        return readCard(id);
      });
    },

    archiveCard(id, actorId) {
      return mutate((log) => {
        const actor = getMember(actorId);
        const card = readCard(id);
        if (card.archivedAt !== null) return card;
        // Archiving is the owner's, held or free: "done" is a human's call the way merging is,
        // and archiving is the other way a card stops. Refused after the no-op above, which
        // changes nothing and so crosses nothing.
        if (actor.kind !== "human") {
          throw new CoreError(
            "forbidden",
            `only the owner may archive a card; ${actor.name} may not archive card ${id}`,
          );
        }
        const at = now();
        // Archiving ends the holder's run outright; like a move, an agent may not do that to
        // someone else's live claim. The owner may. Unreachable while the rule above stands —
        // and kept for that reason: the rule above is one an owner can drop without touching
        // anything else, and dropping it must not also drop this.
        const live = liveClaim(card, at);
        if (live !== null && live.by !== actorId && actor.kind !== "human") {
          throw claimConflict(card, live);
        }
        updateArchived.run(at, at, id);
        log(id, actorId, { type: "card_archived", data: {} });
        releaseOn(card, "archived", at, actorId, log);
        if (card.attention !== null) {
          updateAttention.run(null, at, id);
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
        requireText("note", "multi-line", request.note);
        const moves = validateMoves(request.moves);
        const at = now();
        const attention: Attention = {
          to,
          note: request.note,
          moves,
          raisedBy: actorId,
          raisedAt: at,
        };
        updateAttention.run(JSON.stringify(attention), at, id);
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
          requireText("comment", "multi-line", text);
          log(id, actorId, { type: "comment", data: { text } });
        }
        updateAttention.run(null, now(), id);
        log(id, actorId, { type: "attention_resolved", data: { how: "answered" } });
        return readCard(id);
      });
    },

    claimCard(id, options, actorId) {
      return mutate((log) => {
        getMember(actorId);
        const card = readMutableCard(id);
        const def = phaseDef(card.phase) as PhaseDef;
        if (!def.claimable) {
          throw new CoreError("invalid", `card ${id} is in ${def.id}, which is not claimable`);
        }
        const ttlSeconds = claimTtl(options.ttlSeconds);
        const at = now();
        const live = liveClaim(card, at);
        if (live !== null && live.by !== actorId) throw claimConflict(card, live);
        // Renewing keeps the lease's start; a lapsed claim is over, so a new one begins.
        const renewing = live !== null;
        const claim: Claim = {
          by: actorId,
          claimedAt: renewing ? live.claimedAt : at,
          expiresAt: at + ttlSeconds * 1000,
          ttlSeconds,
        };
        const { changes } = updateClaimIfFree.run(JSON.stringify(claim), at, id, at, actorId);
        if (changes !== 1) {
          throw new CoreError("conflict", `card ${id} was claimed by someone else first`);
        }
        if (renewing) return readCard(id);
        if (card.claim !== null) {
          log(id, card.claim.by, {
            type: "run_interrupted",
            data: { by: card.claim.by, expiresAt: card.claim.expiresAt },
          });
        }
        log(id, actorId, { type: "claimed", data: { ttlSeconds, expiresAt: claim.expiresAt } });
        return readCard(id);
      });
    },

    heartbeat(id, actorId) {
      return mutate(() => {
        getMember(actorId);
        const card = readCard(id);
        const at = now();
        const live = liveClaim(card, at);
        if (live === null) throw new CoreError("conflict", `card ${id} has no live claim`);
        if (live.by !== actorId) throw claimConflict(card, live);
        const claim: Claim = { ...live, expiresAt: at + live.ttlSeconds * 1000 };
        updateClaim.run(JSON.stringify(claim), at, id);
        return readCard(id);
      });
    },

    releaseCard(id, options, actorId) {
      return mutate((log) => {
        const actor = getMember(actorId);
        const card = readCard(id);
        // A bad reason is a bad call whatever the card's state.
        const reason = options.reason ?? null;
        if (reason !== null) requireText("reason", "single-line", reason);
        if (card.claim === null) return card;
        const at = now();
        // A lapsed claim counts as absent: anyone may clear it, and what is recorded is the
        // interruption of the holder's run, as the sweep would have.
        if (liveClaim(card, at) === null) {
          updateClaim.run(null, at, id);
          log(id, card.claim.by, {
            type: "run_interrupted",
            data: { by: card.claim.by, expiresAt: card.claim.expiresAt },
          });
          return readCard(id);
        }
        // Fails closed: an agent cannot take a card off someone else. The owner may.
        if (actor.kind !== "human" && card.claim.by !== actorId) {
          throw new CoreError(
            "forbidden",
            `card ${id} is claimed by member ${card.claim.by}; ${actor.name} may not release it`,
          );
        }
        updateClaim.run(null, at, id);
        log(id, actorId, { type: "released", data: { reason } });
        return readCard(id);
      });
    },

    sweepClaims() {
      return mutate((log) => {
        const at = now();
        const lapsed = selectLapsedClaims.all(at).map(toCard);
        for (const card of lapsed) {
          const claim = card.claim as Claim;
          updateClaim.run(null, at, card.id);
          log(card.id, claim.by, {
            type: "run_interrupted",
            data: { by: claim.by, expiresAt: claim.expiresAt },
          });
          // A request a lapsed *run* raised goes with the claim: nothing answers a question once
          // the run that asked it is gone, and the card would otherwise be neither running nor
          // queued until a member cleared it by hand. A request raised by anyone else — the
          // agent's own question, the owner's note — stands, because it can still be answered.
          // A human's claim is not a run: nothing heartbeats the claim `skelcrew claim` makes,
          // so the owner's own claim lapses while the owner is still there to answer the note
          // they left, and withdrawing it would hand the card they took to the runner. Fails
          // closed: a holder the members table cannot identify withdraws nothing.
          const holder = selectMember.get(claim.by) ?? undefined;
          if (
            card.attention !== null &&
            card.attention.raisedBy === claim.by &&
            holder !== undefined &&
            holder.kind !== "human"
          ) {
            updateAttention.run(null, at, card.id);
            log(card.id, claim.by, {
              type: "attention_resolved",
              data: { how: "interrupted" },
            });
          }
        }
        return lapsed.map((card) => card.id);
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
