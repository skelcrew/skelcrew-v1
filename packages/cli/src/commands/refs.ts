import type { Card, CardRefs } from "@skelcrew/shared";
import { describeRefs, formatId } from "../render";
import { type Command, noExtraPositionals, parseId, string, strings, UsageError } from "./command";

type Input = { id: number; refs: CardRefs };

export const refs: Command<Input, Card> = {
  usage: "refs <id> [--branch <name>] [--pr <url>] [--commit <sha>]...",
  options: {
    branch: { type: "string" },
    pr: { type: "string" },
    commit: { type: "string", multiple: true },
  },

  parse(args) {
    noExtraPositionals(args, 1);
    const id = parseId(args.positionals[0]);
    const patch: CardRefs = {};
    const branch = string(args, "branch");
    const pr = string(args, "pr");
    const commits = strings(args, "commit");
    if (branch !== undefined) patch.branch = branch;
    if (pr !== undefined) patch.prUrl = pr;
    if (commits.length > 0) patch.commits = commits;
    if (Object.keys(patch).length === 0) {
      throw new UsageError("at least one of --branch, --pr, --commit is required");
    }
    return { id, refs: patch };
  },

  async run(ctx, input) {
    const card = await ctx.client.call("setRefs", input);
    return { result: card, render: () => `${formatId(card.id)} ${describeRefs(card.refs)}` };
  },
};
