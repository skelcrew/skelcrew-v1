/**
 * Plain text for a terminal: the row, the phase track, the card view, the activity line,
 * the queue. Nothing here talks to the daemon; every function takes what a command already
 * fetched.
 */
import {
  type Activity,
  type Attention,
  type AttentionResolution,
  type Card,
  type CardDetail,
  type CardRefs,
  type Claim,
  escapeControlCharacters,
  type Member,
  type OpenAttention,
  PHASES,
  type Phase,
} from "@skelcrew/shared";

/**
 * A stored single-line field — a title, a member name, a ref, a release reason — as one line:
 * every control character in the shared set is escaped, `\n` and `\t` included, so a row
 * written before 015 with a newline in its title is one row and not two. The sink escapes
 * whatever reaches it as well; this is what tells it which fields may keep their line breaks.
 *
 * Exported because a few commands compose a line of their own from a stored field — a member
 * name, a card's title, a notification — and there is one of these, not one per caller.
 */
export function oneLine(text: string): string {
  return escapeControlCharacters(text, "single-line");
}

/** The marker a line of a stored multi-line field carries, as 014's permission note quotes its payload. */
function markLine(line: string): string {
  return line.length === 0 ? ">" : `> ${line}`;
}

/**
 * A stored multi-line field that follows a label on the same line — a comment after
 * `commented: `, a note after `note:    `. The first line stays where the label put it and
 * every line after it is marked, so no line of it can read as a card row, an activity entry
 * or a queue block of its own.
 */
function continued(text: string, indent = ""): string {
  const [head = "", ...rest] = text.split("\n");
  return [head, ...rest.map((line) => indent + markLine(line))].join("\n");
}

/**
 * A stored multi-line field that stands on its own lines — a card's body, a note in the queue.
 * Every line is marked, the first included: it starts a line of its own, so it could otherwise
 * read as one the CLI composed.
 *
 * Exported by the line for the chat view, which draws a comment's text as the lines of a
 * terminal rather than as one string (033).
 */
export function markedLines(text: string): string[] {
  return text.split("\n").map(markLine);
}

function marked(text: string): string {
  return markedLines(text).join("\n");
}

export function formatId(id: number): string {
  return `#${id}`;
}

/** Local time, minute precision: `YYYY-MM-DD HH:MM`. */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function phaseName(phase: Phase): string {
  return PHASES.find((p) => p.id === phase)?.name ?? phase;
}

/** Five cells, one per phase in order, the current one filled. */
export function phaseTrack(phase: Phase): string {
  return PHASES.map((p) => (p.id === phase ? "●" : "○")).join("");
}

/** A member's name, as every line that attributes something writes it. */
export function memberName(id: number, members: Member[]): string {
  const found = members.find((m) => m.id === id);
  return found === undefined ? `member ${id}` : oneLine(found.name);
}

const PHASE_NAME_WIDTH = Math.max(...PHASES.map((p) => p.name.length));

/**
 * `!` waiting on the invoking member, `?` waiting on someone else; otherwise `*` held by
 * a live claim, `~` by one that lapsed and has not been swept; a space when none apply.
 * Waiting outranks running: what needs a person is what the column is for.
 */
function marker(card: Card, me: number, now: number): string {
  if (card.attention !== null) return card.attention.to === me ? "!" : "?";
  if (card.claim === null) return " ";
  return card.claim.expiresAt > now ? "*" : "~";
}

/**
 * The widest the status column gets, in characters — a screen column, so the cut is by
 * character and never by bytes. A longer status, which in practice is a waiting note, is cut
 * to it; the whole note is on the card, which `show` and `queue` print.
 *
 * Known limitation: the column is padded in UTF-16 units, so a note with wide characters in it
 * — `日本語のメモです` is 8 of them and twice that many terminal cells — pushes that row's title
 * right of the others. 026's TUI needs a display-width measure of its own, and this column
 * should adopt it then.
 */
export const STATUS_WIDTH = 40;

