import type { Card, Claim } from "@skelcrew/shared";
import { formatId, formatTime } from "../render";
import { type Command, noExtraPositionals, parseId } from "./command";

/** Renews the invoking member's claim by its TTL and prints the new expiry. */
export const heartbeat: Command<{ id: number }, Card> = {
  usage: "heartbeat <id>",
  options: {},

  parse(args) {
    noExtraPositionals(args, 1);
    return { id: parseId(args.positionals[0]) };
  },

  async run(ctx, input) {
    const card = await ctx.client.call("heartbeat", input);
    const held = card.claim as Claim;
    return {
      result: card,
      render: () => `${formatId(card.id)} claim renewed until ${formatTime(held.expiresAt)}`,
    };
  },
};
