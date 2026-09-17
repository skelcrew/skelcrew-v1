/**
 * 026's criterion 4 and 027's criteria 2, 3 and 4: the reducer. A key is a function of the
 * state and nothing else, so the whole of what the keyboard does — moving, and now answering —
 * is testable without a terminal.
 */
import { expect, test } from "bun:test";
import type {
  Activity,
  Attention,
  Card,
  CardDetail,
  Member,
  OpenAttention,
} from "@skelcrew/shared";
import { cardLines } from "./frame";
import { type Pressed, press } from "./keys";
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
    prompt: null,
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

test("Down is j and Up is k, on the board and in the card view", () => {
  // 031: the arrows move the cursor, and move it nowhere j and k cannot go. The card view is
  // opened and then scrolled to its first line, so both ends of both lists are pressed.
  const open = press(state({ cursor: 2, detail: detail() }), "enter").state;
  let scrolled = open;
  for (let i = 0; i < 200; i += 1) scrolled = press(scrolled, "k").state;

  for (const each of [
    state(),
    state({ cursor: 4 }),
    state({ cards: [], requests: [] }),
    open,
    scrolled,
  ]) {
    expect(press(each, "down")).toEqual(press(each, "j"));
    expect(press(each, "up")).toEqual(press(each, "k"));
  }

  // And through the whole list, the arrows walk exactly where j and k walk.
  expect(walk(["down", "down", "down", "down", "down", "down"])).toEqual([1, 2, 3, 4, 4, 4]);
  expect(walk(["up"])).toEqual([0]);
  expect(walk(["G", "up", "up", "up", "up", "up"])).toEqual([4, 3, 2, 1, 0, 0]);
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

  // Every printable key that is not a key is the same state and no action, on every view.
  // `a`, `d`, `m`, `b`, `c` and `o` were in this list until 027 gave them to the daemon.
  for (const key of ["z", "1", " ", "J", "x"]) {
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

// --- 027: the keys that answer ---

const QUESTION: Attention = {
  to: ME,
  note: "ready for review; the work is in /tmp/skelcrew/worktrees/7",
  moves: ["pr"],
  raisedBy: ME,
  raisedAt: NOW,
};

/** One card in Code with an open request, under the cursor. */
function asking(over: Partial<Card> = {}, question: Attention | null = QUESTION): State {
  const one: Card = { ...card(7, "asking"), attention: question, ...over };
  return state({
    cards: [one],
    requests: question === null ? [] : [{ cardId: 7, ...question }],
    cursor: 0,
  });
}

/** Every key in turn, from `start`; the last press is what comes back. */
function typing(start: State, keys: string[]): Pressed {
  let pressed: Pressed = { state: start };
  for (const key of keys) pressed = press(pressed.state, key);
  return pressed;
}

/** The state with nothing said, so "otherwise unchanged" can be asserted against the base. */
function quiet(state: State): State {
  return { ...state, message: "" };
}

test("a allows the open question, and a card without one says so", () => {
  const open = asking();
  const allowed = press(open, "a");
  expect(allowed.action).toEqual({ kind: "resolve", id: 7, text: "allow" });
  expect(allowed.state).toEqual(open);

  const none = asking({}, null);
  const pressed = press(none, "a");
  expect(pressed.action).toBeUndefined();
  expect(pressed.state.message).toContain("#7");
  expect(pressed.state.message).toContain("no open question");
  expect(quiet(pressed.state)).toEqual(none);
});

test("m takes the move the request offers, and says so when it offers none", () => {
  const moved = press(asking(), "m");
  expect(moved.action).toEqual({ kind: "move", id: 7, phase: "pr" });

  const without = asking({}, { ...QUESTION, moves: [] });
  const pressed = press(without, "m");
  expect(pressed.action).toBeUndefined();
  expect(pressed.state.message).toContain("no move");
  expect(quiet(pressed.state)).toEqual(without);

  // No question at all is the same answer `a` gives.
  expect(press(asking({}, null), "m").state.message).toContain("no open question");
});

test("b opens the prompt on the previous phase, and a card in Idea has none", () => {
  const back = press(asking({ phase: "code" }), "b");
  expect(back.action).toBeUndefined();
  expect(back.state.prompt).toEqual({ kind: "back", cardId: 7, phase: "spec", text: "" });

  const idea = asking({ phase: "idea" });
  const pressed = press(idea, "b");
  expect(pressed.action).toBeUndefined();
  expect(pressed.state.prompt).toBeNull();
  expect(pressed.state.message).toContain("Idea");
  expect(quiet(pressed.state)).toEqual(idea);
});

test("d, b and c open the one-line prompt; printable keys and Backspace edit it", () => {
  const open = asking();
  for (const [key, prompt] of [
    ["d", { kind: "deny", cardId: 7, text: "" }],
    ["b", { kind: "back", cardId: 7, phase: "spec", text: "" }],
    ["c", { kind: "comment", cardId: 7, text: "" }],
  ] as const) {
    const opened = press(open, key);
    expect(opened.action).toBeUndefined();
    expect(opened.state.prompt).toEqual(prompt);

    // Printable keys are text, not keys: `j`, `q` and `?` type themselves.
    const typed = typing(opened.state, [..."jq? no", "backspace", "backspace", "!"]);
    expect(typed.action).toBeUndefined();
    expect(typed.state.prompt).toEqual({ ...prompt, text: "jq? !" });
    expect(typed.state.view).toEqual({ kind: "board" });
  }
});

test("Enter sends what was typed, an empty deny sends deny, and Esc sends nothing", () => {
  const open = asking();
  for (const [keys, action] of [
    [["d", ..."not yet", "enter"], { kind: "resolve", id: 7, text: "not yet" }],
    [["d", "enter"], { kind: "resolve", id: 7, text: "deny" }],
    [
      ["b", ..."needs a test", "enter"],
      { kind: "move", id: 7, phase: "spec", message: "needs a test" },
    ],
    [["c", ..."looks good", "enter"], { kind: "comment", id: 7, text: "looks good" }],
  ] as const) {
    const sent = typing(open, [...keys]);
    expect(sent.action).toEqual(action);
    expect(sent.state.prompt).toBeNull();
  }

  for (const key of ["d", "b", "c"]) {
    const cancelled = typing(open, [key, ..."never mind", "escape"]);
    expect(cancelled.action).toBeUndefined();
    expect(cancelled.state.prompt).toBeNull();
    expect(quiet(cancelled.state)).toEqual(open);
  }
});

test("the prompt ignores Down and Up, and neither becomes text", () => {
  const typed = typing(asking(), ["c", ..."a note"]);
  expect(typed.state.prompt).toEqual({ kind: "comment", cardId: 7, text: "a note" });
  for (const key of ["down", "up"]) {
    const pressed = press(typed.state, key);
    expect(pressed.action).toBeUndefined();
    expect(pressed.state).toEqual(typed.state);
  }
});

test("o asks for a shell on the card under the cursor", () => {
  const pressed = press(asking(), "o");
  expect(pressed.action).toEqual({ kind: "open-shell", id: 7 });
});

test("the same keys act on the card the card view shows", () => {
  const open = press(asking(), "enter").state;
  expect(open.view).toEqual({ kind: "card", cardId: 7, scroll: 0 });

  expect(press(open, "a").action).toEqual({ kind: "resolve", id: 7, text: "allow" });
  expect(press(open, "m").action).toEqual({ kind: "move", id: 7, phase: "pr" });
  expect(press(open, "o").action).toEqual({ kind: "open-shell", id: 7 });
  expect(typing(open, ["c", ..."from the card", "enter"]).action).toEqual({
    kind: "comment",
    id: 7,
    text: "from the card",
  });
  // The prompt covers the card view rather than closing it: `q` types, and Esc cancels.
  const typed = typing(open, ["d", ..."q"]);
  expect(typed.state.view).toEqual(open.view);
  expect(typed.state.prompt).toEqual({ kind: "deny", cardId: 7, text: "q" });
  expect(press(typed.state, "escape").state.view).toEqual(open.view);
});

// --- 032: filing a card, and starting one ---

test("n opens the prompt for a title; Enter files it, an empty title says a card needs one", () => {
  const board = asking();
  const opened = press(board, "n");
  expect(opened.action).toBeUndefined();
  expect(opened.state.prompt).toEqual({ kind: "add", text: "" });

  const filed = typing(board, ["n", ..."a new card", "enter"]);
  expect(filed.action).toEqual({ kind: "add", title: "a new card" });
  expect(filed.state.prompt).toBeNull();
  // The cursor stays where it was: the new card arrives as a row, it does not take one.
  expect(filed.state.cursor).toBe(board.cursor);

  const empty = typing(board, ["n", "enter"]);
  expect(empty.action).toBeUndefined();
  expect(empty.state.prompt).toBeNull();
  expect(empty.state.message).toContain("title");

  const cancelled = typing(board, ["n", ..."never mind", "escape"]);
  expect(cancelled.action).toBeUndefined();
  expect(cancelled.state.prompt).toBeNull();
  expect(quiet(cancelled.state)).toEqual(board);

  // The card view is one card: there is no row for another to land on, so `n` is not a key.
  const open = press(board, "enter").state;
  const inCard = press(open, "n");
  expect(inCard.action).toBeUndefined();
  expect(inCard.state).toBe(open);
});

test("s starts the card, and says why it does not on the phases a run or the merge ends", () => {
  for (const [phase, to] of [
    ["idea", "spec"],
    ["spec", "code"],
  ] as const) {
    const start = asking({ phase });
    const started = press(start, "s");
    // The owner's approval carries no message: the card's body is what is being approved.
    expect(started.action).toEqual({ kind: "move", id: 7, phase: to });
    expect(started.state).toEqual(start);
  }

  const said: string[] = [];
  for (const [phase, sentence] of [
    ["code", "pull request exists"],
    ["pr", "merge the pull request"],
    ["done", "is done"],
  ] as const) {
    const stays = asking({ phase });
    const pressed = press(stays, "s");
    expect(pressed.action).toBeUndefined();
    expect(pressed.state.message).toContain(sentence);
    expect(quiet(pressed.state)).toEqual(stays);
    said.push(pressed.state.message);
  }
  // One sentence each, and no two the same.
  expect(new Set(said).size).toBe(3);

  // And the same key on the card the card view shows: the same answer in every phase.
  for (const phase of ["idea", "spec", "code", "pr", "done"] as const) {
    const board = asking({ phase });
    const open = press(board, "enter").state;
    const fromCard = press(open, "s");
    expect(fromCard.action).toEqual(press(board, "s").action);
    expect(fromCard.state.message).toBe(press(board, "s").state.message);
  }
  const idea = press(asking({ phase: "idea" }), "enter").state;
  expect(press(idea, "s").action).toEqual({ kind: "move", id: 7, phase: "spec" });
});
