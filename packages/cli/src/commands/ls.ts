import type { Card } from "@skelcrew/shared";
import { rows } from "../render";
import { type Command, flag, noExtraPositionals } from "./command";

export const ls: Command<{ includeArchived: boolean }, Card[]> = {
  usage: "ls [--all]",
  options: { all: { type: "boolean" } },

  parse(args) {
    noExtraPositionals(args, 0);
    return { includeArchived: flag(args, "all") };
  },

  async run(ctx, input) {
    const cards = await ctx.client.call("listCards", input.includeArchived ? input : {});
    return {
      result: cards,
      render: () =>
        cards.length === 0 ? 'no cards yet; file one with: skelcrew add "<title>"' : rows(cards),
    };
  },
};
