/**
 * What a key does, as a function of the state and nothing else. The screen changes nothing in
 * this spec, so the one action a key can ask the loop for is to quit; it is a union rather than
 * a flag because 027 adds the keys that call the daemon.
 */
import { cardLines } from "./frame";
import { cardIdAt, rowCount, type State } from "./state";

export type Action = { kind: "quit" };

export interface Pressed {
  state: State;
  action?: Action;
}

const QUIT: Pressed["action"] = { kind: "quit" };

function moveTo(state: State, cursor: number): Pressed {
  const last = rowCount(state) - 1;
  if (last < 0) return { state };
  return { state: { ...state, cursor: Math.min(Math.max(0, cursor), last) } };
}

function pressBoard(state: State, key: string): Pressed {
  switch (key) {
    case "j":
      return moveTo(state, state.cursor + 1);
    case "k":
      return moveTo(state, state.cursor - 1);
    case "g":
      return moveTo(state, 0);
    case "G":
      return moveTo(state, rowCount(state) - 1);
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

function pressCard(state: State, scroll: number, key: string): Pressed {
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
 * The key, on the state. Ctrl-C is the one key every view answers the same way; every other
 * key the view does not use leaves the state exactly as it was, so a stray byte draws nothing.
 */
export function press(state: State, key: string): Pressed {
  if (key === "ctrl-c") return { state, action: QUIT };
  switch (state.view.kind) {
    case "board":
      return pressBoard(state, key);
    case "card":
      return pressCard(state, state.view.scroll, key);
    case "help":
      // Any key closes the keys, back to wherever they were opened from.
      return { state: { ...state, view: state.view.from } };
  }
}
