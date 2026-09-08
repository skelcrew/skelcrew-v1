import { type Card, RpcError } from "@skelcrew/shared";
import { formatId } from "../render";
import { type Command, noExtraPositionals, readFile, string, UsageError } from "./command";

type Input = { title: string; body?: string } | { bulk: true };

function line(card: Card): string {
  return `${formatId(card.id)} ${card.title}`;
}

/** One card from the arguments, or one per non-empty stdin line when no title is given. */
export const add: Command<Input, Card | Card[]> = {
  usage: "add <title> [--body <text> | --body-file <path>]",
  options: { body: { type: "string" }, "body-file": { type: "string" } },

  parse(args) {
    noExtraPositionals(args, 1);
    const title = args.positionals[0];
    const body = string(args, "body");
    const bodyFile = string(args, "body-file");
    if (body !== undefined && bodyFile !== undefined) {
      throw new UsageError("--body and --body-file cannot both be given");
    }
    if (title === undefined) {
      if (args.stdinIsTerminal) throw new UsageError("missing <title>");
      if (body !== undefined || bodyFile !== undefined) {
        throw new UsageError("--body and --body-file only apply to a single <title>");
      }
      return { bulk: true };
    }
    if (bodyFile !== undefined) return { title, body: readFile(bodyFile) };
    return body === undefined ? { title } : { title, body };
  },

  async run(ctx, input) {
    if (!("bulk" in input)) {
      const card = await ctx.client.call("createCard", input);
      return { result: card, render: () => line(card) };
    }
    const lines = (await ctx.stdin()).split("\n");
    const cards: Card[] = [];
    let failed = false;
    for (let i = 0; i < lines.length; i += 1) {
      const title = (lines[i] as string).replace(/\r$/, "");
      if (title.trim().length === 0) continue;
      try {
        cards.push(await ctx.client.call("createCard", { title }));
      } catch (error) {
        if (!(error instanceof RpcError)) throw error;
        failed = true;
        ctx.warn(`error: line ${i + 1}: ${error.message}`);
      }
    }
    if (cards.length === 0 && !failed) throw new UsageError("missing <title>: stdin was empty");
    return { result: cards, render: () => cards.map(line).join("\n"), failed };
  },
};
