import { type Card, ERROR_CODES, type Phase, RpcError } from "@skelcrew/shared";
import { formatId } from "../render";
import {
  type Command,
  noExtraPositionals,
  parseId,
  parsePhase,
  string,
  strings,
  UsageError,
} from "./command";

type Input = { id: number; note: string; to?: string; moves: Phase[] };

/** Hands the card to a member. `--to` is a name and defaults to the owner. */
export const attention: Command<Input, Card> = {
  usage: "attention <id> <note> [--to <member>] [--move <phase>]...",
  options: { to: { type: "string" }, move: { type: "string", multiple: true } },

  parse(args) {
    noExtraPositionals(args, 2);
    const id = parseId(args.positionals[0]);
    const note = args.positionals[1];
    if (note === undefined) throw new UsageError("missing <note>");
    const moves = strings(args, "move").map(parsePhase);
    const to = string(args, "to");
    if (to === "") throw new UsageError("--to needs a member name");
    return to === undefined ? { id, note, moves } : { id, note, moves, to };
  },

  async run(ctx, input) {
    // Names are what the CLI shows; the wire takes an id, so the name is looked up here.
    const members = await ctx.client.call("listMembers", {});
    const to =
      input.to === undefined
        ? members.find((m) => m.kind === "human")
        : members.find((m) => m.name === input.to);
    if (to === undefined) {
      throw new RpcError({
        code: ERROR_CODES.not_found,
        message:
          input.to === undefined ? "the daemon has no owner" : `member "${input.to}" not found`,
        data: { code: "not_found" },
      });
    }
    const card = await ctx.client.call("requestAttention", {
      id: input.id,
      to: to.id,
      note: input.note,
      moves: input.moves,
    });
    return { result: card, render: () => `${formatId(card.id)} waiting on ${to.name}` };
  },
};
