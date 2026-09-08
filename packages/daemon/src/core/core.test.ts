import { beforeEach, describe, expect, test } from "bun:test";
import type { Activity, Card, Member, Phase } from "@skelcrew/shared";
import {
  BODY_MAX_BYTES,
  BRANCH_MAX_BYTES,
  COMMENT_MAX_BYTES,
  COMMITS_MAX_COUNT,
  MEMBER_NAME_MAX_BYTES,
  PR_URL_MAX_BYTES,
  TITLE_MAX_BYTES,
} from "@skelcrew/shared";
import { type Core, openCore } from "./core";
import { CoreError } from "./errors";

let core: Core;
let owner: Member;
let agent: Member;

beforeEach(() => {
  core = openCore(":memory:", { owner: "simon" });
  owner = core.listMembers()[0] as Member;
  agent = core.ensureMember("crew-1", "agent");
});

function expectCoreError(fn: () => unknown, code: CoreError["code"], ...fragments: string[]) {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CoreError);
  const error = caught as CoreError;
  expect(error.code).toBe(code);
  for (const fragment of fragments) {
    expect(error.message).toContain(fragment);
  }
  return error;
}

function events(cardId: number, type?: Activity["type"]): Activity[] {
  const all = core.getCard(cardId).activity;
  return type ? all.filter((e) => e.type === type) : all;
}

function cardIn(phase: Phase): Card {
  const card = core.createCard({ title: `card in ${phase}` }, owner.id);
  return phase === "idea" ? card : core.moveCard(card.id, phase, owner.id);
}

describe("members", () => {
  test("a fresh core has exactly one member, the human owner, named by the option", () => {
    const fresh = openCore(":memory:", { owner: "simon" });
    const members = fresh.listMembers();
    expect(members).toHaveLength(1);
    expect(members[0]?.kind).toBe("human");
    expect(members[0]?.name).toBe("simon");
    expect(Number.isInteger(members[0]?.id)).toBe(true);
    fresh.close();
  });

  test("without the option the owner is named after the OS user", () => {
    const fresh = openCore(":memory:");
    const [member] = fresh.listMembers();
    expect(member?.kind).toBe("human");
    expect(typeof member?.name).toBe("string");
    expect(member?.name.length).toBeGreaterThan(0);
    fresh.close();
  });

  test("the seeded owner name is trimmed, so a later human join matches it", () => {
    const fresh = openCore(":memory:", { owner: " simon " });
    try {
      expect(fresh.listMembers().map((m) => m.name)).toEqual(["simon"]);
      const [seeded] = fresh.listMembers();
      expect(fresh.ensureMember(" simon ", "human").id).toBe(seeded?.id as number);
      expect(fresh.listMembers()).toHaveLength(1);
    } finally {
      fresh.close();
    }
  });

  test("an empty or whitespace-only owner name is invalid", () => {
    expectCoreError(() => openCore(":memory:", { owner: "" }), "invalid");
    expectCoreError(() => openCore(":memory:", { owner: " \t" }), "invalid");
  });

  test("an owner name over MEMBER_NAME_MAX_BYTES is invalid", () => {
    const longest = "n".repeat(MEMBER_NAME_MAX_BYTES);
    const fresh = openCore(":memory:", { owner: longest });
    expect(fresh.listMembers()[0]?.name).toBe(longest);
    fresh.close();
    expectCoreError(() => openCore(":memory:", { owner: `${longest}n` }), "invalid");
  });

  test("ensureMember is idempotent and logs member_joined once", () => {
    const again = core.ensureMember("crew-1", "agent");
    expect(again.id).toBe(agent.id);
    expect(again).toEqual(agent);
    expect(core.listMembers()).toHaveLength(2);
    const joined = core.activitySince(0).filter((e) => e.type === "member_joined");
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({
      cardId: null,
      actorId: agent.id,
      data: { name: "crew-1", kind: "agent" },
    });
  });

  test("there is never a second human", () => {
    expect(core.ensureMember("simon", "human").id).toBe(owner.id);
    expectCoreError(() => core.ensureMember("someone-else", "human"), "conflict", "simon");
    expect(core.listMembers().filter((m) => m.kind === "human")).toHaveLength(1);
  });

  test("an empty or whitespace-only member name is invalid and joins nothing", () => {
    const before = { members: core.listMembers(), activity: core.activitySince(0) };
    expectCoreError(() => core.ensureMember("", "agent"), "invalid");
    expectCoreError(() => core.ensureMember(" \n\t", "agent"), "invalid");
    expect(core.listMembers()).toEqual(before.members);
    expect(core.activitySince(0)).toEqual(before.activity);
  });

  test("a member name over MEMBER_NAME_MAX_BYTES is invalid and joins nothing", () => {
    expect(MEMBER_NAME_MAX_BYTES).toBe(256);
    const longest = "n".repeat(MEMBER_NAME_MAX_BYTES);
    expect(core.ensureMember(longest, "agent").name).toBe(longest);
    const before = { members: core.listMembers(), activity: core.activitySince(0) };

    expectCoreError(() => core.ensureMember(`${longest}n`, "agent"), "invalid");
    // Bytes, not characters: 128 two-byte characters fit, 129 do not.
    core.ensureMember("é".repeat(MEMBER_NAME_MAX_BYTES / 2), "agent");
    expectCoreError(
      () => core.ensureMember("é".repeat(MEMBER_NAME_MAX_BYTES / 2 + 1), "agent"),
      "invalid",
    );

    expect(core.listMembers()).toHaveLength(before.members.length + 1);
    expect(core.activitySince(0)).toHaveLength(before.activity.length + 1);
  });

  test("getMember returns a member by id and not_found otherwise", () => {
    expect(core.getMember(agent.id)).toEqual(agent);
    expectCoreError(() => core.getMember(999), "not_found", "999");
  });
});

