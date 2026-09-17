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
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { type Activity, type Client, worktreesDir } from "@skelcrew/shared";
import { type Command, START_A_DAEMON } from "../commands/command";
import { formatId, oneLine } from "../render";
import {
  ARROW_KEYS,
  BACKSPACE_KEYS,
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
import { type Action, press } from "./keys";
import { apply, load, questionOf, type State, type View } from "./state";

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
  /** The daemon's data directory: the runner's worktrees are under it. */
  dataDir: string;
  input: KeyInput;
  screen: Screen;
  /**
   * The owner's shell, in the card's worktree, with the terminal already handed back. Injected
   * so that a test drives `o` without a process ever being started.
   */
  spawnShell(shell: string, cwd: string): Promise<void>;
  /** Where `$SHELL` is read from; the command passes `process.env`. */
  env?: Record<string, string | undefined>;
  /** Window-size changes; the returned function stops listening. */
  onResize?(handler: () => void): () => void;
  now?(): number;
  /** How long a burst of events is collected before one frame, in milliseconds. */
  redrawMs?: number;
}

/**
 * The call the action is, and the sentence the status line shows when the call itself says
 * something. These are the calls `resolve.ts`, `mv.ts`, `comment.ts`, `add.ts` and
 * `archive.ts` make, with the parameters those commands send: the screen and the CLI cannot
 * come to disagree about what a key means, because they make the same request (027's
 * criterion 6). Everything else a call did reaches the screen as the events it caused.
 */
async function perform(client: Client, action: Action): Promise<string | undefined> {
  switch (action.kind) {
    case "resolve":
      await client.call("resolveAttention", { id: action.id, text: action.text });
      return undefined;
    case "move":
      // Moves first, then comments, as `mv` does: a rejected move posts nothing.
      await client.call("moveCard", { id: action.id, phase: action.phase });
      if (action.message !== undefined) {
        await client.call("comment", { id: action.id, text: action.message });
      }
      return undefined;
    case "comment":
      await client.call("comment", { id: action.id, text: action.text });
      return undefined;
    case "add": {
      // The id is the daemon's, so the new card is named back to the owner who filed it.
      const filed = await client.call("createCard", { title: action.title });
      return `${formatId(filed.id)} ${oneLine(filed.title)} added`;
    }
    case "archive":
      await client.call("archiveCard", { id: action.id });
      return undefined;
    default:
      return undefined;
  }
}

/** Where `path` really is when it is a directory, and `undefined` when it is anything else. */
function directory(path: string): string | undefined {
  try {
    return statSync(path).isDirectory() ? realpathSync(path) : undefined;
  } catch {
    // Missing, or not reachable: either way there is nothing to open a shell in.
    return undefined;
  }
}

/** A path a note named, accepted only as an absolute directory inside the runner's root. */
function inside(root: string, path: string): string | undefined {
  if (!isAbsolute(path)) return undefined;
  const real = directory(path);
  if (real === undefined) return undefined;
  return real === root || real.startsWith(root + sep) ? real : undefined;
}

/**
 * Where the card's work is: the path the card's open request names, and the runner's own
 * directory for the card otherwise. `undefined` when there is no such directory, which is what
 * the key then says.
 *
 * A note is written by whoever raised the request, and an agent may raise one, so the path it
 * names is a claim and not a fact. It is taken only when it is an absolute directory under
 * `worktreesDir(dataDir)` — any directory under that root, and nothing outside it; anything
 * else falls back to the card's own directory. That is what makes the directory `o` hands the
 * owner's shell one the daemon chose. Every note the daemon writes today names
 * `worktreesDir(dataDir)/<id>`, which is the fallback — a dirty worktree is kept where it is
 * (006, 014) — so the note's path is what the screen opens only when something named another
 * card's directory under that root. The phrase is read from its last occurrence, so a note that
 * says it twice names the second path rather than everything after the first.
 */
function worktreeOf(state: State, cardId: number, dataDir: string): string | undefined {
  const root = directory(worktreesDir(dataDir));
  if (root === undefined) return undefined;
  const note = questionOf(state, cardId)?.note ?? "";
  const named = [...note.matchAll(/^.*the work is in ([^\n]+?)[ \t]*$/gm)].at(-1)?.[1];
  const path = named === undefined ? undefined : inside(root, named);
  // The card's own directory goes through the same rule: one answer to "is this the runner's".
  return path ?? inside(root, join(root, String(cardId)));
}

/** Raw stdin arrives as bytes or as text, depending on the stream. */
function textOf(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return new TextDecoder().decode(chunk);
  return "";
}

