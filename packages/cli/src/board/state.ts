/**
 * What the screen knows: the daemon's data as one round of requests left it, updated by the
 * activity events that arrive after. Nothing here talks to a terminal and nothing here changes
 * a card — the screen reads.
 */
import type {
  Activity,
  Attention,
  Card,
  CardDetail,
  Claim,
  Client,
  Member,
  OpenAttention,
  Phase,
} from "@skelcrew/shared";
import { firstLine } from "../render";

/** Which of the three screens is open. `help` remembers where it was opened from. */
export type View =
  | { kind: "board" }
  | { kind: "card"; cardId: number; scroll: number }
  | { kind: "help"; from: View };

/**
 * The one-line message being typed, what it is for, and the card it will be sent on. It is a
 * field rather than a fourth view because it is one line at the bottom of whichever view is
 * open: the board or the card stays drawn behind it (027).
 */
export type Prompt =
  | { kind: "deny"; cardId: number; text: string }
  /** `phase` is fixed when the prompt opens: the move the owner was told about is the one sent. */
  | { kind: "back"; cardId: number; phase: Phase; text: string }
  | { kind: "comment"; cardId: number; text: string }
  /** A new card's title. The one prompt about no card in particular (032). */
  | { kind: "add"; text: string }
  /**
   * The question before an archive, which cannot be undone: it takes no text (032). The
   * `title` is taken when the question opens, so the line goes on naming the card it asks
   * about even in the moment before the question closes on the card leaving the board.
   */
  | { kind: "archive"; cardId: number; title: string };

export interface State {
  /** The member the screen is rendered for: whoever the CLI connected as. */
  me: number;
  members: Member[];
  /** Every unarchived card, in id order. */
  cards: Card[];
  /** The open requests addressed to `me`, oldest first. */
  requests: OpenAttention[];
  /** By card id: the first line of the last comment that card's run posted. */
  lastLine: Record<number, string>;
  /** One index over the queue rows and then the board rows. */
  cursor: number;
  view: View;
  /** The open card, once the loop has read it; null while there is none to show. */
  detail: CardDetail | null;
  /** The line being typed, or null: the screen's only text input. */
  prompt: Prompt | null;
  /** The screen's one sentence. Empty until something has to be said. */
  message: string;
}

/**
 * The card's open request, whoever it is addressed to — what `a`, `d` and `m` answer. A
 * request addressed to someone else is sent all the same and refused by the daemon, which is
 * one rule in one place rather than two that can disagree.
 */
export function questionOf(state: State, cardId: number): Attention | undefined {
  const card = state.cards.find((each) => each.id === cardId);
  if (card !== undefined && card.attention !== null) return card.attention;
  return state.requests.find((request) => request.cardId === cardId);
}

/** The queue rows and the board rows, as one list: what the cursor moves through. */
export function rowCount(state: State): number {
  return state.requests.length + state.cards.length;
}

/** The card the row at `index` is about, or undefined when there is no such row. */
export function cardIdAt(state: State, index: number): number | undefined {
  const request = state.requests[index];
  if (request !== undefined) return request.cardId;
  return state.cards[index - state.requests.length]?.id;
}

function live(claim: Claim | null, now: number): boolean {
  return claim !== null && claim.expiresAt > now;
}

/**
 * The first line of the last comment the card's current run posted, or undefined when this run
 * has said nothing yet. "The run" is whoever holds the live claim: the runner in every real
 * case, and the constant that names it lives in the daemon, which no client imports. Comments
 * from before the claim belong to an earlier run and are not this row's line.
 */
function lastComment(detail: CardDetail, claim: Claim): string | undefined {
  for (let index = detail.activity.length - 1; index >= 0; index -= 1) {
    const event = detail.activity[index] as Activity;
    if (event.createdAt < claim.claimedAt) return undefined;
    if (event.type === "comment" && event.actorId === claim.by) return firstLine(event.data.text);
  }
  return undefined;
}

/**
 * One round of requests: the cards, the open requests, the members, and the feed of every
 * running card for its last line. Everything after this arrives as an event.
 */
export async function load(client: Client): Promise<State> {
  const me = client.member.id;
  const now = Date.now();
  const [cards, requests, members] = await Promise.all([
    client.call("listCards", {}),
    client.call("listAttention", { to: me }),
    client.call("listMembers", {}),
  ]);
  const running = cards.filter((card) => live(card.claim, now));
  const details = await Promise.all(running.map((card) => client.call("getCard", { id: card.id })));
  const lastLine: Record<number, string> = {};
  details.forEach((detail, index) => {
    const line = lastComment(detail, (running[index] as Card).claim as Claim);
    if (line !== undefined) lastLine[detail.id] = line;
  });
  return {
    me,
    members,
    cards,
    requests,
    lastLine,
    cursor: 0,
    view: { kind: "board" },
    detail: null,
    prompt: null,
    message: "",
  };
}

