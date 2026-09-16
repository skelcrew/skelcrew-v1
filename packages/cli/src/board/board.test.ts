/**
 * Criteria 8 and 9: the terminal loop over injected streams — no real terminal, no pty — and
 * the tripwire that the screen only ever reads.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Activity,
  type Card,
  type CardDetail,
  type Client,
  METHOD_NAMES,
  type Member,
  type MethodName,
} from "@skelcrew/shared";
import { CURSOR_HOME } from "./ansi";
import { type KeyInput, runBoard, type Screen } from "./board";

const ME: Member = { id: 1, name: "simon", kind: "human", createdAt: 1 };
const RUNNER: Member = { id: 2, name: "runner", kind: "agent", createdAt: 1 };
const NOW = Date.now();
const MINUTE = 60_000;

function card(id: number, title: string, over: Partial<Card> = {}): Card {
  return {
    id,
    title,
    body: "the spec",
    phase: "spec",
    refs: {},
    attention: null,
    claim: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const CARDS: Card[] = [
  card(1, "the board on one screen", {
    attention: { to: ME.id, note: "why: ready", moves: ["code"], raisedBy: RUNNER.id, raisedAt: 1 },
  }),
  card(2, "acting from the screen", {
    phase: "code",
    claim: { by: RUNNER.id, claimedAt: NOW - MINUTE, expiresAt: NOW + MINUTE, ttlSeconds: 120 },
  }),
];

function comment(cardId: number, text: string): Activity {
  return {
    seq: 7,
    cardId,
    actorId: RUNNER.id,
    type: "comment",
    data: { text },
    createdAt: NOW,
  };
}

interface Fake {
  client: Client;
  /** Delivers an event the way a subscribed daemon would. */
  emit(event: Activity): void;
  /** The daemon goes away. */
  lose(): void;
  /** From now on, reading a card fails. */
  breakReads(): void;
  /** A comment lands on the card's feed, the way a run posts one. */
  post(cardId: number, text: string): void;
}

function fakeClient(): Fake {
  let handler: ((event: Activity) => void) | undefined;
  let lost = () => {};
  const closed = new Promise<void>((resolve) => {
    lost = resolve;
  });
  let broken = false;
  const feed = new Map<number, Activity[]>(
    CARDS.map((each) => [each.id, [comment(each.id, "reading the spec")]]),
  );
  const call = (async (method: MethodName, params: { id?: number }) => {
    switch (method) {
      case "listCards":
        return CARDS;
      case "listAttention":
        return [{ cardId: 1, ...(CARDS[0] as Card).attention }];
      case "listMembers":
        return [ME, RUNNER];
      case "getCard": {
        if (broken) throw new Error("the daemon refused");
        const found = CARDS.find((each) => each.id === params.id) as Card;
        const detail: CardDetail = { ...found, activity: [...(feed.get(found.id) ?? [])] };
        return detail;
      }
      default:
        return null;
    }
  }) as Client["call"];
  return {
    client: {
      member: ME,
      closed,
      call,
      async subscribe(next) {
        handler = next;
      },
      async unsubscribe() {},
      async close() {
        lost();
      },
    },
    emit(event) {
      handler?.(event);
    },
    lose: () => {
      lost();
    },
    breakReads() {
      broken = true;
    },
    post(cardId, text) {
      feed.get(cardId)?.push(comment(cardId, text));
    },
  };
}

interface FakeTerminal {
  input: KeyInput;
  screen: Screen;
  /** What the loop listens on for window-size changes. */
  onResize(handler: () => void): () => void;
  /** Every `setRawMode` call, in order. */
  raw: boolean[];
  /** Everything written, in order. */
  written(): string;
  /** Every frame written, in order. */
  frames(): string[];
  /** Keys, as raw stdin delivers them. */
  type(keys: string | Uint8Array): void;
  /** A new window size, and the signal that says so. */
  resize(columns: number, rows: number): void;
  listeners(): number;
}

