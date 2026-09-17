/**
 * The escape character and the few sequences built from it, in both directions. It is spelled
 * here and nowhere else in the CLI: the screen is the one place that writes control characters
 * on purpose rather than escaping them (015), so keeping every one of them in one small file is
 * what makes that exception readable — and checkable.
 *
 * Emphasis is bold, dim and reverse only. No colour sequence is written anywhere, so the screen
 * takes the terminal's own theme rather than shipping one.
 */

const ESC = "\x1b";
const RESET = `${ESC}[0m`;

export const ENTER_ALTERNATE_SCREEN = `${ESC}[?1049h`;
export const LEAVE_ALTERNATE_SCREEN = `${ESC}[?1049l`;
export const HIDE_CURSOR = `${ESC}[?25l`;
export const SHOW_CURSOR = `${ESC}[?25h`;
/** Top left, without clearing: a frame overwrites the one before it line by line. */
export const CURSOR_HOME = `${ESC}[H`;
/** From the cursor to the end of the line. */
export const ERASE_LINE = `${ESC}[K`;
/** From the cursor to the end of the screen: what a shorter frame leaves behind. */
export const ERASE_BELOW = `${ESC}[J`;

export function bold(text: string): string {
  return `${ESC}[1m${text}${RESET}`;
}

export function dim(text: string): string {
  return `${ESC}[2m${text}${RESET}`;
}

export function reverse(text: string): string {
  return `${ESC}[7m${text}${RESET}`;
}

/** The escape key, as raw stdin delivers it — alone, and heading every sequence key. */
export const ESCAPE_KEY = ESC;

/**
 * Up and Down, as raw stdin delivers them, and the key each sequence is (031). Terminals
 * disagree here too: the usual form opens `[`, and a terminal in application cursor mode sends
 * `O` — this screen never turns that mode on, but a multiplexer may. These four are the only
 * sequences the screen has a key for, wherever in a read they arrive; a sequence it has no key
 * for is dropped, and the rest of that read with it.
 */
export const ARROW_KEYS: [sequence: string, key: string][] = [
  [`${ESC}[A`, "up"],
  [`${ESC}[B`, "down"],
  [`${ESC}OA`, "up"],
  [`${ESC}OB`, "down"],
];

/** Ctrl-C, as raw stdin delivers it: in raw mode the terminal sends this byte, not a signal. */
export const INTERRUPT_KEY = "\x03";

/**
 * Backspace, as raw stdin delivers it. Terminals disagree: most send delete for the key marked
 * Backspace, some send backspace, and the screen's one text input takes both for the same key.
 */
export const BACKSPACE_KEYS = ["\x7f", "\x08"];
