import type { Card } from "@skelcrew/shared";
import { formatId } from "../render";
import { type Command, noExtraPositionals, parseId, string } from "./command";

type Input = { id: number; text?: string };

/** Answers the open request on the card. `-m` is posted as a comment first. */
export const resolve: Command<Input, Card> = {
  usage: "resolve <id> [-m <text>]",
  options: { message: { type: "string", short: "m" } },

  parse(args) {
    noExtraPositionals(args, 1);
    const id = parseId(args.positionals[0]);
    const text = string(args, "message");
    return text === undefined ? { id } : { id, text };
  },

  async run(ctx, input) {
    const card = await ctx.client.call("resolveAttention", input);
    return { result: card, render: () => `${formatId(card.id)} resolved` };
  },
};
