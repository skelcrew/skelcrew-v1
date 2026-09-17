/**
 * The screen as text: one string per terminal row, pure. Every line is the CLI's own rendering
 * — `row`, `status` and `cardView` — so the board and `ls`, `queue` and `show` can never
 * disagree about what a card is doing.
 *
 * Every line is composed as plain text, escaped, and only then emphasised, in that order: a
 * title or a note carrying an escape sequence is made visible by `oneLine` before the frame
 * adds the only control characters the screen writes on purpose (015).
 */
import type { Card, OpenAttention } from "@skelcrew/shared";
import { cardView, firstLine, formatId, oneLine, phaseName, row, status } from "../render";
import { bold, dim, reverse } from "./ansi";
import type { Prompt, State, View } from "./state";

export interface Size {
  columns: number;
  rows: number;
}

/** Below this the screen asks for a larger terminal instead of drawing. */
export const MIN_COLUMNS = 60;
export const MIN_ROWS = 12;

/** What a terminal says it is, or 80×24 when the runtime reports nothing (Bun under `script`). */
export function sizeOf(screen: { columns?: number; rows?: number }): Size {
  const columns = screen.columns;
  const rows = screen.rows;
  return {
    columns: columns === undefined || columns === 0 ? 80 : columns,
    rows: rows === undefined || rows === 0 ? 24 : rows,
  };
}

/**
 * How wide the text is on the terminal, in cells. `Bun.stringWidth` is the runtime's own
 * measure: a CJK character and an emoji take two cells, a combining mark none. Counting code
 * points or UTF-16 units instead lets a line of Japanese run past the right edge, wrap onto a
 * second physical row, and scroll the top of the board off the screen on every redraw.
 */
function cells(text: string): number {
  return Bun.stringWidth(text);
}

/**
 * `text` within `columns` cells, the last one an ellipsis when something was dropped. A cluster
 * whose parts are wider apart than together — an emoji built from several code points — is cut
 * early rather than late: the line is then shorter than the terminal, never wider.
 */
function cut(text: string, columns: number): string {
  if (cells(text) <= columns) return text;
  let kept = "";
  let used = 0;
  for (const char of text) {
    const width = cells(char);
    if (used + width > columns - 1) break;
    kept += char;
    used += width;
  }
  return `${kept}…`;
}

/**
 * `text` within `columns` cells, keeping its end rather than its start: the first cell is an
 * ellipsis when something was dropped. What is being typed stays on the screen this way, where
 * cutting the other end would leave the owner writing past the right edge, blind.
 */
function cutStart(text: string, columns: number): string {
  if (cells(text) <= columns) return text;
  let kept = "";
  let used = 0;
  for (const char of [...text].reverse()) {
    const width = cells(char);
    if (used + width > columns - 1) break;
    kept = char + kept;
    used += width;
  }
  return `…${kept}`;
}

/** `text` filled with spaces to `columns` cells. */
function pad(text: string, columns: number): string {
  return text + " ".repeat(Math.max(0, columns - cells(text)));
}

/** One line of a stored field, on a terminal this wide. */
function fit(text: string, columns: number): string {
  return cut(oneLine(text), columns);
}

/** A row, in reverse video when the cursor is on it. */
function rowLine(text: string, columns: number, selected: boolean): string {
  const line = fit(text, columns);
  return selected ? reverse(pad(line, columns)) : line;
}

/** The card id, the title, and the note's first line — 022's `why:` where the note has one. */
function queueRow(request: OpenAttention, state: State, idWidth: number): string {
  const card = state.cards.find((each) => each.id === request.cardId);
  const title = card === undefined ? "" : oneLine(card.title);
  return [formatId(request.cardId).padStart(idWidth), title, firstLine(request.note)].join("  ");
}

/**
 * The row `ls` prints, and after the title the first line of the last comment a running card's
 * run posted, so a row changes as the agent works and one that has not changed stands out.
 */
function boardRow(
  card: Card,
  widths: { id: number; status: number },
  state: State,
  now: number,
): string {
  const base = row(card, widths, state.me, state.members, now);
  const line = state.lastLine[card.id];
  const running = card.claim !== null && card.claim.expiresAt > now;
  return running && line !== undefined && line.length > 0 ? `${base}  ${line}` : base;
}

/** What the prompt is for, as the line says it before the text being typed. */
function promptLabel(prompt: Prompt): string {
  switch (prompt.kind) {
    case "deny":
      return `deny ${formatId(prompt.cardId)}: `;
    case "back":
      return `${formatId(prompt.cardId)} back to ${phaseName(prompt.phase)}: `;
    case "comment":
      return `comment on ${formatId(prompt.cardId)}: `;
  }
}

/**
 * The screen's last line: the prompt while one is open — the terminal's own cursor is hidden,
 * so the caret is a reverse-video cell — and the one sentence otherwise.
 */
function bottomLine(state: State, size: Size): string {
  const prompt = state.prompt;
  if (prompt !== null) {
    // One cell is kept for the caret, so the line still fits when the text fills the terminal,
    // and the line is cut at its start so that the caret's end of it is the part that stays.
    return cutStart(oneLine(promptLabel(prompt) + prompt.text), size.columns - 1) + reverse(" ");
  }
  return state.message.length === 0 ? "" : dim(fit(state.message, size.columns));
}