describe("cards", () => {
  test("createCard files an idea with increasing integer ids, listed in creation order", () => {
    const first = core.createCard({ title: "x" }, owner.id);
    const second = core.createCard({ title: "y", body: "hello" }, owner.id);

    expect(Number.isInteger(first.id)).toBe(true);
    expect(first.phase).toBe("idea");
    expect(first.body).toBe("");
    expect(first.refs).toEqual({});
    expect(first.archivedAt).toBeNull();
    expect(typeof first.createdAt).toBe("number");
    expect(first.updatedAt).toBe(first.createdAt);
    expect(second.id).toBeGreaterThan(first.id);
    expect(second.body).toBe("hello");

    expect(core.listCards().map((c) => c.id)).toEqual([first.id, second.id]);
  });

  test("getCard returns the card with its activity, oldest first", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    const detail = core.getCard(card.id);
    expect(detail).toMatchObject(card);
    expect(detail.activity).toHaveLength(1);
    expect(detail.activity[0]).toMatchObject({
      type: "card_created",
      cardId: card.id,
      actorId: owner.id,
      data: { title: "x" },
    });
  });

  test("an unknown card id is not_found and names the id", () => {
    expectCoreError(() => core.getCard(999), "not_found", "999");
  });

  test.each<unknown>([" 1", "1.0", "1e0", "1", 1.5, Number.NaN, null, undefined])(
    "a non-integer id such as %p is invalid, never coerced to a card or member",
    (id) => {
      const card = core.createCard({ title: "x" }, owner.id);
      expect(card.id).toBe(1);
      const before = core.getCard(card.id);

      expectCoreError(() => core.getCard(id as never), "invalid");
      expectCoreError(() => core.getMember(id as never), "invalid");
      expectCoreError(() => core.moveCard(id as never, "spec", agent.id), "invalid");
      expectCoreError(() => core.comment(card.id, "hi", id as never), "invalid");

      expect(core.getCard(card.id)).toEqual(before);
    },
  );

  test("a rejected move names the card by its stored id", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    const error = expectCoreError(() => core.moveCard(card.id, "spec", agent.id), "forbidden");
    expect(error.message).toContain(`card ${card.id}`);
    const [rejected] = events(card.id, "move_rejected");
    expect(rejected?.type === "move_rejected" && rejected.data.reason).toBe(error.message);
  });

  test("an empty title is invalid", () => {
    expectCoreError(() => core.createCard({ title: "   " }, owner.id), "invalid");
    expect(core.listCards()).toHaveLength(0);
  });

  test("a title over TITLE_MAX_BYTES is invalid and files nothing", () => {
    expect(TITLE_MAX_BYTES).toBe(256);
    const accepted = core.createCard({ title: "t".repeat(TITLE_MAX_BYTES) }, owner.id);
    expect(accepted.title).toBe("t".repeat(TITLE_MAX_BYTES));
    const before = { cards: core.listCards(), activity: core.activitySince(0) };

    expectCoreError(
      () => core.createCard({ title: "t".repeat(TITLE_MAX_BYTES + 1) }, owner.id),
      "invalid",
    );
    // Bytes, not characters: 128 two-byte characters fit, 129 do not.
    core.createCard({ title: "é".repeat(TITLE_MAX_BYTES / 2) }, owner.id);
    expectCoreError(
      () => core.createCard({ title: "é".repeat(TITLE_MAX_BYTES / 2 + 1) }, owner.id),
      "invalid",
    );

    expect(core.listCards()).toHaveLength(before.cards.length + 1);
    expect(core.activitySince(0)).toHaveLength(before.activity.length + 1);
  });

  test("a mutation by an unknown actor is not_found and changes nothing", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    const before = { cards: core.listCards(), activity: core.activitySince(0) };

    expectCoreError(() => core.createCard({ title: "y" }, 999), "not_found", "999");
    expectCoreError(() => core.moveCard(card.id, "spec", 999), "not_found", "999");
    expectCoreError(() => core.setBody(card.id, "b", 999), "not_found", "999");
    expectCoreError(() => core.comment(card.id, "c", 999), "not_found", "999");
    expectCoreError(() => core.setRefs(card.id, { branch: "b" }, 999), "not_found", "999");
    expectCoreError(() => core.archiveCard(card.id, 999), "not_found", "999");

    expect(core.listCards()).toEqual(before.cards);
    expect(core.activitySince(0)).toEqual(before.activity);
  });
});

