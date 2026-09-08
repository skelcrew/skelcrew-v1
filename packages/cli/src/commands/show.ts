import type { CardDetail } from "@skelcrew/shared";
import { cardView } from "../render";
import { type Command, noExtraPositionals, parseId } from "./command";

export const show: Command<{ id: number }, CardDetail> = {
  usage: "show <id>",
  options: {},

  parse(args) {
    noExtraPositionals(args, 1);
    return { id: parseId(args.positionals[0]) };
  },

  async run(ctx, input) {
    const detail = await ctx.client.call("getCard", input);
    const members = await ctx.client.call("listMembers", {});
    return { result: detail, render: () => cardView(detail, members) };
  },
};
