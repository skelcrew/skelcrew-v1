import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCore, SCHEMA_VERSION } from "./core";
import { CoreError } from "./errors";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skelcrew-core-"));
  path = join(dir, "skelcrew.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function userVersion(file: string): number {
  const db = new Database(file, { readonly: true });
  try {
    const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
    return row?.user_version ?? -1;
  } finally {
    db.close();
  }
}

test("a core reopened on the same path shows the same members, cards, and activity", () => {
  const first = openCore(path, { owner: "simon" });
  const owner = first.listMembers()[0];
  if (!owner) throw new Error("no owner");
  const agent = first.ensureMember("crew-1", "agent");
  const a = first.createCard({ title: "a", body: "spec a" }, owner.id);
  first.createCard({ title: "b" }, owner.id);
  first.moveCard(a.id, "spec", owner.id);
  first.comment(a.id, "looks good", agent.id);
  first.setRefs(a.id, { branch: "feat/a" }, agent.id);

  const snapshot = {
    members: first.listMembers(),
    cards: first.listCards({ includeArchived: true }),
    details: first.listCards().map((c) => first.getCard(c.id)),
    activity: first.activitySince(0),
  };
  first.close();

  expect(userVersion(path)).toBe(SCHEMA_VERSION);

  const second = openCore(path, { owner: "someone-else" });
  try {
    expect(second.listMembers()).toEqual(snapshot.members);
    expect(second.listCards({ includeArchived: true })).toEqual(snapshot.cards);
    expect(second.listCards().map((c) => second.getCard(c.id))).toEqual(snapshot.details);
    expect(second.activitySince(0)).toEqual(snapshot.activity);
    expect(second.getCard(a.id).activity).toHaveLength(4);
  } finally {
    second.close();
  }
});

test("a database from before any migration is migrated forward on open", () => {
  const raw = new Database(path, { create: true });
  raw.close();
  expect(userVersion(path)).toBe(0);

  const core = openCore(path, { owner: "simon" });
  try {
    expect(core.listMembers()).toHaveLength(1);
    expect(core.listCards()).toEqual([]);
  } finally {
    core.close();
  }
  expect(userVersion(path)).toBe(SCHEMA_VERSION);
});

test("a database with a newer schema version is refused and left untouched", () => {
  const newer = SCHEMA_VERSION + 1;
  const raw = new Database(path, { create: true });
  raw.exec(`PRAGMA user_version = ${newer}`);
  raw.close();
  const before = readFileSync(path);

  let caught: unknown;
  try {
    openCore(path, { owner: "simon" });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CoreError);
  expect((caught as CoreError).code).toBe("conflict");
  expect((caught as CoreError).message).toContain(String(newer));
  expect((caught as CoreError).message).toContain(String(SCHEMA_VERSION));

  expect(readFileSync(path).equals(before)).toBe(true);
  expect(userVersion(path)).toBe(newer);
});

test("open attention requests survive close and reopen", () => {
  const first = openCore(path, { owner: "simon" });
  const owner = first.listMembers()[0];
  if (!owner) throw new Error("no owner");
  const agent = first.ensureMember("crew-1", "agent");
  const a = first.createCard({ title: "a" }, owner.id);
  const b = first.createCard({ title: "b" }, owner.id);
  first.requestAttention(b.id, { to: owner.id, note: "spec ready", moves: ["code"] }, agent.id);
  first.requestAttention(a.id, { to: agent.id, note: "please" }, owner.id);
  const snapshot = { list: first.listAttention(), cards: first.listCards() };
  expect(snapshot.list.map((r) => r.cardId)).toEqual([b.id, a.id]);
  first.close();

  const second = openCore(path, { owner: "simon" });
  try {
    expect(second.listAttention()).toEqual(snapshot.list);
    expect(second.listAttention({ to: owner.id }).map((r) => r.cardId)).toEqual([b.id]);
    expect(second.listCards()).toEqual(snapshot.cards);
    expect(second.getCard(b.id).attention).toEqual(snapshot.cards[1]?.attention ?? null);
  } finally {
    second.close();
  }
});

/** The 002 schema, verbatim: what a database written before this spec's migration holds. */
const SCHEMA_002 = `
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
  PRAGMA user_version = 1;
`;

