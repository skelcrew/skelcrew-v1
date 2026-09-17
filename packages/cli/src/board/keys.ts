/**
 * What a key does, as a function of the state and nothing else. A key that answers does not
 * make the call: it yields the action, and the loop makes it, so what every key means is
 * readable — and testable — without a terminal or a daemon.
 */
import { PHASES, type Phase } from "@skelcrew/shared";
import { formatId, phaseName } from "../render";
import { cardLines, chatLines } from "./frame";
import { cardIdAt, type Prompt, questionOf, rowCount, type State, type View } from "./state";

/** The chat view, which carries the line being typed as well as the card and the scroll. */
type ChatView = Extract<View, { kind: "chat" }>;

/** The card view, which carries the chat's line for the flip back but draws none of it. */
type CardView = Extract<View, { kind: "card" }>;

/** The chat on a card, at the newest of the conversation, with the line it was left writing. */
function chatOn(cardId: number, text = ""): ChatView {
  return { kind: "chat", cardId, scroll: 0, text };
}

/** The card view of a card, holding the chat's line while the owner reads the body. */
function cardOn(cardId: number, text = ""): CardView {
  return { kind: "card", cardId, scroll: 0, text };
}

/**
 * The chat, with whatever the screen said last left behind. The chat has no bottom line of its
 * own for a sentence: the listening line is where one is read, and a sentence carried in from
 * the board would sit there over the card's open question, which is the one thing the view is
 * there to show (033, after review round 1).
 */
function entersChat(state: State, cardId: number, text = ""): Pressed {
  return { state: { ...state, view: chatOn(cardId, text), message: "" } };
}

/**
 * What the loop is asked to do. Every action but `quit` and `open-shell` is one of the CLI's
 * own calls with the parameters its command would send (027's criterion 6).
 */
export type Action =
  | { kind: "quit" }
  /** `resolve <id> -m <text>`. */
  | { kind: "resolve"; id: number; text: string }
  /** `mv <id> <phase> [-m <message>]`. */
  | { kind: "move"; id: number; phase: Phase; message?: string }
  /** `comment <id> <text>`. */
  | { kind: "comment"; id: number; text: string }
  /** `add <title>`. */
  | { kind: "add"; title: string }
  /** `archive <id>`. */
  | { kind: "archive"; id: number }
  /** The owner's shell, in the card's worktree. No call. */
  | { kind: "open-shell"; id: number };

export interface Pressed {
  state: State;
  action?: Action;
}

const QUIT: Pressed["action"] = { kind: "quit" };

/** The screen's one sentence, when a key does not apply to the row it was pressed on. */
function says(state: State, message: string): Pressed {
  return { state: { ...state, message } };
}

function opens(state: State, prompt: Prompt): Pressed {
  return { state: { ...state, prompt, message: "" } };
}

/** The phase before this one on the track; Idea has none. */
function previousPhase(phase: Phase): Phase | undefined {
  const index = PHASES.findIndex((each) => each.id === phase);
  return index > 0 ? (PHASES[index - 1] as (typeof PHASES)[number]).id : undefined;
}

/** The phase after this one on the track; Done has none. */
function nextPhase(phase: Phase): Phase | undefined {
  const index = PHASES.findIndex((each) => each.id === phase);
  const next = index < 0 ? undefined : PHASES[index + 1];
  return next?.id;
}

/**
 * Why `s` leaves a card where it is, by the phase it is in — one sentence each, and `null`
 * where `s` starts the card instead. The phases whose exit belongs to a run's artefact or to
 * the merge are not the owner's to force from a key: a run moves a card out of Code when the
 * pull request exists (014), and the daemon moves it out of PR when that pull request is
 * merged (018). Every phase is named, so a sixth one is a compile error here rather than a
 * silent move.
 */
