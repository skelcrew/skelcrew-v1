/**
 * Criteria 3, 6 and 7: the frame is a pure function of the state and the terminal's size, so
 * the whole screen is testable without a terminal.
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
import { activityLine, cardHeader, firstLine, status } from "../render";
import {
  cardLines,
  clampScroll,
  conversationLines,
  frame,
  helpLines,
  hint,
  MIN_COLUMNS,
  MIN_ROWS,
  sizeOf,
} from "./frame";
import type { State, View } from "./state";

const ME = 1;
const RUNNER = 2;
const MEMBERS: Member[] = [
  { id: ME, name: "simon", kind: "human", createdAt: 1 },
  { id: RUNNER, name: "runner", kind: "agent", createdAt: 1 },
];
const NOW = Date.UTC(2026, 8, 16, 10, 0, 0);
const MINUTE = 60_000;

function card(id: number, title: string, over: Partial<Card> = {}): Card {
  return {
    id,
    title,
    body: "",
    phase: "code",
    refs: {},
    attention: null,
    claim: null,
    archivedAt: null,
    createdAt: NOW - MINUTE,
    updatedAt: NOW - MINUTE,
    ...over,
  };
}

const CONFLICT: Attention = {
  to: ME,
  note: "why: the pull request conflicts with main\nand the branch is behind",
  moves: ["code"],
  raisedBy: RUNNER,
  raisedAt: NOW - 3 * MINUTE,
};
const MERGED: Attention = {
  to: ME,
  note: "merged?",
  moves: ["done"],
  raisedBy: RUNNER,
  raisedAt: NOW - MINUTE,
};

/**
 * Every status 024 derives for an unarchived card — waiting on you, waiting on someone else,
 * running, interrupted, queued — and a sixth card so the queue half has the two rows the
 * criterion asks for: a second open request is a second card waiting on me.
 */
const CARDS: Card[] = [
  card(1, "waiting on me", { attention: CONFLICT }),
  card(2, "waiting on the runner", {
    attention: { to: RUNNER, note: "answer me", moves: [], raisedBy: ME, raisedAt: NOW - MINUTE },
  }),
  card(3, "running now", {
    claim: { by: RUNNER, claimedAt: NOW - 5 * MINUTE, expiresAt: NOW + MINUTE, ttlSeconds: 120 },
  }),
  card(4, "a lapsed claim", {
    claim: { by: RUNNER, claimedAt: NOW - 90 * MINUTE, expiresAt: NOW - MINUTE, ttlSeconds: 120 },
  }),
  card(5, "queued for the crew", { phase: "spec" }),
  card(6, "also waiting on me", { phase: "pr", attention: MERGED }),
];

const REQUESTS: OpenAttention[] = [
  { cardId: 1, ...CONFLICT },
  { cardId: 6, ...MERGED },
];

const LAST_LINE =
  "ran bun run check and it passed, then pushed the branch and opened the pull request";

function state(over: Partial<State> = {}): State {
  return {
    me: ME,
    members: MEMBERS,
    cards: CARDS,
    requests: REQUESTS,
    lastLine: { 3: LAST_LINE },
    cursor: 0,
    view: { kind: "board" },
    detail: null,
    prompt: null,
    message: "",
    ...over,
  };
}

const ESC = "\u001b";