describe("phases and gates", () => {
  test.each<Phase>(["idea", "spec", "pr"])(
    "an agent may not move a card out of %s; the attempt is logged",
    (from) => {
      const card = cardIn(from);
      const to: Phase = from === "pr" ? "done" : "code";
      const seqBefore = core.activitySince(0).at(-1)?.seq ?? 0;

      expectCoreError(() => core.moveCard(card.id, to, agent.id), "forbidden", from, agent.name);

      expect(core.getCard(card.id).phase).toBe(from);
      const since = core.activitySince(seqBefore);
      expect(since).toHaveLength(1);
      expect(since[0]).toMatchObject({
        type: "move_rejected",
        cardId: card.id,
        actorId: agent.id,
        data: { from, to, reason: expect.any(String) },
      });
      expect(events(card.id, "move_rejected")).toEqual(since);
    },
  );

  test("an agent may not move a card out of done", () => {
    const card = cardIn("done");
    expectCoreError(() => core.moveCard(card.id, "pr", agent.id), "forbidden", "done", agent.name);
    expect(core.getCard(card.id).phase).toBe("done");
  });

  test("an agent may move a card out of code, and the owner can send it back", () => {
    const card = cardIn("code");
    const seqBefore = core.activitySince(0).at(-1)?.seq ?? 0;

    const moved = core.moveCard(card.id, "pr", agent.id);
    expect(moved.phase).toBe("pr");
    expect(moved.updatedAt).toBeGreaterThanOrEqual(card.updatedAt);

    const back = core.moveCard(card.id, "code", owner.id);
    expect(back.phase).toBe("code");

    const moves = core.activitySince(seqBefore);
    expect(moves).toHaveLength(2);
    expect(moves[0]).toMatchObject({
      type: "card_moved",
      cardId: card.id,
      actorId: agent.id,
      data: { from: "code", to: "pr" },
    });
    expect(moves[1]).toMatchObject({
      type: "card_moved",
      cardId: card.id,
      actorId: owner.id,
      data: { from: "pr", to: "code" },
    });
  });

  test("the owner may move a card out of every phase, to any phase", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    for (const to of ["spec", "code", "pr", "done", "idea", "done"] as const) {
      expect(core.moveCard(card.id, to, owner.id).phase).toBe(to);
    }
    expect(events(card.id, "card_moved")).toHaveLength(6);
  });

  test("moving into code never inspects the body", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    expect(card.body).toBe("");
    core.moveCard(card.id, "spec", owner.id);
    expect(core.moveCard(card.id, "code", owner.id).phase).toBe("code");
  });

  test("a move to the current phase is a no-op that records nothing", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    const before = core.getCard(card.id);

    expect(core.moveCard(card.id, "idea", owner.id)).toEqual(card);
    expect(core.moveCard(card.id, "idea", agent.id)).toEqual(card);
    expect(core.getCard(card.id)).toEqual(before);
  });

  test("an unknown phase is invalid", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    expectCoreError(() => core.moveCard(card.id, "review" as Phase, owner.id), "invalid", "review");
    expect(core.getCard(card.id).activity).toHaveLength(1);
  });
});

