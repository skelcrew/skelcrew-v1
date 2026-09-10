import { beforeEach, describe, expect, test } from "bun:test";
import type { Activity, Attention, Card, Member, Phase } from "@skelcrew/shared";
import {
  BODY_MAX_BYTES,
  BRANCH_MAX_BYTES,
  CLAIM_TTL_DEFAULT_SECONDS,
  CLAIM_TTL_MAX_SECONDS,
  CLAIM_TTL_MIN_SECONDS,
  COMMENT_MAX_BYTES,
  COMMITS_MAX_COUNT,
  MEMBER_NAME_MAX_BYTES,
  PR_URL_MAX_BYTES,
  SPEC_PATH_MAX_BYTES,
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
      set: ["prUrl"],
    });
    expect(core.getCard(card.id).refs).toEqual(third.refs);
  });

  test("setRefs stores a repo-relative spec path verbatim and merges it with the rest", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    core.setRefs(card.id, { branch: "feat/x" }, agent.id);
    core.setRefs(card.id, { prUrl: "https://github.com/o/r/pull/1" }, agent.id);

    const withSpec = core.setRefs(
      card.id,
      { specPath: "docs/specs/011-card-records-its-artefacts.md" },
      agent.id,
    );
    expect(withSpec.refs).toEqual({
      branch: "feat/x",
      prUrl: "https://github.com/o/r/pull/1",
      specPath: "docs/specs/011-card-records-its-artefacts.md",
    });
    expect(core.getCard(card.id).refs).toEqual(withSpec.refs);
  });

  test("a specPath over SPEC_PATH_MAX_BYTES is invalid and changes nothing", () => {
    expect(SPEC_PATH_MAX_BYTES).toBe(256);
    const card = core.createCard({ title: "x" }, owner.id);
    const prefix = "docs/specs/";
    const longest = prefix + "s".repeat(SPEC_PATH_MAX_BYTES - prefix.length);

    expect(core.setRefs(card.id, { specPath: longest }, owner.id).refs.specPath).toBe(longest);
    const before = core.getCard(card.id);
    const seqBefore = core.activitySince(0).at(-1)?.seq ?? 0;

    expectCoreError(() => core.setRefs(card.id, { specPath: `${longest}s` }, owner.id), "invalid");
    // Bytes, not characters: 128 two-byte characters fit, 129 do not.
    core.setRefs(card.id, { specPath: "é".repeat(SPEC_PATH_MAX_BYTES / 2) }, owner.id);
    expectCoreError(
      () => core.setRefs(card.id, { specPath: "é".repeat(SPEC_PATH_MAX_BYTES / 2 + 1) }, owner.id),
      "invalid",
    );

    expect(core.getCard(card.id).refs.specPath).toBe("é".repeat(SPEC_PATH_MAX_BYTES / 2));
    expect(core.activitySince(seqBefore)).toHaveLength(1);
    expect(before.activity).toHaveLength(2);
  });

  test("the refs_set event records the keys the call set, in CardRefs order", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    core.setRefs(
      card.id,
      { branch: "feat/x", commits: ["abcdef0"], specPath: "docs/specs/011-x.md" },
      agent.id,
    );

    core.setRefs(card.id, { prUrl: "https://github.com/o/r/pull/1" }, agent.id);
    const refsSet = events(card.id, "refs_set");
    expect(refsSet[1]?.data).toEqual({
      refs: {
        branch: "feat/x",
        specPath: "docs/specs/011-x.md",
        commits: ["abcdef0"],
        prUrl: "https://github.com/o/r/pull/1",
      },
      set: ["prUrl"],
    });

    // Declaration order, whatever order the caller wrote the patch in.
    core.setRefs(
      card.id,
      {
        prUrl: "https://github.com/o/r/pull/2",
        commits: ["abcdef0"],
        specPath: "docs/specs/011-x.md",
        branch: "feat/x",
      },
      agent.id,
    );
    expect(events(card.id, "refs_set")[2]?.data).toMatchObject({
      set: ["branch", "specPath", "commits", "prUrl"],
    });
  });

  test("a key the core did not set is not in the record", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    core.setRefs(card.id, { branch: "feat/x", prUrl: undefined }, agent.id);
    expect(events(card.id, "refs_set")[0]?.data).toEqual({
      refs: { branch: "feat/x" },
      set: ["branch"],
    });

    // A patch that sets nothing changed nothing, and says so.
    core.setRefs(card.id, {}, agent.id);
    expect(events(card.id, "refs_set")[1]?.data).toEqual({
      refs: { branch: "feat/x" },
      set: [],
    });
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
    ["empty specPath", { specPath: "" }],
    ["specPath over 256 bytes", { specPath: `docs/${"s".repeat(252)}` }],
    ["absolute specPath", { specPath: "/etc/passwd" }],
    ["specPath escaping the repository", { specPath: "docs/../../etc/passwd" }],
    ["specPath with a leading ./", { specPath: "./docs/specs/011-x.md" }],
    ["specPath with a trailing /", { specPath: "docs/specs/" }],
    ["specPath with a newline", { specPath: "docs/specs/011-x.md\nrm -rf /" }],
    ["specPath with a NUL", { specPath: "docs/specs/011-x.md\0.png" }],
    ["specPath not a string", { specPath: 42 }],
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

describe("attention", () => {
  function raise(cardId: number, note = "spec ready", moves: Phase[] = ["code"]) {
    return core.requestAttention(cardId, { to: owner.id, note, moves }, agent.id);
  }

  test("requestAttention sets the request on the card and records attention_requested", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    expect(card.attention).toBeNull();
    const before = Date.now();

    const updated = raise(card.id);

    expect(updated.attention).toEqual({
      to: owner.id,
      note: "spec ready",
      moves: ["code"],
      raisedBy: agent.id,
      raisedAt: expect.any(Number),
    });
    expect(updated.attention?.raisedAt).toBeGreaterThanOrEqual(before);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(card.updatedAt);
    expect(core.getCard(card.id).attention).toEqual(updated.attention);
    expect(core.listCards()[0]?.attention).toEqual(updated.attention);

    // The event carries the same fields as the card, from one clock read: a consumer that
    // sees the event can tell whether it is still the card's open request by equality.
    const requested = events(card.id, "attention_requested");
    expect(requested).toHaveLength(1);
    expect(requested[0]).toEqual({
      seq: expect.any(Number),
      cardId: card.id,
      actorId: agent.id,
      type: "attention_requested",
      data: updated.attention as Attention,
      createdAt: expect.any(Number),
    });
    expect(requested[0]?.data).toEqual({
      to: owner.id,
      note: "spec ready",
      moves: ["code"],
      raisedBy: agent.id,
      raisedAt: updated.attention?.raisedAt as number,
    });
  });

  test("moves defaults to empty; any member may raise to any member, including themselves", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    const toAgent = core.requestAttention(card.id, { to: agent.id, note: "please" }, owner.id);
    expect(toAgent.attention).toMatchObject({ to: agent.id, moves: [], raisedBy: owner.id });

    const toSelf = core.requestAttention(card.id, { to: owner.id, note: "remind me" }, owner.id);
    expect(toSelf.attention).toMatchObject({ to: owner.id, raisedBy: owner.id });
    expect(events(card.id, "attention_requested")[0]?.data).toEqual({
      to: agent.id,
      note: "please",
      moves: [],
      raisedBy: owner.id,
      raisedAt: toAgent.attention?.raisedAt as number,
    });
  });

  test("raising while one is open replaces it and records a second event", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    raise(card.id, "first", ["code"]);
    const second = raise(card.id, "second", ["idea", "code"]);

    expect(second.attention).toMatchObject({ note: "second", moves: ["idea", "code"] });
    const requested = events(card.id, "attention_requested");
    expect(requested.map((e) => (e.type === "attention_requested" ? e.data.note : null))).toEqual([
      "first",
      "second",
    ]);
    expect(events(card.id, "attention_resolved")).toEqual([]);
    expect(core.listAttention()).toHaveLength(1);
  });

  test.each<[string, { to: number; note: string; moves?: Phase[] }, CoreError["code"]]>([
    ["an empty note", { to: 1, note: "" }, "invalid"],
    ["a whitespace-only note", { to: 1, note: " \n" }, "invalid"],
    ["a note over the comment cap", { to: 1, note: "n".repeat(COMMENT_MAX_BYTES + 1) }, "invalid"],
    ["an unknown addressee", { to: 999, note: "hi" }, "not_found"],
    ["a non-integer addressee", { to: 1.5, note: "hi" }, "invalid"],
    ["a move that is not a phase", { to: 1, note: "hi", moves: ["review" as Phase] }, "invalid"],
    ["moves that is not an array", { to: 1, note: "hi", moves: "code" as never }, "invalid"],
  ])("%s is refused and changes nothing", (_label, input, code) => {
    const card = core.createCard({ title: "x" }, owner.id);
    // `to: 1` in the table stands for the owner, whose id is 1 on a fresh core.
    expect(owner.id).toBe(1);
    const before = core.getCard(card.id);
    const activity = core.activitySince(0);

    expectCoreError(() => core.requestAttention(card.id, input, agent.id), code);

    expect(core.getCard(card.id)).toEqual(before);
    expect(core.getCard(card.id).attention).toBeNull();
    expect(core.activitySince(0)).toEqual(activity);
    expect(core.listAttention()).toEqual([]);
  });

  test("a note of exactly the comment cap is accepted", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    const note = "n".repeat(COMMENT_MAX_BYTES);
    expect(raise(card.id, note).attention?.note).toBe(note);
  });

  test("an unknown raiser is not_found and an archived card cannot be waited on", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    expectCoreError(
      () => core.requestAttention(card.id, { to: owner.id, note: "hi" }, 999),
      "not_found",
      "999",
    );
    core.archiveCard(card.id, owner.id);
    expectCoreError(
      () => core.requestAttention(card.id, { to: owner.id, note: "hi" }, agent.id),
      "invalid",
    );
    expect(core.getCard(card.id).attention).toBeNull();
    expect(events(card.id, "attention_requested")).toEqual([]);
  });

  test("a move to a different phase resolves it: card_moved then attention_resolved together", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    raise(card.id);
    const seen: Activity[] = [];
    core.subscribe((event) => seen.push(event));
    const seqBefore = core.activitySince(0).at(-1)?.seq ?? 0;

    const moved = core.moveCard(card.id, "code", owner.id);

    expect(moved.phase).toBe("code");
    expect(moved.attention).toBeNull();
    const since = core.activitySince(seqBefore);
    expect(since.map((e) => e.type)).toEqual(["card_moved", "attention_resolved"]);
    expect(since[1]).toMatchObject({
      cardId: card.id,
      actorId: owner.id,
      data: { how: "moved", phase: "code" },
    });
    expect(seen).toEqual(since);
    expect(core.listAttention()).toEqual([]);
  });

  test("a rejected move leaves the request open and records only move_rejected", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    const raised = raise(card.id);
    const seqBefore = core.activitySince(0).at(-1)?.seq ?? 0;

    expectCoreError(() => core.moveCard(card.id, "code", agent.id), "forbidden");

    expect(core.getCard(card.id).attention).toEqual(raised.attention);
    expect(core.activitySince(seqBefore).map((e) => e.type)).toEqual(["move_rejected"]);
    expect(core.listAttention().map((a) => a.cardId)).toEqual([card.id]);
  });

  test("a same-phase move leaves the request open and records nothing", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    const raised = raise(card.id);
    const before = core.getCard(card.id);

    expect(core.moveCard(card.id, "idea", owner.id)).toEqual(raised);
    expect(core.getCard(card.id)).toEqual(before);
    expect(core.listAttention()).toHaveLength(1);
  });

  test("archiveCard resolves it with how: archived", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    raise(card.id);
    const seqBefore = core.activitySince(0).at(-1)?.seq ?? 0;

    const archived = core.archiveCard(card.id, owner.id);

    expect(archived.attention).toBeNull();
    const since = core.activitySince(seqBefore);
    expect(since.map((e) => e.type)).toEqual(["card_archived", "attention_resolved"]);
    expect(since[1]).toMatchObject({ actorId: owner.id, data: { how: "archived" } });
    expect(core.listAttention()).toEqual([]);
    expect(core.getCard(card.id).attention).toBeNull();
  });

  test("a comment on its own resolves nothing", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    const raised = raise(card.id);
    core.comment(card.id, "yes", owner.id);
    core.comment(card.id, "noted", agent.id);
    expect(core.getCard(card.id).attention).toEqual(raised.attention);
    expect(events(card.id, "attention_resolved")).toEqual([]);
    expect(core.listAttention()).toHaveLength(1);
  });

  test("resolveAttention with text records comment then attention_resolved and clears it", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    raise(card.id);
    const seqBefore = core.activitySince(0).at(-1)?.seq ?? 0;

    const resolved = core.resolveAttention(card.id, "yes", owner.id);

    expect(resolved.attention).toBeNull();
    expect(resolved.phase).toBe("idea");
    const since = core.activitySince(seqBefore);
    expect(since.map((e) => e.type)).toEqual(["comment", "attention_resolved"]);
    expect(since[0]).toMatchObject({ actorId: owner.id, data: { text: "yes" } });
    expect(since[1]).toMatchObject({ actorId: owner.id, data: { how: "answered" } });
    expect(core.getCard(card.id).attention).toBeNull();
    expect(core.listAttention()).toEqual([]);
  });

  test("resolveAttention without text records only the resolution", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    raise(card.id);
    const seqBefore = core.activitySince(0).at(-1)?.seq ?? 0;

    core.resolveAttention(card.id, undefined, owner.id);

    expect(core.activitySince(seqBefore).map((e) => e.type)).toEqual(["attention_resolved"]);
    expect(core.getCard(card.id).attention).toBeNull();
  });

  test("the addressee may answer; another agent is forbidden and it stays open", () => {
    const other = core.ensureMember("crew-9", "agent");
    const card = core.createCard({ title: "x" }, owner.id);
    const raised = core.requestAttention(card.id, { to: agent.id, note: "please" }, owner.id);
    const seqBefore = core.activitySince(0).at(-1)?.seq ?? 0;

    expectCoreError(() => core.resolveAttention(card.id, "me?", other.id), "forbidden", other.name);
    expect(core.getCard(card.id).attention).toEqual(raised.attention);
    expect(core.activitySince(seqBefore)).toEqual([]);

    const resolved = core.resolveAttention(card.id, "done", agent.id);
    expect(resolved.attention).toBeNull();
    expect(core.activitySince(seqBefore).map((e) => [e.type, e.actorId])).toEqual([
      ["comment", agent.id],
      ["attention_resolved", agent.id],
    ]);
  });

  test("the owner may answer a request addressed to an agent", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    core.requestAttention(card.id, { to: agent.id, note: "please" }, owner.id);
    expect(core.resolveAttention(card.id, undefined, owner.id).attention).toBeNull();
  });

  test("an agent may not answer a request addressed to the owner", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    const raised = raise(card.id);
    expectCoreError(() => core.resolveAttention(card.id, "self-approved", agent.id), "forbidden");
    expect(core.getCard(card.id).attention).toEqual(raised.attention);
    expect(events(card.id, "comment")).toEqual([]);
  });

  test("resolving with nothing open is invalid; empty text is invalid and leaves it open", () => {
    const card = core.createCard({ title: "x" }, owner.id);
    expectCoreError(() => core.resolveAttention(card.id, "yes", owner.id), "invalid");
    expectCoreError(() => core.resolveAttention(card.id, undefined, owner.id), "invalid");
    expect(events(card.id)).toHaveLength(1);

    const raised = raise(card.id);
    expectCoreError(() => core.resolveAttention(card.id, "  ", owner.id), "invalid");
    expectCoreError(
      () => core.resolveAttention(card.id, "t".repeat(COMMENT_MAX_BYTES + 1), owner.id),
      "invalid",
    );
    expect(core.getCard(card.id).attention).toEqual(raised.attention);
    expect(events(card.id, "attention_resolved")).toEqual([]);
    expectCoreError(() => core.resolveAttention(card.id, "yes", 999), "not_found", "999");
    expectCoreError(() => core.resolveAttention(999, "yes", owner.id), "not_found", "999");
  });

  test("listAttention returns open requests oldest first with card ids, and filters by to", () => {
    const a = core.createCard({ title: "a" }, owner.id);
    const b = core.createCard({ title: "b" }, owner.id);
    const c = core.createCard({ title: "c" }, owner.id);
    expect(core.listAttention()).toEqual([]);

    const onB = core.requestAttention(b.id, { to: owner.id, note: "b first" }, agent.id);
    const onA = core.requestAttention(a.id, { to: agent.id, note: "a second" }, owner.id);
    const onC = core.requestAttention(
      c.id,
      { to: owner.id, note: "c third", moves: ["pr"] },
      agent.id,
    );

    expect(core.listAttention()).toEqual([
      { cardId: b.id, ...(onB.attention as Attention) },
      { cardId: a.id, ...(onA.attention as Attention) },
      { cardId: c.id, ...(onC.attention as Attention) },
    ]);
    expect(core.listAttention({ to: owner.id }).map((r) => r.cardId)).toEqual([b.id, c.id]);
    expect(core.listAttention({ to: agent.id }).map((r) => r.cardId)).toEqual([a.id]);
    expect(core.listAttention({ to: 999 })).toEqual([]);

    core.resolveAttention(b.id, "ok", owner.id);
    expect(core.listAttention({ to: owner.id }).map((r) => r.cardId)).toEqual([c.id]);
    core.moveCard(c.id, "spec", owner.id);
    expect(core.listAttention({ to: owner.id })).toEqual([]);
    expect(core.listAttention().map((r) => r.cardId)).toEqual([a.id]);
  });
});

