/**
 * The merge poll, as a member sees it on the card: against the real core and a faked forge.
 * No test here spawns `gh` — the forge is the boundary, and what it answers is the whole of
 * what the daemon knows about the pull request.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Activity, Card, Member, Phase } from "@skelcrew/shared";
import { type Core, openCore } from "./core/core";
import { MERGE_POLL_INTERVAL_MS, mergePoll, mergePollIntervalFromEnv } from "./merges";
import type { Forge, PullRequest } from "./runner/forge";

const REPO_URL = "https://example.invalid/skelcrew/skelcrew";
const OTHER_REPO_URL = "https://example.invalid/someone/else";
const PR_URL = `${REPO_URL}/pull/1`;
const BRANCH = "skelcrew/1-a-card";
const MERGED_AT = "2026-09-09T08:44:11Z";

let core: Core;
let owner: Member;
let runnerMember: Member;
let crew: Member;
const warnings: string[] = [];

beforeEach(() => {
  core = openCore(":memory:", { owner: "simon" });
  owner = core.listMembers()[0] as Member;
  runnerMember = core.ensureMember("runner", "agent");
  crew = core.ensureMember("crew", "agent");
  warnings.length = 0;
});

function mergedPr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    url: PR_URL,
    state: "merged",
    mergedAt: MERGED_AT,
    headRefName: BRANCH,
    baseRepo: REPO_URL,
    ...overrides,
  };
}

function openPr(): PullRequest {
  return { url: PR_URL, state: "open", headRefName: BRANCH, baseRepo: REPO_URL };
}

function closedPr(): PullRequest {
  return { url: PR_URL, state: "closed", headRefName: BRANCH, baseRepo: REPO_URL };
}

interface FakeForge extends Forge {
  /** Every pull request URL the poll asked about, in order. */
  asked: string[];
  /** How many times the poll asked what repository it is watching. */
  repoAsks: number;
}

/**
 * A forge that answers from a table. `repoUrl` present and undefined is `gh` unable to answer
 * about the repository itself, the way an absent or logged-out `gh` cannot.
 */
function fakeForge(
  options: { answer?: (url: string) => PullRequest | undefined; repoUrl?: string | undefined } = {},
): FakeForge {
  const forge: FakeForge = {
    asked: [],
    repoAsks: 0,
    async pullRequest(_repoRoot, url) {
      forge.asked.push(url);
      return options.answer?.(url);
    },
    async repoUrl() {
      forge.repoAsks += 1;
      return "repoUrl" in options ? options.repoUrl : REPO_URL;
    },
  };
  return forge;
}

function poll(forge: Forge, over: Core = core) {
  return mergePoll({
    core: over,
    forge,
    repoRoot: "/repo",
    runnerId: runnerMember.id,
    warn: (line) => warnings.push(line),
  });
}

/** A card the owner has approved into PR, with the refs a Code run left on it. */
function cardInPr(refs: { branch?: string; prUrl?: string } = { branch: BRANCH, prUrl: PR_URL }) {
  const card = core.createCard({ title: "a card" }, owner.id);
  core.setRefs(card.id, refs, crew.id);
  return core.moveCard(card.id, "pr", owner.id);
}

function activity(cardId: number): Activity[] {
  return core.getCard(cardId).activity;
}

function comments(cardId: number): string[] {
  return activity(cardId)
    .filter((e) => e.type === "comment")
    .map((e) => e.data.text);
}

const MISMATCH = `pull request ${PR_URL} is merged, but it is not this card's work: `;

// --- criterion 2: the merge lands the card in Done ---

