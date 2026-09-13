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

function poll(forge: Forge, over: Core = core, timeoutMs?: number) {
  return mergePoll({
    core: over,
    forge,
    repoRoot: "/repo",
    runnerId: runnerMember.id,
    warn: (line) => warnings.push(line),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

/**
 * A card the owner has approved into PR, with the refs a Code run leaves on it: the branch
 * recorded by `runner` at run start, the pull request recorded by `crew` (014) — which is who
 * writes each in a real run, and what the ownership check depends on.
 */
function cardInPr(refs: { branch?: string; prUrl?: string } = { branch: BRANCH, prUrl: PR_URL }) {
  const card = core.createCard({ title: "a card" }, owner.id);
  if (refs.branch !== undefined) core.setRefs(card.id, { branch: refs.branch }, runnerMember.id);
  if (refs.prUrl !== undefined) core.setRefs(card.id, { prUrl: refs.prUrl }, crew.id);
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

/** Every phase move on the card, as `<from>-<to>`: what the owner's decisions add up to. */
function moves(cardId: number): string[] {
  return activity(cardId)
    .filter((e) => e.type === "card_moved")
    .map((e) => `${e.data.from}-${e.data.to}`);
}

/**
 * A forge that stops with the card's pull request asked about and waits: `arrived` resolves
 * inside the call, `release` lets it answer. What the test does in between is what a member can
 * do while a `gh` round-trip is in flight.
 */
function gatedForge(answer: () => PullRequest): {
  forge: Forge;
  /** Every pull request URL asked about, in order. */
  asked: string[];
  arrived: Promise<void>;
  release: () => void;
} {
  const asked: string[] = [];
  let hasAsked: () => void = () => {};
  const arrived = new Promise<void>((resolve) => {
    hasAsked = resolve;
  });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    forge: {
      async pullRequest(_repoRoot, url) {
        asked.push(url);
        hasAsked();
        await gate;
        return answer();
      },
      async repoUrl() {
        return REPO_URL;
      },
    },
    asked,
    arrived,
    release: () => release(),
  };
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

/**
 * Review round 2, Minor 5: the merge time is best-effort. Whether the real `gh` can answer
 * `MERGED` with `mergedAt: null` is unverified — every merged pull request it was asked about
 * carried a time — so the card says what is known and the merge still lands.
 */
test("a merge the forge gives no time for lands the card, and the comment says only that", async () => {
  const card = cardInPr();
  const noTime: PullRequest = {
    url: PR_URL,
    state: "merged",
    headRefName: BRANCH,
    baseRepo: REPO_URL,
  };

  await poll(fakeForge({ answer: () => noTime })).tick();

  expect(core.getCard(card.id).phase).toBe("done");
  expect(comments(card.id)).toEqual([`pull request ${PR_URL} merged`]);
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

test("a card no run has recorded a branch on has nothing for the head to match", async () => {
  const card = cardInPr({ prUrl: PR_URL });
  await poll(fakeForge({ answer: () => mergedPr() })).tick();

  expect(core.getCard(card.id).phase).toBe("pr");
  expect(comments(card.id)).toEqual([
    `${MISMATCH}its head branch is ${BRANCH}, and no run has recorded a branch on this card`,
  ]);
});

/**
 * Review round 1, Important 2, demonstrated through the real CLI: `crew` can write `branch` as
 * well as `prUrl` (`setRefs` has no actor restriction), so a check against `refs.branch` as it
 * sits on the card compares two fields the same member controls. The branch compared is read
 * from a `refs_set` by the `runner` member or by a human member instead, which binds a wrong,
 * stale or copied `prUrl` and an agent that keeps the identity it was given. It does **not** bind
 * a caller that asserts another name over the socket: review round 3 ran `skelcrew --as runner
 * refs <id> --branch <other>` live, and it joined the `runner` member and wrote the very event
 * this check reads — names are not credentials (`allowlist.ts`, since 016). That caller is
 * owner-equivalent by passing no `--as` at all, which is 016's recorded limit.
 */
test("crew rewriting the branch and the pull request does not land the card in Done", async () => {
  const card = cardInPr();
  // Two writes as `crew`: another card's merged pull request, and a branch to match its head.
  core.setRefs(card.id, { branch: "skelcrew/1-probe", prUrl: `${REPO_URL}/pull/7` }, crew.id);

  await poll(
    fakeForge({
      answer: (url) => mergedPr({ url, headRefName: "skelcrew/1-probe" }),
    }),
  ).tick();

  expect(core.getCard(card.id).phase).toBe("pr");
  expect(comments(card.id)).toEqual([
    `pull request ${REPO_URL}/pull/7 is merged, but it is not this card's work: its head branch is skelcrew/1-probe, not ${BRANCH}`,
  ]);
});

test("a branch only crew ever recorded is no branch of this card's", async () => {
  const card = core.createCard({ title: "a card" }, owner.id);
  core.setRefs(card.id, { branch: BRANCH, prUrl: PR_URL }, crew.id);
  core.moveCard(card.id, "pr", owner.id);

  await poll(fakeForge({ answer: () => mergedPr() })).tick();

  expect(core.getCard(card.id).phase).toBe("pr");
  expect(comments(card.id)).toEqual([
    `${MISMATCH}its head branch is ${BRANCH}, and no run has recorded a branch on this card`,
  ]);
});

/**
 * Review round 2, Important 1: the round-1 fix claimed `crew` could not produce a `refs_set` as
 * `runner`, and review walked `skelcrew --as runner refs <id> --branch <other>` live — names are
 * not credentials. So the check binds an agent that keeps the identity it was given, and a branch
 * a *human* member recorded binds too: that member can `mv <id> done` anyway, and the card whose
 * branch and pull request were made by hand in a terminal must still be able to land.
 */
test("a branch the owner recorded by hand binds: the hand-driven card lands", async () => {
  const card = core.createCard({ title: "by hand" }, owner.id);
  core.setRefs(card.id, { branch: "my-own-branch", prUrl: PR_URL }, owner.id);
  core.moveCard(card.id, "pr", owner.id);

  await poll(fakeForge({ answer: () => mergedPr({ headRefName: "my-own-branch" }) })).tick();

  expect(core.getCard(card.id).phase).toBe("done");
});

test("a refs_set from before 011, which recorded no `set`, says nothing about the branch", async () => {
  const card = cardInPr();
  // 011's note: `set` absent means unknown, never "nothing" — and never "branch" either. The
  // core writes `set` on every event now, so the shape is reproduced by stripping it here.
  const legacy: Core = {
    ...core,
    getCard(id) {
      const detail = core.getCard(id);
      return {
        ...detail,
        activity: detail.activity.map((e) =>
          e.type === "refs_set" ? { ...e, data: { refs: e.data.refs } } : e,
        ),
      };
    },
  };

  await poll(fakeForge({ answer: () => mergedPr() }), legacy).tick();

  expect(core.getCard(card.id).phase).toBe("pr");
  expect(comments(card.id)).toEqual([
    `${MISMATCH}its head branch is ${BRANCH}, and no run has recorded a branch on this card`,
  ]);
});

test("the branch compared is the last one a run recorded, so a re-run's branch counts", async () => {
  const card = cardInPr();
  // A second run on the same card records its branch again; that is the one that binds.
  core.setRefs(card.id, { branch: "skelcrew/1-a-card-again" }, runnerMember.id);

  await poll(
    fakeForge({ answer: () => mergedPr({ headRefName: "skelcrew/1-a-card-again" }) }),
  ).tick();

  expect(core.getCard(card.id).phase).toBe("done");
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

// --- a prUrl on another host is never dialled (review round 3, Important 2) ---

/**
 * `gh pr view <url>` is not passive about the URL: it sends a request to the host the URL names
 * (review round 3 got `HTTP 405` back from `example.com`), and the poll asks again every interval.
 * `crew` can set any card's `prUrl` (016), so a card whose `prUrl` names a host of the agent's
 * choosing would otherwise make the owner's daemon contact that host once a minute for as long as
 * the card sits in PR. The origin is compared before anything is asked — and the faked forge here
 * would answer "merged, this repository, this card's branch", so a tick that asks it at all lands
 * the card in Done.
 */
test("a prUrl on another host is a mismatch before it is a question: the forge is not asked", async () => {
  const elsewhere = "https://attacker.invalid/someone/else/pull/1";
  const card = cardInPr({ branch: BRANCH, prUrl: elsewhere });
  const forge = fakeForge({ answer: (url) => mergedPr({ url, baseRepo: REPO_URL }) });
  const poller = poll(forge);

  await poller.tick();

  expect(forge.asked).toEqual([]);
  expect(core.getCard(card.id).phase).toBe("pr");
  expect(comments(card.id)).toEqual([
    `pull request ${elsewhere} is not this card's work: it is on https://attacker.invalid, not ${
      new URL(REPO_URL).origin
    }, so the forge was not asked about it`,
  ]);

  // Through the same once-rule as every other mismatch, and still never dialled.
  const seen = activity(card.id).length;
  await poller.tick();
  expect(activity(card.id).length).toBe(seen);
  expect(forge.asked).toEqual([]);
  expect(core.getCard(card.id).phase).toBe("pr");
});

/**
 * The origin, not the whole slug: a repository that was renamed or redirects is still on this
 * repository's forge, and the pull request's canonical `url` is what the repository comparison
 * then reads — which is the case above, "a merged pull request in another repository", where the
 * host matches and the answer is asked for and rejected.
 */
test("a prUrl on this host in another repository is still asked about", async () => {
  const card = cardInPr({ branch: BRANCH, prUrl: `${OTHER_REPO_URL}/pull/1` });
  const forge = fakeForge({
    answer: (url) => mergedPr({ url, baseRepo: OTHER_REPO_URL }),
  });

  await poll(forge).tick();

  expect(forge.asked).toEqual([`${OTHER_REPO_URL}/pull/1`]);
  expect(core.getCard(card.id).phase).toBe("pr");
  expect(comments(card.id)).toEqual([
    `pull request ${OTHER_REPO_URL}/pull/1 is merged, but it is not this card's work: it is in ${OTHER_REPO_URL}, not ${REPO_URL}`,
  ]);
});

/**
 * The origin comparison needs the repository's own URL, and a forge that cannot give one takes
 * the warned-once path: no pull request is dialled either, and the card stays in PR. This holds
 * before this round's change as well as after it — it is here so that moving the origin
 * comparison after the call would be visible.
 */
test("a forge that cannot say what repository this is dials no pull request", async () => {
  const card = cardInPr();
  const forge = fakeForge({ answer: () => mergedPr(), repoUrl: undefined });

  await poll(forge).tick();

  expect(forge.asked).toEqual([]);
  expect(core.getCard(card.id).phase).toBe("pr");
  expect(comments(card.id)).toEqual([]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("/repo");
});

/** And a repository URL no origin can be read from is the same "cannot answer", not a guess. */
test("a repository URL that is not a URL dials nothing either", async () => {
  const card = cardInPr();
  const forge = fakeForge({ answer: () => mergedPr(), repoUrl: "not a url" });

  await poll(forge).tick();

  expect(forge.asked).toEqual([]);
  expect(core.getCard(card.id).phase).toBe("pr");
  expect(warnings).toHaveLength(1);
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
  // The request comes first and the comment follows it: the comment is what the once-rule
  // reads, so posting it before a raise that fails would suppress every later tick's retry
  // (review round 1, Minor 4). The request carries the same text, so the feed reads the same.
  const last = activity(card.id).slice(-2);
  expect(last[0]?.type).toBe("attention_requested");
  expect(last[1]?.type).toBe("comment");

  const seen = activity(card.id).length;
  await poller.tick();
  expect(activity(card.id).length).toBe(seen);
});

test("a request the poll did not raise is not replaced, and nothing is said over it", async () => {
  const card = cardInPr();
  // The owner's own question on the card: the poll may not overwrite it.
  core.requestAttention(card.id, { to: owner.id, note: "what happened here?" }, owner.id);
  const poller = poll(fakeForge({ answer: () => closedPr() }));

  await poller.tick();

  expect(core.getCard(card.id).attention?.note).toBe("what happened here?");
  expect(comments(card.id)).toEqual([]);

  // Once the owner has answered it, the next tick says its piece.
  core.resolveAttention(card.id, undefined, owner.id);
  await poller.tick();

  const note = `pull request ${PR_URL} closed without merging`;
  expect(comments(card.id)).toEqual([note]);
  expect(core.getCard(card.id).attention?.note).toBe(note);
});

/**
 * Review round 2, Minor 4: the raise took and the comment threw, which left the card carrying
 * the request and no comment — and every later tick refused to raise over a request the poll
 * itself had made. The poll may replace an open request that *is* the one it would raise (same
 * member, same note) and nothing else, so the next tick finishes what the last one started.
 */
test("a comment that fails after the raise is retried, and the poll may replace its own request", async () => {
  const card = cardInPr();
  let fail = true;
  const refusing: Core = {
    ...core,
    comment(id, text, actorId) {
      if (fail) throw new Error("database is locked");
      return core.comment(id, text, actorId);
    },
  };
  const poller = poll(fakeForge({ answer: () => closedPr() }), refusing);
  const note = `pull request ${PR_URL} closed without merging`;

  await poller.tick();
  expect(comments(card.id)).toEqual([]);
  expect(core.getCard(card.id).attention?.note).toBe(note);
  expect(warnings).toHaveLength(1);

  fail = false;
  await poller.tick();

  expect(comments(card.id)).toEqual([note]);
  expect(core.getCard(card.id).attention?.note).toBe(note);
  // Its own identical request, raised again: the replacement carries no new information, and it
  // is the price of the comment being retried at all.
  expect(activity(card.id).filter((e) => e.type === "attention_requested")).toHaveLength(2);
});

test("a raise that fails posts no comment, so the next tick asks again", async () => {
  const card = cardInPr();
  let fail = true;
  const refusing: Core = {
    ...core,
    requestAttention(id, request, actorId) {
      if (fail) throw new Error("database is locked");
      return core.requestAttention(id, request, actorId);
    },
  };
  const poller = poll(fakeForge({ answer: () => closedPr() }), refusing);

  await poller.tick();
  expect(comments(card.id)).toEqual([]);
  expect(core.getCard(card.id).attention).toBeNull();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(`card ${card.id}`);

  fail = false;
  await poller.tick();

  const note = `pull request ${PR_URL} closed without merging`;
  expect(comments(card.id)).toEqual([note]);
  expect(core.getCard(card.id).attention?.note).toBe(note);
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
  // The repository's own URL is what could not be read, and `gh repo view` is every tick's first
  // call — so this is the one line an owner with no `gh` at all ever sees, and it says so
  // (review round 2, Minor 6, correcting round 1's Minor 7).
  expect(warnings[0]).toContain("/repo");
  expect(warnings[0]).toContain("installed and logged in");

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
  expect(warnings[0]).toContain("logged in");
});

test("each cause is said once: the repository's URL and a pull request are not one line", async () => {
  cardInPr();
  let repoKnown = false;
  const forge: Forge = {
    async pullRequest() {
      return undefined;
    },
    async repoUrl() {
      return repoKnown ? REPO_URL : undefined;
    },
  };
  const poller = poll(forge);

  await poller.tick();
  await poller.tick();
  expect(warnings).toHaveLength(1);

  repoKnown = true;
  await poller.tick();
  await poller.tick();

  expect(warnings).toHaveLength(2);
  expect(warnings[0]).not.toBe(warnings[1]);
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

test("a tick while a tick is in flight is not a second tick: the forge is asked once", async () => {
  const card = cardInPr();
  const gated = gatedForge(() => mergedPr());
  const poller = poll(gated.forge);

  const first = poller.tick();
  const second = poller.tick();
  const third = poller.tick();
  await gated.arrived;
  gated.release();
  await Promise.all([first, second, third]);

  // What the guard is for: one `gh` round-trip, not three, and one comment rather than three.
  expect(gated.asked).toEqual([PR_URL]);
  expect(comments(card.id)).toEqual([`pull request ${PR_URL} merged at ${MERGED_AT}`]);
  expect(core.getCard(card.id).phase).toBe("done");
  // A skipped tick is said — once for the process, however many are skipped.
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("still in flight");
});

// --- a forge that never answers (review round 2, Important 2) ---

test("a tick whose forge never answers ends anyway, says so once, and the next tick runs", async () => {
  const card = cardInPr();
  let asks = 0;
  const forge: Forge = {
    async pullRequest() {
      asks += 1;
      // A `gh` that hangs: this is what `proc.exited` did on a stalled network.
      return new Promise<undefined>(() => {});
    },
    async repoUrl() {
      return REPO_URL;
    },
  };
  const poller = poll(forge, core, 20);

  await poller.tick();
  await poller.tick();

  expect(asks).toBe(2);
  expect(core.getCard(card.id).phase).toBe("pr");
  expect(comments(card.id)).toEqual([]);
  // The hang joins the "cannot answer" path: one line, and the poll is not wedged.
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(PR_URL);
});

test("a tick whose forge never says what repository this is ends anyway", async () => {
  const card = cardInPr();
  const forge: Forge = {
    async pullRequest() {
      return mergedPr();
    },
    async repoUrl() {
      return new Promise<undefined>(() => {});
    },
  };
  const poller = poll(forge, core, 20);

  await poller.tick();
  await poller.tick();

  expect(core.getCard(card.id).phase).toBe("pr");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("/repo");
});

// --- the card as it is now, not as the tick listed it (review round 1, Important 1) ---

test("a card the owner sends back to Code while gh is being asked is left where they put it", async () => {
  const card = cardInPr();
  const gated = gatedForge(() => mergedPr());
  const poller = poll(gated.forge);

  const tick = poller.tick();
  await gated.arrived;
  // The owner's decision, inside the window the `gh` round-trip opens.
  core.moveCard(card.id, "code", owner.id);
  gated.release();
  await tick;

  expect(core.getCard(card.id).phase).toBe("code");
  expect(moves(card.id)).toEqual(["idea-pr", "pr-code"]);
  expect(comments(card.id)).toEqual([]);
});

test("a card archived while gh is being asked stays archived and unremarked", async () => {
  const card = cardInPr();
  const gated = gatedForge(() => mergedPr());
  const poller = poll(gated.forge);

  const tick = poller.tick();
  await gated.arrived;
  core.archiveCard(card.id, owner.id);
  gated.release();
  await tick;

  expect(core.getCard(card.id).archivedAt).not.toBeNull();
  expect(core.getCard(card.id).phase).toBe("pr");
  expect(comments(card.id)).toEqual([]);
});

test("a pull request replaced while gh is being asked is not the answer the tick has", async () => {
  const card = cardInPr();
  const gated = gatedForge(() => mergedPr());
  const poller = poll(gated.forge);

  const tick = poller.tick();
  await gated.arrived;
  core.setRefs(card.id, { prUrl: `${REPO_URL}/pull/2` }, crew.id);
  gated.release();
  await tick;

  expect(core.getCard(card.id).phase).toBe("pr");
  expect(comments(card.id)).toEqual([]);
});

test("a mismatch is not commented on a card that left PR while gh was being asked", async () => {
  const card = cardInPr();
  const gated = gatedForge(() => mergedPr({ headRefName: "someone-elses" }));
  const poller = poll(gated.forge);

  const tick = poller.tick();
  await gated.arrived;
  core.moveCard(card.id, "code", owner.id);
  gated.release();
  await tick;

  expect(comments(card.id)).toEqual([]);
  expect(core.getCard(card.id).phase).toBe("code");
});

// --- a move that fails does not re-say the merge (review round 1, Minor 5) ---

test("a merge whose move keeps failing is commented once, and the move is retried", async () => {
  const card = cardInPr();
  const refusing: Core = {
    ...core,
    moveCard() {
      throw new Error("database is locked");
    },
  };
  const poller = poll(fakeForge({ answer: () => mergedPr() }), refusing);

  await poller.tick();
  await poller.tick();

  expect(comments(card.id)).toEqual([`pull request ${PR_URL} merged at ${MERGED_AT}`]);
  expect(core.getCard(card.id).phase).toBe("pr");
  // Each tick still tried, and each failure is on the daemon's stderr.
  expect(warnings).toHaveLength(2);
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