const STAYS: Record<Phase, ((id: string) => string) | null> = {
  idea: null,
  spec: null,
  code: (id) =>
    `${id} is in ${phaseName("code")}; the run moves it to ${phaseName("pr")} when the pull request exists`,
  pr: (id) =>
    `${id} is in ${phaseName("pr")}; merge the pull request and the daemon moves it to ${phaseName("done")}`,
  done: (id) => `${id} is done`,
};

/**
 * The keys that answer, on one card: the same eight wherever the cursor is, because the card
 * view shows one card and the board's selected row is one card. `undefined` when the key is
 * not one of them.
 */
function act(state: State, cardId: number, key: string): Pressed | undefined {
  const none = `${formatId(cardId)} has no open question`;
  switch (key) {
    case "a": {
      if (questionOf(state, cardId) === undefined) return says(state, none);
      return { state, action: { kind: "resolve", id: cardId, text: "allow" } };
    }
    case "d": {
      if (questionOf(state, cardId) === undefined) return says(state, none);
      return opens(state, { kind: "deny", cardId, text: "" });
    }
    case "m": {
      const question = questionOf(state, cardId);
      if (question === undefined) return says(state, none);
      const phase = question.moves[0];
      if (phase === undefined) {
        return says(state, `the request on ${formatId(cardId)} offers no move`);
      }
      return { state, action: { kind: "move", id: cardId, phase } };
    }
    case "b": {
      const card = state.cards.find((each) => each.id === cardId);
      const phase = card === undefined ? undefined : previousPhase(card.phase);
      if (phase === undefined) {
        return says(state, `${formatId(cardId)} is in ${phaseName("idea")}; there is nowhere back`);
      }
      return opens(state, { kind: "back", cardId, phase, text: "" });
    }
    case "s": {
      // The owner's approval, and it carries no message: the card's body is the artefact being
      // approved, and feedback with a move is `b`.
      const card = state.cards.find((each) => each.id === cardId);
      const stays = card === undefined ? null : STAYS[card.phase];
      if (stays !== null) return says(state, stays(formatId(cardId)));
      const phase = card === undefined ? undefined : nextPhase(card.phase);
      if (phase === undefined) return says(state, `${formatId(cardId)} is not on the board`);
      return { state, action: { kind: "move", id: cardId, phase } };
    }
    case "c":
      return opens(state, { kind: "comment", cardId, text: "" });
    case "x": {
      // A question first: there is no unarchive. The title is taken now, so the question goes
      // on naming the card even if the card leaves the board while it is open.
      const card = state.cards.find((each) => each.id === cardId);
      return opens(state, { kind: "archive", cardId, title: card?.title ?? "" });
    }
    case "o":
      return { state, action: { kind: "open-shell", id: cardId } };
    default:
      return undefined;
  }
}

/** What Enter sends, by what the prompt was opened for. An empty `d` denies in one word. */
function sent(prompt: Prompt): Action {
  switch (prompt.kind) {
    case "deny":
      return { kind: "resolve", id: prompt.cardId, text: prompt.text || "deny" };
    case "back":
      // No message is `mv <id> <phase>`, which is the call that carries none.
      return prompt.text.length === 0
        ? { kind: "move", id: prompt.cardId, phase: prompt.phase }
        : { kind: "move", id: prompt.cardId, phase: prompt.phase, message: prompt.text };
    case "comment":
      return { kind: "comment", id: prompt.cardId, text: prompt.text };
    case "add":
      return { kind: "add", title: prompt.text };
    case "archive":
      return { kind: "archive", id: prompt.cardId };
  }
}

/** One character as the terminal sends it, rather than one of the named keys. */
function printable(key: string): boolean {
  return [...key].length === 1 && key >= " ";
}

/**
 * The prompt has every key while it is open: Enter sends, Esc cancels, Backspace and printable
 * characters edit, and nothing else is interpreted — a `q` here is a letter, not the way out.
 */