describe("body", () => {
  test("setBody replaces the body and logs the byte length, never the text", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    const text = "héllo"; // 6 bytes in UTF-8, 5 characters
    const updated = core.setBody(card.id, text, agent.id);
    expect(updated.body).toBe(text);

    const [event] = events(card.id, "body_set");
    expect(event).toMatchObject({ actorId: agent.id, data: { bytes: 6 } });
    expect(event?.data).not.toHaveProperty("text");
    expect(JSON.stringify(event)).not.toContain(text);
  });

  test("a body over 64 KiB is invalid and leaves the body unchanged", () => {
    const card = core.setBody(core.createCard({ title: "x" }, owner.id).id, "keep", owner.id);
    const seqBefore = core.activitySince(0).at(-1)?.seq;

    expect(BODY_MAX_BYTES).toBe(64 * 1024);
    core.setBody(card.id, "a".repeat(BODY_MAX_BYTES), owner.id);
    expectCoreError(
      () => core.setBody(card.id, "a".repeat(BODY_MAX_BYTES + 1), owner.id),
      "invalid",
    );
    expectCoreError(
      () => core.createCard({ title: "y", body: "a".repeat(BODY_MAX_BYTES + 1) }, owner.id),
      "invalid",
    );

    expect(core.getCard(card.id).body).toBe("a".repeat(BODY_MAX_BYTES));
    expect(core.activitySince(seqBefore ?? 0)).toHaveLength(1);
  });
});

describe("comments", () => {
  test("a comment records its text and actor", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    const event = core.comment(card.id, "hello", agent.id);
    expect(event).toMatchObject({
      type: "comment",
      cardId: card.id,
      actorId: agent.id,
      data: { text: "hello" },
    });
    expect(events(card.id, "comment")).toEqual([event]);
  });

  test("empty, whitespace-only, and oversized comments are invalid", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    expectCoreError(() => core.comment(card.id, "", owner.id), "invalid");
    expectCoreError(() => core.comment(card.id, "  \n\t", owner.id), "invalid");
    expect(COMMENT_MAX_BYTES).toBe(16 * 1024);
    core.comment(card.id, "a".repeat(COMMENT_MAX_BYTES), owner.id);
    expectCoreError(
      () => core.comment(card.id, "a".repeat(COMMENT_MAX_BYTES + 1), owner.id),
      "invalid",
    );
    expect(events(card.id, "comment")).toHaveLength(1);
  });
});

