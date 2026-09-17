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
import { activityLine, firstLine, status } from "../render";
import { cardLines, clampScroll, conversationLines, frame, sizeOf } from "./frame";
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
      view: { kind: "card", cardId: 1, scroll: 0 },
      detail: detail(),
      prompt: { kind: "deny", cardId: 1, text: "no" },
    }),
    size,
    NOW,
  );
  expect(plain(card[size.rows - 1] as string)).toContain("deny #1: no");
});

test("the keys screen names every key, including the ones that answer", () => {
  const shown = frame(state({ view: { kind: "help", from: { kind: "board" } } }), {
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
  const shown = frame(state({ view: { kind: "help", from: { kind: "board" } } }), SIZE).map(plain);
  const enter = shown.find((line) => line.trimStart().startsWith("enter"));
  expect(enter).toContain("chat");
  const tab = shown.find((line) => line.trimStart().startsWith("tab"));
  expect(tab).toBeDefined();
  expect(tab).toContain("card");
});

test("the keys screen names the arrows beside j and k", () => {
  const shown = frame(state({ view: { kind: "help", from: { kind: "board" } } }), {
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
    state({ view: { kind: "help", from: { kind: "board" } } }),
    state({ message: "lost the daemon" }),
    state({ prompt: { kind: "deny", cardId: 1, text: "not yet" } }),
    state({ view: { kind: "card", cardId: 1, scroll: 0 }, detail: detail() }),
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
        data: {
          to: ME,
          note: "why: the tests are red",
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

  // Every event that is not somebody talking is one dim line, and it is `activityLine`'s.
  const quiet = lines.filter((line) => line.quiet).map((line) => line.text);
  expect(quiet).toEqual(
    card.activity.filter((e) => e.type !== "comment").map((e) => activityLine(e, MEMBERS)),
  );
  expect(quiet.length).toBe(4);

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
  const open = state({ view: { kind: "card", cardId: 1, scroll: 0 }, detail: detail() });
  const lines = frame(open, { columns: 100, rows: 24 }, NOW).map(plain);

  // The newest of the feed is on screen; the oldest, thirty entries back, is not.
  expect(lines.some((line) => line.endsWith("commented: step 30"))).toBe(true);
  expect(lines.some((line) => line.endsWith("commented: step 1"))).toBe(false);

  // Scrolled back far enough, the header and the body, marked line by line, are on screen.
  const top = frame(
    { ...open, view: { kind: "card", cardId: 1, scroll: 25 } },
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
  const open = state({ view: { kind: "card", cardId: 1, scroll: 500 }, detail: detail() });
  const lines = cardLines(open, NOW);

  // As far back as the card goes: one screenful of it, starting at its first line.
  const clamped = clampScroll(open, size);
  expect(clamped.view).toEqual({
    kind: "card",
    cardId: 1,
    scroll: lines.length - (size.rows - 1),
  });

  const drawn = frame(clamped, size, NOW).map(plain);
  expect(drawn[0]).toBe("#1 waiting on me");
  // A full window: the bottom row still carries the card, rather than the blank left by a
  // window that shrank as the scroll ran past the top.
  expect(drawn[size.rows - 2]).not.toBe("");

  // One line back down moves the window, rather than being swallowed by slack.
  const scroll = lines.length - (size.rows - 1) - 1;
  const stepped = frame({ ...open, view: { kind: "card", cardId: 1, scroll } }, size, NOW).map(
    plain,
  );
  expect(stepped[0]).not.toBe("#1 waiting on me");
  // Clamping what is already within the window changes nothing.
  expect(clampScroll(clamped, size)).toBe(clamped);
});