/**
 * The lines, the terminal's height, and the one line the screen keeps for a sentence or the
 * prompt. The window follows the cursor when there is more to show than there is room for.
 */
function screenful(lines: string[], cursorLine: number, size: Size, bottom: string): string[] {
  const available = size.rows - 1;
  let start = 0;
  if (lines.length > available) {
    const wanted = cursorLine < 0 ? 0 : cursorLine - Math.floor(available / 2);
    start = Math.min(Math.max(0, wanted), lines.length - available);
  }
  const shown = lines.slice(start, start + available);
  while (shown.length < available) shown.push("");
  shown.push(bottom);
  return shown;
}

function boardFrame(state: State, size: Size, now: number): string[] {
  const { columns } = size;
  const lines: string[] = [];
  let cursorLine = -1;

  lines.push(dim("waiting on you"));
  if (state.requests.length === 0) lines.push(dim("nothing is waiting on you"));
  const queueIds = Math.max(2, ...state.requests.map((r) => formatId(r.cardId).length));
  state.requests.forEach((request, index) => {
    const selected = index === state.cursor;
    if (selected) cursorLine = lines.length;
    lines.push(rowLine(queueRow(request, state, queueIds), columns, selected));
  });

  lines.push(dim("─".repeat(columns)));
  lines.push(dim("board"));
  if (state.cards.length === 0) {
    lines.push(dim('no cards yet; file one with: skelcrew add "<title>"'));
  }
  const widths = {
    id: Math.max(2, ...state.cards.map((card) => formatId(card.id).length)),
    status: Math.max(0, ...state.cards.map((c) => status(c, state.me, state.members, now).length)),
  };
  state.cards.forEach((card, index) => {
    const selected = state.requests.length + index === state.cursor;
    if (selected) cursorLine = lines.length;
    lines.push(rowLine(boardRow(card, widths, state, now), columns, selected));
  });

  return screenful(lines, cursorLine, size, bottomLine(state, size));
}

/** The open card exactly as `show` prints it, or a word while it is being read. */
export function cardLines(state: State, now = Date.now()): string[] {
  const open = state.view.kind === "card" ? state.view.cardId : undefined;
  const detail = state.detail;
  if (detail === null || detail.id !== open) return ["reading the card …"];
  return cardView(detail, state.members, state.me, now).split("\n");
}

/**
 * The scroll the frame draws at: back as far as the card's first line reaching the top of the
 * window, and no further, so one `j` moves the view rather than taking up slack. The reducer
 * knows the card but not the terminal, which is why this lives here and the loop applies it.
 */
function scrollWithin(lineCount: number, size: Size, scroll: number): number {
  return Math.min(Math.max(0, scroll), Math.max(0, lineCount - (size.rows - 1)));
}

/** The state with the card view's scroll brought inside what this terminal can show. */
export function clampScroll(state: State, size: Size): State {
  const view = state.view;
  if (view.kind !== "card") return state;
  const scroll = scrollWithin(cardLines(state).length, size, view.scroll);
  return scroll === view.scroll ? state : { ...state, view: { ...view, scroll } };
}

function cardFrame(state: State, view: View & { kind: "card" }, size: Size, now: number): string[] {
  const lines = cardLines(state, now);
  const available = size.rows - 1;
  // The scroll counts lines up from the newest, which is where the view opens.
  const end = lines.length - scrollWithin(lines.length, size, view.scroll);
  const start = Math.max(0, end - available);
  const shown = lines.slice(start, end).map((line, index) => {
    const text = fit(line, size.columns);
    // The card's first line is its id and title: the one place the screen uses bold.
    return start + index === 0 ? bold(text) : text;
  });
  return screenful(shown, -1, size, bottomLine(state, size));
}

const KEYS = [
  "  j, k, ↓, ↑   down and up; in a card, scroll",
  "  g, G         the first row and the last",
  "  enter        open the card under the cursor",
  "  esc, q       back to the board",
  "  s            start the card: Idea into Spec, Spec into Code",
  "  a            allow the open question",
  "  d            deny it, with a message",
  "  m            take the move the request offers",
  "  b            send the card back a phase, with a message",
  "  c            comment on the card",
  "  o            a shell in the card's worktree",
  "  ?            these keys",
  "  q            quit",
];

function helpFrame(state: State, size: Size): string[] {
  const lines = [dim("keys"), "", ...KEYS.map((line) => fit(line, size.columns))];
  return screenful(lines, -1, size, bottomLine(state, size));
}

export function frame(state: State, size: Size, now = Date.now()): string[] {
  if (size.columns < MIN_COLUMNS || size.rows < MIN_ROWS) {
    const asked = `${MIN_COLUMNS}×${MIN_ROWS}`;
    const has = `${size.columns}×${size.rows}`;
    return [fit(`skelcrew needs at least ${asked}; this is ${has}`, size.columns)];
  }
  switch (state.view.kind) {
    case "board":
      return boardFrame(state, size, now);
    case "card":
      return cardFrame(state, state.view, size, now);
    case "help":
      return helpFrame(state, size);
  }
}
