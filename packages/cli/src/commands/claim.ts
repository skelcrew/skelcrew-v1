import type { Card, Claim } from "@skelcrew/shared";
import { formatId, formatTime } from "../render";
import { type Command, noExtraPositionals, parseId, string, UsageError } from "./command";

type Input = { id: number; ttlSeconds?: number };

/** Takes the card as the invoking member, or renews their claim, and prints the expiry. */
export const claim: Command<Input, Card> = {
  usage: "claim <id> [--ttl <seconds>]",
  options: { ttl: { type: "string" } },

  parse(args) {
    noExtraPositionals(args, 1);
    const id = parseId(args.positionals[0]);
    const ttl = string(args, "ttl");
    if (ttl === undefined) return { id };
    if (!/^\d+$/.test(ttl)) throw new UsageError(`"${ttl}" is not a number of seconds`);
    return { id, ttlSeconds: Number(ttl) };
  },

  async run(ctx, input) {
    const card = await ctx.client.call("claimCard", input);
    const held = card.claim as Claim;
    return {
      result: card,
      render: () =>
        `${formatId(card.id)} claimed by ${ctx.client.member.name} until ${formatTime(held.expiresAt)} (${held.ttlSeconds}s)`,
    };
  },
};
