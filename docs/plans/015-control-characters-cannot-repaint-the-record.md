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
- **`--json` is not escaped.** It is the daemon's result copied out for a machine, and escaping
  the serialized text would change the values a reader parses back (`\n` in a body would become
  a literal backslash-n). `JSON.stringify` already writes C0 characters as `\uNNNN`; DEL and the
  C1 range it emits raw, so a pre-015 row printed with `--json` still carries them. Recorded as
  a limitation rather than fixed, because fixing it means a second character list.
- **Which file reads normalise.** `readFile` in `commands/command.ts`, the one helper behind
  `body --file` and `add --body-file`. Text arriving on stdin is not a file read and is not
  normalised (`comment` already strips one trailing `\r\n`; `add` already strips a trailing `\r`
  per bulk line).
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

## Red, then green

Every new test was run against `main` at `63011e8` with this branch's implementation files
replaced by the base's (a scratch copy, `bun --cwd`): 59 of the 60 fail there. The one that
passes is `core.test.ts`'s "a multi-line field keeps newlines and tabs, stored as given" — it
characterises behaviour that already existed and must survive the change, so it cannot be red.
