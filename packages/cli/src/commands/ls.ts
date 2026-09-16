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
    if (cards.length === 0) {
      return { result: cards, render: () => 'no cards yet; file one with: skelcrew add "<title>"' };
    }
    // For `waiting on <name>`: the status column names who a card waits on, as `queue` does.
    const members = await ctx.client.call("listMembers", {});
    return { result: cards, render: () => rows(cards, ctx.client.member.id, members) };
  },
};
