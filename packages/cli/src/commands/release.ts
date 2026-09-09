import type { Card } from "@skelcrew/shared";
import { formatId } from "../render";
import { type Command, noExtraPositionals, parseId, string } from "./command";

type Input = { id: number; reason?: string };

/** Clears the claim: the holder's own, or any claim when invoked as the owner. */
export const release: Command<Input, Card> = {
  usage: "release <id> [-m <reason>]",
  options: { message: { type: "string", short: "m" } },

  parse(args) {
    noExtraPositionals(args, 1);
    const id = parseId(args.positionals[0]);
    const reason = string(args, "message");
    return reason === undefined ? { id } : { id, reason };
  },

  async run(ctx, input) {
    const card = await ctx.client.call("releaseCard", input);
    return { result: card, render: () => `${formatId(card.id)} released` };
  },
};