function fakeTerminal(opened = { columns: 100, rows: 24 }): FakeTerminal {
  const handlers = new Set<(chunk: unknown) => void>();
  const resizes = new Set<() => void>();
  const out: string[] = [];
  const raw: boolean[] = [];
  const size = { ...opened };
  return {
    input: {
      setRawMode: (on) => {
        raw.push(on);
      },
      on: (handler) => {
        handlers.add(handler);
      },
      off: (handler) => {
        handlers.delete(handler);
      },
      resume: () => {},
      pause: () => {},
    },
    screen: {
      write: (text) => {
        out.push(text);
      },
      // Read afresh every frame, as the real one is.
      get columns() {
        return size.columns;
      },
      get rows() {
        return size.rows;
      },
    },
    onResize: (handler) => {
      resizes.add(handler);
      return () => {
        resizes.delete(handler);
      };
    },
    raw,
    written: () => out.join(""),
    frames: () => out.filter((text) => text.startsWith(CURSOR_HOME)),
    type: (keys) => {
      for (const handler of [...handlers]) handler(keys);
    },
    resize: (columns, rows) => {
      size.columns = columns;
      size.rows = rows;
      for (const handler of [...resizes]) handler();
    },
    listeners: () => handlers.size,
  };
}

const ALTERNATE_SCREEN_ON = "\u001b[?1049h";
const ALTERNATE_SCREEN_OFF = "\u001b[?1049l";

