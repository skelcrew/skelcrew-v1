import { Database } from "bun:sqlite";
import { CoreError } from "./errors";

/**
 * Ordered migrations. `PRAGMA user_version` records how many have been applied; opening a
 * database applies the rest in one transaction. A migration is history: never edit one,
 * append the next. The phase list in migration 1 is written out rather than generated from
 * `PHASES` for the same reason — a later change to the track is a later migration.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE members (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    kind       TEXT    NOT NULL CHECK (kind IN ('human', 'agent')),
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX members_name_kind ON members (name, kind);

  CREATE TABLE cards (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    body        TEXT    NOT NULL DEFAULT '',
    phase       TEXT    NOT NULL CHECK (phase IN ('idea', 'spec', 'code', 'pr', 'done')),
    refs        TEXT    NOT NULL DEFAULT '{}',
    archived_at INTEGER,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE activity (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id    INTEGER REFERENCES cards (id),
    actor_id   INTEGER NOT NULL REFERENCES members (id),
    type       TEXT    NOT NULL,
    data       TEXT    NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX activity_card_seq ON activity (card_id, seq);
  `,
  // 010: the open attention request, as JSON `{ to, note, moves, raisedBy, raisedAt }` or
  // NULL. One request per card, so it is a column of the card, like phase.
  `
  ALTER TABLE cards ADD COLUMN attention TEXT;
  `,
  // 009: the claim, as JSON `{ by, claimedAt, expiresAt, ttlSeconds }` or NULL. One holder
  // per card is the point, so it is a column of the card, like attention.
  `
  ALTER TABLE cards ADD COLUMN claim TEXT;
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

function userVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}

/**
 * How long opening waits for another process opening the same database. Opening is the one
 * thing here that waits: two daemons started in the same instant — two `skelcrew` in two
 * terminals, on a directory neither has started one in — both find no socket and both go on to
 * write this file, and before 030 that was two migrations racing, which left one or both dead
 * with `no such table: main.members`. Every write after the open still fails at once rather
 * than waiting: a claim that collides with the daemon's is a conflict to report, not a queue.
 */
const OPEN_BUSY_TIMEOUT_MS = 10_000;

/**
 * Open a database, refuse one written by a newer skelcrew, and migrate an older one forward.
 * The version check comes before any pragma that writes: a refused file is left as found.
 */
export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  try {
    db.exec("PRAGMA foreign_keys = ON");
    // Set before the first read of the file, because reading is where waiting starts: a
    // database another process is creating, or whose journal it is recovering, answers
    // "locked" rather than "empty". Neither pragma writes anything, so the version check
    // below still comes before any write.
    db.exec(`PRAGMA busy_timeout = ${OPEN_BUSY_TIMEOUT_MS}`);
    const version = userVersion(db);
    if (version > SCHEMA_VERSION) {
      throw new CoreError(
        "conflict",
        `database ${path} has schema version ${version}; this skelcrew knows version ${SCHEMA_VERSION}`,
      );
    }
    // The wait stays on until `finishOpening`: the caller's own first writes are part of
    // opening and race the same way — `openCore` seeds the owner, which is the daemon's very
    // first insert into a database it just made.
    enableWal(db);
    if (version < SCHEMA_VERSION) migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * The end of the open: from here a write that collides with another process's fails at once
 * rather than waiting, which is what a claim taken twice must do — a conflict to report, not a
 * queue to join.
 */
export function finishOpening(db: Database): void {
  db.exec("PRAGMA busy_timeout = 0");
}

function journalMode(db: Database): string {
  const row = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
  return row?.journal_mode ?? "";
}

/**
 * WAL, which is a property of the file rather than of this connection: whoever creates the
 * database converts it and every later connection follows, so the common case is the read below
 * and nothing more.
 *
 * A refusal is not fatal, and is the one write of the open that the wait above cannot cover:
 * SQLite declines a journal-mode change while another connection holds the database and does not
 * run the busy handler for it, so two processes creating the file in the same instant cannot
 * both convert it — and made to wait for each other, neither could, since waiting means holding
 * it. One of the two is about to find the socket taken and exit anyway. The daemon that goes on
 * runs on the mode the file is in, which is correct if less concurrent, and the next start on a
 * quiet directory converts it.
 */
function enableWal(db: Database): void {
  if (journalMode(db) === "wal") return;
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch {
    // Another connection holds the file; see above.
  }
}

/**
 * The migrations this database is missing, applied once however many processes ask at once.
 * `BEGIN EXCLUSIVE` takes the write lock before anything is read, so a second opener waits
 * here rather than migrating in parallel, and the version is re-read *inside* the lock — the
 * one read outside it may be what the winner has already replaced, and applying a migration
 * twice is what fails.
 */
function migrate(db: Database): void {
  db.exec("BEGIN EXCLUSIVE");
  try {
    for (let next = userVersion(db); next < SCHEMA_VERSION; next += 1) {
      db.exec(MIGRATIONS[next] as string);
      db.exec(`PRAGMA user_version = ${next + 1}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
