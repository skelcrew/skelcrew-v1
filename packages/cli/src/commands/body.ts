import type { Card } from "@skelcrew/shared";
import { formatId } from "../render";
import { type Command, noExtraPositionals, parseId, readFile, string, UsageError } from "./command";

type Input = { id: number; body?: string };

/** The body from the file, or stdin verbatim. */
export const body: Command<Input, Card> = {
  usage: "body <id> [--file <path>]",
  options: { file: { type: "string" } },

  parse(args) {
    noExtraPositionals(args, 1);
    const id = parseId(args.positionals[0]);
    const file = string(args, "file");
    if (file !== undefined) return { id, body: readFile(file) };
    if (args.stdinIsTerminal)
      throw new UsageError("missing --file <path>, and stdin is a terminal");
    return { id };
  },

  async run(ctx, input) {
    const text = input.body ?? (await ctx.stdin());
    const card = await ctx.client.call("setBody", { id: input.id, body: text });
    return {
      result: card,
      render: () => `${formatId(card.id)} body set (${Buffer.byteLength(card.body, "utf8")} bytes)`,
    };
  },
};