async function until(what: string, ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (ready()) return;
    await Bun.sleep(1);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function start(fake: Fake, terminal: FakeTerminal, redrawMs = 0): Promise<void> {
  return runBoard({
    client: fake.client,
    socketPath: "/tmp/skelcrew.sock",
    input: terminal.input,
    screen: terminal.screen,
    onResize: terminal.onResize,
    redrawMs,
    now: () => NOW,
  });
}

/**
 * The loop, once the first frame has been drawn. The promise is handed back inside an object:
 * an `async` function returning it would wait for the screen to close.
 */
async function started(
  fake: Fake,
  terminal: FakeTerminal,
  redrawMs = 0,
): Promise<{ running: Promise<void> }> {
  const running = start(fake, terminal, redrawMs);
  // A rejection before the wait would otherwise be unhandled.
  running.catch(() => {});
  await until("the first frame", () => terminal.written().includes("waiting on you"));
  return { running };
}

test("the screen draws the board, and q leaves the terminal as it found it", async () => {
  const fake = fakeClient();
  const terminal = fakeTerminal();
  const { running } = await started(fake, terminal);

  const drawn = terminal.written();
  expect(drawn).toStartWith(ALTERNATE_SCREEN_ON);
  expect(drawn).toContain("the board on one screen");
  expect(drawn).toContain("acting from the screen");
  // The running card's last line came from its feed, read once at startup.
  expect(drawn).toContain("reading the spec");
  expect(terminal.raw).toEqual([true]);

  terminal.type("q");
  await running;
  expect(terminal.written()).toEndWith(ALTERNATE_SCREEN_OFF);
  expect(terminal.raw).toEqual([true, false]);
  expect(terminal.listeners()).toBe(0);
});

test("a key moves the cursor and an event redraws the row it happened on", async () => {
  const fake = fakeClient();
  const terminal = fakeTerminal();
  const { running } = await started(fake, terminal);
  const first = terminal.written();

  terminal.type("j");
  await until("the cursor to move", () => terminal.written().length > first.length);

  fake.emit(comment(2, "bun run check passed\nand the branch is pushed"));
  await until("the new last line", () => terminal.written().includes("bun run check passed"));
  // Only the comment's first line reaches the row.
  expect(terminal.written()).not.toContain("and the branch is pushed");

  terminal.type(new TextEncoder().encode("q"));
  await running;
});

test("ctrl-c leaves the terminal as it found it", async () => {
  const fake = fakeClient();
  const terminal = fakeTerminal();
  const { running } = await started(fake, terminal);

  terminal.type("\u0003");
  await running;
  expect(terminal.written()).toEndWith(ALTERNATE_SCREEN_OFF);
  expect(terminal.raw).toEqual([true, false]);
});

test("losing the daemon says so, exits, and leaves the terminal as it found it", async () => {
  const fake = fakeClient();
  const terminal = fakeTerminal();
  const { running } = await started(fake, terminal);

  fake.lose();
  await expect(running).rejects.toThrow(/lost the daemon on \/tmp\/skelcrew\.sock/);
  await running.catch(() => {});
  expect(terminal.written()).toEndWith(ALTERNATE_SCREEN_OFF);
  expect(terminal.raw).toEqual([true, false]);
});

test("an error thrown while the screen is up leaves the terminal as it found it", async () => {
  const fake = fakeClient();
  const terminal = fakeTerminal();
  const { running } = await started(fake, terminal);

  fake.breakReads();
  terminal.type("\r");
  await expect(running).rejects.toThrow(/the daemon refused/);
  await running.catch(() => {});
  expect(terminal.written()).toEndWith(ALTERNATE_SCREEN_OFF);
  expect(terminal.raw).toEqual([true, false]);
  expect(terminal.listeners()).toBe(0);
});

test("reopening a card reads it again, rather than drawing the feed it had", async () => {
  const fake = fakeClient();
  const terminal = fakeTerminal();
  const { running } = await started(fake, terminal);
  const card = () => (terminal.frames().at(-1) ?? "").includes("created:");

  terminal.type("\r");
  await until("the card view", card);
  terminal.type("q");
  await until("the board again", () => !card());

  // The run posts while the card is closed: no event reaches a card view that is not open.
  fake.post(1, "ZZZ-after-close");
  terminal.type("\r");
  await until("the comment posted while it was closed", () =>
    (terminal.frames().at(-1) ?? "").includes("ZZZ-after-close"),
  );

  terminal.type("q");
  terminal.type("q");
  await running;
});

test("a key typed while the screen is still loading is not lost", async () => {
  const fake = fakeClient();
  const terminal = fakeTerminal();
  const running = start(fake, terminal);

  // Before the first frame: the loop is still reading the daemon.
  expect(terminal.written()).not.toContain("waiting on you");
  terminal.type("q");

  await running;
  expect(terminal.written()).toEndWith(ALTERNATE_SCREEN_OFF);
});

test("a resize redraws: too small asks for room, and growing brings the board back", async () => {
  const fake = fakeClient();
  const terminal = fakeTerminal({ columns: 40, rows: 8 });
  const running = start(fake, terminal);
  running.catch(() => {});
  const last = () => terminal.frames().at(-1) ?? "";
  await until("the ask", () => last().includes("skelcrew needs"));

  terminal.resize(100, 24);
  await until("the board", () => last().includes("the board on one screen"));

  terminal.resize(50, 10);
  await until("the ask again", () => last().includes("skelcrew needs"));

  terminal.type("q");
  await running;
});

test("a burst of events is one frame", async () => {
  const fake = fakeClient();
  const terminal = fakeTerminal();
  const { running } = await started(fake, terminal, 30);
  const before = terminal.frames().length;

  fake.emit(comment(2, "one"));
  fake.emit(comment(2, "two"));
  fake.emit(comment(2, "three"));
  await until("the frame", () => terminal.frames().length > before);
  await Bun.sleep(90);

  // One frame for the three, and it carries the newest of them.
  expect(terminal.frames().length).toBe(before + 1);
  expect(terminal.frames().at(-1)).toContain("three");

  terminal.type("q");
  await running;
});

test("a terminal that is too small is asked to grow, and nothing else is drawn", async () => {
  const fake = fakeClient();
  const terminal = fakeTerminal({ columns: 40, rows: 8 });
  const running = start(fake, terminal);
  running.catch(() => {});
  await until("the frame", () => terminal.written().includes("skelcrew needs"));
  expect(terminal.written()).not.toContain("the board on one screen");

  terminal.type("q");
  await running;
});

/**
 * Criterion 9, in the shape of 015's tripwire: the screen reads. Every method the module names
 * is one of the protocol's reads, which is checked against the wire's own list rather than
 * against three names, so a mutating call added later trips this test whichever one it is.
 *
 * This file is the one it does not read: it has to spell what it refuses.
 */
test("nothing in the board module calls a method that changes a card, or spawns", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const files = readdirSync(dir).filter((name) => name !== "board.test.ts");
  expect(files.length).toBeGreaterThan(4);

  const reads: MethodName[] = [
    "hello",
    "listCards",
    "getCard",
    "listMembers",
    "listAttention",
    "activitySince",
    "subscribe",
    "unsubscribe",
  ];
  const named = new Set<string>();
  for (const name of files) {
    const source = readFileSync(join(dir, name), "utf8");
    for (const found of source.matchAll(/\bcall\(\s*"([A-Za-z]+)"/g)) named.add(found[1] as string);
    for (const forbidden of ["spawn", "execFile", "child_process", "Bun.$"]) {
      expect(`${name}: ${source.includes(forbidden)}`).toBe(`${name}: false`);
    }
  }
  expect([...named].sort()).toEqual(["getCard", "listAttention", "listCards", "listMembers"]);
  for (const method of METHOD_NAMES.filter((each) => !reads.includes(each))) {
    expect(`${method}: ${named.has(method)}`).toBe(`${method}: false`);
  }
});
