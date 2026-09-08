import { type Card, PHASES, type Phase } from "@skelcrew/shared";
import { formatId, phaseName } from "../render";
import { type Command, noExtraPositionals, parseId, string, UsageError } from "./command";

type Input = { id: number; phase: Phase; message?: string };

function parsePhase(raw: string | undefined): Phase {
  if (raw === undefined) throw new UsageError("missing <phase>");
  const phase = PHASES.find((p) => p.id === raw.toLowerCase());
  if (!phase) {
    const ids = PHASES.map((p) => p.id).join(", ");
    throw new UsageError(`unknown phase "${raw}"; expected one of ${ids}`);
  }
  return phase.id;
}

/** Moves first, then comments: a rejected move posts nothing. */
export const mv: Command<Input, Card> = {
  usage: "mv <id> <phase> [-m <text>]",
  options: { message: { type: "string", short: "m" } },

  parse(args) {
    noExtraPositionals(args, 2);
    const id = parseId(args.positionals[0]);
    const phase = parsePhase(args.positionals[1]);
    const message = string(args, "message");
    return message === undefined ? { id, phase } : { id, phase, message };
  },

  async run(ctx, input) {
    const card = await ctx.client.call("moveCard", { id: input.id, phase: input.phase });
    if (input.message !== undefined) {
      try {
        await ctx.client.call("comment", { id: input.id, text: input.message });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const moved = `${formatId(card.id)} moved to ${phaseName(card.phase)}`;
        throw new Error(`${moved}, but the comment was not posted: ${reason}`);
      }
    }
    return {
      result: card,
      render: () => `${formatId(card.id)} moved to ${phaseName(card.phase)}`,
    };
  },
};