describe("references", () => {
  test("setRefs merges and logs the resulting refs", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    const first = core.setRefs(card.id, { branch: "feat/x" }, agent.id);
    expect(first.refs).toEqual({ branch: "feat/x" });

    const second = core.setRefs(card.id, { prUrl: "https://github.com/o/r/pull/1" }, agent.id);
    expect(second.refs).toEqual({ branch: "feat/x", prUrl: "https://github.com/o/r/pull/1" });

    const third = core.setRefs(card.id, { commits: ["abcdef0", "a".repeat(40)] }, agent.id);
    expect(third.refs.commits).toEqual(["abcdef0", "a".repeat(40)]);

    const refsSet = events(card.id, "refs_set");
    expect(refsSet).toHaveLength(3);
    expect(refsSet[1]?.data).toEqual({
      refs: { branch: "feat/x", prUrl: "https://github.com/o/r/pull/1" },
    });
    expect(core.getCard(card.id).refs).toEqual(third.refs);
  });

  test("a commit list over COMMITS_MAX_COUNT is invalid and changes nothing", () => {
    expect(COMMITS_MAX_COUNT).toBe(256);
    const card = core.createCard({ title: "x" }, owner.id);
    const sha = (i: number) => i.toString(16).padStart(40, "0");
    const full = Array.from({ length: COMMITS_MAX_COUNT }, (_, i) => sha(i));

    expect(core.setRefs(card.id, { commits: full }, owner.id).refs.commits).toEqual(full);
    const before = core.getCard(card.id);
    const seqBefore = core.activitySince(0).at(-1)?.seq ?? 0;

    expectCoreError(
      () => core.setRefs(card.id, { commits: [...full, sha(COMMITS_MAX_COUNT)] }, owner.id),
      "invalid",
    );

    expect(core.getCard(card.id)).toEqual(before);
    expect(core.activitySince(seqBefore)).toEqual([]);
  });

  test("a sparse commits array is invalid: every slot must be a sha", () => {
    const card = core.setRefs(
      core.createCard({ title: "x" }, owner.id).id,
      { branch: "b" },
      owner.id,
    );
    const before = core.getCard(card.id);
    const sparse: string[] = [];
    sparse[1] = "abcdef0";

    expectCoreError(() => core.setRefs(card.id, { commits: sparse }, owner.id), "invalid");
    expectCoreError(() => core.setRefs(card.id, { commits: new Array(3) }, owner.id), "invalid");

    expect(core.getCard(card.id)).toEqual(before);
  });

  test("a prUrl over PR_URL_MAX_BYTES is invalid and changes nothing", () => {
    expect(PR_URL_MAX_BYTES).toBe(256);
    const card = core.createCard({ title: "x" }, owner.id);
    const prefix = "https://github.com/o/r/pull/1?f=";
    const longest = prefix + "x".repeat(PR_URL_MAX_BYTES - prefix.length);

    expect(core.setRefs(card.id, { prUrl: longest }, owner.id).refs.prUrl).toBe(longest);
    const before = core.getCard(card.id);
    const seqBefore = core.activitySince(0).at(-1)?.seq ?? 0;

    expectCoreError(() => core.setRefs(card.id, { prUrl: `${longest}x` }, owner.id), "invalid");
    const encoded = `${prefix}${encodeURIComponent("x".repeat(1024 * 1024))}`;
    expectCoreError(() => core.setRefs(card.id, { prUrl: encoded }, owner.id), "invalid");

    expect(core.getCard(card.id)).toEqual(before);
    expect(core.activitySince(seqBefore)).toEqual([]);
  });

  test("a branch over BRANCH_MAX_BYTES is invalid and changes nothing", () => {
    expect(BRANCH_MAX_BYTES).toBe(256);
    const card = core.createCard({ title: "x" }, owner.id);
    const longest = "b".repeat(BRANCH_MAX_BYTES);

    expect(core.setRefs(card.id, { branch: longest }, owner.id).refs.branch).toBe(longest);
    const before = core.getCard(card.id);
    const seqBefore = core.activitySince(0).at(-1)?.seq ?? 0;

    expectCoreError(() => core.setRefs(card.id, { branch: `${longest}b` }, owner.id), "invalid");
    // Bytes, not characters: 128 two-byte characters fit, 129 do not.
    core.setRefs(card.id, { branch: "é".repeat(BRANCH_MAX_BYTES / 2) }, owner.id);
    expectCoreError(
      () => core.setRefs(card.id, { branch: "é".repeat(BRANCH_MAX_BYTES / 2 + 1) }, owner.id),
      "invalid",
    );

    expect(core.getCard(card.id).refs.branch).toBe("é".repeat(BRANCH_MAX_BYTES / 2));
    expect(core.activitySince(seqBefore)).toHaveLength(1);
    expect(before.activity).toHaveLength(2);
  });

  test.each<[string, unknown]>([
    ["short commit", { commits: ["abc"] }],
    ["uppercase commit", { commits: ["ABCDEF0"] }],
    ["non-hex commit", { commits: ["abcdefg"] }],
    ["commit over 40 chars", { commits: ["a".repeat(41)] }],
    ["commits not an array", { commits: "abcdef0" }],
    ["http url", { prUrl: "http://github.com/o/r/pull/1" }],
    ["relative url", { prUrl: "/o/r/pull/1" }],
    ["empty branch", { branch: "" }],
    ["branch over 256 bytes", { branch: "b".repeat(257) }],
    ["branch not a string", { branch: 42 }],
    ["unknown key", { issue: "https://github.com/o/r/issues/1" }],
    ["not an object", "feat/x"],
    ["null", null],
  ])("rejects %s and changes nothing", (_label, refs) => {
    const card = core.setRefs(
      core.createCard({ title: "x" }, owner.id).id,
      { branch: "b" },
      owner.id,
    );
    const before = core.getCard(card.id);
    expectCoreError(() => core.setRefs(card.id, refs as never, owner.id), "invalid");
    expect(core.getCard(card.id)).toEqual(before);
  });
});

