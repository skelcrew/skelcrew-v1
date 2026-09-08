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
];

export const SCHEMA_VERSION = MIGRATIONS.length;

function userVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}

/**
 * Open a database, refuse one written by a newer skelcrew, and migrate an older one forward.
 * The version check comes before any pragma that writes: a refused file is left as found.
 */
export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const version = userVersion(db);
    if (version > SCHEMA_VERSION) {
      throw new CoreError(
        "conflict",
        `database ${path} has schema version ${version}; this skelcrew knows version ${SCHEMA_VERSION}`,
      );
    }
    db.exec("PRAGMA journal_mode = WAL");
    if (version < SCHEMA_VERSION) {
      db.transaction(() => {
        for (let next = version; next < SCHEMA_VERSION; next += 1) {
          db.exec(MIGRATIONS[next] as string);
          db.exec(`PRAGMA user_version = ${next + 1}`);
        }
      })();
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
