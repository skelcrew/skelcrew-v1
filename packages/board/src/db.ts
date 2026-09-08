import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  LANE_AGENT_REVIEW,
  LANE_DEVELOPING,
  LANE_DONE,
  LANE_IDEAS,
  LANE_PR_REVIEW,
  LANE_READY,
  LANE_SPECCING,
  LANE_SPEC_REVIEW,
} from "@kanbot/shared";

const here = dirname(fileURLToPath(import.meta.url));
/** packages/board/data/kanbot.db — gitignored. */
export const DB_PATH = process.env.KANBOT_DB ?? join(here, "..", "data", "kanbot.db");
export const PUBLIC_DIR = join(here, "..", "public");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('human','agent')),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS members_name_kind ON members(name, kind);

CREATE TABLE IF NOT EXISTS lanes (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,
  pos              INTEGER NOT NULL,
  stage            TEXT,
  human_only_entry INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cards (
  id               TEXT PRIMARY KEY,
  lane_id          TEXT NOT NULL REFERENCES lanes(id),
  pos              INTEGER NOT NULL,
  title            TEXT NOT NULL,
  body             TEXT NOT NULL DEFAULT '',
  spec             TEXT,
  refs             TEXT NOT NULL DEFAULT '{}',
  claimed_by       TEXT,
  claim_expires_at INTEGER,
  waiting_on       TEXT,
  waiting_note     TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_lane ON cards(lane_id, pos);

CREATE TABLE IF NOT EXISTS activity (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id    TEXT,
  member_id  TEXT NOT NULL,
  type       TEXT NOT NULL,
  data       TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_card ON activity(card_id, seq);
`;

interface LaneSeed {
  name: string;
  stage: string | null;
  humanOnlyEntry: boolean;
}

const LANE_SEEDS: LaneSeed[] = [
  { name: LANE_IDEAS, stage: null, humanOnlyEntry: false },
  { name: LANE_SPECCING, stage: "spec", humanOnlyEntry: false },
  { name: LANE_SPEC_REVIEW, stage: null, humanOnlyEntry: false },
  { name: LANE_READY, stage: null, humanOnlyEntry: true },
  { name: LANE_DEVELOPING, stage: "develop", humanOnlyEntry: false },
  { name: LANE_AGENT_REVIEW, stage: "review", humanOnlyEntry: false },
  { name: LANE_PR_REVIEW, stage: null, humanOnlyEntry: false },
  { name: LANE_DONE, stage: null, humanOnlyEntry: true },
];

export function openDb(): DatabaseSync {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  seed(db);
  return db;
}

function seed(db: DatabaseSync): void {
  const now = Date.now();

  const laneCount = db.prepare("SELECT COUNT(*) AS n FROM lanes").get() as { n: number };
  if (laneCount.n === 0) {
    const insert = db.prepare(
      "INSERT INTO lanes (id, name, pos, stage, human_only_entry) VALUES (?, ?, ?, ?, ?)",
    );
    LANE_SEEDS.forEach((lane, i) => {
      insert.run(randomUUID(), lane.name, i, lane.stage, lane.humanOnlyEntry ? 1 : 0);
    });
  } else {
    // A board seeded before a lane existed gets it inserted at its seed position.
    const insert = db.prepare(
      "INSERT INTO lanes (id, name, pos, stage, human_only_entry) VALUES (?, ?, ?, ?, ?)",
    );
    LANE_SEEDS.forEach((lane, i) => {
      const exists = db.prepare("SELECT 1 FROM lanes WHERE name = ?").get(lane.name);
      if (exists) return;
      db.prepare("UPDATE lanes SET pos = pos + 1 WHERE pos >= ?").run(i);
      insert.run(randomUUID(), lane.name, i, lane.stage, lane.humanOnlyEntry ? 1 : 0);
    });
  }

  const humanCount = db.prepare(
    "SELECT COUNT(*) AS n FROM members WHERE kind = 'human'",
  ).get() as { n: number };
  if (humanCount.n === 0) {
    let name = "owner";
    try {
      name = os.userInfo().username || "owner";
    } catch {
      /* keep default */
    }
    db.prepare(
      "INSERT INTO members (id, name, kind, created_at) VALUES (?, ?, 'human', ?)",
    ).run(randomUUID(), name, now);
  }
}