/**
 * The keys in what was typed. The escape character is read as a sequence wherever in the read
 * it falls, not only at the start of one: Up and Down are keys (031), every other sequence —
 * Left, Page Up, a mouse report — is one this screen uses for nothing and is dropped along with
 * the rest of the read, and the escape character with nothing after it is Esc.
 *
 * Wherever it falls, because one read is not one key. The terminal sends each press as its own
 * three bytes and a slow link joins them: holding Down is Down's sequence twice over, and a
 * letter typed just before Down is that letter and then the sequence. Reading the sequence only
 * at the start of a read would make the second case three keys — the letter, `[` and `B` — and
 * `[B` would land in whatever the owner was typing (031, of the prompt: "neither becomes text").
 *
 * Tab is the one control character below `" "` that is a key (033, where it flips between the
 * card and the chat); every other one but Enter, Backspace and Ctrl-C is still dropped.
 *
 * Exported for its test: what each chunk decodes to is a table, and an absence — Left moving
 * nothing — reads the same on the screen whether it was dropped or was never a key at all.
 */
export function keysOf(chunk: string): string[] {
  const keys: string[] = [];
  // By code point, as reading the characters always has: an emoji is one key, not two halves.
  const chars = [...chunk];
  let at = 0;
  while (at < chars.length) {
    const char = chars[at] as string;
    if (char === ESCAPE_KEY) {
      const rest = chars.slice(at).join("");
      if (rest.length === 1) {
        keys.push("escape");
        return keys;
      }
      const arrow = ARROW_KEYS.find(([sequence]) => rest.startsWith(sequence));
      // A sequence with no key drops itself and everything after it: the screen cannot know
      // where an unknown one ends, and reading its tail as keys would act on bytes.
      if (arrow === undefined) return keys;
      keys.push(arrow[1]);
      at += [...arrow[0]].length;
      continue;
    }
    if (char === INTERRUPT_KEY) keys.push("ctrl-c");
    else if (char === "\t") keys.push("tab");
    else if (char === "\r" || char === "\n") keys.push("enter");
    else if (BACKSPACE_KEYS.includes(char)) keys.push("backspace");
    else if (char >= " ") keys.push(char);
    at += 1;
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
  /** True while the owner's shell has the terminal: nothing is drawn into it. */
  let suspended = false;
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
    if (state === undefined || suspended) return;
    const lines = frame(state, sizeOf(screen), now());
    screen.write(CURSOR_HOME + lines.map((line) => line + ERASE_LINE).join("\r\n") + ERASE_BELOW);
  }

  /** One frame per burst: a run posting three comments at once is one redraw. */
  function redraw(): void {
    if (timer !== undefined || over || suspended) return;
    timer = setTimeout(() => {
      timer = undefined;
      try {
        draw();
      } catch (error) {
        fail(error);
      }
    }, redrawMs);
  }

  /** The frame a burst is waiting for, drawn now: what is on the state is on the screen. */
  function flush(): void {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    draw();
  }

  /** The card a view is about, if it is about one: the card view's and the chat's. */
  function shows(view: View): number | undefined {
    return view.kind === "card" || view.kind === "chat" ? view.cardId : undefined;
  }

  /**
   * The card a press opened: a view of a card that was not already showing that card. Opening
   * one is always a read, however recently it was open — the feed moved on while it was closed,
   * and a card view that draws what the card said a minute ago is worse than none. Tab between
   * the two views of one card reads nothing: the card under them has not changed.
   */
  function opened(before: View, after: View): number | undefined {
    const card = shows(after);
    if (card === undefined) return undefined;
    return shows(before) === card ? undefined : card;
  }

  /**
   * The exit ramp: the terminal goes back to the owner, their shell runs in the card's
   * worktree, and the screen comes back — reloaded, because the crew worked on while they
   * were in there — when it exits.
   */
  async function openShell(cardId: number): Promise<void> {
    if (state === undefined) return;
    const path = worktreeOf(state, cardId, deps.dataDir);
    if (path === undefined) {
      state = { ...state, message: `${formatId(cardId)} has no worktree` };
      redraw();
      return;
    }
    const shell = (deps.env ?? process.env).SHELL || "sh";
    suspended = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    freeTerminal();
    try {
      await deps.spawnShell(shell, path);
    } finally {
      if (!over) {
        takeTerminal();
        suspended = false;
      }
    }
    state = await load(client);
    draw();
  }

  async function onKey(chunk: unknown): Promise<void> {
    for (const key of keysOf(textOf(chunk))) {
      if (state === undefined || over) return;
      // The screen's one sentence ends here rather than in the reducer: it is shown on the
      // frame after the key or the call that set it, and the next key takes it off — but not
      // before it has been on the screen. The loop draws one frame per burst, so two keys read
      // together would otherwise set the sentence and end it between frames, and the owner
      // would never see it (034, after review round 1). The pending frame is drawn first.
      if (state.message.length > 0) {
        flush();
        state = { ...state, message: "" };
      }
      const before = state.view;
      // Two lines pasted into the prompt arrive as one chunk with a newline in it. The line is
      // sent and the chunk ends there: what follows a newline is text the owner typed, and
      // reading it as board keys would answer questions and open shells they never asked for
      // (027 — of the prompt, "nothing else is interpreted").
      const prompting = state.prompt !== null;
      // What the chat's input held before the key: the line a refused call gets put back.
      const typed = before.kind === "chat" ? before.text : "";
      const pressed = press(state, key);
      // The reducer knows the card; the terminal's height is the loop's to hold.
      state = clampScroll(pressed.state, sizeOf(screen));
      const action = pressed.action;
      if (action?.kind === "quit") {
        quit();
        return;
      }
      if (action?.kind === "open-shell") {
        await openShell(action.id);
        continue;
      }
      if (action !== undefined) {
        try {
          const said = await perform(client, action);
          // What the call did reaches the screen as the events it caused, like anything else;
          // what only its own answer carries — a filed card's id — is the sentence it returns.
          state = { ...state, message: said ?? "" };
        } catch (error) {
          // Refused: the daemon's own sentence, and nothing else on the screen changes — except
          // in the chat, where the line that was refused goes back into the input instead of
          // being lost, and the sentence is read on the listening line just above it (033).
          const message = error instanceof Error ? error.message : String(error);
          const view = state.view;
          const back = view.kind === "chat" && typed.length > 0 ? { ...view, text: typed } : view;
          state = { ...state, message, view: back };
        }
      }
      const opening = opened(before, state.view);
      if (opening !== undefined) {
        const detail = await client.call("getCard", { id: opening });
        state = { ...state, detail };
      }
      redraw();
      if (prompting && state.prompt === null) return;
      // The chat's line ends a chunk the same way: a paste with a newline in it sends the line
      // and what follows it is dropped, rather than becoming the next line's text (033). Only
      // an Enter that sent a line ends it, though — an empty one sends nothing, so a chunk that
      // begins with a newline is the line the owner pasted and not a tail to drop.
      if (before.kind === "chat" && key === "enter" && typed.length > 0) return;
      // And so does leaving the chat mid-chunk. A tab in pasted text — two columns of a table
      // — flips to the card view, where the letters after it would be keys: `a` answering the
      // open question, `o` opening a shell. In the chat a paste is text, so what follows the
      // flip is dropped rather than acted on, whichever exit the chunk took.
      if (before.kind === "chat" && state.view.kind !== "chat") return;
    }
  }

  async function onEvent(event: Activity): Promise<void> {
    if (state === undefined || over) return;
    state = apply(state, event);
    const cardId = event.cardId;
    if (cardId !== null) {
      // A card the screen has never seen — one filed while it was open — and the open card,
      // whose feed the card view and the chat both draw, are read back whole.
      const missing = !state.cards.some((each) => each.id === cardId);
      const open = shows(state.view) === cardId;
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

  /** The screen takes the terminal: raw keys, the alternate screen, no cursor. */
  function takeTerminal(): void {
    input.setRawMode(true);
    input.resume();
    input.on(onData);
    screen.write(ENTER_ALTERNATE_SCREEN + HIDE_CURSOR);
  }

  /** And hands it back exactly as it found it — on the way out, and for `o`'s shell. */
  function freeTerminal(): void {
    input.off(onData);
    input.setRawMode(false);
    input.pause();
    screen.write(SHOW_CURSOR + LEAVE_ALTERNATE_SCREEN);
  }

  takeTerminal();
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
        `lost the daemon on ${deps.socketPath}; ${START_A_DAEMON}, and open the board again`,
      );
    }
  } finally {
    over = true;
    if (timer !== undefined) clearTimeout(timer);
    stopResize();
    // A shell holds the terminal already; it was handed back before that shell started.
    if (!suspended) freeTerminal();
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
      dataDir: ctx.dataDir,
      env: process.env,
      // The owner's own shell, in their own terminal, as them. The directory is a path and
      // never a command, and `worktreeOf` has already established that it is one of the
      // runner's own worktrees — a note may name it, but a note cannot choose it (027).
      spawnShell: async (shell, cwd) => {
        await Bun.spawn([shell], { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
          .exited;
      },
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
