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
