/**
 * Plain text for a terminal: the row, the phase track, the card view, the activity line.
 * Nothing here talks to the daemon; every function takes what a command already fetched.
 */
import {
  type Activity,
  type Card,
  type CardDetail,
  type CardRefs,
  type Member,
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

const PHASE_NAME_WIDTH = Math.max(...PHASES.map((p) => p.name.length));

export function row(card: Card, idWidth: number): string {
  const cells = [
    formatId(card.id).padStart(idWidth),
    phaseTrack(card.phase),
    phaseName(card.phase).padEnd(PHASE_NAME_WIDTH),
    card.title,
  ];
  if (card.archivedAt !== null) cells.push("(archived)");
  return cells.join("  ");
}

export function rows(cards: Card[]): string {
  const idWidth = Math.max(...cards.map((c) => formatId(c.id).length));
  return cards.map((card) => row(card, idWidth)).join("\n");
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

function summary(event: Activity): string {
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
  }
}

export function activityLine(event: Activity, members: Member[]): string {
  const actor = members.find((m) => m.id === event.actorId)?.name ?? `member ${event.actorId}`;
  return `${formatTime(event.createdAt)}  ${actor}  ${summary(event)}`;
}

/** Header, blank line, the body verbatim, blank line, the activity oldest first. */
export function cardView(card: CardDetail, members: Member[]): string {
  const header = [
    `${formatId(card.id)} ${card.title}`,
    `phase:   ${phaseName(card.phase)}${card.archivedAt === null ? "" : " (archived)"}`,
    ...refLines(card.refs),
    `created: ${formatTime(card.createdAt)}`,
    `updated: ${formatTime(card.updatedAt)}`,
  ];
  const activity = card.activity.map((event) => activityLine(event, members));
  const body = card.body.endsWith("\n") || card.body.length === 0 ? card.body : `${card.body}\n`;
  return `${header.join("\n")}\n\n${body}\n${activity.join("\n")}`;
}
