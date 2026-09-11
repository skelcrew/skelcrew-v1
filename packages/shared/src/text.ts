/**
 * Control characters, in one place: the set the daemon refuses at every write and the CLI and
 * the runner escape at every sink. A string carrying a carriage return or an escape sequence
 * can overwrite the line it is printed on, so a member could make its own entry read as
 * something it is not — and a record that can be repainted is not a record.
 *
 * The set is Unicode's, not a tool's: the C0 controls, DEL, and the C1 controls. It is defined
 * here and nowhere else; both functions below read the same predicate, so the characters
 * refused and the characters escaped can never drift apart.
 *
 * Bidirectional and formatting characters are deliberately not here: they can reorder how a
 * line reads without any control character, and they are also what right-to-left scripts need.
 * See spec 015, *Out of scope*.
 */

/**
 * How a field treats the two characters that lay text out. A single-line field — a title, a
 * member name, a branch, a path, a URL, a release reason — refuses them like every other
 * control character; a multi-line field — a body, a comment, an attention note — keeps them.
 */
export type TextKind = "single-line" | "multi-line";

/** What a multi-line field keeps: tab (U+0009) and line feed (U+000A). */
const MULTI_LINE_KEEPS = "\t\n";

/** The C0 controls, DEL, and the C1 controls. */
function isControlCode(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function isRefused(char: string, kind: TextKind): boolean {
  if (kind === "multi-line" && MULTI_LINE_KEEPS.includes(char)) return false;
  return isControlCode(char.charCodeAt(0));
}

/** `U+001B`: how a refused character is named in the error that refuses it. */
function codePointOf(char: string): string {
  return `U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
}

export interface ControlCharacter {
  /** The character itself. */
  char: string;
  /** Where it is in the string. */
  index: number;
  /** Its code point, as `U+001B`. */
  codePoint: string;
}

/** The first character `kind` refuses, or undefined when the string carries none. */
export function findControlCharacter(text: string, kind: TextKind): ControlCharacter | undefined {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (isRefused(char, kind)) return { char, index, codePoint: codePointOf(char) };
  }
  return undefined;
}

/** The two-character names; everything else in the set is written `\xNN`. */
const NAMED: Record<string, string> = { "\t": "\\t", "\n": "\\n", "\r": "\\r" };

function escapeOne(char: string): string {
  return NAMED[char] ?? `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
}

/**
 * `text` with every character `kind` refuses rendered as a visible ASCII escape, so a terminal
 * prints it rather than acting on it. Applying this twice changes nothing the first pass left.
 */
export function escapeControlCharacters(text: string, kind: TextKind): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    out += isRefused(char, kind) ? escapeOne(char) : char;
  }
  return out;
}