describe("archiving", () => {
  test("archiving hides a card from listCards but keeps it and its history", () => {
    const kept = core.createCard({ title: "kept" }, owner.id);
    const gone = core.createCard({ title: "gone" }, owner.id);

    const archived = core.archiveCard(gone.id, owner.id);
    expect(typeof archived.archivedAt).toBe("number");
    expect(events(gone.id, "card_archived")).toHaveLength(1);
    expect(events(gone.id, "card_archived")[0]).toMatchObject({ actorId: owner.id });

    expect(core.listCards().map((c) => c.id)).toEqual([kept.id]);
    expect(core.listCards({ includeArchived: true }).map((c) => c.id)).toEqual([kept.id, gone.id]);
    expect(core.getCard(gone.id).activity.map((e) => e.type)).toEqual([
      "card_created",
      "card_archived",
    ]);
  });

  test("an archived card accepts comments and rejects other mutations", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    core.archiveCard(card.id, owner.id);
    const before = core.getCard(card.id);

    expectCoreError(() => core.moveCard(card.id, "spec", owner.id), "invalid");
    expectCoreError(() => core.moveCard(card.id, "idea", owner.id), "invalid");
    expectCoreError(() => core.setBody(card.id, "b", owner.id), "invalid");
    expectCoreError(() => core.setRefs(card.id, { branch: "b" }, owner.id), "invalid");
    expect(core.getCard(card.id)).toEqual(before);

    core.comment(card.id, "still here", agent.id);
    expect(events(card.id, "comment")).toHaveLength(1);
  });

  test("archiving an archived card records nothing", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    const archived = core.archiveCard(card.id, owner.id);
    expect(core.archiveCard(card.id, agent.id)).toEqual(archived);
    expect(events(card.id, "card_archived")).toHaveLength(1);
  });
});

