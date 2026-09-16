/**
 * The screen: bare `skelcrew` with a terminal on stdout. It owns the terminal for its whole
 * life — raw mode, the alternate screen, one frame per redraw — and hands it back exactly as it
 * found it on every exit.
 *
 * The five design choices it was built under (`docs/MILESTONES.md`, 026), because a change that
 * breaks one is wrong:
 *
 * - **Opinionated defaults, almost no config.** No flags of its own, no file, no environment
 *   variable, no settings screen. One way to do things, chosen well.
 * - **Keyboard only, vim-flavoured.** `j`/`k` move, single keys act, `?` shows the keys. No
 *   mouse, no navigation that needs the arrow keys.
 * - **Fast and quiet.** It draws once from one round of requests and then only when something
 *   happened. No spinner, no progress bar, nothing animates while waiting.
 * - **Fits the terminal it runs in.** No colour is ever written: emphasis is bold, dim and
 *   reverse, so the screen takes the terminal's theme. Box drawing is one rule character.
 * - **Legible.** The loop is one file, over three pure parts — a state, a frame, a reducer —
 *   and reading it is reading the product.
 */
import type { Activity, Client } from "@skelcrew/shared";
import type { Command } from "../commands/command";
import {
  CURSOR_HOME,
  ENTER_ALTERNATE_SCREEN,
  ERASE_BELOW,
  ERASE_LINE,
  ESCAPE_KEY,
  HIDE_CURSOR,
  INTERRUPT_KEY,
  LEAVE_ALTERNATE_SCREEN,
  SHOW_CURSOR,
} from "./ansi";
import { clampScroll, frame, sizeOf } from "./frame";
import { press } from "./keys";
import { apply, load, type State, type View } from "./state";

/** Raw stdin, as much of it as the loop uses. */
export interface KeyInput {
  setRawMode(on: boolean): void;
  on(handler: (chunk: unknown) => void): void;
  off(handler: (chunk: unknown) => void): void;
  resume(): void;
  pause(): void;
}

/** Stdout, as much of it as the loop uses. */
export interface Screen {
  write(text: string): void;
  readonly columns?: number;
  readonly rows?: number;
}

export interface BoardDeps {
  client: Client;
  /** Where the daemon was reached, for the message when it goes away. */
  socketPath: string;
  input: KeyInput;
  screen: Screen;
  /** Window-size changes; the returned function stops listening. */
  onResize?(handler: () => void): () => void;
  now?(): number;
  /** How long a burst of events is collected before one frame, in milliseconds. */
  redrawMs?: number;
}

/** Raw stdin arrives as bytes or as text, depending on the stream. */
function textOf(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return new TextDecoder().decode(chunk);
  return "";
}

/**
 * The keys in what was typed. A chunk that opens with the escape character and carries more is
 * a sequence — an arrow key, a mouse report — and this screen uses none of them, by decision;
 * the escape character alone is Esc.
 */
function keysOf(chunk: string): string[] {
  if (chunk.length === 0) return [];
  if (chunk.startsWith(ESCAPE_KEY)) return chunk.length === 1 ? ["escape"] : [];
  const keys: string[] = [];
  for (const char of chunk) {
    if (char === INTERRUPT_KEY) keys.push("ctrl-c");
    else if (char === "\r" || char === "\n") keys.push("enter");
    else if (char >= " ") keys.push(char);
  }
  return keys;
}

/**
 * The loop. It draws once from one round of requests and then only when something happened: a
 * key, an event, a resize. Everything it writes to the terminal is written here, and the
 * `finally` hands the terminal back however the loop ends — `q`, ctrl-c, a lost daemon, a
 * thrown error.
 */