function pressPrompt(state: State, prompt: Prompt, key: string): Pressed {
  if (prompt.kind === "archive") {
    // A question rather than a line: Enter archives, Esc keeps the card, and every other key
    // leaves the question exactly as it is rather than answering it by accident.
    if (key === "enter") return { state: { ...state, prompt: null }, action: sent(prompt) };
    if (key === "escape") return { state: { ...state, prompt: null } };
    return { state };
  }
  switch (key) {
    case "enter":
      // A card needs a title, and the prompt closes so that the sentence can be read: the
      // prompt has the bottom line while it is open.
      if (prompt.kind === "add" && prompt.text.length === 0) {
        return says({ ...state, prompt: null }, "a card needs a title");
      }
      return { state: { ...state, prompt: null }, action: sent(prompt) };
    case "escape":
      return { state: { ...state, prompt: null } };
    case "backspace":
      return {
        state: { ...state, prompt: { ...prompt, text: [...prompt.text].slice(0, -1).join("") } },
      };
    default:
      if (!printable(key)) return { state };
      return { state: { ...state, prompt: { ...prompt, text: prompt.text + key } } };
  }
}

/**
 * What a line typed in the chat sends. While a question is open on the card, `allow` and a
 * line that is or begins `deny` answer it — the two words the listening line offers, read from
 * the line because in this view letters are text and a keypress would be one. Every other
 * line, and every line with no question open, is a comment on the card, which is how feedback
 * and mid-run answers travel (012, 015).
 */
function said(state: State, cardId: number, text: string): Action {
  const answers = text === "allow" || text === "deny" || text.startsWith("deny ");
  return answers && questionOf(state, cardId) !== undefined
    ? { kind: "resolve", id: cardId, text }
    : { kind: "comment", id: cardId, text };
}

/** The chat scrolled to `scroll` lines back from the newest, and no further than its first. */
function chatScrollTo(state: State, view: ChatView, scroll: number): Pressed {
  // The reducer knows the conversation but not the terminal, which is why the loop tightens
  // this to the window with `clampScroll`, as it does for the card view.
  const top = Math.max(0, chatLines(state).length - 1);
  return { state: { ...state, view: { ...view, scroll: Math.min(Math.max(0, scroll), top) } } };
}

/**
 * The chat has one key that is not text: Tab, which flips to the card view. Esc clears the
 * line and leaves for the board when there is nothing to clear, the arrows scroll the
 * conversation, Enter sends, and everything printable is text — an `a` here is a letter, not
 * an answer. Anything typed brings the conversation back to the newest, which is where the
 * line being written belongs.
 *
 * Any key at all clears what the daemon said last — `press` does it for every view — so the
 * listening line holds a refusal until the owner does something and then goes back to saying
 * who is listening.
 */
function pressChat(state: State, view: ChatView, key: string): Pressed {
  const typed = (text: string): Pressed => ({
    state: { ...state, view: { ...view, text, scroll: 0 } },
  });
  switch (key) {
    case "tab":
      // The line goes with the flip: the card view holds it, undrawn, until Tab comes back.
      return { state: { ...state, view: cardOn(view.cardId, view.text) } };
    case "escape":
      if (view.text.length === 0) return { state: { ...state, view: { kind: "board" } } };
      return { state: { ...state, view: { ...view, text: "" } } };
    case "enter":
      // An empty line sends nothing: the view is open, so Enter on it is a key pressed in
      // passing rather than something said.
      if (view.text.length === 0) return { state };
      return { state: typed("").state, action: said(state, view.cardId, view.text) };
    case "backspace":
      return typed([...view.text].slice(0, -1).join(""));
    case "up":
      return chatScrollTo(state, view, view.scroll + 1);
    case "down":
      return chatScrollTo(state, view, view.scroll - 1);
    default:
      if (!printable(key)) return { state };
      return typed(view.text + key);
  }
}

