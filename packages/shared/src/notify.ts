/**
 * The ping: one OS notification per attention request its reader should hear about — `watch`'s
 * invoking member (010), and the owner beside a daemon running in a terminal (023), which is
 * why this sits in shared rather than in the CLI. `SKELCREW_NOTIFY` names a command that
 * receives the title and the text as its two arguments (tests point it at a recording script);
 * otherwise `osascript` on macOS, then `notify-send` wherever it is on PATH, and failing both a
 * marked line on stdout. Selection runs nothing: PATH is scanned for an executable file, the
 * way `which` would.
 *
 * The one value that is not a command is `none`, which is the switch: an owner who wants quiet
 * sets it and every reader of the variable goes silent — `watch` tails on without pinging, and
 * a daemon in a terminal announces nothing at all (023). It is spelled out here, where the
 * variable is read, so that no caller has to know it.
 */
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/** What `SKELCREW_NOTIFY` is set to for no notifications at all. */
const NOTIFY_OFF = "none";

export interface Notifier {
  readonly name: "custom" | "osascript" | "notify-send" | "print" | "none";
  /** The command for one ping; absent when the notifier prints instead, or is off. */
  argv?(title: string, text: string): string[];
}

/** The first executable file named `command` on `path`, or undefined. */
export function findOnPath(command: string, path: string | undefined): string | undefined {
  if (!path) return undefined;
  for (const dir of path.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, command);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not there, or not runnable: try the next directory.
    }
  }
  return undefined;
}

/** A double-quoted AppleScript string literal. */
function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function selectNotifier(
  env: Record<string, string | undefined>,
  platform: string,
): Notifier {
  const custom = env.SKELCREW_NOTIFY;
  if (custom === NOTIFY_OFF) return { name: "none" };
  if (custom) return { name: "custom", argv: (title, text) => [custom, title, text] };
  if (platform === "darwin") {
    const osascript = findOnPath("osascript", env.PATH);
    if (osascript) {
      return {
        name: "osascript",
        argv: (title, text) => [
          osascript,
          "-e",
          `display notification ${appleScriptString(text)} with title ${appleScriptString(title)}`,
        ],
      };
    }
  }
  const notifySend = findOnPath("notify-send", env.PATH);
  if (notifySend) return { name: "notify-send", argv: (title, text) => [notifySend, title, text] };
  return { name: "print" };
}

/**
 * Sends one notification and waits for the command to finish; prints when there is none, and
 * does nothing at all when the notifier is off. Throws when the command cannot be spawned, and
 * otherwise returns what it exited with — a notifier that runs nothing exits nothing, so it
 * returns 0. A caller that treats a failing notifier as its own failure reads the status;
 * `watch` ignores it, as it always has.
 */
export async function notify(
  notifier: Notifier,
  title: string,
  text: string,
  print: (line: string) => void,
): Promise<number> {
  if (notifier.name === "none") return 0;
  if (!notifier.argv) {
    print(`[notify] ${title}: ${text}`);
    return 0;
  }
  const proc = Bun.spawn(notifier.argv(title, text), {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return proc.exited;
}
