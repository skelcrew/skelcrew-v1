#!/usr/bin/env node
/**
 * kanbot CLI — the owner's terminal hands. Unlike MCP members (agents), this acts as the
 * board's human owner, so it can move cards through the approval gates (Ready, Done).
 */
import type { Activity, BoardSnapshot, Card, CardDetail, Lane, Member } from "@kanbot/shared";

const BOARD = process.env.KANBOT_BOARD ?? "http://localhost:4777";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BOARD}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* keep status */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

const board = (): Promise<BoardSnapshot> => api("/api/board");

function owner(b: BoardSnapshot): Member {
  const human = b.members.find((m) => m.kind === "human");
  if (!human) throw new Error("no human member on the board");
  return human;
}

/** Match a card by id prefix or case-insensitive title substring; must be unambiguous. */
function findCard(b: BoardSnapshot, query: string): Card {
  const q = query.toLowerCase();
  const hits = b.cards.filter((c) => c.id.startsWith(query) || c.title.toLowerCase().includes(q));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) throw new Error(`no card matches "${query}"`);
  throw new Error(
    `"${query}" is ambiguous:\n${hits.map((c) => `  ${c.id.slice(0, 8)}  ${c.title}`).join("\n")}`,
  );
}

function findLane(b: BoardSnapshot, query: string): Lane {
  const q = query.toLowerCase();
  const hits = b.lanes.filter((l) => l.name.toLowerCase().startsWith(q));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) throw new Error(`no lane matches "${query}"`);
  throw new Error(`"${query}" is ambiguous: ${hits.map((l) => l.name).join(", ")}`);
}

function laneOf(b: BoardSnapshot, card: Card): string {
  return b.lanes.find((l) => l.id === card.laneId)?.name ?? "?";
}

function memberName(b: BoardSnapshot, id: string | null): string {
  if (!id) return "";
  return b.members.find((m) => m.id === id)?.name ?? id.slice(0, 8);
}

function cardLine(b: BoardSnapshot, c: Card): string {
  const bits = [`${c.id.slice(0, 8)}  ${c.title}`];
  if (c.claimedBy) bits.push(`[${memberName(b, c.claimedBy)}]`);
  if (c.waitingOn) bits.push(`⏳ ${memberName(b, c.waitingOn)}`);
  if (c.refs.prUrl) bits.push(c.refs.prUrl);
  else if (c.refs.branch) bits.push(`(${c.refs.branch})`);
  return bits.join("  ");
}

/* ---------------------------------------------------------------- commands */

async function ls(): Promise<void> {
  const b = await board();
  for (const lane of [...b.lanes].sort((x, y) => x.pos - y.pos)) {
    const cards = b.cards.filter((c) => c.laneId === lane.id).sort((x, y) => x.pos - y.pos);
    const tag = lane.stage ? ` [${lane.stage}]` : lane.humanOnlyEntry ? " [gate]" : "";
    console.log(`${lane.name}${tag} (${cards.length})`);
    for (const c of cards) console.log(`  ${cardLine(b, c)}`);
  }
}

async function queue(): Promise<void> {
  const b = await board();
  const meId = owner(b).id;
  const waiting = b.cards.filter((c) => c.waitingOn === meId);
  if (!waiting.length) {
    console.log("nothing waiting on you");
    return;
  }
  for (const c of waiting) {
    console.log(`${laneOf(b, c)}: ${cardLine(b, c)}`);
    if (c.waitingNote) console.log(`  → ${c.waitingNote}`);
  }
}

async function add(title: string, body: string): Promise<void> {
  if (!title) throw new Error("usage: kanbot add <title> [body]");
  const b = await board();
  const card = await api<Card>("/api/cards", {
    method: "POST",
    body: JSON.stringify({ title, body, actorId: owner(b).id }),
  });
  console.log(`added ${card.id.slice(0, 8)} "${card.title}" to Ideas`);
}

async function mv(cardQuery: string, laneQuery: string): Promise<void> {
  if (!cardQuery || !laneQuery) throw new Error("usage: kanbot mv <card> <lane>");
  const b = await board();
  const card = findCard(b, cardQuery);
  const lane = findLane(b, laneQuery);
  await api(`/api/cards/${card.id}/move`, {
    method: "POST",
    body: JSON.stringify({ laneId: lane.id, actorId: owner(b).id }),
  });
  console.log(`moved "${card.title}" → ${lane.name}`);
}

async function show(cardQuery: string): Promise<void> {
  if (!cardQuery) throw new Error("usage: kanbot show <card>");
  const b = await board();
  const card = findCard(b, cardQuery);
  const detail = await api<CardDetail>(`/api/cards/${card.id}`);
  console.log(`${card.title}`);
  console.log(`lane: ${laneOf(b, card)}   id: ${card.id}`);
  if (card.refs.branch) console.log(`branch: ${card.refs.branch}`);
  if (card.refs.prUrl) console.log(`pr: ${card.refs.prUrl}`);
  if (card.waitingOn) console.log(`waiting on ${memberName(b, card.waitingOn)}: ${card.waitingNote ?? ""}`);
  if (card.body.trim()) console.log(`\n${card.body.trim()}`);
  if (card.spec) console.log(`\n--- spec ---\n${card.spec}`);
  console.log(`\n--- activity ---`);
  for (const a of detail.activity.slice(-15)) {
    const d = a.data as { text?: string; note?: string; from?: string; to?: string; reason?: string };
    const extra = d.text ?? d.note ?? (d.from ? `${d.from} → ${d.to}` : d.reason) ?? "";
    console.log(`${memberName(b, a.memberId)}  ${a.type}  ${String(extra).slice(0, 100)}`);
  }
}

async function comment(cardQuery: string, text: string): Promise<void> {
  if (!cardQuery || !text) throw new Error("usage: kanbot comment <card> <text>");
  const b = await board();
  const card = findCard(b, cardQuery);
  await api(`/api/cards/${card.id}/comment`, {
    method: "POST",
    body: JSON.stringify({ text, actorId: owner(b).id }),
  });
  console.log(`commented on "${card.title}"`);
}

const USAGE = `kanbot — the board from your terminal (acts as the board's owner)

  kanbot ls                     the whole board
  kanbot queue                  what's waiting on you
  kanbot add <title> [body]     new idea card
  kanbot mv <card> <lane>       move a card (card: title substring or id prefix)
  kanbot show <card>            card details, spec, and recent activity
  kanbot comment <card> <text>  comment on a card

  KANBOT_BOARD overrides the board URL (default http://localhost:4777)`;

const [, , cmd, ...rest] = process.argv;
const run = async (): Promise<void> => {
  switch (cmd) {
    case "ls":
      return ls();
    case "queue":
      return queue();
    case "add":
      return add(rest[0] ?? "", rest.slice(1).join(" "));
    case "mv":
      return mv(rest[0] ?? "", rest.slice(1).join(" "));
    case "show":
      return show(rest.join(" "));
    case "comment":
      return comment(rest[0] ?? "", rest.slice(1).join(" "));
    default:
      console.log(USAGE);
      process.exitCode = cmd ? 1 : 0;
  }
};

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
