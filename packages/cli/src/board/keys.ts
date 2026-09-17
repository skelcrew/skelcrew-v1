/**
 * What a key does, as a function of the state and nothing else. A key that answers does not
 * make the call: it yields the action, and the loop makes it, so what every key means is
 * readable — and testable — without a terminal or a daemon.
 */
import { PHASES, type Phase } from "@skelcrew/shared";
import { formatId, phaseName } from "../render";
import { cardLines } from "./frame";
import { cardIdAt, type Prompt, questionOf, rowCount, type State } from "./state";

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
 * The keys that answer, on one card: the same seven wherever the cursor is, because the card
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
      const cardId = cardIdAt(state, state.cursor);
      if (cardId === undefined) return { state };
      return { state: { ...state, view: { kind: "card", cardId, scroll: 0 } } };
    }
    case "?":
      return { state: { ...state, view: { kind: "help", from: state.view } } };
    case "q":
      return { state, action: QUIT };
    default:
      return { state };
  }
}

function pressCard(state: State, cardId: number, scroll: number, key: string): Pressed {
  const acted = act(state, cardId, key);
  if (acted !== undefined) return acted;
  switch (key) {
    // The scroll counts lines up from the newest, so `k` goes back and `j` returns.
    case "j":
      return scrollTo(state, scroll - 1);
    case "k":
      return scrollTo(state, scroll + 1);
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
 */
export function press(state: State, key: string): Pressed {
  if (key === "ctrl-c") return { state, action: QUIT };
  if (state.prompt !== null) return pressPrompt(state, state.prompt, key);
  switch (state.view.kind) {
    case "board":
      return pressBoard(state, moving(key));
    case "card":
      return pressCard(state, state.view.cardId, state.view.scroll, moving(key));
    case "help":
      // Any key closes the keys, back to wherever they were opened from.
      return { state: { ...state, view: state.view.from } };
  }
}