export async function runBoard(deps: BoardDeps): Promise<void> {
  const { client, input, screen } = deps;
  const now = deps.now ?? (() => Date.now());
  const redrawMs = deps.redrawMs ?? 16;

  let state: State | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let over = false;
  let quit = () => {};
  let fail = (_error: unknown) => {};
  const done = new Promise<void>((resolve, reject) => {
    quit = () => {
      if (!over) {
        over = true;
        resolve();
      }
    };
    fail = (error) => {
      if (!over) {
        over = true;
        reject(error);
      }
    };
  });

  function draw(): void {
    if (state === undefined) return;
    const lines = frame(state, sizeOf(screen), now());
    screen.write(CURSOR_HOME + lines.map((line) => line + ERASE_LINE).join("\r\n") + ERASE_BELOW);
  }

  /** One frame per burst: a run posting three comments at once is one redraw. */
  function redraw(): void {
    if (timer !== undefined || over) return;
    timer = setTimeout(() => {
      timer = undefined;
      try {
        draw();
      } catch (error) {
        fail(error);
      }
    }, redrawMs);
  }

  /**
   * The card a press opened: a card view that was not already showing that card. Opening one
   * is always a read, however recently it was open — the feed moved on while it was closed,
   * and a card view that draws what the card said a minute ago is worse than none.
   */
  function opened(before: View, after: View): number | undefined {
    if (after.kind !== "card") return undefined;
    return before.kind === "card" && before.cardId === after.cardId ? undefined : after.cardId;
  }

  async function onKey(chunk: unknown): Promise<void> {
    for (const key of keysOf(textOf(chunk))) {
      if (state === undefined || over) return;
      const before = state.view;
      const pressed = press(state, key);
      // The reducer knows the card; the terminal's height is the loop's to hold.
      state = clampScroll(pressed.state, sizeOf(screen));
      if (pressed.action?.kind === "quit") {
        quit();
        return;
      }
      const opening = opened(before, state.view);
      if (opening !== undefined) {
        const detail = await client.call("getCard", { id: opening });
        state = { ...state, detail };
      }
      redraw();
    }
  }

  async function onEvent(event: Activity): Promise<void> {
    if (state === undefined || over) return;
    state = apply(state, event);
    const cardId = event.cardId;
    if (cardId !== null) {
      // A card the screen has never seen — one filed while it was open — and the open card,
      // whose feed the card view shows, are both read back whole.
      const missing = !state.cards.some((each) => each.id === cardId);
      const open = state.view.kind === "card" && state.view.cardId === cardId;
      if (missing || open) {
        const detail = await client.call("getCard", { id: cardId });
        // A `CardDetail` is a `Card` with its feed: the board reads the card's own fields.
        const cards =
          missing && detail.archivedAt === null
            ? [...state.cards, detail].sort((a, b) => a.id - b.id)
            : state.cards;
        state = { ...state, cards, detail: open ? detail : state.detail };
      }
    }
    redraw();
  }

  // Events are handled one at a time, in the order they arrive, as `watch` does. Keys and
  // events that arrive before the first read has come back are held, not dropped.
  let chain: Promise<void> = Promise.resolve();
  const buffered: Activity[] = [];
  const bufferedKeys: unknown[] = [];
  const onData = (chunk: unknown) => {
    if (state === undefined) bufferedKeys.push(chunk);
    else chain = chain.then(() => onKey(chunk)).catch(fail);
  };
  const stopResize =
    deps.onResize?.(() => {
      if (state !== undefined) state = clampScroll(state, sizeOf(screen));
      redraw();
    }) ?? (() => {});

  input.setRawMode(true);
  input.resume();
  input.on(onData);
  screen.write(ENTER_ALTERNATE_SCREEN + HIDE_CURSOR);
  try {
    // Subscribed before anything is read, so an event between the read and the stream is held
    // rather than lost; `apply` is idempotent, so one the read already reflected costs nothing.
    await client.subscribe((event) => {
      if (state === undefined) buffered.push(event);
      else chain = chain.then(() => onEvent(event)).catch(fail);
    });
    state = await load(client);
    for (const event of buffered.splice(0)) chain = chain.then(() => onEvent(event)).catch(fail);
    draw();
    for (const chunk of bufferedKeys.splice(0)) chain = chain.then(() => onKey(chunk)).catch(fail);

    const outcome = await Promise.race([
      done.then(() => "done" as const),
      client.closed.then(() => "lost" as const),
    ]);
    if (outcome === "lost") {
      throw new Error(
        `lost the daemon on ${deps.socketPath}; run \`bun run daemon\` from the repository and open the board again`,
      );
    }
  } finally {
    over = true;
    if (timer !== undefined) clearTimeout(timer);
    stopResize();
    input.off(onData);
    input.setRawMode(false);
    input.pause();
    screen.write(SHOW_CURSOR + LEAVE_ALTERNATE_SCREEN);
  }
}

export const board: Command<null, null> = {
  usage: "(no command, with a terminal on stdout): the board",
  options: {},

  parse() {
    return null;
  },

  async run(ctx) {
    await runBoard({
      client: ctx.client,
      socketPath: ctx.socketPath,
      input: {
        setRawMode: (on) => {
          // The screen opens on a terminal on stdout; stdin can still be a file or a pipe,
          // which has no raw mode. The board then draws and redraws, and no key arrives.
          if (process.stdin.isTTY === true) process.stdin.setRawMode(on);
        },
        on: (handler) => {
          process.stdin.on("data", handler);
        },
        off: (handler) => {
          process.stdin.off("data", handler);
        },
        resume: () => {
          process.stdin.resume();
        },
        pause: () => {
          process.stdin.pause();
        },
      },
      screen: {
        write: (text) => {
          process.stdout.write(text);
        },
        // Read afresh every frame: a resize changes these in place.
        get columns() {
          return process.stdout.columns;
        },
        get rows() {
          return process.stdout.rows;
        },
      },
      onResize: (handler) => {
        process.on("SIGWINCH", handler);
        return () => {
          process.off("SIGWINCH", handler);
        };
      },
    });
    return { result: null, render: () => "" };
  },
};
