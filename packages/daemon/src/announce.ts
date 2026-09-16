/**
 * The daemon's own ping: a question raised to a human reaches the owner sitting beside the
 * terminal the daemon runs in, without them running anything. It is not a member action and
 * records nothing on the card — the request is already there — so this reads the core and
 * never writes to it.
 *
 * The notifier is the CLI's, unchanged (010): `SKELCREW_NOTIFY`, else `osascript`, else
 * `notify-send`, else a printed line. `watch` keeps pinging whoever runs it, so an owner
 * running both hears twice; not coupling the two is the spec's choice (023).
 */
import { BELL, escapeControlCharacters, notify, selectNotifier } from "@skelcrew/shared";
import type { Core } from "./core/core";

/**
 * The variable that names the notifier command, and the value that turns it off. `none` is the
 * shared notifier's own switch, so this file would send nothing under it either way; the check
 * below is what also keeps the bell quiet, which is the daemon's alone.
 */
const NOTIFY_ENV = "SKELCREW_NOTIFY";
const NOTIFY_OFF = "none";

/**
 * `#12 Add login page: why: the push needs your say-so` — the card, its title, and the note's
 * first line, which is the question's own summary (022's `why:` line when there is one). A
 * banner is one line by nature, so both fields are escaped as single-line ones, whatever they
 * are on the card.
 */
function announcementText(card: { id: number; title: string }, note: string): string {
  const oneLine = (text: string) => escapeControlCharacters(text, "single-line");
  return `#${card.id} ${oneLine(card.title)}: ${oneLine(note.split("\n", 1)[0] ?? "")}`;
}

/**
 * Announces every request raised to a human member, while `isTerminal` and the notifier is not
 * turned off. Returns the unsubscribe, which the daemon calls on shutdown with its timers; a
 * daemon that does not announce subscribes to nothing and returns a no-op.
 */
export function startAnnouncing(options: {
  core: Core;
  env: Record<string, string | undefined>;
  platform: string;
  /** Whether the daemon's own standard output is a terminal. */
  isTerminal: boolean;
  /** Written verbatim to that terminal: the bell, and a printing notifier's line. */
  out: (text: string) => void;
  warn: (line: string) => void;
}): () => void {
  if (!options.isTerminal || options.env[NOTIFY_ENV] === NOTIFY_OFF) return () => {};
  const notifier = selectNotifier(options.env, options.platform);
  const named = options.env[NOTIFY_ENV] ?? notifier.name;

  const reasonFor = (error: unknown) => (error instanceof Error ? error.message : String(error));

  // Warned once for the process: a notifier that is missing or broken is missing or broken for
  // every request after it, and a line per question would bury the questions themselves.
  let warnedAboutNotifier = false;
  const notifierFailed = (error: unknown): void => {
    if (warnedAboutNotifier) return;
    warnedAboutNotifier = true;
    options.warn(`skelcrew daemon: could not announce through ${named}: ${reasonFor(error)}`);
  };

  // Anything else that goes wrong here is a defect, not a notifier the owner can fix, so it is
  // said every time and worded as its own thing: one flag must not hide a daemon bug for the
  // rest of the process.
  const brokeDown = (error: unknown): void => {
    options.warn(`skelcrew daemon: announcing a request failed: ${reasonFor(error)}`);
  };

  // One notification at a time, in the order the requests arrive, the way `watch` pings: a
  // notifier is a subprocess, and two banners racing is no better than two in a row.
  let chain: Promise<void> = Promise.resolve();
  return options.core.subscribe((event) => {
    // A listener that throws is rethrown at the mutation that caused it: raising a request
    // must not fail because announcing it did.
    try {
      if (event.type !== "attention_requested" || event.cardId === null) return;
      // A request to an agent is that agent's work, not a question anyone is beside the
      // terminal for.
      if (options.core.getMember(event.data.to).kind !== "human") return;
      const text = announcementText(options.core.getCard(event.cardId), event.data.note);
      options.out(BELL);
      chain = chain
        .then(async () => {
          const status = await notify(notifier, "skelcrew", text, (line) =>
            options.out(`${line}\n`),
          );
          if (status !== 0) throw new Error(`exited ${status}`);
        })
        .catch(notifierFailed);
    } catch (error) {
      brokeDown(error);
    }
  });
}
