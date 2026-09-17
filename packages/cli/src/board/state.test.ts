/**
 * Criterion 5: what an event does to the screen's state. Pure, so a burst of activity is a
 * fixture and not a daemon.
 */
import { expect, test } from "bun:test";
import type { Activity, ActivityEvent, Card, Member, OpenAttention } from "@skelcrew/shared";
import { apply, type State } from "./state";

const ME = 1;
const RUNNER = 2;
const MEMBERS: Member[] = [
  { id: ME, name: "simon", kind: "human", createdAt: 1 },
  { id: RUNNER, name: "runner", kind: "agent", createdAt: 1 },
];
const NOW = Date.UTC(2026, 8, 16, 10, 0, 0);
const MINUTE = 60_000;

function card(id: number, over: Partial<Card> = {}): Card {
  return {
    id,
    title: `card ${id}`,
    body: "",
    phase: "code",
    refs: {},
    attention: null,
    claim: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const LIVE = { by: RUNNER, claimedAt: NOW - MINUTE, expiresAt: NOW + MINUTE, ttlSeconds: 120 };

function state(over: Partial<State> = {}): State {
  return {
    me: ME,
    members: MEMBERS,
    cards: [card(1, { claim: LIVE }), card(2), card(3)],
    requests: [],
    lastLine: {},
    cursor: 0,
    view: { kind: "board" },
    detail: null,
    prompt: null,
    message: "",
    ...over,
  };
}

function event(cardId: number | null, actorId: number, body: ActivityEvent): Activity {
  return { seq: 1, cardId, actorId, createdAt: NOW, ...body };
}

function comment(cardId: number, actorId: number, text: string): Activity {
  return event(cardId, actorId, { type: "comment", data: { text } });
}

test("a running card's last line is the last comment its run posted", () => {
  const first = apply(state(), comment(1, RUNNER, "reading the spec"));
  expect(first.lastLine).toEqual({ 1: "reading the spec" });

  // The newest replaces the one before it, and only its first line is kept.
  const second = apply(first, comment(1, RUNNER, "bun run check\npassed, 412 tests"));
  expect(second.lastLine).toEqual({ 1: "bun run check" });
});

test("a comment by anyone but the run, or on a card that is not running, leaves the line", () => {
  const running = apply(state(), comment(1, RUNNER, "reading the spec"));

  // The owner commenting on the card the run holds is not the run talking.
  expect(apply(running, comment(1, ME, "any news?")).lastLine).toEqual({ 1: "reading the spec" });

  // No claim at all.
  expect(apply(running, comment(2, RUNNER, "unclaimed")).lastLine).toEqual({
    1: "reading the spec",
  });

  // A claim that had already lapsed when the comment was made.
  const lapsed = state({
    cards: [card(1, { claim: { ...LIVE, expiresAt: NOW - MINUTE } }), card(2), card(3)],
  });
  expect(apply(lapsed, comment(1, RUNNER, "from a dead run")).lastLine).toEqual({});
});

test("a request addressed to me joins the queue, and resolving it takes it away", () => {
  const note = "why: the spec is ready";
  const raised = apply(
    state(),
    event(2, RUNNER, {
      type: "attention_requested",
      data: { to: ME, note, moves: ["code"], raisedBy: RUNNER, raisedAt: NOW },
    }),
  );
  expect(raised.requests).toEqual([
    { cardId: 2, to: ME, note, moves: ["code"], raisedBy: RUNNER, raisedAt: NOW },
  ] as OpenAttention[]);
  expect(raised.cards[1]?.attention).toMatchObject({ to: ME, note });

  // A request to someone else is on the card, but not in my queue.
  const elsewhere = apply(
    raised,
    event(3, ME, {
      type: "attention_requested",
      data: { to: RUNNER, note: "over to you", moves: [], raisedBy: ME, raisedAt: NOW },
    }),
  );
  expect(elsewhere.requests.map((r) => r.cardId)).toEqual([2]);
  expect(elsewhere.cards[2]?.attention).toMatchObject({ to: RUNNER });

  const resolved = apply(
    elsewhere,
    event(2, ME, { type: "attention_resolved", data: { how: "answered" } }),
  );
  expect(resolved.requests).toEqual([]);
  expect(resolved.cards[1]?.attention).toBeNull();
});

test("a move, a claim and a release are on the card the next frame draws", () => {
  const moved = apply(
    state(),
    event(3, ME, { type: "card_moved", data: { from: "code", to: "pr" } }),
  );
  expect(moved.cards[2]?.phase).toBe("pr");

  const claimed = apply(
    moved,
    event(2, RUNNER, { type: "claimed", data: { ttlSeconds: 120, expiresAt: NOW + MINUTE } }),
  );
  expect(claimed.cards[1]?.claim).toEqual({
    by: RUNNER,
    claimedAt: NOW,
    expiresAt: NOW + MINUTE,
    ttlSeconds: 120,
  });

  const released = apply(claimed, event(2, RUNNER, { type: "released", data: { reason: null } }));
  expect(released.cards[1]?.claim).toBeNull();

  // A lapsed lease is the same path: the card stops being held.
  const interrupted = apply(
    state(),
    event(1, RUNNER, { type: "run_interrupted", data: { by: RUNNER, expiresAt: NOW - MINUTE } }),
  );
  expect(interrupted.cards[0]?.claim).toBeNull();
});

test("the last line goes with the run that wrote it", () => {
  const running = apply(state(), comment(1, RUNNER, "reading the spec"));
  expect(running.lastLine).toEqual({ 1: "reading the spec" });

  // The row is the running card's; a card nobody holds has no line to carry.
  const released = apply(running, event(1, RUNNER, { type: "released", data: { reason: null } }));
  expect(released.lastLine).toEqual({});

  const lapsed = apply(
    running,
    event(1, RUNNER, { type: "run_interrupted", data: { by: RUNNER, expiresAt: NOW - MINUTE } }),
  );
  expect(lapsed.lastLine).toEqual({});
});

test("a member who joins twice is one member", () => {
  const joining = event(null, 3, {
    type: "member_joined",
    data: { name: "crew-1", kind: "agent" },
  });
  const once = apply(state(), joining);
  // The stream is replayed from before what one round of requests already showed: an event
  // applied twice must leave what one left.
  expect(apply(once, joining)).toEqual(once);
  expect(apply(once, joining).members.map((m) => m.name)).toEqual(["simon", "runner", "crew-1"]);
});

test("the cursor stays on a row when the rows underneath it go away", () => {
  const bottom = state({ cursor: 2 });
  const archived = apply(bottom, event(3, ME, { type: "card_archived", data: {} }));
  expect(archived.cards.map((c) => c.id)).toEqual([1, 2]);
  expect(archived.cursor).toBe(1);
});

test("a view open on a card that is archived closes to the board", () => {
  // There is no row behind it to come back to, and no card left to talk to: the same rule for
  // the card view (032) and for the chat, which is the same card by another view (033).
  for (const view of [
    { kind: "card", cardId: 3, scroll: 0 },
    { kind: "chat", cardId: 3, scroll: 0, text: "half a line" },
  ] as const) {
    const open = state({ view, cursor: 2 });
    expect(apply(open, event(3, ME, { type: "card_archived", data: {} })).view).toEqual({
      kind: "board",
    });
    // Another card's archiving leaves the view where it is.
    expect(apply(open, event(2, ME, { type: "card_archived", data: {} })).view).toEqual(view);
  }
});

test("a member who joins is named on the next frame", () => {
  const joined = apply(
    state(),
    event(null, 3, { type: "member_joined", data: { name: "crew-1", kind: "agent" } }),
  );
  expect(joined.members.map((m) => m.name)).toEqual(["simon", "runner", "crew-1"]);
});
