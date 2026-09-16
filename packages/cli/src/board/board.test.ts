/**
 * 026's criterion 8 and 027's criteria 5, 6 and 7: the terminal loop over injected streams —
 * no real terminal, no pty, no real shell — and the table of every action the keys yield
 * against the calls the CLI's own commands make, which replaces 026's tripwire.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import {
  type Activity,
  type Card,
  type CardDetail,
  type Client,
  ERROR_CODES,
  type Member,
  type MethodName,
  RpcError,
} from "@skelcrew/shared";
import type { Args, Command, Context } from "../commands/command";
import { comment as commentCommand } from "../commands/comment";
import { mv as mvCommand } from "../commands/mv";
import { resolve as resolveCommand } from "../commands/resolve";
import { CURSOR_HOME } from "./ansi";
import { type BoardDeps, type KeyInput, runBoard, type Screen } from "./board";
import type { Action } from "./keys";

const ME: Member = { id: 1, name: "simon", kind: "human", createdAt: 1 };
const RUNNER: Member = { id: 2, name: "runner", kind: "agent", createdAt: 1 };
const NOW = Date.now();
const MINUTE = 60_000;

/**
 * A data directory with the runner's worktrees under it — `o` reads a real directory, and
 * nothing else here touches the disk. Beside the two the runner made for cards 1 and 2: a
 * second directory under the worktrees root, which a note may name, a directory under the data
 * directory but outside that root, and a regular file inside it.
 */
const LINKED_DIR = mkdtempSync(join(tmpdir(), "skc-board-"));
const DATA_DIR = realpathSync(LINKED_DIR);
const WORKTREE = join(DATA_DIR, "worktrees", "2");
const OWN = join(DATA_DIR, "worktrees", "1");
const ELSEWHERE = join(DATA_DIR, "worktrees", "1-salvaged");
const OUTSIDE = join(DATA_DIR, "outside");
const NOT_A_DIRECTORY = join(DATA_DIR, "worktrees", "notes.txt");
/** A data directory the runner has made no worktree in: every fallback is missing. */
const BARE_DIR = realpathSync(mkdtempSync(join(tmpdir(), "skc-board-")));
mkdirSync(WORKTREE, { recursive: true });
mkdirSync(OWN);
mkdirSync(ELSEWHERE);
mkdirSync(OUTSIDE);
writeFileSync(NOT_A_DIRECTORY, "where the work is\n");
afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(BARE_DIR, { recursive: true, force: true });
});

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

/** One call as it went to the daemon: what a recording client keeps. */
type Call = [MethodName, unknown];

interface Fake {
  client: Client;
  /** Every call, in order, as the method and its parameters. */
  calls: Call[];
  /** Delivers an event the way a subscribed daemon would. */
  emit(event: Activity): void;
  /** The daemon goes away. */
  lose(): void;
  /** From now on, reading a card fails. */
  breakReads(): void;
  /** From now on, every call that changes a card is refused with this message. */
  refuse(message: string): void;
  /** A comment lands on the card's feed, the way a run posts one. */
  post(cardId: number, text: string): void;
}

/** The methods the screen may call that change a card; the rest are the reads it loads from. */
const CHANGES: MethodName[] = ["resolveAttention", "moveCard", "comment"];

