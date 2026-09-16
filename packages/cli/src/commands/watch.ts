import { type Activity, type Member, notify, selectNotifier } from "@skelcrew/shared";
import { activityLine, formatId, oneLine } from "../render";
import {
  type Command,
  flag,
  noExtraPositionals,
  START_A_DAEMON,
  string,
  UsageError,
} from "./command";

type Input = { since?: number };

/**
 * The live tail: one line per event as it happens, the same line `show` renders, and a
 * notification when an `attention_requested` event addresses the invoking member. Stays
 * running until SIGINT or SIGTERM (exit 0) or until the daemon goes away (exit 1).
 */
export const watch: Command<Input, null> = {
  usage: "watch [--since <seq>]",
  options: { since: { type: "string" } },

  parse(args) {
    noExtraPositionals(args, 0);
    if (flag(args, "json")) throw new UsageError("--json does not apply to watch");
    const since = string(args, "since");
    if (since === undefined) return {};
    if (!/^\d+$/.test(since)) throw new UsageError(`"${since}" is not a sequence number`);
    return { since: Number(since) };
  },

  async run(ctx, input) {
    // Installed before anything is awaited: a ctrl-c during the replay is a clean exit too.
    const stopped = new Promise<void>((done) => {
      process.once("SIGINT", () => done());
      process.once("SIGTERM", () => done());
    });
    const me = ctx.client.member;
    const members: Member[] = await ctx.client.call("listMembers", {});
    const notifier = selectNotifier(process.env, process.platform);

    async function handle(event: Activity): Promise<void> {
      if (event.type === "member_joined") {
        members.push({
          id: event.actorId,
          name: event.data.name,
          kind: event.data.kind,
          createdAt: event.createdAt,
        });
      }
      // The line first, unconditionally: a failing ping must not hide the event.
      ctx.out(activityLine(event, members));
      if (
        event.type === "attention_requested" &&
        event.data.to === me.id &&
        event.cardId !== null
      ) {
        // Ping only while this request is still the card's open one, matched by the
        // record the event carries: a replayed request that was since answered, replaced,
        // or moved on is history, not a call to act.
        const card = await ctx.client.call("getCard", { id: event.cardId });
        const open = card.attention;
        if (
          open !== null &&
          open.raisedAt === event.data.raisedAt &&
          open.raisedBy === event.data.raisedBy
        ) {
          // A notification is one line by nature — a desktop banner, or a printed line beside
          // the events when there is no notifier — so the title and the note are single-line
          // fields here, whatever they are on the card.
          const text = `${formatId(card.id)} ${oneLine(card.title)}: ${oneLine(event.data.note)}`;
          await notify(notifier, "skelcrew", text, ctx.out);
        }
      }
    }

    // Events are handled one at a time, in the order they arrive, even when one waits on
    // a card read or a notifier; a failure is reported and the tail goes on.
    let chain: Promise<void> = Promise.resolve();
    await ctx.client.subscribe((event) => {
      chain = chain
        .then(() => handle(event))
        .catch((error) => {
          ctx.warn(`error: ${error instanceof Error ? error.message : String(error)}`);
        });
    }, input.since);
    ctx.warn(`watching as ${oneLine(me.name)}; ctrl-c to stop`);

    // A dead tail that looks alive is worse than none: losing the daemon is an error.
    const outcome = await Promise.race([
      stopped.then(() => "stopped" as const),
      ctx.client.closed.then(() => "lost" as const),
    ]);
    if (outcome === "lost") {
      throw new Error(`lost the daemon on ${ctx.socketPath}; ${START_A_DAEMON}, and watch again`);
    }
    return { result: null, render: () => "" };
  },
};