/** `text` within `width` characters, the last one an ellipsis when something was dropped. */
function cut(text: string, width: number): string {
  const chars = [...text];
  return chars.length <= width ? text : `${chars.slice(0, width - 1).join("")}…`;
}

/**
 * Local time of day, minute precision: `HH:MM`. A heartbeat moves only the expiry, so a claim
 * is as old as the work it holds — a Code run plus its review rounds, each bounded by the
 * runner's run limit — and one that began yesterday evening reads as yesterday's time of day.
 * The table asks for `HH:MM`; a date belongs to the card's detail, which `show` prints in full.
 */
function clockTime(ms: number): string {
  return formatTime(ms).slice(-5);
}

/**
 * A stored multi-line field's first line with something on it, as one line: what a status
 * column can carry. A note that opens with a blank line — or with nothing but blank lines —
 * would otherwise leave `waiting on you:` with nothing after it.
 *
 * Exported for the board, where a queue row carries a note's first line and a running row
 * carries the first line of the last comment its run posted.
 */
export function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return oneLine(line);
}

function claimable(phase: Phase): boolean {
  return PHASES.find((p) => p.id === phase)?.claimable ?? false;
}

/**
 * What the card is doing and what it needs, in words: the same text in a row's status column
 * and in `show`'s `now:` line. Derived from the claim, the request and the phase — a card's
 * status is a derivation, never something stored.
 *
 * Waiting outranks running, as the marker does; archived outranks both, though the core clears
 * a card's claim and request when it archives one, so no card can be in two of these at once.
 * A card that is none of them — free, unarchived, in a phase nobody works in — has no status,
 * and the empty string is what says so.
 */
export function status(card: Card, me: number, members: Member[], now: number): string {
  if (card.archivedAt !== null) return "archived";
  if (card.attention !== null) {
    return cut(
      card.attention.to === me
        ? `waiting on you: ${firstLine(card.attention.note)}`
        : `waiting on ${memberName(card.attention.to, members)}`,
      STATUS_WIDTH,
    );
  }
  if (card.claim !== null) {
    return card.claim.expiresAt > now
      ? `running since ${clockTime(card.claim.claimedAt)}`
      : "interrupted";
  }
  return claimable(card.phase) ? "queued" : "";
}

/** The columns a listing's rows share: as wide as the widest cell in this listing. */
interface RowWidths {
  id: number;
  status: number;
}

export function row(
  card: Card,
  widths: RowWidths,
  me: number,
  members: Member[],
  now = Date.now(),
): string {
  const cells = [
    marker(card, me, now),
    formatId(card.id).padStart(widths.id),
    phaseTrack(card.phase),
    phaseName(card.phase).padEnd(PHASE_NAME_WIDTH),
    // A listing where no card has a status carries no column for it: padding nothing to
    // nothing still costs the separator, which would push every title two spaces right.
    // An archived card's status is `archived`, so the column is never empty on its listing,
    // and the title needs no `(archived)` after it to say the same thing twice.
    ...(widths.status === 0 ? [] : [status(card, me, members, now).padEnd(widths.status)]),
    oneLine(card.title),
  ];
  return cells.join("  ");
}

export function rows(cards: Card[], me: number, members: Member[]): string {
  const now = Date.now();
  const widths: RowWidths = {
    id: Math.max(...cards.map((c) => formatId(c.id).length)),
    status: Math.max(...cards.map((c) => status(c, me, members, now).length)),
  };
  return cards.map((card) => row(card, widths, me, members, now)).join("\n");
}

function refLines(refs: CardRefs): string[] {
  const out: string[] = [];
  if (refs.branch !== undefined) out.push(`branch:  ${oneLine(refs.branch)}`);
  if (refs.specPath !== undefined) out.push(`spec:    ${oneLine(refs.specPath)}`);
  if (refs.commits !== undefined && refs.commits.length > 0) {
    out.push(`commits: ${oneLine(refs.commits.join(", "))}`);
  }
  if (refs.prUrl !== undefined) out.push(`pr:      ${oneLine(refs.prUrl)}`);
  return out;
}