function fakeClient(cards: Card[] = CARDS): Fake {
  let handler: ((event: Activity) => void) | undefined;
  let lost = () => {};
  const closed = new Promise<void>((resolve) => {
    lost = resolve;
  });
  let broken = false;
  let refused: string | undefined;
  const calls: Call[] = [];
  const feed = new Map<number, Activity[]>(
    cards.map((each) => [each.id, [comment(each.id, "reading the spec")]]),
  );
  const call = (async (method: MethodName, params: { id?: number }) => {
    calls.push([method, params]);
    if (refused !== undefined && CHANGES.includes(method)) {
      throw new RpcError({
        code: ERROR_CODES.forbidden,
        message: refused,
        data: { code: "forbidden" },
      });
    }
    switch (method) {
      case "listCards":
        return cards;
      case "listAttention":
        return cards
          .filter((each) => each.attention?.to === ME.id)
          .map((each) => ({ cardId: each.id, ...each.attention }));
      case "listMembers":
        return [ME, RUNNER];
      case "getCard": {
        if (broken) throw new Error("the daemon refused");
        const found = cards.find((each) => each.id === params.id) as Card;
        const detail: CardDetail = { ...found, activity: [...(feed.get(found.id) ?? [])] };
        return detail;
      }
      case "comment":
        return comment(params.id as number, "said");
      case "resolveAttention":
      case "moveCard":
        return cards.find((each) => each.id === params.id) as Card;
      default:
        return null;
    }
  }) as Client["call"];
  return {
    calls,
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
    refuse(message) {
      refused = message;
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

/**
 * The shell `o` would start, faked: it records what it was asked for and stays running until
 * the test lets it exit. No test spawns a process (027's criterion 1).
 */
interface FakeShell {
  spawnShell: BoardDeps["spawnShell"];
  started: { shell: string; cwd: string }[];
  /** The shell exits. */
  exit(): void;
}

function fakeShell(): FakeShell {
  const started: { shell: string; cwd: string }[] = [];
  let exit = () => {};
  return {
    started,
    spawnShell: (shell, cwd) => {
      started.push({ shell, cwd });
      return new Promise<void>((resolve) => {
        exit = resolve;
      });
    },
    exit: () => {
      exit();
    },
  };
}

function start(fake: Fake, terminal: FakeTerminal, over: Partial<BoardDeps> = {}): Promise<void> {
  return runBoard({
    client: fake.client,
    socketPath: "/tmp/skelcrew.sock",
    dataDir: DATA_DIR,
    input: terminal.input,
    screen: terminal.screen,
    onResize: terminal.onResize,
    redrawMs: 0,
    now: () => NOW,
    env: { SHELL: "/bin/fish" },
    spawnShell: () => {
      throw new Error("this test must not start a shell");
    },
    ...over,
  });
}

/**
 * The loop, once the first frame has been drawn. The promise is handed back inside an object:
 * an `async` function returning it would wait for the screen to close.
 */
async function started(
  fake: Fake,
  terminal: FakeTerminal,
  over: Partial<BoardDeps> = {},
): Promise<{ running: Promise<void> }> {
  const running = start(fake, terminal, over);
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
  // And how to get one back, in the sentence every message about a daemon that is not there
  // uses (030's criterion 11): the screen's is one of them, and it named `bun run daemon`,
  // which no longer exists.
  const lost = await running.then(
    () => "",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  expect(lost).toContain("run `skelcrew` in a terminal, or `skelcrew --headless`");
  expect(lost).not.toContain("bun run daemon");
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
  const { running } = await started(fake, terminal, { redrawMs: 30 });
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

// --- 027: what the keys send, and the exit ramp ---

test("a refused call puts the daemon's message on the screen and changes nothing else", async () => {
  const fake = fakeClient();
  const terminal = fakeTerminal();
  const { running } = await started(fake, terminal);
  const before = terminal.frames().at(-1) as string;

  fake.refuse("the request is not addressed to you");
  // `a` on the queue row: the card's request, allowed.
  terminal.type("a");
  await until("the refusal", () =>
    (terminal.frames().at(-1) ?? "").includes("the request is not addressed to you"),
  );
  expect(fake.calls).toContainEqual(["resolveAttention", { id: 1, text: "allow" }]);

  // The rest of the screen is the frame it was: the two rows, and the same selected row.
  const after = terminal.frames().at(-1) as string;
  const rows = (frame: string) =>
    frame.split("\r\n").filter((line) => line.includes("#") || line.includes("reading the spec"));
  expect(rows(after)).toEqual(rows(before));

  terminal.type("q");
  await running;
});

/** The cards the table presses its keys on: one in Code with a request offering PR. */
function asking(): Card[] {
  return [
    card(3, "acting from the screen", {
      phase: "code",
      attention: {
        to: ME.id,
        note: "ready for review",
        moves: ["pr"],
        raisedBy: RUNNER.id,
        raisedAt: 1,
      },
    }),
  ];
}

/** The calls the screen makes when these keys are pressed on the first row. */
async function screenCalls(keys: string[]): Promise<Call[]> {
  const fake = fakeClient(asking());
  const terminal = fakeTerminal();
  const { running } = await started(fake, terminal);
  const read = fake.calls.length;
  for (const key of keys) terminal.type(key);
  terminal.type("q");
  await running;
  return fake.calls.slice(read);
}

/** The calls the CLI command makes for this argv, run exactly as `main.ts` runs it. */
async function cliCalls(command: Command, argv: string[]): Promise<Call[]> {
  const calls: Call[] = [];
  const fake = fakeClient(asking());
  const parsed = parseArgs({
    args: argv,
    options: command.options as ParseArgsOptionsConfig,
    strict: true,
    allowPositionals: true,
  });
  const args: Args = {
    positionals: parsed.positionals,
    values: parsed.values as Args["values"],
    stdinIsTerminal: true,
  };
  const ctx: Context = {
    client: {
      ...fake.client,
      call: ((method: MethodName, params: unknown) => {
        calls.push([method, params]);
        return fake.client.call(method as "getCard", params as { id: number });
      }) as Client["call"],
    },
    socketPath: "/tmp/skelcrew.sock",
    dataDir: DATA_DIR,
    stdin: async () => "",
    out: () => {},
    warn: () => {},
  };
  await command.run(ctx, command.parse(args));
  return calls;
}

/**
 * Criterion 6, replacing 026's tripwire: every key that answers makes the call its CLI command
 * makes, with the same parameters — asserted by running both, not by reading the source. A key
 * and its command can therefore never come to mean two different things.
 */
test("every key sends exactly what its CLI command sends", async () => {
  const table: { keys: string[]; command: Command; argv: string[] }[] = [
    { keys: ["a"], command: resolveCommand, argv: ["3", "-m", "allow"] },
    { keys: ["d", ..."not yet", "\r"], command: resolveCommand, argv: ["3", "-m", "not yet"] },
    { keys: ["d", "\r"], command: resolveCommand, argv: ["3", "-m", "deny"] },
    { keys: ["m"], command: mvCommand, argv: ["3", "pr"] },
    {
      keys: ["b", ..."needs a test", "\r"],
      command: mvCommand,
      argv: ["3", "spec", "-m", "needs a test"],
    },
    { keys: ["c", ..."looks good", "\r"], command: commentCommand, argv: ["3", "looks good"] },
  ];

  const sent: Call[] = [];
  for (const { keys, command, argv } of table) {
    const [screen, cli] = await Promise.all([screenCalls(keys), cliCalls(command, argv)]);
    expect(cli.length).toBeGreaterThan(0);
    expect(screen).toEqual(cli);
    sent.push(...screen);
  }

  // Nothing else: the keys that answer make these three calls and no fourth.
  const methods = new Set(sent.map(([method]) => method));
  expect([...methods].sort()).toEqual(["comment", "moveCard", "resolveAttention"]);

  // And the table is every action the reducer can yield: a seventh key with a call of its own
  // does not typecheck until it has a row here.
  const covered: Record<Exclude<Action["kind"], "quit" | "open-shell">, boolean> = {
    resolve: table.some((row) => row.command === resolveCommand),
    move: table.some((row) => row.command === mvCommand),
    comment: table.some((row) => row.command === commentCommand),
  };
  expect(Object.values(covered).every(Boolean)).toBe(true);
});

/**
 * Two lines pasted into the prompt arrive as one chunk with a newline in it. The first line is
 * sent and the chunk ends there: what follows a newline is text the owner typed, never a series
 * of board keys. `allow` alone would resolve the card's open request (`a`) and drop the owner
 * into a shell (`o`), neither asked for nor undoable — the spec says of the prompt that
 * "nothing else is interpreted".
 */
test("a pasted chunk stops at the prompt's Enter, rather than acting on the rest", async () => {
  const asked = card(1, "the board on one screen", {
    phase: "code",
    attention: { to: ME.id, note: "ready", moves: ["pr"], raisedBy: RUNNER.id, raisedAt: 1 },
  });
  const fake = fakeClient([asked]);
  const terminal = fakeTerminal();
  const shell = fakeShell();
  const { running } = await started(fake, terminal, { spawnShell: shell.spawnShell });
  const read = fake.calls.length;

  terminal.type("c");
  terminal.type("hi\nallow");
  await until("the comment", () => fake.calls.length > read);
  // Long enough for the rest of the chunk to have acted, if it were going to.
  await Bun.sleep(20);

  expect(fake.calls.slice(read)).toEqual([["comment", { id: 1, text: "hi" }]]);
  expect(shell.started).toEqual([]);

  terminal.type("q");
  await running;
});

test("o opens a shell in the card's worktree and comes back to the screen", async () => {
  const fake = fakeClient();
  const terminal = fakeTerminal();
  const shell = fakeShell();
  const { running } = await started(fake, terminal, { spawnShell: shell.spawnShell });

  // The board row for card 2 — the runner's worktree is `<data dir>/worktrees/2`.
  terminal.type("j");
  terminal.type("j");
  terminal.type("o");
  await until("the shell", () => shell.started.length === 1);

  expect(shell.started[0]).toEqual({ shell: "/bin/fish", cwd: WORKTREE });
  // The terminal was handed back before the shell started, and no frame was drawn into it.
  const handedOver = terminal.written();
  expect(handedOver).toEndWith(ALTERNATE_SCREEN_OFF);
  expect(terminal.raw).toEqual([true, false]);

  shell.exit();
  await until(
    "the screen again",
    () => terminal.frames().length > 0 && terminal.written().length > handedOver.length,
  );
  const back = terminal.written().slice(handedOver.length);
  expect(back).toStartWith(ALTERNATE_SCREEN_ON);
  expect(back).toContain("the board on one screen");
  expect(terminal.raw).toEqual([true, false, true]);

  terminal.type("q");
  await running;
  expect(terminal.raw).toEqual([true, false, true, false]);
  expect(terminal.listeners()).toBe(0);
});

test("o takes the worktree from the request's note, and says so when there is none", async () => {
  // A note may name any directory under the worktrees root, and only that. Every note the
  // daemon writes today names `<root>/<id>`, which is also the fallback — a dirty worktree is
  // kept where it is (006, 014) — so this asserts the rule on another directory under the root.
  const salvaged = card(1, "the board on one screen", {
    attention: {
      to: ME.id,
      note: `ready; the work is in ${ELSEWHERE}`,
      moves: [],
      raisedBy: RUNNER.id,
      raisedAt: 1,
    },
  });
  const fake = fakeClient([salvaged]);
  const terminal = fakeTerminal();
  const shell = fakeShell();
  const { running } = await started(fake, terminal, { spawnShell: shell.spawnShell });

  // The queue row is card 1, whose note says where the work was left.
  const drawn = terminal.frames().length;
  terminal.type("o");
  await until("the shell", () => shell.started.length === 1);
  expect(shell.started[0]?.cwd).toBe(ELSEWHERE);
  shell.exit();
  await until("the screen again", () => terminal.frames().length > drawn);

  terminal.type("q");
  await running;

  // A card whose worktree is not there: nothing is started, and the screen says why.
  const other = fakeTerminal();
  const empty = realpathSync(mkdtempSync(join(tmpdir(), "skc-board-")));
  const second = fakeShell();
  const loop = await started(fakeClient(), other, {
    dataDir: empty,
    spawnShell: second.spawnShell,
  });
  other.type("j");
  other.type("j");
  other.type("o");
  await until("the message", () => (other.frames().at(-1) ?? "").includes("no worktree"));
  expect(second.started).toEqual([]);
  expect(other.raw).toEqual([true]);

  other.type("q");
  await loop.running;
  rmSync(empty, { recursive: true, force: true });
});

/**
 * Where `o` on card 1's queue row starts the shell when the card's request note reads this —
 * the directory the shell was asked for, or `undefined` when the screen said there is none.
 * Card 1's own worktree is under `DATA_DIR` and missing under `BARE_DIR`, so the note's path
 * and the runner's own directory for the card can be told apart.
 */
async function shellFor(note: string, dataDir = DATA_DIR): Promise<string | undefined> {
  const asked = card(1, "the board on one screen", {
    attention: { to: ME.id, note, moves: [], raisedBy: RUNNER.id, raisedAt: 1 },
  });
  const fake = fakeClient([asked]);
  const terminal = fakeTerminal();
  const shell = fakeShell();
  const { running } = await started(fake, terminal, { dataDir, spawnShell: shell.spawnShell });

  const drawn = terminal.frames().length;
  terminal.type("o");
  await until(
    "the shell or the answer that there is none",
    () => shell.started.length === 1 || (terminal.frames().at(-1) ?? "").includes("no worktree"),
  );
  const opened = shell.started[0]?.cwd;
  if (opened !== undefined) {
    shell.exit();
    await until("the screen again", () => terminal.frames().length > drawn);
  }
  terminal.type("q");
  // The screen is still up and leaves cleanly: a note is not a way to end it.
  await running;
  return opened;
}

/**
 * The note is written by whoever raised the request, and an agent may raise one, so the path it
 * names is a claim rather than a fact. `o` hands the owner's own terminal to their own shell:
 * the directory it starts in is the runner's, whatever the note says.
 */
test("o only opens a directory the runner made, whatever the note says", async () => {
  const table: { why: string; note: string; dataDir?: string; opens?: string }[] = [
    // A path outside the worktrees root is not one of the runner's, so the card's own is used.
    { why: "outside the root", note: `ready; the work is in ${OUTSIDE}`, opens: OWN },
    // And when the card has none either, nothing is started at all.
    { why: "outside, no fallback", note: `ready; the work is in ${OUTSIDE}`, dataDir: BARE_DIR },
    // An existing path that is not a directory is no worktree: `Bun.spawn` is never handed one,
    // and there is nothing for it to throw `ENOTDIR` over.
    { why: "a file, no fallback", note: `the work is in ${NOT_A_DIRECTORY}`, dataDir: BARE_DIR },
    { why: "a file", note: `the work is in ${NOT_A_DIRECTORY}`, opens: OWN },
    // A relative path would be read against wherever the owner started `skelcrew`.
    { why: "relative", note: "ready; the work is in .", opens: OWN },
    // The phrase in prose names no path, and falls back rather than refusing.
    { why: "in prose", note: "ready; the work is in the worktree", opens: OWN },
    // The note's own path, when it is one of the runner's, and the last of two.
    { why: "the runner's own", note: `ready; the work is in ${ELSEWHERE}`, opens: ELSEWHERE },
    {
      why: "the last of two",
      note: `the work is in ${OUTSIDE}; and then the work is in ${ELSEWHERE}`,
      opens: ELSEWHERE,
    },
    // The CLI resolves `SKELCREW_DIR` lexically and the runner writes its notes through
    // `realpath`, so on a data directory reached through a link (`/tmp` on macOS) the two are
    // spelled differently — and it is the same directory all the same.
    {
      why: "spelled through a link",
      note: `the work is in ${ELSEWHERE}`,
      dataDir: LINKED_DIR,
      opens: ELSEWHERE,
    },
  ];

  const opened: string[] = [];
  for (const row of table) {
    opened.push(`${row.why}: ${await shellFor(row.note, row.dataDir)}`);
  }
  expect(opened).toEqual(table.map((row) => `${row.why}: ${row.opens}`));
});

test("the shell is $SHELL, and sh when the owner has none", async () => {
  const terminal = fakeTerminal();
  const shell = fakeShell();
  const { running } = await started(fakeClient(), terminal, {
    env: {},
    spawnShell: shell.spawnShell,
  });

  const drawn = terminal.frames().length;
  terminal.type("j");
  terminal.type("j");
  terminal.type("o");
  await until("the shell", () => shell.started.length === 1);
  expect(shell.started[0]?.shell).toBe("sh");

  shell.exit();
  await until("the screen again", () => terminal.frames().length > drawn);
  terminal.type("q");
  await running;
});