test("a merged pull request of this card's own work lands it in Done, the runner saying why first", async () => {
  const card = cardInPr();
  const forge = fakeForge({ answer: () => mergedPr() });
  const poller = poll(forge);

  await poller.tick();

  expect(core.getCard(card.id).phase).toBe("done");
  const last = activity(card.id).slice(-2);
  expect(last[0]).toMatchObject({
    type: "comment",
    actorId: runnerMember.id,
    data: { text: `pull request ${PR_URL} merged at ${MERGED_AT}` },
  });
  expect(last[1]).toMatchObject({
    type: "card_moved",
    actorId: owner.id,
    data: { from: "pr", to: "done" },
  });
  // Nothing waits on the owner: the merge was the gesture, and a request would be a second one.
  expect(core.listAttention()).toEqual([]);
  expect(core.getCard(card.id).attention).toBeNull();
  expect(warnings).toEqual([]);

  // And the card, now in Done, is not asked about again.
  await poller.tick();
  expect(forge.asked).toEqual([PR_URL]);
});

test("an open pull request is nothing on the card at all", async () => {
  const card = cardInPr();
  const forge = fakeForge({ answer: () => openPr() });

  await poll(forge).tick();

  expect(core.getCard(card.id).phase).toBe("pr");
  expect(activity(card.id).filter((e) => e.type === "comment")).toEqual([]);
  expect(core.listAttention()).toEqual([]);
  expect(forge.asked).toEqual([PR_URL]);
});

// --- criterion 3: the pull request has to be the card's own ---

test("a merged pull request from another branch leaves the card in PR, said once", async () => {
  const card = cardInPr();
  const poller = poll(fakeForge({ answer: () => mergedPr({ headRefName: "someone-elses" }) }));

  await poller.tick();

  expect(core.getCard(card.id).phase).toBe("pr");
  expect(comments(card.id)).toEqual([`${MISMATCH}its head branch is someone-elses, not ${BRANCH}`]);

  const seen = activity(card.id).length;
  await poller.tick();
  expect(activity(card.id).length).toBe(seen);
  expect(core.getCard(card.id).phase).toBe("pr");
});

test("a merged pull request in another repository leaves the card in PR, said once", async () => {
  const card = cardInPr();
  const poller = poll(
    fakeForge({
      answer: () => mergedPr({ url: `${OTHER_REPO_URL}/pull/1`, baseRepo: OTHER_REPO_URL }),
    }),
  );

  await poller.tick();

  expect(core.getCard(card.id).phase).toBe("pr");
  expect(comments(card.id)).toEqual([
    `pull request ${OTHER_REPO_URL}/pull/1 is merged, but it is not this card's work: it is in ${OTHER_REPO_URL}, not ${REPO_URL}`,
  ]);

  const seen = activity(card.id).length;
  await poller.tick();
  expect(activity(card.id).length).toBe(seen);
});

test("both mismatches are named at once, the repository before the branch", async () => {
  const card = cardInPr();
  await poll(
    fakeForge({
      answer: () =>
        mergedPr({
          url: `${OTHER_REPO_URL}/pull/1`,
          baseRepo: OTHER_REPO_URL,
          headRefName: "someone-elses",
        }),
    }),
  ).tick();

  const said = comments(card.id)[0] as string;
  expect(said).toContain(`it is in ${OTHER_REPO_URL}, not ${REPO_URL}`);
  expect(said).toContain(`its head branch is someone-elses, not ${BRANCH}`);
  expect(said.indexOf("it is in")).toBeLessThan(said.indexOf("its head branch"));
  expect(core.getCard(card.id).phase).toBe("pr");
});

test("a card with a pull request but no branch has nothing for the head to match", async () => {
  const card = cardInPr({ prUrl: PR_URL });
  await poll(fakeForge({ answer: () => mergedPr() })).tick();

  expect(core.getCard(card.id).phase).toBe("pr");
  expect(comments(card.id)).toEqual([
    `${MISMATCH}its head branch is ${BRANCH}, and this card records no branch`,
  ]);
});