test("a database created by 002's schema migrates forward and its cards read back with attention null", () => {
  const raw = new Database(path, { create: true });
  raw.exec(SCHEMA_002);
  raw.exec("INSERT INTO members (name, kind, created_at) VALUES ('simon', 'human', 1)");
  raw.exec(
    `INSERT INTO cards (title, body, phase, refs, created_at, updated_at) VALUES ('old', 'b', 'spec', '{"branch":"feat/x"}', 1, 2)`,
  );
  raw.exec(
    `INSERT INTO activity (card_id, actor_id, type, data, created_at) VALUES (1, 1, 'card_created', '{"title":"old"}', 1)`,
  );
  raw.close();
  expect(userVersion(path)).toBe(1);

  const core = openCore(path, { owner: "someone-else" });
  try {
    expect(core.listMembers().map((m) => m.name)).toEqual(["simon"]);
    const [card] = core.listCards();
    expect(card).toEqual({
      id: 1,
      title: "old",
      body: "b",
      phase: "spec",
      refs: { branch: "feat/x" },
      attention: null,
      claim: null,
      archivedAt: null,
      createdAt: 1,
      updatedAt: 2,
    });
    expect(core.getCard(1).attention).toBeNull();
    expect(core.getCard(1).activity).toHaveLength(1);
    expect(core.listAttention()).toEqual([]);
    core.requestAttention(1, { to: 1, note: "after the migration" }, 1);
    expect(core.listAttention().map((r) => r.cardId)).toEqual([1]);
  } finally {
    core.close();
  }
  expect(userVersion(path)).toBe(SCHEMA_VERSION);
});

/** The 010 schema: 002's plus the attention column, at version 2. */
const SCHEMA_010 = `${SCHEMA_002.replace("PRAGMA user_version = 1;", "")}
  ALTER TABLE cards ADD COLUMN attention TEXT;
  PRAGMA user_version = 2;
`;

test("a database created by 010's schema migrates forward and its cards read back with claim null", () => {
  const raw = new Database(path, { create: true });
  raw.exec(SCHEMA_010);
  raw.exec("INSERT INTO members (name, kind, created_at) VALUES ('simon', 'human', 1)");
  raw.exec(
    `INSERT INTO cards (title, body, phase, refs, attention, created_at, updated_at) VALUES ('old', 'b', 'code', '{}', NULL, 1, 2)`,
  );
  raw.exec(
    `INSERT INTO activity (card_id, actor_id, type, data, created_at) VALUES (1, 1, 'card_created', '{"title":"old"}', 1)`,
  );
  raw.close();
  expect(userVersion(path)).toBe(2);

  const core = openCore(path, { owner: "someone-else" });
  try {
    expect(core.listMembers().map((m) => m.name)).toEqual(["simon"]);
    const [card] = core.listCards();
    expect(card).toEqual({
      id: 1,
      title: "old",
      body: "b",
      phase: "code",
      refs: {},
      attention: null,
      claim: null,
      archivedAt: null,
      createdAt: 1,
      updatedAt: 2,
    });
    expect(core.getCard(1).claim).toBeNull();
    expect(core.getCard(1).activity).toHaveLength(1);
    expect(core.sweepClaims()).toEqual([]);
    expect(core.claimCard(1, {}, 1).claim?.by).toBe(1);
  } finally {
    core.close();
  }
  expect(userVersion(path)).toBe(SCHEMA_VERSION);
});

test("claims survive close and reopen", () => {
  const T0 = 1_700_000_000_000;
  const first = openCore(path, { owner: "simon", now: () => T0 });
  const owner = first.listMembers()[0];
  if (!owner) throw new Error("no owner");
  const agent = first.ensureMember("crew-1", "agent");
  const a = first.createCard({ title: "a" }, owner.id);
  const b = first.createCard({ title: "b" }, owner.id);
  first.moveCard(a.id, "spec", owner.id);
  first.moveCard(b.id, "code", owner.id);
  first.claimCard(a.id, { ttlSeconds: 300 }, agent.id);
  first.claimCard(b.id, {}, owner.id);
  const snapshot = { cards: first.listCards(), activity: first.activitySince(0) };
  expect(snapshot.cards.map((c) => c.claim?.by)).toEqual([agent.id, owner.id]);
  first.close();

  const second = openCore(path, { owner: "simon", now: () => T0 + 1000 });
  try {
    expect(second.listCards()).toEqual(snapshot.cards);
    expect(second.getCard(a.id).claim).toEqual({
      by: agent.id,
      claimedAt: T0,
      expiresAt: T0 + 300_000,
      ttlSeconds: 300,
    });
    expect(second.activitySince(0)).toEqual(snapshot.activity);
    // The lease is the same lease: the holder renews it and another agent cannot take it.
    expect(second.heartbeat(a.id, agent.id).claim?.expiresAt).toBe(T0 + 1000 + 300_000);
    const other = second.ensureMember("crew-2", "agent");
    expect(() => second.claimCard(a.id, {}, other.id)).toThrow(CoreError);
  } finally {
    second.close();
  }
});
