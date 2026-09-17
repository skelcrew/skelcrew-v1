/**
 * The screen as text: one string per terminal row, pure. Every line is the CLI's own rendering
 * — `row`, `status` and `cardView` — so the board and `ls`, `queue` and `show` can never
 * disagree about what a card is doing.
 *
 * Every line is composed as plain text, escaped, and only then emphasised, in that order: a
 * title or a note carrying an escape sequence is made visible by `oneLine` before the frame
 * adds the only control characters the screen writes on purpose (015).
 */
import type { Activity, Card, CardDetail, Member, OpenAttention } from "@skelcrew/shared";
import {
  activityLine,
  cardHeader,
  cardView,
  firstLine,
  formatId,
  formatTime,
  markedLines,
  memberName,
  oneLine,
  phaseName,
  row,
  status,
} from "../render";
import { bold, dim, reverse } from "./ansi";
import { type Prompt, questionOf, type State, type View } from "./state";

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
function promptLabel(prompt: Exclude<Prompt, { kind: "archive" }>): string {
  switch (prompt.kind) {
    case "deny":
      return `deny ${formatId(prompt.cardId)}: `;
    case "back":
      return `${formatId(prompt.cardId)} back to ${phaseName(prompt.phase)}: `;
    case "comment":
      return `comment on ${formatId(prompt.cardId)}: `;
    case "add":
      return "new card: ";
  }
}

/**
 * The archive question: the card it is about, and both ways to answer it. The title is the
 * prompt's own, taken when the question opened, so the line reads the same whatever became of
 * the card under it. It is also what gets cut when the terminal is narrow, because Enter cannot
 * be undone and what it does has to stay on the screen.
 */
function archiveQuestion(prompt: Extract<Prompt, { kind: "archive" }>, columns: number): string {
  const asks = `archive ${formatId(prompt.cardId)} `;
  const answers = "? Enter archives, Esc keeps it";
  const room = columns - cells(asks) - cells(answers);
  return cut(asks + cut(oneLine(prompt.title), Math.max(0, room)) + answers, columns);
}

/**
 * A line being typed — the prompt's, and the chat's input. The terminal's own cursor is hidden,
 * so the caret is a reverse-video cell; one cell is kept for it, so the line still fits when the
 * text fills the terminal, and the line is cut at its start so that the caret's end of it is the
 * part that stays.
 */
function typedLine(text: string, size: Size): string {
  return cutStart(oneLine(text), size.columns - 1) + reverse(" ");
}

/**
 * The screen's last line: the prompt while one is open — the terminal's own cursor is hidden,
 * so the caret is a reverse-video cell — and the one sentence otherwise.
 */