/** What a terminal prints, with the emphasis sequences taken back off. */
function plain(line: string): string {
  return line
    .split(ESC)
    .map((piece, index) => (index === 0 ? piece : piece.replace(/^\[[0-9?]*[a-zA-Z]/, "")))
    .join("");
}

/**
 * How wide the line is on a terminal, in cells — not code points: a CJK character and an emoji
 * take two, a combining mark takes none, and a line measured the other way passes a width
 * assertion while wrapping onto a second physical row.
 */
function width(line: string): number {
  return Bun.stringWidth(plain(line));
}

test("the board frame is the queue over the board, with every status in words", () => {
  const lines = frame(state(), { columns: 100, rows: 24 }, NOW);
  const shown = lines.map(plain);

  // The two halves, one dim header each, with a single rule line between them.
  const queueHeader = shown.indexOf("waiting on you");
  const boardHeader = shown.indexOf("board");
  expect(queueHeader).toBe(0);
  expect(lines[queueHeader]).toContain("\u001b[2m");
  expect(boardHeader).toBeGreaterThan(queueHeader);
  expect(lines[boardHeader]).toContain("\u001b[2m");
  expect(shown[boardHeader - 1]).toBe("─".repeat(100));
  expect(shown.filter((line) => line.includes("─")).length).toBe(1);

  // One row per request: the card id, its title and the note's first line.
  const queueRows = shown.slice(queueHeader + 1, boardHeader - 1);
  expect(queueRows.length).toBe(2);
  expect(queueRows[0]).toContain("#1");
  expect(queueRows[0]).toContain("waiting on me");
  expect(queueRows[0]).toContain("why: the pull request conflicts with main");
  expect(queueRows[0]).not.toContain("and the branch is behind");
  expect(queueRows[1]).toContain("#6");
  expect(queueRows[1]).toContain("also waiting on me");
  expect(queueRows[1]).toContain("merged?");

  // One row per card: the marker, the id, the phase track, the phase, the status, the title.
  const boardRows = shown.slice(boardHeader + 1).filter((line) => line.includes("#"));
  expect(boardRows.length).toBe(6);
  expect(boardRows[0]).toStartWith("!  #1  ○○●○○  Code  waiting on you: why: the pull request");
  expect(boardRows[0]).toContain("waiting on me");
  expect(boardRows[1]).toStartWith("?  #2  ○○●○○  Code  waiting on runner");
  expect(boardRows[2]).toStartWith("*  #3");
  expect(boardRows[2]).toContain("running since");
  expect(boardRows[3]).toStartWith("~  #4");
  expect(boardRows[3]).toContain("interrupted");
  expect(boardRows[4]).toStartWith("   #5  ○●○○○  Spec  queued");
  expect(boardRows[4]).toContain("queued for the crew");
  expect(boardRows[5]).toStartWith("!  #6  ○○○●○  PR");

  // The running card's row carries the last line its run posted, after the title, cut to fit.
  const running = boardRows[2] as string;
  expect(running).toContain("running now");
  expect(running.indexOf("ran bun run check")).toBeGreaterThan(running.indexOf("running now"));
  expect(width(running)).toBe(100);
  expect(running.endsWith("…")).toBe(true);
  expect(boardRows[4]).not.toContain("ran bun run check");

  // Every line fits the terminal, and the frame is exactly as tall as it.
  expect(lines.length).toBe(24);
  expect(lines.every((line) => width(line) <= 100)).toBe(true);
});

test("the selected row is in reverse video, and it is the only one", () => {
  for (const cursor of [0, 1, 2, 5]) {
    const lines = frame(state({ cursor }), { columns: 100, rows: 24 }, NOW);
    const selected = lines.filter((line) => line.includes("\u001b[7m"));
    expect(selected.length).toBe(1);
    const expected = cursor < 2 ? ["#1", "#6"][cursor] : `#${cursor - 1}`;
    expect(plain(selected[0] as string)).toContain(expected as string);
  }
});

test("a row of wide characters is cut and padded in cells, so no line wraps", () => {
  const title =
    "日本語のカードです、これはとても長いタイトルでターミナルの幅を超えるはずですよ日本語のカードです";
  const wide = state({
    requests: [],
    cursor: 0,
    cards: [
      card(7, title, {
        claim: { by: RUNNER, claimedAt: NOW - MINUTE, expiresAt: NOW + MINUTE, ttlSeconds: 120 },
      }),
      card(8, `${title}（二枚目）`),
    ],
    lastLine: { 7: "🙂 のコメントです。これも幅を超えるはずの長い一行です。🙂🙂🙂" },
  });

  const lines = frame(wide, { columns: 100, rows: 24 }, NOW);
  for (const line of lines) expect(width(line)).toBeLessThanOrEqual(100);

  // The selected row is filled to the width exactly: a cell too many wraps and scrolls the
  // screen, a cell too few leaves a gap in the reverse video.
  const selected = lines.filter((line) => line.includes(`${ESC}[7m`));
  expect(selected.length).toBe(1);
  expect(width(selected[0] as string)).toBe(100);
  // Cut, and then filled: a wide character straddling the last cell leaves one space.
  expect(plain(selected[0] as string).trimEnd()).toEndWith("…");
});

test("the message is the bottom line, and the prompt takes it while one is open", () => {
  const size = { columns: 100, rows: 24 };
  const bottom = (over: Partial<State>) => frame(state(over), size, NOW)[size.rows - 1] as string;

  expect(plain(bottom({ message: "#1 has no open question" }))).toBe("#1 has no open question");

  // The prompt says what it will send and on which card, and ends in a reverse-video cursor.
  const deny = bottom({ prompt: { kind: "deny", cardId: 1, text: "not yet" } });
  expect(plain(deny)).toContain("deny #1: not yet");
  expect(deny).toContain(`${ESC}[7m`);
  expect(width(deny)).toBeLessThanOrEqual(size.columns);
  expect(plain(bottom({ prompt: { kind: "back", cardId: 1, phase: "spec", text: "" } }))).toContain(
    "#1 back to Spec:",
  );
  expect(plain(bottom({ prompt: { kind: "comment", cardId: 6, text: "ok" } }))).toContain(
    "comment on #6: ok",
  );

  // 032: the title being typed for a new card. It is the one prompt about no card in
  // particular, so its label names none.
  expect(plain(bottom({ prompt: { kind: "add", text: "a new card" } }))).toContain(
    "new card: a new card",
  );

  // And the archive question, which takes no text and so has no cursor — it names the card it
  // is about and both ways to answer it.
  const question = bottom({ prompt: { kind: "archive", cardId: 1, title: "waiting on me" } });
  expect(plain(question)).toBe("archive #1 waiting on me? Enter archives, Esc keeps it");
  expect(question).not.toContain(`${ESC}[7m`);

  // The title is the prompt's own, taken when the question opened: a card that has left the
  // board under it is still named by the line that asks about it.
  expect(
    plain(
      bottom({ cards: [], requests: [], prompt: { kind: "archive", cardId: 1, title: "gone" } }),
    ),
  ).toBe("archive #1 gone? Enter archives, Esc keeps it");

  // A long title is what gets cut, rather than the two ways to answer: Enter cannot be undone,
  // so what it does has to stay on the screen.
  const longTitle = bottom({ prompt: { kind: "archive", cardId: 7, title: "a".repeat(200) } });
  expect(width(longTitle)).toBeLessThanOrEqual(size.columns);
  expect(plain(longTitle)).toEndWith("? Enter archives, Esc keeps it");

  // The prompt covers the message, and the board is still drawn above it.
  const both = frame(
    state({ message: "the daemon said no", prompt: { kind: "comment", cardId: 1, text: "" } }),
    size,
    NOW,
  ).map(plain);
  expect(both[size.rows - 1]).not.toContain("the daemon said no");
  expect(both.some((line) => line.includes("waiting on me"))).toBe(true);

  // A line longer than the terminal is cut rather than wrapped, cursor and all — and cut at
  // the start, so what is being typed stays on the screen instead of going blind at the edge.
  const long = bottom({ prompt: { kind: "comment", cardId: 1, text: `${"x".repeat(200)}END` } });
  expect(width(long)).toBeLessThanOrEqual(size.columns);
  expect(plain(long)).toContain("END");
  expect(plain(long)).toStartWith("…");

  // And it is the bottom line of the card view too.
  const card = frame(
    state({
      view: { kind: "card", cardId: 1, scroll: 0, text: "" },
      detail: detail(),
      prompt: { kind: "deny", cardId: 1, text: "no" },
    }),
    size,
    NOW,
  );
  expect(plain(card[size.rows - 1] as string)).toContain("deny #1: no");
});

test("the keys screen names every key, including the ones that answer", () => {
  const shown = frame(state({ view: { kind: "help", from: { kind: "board" }, scroll: 0 } }), {
    columns: 100,
    rows: 24,
  }).map(plain);
  // 032's criterion 8: `n`, `s` and `x` beside the six 027 added.
  for (const key of ["a", "d", "m", "b", "c", "o", "n", "s", "x"]) {
    expect(shown.some((line) => line.trimStart().startsWith(key))).toBe(true);
  }
});

test("the keys screen says Enter opens the chat, and names the key that flips", () => {
  // 033's criterion 10.
  const shown = frame(
    state({ view: { kind: "help", from: { kind: "board" }, scroll: 0 } }),
    SIZE,
  ).map(plain);
  const enter = shown.find((line) => line.trimStart().startsWith("enter"));
  expect(enter).toContain("chat");
  const tab = shown.find((line) => line.trimStart().startsWith("tab"));
  expect(tab).toBeDefined();
  expect(tab).toContain("card");

  // `q` is a letter in the chat, so the way back from every view is `esc` alone; `q` is named
  // as what it is, the card view's way back and the board's way out.
  const esc = shown.find((line) => line.trimStart().startsWith("esc"));
  expect(esc).toContain("back to the board");
  // `esc` alone in the key column — not `esc, q`, which is what it said before the chat had a
  // letter for every key. The line's words are its own business; its key column is not.
  expect(esc).not.toMatch(/^\s*esc,/);
  const quits = shown.find((line) => line.trimStart().startsWith("q "));
  expect(quits).toContain("quit");
  expect(quits).toContain("card view");
});

test("the keys screen has a chat section, drawn on a 24-row screen", () => {
  // Every key above is the board's or the card's; in the chat a letter is text, and the
  // screen says what is left. It has to fit: these lines are the last of the list.
  const shown = frame(
    state({ view: { kind: "help", from: { kind: "board" }, scroll: 0 } }),
    SIZE,
  ).map(plain);
  expect(shown.some((line) => line.includes("in the chat"))).toBe(true);

  const sending = shown.find((line) => line.trimStart().startsWith("enter, esc"));
  expect(sending).toContain("send the line");
  expect(sending).toContain("back to the board");
  const scrolling = shown.find((line) => line.trimStart().startsWith("↑, ↓, tab"));
  expect(scrolling).toContain("scroll");
  expect(scrolling).toContain("card view");
  const answering = shown.find((line) => line.trimStart().startsWith("allow, deny"));
  expect(answering).toContain("the open question");

  // And `j, k` says where it is true: in the chat they are letters, and the arrows scroll.
  const moving = shown.find((line) => line.trimStart().startsWith("j, k"));
  expect(moving).toContain("in the chat");
});

test("the keys screen names the arrows beside j and k", () => {
  const shown = frame(state({ view: { kind: "help", from: { kind: "board" }, scroll: 0 } }), {
    columns: 100,
    rows: 24,
  }).map(plain);
  const moving = shown.find((line) => line.trimStart().startsWith("j, k"));
  expect(moving).toBeDefined();
  expect(moving).toContain("↑");
  expect(moving).toContain("↓");
});

test("no frame writes a colour", () => {
  const views: State[] = [
    state(),
    state({ view: { kind: "help", from: { kind: "board" }, scroll: 0 } }),
    state({ message: "lost the daemon" }),
    state({ prompt: { kind: "deny", cardId: 1, text: "not yet" } }),
    state({ view: { kind: "card", cardId: 1, scroll: 0, text: "" }, detail: detail() }),
    // 033's criterion 5: the chat draws dim lines and one reverse-video caret, and no colour.
    state({ view: chat(3, { text: "how is it going" }), detail: exchange() }),
  ];
  for (const each of views) {
    const drawn = frame(each, { columns: 100, rows: 24 }, NOW);
    expect(drawn.length).toBe(24);
    for (const line of drawn) {
      for (const colour of ["\u001b[3", "\u001b[9", "38;", "48;"]) {
        expect(line).not.toContain(colour);
      }
    }
  }
});

test("a terminal below 60 by 12 is asked to grow, and one that reports nothing is 80 by 24", () => {
  for (const size of [
    { columns: 50, rows: 10 },
    { columns: 50, rows: 24 },
    { columns: 100, rows: 11 },
  ]) {
    const lines = frame(state(), size, NOW);
    expect(lines.length).toBe(1);
    expect(plain(lines[0] as string)).toContain("60");
    expect(plain(lines[0] as string)).toContain("12");
    expect(width(lines[0] as string)).toBeLessThanOrEqual(size.columns);
  }

  expect(sizeOf({ columns: 0, rows: 0 })).toEqual({ columns: 80, rows: 24 });
  expect(sizeOf({})).toEqual({ columns: 80, rows: 24 });
  expect(sizeOf({ columns: 120, rows: 40 })).toEqual({ columns: 120, rows: 40 });
});

function activity(seq: number, text: string): Activity {
  return {
    seq,
    cardId: 1,
    actorId: RUNNER,
    type: "comment",
    data: { text },
    createdAt: NOW - MINUTE,
  };
}

function detail(): CardDetail {
  return {
    ...(CARDS[0] as Card),
    body: "## Goal\n\nOne screen that shows what is waiting on the owner.",
    activity: Array.from({ length: 30 }, (_, i) => activity(i + 1, `step ${i + 1}`)),
  };
}

// --- 033: the chat view ---

const SIZE = { columns: 100, rows: 24 };
/** Where the listening line and the input are: the two bottom rows, in that order. */
const LISTENING = SIZE.rows - 2;
const INPUT = SIZE.rows - 1;

function event(seq: number, over: Partial<Activity> & Pick<Activity, "type" | "data">): Activity {
  return { seq, cardId: 3, actorId: RUNNER, createdAt: NOW - MINUTE, ...over } as Activity;
}

/**
 * A card's record as a run leaves it: the owner's line, the agent's text turns and its tool
 * summary, and the events between them — the whole of what the conversation draws.
 */
function exchange(): CardDetail {
  return {
    ...(CARDS[2] as Card),
    activity: [
      event(1, { type: "card_moved", data: { from: "spec", to: "code" }, actorId: ME }),
      event(2, { type: "claimed", data: { ttlSeconds: 120, expiresAt: NOW + MINUTE } }),
      event(3, {
        type: "comment",
        data: { text: "reading the spec\nand the repository's CLAUDE.md\nthen the tests" },
      }),
      event(4, { type: "comment", data: { text: "ran 5 tools: Read ×2, Bash `bun test`" } }),
      event(5, { type: "comment", data: { text: "check the frame test too" }, actorId: ME }),
      event(6, {
        type: "attention_requested",
        // A note of two lines: 022's `why:` and what it is about. The second line is the reason,
        // so the entry it renders is two lines of the conversation and not one.
        data: {
          to: ME,
          note: "why: two frame cases are red\nand the third only passes alone",
          moves: ["spec"],
          raisedBy: RUNNER,
          raisedAt: NOW,
        },
      }),
      event(7, { type: "attention_resolved", data: { how: "answered" }, actorId: ME }),
    ],
  };
}

/** The running card, with more conversation than a 24-row terminal can show. */
function talking(): CardDetail {
  return {
    ...(CARDS[2] as Card),
    body: "## Goal\n\nOne screen that shows what is waiting on the owner.",
    activity: Array.from({ length: 60 }, (_, i) => activity(i + 1, `step ${i + 1}`)),
  };
}

function chat(cardId: number, over: Partial<Extract<View, { kind: "chat" }>> = {}): View {
  return { kind: "chat", cardId, scroll: 0, text: "", ...over };
}

test("the conversation is the card's activity as an exchange, in the order it happened", () => {
  const card = exchange();
  const lines = conversationLines(card, MEMBERS);
  const text = lines.map((line) => line.text);

  // The order is the activity's: the move first, the resolved request last.
  expect(text[0]).toContain("moved Spec → Code");
  expect(text.at(-1)).toContain("resolved attention");

  // Every event that is not somebody talking is the dim entry `activityLine` renders for it:
  // one line for most, and both lines of a request whose note has two — the second is the
  // reason, and cutting it would lose it.
  const quiet = lines.filter((line) => line.quiet).map((line) => line.text);
  expect(quiet).toEqual(
    card.activity
      .filter((e) => e.type !== "comment")
      .flatMap((e) => activityLine(e, MEMBERS).split("\n")),
  );
  expect(quiet.length).toBe(5);
  const asked = quiet.findIndex((line) => line.includes("why: two frame cases are red"));
  expect(asked).toBeGreaterThanOrEqual(0);
  expect(quiet[asked + 1]).toContain("> and the third only passes alone");

  // The agent's three-line turn is three lines, attributed to it, every one of them marked
  // the way `show` marks a body, and the three start in the same column.
  const at = text.findIndex((line) => line.includes("reading the spec"));
  const turn = text.slice(at, at + 3);
  expect(turn[0]).toContain("runner");
  expect(turn[0]).toEndWith("> reading the spec");
  expect(turn[1]).toEndWith("> and the repository's CLAUDE.md");
  expect(turn[2]).toEndWith("> then the tests");
  expect(new Set(turn.map((line) => line.indexOf(">"))).size).toBe(1);
  expect(lines.slice(at, at + 3).every((line) => !line.quiet)).toBe(true);
  // The name is on the first line of the turn only: the rest are its text, under it.
  expect(turn.filter((line) => line.includes("runner")).length).toBe(1);

  // The tool summary is the comment it is, as it stands (012).
  expect(text.some((line) => line.endsWith("> ran 5 tools: Read ×2, Bash `bun test`"))).toBe(true);

  // The owner's line is one line of the exchange, attributed to her by the same name the
  // record's own lines carry.
  const mine = lines.filter((line) => !line.quiet && line.text.includes("simon"));
  expect(mine.length).toBe(1);
  expect(mine[0]?.text).toEndWith("> check the frame test too");

  // A card that has not been read yet has no conversation to draw.
  expect(conversationLines(null, MEMBERS)).toEqual([]);

  // And the frame draws both lines of that request where the conversation goes, both dim.
  const drawn = frame(state({ view: chat(3), detail: card }), SIZE, NOW);
  const note = drawn.filter((line) =>
    ["why: two frame cases are red", "and the third only passes alone"].some((part) =>
      plain(line).includes(part),
    ),
  );
  expect(note.length).toBe(2);
  expect(note.every((line) => line.includes(`${ESC}[2m`))).toBe(true);
});

test("the chat frame is the header, the conversation, the listening line and the input", () => {
  const open = state({ view: chat(3, { text: "how is it going" }), detail: talking() });
  const lines = frame(open, SIZE, NOW);
  const shown = lines.map(plain);

  expect(lines.length).toBe(SIZE.rows);
  // The header at the top, as `show` prints it — and not the body, which is one Tab away.
  expect(shown[0]).toBe("#3 running now");
  expect(shown[1]).toBe(`now:     ${status(CARDS[2] as Card, ME, MEMBERS, NOW)}`);
  expect(shown.some((line) => line.includes("phase:   Code"))).toBe(true);
  expect(shown.some((line) => line.includes("## Goal"))).toBe(false);

  // The newest of the conversation is at the bottom of the middle; the oldest are the lines
  // not shown.
  expect(shown[LISTENING - 1]).toEndWith("> step 60");
  expect(shown.some((line) => line.endsWith("> step 1"))).toBe(false);
  expect(shown.some((line) => line.endsWith("> step 2"))).toBe(false);

  // Then the line that says who is listening, then the input, with the caret the prompt draws.
  expect(shown[LISTENING]).toBe(
    `crew is listening · ${status(CARDS[2] as Card, ME, MEMBERS, NOW)}`,
  );
  expect(shown[INPUT]).toContain("how is it going");
  expect(lines[INPUT]).toContain(`${ESC}[7m`);
  expect(lines.every((line) => width(line) <= SIZE.columns)).toBe(true);

  // The smallest terminal the screen draws on at all, with a header taller than the room left
  // under it and a line longer than the width: still exactly as tall as the terminal, and
  // still never wider — a row too many scrolls the screen on every redraw.
  const small = { columns: MIN_COLUMNS, rows: MIN_ROWS };
  const tight = frame(
    state({
      view: chat(1, { text: "x".repeat(200) }),
      detail: { ...(CARDS[0] as Card), activity: [] },
    }),
    small,
    NOW,
  );
  expect(tight.length).toBe(small.rows);
  expect(tight.every((line) => width(line) <= small.columns)).toBe(true);
  // The input keeps the bottom row whatever the header did above it.
  expect(tight[small.rows - 1]).toContain(`${ESC}[7m`);
});

test("a note of two lines is two lines of the header, as show prints it", () => {
  // `cardHeader` returns a `note:` element with a line break inside it, so drawing the array as
  // lines drew the break as a literal `\n` — and cut the `why:` away when the first line and
  // the second together ran past the terminal.
  const open = state({
    view: chat(1),
    detail: { ...(CARDS[0] as Card), activity: talking().activity },
  });
  const lines = frame(open, SIZE, NOW);
  const shown = lines.map(plain);

  // The header occupies the lines `show` gives it, one for one, and no line carries a break.
  const head = cardHeader(CARDS[0] as Card, MEMBERS, ME, NOW).flatMap((line) => line.split("\n"));
  expect(head.length).toBe(9);
  expect(shown.slice(0, head.length)).toEqual(head);
  expect(shown.every((line) => !line.includes("\\n"))).toBe(true);

  // And the row budget counts them: the conversation fills what is left, newest at the bottom.
  expect(lines.length).toBe(SIZE.rows);
  expect(shown[LISTENING - 1]).toEndWith("> step 60");

  // On the narrowest terminal the screen draws on, the two lines are still two, each cut to
  // the terminal — rather than the second being lost with the cut of the first.
  const narrow = { columns: MIN_COLUMNS, rows: SIZE.rows };
  const tight = frame(open, narrow, NOW).map(plain);
  expect(tight.some((line) => line.startsWith("note:    why: the pull request"))).toBe(true);
  expect(tight.some((line) => line.trimStart().startsWith("> and the branch is behind"))).toBe(
    true,
  );
  expect(tight.every((line) => width(line) <= narrow.columns)).toBe(true);
});

test("the chat scrolls back to the first line of the conversation, and no further", () => {
  const open = state({ view: chat(3, { scroll: 500 }), detail: talking() });
  const clamped = clampScroll(open, SIZE);
  const drawn = frame(clamped, SIZE, NOW).map(plain);

  // As far back as the conversation goes: its first line, under the header.
  expect(drawn[0]).toBe("#3 running now");
  expect(drawn.some((line) => line.endsWith("> step 1"))).toBe(true);
  expect(drawn.some((line) => line.endsWith("> step 60"))).toBe(false);
  // A full window: no blank row left by a scroll that ran past the top.
  expect(drawn[LISTENING - 1]).not.toBe("");
  // Clamping what is already within the window changes nothing.
  expect(clampScroll(clamped, SIZE)).toBe(clamped);

  // And one line forward moves the window rather than being swallowed by slack.
  const scroll = (clamped.view as Extract<View, { kind: "chat" }>).scroll - 1;
  const stepped = frame({ ...open, view: chat(3, { scroll }) }, SIZE, NOW).map(plain);
  expect(stepped.some((line) => line.endsWith("> step 1"))).toBe(false);
});

test("the listening line says who is listening, or the open question, or the daemon's word", () => {
  const line = (over: Partial<State>) => plain(frame(state(over), SIZE, NOW)[LISTENING] as string);
  const of = (card: Card, activity: Activity[] = []): CardDetail => ({ ...card, activity });

  // A live claim: the crew hears what is typed, and since when it has been working.
  expect(line({ view: chat(3), detail: of(CARDS[2] as Card) })).toBe(
    `crew is listening · ${status(CARDS[2] as Card, ME, MEMBERS, NOW)}`,
  );

  // No run: nothing is listening now, and the next run reads the card.
  const quiet = "no run is live; the next run reads what you write here";
  expect(line({ view: chat(5), detail: of(CARDS[4] as Card) })).toBe(quiet);
  // A claim that lapsed is no run either.
  expect(line({ view: chat(4), detail: of(CARDS[3] as Card) })).toBe(quiet);

  // An open question is the line instead: its first line, 022's `why:` and all, and the two
  // words the input understands while it is open.
  const asked = line({ view: chat(1), detail: of(CARDS[0] as Card) });
  expect(asked).toBe(`${firstLine(CONFLICT.note)} · allow · deny · or write`);
  expect(asked).toContain("why: the pull request conflicts with main");
  expect(asked).not.toContain("and the branch is behind");

  // And what the daemon said last takes the line: a refused call is read where the owner is
  // looking, rather than under the board.
  expect(line({ view: chat(3), detail: of(CARDS[2] as Card), message: "the daemon said no" })).toBe(
    "the daemon said no",
  );
});

test("the card view is what show prints, scrolled to the newest", () => {
  const open = state({ view: { kind: "card", cardId: 1, scroll: 0, text: "" }, detail: detail() });
  const lines = frame(open, { columns: 100, rows: 24 }, NOW).map(plain);

  // The newest of the feed is on screen; the oldest, thirty entries back, is not.
  expect(lines.some((line) => line.endsWith("commented: step 30"))).toBe(true);
  expect(lines.some((line) => line.endsWith("commented: step 1"))).toBe(false);

  // Scrolled back far enough, the header and the body, marked line by line, are on screen.
  const top = frame(
    { ...open, view: { kind: "card", cardId: 1, scroll: 25, text: "" } },
    { columns: 100, rows: 24 },
    NOW,
  ).map(plain);
  expect(top).toContain("#1 waiting on me");
  expect(top).toContain("> ## Goal");
  expect(top).toContain("> One screen that shows what is waiting on the owner.");
  expect(top.some((line) => line.endsWith("commented: step 30"))).toBe(false);
});

test("the card view stops with the card's first line at the top of the window", () => {
  const size = { columns: 100, rows: 24 };
  const open = state({
    view: { kind: "card", cardId: 1, scroll: 500, text: "" },
    detail: detail(),
  });
  const lines = cardLines(open, NOW);

  // As far back as the card goes: one screenful of it, starting at its first line.
  const clamped = clampScroll(open, size);
  expect(clamped.view).toEqual({
    kind: "card",
    cardId: 1,
    scroll: lines.length - (size.rows - 1),
    text: "",
  });

  const drawn = frame(clamped, size, NOW).map(plain);
  expect(drawn[0]).toBe("#1 waiting on me");
  // A full window: the bottom row still carries the card, rather than the blank left by a
  // window that shrank as the scroll ran past the top.
  expect(drawn[size.rows - 2]).not.toBe("");

  // One line back down moves the window, rather than being swallowed by slack.
  const scroll = lines.length - (size.rows - 1) - 1;
  const stepped = frame(
    { ...open, view: { kind: "card", cardId: 1, scroll, text: "" } },
    size,
    NOW,
  ).map(plain);
  expect(stepped[0]).not.toBe("#1 waiting on me");
  // Clamping what is already within the window changes nothing.
  expect(clampScroll(clamped, size)).toBe(clamped);
});

// --- 034: the keys that apply are on the screen ---

/** A board of one card in this phase, no requests, and the cursor on its row. */
function oneCard(phase: Card["phase"], over: Partial<Card> = {}): State {
  return state({ cards: [card(9, "one card", { phase, ...over })], requests: [], cursor: 0 });
}

/** The card view of that one card, short enough to fit any terminal the screen draws on. */
function reading(phase: Card["phase"], over: Partial<Card> = {}): State {
  const board = oneCard(phase, over);
  return {
    ...board,
    view: { kind: "card", cardId: 9, scroll: 0, text: "" },
    detail: { ...(board.cards[0] as Card), activity: [] },
  };
}

/** The same card view with more lines than a terminal this tall can show: one to scroll. */
function readingLong(phase: Card["phase"], over: Partial<Card> = {}): State {
  const open = reading(phase, over);
  const activity: Activity[] = Array.from({ length: 30 }, (_, index) => ({
    seq: index + 1,
    cardId: 9,
    actorId: ME,
    type: "comment",
    data: { text: `step ${index + 1}` },
    createdAt: NOW,
  }));
  return { ...open, detail: { ...(open.detail as CardDetail), activity } };
}

/** The terminal the hint is read on: wide enough for the whole of it, and 24 rows tall. */
const HINT_SIZE = { columns: 100, rows: 24 };

test("the hint is the keys that do something where the cursor is, in that order", () => {
  // A queue row: the three keys that answer a request, and the one that opens the card.
  expect(hint(state(), HINT_SIZE)).toBe("a allow · d deny · m move · enter chat · ? keys");

  // `m` is named only while the request offers a move.
  const noMove: Attention = { ...CONFLICT, moves: [] };
  const offered = state({
    cards: [card(1, "waiting on me", { attention: noMove })],
    requests: [{ cardId: 1, ...noMove }],
  });
  expect(hint(offered, HINT_SIZE)).toBe("a allow · d deny · enter chat · ? keys");

  // A card row, by phase: `s` starts a card in Idea or Spec, and `b` has nowhere to send one
  // back to from Idea. The rest apply on every row.
  expect(hint(oneCard("idea"), HINT_SIZE)).toBe(
    "s start · enter chat · c comment · x archive · o shell · n new · ? keys",
  );
  expect(hint(oneCard("spec"), HINT_SIZE)).toBe(
    "s start · enter chat · c comment · b back · x archive · o shell · n new · ? keys",
  );
  for (const phase of ["code", "pr", "done"] as const) {
    expect(hint(oneCard(phase), HINT_SIZE)).toBe(
      "enter chat · c comment · b back · x archive · o shell · n new · ? keys",
    );
  }

  // A card row whose card has an open question is a row `a`, `d` and `m` answer too.
  expect(hint(oneCard("code", { attention: CONFLICT }), HINT_SIZE)).toBe(
    "a allow · d deny · m move · enter chat · ? keys",
  );

  // A board with no rows at all: the one key with anything to do is the one that files a card.
  expect(hint(state({ cards: [], requests: [] }), HINT_SIZE)).toBe("n new · ? keys");

  // The card view: the flip to the chat, the way back, and the keys that act on the card. The
  // way back is second, where a narrow terminal cannot cut it (the spec's amended table). A
  // card that fits the terminal has nothing to scroll, so neither `j` nor `k` is named.
  expect(hint(reading("idea"), HINT_SIZE)).toBe(
    "tab chat · q back · s start · c comment · x archive · o shell · ? keys",
  );
  expect(hint(reading("code"), HINT_SIZE)).toBe(
    "tab chat · q back · c comment · b back · x archive · o shell · ? keys",
  );

  // More lines than the terminal can show, and `j k scroll` is one of the keys that do
  // something here (the spec's table, amended after review round 2).
  expect(hint(readingLong("code"), HINT_SIZE)).toBe(
    "tab chat · q back · c comment · b back · x archive · o shell · j k scroll · ? keys",
  );
  // The same card on a terminal tall enough for the whole of it names neither key again.
  expect(hint(readingLong("code"), { columns: 100, rows: 200 })).toBe(
    "tab chat · q back · c comment · b back · x archive · o shell · ? keys",
  );

  // The card view of a card with an open question answers it too: the three keys come first,
  // and `m` only while the request offers a move.
  expect(hint(readingLong("code", { attention: CONFLICT }), HINT_SIZE)).toBe(
    "a allow · d deny · m move · tab chat · q back · c comment · b back · x archive · o shell · j k scroll · ? keys",
  );
  expect(hint(reading("idea", { attention: { ...CONFLICT, moves: [] } }), HINT_SIZE)).toBe(
    "a allow · d deny · tab chat · q back · s start · c comment · x archive · o shell · ? keys",
  );

  // The keys list says how to move through it and how to close it; the chat has no hint at all,
  // because its bottom line is the input and the line above it says who is listening (033).
  expect(
    hint(state({ view: { kind: "help", from: { kind: "board" }, scroll: 0 } }), HINT_SIZE),
  ).toBe("j k scroll · q close");
  expect(hint(state({ view: chat(3) }), HINT_SIZE)).toBe("");
});

test("the bottom line teaches whenever it has nothing more important to show", () => {
  const size = { columns: 100, rows: 24 };
  const bottom = (over: Partial<State> = {}) =>
    frame(state(over), size, NOW)[size.rows - 1] as string;

  // Dim, and the hint for the row the cursor is on.
  expect(plain(bottom())).toBe(hint(state(), size));
  expect(bottom()).toContain(`${ESC}[2m`);
  expect(plain(bottom({ cursor: 4 }))).toBe(hint(state({ cursor: 4 }), size));

  // A sentence is more important than the hint, and the prompt is more important than both:
  // the line never has two things on it.
  expect(plain(bottom({ message: "#1 has no open question" }))).toBe("#1 has no open question");
  const prompt = bottom({ prompt: { kind: "comment", cardId: 1, text: "" } });
  expect(plain(prompt)).toContain("comment on #1:");
  expect(plain(prompt)).not.toContain("? keys");

  // And the card view's bottom line is the card's keys.
  const open = reading("code");
  expect(plain(frame(open, size, NOW)[size.rows - 1] as string)).toBe(hint(open, size));
});

test("the keys list scrolls, so no terminal the screen accepts hides a key", () => {
  // The smallest terminal the screen draws on at all: the list is taller than it, and every
  // key in it has to be reachable (032's carried finding).
  const small = { columns: 100, rows: MIN_ROWS };
  const keys = (scroll: number): State =>
    state({ view: { kind: "help", from: { kind: "board" }, scroll } });
  const shown = (scroll: number) => frame(keys(scroll), small, NOW).map(plain);

  expect(helpLines().length).toBeGreaterThan(small.rows - 1);

  // It opens at the top: the header, and the first of the keys.
  const top = shown(0);
  expect(top[0]).toBe("keys");
  expect(top.some((line) => line.trimStart().startsWith("j, k"))).toBe(true);
  expect(top.some((line) => line.trimStart().startsWith("allow, deny"))).toBe(false);
  // The bottom line says how to move through the list and how to close it.
  expect(top[small.rows - 1]).toBe("j k scroll · q close");

  // Scrolled a line, the window moves a line: the header is gone and the first key line is.
  expect(shown(1)[0]).toBe("");
  expect(shown(2)[0]).toContain("j, k");

  // As far as the list goes, and no further: its last line is on the screen, the window is
  // full, and the frame is exactly as tall as the terminal.
  const end = shown(500);
  expect(end.some((line) => line.trimStart().startsWith("allow, deny"))).toBe(true);
  expect(end[small.rows - 2]).not.toBe("");
  expect(end.length).toBe(small.rows);

  // And the scroll the state carries is brought inside the window, as the card view's is.
  const clamped = clampScroll(keys(500), small);
  expect(clamped.view).toEqual({
    kind: "help",
    from: { kind: "board" },
    scroll: helpLines().length - (small.rows - 1),
  });
  expect(clampScroll(clamped, small)).toBe(clamped);
});

test("a hint too long for the terminal drops items from the end, and keeps ? keys", () => {
  const open = oneCard("spec");
  const whole = hint(open, HINT_SIZE);
  const at = (columns: number) => plain(frame(open, { columns, rows: 24 }, NOW)[24 - 1] as string);

  // A card row's whole hint is longer than the narrowest terminal the screen draws on.
  expect(Bun.stringWidth(whole)).toBeGreaterThan(MIN_COLUMNS);
  expect(at(100)).toBe(whole);

  const cut = at(MIN_COLUMNS);
  expect(Bun.stringWidth(cut)).toBeLessThanOrEqual(MIN_COLUMNS);
  expect(cut).toEndWith("? keys");
  // What survives is the head of the order, which is what the owner presses most.
  expect(cut).toBe("s start · enter chat · c comment · b back · ? keys");
});
