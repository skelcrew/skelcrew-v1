import type { Activity, ReviewVerdict } from "@skelcrew/shared";
import { activityLine } from "../render";
import { type Command, noExtraPositionals, parseId, UsageError } from "./command";

type Input = { id: number; verdict: ReviewVerdict; text?: string };

/**
 * The verdict as a member types it. `changes-requested` is hyphenated on the command line and
 * stored with an underscore, which is how the event spells it.
 */
const VERDICTS: Record<string, ReviewVerdict> = {
  approved: "approved",
  "changes-requested": "changes_requested",
};

/**
 * Records a verdict on the card. A member primitive like `comment`: the reviewer a run spawns
 * calls it, and so can the owner from the terminal — it is a record either way, and moves
 * nothing. Findings are required with `changes-requested`, and refused here before anything
 * connects, because a verdict nobody can act on is not one.
 */
export const review: Command<Input, Activity> = {
  usage: "review <id> <verdict> [<text>]",
  options: {},

  parse(args) {
    noExtraPositionals(args, 3);
    const id = parseId(args.positionals[0]);
    const word = args.positionals[1];
    if (word === undefined) throw new UsageError("missing <verdict>");
    const verdict = VERDICTS[word.toLowerCase()];
    if (verdict === undefined) {
      const words = Object.keys(VERDICTS).join(", ");
      throw new UsageError(`unknown verdict "${word}"; expected one of ${words}`);
    }
    const text = args.positionals[2];
    if (verdict === "changes_requested" && (text === undefined || text.trim().length === 0)) {
      throw new UsageError("changes-requested needs its findings as <text>");
    }
    return text === undefined ? { id, verdict } : { id, verdict, text };
  },

  async run(ctx, input) {
    const event = await ctx.client.call("reviewCard", input);
    return { result: event, render: () => activityLine(event, [ctx.client.member]) };
  },
};
