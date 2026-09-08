import type { Activity } from "@skelcrew/shared";
import { activityLine } from "../render";
import { type Command, noExtraPositionals, parseId, UsageError } from "./command";

type Input = { id: number; text?: string };

/** Text from the argument, or stdin without its final newline. */
export const comment: Command<Input, Activity> = {
  usage: "comment <id> [<text>]",
  options: {},

  parse(args) {
    noExtraPositionals(args, 2);
    const id = parseId(args.positionals[0]);
    const text = args.positionals[1];
    if (text === undefined && args.stdinIsTerminal) throw new UsageError("missing <text>");
    return text === undefined ? { id } : { id, text };
  },

  async run(ctx, input) {
    const text = input.text ?? (await ctx.stdin()).replace(/\r?\n$/, "");
    const event = await ctx.client.call("comment", { id: input.id, text });
    return { result: event, render: () => activityLine(event, [ctx.client.member]) };
  },
};