describe("claims", () => {
  const T0 = 1_700_000_000_000;
  let clock: number;
  let other: Member;

  // A core on an injected clock, so expiry is exercised by moving `clock`, never by sleeping.
  beforeEach(() => {
    core.close();
    clock = T0;
    core = openCore(":memory:", { owner: "simon", now: () => clock });
    owner = core.listMembers()[0] as Member;
    agent = core.ensureMember("crew-1", "agent");
    other = core.ensureMember("crew-2", "agent");
  });

  function lastSeq(): number {
    return core.activitySince(0).at(-1)?.seq ?? 0;
  }

  test("claimCard takes a card in spec for 120 s and records one claimed event", () => {
    const card = cardIn("spec");
    expect(card.claim).toBeNull();
    const seqBefore = lastSeq();

    const claimed = core.claimCard(card.id, {}, agent.id);

    expect(claimed.claim).toEqual({
      by: agent.id,
      claimedAt: T0,
      expiresAt: T0 + 120_000,
      ttlSeconds: 120,
    });
    expect(claimed.phase).toBe("spec");
    expect(core.getCard(card.id).claim).toEqual(claimed.claim);
    expect(core.listCards()[0]?.claim).toEqual(claimed.claim);
    const since = core.activitySince(seqBefore);
    expect(since).toHaveLength(1);
    expect(since[0]).toMatchObject({
      type: "claimed",
      cardId: card.id,
      actorId: agent.id,
      data: { ttlSeconds: 120, expiresAt: T0 + 120_000 },
    });
  });

  test("claiming again as the holder renews with the given TTL and records nothing", () => {
    const card = cardIn("code");
    core.claimCard(card.id, {}, agent.id);
    clock += 60_000;
    const seqBefore = lastSeq();

    const renewed = core.claimCard(card.id, {}, agent.id);
    expect(renewed.claim).toEqual({
      by: agent.id,
      claimedAt: T0,
      expiresAt: T0 + 60_000 + 120_000,
      ttlSeconds: 120,
    });
    expect(core.activitySince(seqBefore)).toEqual([]);

    const longer = core.claimCard(card.id, { ttlSeconds: 600 }, agent.id);
    expect(longer.claim).toEqual({
      by: agent.id,
      claimedAt: T0,
      expiresAt: T0 + 60_000 + 600_000,
      ttlSeconds: 600,
    });
    expect(core.activitySince(seqBefore)).toEqual([]);
    expect(core.getCard(card.id).claim).toEqual(longer.claim);
  });

  test("a claim on a live claim by anyone else is a conflict naming the holder and the expiry", () => {
    const card = cardIn("spec");
    const claimed = core.claimCard(card.id, {}, agent.id);
    const seqBefore = lastSeq();

    expectCoreError(
      () => core.claimCard(card.id, {}, other.id),
      "conflict",
      agent.name,
      new Date(T0 + 120_000).toISOString(),
    );
    expectCoreError(() => core.claimCard(card.id, {}, owner.id), "conflict", agent.name);

    expect(core.getCard(card.id).claim).toEqual(claimed.claim);
    expect(core.activitySince(seqBefore)).toEqual([]);
  });

  test("ttlSeconds defaults to 120 and is clamped to 10 through 3600", () => {
    expect(CLAIM_TTL_DEFAULT_SECONDS).toBe(120);
    expect(CLAIM_TTL_MIN_SECONDS).toBe(10);
    expect(CLAIM_TTL_MAX_SECONDS).toBe(3600);
    const a = cardIn("spec");
    const b = cardIn("spec");
    const c = cardIn("spec");

    expect(core.claimCard(a.id, { ttlSeconds: 5 }, agent.id).claim).toMatchObject({
      ttlSeconds: 10,
      expiresAt: T0 + 10_000,
    });
    expect(events(a.id, "claimed")[0]?.data).toEqual({ ttlSeconds: 10, expiresAt: T0 + 10_000 });
    expect(core.claimCard(b.id, { ttlSeconds: 9999 }, agent.id).claim).toMatchObject({
      ttlSeconds: 3600,
      expiresAt: T0 + 3_600_000,
    });
    expect(events(b.id, "claimed")[0]?.data).toEqual({
      ttlSeconds: 3600,
      expiresAt: T0 + 3_600_000,
    });
    expect(core.claimCard(c.id, { ttlSeconds: 45 }, agent.id).claim).toMatchObject({
      ttlSeconds: 45,
      expiresAt: T0 + 45_000,
    });
  });

  test("a ttlSeconds that is not an integer is invalid and claims nothing", () => {
    const card = cardIn("spec");
    for (const ttlSeconds of [1.5, Number.NaN, "60", null]) {
      expectCoreError(
        () => core.claimCard(card.id, { ttlSeconds: ttlSeconds as never }, agent.id),
        "invalid",
      );
    }
    expect(core.getCard(card.id).claim).toBeNull();
    expect(events(card.id, "claimed")).toEqual([]);
  });

  test.each<Phase>(["idea", "pr", "done"])("a card in %s is not claimable", (phase) => {
    const card = cardIn(phase);
    expectCoreError(() => core.claimCard(card.id, {}, agent.id), "invalid", phase);
    expectCoreError(() => core.claimCard(card.id, {}, owner.id), "invalid", phase);
    expect(core.getCard(card.id).claim).toBeNull();
    expect(events(card.id, "claimed")).toEqual([]);
  });

  test("an archived card is not claimable; an unknown actor or card is not_found", () => {
    const card = cardIn("spec");
    core.archiveCard(card.id, owner.id);
    const seqBefore = lastSeq();
    expectCoreError(() => core.claimCard(card.id, {}, agent.id), "invalid", "archived");
    expectCoreError(() => core.claimCard(card.id, {}, 999), "not_found", "999");
    expectCoreError(() => core.claimCard(999, {}, agent.id), "not_found", "999");
    expect(core.getCard(card.id).claim).toBeNull();
    expect(core.activitySince(seqBefore)).toEqual([]);
  });

  test("once the clock reaches expiresAt another agent claims over it: run_interrupted, then claimed", () => {
    const card = cardIn("spec");
    const first = core.claimCard(card.id, {}, agent.id);
    clock = T0 + 120_000;
    const seqBefore = lastSeq();
    const seen: Activity[] = [];
    core.subscribe((event) => seen.push(event));

    const second = core.claimCard(card.id, { ttlSeconds: 30 }, other.id);

    expect(second.claim).toEqual({
      by: other.id,
      claimedAt: clock,
      expiresAt: clock + 30_000,
      ttlSeconds: 30,
    });
    const since = core.activitySince(seqBefore);
    expect(since.map((e) => e.type)).toEqual(["run_interrupted", "claimed"]);
    expect(since[0]).toMatchObject({
      cardId: card.id,
      actorId: agent.id,
      data: { by: agent.id, expiresAt: first.claim?.expiresAt as number },
    });
    expect(since[1]).toMatchObject({
      cardId: card.id,
      actorId: other.id,
      data: { ttlSeconds: 30, expiresAt: clock + 30_000 },
    });
    expect(seen).toEqual(since);

    expectCoreError(() => core.heartbeat(card.id, agent.id), "conflict", other.name);
    expect(core.getCard(card.id).claim).toEqual(second.claim);
  });

  test("the holder re-claiming its own lapsed claim is an interruption and a new claim, not a renewal", () => {
    const card = cardIn("code");
    core.claimCard(card.id, {}, agent.id);
    clock = T0 + 200_000;
    const seqBefore = lastSeq();

    const again = core.claimCard(card.id, {}, agent.id);

    expect(again.claim).toEqual({
      by: agent.id,
      claimedAt: clock,
      expiresAt: clock + 120_000,
      ttlSeconds: 120,
    });
    expect(core.activitySince(seqBefore).map((e) => [e.type, e.actorId])).toEqual([
      ["run_interrupted", agent.id],
      ["claimed", agent.id],
    ]);
  });

  test("heartbeat by the holder extends by the original TTL and records nothing", () => {
    const card = cardIn("code");
    core.claimCard(card.id, { ttlSeconds: 60 }, agent.id);
    clock += 45_000;
    const seqBefore = lastSeq();

    const beat = core.heartbeat(card.id, agent.id);

    expect(beat.claim).toEqual({
      by: agent.id,
      claimedAt: T0,
      expiresAt: T0 + 45_000 + 60_000,
      ttlSeconds: 60,
    });
    expect(core.activitySince(seqBefore)).toEqual([]);
    expect(core.getCard(card.id).claim).toEqual(beat.claim);

    clock += 45_000;
    expect(core.heartbeat(card.id, agent.id).claim?.expiresAt).toBe(T0 + 90_000 + 60_000);
    expect(core.activitySince(seqBefore)).toEqual([]);
  });

  test("heartbeat by a non-holder, or with no live claim, is a conflict and changes nothing", () => {
    const card = cardIn("code");
    expectCoreError(() => core.heartbeat(card.id, agent.id), "conflict");

    const claimed = core.claimCard(card.id, {}, agent.id);
    const seqBefore = lastSeq();
    expectCoreError(() => core.heartbeat(card.id, other.id), "conflict", agent.name);
    expectCoreError(() => core.heartbeat(card.id, owner.id), "conflict", agent.name);
    expect(core.getCard(card.id).claim).toEqual(claimed.claim);

    clock = T0 + 120_000;
    expectCoreError(() => core.heartbeat(card.id, agent.id), "conflict");
    // Lapsed and unswept: still visible as stored, with its past expiry.
    expect(core.getCard(card.id).claim).toEqual(claimed.claim);

    expectCoreError(() => core.heartbeat(card.id, 999), "not_found", "999");
    expectCoreError(() => core.heartbeat(999, agent.id), "not_found", "999");
    expect(core.activitySince(seqBefore)).toEqual([]);
  });

  test("releaseCard by the holder clears the claim and records released with the reason", () => {
    const card = cardIn("code");
    core.claimCard(card.id, {}, agent.id);
    const seqBefore = lastSeq();

    const released = core.releaseCard(card.id, { reason: "done" }, agent.id);

    expect(released.claim).toBeNull();
    expect(released.phase).toBe("code");
    const since = core.activitySince(seqBefore);
    expect(since).toHaveLength(1);
    expect(since[0]).toMatchObject({
      type: "released",
      cardId: card.id,
      actorId: agent.id,
      data: { reason: "done" },
    });
    expect(core.getCard(card.id).claim).toBeNull();
    // Released, the card is claimable by anyone again.
    expect(core.claimCard(card.id, {}, other.id).claim?.by).toBe(other.id);
  });

  test("the owner may release anyone's claim; without a reason the event carries null", () => {
    const card = cardIn("code");
    core.claimCard(card.id, {}, agent.id);
    const seqBefore = lastSeq();

    expect(core.releaseCard(card.id, {}, owner.id).claim).toBeNull();

    const since = core.activitySince(seqBefore);
    expect(since.map((e) => e.type)).toEqual(["released"]);
    expect(since[0]).toMatchObject({ actorId: owner.id, data: { reason: null } });
  });

  test("another agent may not release; the claim stands", () => {
    const card = cardIn("code");
    const claimed = core.claimCard(card.id, {}, agent.id);
    const seqBefore = lastSeq();

    expectCoreError(
      () => core.releaseCard(card.id, { reason: "mine now" }, other.id),
      "forbidden",
      other.name,
    );

    expect(core.getCard(card.id).claim).toEqual(claimed.claim);
    expect(core.activitySince(seqBefore)).toEqual([]);
  });

  test("releasing a lapsed claim records the interruption for the former holder, whoever asks", () => {
    const first = cardIn("code");
    const second = cardIn("code");
    core.claimCard(first.id, { ttlSeconds: 30 }, agent.id);
    core.claimCard(second.id, { ttlSeconds: 30 }, agent.id);
    clock = T0 + 30_000;
    const seqBefore = lastSeq();

    // A lapsed claim counts as absent: no forbidden for a non-holder agent.
    const byOther = core.releaseCard(first.id, { reason: "taking over" }, other.id);
    expect(byOther.claim).toBeNull();
    const byOwner = core.releaseCard(second.id, {}, owner.id);
    expect(byOwner.claim).toBeNull();

    const since = core.activitySince(seqBefore);
    expect(since.map((e) => [e.type, e.cardId, e.actorId])).toEqual([
      ["run_interrupted", first.id, agent.id],
      ["run_interrupted", second.id, agent.id],
    ]);
    expect(since[0]?.data).toEqual({ by: agent.id, expiresAt: T0 + 30_000 });
    expect(since[1]?.data).toEqual({ by: agent.id, expiresAt: T0 + 30_000 });
    expect(events(first.id, "released")).toEqual([]);
    expect(core.sweepClaims()).toEqual([]);
    // Cleared, the card is claimable straight away.
    expect(core.claimCard(first.id, {}, other.id).claim?.by).toBe(other.id);
  });

  test("releasing an unclaimed card records nothing, whoever asks", () => {
    const card = cardIn("code");
    const idea = cardIn("idea");
    const before = { card: core.getCard(card.id), idea: core.getCard(idea.id) };

    expect(core.releaseCard(card.id, { reason: "nothing" }, agent.id)).toEqual(card);
    expect(core.releaseCard(card.id, {}, other.id)).toEqual(card);
    expect(core.releaseCard(idea.id, {}, owner.id)).toEqual(idea);
    expect(core.getCard(card.id)).toEqual(before.card);
    expect(core.getCard(idea.id)).toEqual(before.idea);
    expectCoreError(() => core.releaseCard(card.id, {}, 999), "not_found", "999");
    expectCoreError(() => core.releaseCard(999, {}, agent.id), "not_found", "999");
  });

  test("an empty or oversized reason is invalid, whether or not the card is claimed", () => {
    const card = cardIn("code");
    const unclaimed = core.getCard(card.id);
    expectCoreError(() => core.releaseCard(card.id, { reason: "" }, agent.id), "invalid");
    expectCoreError(() => core.releaseCard(card.id, { reason: " \n" }, owner.id), "invalid");
    expect(core.getCard(card.id)).toEqual(unclaimed);

    const claimed = core.claimCard(card.id, {}, agent.id);
    const seqBefore = lastSeq();

    expectCoreError(() => core.releaseCard(card.id, { reason: " \n" }, agent.id), "invalid");
    expectCoreError(
      () => core.releaseCard(card.id, { reason: "r".repeat(COMMENT_MAX_BYTES + 1) }, agent.id),
      "invalid",
    );

    expect(core.getCard(card.id).claim).toEqual(claimed.claim);
    expect(core.activitySince(seqBefore)).toEqual([]);
  });

  test("a move out of the phase by the holder records card_moved then released { reason: moved }", () => {
    const card = cardIn("code");
    core.claimCard(card.id, {}, agent.id);
    const seqBefore = lastSeq();
    const seen: Activity[] = [];
    core.subscribe((event) => seen.push(event));

    const moved = core.moveCard(card.id, "pr", agent.id);

    expect(moved.phase).toBe("pr");
    expect(moved.claim).toBeNull();
    const since = core.activitySince(seqBefore);
    expect(since.map((e) => e.type)).toEqual(["card_moved", "released"]);
    expect(since[1]).toMatchObject({
      cardId: card.id,
      actorId: agent.id,
      data: { reason: "moved" },
    });
    expect(seen).toEqual(since);
    expect(core.getCard(card.id).claim).toBeNull();
  });

  test("a non-holder agent may not move a card with a live claim; the owner may, and it releases", () => {
    const card = cardIn("code");
    const claimed = core.claimCard(card.id, {}, agent.id);
    const seqBefore = lastSeq();

    expectCoreError(() => core.moveCard(card.id, "pr", other.id), "conflict", agent.name);

    expect(core.getCard(card.id).phase).toBe("code");
    expect(core.getCard(card.id).claim).toEqual(claimed.claim);
    expect(core.activitySince(seqBefore)).toEqual([]);

    const moved = core.moveCard(card.id, "pr", owner.id);
    expect(moved.claim).toBeNull();
    expect(core.activitySince(seqBefore).map((e) => [e.type, e.actorId])).toEqual([
      ["card_moved", owner.id],
      ["released", owner.id],
    ]);
  });

  test("a lapsed claim does not block another agent's move; the move records the interruption, not a release", () => {
    const card = cardIn("code");
    core.claimCard(card.id, {}, agent.id);
    clock = T0 + 120_000;
    const seqBefore = lastSeq();

    const moved = core.moveCard(card.id, "pr", other.id);

    expect(moved.claim).toBeNull();
    const since = core.activitySince(seqBefore);
    expect(since.map((e) => [e.type, e.actorId])).toEqual([
      ["card_moved", other.id],
      ["run_interrupted", agent.id],
    ]);
    expect(since[1]?.data).toEqual({ by: agent.id, expiresAt: T0 + 120_000 });
    expect(events(card.id, "released")).toEqual([]);
  });

  test("archiving over a lapsed claim records the interruption, not a release", () => {
    const card = cardIn("spec");
    core.claimCard(card.id, { ttlSeconds: 30 }, agent.id);
    clock = T0 + 30_000;
    const seqBefore = lastSeq();

    const archived = core.archiveCard(card.id, other.id);

    expect(archived.claim).toBeNull();
    const since = core.activitySince(seqBefore);
    expect(since.map((e) => [e.type, e.actorId])).toEqual([
      ["card_archived", other.id],
      ["run_interrupted", agent.id],
    ]);
    expect(since[1]?.data).toEqual({ by: agent.id, expiresAt: T0 + 30_000 });
    expect(core.sweepClaims()).toEqual([]);
  });

  test("a non-holder agent may not archive a card with a live claim; the owner may, and it releases", () => {
    const card = cardIn("code");
    const claimed = core.claimCard(card.id, {}, agent.id);
    const before = core.getCard(card.id);
    const seqBefore = lastSeq();

    expectCoreError(() => core.archiveCard(card.id, other.id), "conflict", agent.name);

    expect(core.getCard(card.id)).toEqual(before);
    expect(core.getCard(card.id).archivedAt).toBeNull();
    expect(core.getCard(card.id).claim).toEqual(claimed.claim);
    expect(core.listCards().map((c) => c.id)).toEqual([card.id]);
    expect(core.activitySince(seqBefore)).toEqual([]);

    // The holder may archive its own claimed card.
    const own = cardIn("code");
    core.claimCard(own.id, {}, agent.id);
    expect(core.archiveCard(own.id, agent.id).claim).toBeNull();

    expect(
      events(own.id)
        .slice(-2)
        .map((e) => [e.type, e.actorId]),
    ).toEqual([
      ["card_archived", agent.id],
      ["released", agent.id],
    ]);

    const archived = core.archiveCard(card.id, owner.id);
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.claim).toBeNull();
    expect(
      events(card.id)
        .slice(-2)
        .map((e) => [e.type, e.actorId]),
    ).toEqual([
      ["card_archived", owner.id],
      ["released", owner.id],
    ]);
  });

  test("a same-phase move leaves the claim alone", () => {
    const card = cardIn("code");
    const claimed = core.claimCard(card.id, {}, agent.id);
    const before = core.getCard(card.id);

    expect(core.moveCard(card.id, "code", owner.id)).toEqual(claimed);
    expect(core.moveCard(card.id, "code", other.id)).toEqual(claimed);
    expect(core.getCard(card.id)).toEqual(before);
  });

  test("a rejected gate move leaves the claim alone and records only move_rejected", () => {
    const card = cardIn("spec");
    const claimed = core.claimCard(card.id, {}, agent.id);
    const seqBefore = lastSeq();

    expectCoreError(() => core.moveCard(card.id, "code", agent.id), "forbidden");

    expect(core.getCard(card.id).claim).toEqual(claimed.claim);
    expect(core.activitySince(seqBefore).map((e) => e.type)).toEqual(["move_rejected"]);
  });

  test("a move releases the claim and resolves the open request in one transaction", () => {
    const card = cardIn("code");
    core.claimCard(card.id, {}, agent.id);
    core.requestAttention(card.id, { to: owner.id, note: "pr ready" }, agent.id);
    const seqBefore = lastSeq();

    const moved = core.moveCard(card.id, "pr", owner.id);

    expect(moved.claim).toBeNull();
    expect(moved.attention).toBeNull();
    expect(core.activitySince(seqBefore).map((e) => e.type)).toEqual([
      "card_moved",
      "released",
      "attention_resolved",
    ]);
  });

  test("archiveCard releases with reason archived", () => {
    const card = cardIn("code");
    core.claimCard(card.id, {}, agent.id);
    const seqBefore = lastSeq();

    const archived = core.archiveCard(card.id, owner.id);

    expect(archived.claim).toBeNull();
    expect(archived.archivedAt).not.toBeNull();
    const since = core.activitySince(seqBefore);
    expect(since.map((e) => e.type)).toEqual(["card_archived", "released"]);
    expect(since[1]).toMatchObject({ actorId: owner.id, data: { reason: "archived" } });
    expect(core.getCard(card.id).claim).toBeNull();
  });

  test("sweepClaims interrupts every lapsed claim, leaves the live one, and returns the ids", () => {
    const a = cardIn("spec");
    const b = cardIn("code");
    const c = cardIn("code");
    core.claimCard(a.id, { ttlSeconds: 10 }, agent.id);
    core.claimCard(b.id, { ttlSeconds: 30 }, other.id);
    clock = T0 + 20_000;
    const live = core.claimCard(c.id, {}, agent.id);
    clock = T0 + 30_000;

    // Before the sweep, the lapsed claims are visible as stored, with their past expiries.
    expect(core.getCard(a.id).claim).toEqual({
      by: agent.id,
      claimedAt: T0,
      expiresAt: T0 + 10_000,
      ttlSeconds: 10,
    });
    expect(core.getCard(b.id).claim).toMatchObject({ by: other.id, expiresAt: T0 + 30_000 });
    expect(core.listCards().map((card) => card.claim?.expiresAt)).toEqual([
      T0 + 10_000,
      T0 + 30_000,
      T0 + 140_000,
    ]);
    const seqBefore = lastSeq();
    const seen: Activity[] = [];
    core.subscribe((event) => seen.push(event));

    expect(core.sweepClaims()).toEqual([a.id, b.id]);

    const since = core.activitySince(seqBefore);
    expect(since).toHaveLength(2);
    expect(since[0]).toMatchObject({
      type: "run_interrupted",
      cardId: a.id,
      actorId: agent.id,
      data: { by: agent.id, expiresAt: T0 + 10_000 },
    });
    expect(since[1]).toMatchObject({
      type: "run_interrupted",
      cardId: b.id,
      actorId: other.id,
      data: { by: other.id, expiresAt: T0 + 30_000 },
    });
    expect(seen).toEqual(since);
    expect(core.getCard(a.id).claim).toBeNull();
    expect(core.getCard(b.id).claim).toBeNull();
    expect(core.getCard(c.id).claim).toEqual(live.claim);
    // The cards stay where they are: back in the queue is a status, not a move.
    expect(core.getCard(a.id).phase).toBe("spec");
    expect(core.getCard(b.id).phase).toBe("code");
    expect(core.getCard(a.id).attention).toBeNull();

    // A second sweep finds nothing.
    const seqAfter = lastSeq();
    expect(core.sweepClaims()).toEqual([]);
    expect(core.activitySince(seqAfter)).toEqual([]);

    // The live one lapses later and is swept then.
    clock = T0 + 140_000;
    expect(core.sweepClaims()).toEqual([c.id]);
    expect(core.activitySince(seqAfter).map((e) => [e.type, e.actorId])).toEqual([
      ["run_interrupted", agent.id],
    ]);
    expect(core.listCards().every((card) => card.claim === null)).toBe(true);
  });

  test("sweepClaims with no claims at all returns nothing and records nothing", () => {
    cardIn("spec");
    const before = core.activitySince(0);
    expect(core.sweepClaims()).toEqual([]);
    expect(core.activitySince(0)).toEqual(before);
  });

  test("a claim survives an unrelated mutation and a comment", () => {
    const card = cardIn("code");
    const claimed = core.claimCard(card.id, {}, agent.id);
    core.comment(card.id, "working", agent.id);
    core.setRefs(card.id, { branch: "feat/x" }, agent.id);
    core.setBody(card.id, "# spec", owner.id);
    expect(core.getCard(card.id).claim).toEqual(claimed.claim);
  });
});