test("'once' is since the card entered PR: sent back and returned, it is told again", async () => {
  const card = cardInPr();
  const poller = poll(fakeForge({ answer: () => mergedPr({ headRefName: "someone-elses" }) }));

  await poller.tick();
  expect(comments(card.id)).toHaveLength(1);

  core.moveCard(card.id, "code", owner.id);
  core.moveCard(card.id, "pr", owner.id);
  await poller.tick();

  expect(comments(card.id)).toHaveLength(2);
  expect(core.getCard(card.id).phase).toBe("pr");
});

describe("the ownership check", () => {
  const table: { name: string; answer: PullRequest; lands: boolean }[] = [
    { name: "this repository, this card's branch", answer: mergedPr(), lands: true },
    {
      name: "this repository, another branch",
      answer: mergedPr({ headRefName: "someone-elses" }),
      lands: false,
    },
    {
      name: "another repository, this card's branch",
      answer: mergedPr({ url: `${OTHER_REPO_URL}/pull/1`, baseRepo: OTHER_REPO_URL }),
      lands: false,
    },
    {
      name: "another repository and another branch",
      answer: mergedPr({
        url: `${OTHER_REPO_URL}/pull/1`,
        baseRepo: OTHER_REPO_URL,
        headRefName: "someone-elses",
      }),
      lands: false,
    },
    // Recorded as passing in the spec's red-team: another pull request in this repository from
    // this card's own branch means the card's own work merged, under another number.
    {
      name: "this repository, this card's branch, another pull request",
      answer: mergedPr({ url: `${REPO_URL}/pull/99` }),
      lands: true,
    },
  ];

  for (const shape of table) {
    test(`${shape.name} ${shape.lands ? "lands in Done" : "stays in PR"}`, async () => {
      const card = cardInPr();
      await poll(fakeForge({ answer: () => shape.answer })).tick();
      expect(core.getCard(card.id).phase).toBe(shape.lands ? "done" : "pr");
    });
  }
});

// --- criterion 4: closed without merging is the owner's to decide ---

test("a pull request closed without merging asks the owner, with no move, once", async () => {
  const card = cardInPr();
  const poller = poll(fakeForge({ answer: () => closedPr() }));

  await poller.tick();

  const note = `pull request ${PR_URL} closed without merging`;
  expect(core.getCard(card.id).phase).toBe("pr");
  expect(comments(card.id)).toEqual([note]);
  const open = core.listAttention();
  expect(open).toHaveLength(1);
  expect(open[0]).toMatchObject({
    cardId: card.id,
    to: owner.id,
    note,
    moves: [],
    raisedBy: runnerMember.id,
  });
  // The comment comes first here too: the request's note is a reason already on the feed.
  const last = activity(card.id).slice(-2);
  expect(last[0]?.type).toBe("comment");
  expect(last[1]?.type).toBe("attention_requested");

  const seen = activity(card.id).length;
  await poller.tick();
  expect(activity(card.id).length).toBe(seen);
});

// --- criterion 5: only a card in PR with a pull request is asked about ---

test("a board with nothing in PR carrying a pull request makes no forge call", async () => {
  // The shapes that must not be polled, as a table of cards on one board.
  const byHand = cardInPr({ branch: BRANCH });
  const archived = cardInPr();
  core.archiveCard(archived.id, owner.id);
  const inCode = cardInPr();
  core.moveCard(inCode.id, "code", owner.id);
  const alreadyDone = cardInPr();
  core.moveCard(alreadyDone.id, "done", owner.id);
  const inIdea = core.createCard({ title: "an idea" }, owner.id);
  core.setRefs(inIdea.id, { branch: BRANCH, prUrl: PR_URL }, crew.id);

  const forge = fakeForge({ answer: () => mergedPr() });
  await poll(forge).tick();

  expect(forge.asked).toEqual([]);
  expect(forge.repoAsks).toBe(0);
  expect(warnings).toEqual([]);
  for (const [card, phase] of [
    [byHand, "pr"],
    [archived, "pr"],
    [inCode, "code"],
    [alreadyDone, "done"],
    [inIdea, "idea"],
  ] as [Card, Phase][]) {
    expect(core.getCard(card.id).phase).toBe(phase);
    expect(activity(card.id).filter((e) => e.type === "comment")).toEqual([]);
  }
});