function bottomLine(state: State, size: Size): string {
  const prompt = state.prompt;
  if (prompt !== null) {
    // The archive question takes no text, so it has no caret: it is read and answered.
    if (prompt.kind === "archive") return archiveQuestion(prompt, size.columns);
    return typedLine(promptLabel(prompt) + prompt.text, size);
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

/** What a view drawn from a card says while the loop is still reading that card. */
const READING = "reading the card …";

/** The open card exactly as `show` prints it, or a word while it is being read. */
export function cardLines(state: State, now = Date.now()): string[] {
  const open = state.view.kind === "card" ? state.view.cardId : undefined;
  const detail = state.detail;
  if (detail === null || detail.id !== open) return [READING];
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

/** The state with the open view's scroll brought inside what this terminal can show. */
export function clampScroll(state: State, size: Size, now = Date.now()): State {
  const view = state.view;
  if (view.kind === "card") {
    const scroll = scrollWithin(cardLines(state).length, size, view.scroll);
    return scroll === view.scroll ? state : { ...state, view: { ...view, scroll } };
  }
  if (view.kind === "chat") {
    const scroll = chatScrollWithin(state, view, size, now);
    return scroll === view.scroll ? state : { ...state, view: { ...view, scroll } };
  }
  return state;
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

/** One line of the conversation, and whether it is drawn dim. */
export interface ConversationLine {
  text: string;
  /** An event that is nobody talking: the card's record, between the turns. */
  quiet: boolean;
}

/**
 * A comment, as the turn it is: who said it and when, then its text with every line marked the
 * way `show` marks a body (015), the lines after the first under the name. A turn is as many
 * lines as it has; nothing of it is cut away, because it is what the owner came to read.
 */
function turnLines(
  event: Extract<Activity, { type: "comment" }>,
  members: Member[],
): ConversationLine[] {
  const who = `${formatTime(event.createdAt)}  ${memberName(event.actorId, members)}  `;
  const under = " ".repeat(cells(who));
  return markedLines(event.data.text).map((line, index) => ({
    text: (index === 0 ? who : under) + line,
    quiet: false,
  }));
}

/**
 * The card's activity as a conversation, oldest first: a comment is somebody talking — the
 * owner's lines, the agent's text turns, its tool summaries and its `allowed`/`denied` notes,
 * which are all comments on the card (012) — and every other event is the record between them,
 * as the line `show` prints for it. Who said what is the member's name, the same name those
 * lines carry.
 *
 * Pure, and the card's own record: there is no conversation anywhere but on the card.
 */
export function conversationLines(
  detail: CardDetail | null,
  members: Member[],
): ConversationLine[] {
  if (detail === null) return [];
  return detail.activity.flatMap((event) =>
    event.type === "comment"
      ? turnLines(event, members)
      : activityLine(event, members)
          .split("\n")
          .map((text) => ({ text, quiet: true })),
  );
}

/** The open chat's card, once the loop has read it; null while there is none to show. */
function chatCard(state: State, cardId: number): CardDetail | null {
  const detail = state.detail;
  return detail !== null && detail.id === cardId ? detail : null;
}

/** The open chat's conversation: what `Up` and `Down` scroll through. */
export function chatLines(state: State): ConversationLine[] {
  const view = state.view;
  if (view.kind !== "chat") return [];
  return conversationLines(chatCard(state, view.cardId), state.members);
}

/**
 * The header the chat draws and the rows left under it. The header is fixed at the top and the
 * two bottom lines — who is listening, and the input — are always drawn, so what a terminal
 * this size has room for is whatever is left.
 */
function chatShape(state: State, cardId: number, size: Size, now: number) {
  const detail = chatCard(state, cardId);
  const header = detail === null ? [READING] : cardHeader(detail, state.members, state.me, now);
  const available = Math.max(0, size.rows - 2);
  // A header taller than the terminal cannot push the input off the bottom of it.
  const head = header.slice(0, available);
  return { head, room: available - head.length };
}

/** The scroll the chat draws at: back as far as the conversation's first line, and no further. */
function chatScrollWithin(state: State, view: View & { kind: "chat" }, size: Size, now: number) {
  const { room } = chatShape(state, view.cardId, size, now);
  const lines = conversationLines(chatCard(state, view.cardId), state.members).length;
  return Math.min(Math.max(0, view.scroll), Math.max(0, lines - room));
}

/** The prefix 024's `status` gives a card whose run holds a live claim. */
const RUNNING = "running since ";

/**
 * Who hears what is typed. The daemon's last word takes the line when it said something, so a
 * refused call is read where the owner is looking; the card's open question takes it while
 * there is one, with the two words the input understands; otherwise it is whether a run is
 * live, which is 024's `status` — one derivation, so this line and the card's row cannot come
 * to disagree about it.
 */
function listeningLine(state: State, cardId: number, size: Size, now: number): string {
  const said = state.message;
  if (said.length > 0) return dim(fit(said, size.columns));
  const question = questionOf(state, cardId);
  if (question !== undefined) {
    return dim(fit(`${firstLine(question.note)} · allow · deny · or write`, size.columns));
  }
  const card = state.cards.find((each) => each.id === cardId);
  const doing = card === undefined ? "" : status(card, state.me, state.members, now);
  const line = doing.startsWith(RUNNING)
    ? `crew is listening · ${doing}`
    : "no run is live; the next run reads what you write here";
  return dim(fit(line, size.columns));
}

/**
 * The card's header, the conversation under it with the newest at the bottom, the line that
 * says who is listening, and the input — which is open as long as the view is. The body is not
 * drawn: a spec does not fit over a conversation, and the card view has it whole, one Tab away.
 */
function chatFrame(state: State, view: View & { kind: "chat" }, size: Size, now: number): string[] {
  const { columns } = size;
  const { head, room } = chatShape(state, view.cardId, size, now);
  const lines = conversationLines(chatCard(state, view.cardId), state.members);
  const end = lines.length - chatScrollWithin(state, view, size, now);
  const start = Math.max(0, end - room);
  const shown = [
    // The card's first line is its id and title: the one place the screen uses bold.
    ...head.map((line, index) => (index === 0 ? bold(fit(line, columns)) : fit(line, columns))),
    ...lines
      .slice(start, end)
      .map((line) => (line.quiet ? dim(fit(line.text, columns)) : fit(line.text, columns))),
  ];
  while (shown.length < size.rows - 2) shown.push("");
  shown.push(listeningLine(state, view.cardId, size, now));
  shown.push(typedLine(view.text, size));
  return shown;
}

const KEYS = [
  "  j, k, ↓, ↑   down and up; in a card, scroll",
  "  g, G         the first row and the last",
  "  enter        open the chat on the card under the cursor",
  "  tab          flip between the chat and the card",
  "  esc, q       back to the board",
  "  n            file a card, by title",
  "  s            start the card: Idea into Spec, Spec into Code",
  "  a            allow the open question",
  "  d            deny it, with a message",
  "  m            take the move the request offers",
  "  b            send the card back a phase, with a message",
  "  c            comment on the card",
  "  x            archive the card, after a question",
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
    case "chat":
      return chatFrame(state, state.view, size, now);
    case "help":
      return helpFrame(state, size);
  }
}
