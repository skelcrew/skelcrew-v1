import type { Card } from "@skelcrew/shared";
import { rows } from "../render";
import { type Command, flag, noExtraPositionals } from "./command";

export const ls: Command<{ includeArchived: boolean; json: boolean }, Card[]> = {
  usage: "ls [--all]",
  options: { all: { type: "boolean" } },

  parse(args) {
    noExtraPositionals(args, 0);
    return { includeArchived: flag(args, "all"), json: flag(args, "json") };
  },

  async run(ctx, input) {
    const cards = await ctx.client.call(
      "listCards",
      input.includeArchived ? { includeArchived: true } : {},
    );
    if (cards.length === 0) {
      return { result: cards, render: () => 'no cards yet; file one with: skelcrew add "<title>"' };
    }
    // `--json` prints the daemon's result and never calls the renderer, so the board's text is
    // all that needs the names: the status column's `waiting on <name>`, as `queue` does.
    if (input.json) return { result: cards, render: () => "" };
    const members = await ctx.client.call("listMembers", {});
    return { result: cards, render: () => rows(cards, ctx.client.member.id, members) };
  },
};