// --- criterion 6: gh missing or not logged in is said once and waited out ---

test("a forge that cannot answer changes nothing and is said once, however many ticks", async () => {
  const card = cardInPr();
  let available = false;
  const forge: Forge = {
    async pullRequest(_repoRoot, url) {
      return available ? mergedPr({ url }) : undefined;
    },
    async repoUrl() {
      return available ? REPO_URL : undefined;
    },
  };
  const poller = poll(forge);

  for (let i = 0; i < 5; i += 1) await poller.tick();

  expect(core.getCard(card.id).phase).toBe("pr");
  expect(comments(card.id)).toEqual([]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("gh");

  available = true;
  await poller.tick();

  expect(core.getCard(card.id).phase).toBe("done");
  expect(warnings).toHaveLength(1);
});

test("a pull request the forge cannot answer about leaves the card alone, said once", async () => {
  const card = cardInPr();
  const poller = poll(fakeForge({ answer: () => undefined }));

  await poller.tick();
  await poller.tick();

  expect(core.getCard(card.id).phase).toBe("pr");
  expect(comments(card.id)).toEqual([]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(PR_URL);
});

// --- criterion 7: the interval ---

describe("the poll interval", () => {
  test("defaults to sixty seconds", () => {
    expect(MERGE_POLL_INTERVAL_MS).toBe(60_000);
    expect(mergePollIntervalFromEnv({})).toBe(60_000);
    expect(mergePollIntervalFromEnv({ SKELCREW_MERGE_POLL_SECONDS: "" })).toBe(60_000);
  });

  test("SKELCREW_MERGE_POLL_SECONDS overrides it", () => {
    expect(mergePollIntervalFromEnv({ SKELCREW_MERGE_POLL_SECONDS: "5" })).toBe(5000);
    expect(mergePollIntervalFromEnv({ SKELCREW_MERGE_POLL_SECONDS: "0.5" })).toBe(500);
  });

  test("a value that is not a positive number of seconds stops the daemon", () => {
    for (const value of ["0", "-1", "abc", "NaN", " ", "1s"]) {
      expect(() => mergePollIntervalFromEnv({ SKELCREW_MERGE_POLL_SECONDS: value })).toThrow(
        "SKELCREW_MERGE_POLL_SECONDS",
      );
    }
  });
});

// --- one tick at a time, and one card's failure is not the others' ---

test("a tick while a tick is in flight is not a second tick", async () => {
  const card = cardInPr();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const forge: Forge = {
    async pullRequest(_repoRoot, url) {
      await gate;
      return mergedPr({ url });
    },
    async repoUrl() {
      return REPO_URL;
    },
  };
  const poller = poll(forge);

  const first = poller.tick();
  const second = poller.tick();
  release();
  await Promise.all([first, second]);

  expect(comments(card.id)).toEqual([`pull request ${PR_URL} merged at ${MERGED_AT}`]);
  expect(core.getCard(card.id).phase).toBe("done");
});

test("a card the core refuses is one warning; the rest of the tick goes on", async () => {
  const first = cardInPr();
  const second = cardInPr({ branch: "skelcrew/2-another", prUrl: `${REPO_URL}/pull/2` });
  const refusing: Core = {
    ...core,
    moveCard(id, phase, actorId) {
      if (id === first.id) throw new Error("database is locked");
      return core.moveCard(id, phase, actorId);
    },
  };
  const forge = fakeForge({
    answer: (url) =>
      url === PR_URL ? mergedPr() : mergedPr({ url, headRefName: "skelcrew/2-another" }),
  });

  await poll(forge, refusing).tick();

  expect(core.getCard(first.id).phase).toBe("pr");
  expect(core.getCard(second.id).phase).toBe("done");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(`card ${first.id}`);
  expect(warnings[0]).toContain("database is locked");
});
