import type { OpenAttention } from "@skelcrew/shared";
import { queueView } from "../render";
import { type Command, flag, noExtraPositionals } from "./command";

/** The home view: what is waiting on the invoking member, oldest first. `--all`: on anyone. */
export const queue: Command<{ all: boolean }, OpenAttention[]> = {
  usage: "queue [--all]",
  options: { all: { type: "boolean" } },

  parse(args) {
    noExtraPositionals(args, 0);
    return { all: flag(args, "all") };
  },

  async run(ctx, input) {
    const me = ctx.client.member;
    const requests = await ctx.client.call("listAttention", input.all ? {} : { to: me.id });
    if (requests.length === 0) {
      return {
        result: requests,
        render: () => (input.all ? "nothing is waiting on anyone" : "nothing is waiting on you"),
      };
    }
    const cards = await ctx.client.call("listCards", {});
    const members = await ctx.client.call("listMembers", {});
    return { result: requests, render: () => queueView(requests, cards, members) };
  },
};