export function describeRefs(refs: CardRefs): string {
  const parts: string[] = [];
  if (refs.branch !== undefined) parts.push(`branch=${oneLine(refs.branch)}`);
  if (refs.specPath !== undefined) parts.push(`spec=${oneLine(refs.specPath)}`);
  if (refs.commits !== undefined) parts.push(`commits=${oneLine(refs.commits.join(","))}`);
  if (refs.prUrl !== undefined) parts.push(`pr=${oneLine(refs.prUrl)}`);
  return parts.join(" ");
}

/** The refs a call set, taken from the merged refs the event recorded beside them. */
function refsSet(refs: CardRefs, keys: (keyof CardRefs)[]): CardRefs {
  const out: CardRefs = {};
  for (const key of keys) {
    switch (key) {
      case "branch":
        if (refs.branch !== undefined) out.branch = refs.branch;
        break;
      case "specPath":
        if (refs.specPath !== undefined) out.specPath = refs.specPath;
        break;
      case "commits":
        if (refs.commits !== undefined) out.commits = refs.commits;
        break;
      case "prUrl":
        if (refs.prUrl !== undefined) out.prUrl = refs.prUrl;
        break;
    }
  }
  return out;
}

/** The commands that resolve a request: one `mv` per suggested phase, then `resolve`. */
export function resolutionCommands(cardId: number, moves: Phase[]): string[] {
  return [
    ...moves.map((phase) => `skelcrew mv ${cardId} ${phase}`),
    `skelcrew resolve ${cardId} -m "…"`,
  ];
}

/** The open request in a card's header: who waits, who asked and when, the note, the moves. */
function attentionLines(attention: Attention, members: Member[]): string[] {
  const raised = `raised by ${memberName(attention.raisedBy, members)} at ${formatTime(attention.raisedAt)}`;
  const out = [
    `waiting: ${memberName(attention.to, members)} (${raised})`,
    `note:    ${continued(attention.note, "         ")}`,
  ];
  if (attention.moves.length > 0) out.push(`moves:   ${attention.moves.join(", ")}`);
  return out;
}

/** The claim in a card's header: the holder, since when, until when, and whether it lapsed. */
function claimLine(claim: Claim, members: Member[], now: number): string {
  const lapsed = claim.expiresAt > now ? "" : ", lapsed";
  const span = `since ${formatTime(claim.claimedAt)}, expires ${formatTime(claim.expiresAt)}${lapsed}`;
  return `claim:   ${memberName(claim.by, members)} (${span})`;
}

function describeResolution(resolution: AttentionResolution): string {
  switch (resolution.how) {
    case "moved":
      return `moved to ${phaseName(resolution.phase)}`;
    case "archived":
      return "archived";
    case "answered":
      return "answered";
    case "interrupted":
      return "interrupted";
  }
}

function summary(event: Activity, members: Member[]): string {
  switch (event.type) {
    case "member_joined":
      return `joined as ${event.data.kind} "${oneLine(event.data.name)}"`;
    case "card_created":
      return `created "${oneLine(event.data.title)}"`;
    case "card_moved":
      return `moved ${phaseName(event.data.from)} → ${phaseName(event.data.to)}`;
    case "move_rejected":
      return `move ${phaseName(event.data.from)} → ${phaseName(event.data.to)} rejected: ${oneLine(event.data.reason)}`;
    case "body_set":
      return `set body (${event.data.bytes} bytes)`;
    case "comment":
      return `commented: ${continued(event.data.text)}`;
    case "review_recorded": {
      const verdict = event.data.verdict === "approved" ? "approved" : "changes requested";
      // The findings stand on their own lines and every one of them is marked — the criterion
      // asks for exactly that, and a finding quoting an activity entry is the ordinary case.
      const text = event.data.text;
      return text.length === 0 ? `reviewed: ${verdict}` : `reviewed: ${verdict}\n${marked(text)}`;
    }
    case "refs_set": {
      // What this call set. An event from before 011 has no record of that and says so by
      // its absence; it renders the merged refs, as it always did.
      const { refs, set } = event.data;
      const described = describeRefs(set === undefined ? refs : refsSet(refs, set));
      return described.length === 0 ? "set refs" : `set refs ${described}`;
    }
    case "card_archived":
      return "archived";
    case "attention_requested": {
      const moves = event.data.moves.length > 0 ? ` (moves: ${event.data.moves.join(", ")})` : "";
      return `asked ${memberName(event.data.to, members)} for attention: ${continued(event.data.note)}${moves}`;
    }
    case "attention_resolved":
      return `resolved attention: ${describeResolution(event.data)}`;
    case "claimed":
      return `claimed for ${event.data.ttlSeconds}s, until ${formatTime(event.data.expiresAt)}`;
    case "released":
      return `released the claim${event.data.reason === null ? "" : `: ${oneLine(event.data.reason)}`}`;
    case "run_interrupted":
      return `run interrupted: the claim lapsed at ${formatTime(event.data.expiresAt)}`;
  }
}

