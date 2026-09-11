# 015 — Control characters cannot repaint the record

## The change, in steps

1. `packages/shared/src/text.ts`: the one definition of the refused set (C0, DEL, C1), the
   two exemptions for multi-line fields (`\n`, `\t`), a `findControlCharacter(text, kind)`
   that names the first refused character as `U+XXXX`, and an
   `escapeControlCharacters(text, kind)` that renders each one visibly (`\r`, `\x1b`).
   Re-exported from `packages/shared/src/index.ts`.
2. `packages/daemon/src/core/core.ts`: one `requireNoControl(what, kind, value)` wrapping the
   predicate into the file's `invalid` error, called from `memberName`, `createCard` (title,
   body), `setBody`, `requireText` (comment, note, reason — kind as a parameter), and
   `validateRefs` (`branch`, `specPath`, `prUrl`). `isRepoRelativePath`'s own `\0`/`\n` check
   stays.
3. `packages/cli/src/main.ts`: the escape at the sink — `out`, `warn`, the rendered result,
   and `fail`'s two stderr writes. `render.ts` unchanged.
4. `packages/cli/src/commands/command.ts`: `readFile` normalises `\r\n` to `\n`, which is what
   `body --file` and `add --body-file` read through. Nothing else is normalised.
5. `packages/daemon/src/runner/run.ts`: the shared escape in `excerpt`, in `questionFor`'s
   input (and so in `describeInput`, which `describeCall` uses) and in `summarizeTools`.

## Files expected to touch

- `packages/shared/src/text.ts` (new), `packages/shared/src/text.test.ts` (new),
  `packages/shared/src/index.ts`
- `packages/daemon/src/core/core.ts`, `packages/daemon/src/core/core.test.ts`
- `packages/cli/src/main.ts`, `packages/cli/src/commands/command.ts`,
  `packages/cli/src/cli.test.ts`
- `packages/daemon/src/runner/run.ts`, `packages/daemon/src/runner/run.test.ts`

## Decisions the spec left open

- **Escape forms.** `\n`, `\r`, `\t` render as their two-character names; every other refused
  character renders as `\xNN` with two lowercase hex digits (the whole set fits in two). The
  backslash itself is not escaped: a literal `\x1b` a member typed stays `\x1b`, which the spec
  neither asks for nor rules out, and escaping backslashes would rewrite every path and command
  the CLI prints.
- **Where the CLI escapes.** The sink is `out`, `warn`, the rendered result written in `main`,
  and `fail`. All four go through one `safe()` so a renderer or an error added later cannot skip
  it. The kind there is multi-line: a stored `\n` is already a line break by the time it reaches
  the sink, and tabs a renderer laid out stay tabs.
- **`--json` is not escaped.** *(Superseded in round 2 — see below; it is escaped as JSON.)*
- **Which file reads normalise.** `readFile` in `commands/command.ts`, the one helper behind
  `body --file` and `add --body-file`. *(Round 2 adds standard input, at `main.ts`'s `stdin()`.)*
- **The order of checks.** The control check runs before the empty check in `requireText` and
  `memberName`, so a value of exactly `"\r"` is refused for the character it carries rather than
  for trimming to nothing, and before `trim()` so a trailing `\n` cannot be silently dropped.
- **Criterion 10's test** scans non-test sources of the three packages for the syntax a second
  definition would need (`\xNN`/`\uNNNN` escapes, `0xNN` literals, `charCodeAt`/`codePointAt`)
  and asserts `shared/src/text.ts` is the only file with any. Test files are excluded: they
  spell control characters out by necessity.
- **Not escaped, and why:** the tool *name* in `describeCall` and in the question's frame. The
  spec names `excerpt`, `quoted`/`inputOf` and `summarizeTools` as the relay helpers; a control
  character in a tool name is the "relay path this spec misses" the spec describes, refused
  loudly by the core.

## Red, then green (round 1)

Every new test was run against `main` at `63011e8` with this branch's implementation files
replaced by the base's (a scratch copy, `bun --cwd`): 59 of the 60 fail there. The one that
passes is `core.test.ts`'s "a multi-line field keeps newlines and tabs, stored as given" — it
characterises behaviour that already existed and must survive the change, so it cannot be red.

## Round 2 — review findings, against the amended spec

The spec was amended first (`3e58014`): the approved text kept `\n` in multi-line fields "where
the renderer already lays the text out by line", a condition `render.ts` never met, so a stored
newline could forge a card row, an activity entry or a queue block. What changed here:

1. **`render.ts` lays multi-line fields out and escapes single-line ones.** `oneLine()` escapes
   a title, a member name, a ref, a release reason and a `move_rejected` reason with the
   single-line kind before they reach a line, so a legacy title with `\n` is one row.
   `continued()` marks every line after the first of a field that follows a label (a comment
   after `commented: `, a note after `note:    `); `marked()` marks every line of a field that
   stands on its own (a card's body in `cardView`, a note in `queueView`). The marker is `> `,
   an empty line becoming `>`, which is 014's `quoted()` — and it is what stops a blank line
   inside a note ending its queue block. The sink's multi-line escape stays as the backstop.
2. **`--json` is escaped after all** (`safeJson` in `main.ts`). `JSON.stringify` escapes every
   C0, `"` and `\`, so only DEL and C1 survive; those are rewritten as `\uNNNN` using
   `findControlCharacter`'s own code point — no second list, and a parser reads the value back
   unchanged. The round-1 note above ("`--json` is not escaped") is superseded; the absolute at
   `main.ts`'s `safe()` now holds for every byte the CLI writes.
3. **Standard input is normalised like a file** — `withLfLineEndings` in `commands/command.ts`,
   applied by `readFile` and by `main.ts`'s `stdin()`, so `body <id> < spec.md` and
   `comment <id> < notes.txt` take a CRLF file. An argument is never normalised.
4. **`attention`'s own line escapes the member name** it prints, which is a stored single-line
   field that `render.ts` does not compose.
5. **The source scan also trips on `\p{C…}`, `\u{…}` and `fromCharCode`**, and its doc comment
   says it is a tripwire for the common spellings rather than a proof.

Two existing assertions changed, because the spec changed what they assert: `show`'s body is no
longer printed verbatim, so "show prints the card, the body by line…" and "body replaces the
body from stdin or a file…" now assert the marked layout beside the unchanged stored value.

### Red, then green (round 2)

- Against the round-1 commit `4444bfd` (its four CLI files restored into a scratch copy), **8
  tests fail**: the CRLF/stdin case, the `\x7f` and `\x85` rows (the `--json` residue), the
  three criterion 6a forgeries, and the two body-rendering assertions above.
- The other three round-2 tests — the `\x1b` and `\r` rows, and the daemon-message-naming-a-
  stored-member half of criterion 7 — **pass against round 1**: they widen coverage of
  behaviour round 1 already had (C0 escaping at the sink). They are red against base.
- Against base `63011e8`, of the 69 tests this branch adds or changes, **68 fail**; the one that
  passes is the characterisation test named above.
- The scan tripwire was checked by execution: with the reviewer's `export const CONTROLS =
  /\p{Cc}/u;` added to `render.ts` in a scratch copy, the round-1 regex passed and the round-2
  regex fails, naming `cli/src/render.ts`.
