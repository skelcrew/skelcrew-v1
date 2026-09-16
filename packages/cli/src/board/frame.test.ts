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
import { cardLines, clampScroll, frame, sizeOf } from "./frame";
import type { State } from "./state";

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

test("no frame writes a colour", () => {
  const views: State[] = [
    state(),
    state({ view: { kind: "help", from: { kind: "board" } } }),
    state({ message: "lost the daemon" }),
    state({ view: { kind: "card", cardId: 1, scroll: 0 }, detail: detail() }),
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