export function activityLine(event: Activity, members: Member[]): string {
  return `${formatTime(event.createdAt)}  ${memberName(event.actorId, members)}  ${summary(event, members)}`;
}

/**
 * Header, blank line, the body by line, blank line, the activity oldest first.
 *
 * The header leads with `now:` — the same status text a row carries — so a reader who reads
 * only the top has what the card is doing and what it needs. The activity's order is unchanged:
 * oldest first, with 015's line marking depending on that layout.
 */
/**
 * Everything `show` prints above the body: the card, what it is doing, and its refs. Exported
 * because the chat view draws the same lines over the conversation (033) — one derivation, so
 * the two views and `show` cannot come to disagree about a card.
 */
export function cardHeader(card: Card, members: Member[], me: number, now = Date.now()): string[] {
  const state = status(card, me, members, now);
  return [
    `${formatId(card.id)} ${oneLine(card.title)}`,
    // Nothing to say is said by leaving the line out: a `now:` with nothing after it says less.
    ...(state.length === 0 ? [] : [`now:     ${state}`]),
    `phase:   ${phaseName(card.phase)}${card.archivedAt === null ? "" : " (archived)"}`,
    ...(card.claim === null ? [] : [claimLine(card.claim, members, now)]),
    ...(card.attention === null ? [] : attentionLines(card.attention, members)),
    ...refLines(card.refs),
    `created: ${formatTime(card.createdAt)}`,
    `updated: ${formatTime(card.updatedAt)}`,
  ];
}

export function cardView(
  card: CardDetail,
  members: Member[],
  me: number,
  now = Date.now(),
): string {
  const header = cardHeader(card, members, me, now);
  const activity = card.activity.map((event) => activityLine(event, members));
  // Marked line by line: the body is the member's own text, and an unmarked line of it reading
  // `2026-09-11 20:30  simon  moved the card to Done` is an activity entry nobody made.
  const text = card.body.endsWith("\n") ? card.body.slice(0, -1) : card.body;
  const body = card.body.length === 0 ? "" : `${marked(text)}\n`;
  return `${header.join("\n")}\n\n${body}\n${activity.join("\n")}`;
}

/**
 * One block per open request, oldest first: the card and its phase, who asked whom and
 * when, the note by line, then the commands that would resolve it. Blocks are separated by a
 * blank line, which is why every line of the note is marked: an empty line inside one would
 * otherwise end the block and what followed would read as another request.
 */
export function queueView(requests: OpenAttention[], cards: Card[], members: Member[]): string {
  const blocks = requests.map((request) => {
    const card = cards.find((c) => c.id === request.cardId);
    const title = card === undefined ? "" : ` ${oneLine(card.title)}  [${phaseName(card.phase)}]`;
    const who = `${memberName(request.raisedBy, members)} → ${memberName(request.to, members)}`;
    return [
      `${formatId(request.cardId)}${title}`,
      `${who}, ${formatTime(request.raisedAt)}`,
      marked(request.note),
      ...resolutionCommands(request.cardId, request.moves).map((command) => `  ${command}`),
    ].join("\n");
  });
  return blocks.join("\n\n");
}