describe("activity", () => {
  test("subscribe delivers every event in seq order until unsubscribed", () => {
    const received: Activity[] = [];
    const unsubscribe = core.subscribe((event) => received.push(event));

    const card = core.createCard({ title: "x" }, owner.id);
    core.moveCard(card.id, "spec", owner.id);
    expect(() => core.moveCard(card.id, "code", agent.id)).toThrow();
    core.moveCard(card.id, "code", owner.id);
    core.setBody(card.id, "body", agent.id);
    core.comment(card.id, "hi", agent.id);
    core.setRefs(card.id, { branch: "feat/x" }, agent.id);
    core.moveCard(card.id, "pr", agent.id);
    core.moveCard(card.id, "code", owner.id);
    core.moveCard(card.id, "code", owner.id); // no-op
    core.ensureMember("crew-2", "agent");
    core.ensureMember("crew-2", "agent"); // no-op
    core.archiveCard(card.id, owner.id);
    core.archiveCard(card.id, owner.id); // no-op
    core.comment(card.id, "bye", owner.id);

    expect(received.map((e) => e.type)).toEqual([
      "card_created",
      "card_moved",
      "move_rejected",
      "card_moved",
      "body_set",
      "comment",
      "refs_set",
      "card_moved",
      "card_moved",
      "member_joined",
      "card_archived",
      "comment",
    ]);
    const seqs = received.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => (seqs[0] as number) + i));
    expect(received).toEqual(core.activitySince(seqs[0] === undefined ? 0 : seqs[0] - 1));

    unsubscribe();
    core.comment(card.id, "unheard", owner.id);
    expect(received).toHaveLength(12);
  });

  test("a listener that mutates re-entrantly never puts another listener out of seq order", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    const seenByA: number[] = [];
    const seenByB: number[] = [];
    core.subscribe((event) => {
      seenByA.push(event.seq);
      if (event.type === "comment" && event.data.text === "outer") {
        core.comment(card.id, "nested", agent.id);
      }
    });
    core.subscribe((event) => seenByB.push(event.seq));

    const outer = core.comment(card.id, "outer", owner.id);

    expect(outer.data).toEqual({ text: "outer" });
    expect(seenByA).toEqual([outer.seq, outer.seq + 1]);
    expect(seenByB).toEqual([outer.seq, outer.seq + 1]);
    const texts = events(card.id, "comment").map((e) =>
      e.type === "comment" ? e.data.text : null,
    );
    expect(texts).toEqual(["outer", "nested"]);
  });

  test("a throwing listener does not stop delivery to the others or the commit", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    const seenByB: number[] = [];
    core.subscribe(() => {
      throw new Error("boom");
    });
    core.subscribe((event) => seenByB.push(event.seq));

    expect(() => core.comment(card.id, "hello", owner.id)).toThrow("boom");

    const [recorded] = events(card.id, "comment");
    expect(recorded?.data).toEqual({ text: "hello" });
    expect(seenByB).toEqual([recorded?.seq as number]);

    // The dispatcher is not wedged: the next mutation still reaches the surviving listener.
    expect(() => core.comment(card.id, "again", owner.id)).toThrow("boom");
    expect(seenByB).toHaveLength(2);
  });

  test("activitySince returns exactly the events after seq", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    core.comment(card.id, "one", owner.id);
    core.comment(card.id, "two", owner.id);
    const all = core.activitySince(0);
    expect(all.map((e) => e.type)).toEqual(["member_joined", "card_created", "comment", "comment"]);

    const pivot = all[1]?.seq as number;
    expect(core.activitySince(pivot)).toEqual(all.slice(2));
    expect(core.activitySince(all.at(-1)?.seq as number)).toEqual([]);
  });

  test("each event carries a seq, card id, actor, type, data, and timestamp", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    const [created] = events(card.id);
    expect(created).toEqual({
      seq: expect.any(Number),
      cardId: card.id,
      actorId: owner.id,
      type: "card_created",
      data: { title: "x" },
      createdAt: expect.any(Number),
    });
  });
});
