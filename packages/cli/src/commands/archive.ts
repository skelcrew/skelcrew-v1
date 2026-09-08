import type { Card } from "@skelcrew/shared";
import { formatId } from "../render";
import { type Command, noExtraPositionals, parseId } from "./command";

export const archive: Command<{ id: number }, Card> = {
  usage: "archive <id>",
  options: {},

  parse(args) {
    noExtraPositionals(args, 1);
    return { id: parseId(args.positionals[0]) };
  },

  async run(ctx, input) {
    const card = await ctx.client.call("archiveCard", input);
    return { result: card, render: () => `${formatId(card.id)} archived` };
  },
};