function withCard(state: State, cardId: number, change: (card: Card) => Card): State {
  return { ...state, cards: state.cards.map((card) => (card.id === cardId ? change(card) : card)) };
}

/** The requests addressed to me, oldest first, with this card's one replaced or removed. */
function withRequest(state: State, cardId: number, request?: OpenAttention): OpenAttention[] {
  const rest = state.requests.filter((open) => open.cardId !== cardId);
  if (request === undefined) return rest;
  return [...rest, request].sort((a, b) => a.raisedAt - b.raisedAt);
}

/** The same view with the card underneath it gone: the keys stay up, over the board. */
function closed(view: View): View {
  return view.kind === "help" ? { kind: "help", from: { kind: "board" } } : { kind: "board" };
}

/** A cursor that outlived its row sits on the last one. */
function clamp(state: State): State {
  const last = Math.max(0, rowCount(state) - 1);
  return state.cursor <= last ? state : { ...state, cursor: last };
}

/**
 * The event, on the state. Idempotent for every event it handles, so re-applying one the
 * initial load already reflected costs nothing but the work.
 *
 * The clock is the event's own `createdAt`: whether the claim was live is a question about the
 * moment the comment was posted, not about the moment the frame is drawn.
 */
export function apply(state: State, event: Activity): State {
  if (event.type === "member_joined") {
    const member: Member = {
      id: event.actorId,
      name: event.data.name,
      kind: event.data.kind,
      createdAt: event.createdAt,
    };
    // Replaced rather than appended: the member may be one the initial read already had.
    const known = state.members.some((each) => each.id === member.id);
    const members = known
      ? state.members.map((each) => (each.id === member.id ? member : each))
      : [...state.members, member];
    return { ...state, members };
  }
  const cardId = event.cardId;
  if (cardId === null) return state;
  const card = state.cards.find((each) => each.id === cardId);
  if (card === undefined) return state;

  switch (event.type) {
    case "comment": {
      // Only the run's own comments, and only while it holds the card: a member talking on a
      // card the crew is working is talking, not working.
      if (!live(card.claim, event.createdAt) || (card.claim as Claim).by !== event.actorId) {
        return state;
      }
      return { ...state, lastLine: { ...state.lastLine, [cardId]: firstLine(event.data.text) } };
    }
    case "card_moved":
      return withCard(state, cardId, (each) => ({ ...each, phase: event.data.to }));
    case "claimed":
      return withCard(state, cardId, (each) => ({
        ...each,
        claim: {
          by: event.actorId,
          claimedAt: event.createdAt,
          expiresAt: event.data.expiresAt,
          ttlSeconds: event.data.ttlSeconds,
        },
      }));
    case "released":
    case "run_interrupted": {
      // The line belongs to the run that wrote it: a card nobody holds carries none.
      const { [cardId]: _gone, ...lastLine } = state.lastLine;
      const free = withCard(state, cardId, (each) => ({ ...each, claim: null }));
      return { ...free, lastLine };
    }
    case "attention_requested": {
      const held = withCard(state, cardId, (each) => ({ ...each, attention: event.data }));
      const mine = event.data.to === state.me ? { cardId, ...event.data } : undefined;
      return { ...held, requests: withRequest(held, cardId, mine) };
    }
    case "attention_resolved": {
      const held = withCard(state, cardId, (each) => ({ ...each, attention: null }));
      return clamp({ ...held, requests: withRequest(held, cardId) });
    }
    case "card_archived": {
      // The board is the unarchived cards, and an archived card's request went with it. A card
      // view open on it closes to the board: there is no row behind it to come back to. The keys
      // screen stays open — no key has closed it — but the card it was opened from becomes the
      // board, so the key that closes it does not land on a card that has left. So does the
      // question about archiving it: the card is gone, so there is nothing left to ask.
      const behind = state.view.kind === "help" ? state.view.from : state.view;
      const open = behind.kind === "card" && behind.cardId === cardId;
      const asking = state.prompt?.kind === "archive" && state.prompt.cardId === cardId;
      return clamp({
        ...state,
        cards: state.cards.filter((each) => each.id !== cardId),
        requests: withRequest(state, cardId),
        view: open ? closed(state.view) : state.view,
        prompt: asking ? null : state.prompt,
      });
    }
    default:
      return state;
  }
}