function moveTo(state: State, cursor: number): Pressed {
  const last = rowCount(state) - 1;
  if (last < 0) return { state };
  return { state: { ...state, cursor: Math.min(Math.max(0, cursor), last) } };
}

function pressBoard(state: State, key: string): Pressed {
  const cardId = cardIdAt(state, state.cursor);
  if (cardId !== undefined) {
    const acted = act(state, cardId, key);
    if (acted !== undefined) return acted;
  }
  switch (key) {
    case "j":
      return moveTo(state, state.cursor + 1);
    case "k":
      return moveTo(state, state.cursor - 1);
    case "g":
      return moveTo(state, 0);
    case "G":
      return moveTo(state, rowCount(state) - 1);
    case "n":
      // The board only: the card view is one card, and a card filed there has no row to land
      // on. The cursor stays where it is; the new card arrives as an event, like anything else.
      return opens(state, { kind: "add", text: "" });
    case "enter": {
      // Entering a card is entering the chat on it (033): the card itself is one Tab away.
      const cardId = cardIdAt(state, state.cursor);
      if (cardId === undefined) return { state };
      return entersChat(state, cardId);
    }
    case "?":
      return { state: { ...state, view: { kind: "help", from: state.view } } };
    case "q":
      return { state, action: QUIT };
    default:
      return { state };
  }
}

function pressCard(state: State, view: CardView, key: string): Pressed {
  const cardId = view.cardId;
  const acted = act(state, cardId, key);
  if (acted !== undefined) return acted;
  switch (key) {
    case "tab":
      // Back to the line this view was flipped from, which it has been holding since.
      return entersChat(state, cardId, view.text);
    // The scroll counts lines up from the newest, so `k` goes back and `j` returns.
    case "j":
      return scrollTo(state, view.scroll - 1);
    case "k":
      return scrollTo(state, view.scroll + 1);
    case "q":
    case "escape":
      return { state: { ...state, view: { kind: "board" } } };
    case "?":
      return { state: { ...state, view: { kind: "help", from: state.view } } };
    default:
      return { state };
  }
}

function scrollTo(state: State, scroll: number): Pressed {
  const view = state.view;
  if (view.kind !== "card") return { state };
  // The top of what `show` would print is as far back as it goes.
  const top = Math.max(0, cardLines(state).length - 1);
  return { state: { ...state, view: { ...view, scroll: Math.min(Math.max(0, scroll), top) } } };
}

/**
 * The arrows, as the letters they move like: Down is `j` and Up is `k` (031), so the views
 * below gain no second path and nothing is reachable by the arrows alone. The prompt is above
 * this: neither is text, and neither moves anything while one is open.
 */
function moving(key: string): string {
  if (key === "down") return "j";
  if (key === "up") return "k";
  return key;
}

/**
 * The key, on the state. Ctrl-C is the one key every view answers the same way — the prompt
 * included, where Esc is the cancel and Ctrl-C is still the way out of the screen; every other
 * key the view does not use leaves the state exactly as it was, so a stray byte draws nothing.
 *
 * What was said last goes first, whatever the key turns out to do: a sentence is shown on the
 * frame that follows the key or the call that set it and on no later one, so the bottom line
 * goes back to teaching as soon as the owner presses anything (034). A key with a sentence of
 * its own sets it in this same press, through `says`.
 */
export function press(state: State, key: string): Pressed {
  if (state.message.length > 0) return press({ ...state, message: "" }, key);
  if (key === "ctrl-c") return { state, action: QUIT };
  if (state.prompt !== null) return pressPrompt(state, state.prompt, key);
  switch (state.view.kind) {
    case "board":
      return pressBoard(state, moving(key));
    case "card":
      return pressCard(state, state.view, moving(key));
    case "chat":
      // The arrows are not `j` and `k` here: both letters are text.
      return pressChat(state, state.view, key);
    case "help":
      // Any key closes the keys, back to wherever they were opened from.
      return { state: { ...state, view: state.view.from } };
  }
}
