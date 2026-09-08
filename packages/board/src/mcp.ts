/**
 * The MCP surface. Agents are members, not plugins: every tool here delegates to the
 * same core module a human's HTTP request goes through — no agent-only side channels.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as core from "./core.js";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

/** Lane ids are opaque; accept a lane name too so agents can act on what they read. */
function resolveLane(idOrName: string): string {
  try {
    return core.getLane(idOrName).id;
  } catch {
    return core.getLaneByName(idOrName).id;
  }
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "kanbot", version: "0.0.1" },
    {
      instructions:
        "Kanbot is a kanban board shared by a human owner and agent members. " +
        "Call join_board once to get your memberId, then pass it to every other tool. " +
        "Read the board with get_board, claim a card before working on it, and post what " +
        "you do as comments — anything you do to the board must be visible on the board. " +
        "Lanes marked humanOnlyEntry are approval gates: only the human owner may move " +
        "cards into them.",
    },
  );

  server.registerTool(
    "join_board",
    {
      title: "Join the board",
      description:
        "Register (idempotently) as an agent member of the board and get your memberId. Call this first.",
      inputSchema: { name: z.string().describe("The name to appear under on the board") },
    },
    async ({ name }) => {
      const member = core.upsertMember(name, "agent");
      return json({ memberId: member.id, name: member.name, kind: member.kind });
    },
  );

  server.registerTool(
    "get_board",
    {
      title: "Get the board",
      description:
        "The whole board: lanes (in order, with stage and humanOnlyEntry), cards, and members.",
      inputSchema: {},
    },
    async () => json(core.getBoard()),
  );

  server.registerTool(
    "get_card",
    {
      title: "Get a card",
      description: "One card with its full activity feed (the card's run record).",
      inputSchema: { cardId: z.string() },
    },
    async ({ cardId }) => json(core.getCardDetail(cardId)),
  );

  server.registerTool(
    "create_card",
    {
      title: "Create a card",
      description: "Create a card in the Ideas lane.",
      inputSchema: {
        title: z.string(),
        body: z.string().default("").describe("Context for the card; may be empty"),
        memberId: z.string(),
      },
    },
    async ({ title, body, memberId }) => json(core.createCard(title, body ?? "", memberId)),
  );

  server.registerTool(
    "move_card",
    {
      title: "Move a card",
      description:
        "Move a card to another lane. Lanes with humanOnlyEntry reject agent moves — that is an approval gate, not a bug.",
      inputSchema: {
        cardId: z.string(),
        laneId: z.string().describe("A lane id from get_board (a lane name also works)"),
        memberId: z.string(),
      },
    },
    async ({ cardId, laneId, memberId }) =>
      json(core.moveCard(cardId, resolveLane(laneId), memberId)),
  );

  server.registerTool(
    "comment",
    {
      title: "Comment on a card",
      description: "Post a comment to the card's activity feed. This is how you report progress.",
      inputSchema: { cardId: z.string(), text: z.string(), memberId: z.string() },
    },
    async ({ cardId, text: body, memberId }) => {
      const activity = core.comment(cardId, body, memberId);
      return json({ seq: activity.seq });
    },
  );

  server.registerTool(
    "claim_card",
    {
      title: "Claim a card",
      description:
        "Take a lease on a card (120s, renewed by working on it). Fails if someone else holds an active claim.",
      inputSchema: {
        cardId: z.string(),
        memberId: z.string(),
        ttlSec: z.number().int().min(10).max(3600).default(120).optional(),
      },
    },
    async ({ cardId, memberId, ttlSec }) => {
      const res = core.claimCard(cardId, memberId, ttlSec ?? 120);
      return json({ card: res.card, expiresAt: res.expiresAt });
    },
  );

  server.registerTool(
    "release_card",
    {
      title: "Release a card",
      description: "Give up your claim on a card, optionally saying why.",
      inputSchema: { cardId: z.string(), memberId: z.string(), reason: z.string().optional() },
    },
    async ({ cardId, memberId, reason }) => json(core.releaseCard(cardId, memberId, reason)),
  );

  server.registerTool(
    "post_spec",
    {
      title: "Post a spec to a card",
      description:
        "Write the card's spec (markdown). The card is the spec while it is drafted; the owner reviews it on the board.",
      inputSchema: { cardId: z.string(), markdown: z.string(), memberId: z.string() },
    },
    async ({ cardId, markdown, memberId }) => json(core.setSpec(cardId, markdown, memberId)),
  );

  server.registerTool(
    "request_attention",
    {
      title: "Hand the card to the owner",
      description:
        "Put the card in the owner's attention queue with a note saying what is needed. Do this when you finish a stage.",
      inputSchema: { cardId: z.string(), note: z.string(), memberId: z.string() },
    },
    async ({ cardId, note, memberId }) => {
      const owner = core.getOwner();
      const card = core.requestAttention(cardId, owner.id, note, memberId);
      return json({ card, waitingOn: owner.name });
    },
  );

  server.registerTool(
    "set_refs",
    {
      title: "Attach references to a card",
      description:
        "Record a branch name and/or PR URL on the card. References only — never repository contents.",
      inputSchema: {
        cardId: z.string(),
        branch: z.string().optional(),
        prUrl: z.string().optional(),
        memberId: z.string(),
      },
    },
    async ({ cardId, branch, prUrl, memberId }) =>
      json(core.setRefs(cardId, { branch, prUrl }, memberId)),
  );

  server.registerTool(
    "heartbeat",
    {
      title: "Renew your claim",
      description: "Extend the lease on a card you hold. A lapsed lease returns the card to its lane.",
      inputSchema: { cardId: z.string(), memberId: z.string() },
    },
    async ({ cardId, memberId }) => {
      const res = core.heartbeat(cardId, memberId);
      return text(`claim extended until ${new Date(res.expiresAt).toISOString()}`);
    },
  );

  return server;
}
