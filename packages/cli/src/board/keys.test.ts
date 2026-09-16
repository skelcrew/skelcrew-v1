/**
 * Criterion 4: the reducer. A key is a function of the state and nothing else, so the whole
 * of what the keyboard does is testable without a terminal.
 */
import { expect, test } from "bun:test";
import type { Activity, Card, CardDetail, Member, OpenAttention } from "@skelcrew/shared";
import { cardLines } from "./frame";
import { press } from "./keys";
import type { State } from "./state";

const ME = 1;
const MEMBERS: Member[] = [{ id: ME, name: "simon", kind: "human", createdAt: 1 }];
const NOW = Date.UTC(2026, 8, 16, 10, 0, 0);

function card(id: number, title: string): Card {
  return {
    id,
    title,
    body: "",
    phase: "code",
    refs: {},
    attention: null,
    claim: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const CARDS = [card(3, "three"), card(4, "four"), card(5, "five")];
const REQUESTS: OpenAttention[] = [
  { cardId: 4, to: ME, note: "a", moves: [], raisedBy: ME, raisedAt: NOW },
  { cardId: 5, to: ME, note: "b", moves: [], raisedBy: ME, raisedAt: NOW },
];

function state(over: Partial<State> = {}): State {
  return {
    me: ME,
    members: MEMBERS,
    cards: CARDS,
    requests: REQUESTS,
    lastLine: {},
    cursor: 0,
    view: { kind: "board" },
    detail: null,
    message: "",
    ...over,
  };
}

/** The cursor after each key in turn, starting from `state(over)`. */
function walk(keys: string[], over: Partial<State> = {}): number[] {
  let current = state(over);
  return keys.map((key) => {
    current = press(current, key).state;
    return current.cursor;
  });
}

test("j and k move through the queue rows and then the board rows, and stop at the ends", () => {
  // Two requests, then three cards: five rows, one cursor.
  expect(walk(["j", "j", "j", "j", "j", "j"])).toEqual([1, 2, 3, 4, 4, 4]);
  expect(walk(["k"])).toEqual([0]);
  expect(walk(["G", "k", "k", "k", "k", "k"])).toEqual([4, 3, 2, 1, 0, 0]);
  expect(walk(["G", "g"])).toEqual([4, 0]);
  expect(walk(["j", "G"])).toEqual([1, 4]);
});

test("Enter opens the card under the cursor, and q or Esc comes back", () => {
  // A queue row opens its request's card; a board row opens the card it is.
  for (const [cursor, cardId] of [
    [0, 4],
    [1, 5],
    [2, 3],
    [4, 5],
  ] as const) {
    const opened = press(state({ cursor }), "enter").state;
    expect(opened.view).toEqual({ kind: "card", cardId, scroll: 0 });
    for (const back of ["q", "escape"]) {
      const closed = press(opened, back);
      expect(closed.action).toBeUndefined();
      expect(closed.state.view).toEqual({ kind: "board" });
      // Coming back leaves the cursor where it was.
      expect(closed.state.cursor).toBe(cursor);
    }
  }
});

test("Enter on a board with no rows does nothing", () => {
  const empty = state({ cards: [], requests: [] });
  const pressed = press(empty, "enter");
  expect(pressed.state).toBe(empty);
  expect(pressed.action).toBeUndefined();
});

test("? opens the keys and any key closes them again", () => {
  const board = state();
  const help = press(board, "?").state;
  expect(help.view).toEqual({ kind: "help", from: { kind: "board" } });
  for (const key of ["?", "j", "x", "enter", "escape", "q"]) {
    const closed = press(help, key);
    expect(closed.state.view).toEqual({ kind: "board" });
    expect(closed.action).toBeUndefined();
  }

  // Opened from a card, it closes back to that card.
  const open = press(state({ cursor: 2 }), "enter").state;
  const fromCard = press(open, "?").state;
  expect(fromCard.view).toEqual({ kind: "help", from: open.view });
  expect(press(fromCard, "j").state.view).toEqual(open.view);
});

test("q quits the board, ctrl-c quits from anywhere, and nothing else acts", () => {
  const board = state();
  expect(press(board, "q")).toEqual({ state: board, action: { kind: "quit" } });

  const open = press(board, "enter").state;
  const help = press(board, "?").state;
  for (const view of [board, open, help]) {
    expect(press(view, "ctrl-c").action).toEqual({ kind: "quit" });
  }

  // Every other printable key is the same state and no action, on every view.
  for (const key of ["a", "d", "m", "b", "c", "o", "z", "1", " ", "J"]) {
    const pressed = press(board, key);
    expect(pressed.state).toBe(board);
    expect(pressed.action).toBeUndefined();
  }
});

function detail(): CardDetail {
  const activity: Activity[] = Array.from({ length: 30 }, (_, i) => ({
    seq: i + 1,
    cardId: 3,
    actorId: ME,
    type: "comment",
    data: { text: `step ${i + 1}` },
    createdAt: NOW,
  }));
  return { ...(CARDS[0] as Card), activity };
}

test("j and k scroll the card view, newest first, and stop at both ends", () => {
  const open = press(state({ cursor: 2, detail: detail() }), "enter").state;
  expect(open.view).toEqual({ kind: "card", cardId: 3, scroll: 0 });

  // It opens at the newest: `j` cannot go further down.
  expect(press(open, "j").state.view).toEqual(open.view);

  let current = open;
  for (let i = 0; i < 200; i += 1) current = press(current, "k").state;
  // Scrolled to the first line of what `show` would print, and no further: the reducer knows
  // the card but not the terminal, so the loop tightens this to the window with `clampScroll`.
  expect(current.view).toEqual({
    kind: "card",
    cardId: 3,
    scroll: cardLines(open, NOW).length - 1,
  });
  expect(press(current, "j").state.view).toMatchObject({
    scroll: cardLines(open, NOW).length - 2,
  });
});
