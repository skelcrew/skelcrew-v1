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
  type Member,
  type OpenAttention,
  PHASES,
  type Phase,
} from "@skelcrew/shared";

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

function memberName(id: number, members: Member[]): string {
  return members.find((m) => m.id === id)?.name ?? `member ${id}`;
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

export function row(card: Card, idWidth: number, me: number, now = Date.now()): string {
  const cells = [
    marker(card, me, now),
    formatId(card.id).padStart(idWidth),
    phaseTrack(card.phase),
    phaseName(card.phase).padEnd(PHASE_NAME_WIDTH),
    card.title,
  ];
  if (card.archivedAt !== null) cells.push("(archived)");
  return cells.join("  ");
}

export function rows(cards: Card[], me: number): string {
  const idWidth = Math.max(...cards.map((c) => formatId(c.id).length));
  const now = Date.now();
  return cards.map((card) => row(card, idWidth, me, now)).join("\n");
}

function refLines(refs: CardRefs): string[] {
  const out: string[] = [];
  if (refs.branch !== undefined) out.push(`branch:  ${refs.branch}`);
  if (refs.commits !== undefined && refs.commits.length > 0) {
    out.push(`commits: ${refs.commits.join(", ")}`);
  }
  if (refs.prUrl !== undefined) out.push(`pr:      ${refs.prUrl}`);
  return out;
}

export function describeRefs(refs: CardRefs): string {
  const parts: string[] = [];
  if (refs.branch !== undefined) parts.push(`branch=${refs.branch}`);
  if (refs.commits !== undefined) parts.push(`commits=${refs.commits.join(",")}`);
  if (refs.prUrl !== undefined) parts.push(`pr=${refs.prUrl}`);
  return parts.join(" ");
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
    `note:    ${attention.note.split("\n").join("\n         ")}`,
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
  }
}

function summary(event: Activity, members: Member[]): string {
  switch (event.type) {
    case "member_joined":
      return `joined as ${event.data.kind} "${event.data.name}"`;
    case "card_created":
      return `created "${event.data.title}"`;
    case "card_moved":
      return `moved ${phaseName(event.data.from)} → ${phaseName(event.data.to)}`;
    case "move_rejected":
      return `move ${phaseName(event.data.from)} → ${phaseName(event.data.to)} rejected: ${event.data.reason}`;
    case "body_set":
      return `set body (${event.data.bytes} bytes)`;
    case "comment":
      return `commented: ${event.data.text}`;
    case "refs_set":
      return `set refs ${describeRefs(event.data.refs)}`;
    case "card_archived":
      return "archived";
    case "attention_requested": {
      const moves = event.data.moves.length > 0 ? ` (moves: ${event.data.moves.join(", ")})` : "";
      return `asked ${memberName(event.data.to, members)} for attention: ${event.data.note}${moves}`;
    }
    case "attention_resolved":
      return `resolved attention: ${describeResolution(event.data)}`;
    case "claimed":
      return `claimed for ${event.data.ttlSeconds}s, until ${formatTime(event.data.expiresAt)}`;
    case "released":
      return `released the claim${event.data.reason === null ? "" : `: ${event.data.reason}`}`;
    case "run_interrupted":
      return `run interrupted: the claim lapsed at ${formatTime(event.data.expiresAt)}`;
  }
}

export function activityLine(event: Activity, members: Member[]): string {
  return `${formatTime(event.createdAt)}  ${memberName(event.actorId, members)}  ${summary(event, members)}`;
}

/** Header, blank line, the body verbatim, blank line, the activity oldest first. */
export function cardView(card: CardDetail, members: Member[], now = Date.now()): string {
  const header = [
    `${formatId(card.id)} ${card.title}`,
    `phase:   ${phaseName(card.phase)}${card.archivedAt === null ? "" : " (archived)"}`,
    ...(card.claim === null ? [] : [claimLine(card.claim, members, now)]),
    ...(card.attention === null ? [] : attentionLines(card.attention, members)),
    ...refLines(card.refs),
    `created: ${formatTime(card.createdAt)}`,
    `updated: ${formatTime(card.updatedAt)}`,
  ];
  const activity = card.activity.map((event) => activityLine(event, members));
  const body = card.body.endsWith("\n") || card.body.length === 0 ? card.body : `${card.body}\n`;
  return `${header.join("\n")}\n\n${body}\n${activity.join("\n")}`;
}

/**
 * One block per open request, oldest first: the card and its phase, who asked whom and
 * when, the note verbatim, then the commands that would resolve it.
 */
export function queueView(requests: OpenAttention[], cards: Card[], members: Member[]): string {
  const blocks = requests.map((request) => {
    const card = cards.find((c) => c.id === request.cardId);
    const title = card === undefined ? "" : ` ${card.title}  [${phaseName(card.phase)}]`;
    const who = `${memberName(request.raisedBy, members)} → ${memberName(request.to, members)}`;
    return [
      `${formatId(request.cardId)}${title}`,
      `${who}, ${formatTime(request.raisedAt)}`,
      request.note,
      ...resolutionCommands(request.cardId, request.moves).map((command) => `  ${command}`),
    ].join("\n");
  });
  return blocks.join("\n\n");
}
