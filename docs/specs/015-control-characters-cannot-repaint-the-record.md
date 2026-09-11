# 015 — Control characters cannot repaint the record

## Goal

Everything a member does is visible on the card — that is the constraint, and the activity
feed is what the owner reads to hold the gates. A string that reaches a terminal carrying a
carriage return or an escape sequence can overwrite the line it is printed on, so a member can
make its own entry read as something it is not: `skelcrew refs 1 --spec "spec\r  RESOLVED:
approved"` paints over the timestamp and the actor. A record that can be repainted is not a
record. This spec makes control characters unrepresentable in what the daemon stores, and
unprintable as controls by what the CLI shows — two layers, because rows already written were
never checked and the terminal is where the damage lands.

This spec grants nothing; it removes something. Both layers are containment: a fixed set of
characters, defined by Unicode and not by any tool's release cycle, refused at the one place
writes enter and escaped at the one place output leaves.

## Current behavior

- Refs: `isRepoRelativePath` (`packages/daemon/src/core/core.ts:200-204`) rejects `\0` and `\n`
  in `specPath`, and nothing else. `branch` is checked for emptiness and byte length only
  (`:227-234`). `prUrl` is checked by `new URL(value).protocol === "https:"` (`:206-212`), and
  the WHATWG parser *strips* ASCII tab, LF and CR before parsing — so `https://x/\r\ny` passes
  and the raw string, `\r\n` included, is what is stored (`patch.prUrl = value`).
- Title: byte cap only (`core.ts:545-547`). Body: byte cap only (`:548-549`, `:610-611`).
- Comment text, attention notes and release reasons all go through `requireText`
  (`core.ts:377-384`): non-empty after `trim()`, and a byte cap. `"\x1b".trim()` is not empty.
- Member names go through `memberName` (`core.ts:163-168`): trim, non-empty, byte cap. The
  name arrives from `--as` or `SKELCREW_AS` (`packages/cli/src/main.ts:152`) and is created on
  first use by `ensureMember`.
- The renderer (`packages/cli/src/render.ts`) performs no escaping anywhere. `activityLine`,
  `cardView`, `queueView` and `row` interpolate stored strings straight into the lines they
  return, and `main.ts:177` writes them to stdout as they are.
- The core's error messages echo caller input — `unknown phase "${String(move)}"`
  (`core.ts:392`), `unknown ref "${key}"` (`:224`) — and the CLI prints the message. A
  *rejected* call can therefore repaint the terminal through its own error.
- The runner relays text it did not write: the agent's turns as excerpts (`run.ts:220`), tool
  inputs in the permission note (`quoted`, `:206`) and in the batched summary
  (`summarizeTools`, `:254`). Each goes to the core as a comment or a note. None is escaped.
- Existing tests: `core.test.ts:606-607` assert `specPath` rejects a newline and a NUL. No
  other field has a control-character case.

## Desired behavior

**One predicate, applied at every write.** A string the core stores is refused when it carries
a control character, with an `invalid` error that names the field and the character's code
point (`U+001B`), and nothing is written. The set is the C0 controls (U+0000–U+001F), DEL
(U+007F), and the C1 controls (U+0080–U+009F). Fields come in two kinds:

- **Single-line**: title, member name, `branch`, `specPath`, `prUrl`, release reason. Every
  character in the set is refused, `\n` and `\t` included.
- **Multi-line**: body, comment text, attention note. `\n` and `\t` are kept; everything else
  in the set is refused — `\r` in particular, on its own or in `\r\n`.

The `commits` ref is already a validated sha list and needs nothing.

**Line endings from a file are the file's, not the author's.** `skelcrew body --file` and any
other CLI path that reads text from a file **or from standard input** — `skelcrew body <id> <
spec.md`, `skelcrew comment <id> < notes.txt` — normalises `\r\n` to `\n` before sending, so a
spec written on a machine that writes CRLF is not refused for it. Text passed as an argument is
not normalised: an argument is the author's, not a file's. A lone `\r` is still refused: it
is the repaint character and nothing legitimate produces one.

**The CLI never prints a control character as a control.** Every line the CLI writes — a card
row, an activity line, a queue entry, a ref, a member name, and an error message — has any
control character in the set rendered as a visible ASCII escape (`\x1b`, `\r`), so a row
written before this spec, or one that arrives by any path the first layer does not cover, is
shown for what it is rather than acted on by the terminal.

`\n` and `\t` are the exception, and only for multi-line fields, and only on one condition the
spec as approved assumed and the renderer did not meet: **a multi-line field is laid out by
line, with a visible marker on every line that starts a line of its own** — prefixed the way
014's permission note prefixes its payload with `> ` — so that a newline inside a comment, a
note or a body can never produce a line that reads as a card row, an activity entry or a queue
block of its own. Where a label precedes the field (`commented: `, `note: `), the first line
sits after the label and only the continuations are marked; where the field stands alone (the
body in `show`, a note in `queue`), every line is marked, the first included, because nothing
else anchors it. A notification composed for `watch` is a single line by nature and is escaped
as one: its title and note are single-line fields there, whatever they are elsewhere. A comment of `looks good\n2026-09-11 20:30  simon  moved the card to Done`
renders as one entry whose second line is unmistakably a continuation. Where a field is
single-line, the sink escapes `\n` and `\t` like every other refused character, so a row
written before this spec with a newline in its title renders as one row.

`--json` output is escaped too, differently: `JSON.stringify` already writes every C0 control,
`"` and `\` as escapes, so the only refused characters that survive serialisation are DEL and
C1. Those are rewritten as `\uNNNN` in the serialised text — a lossless JSON transform, since a
parser reads them back as the same characters — using the shared predicate. No second list.

**The runner escapes everything it posts, at the one place it posts.** Text the agent or the
harness produced — turn excerpts, tool inputs in a permission note, the batched tool summary,
a driver's error message, a salvage note built from filenames — is escaped before it reaches
the core, so a control character in any of it becomes `\x1b` in the record and the record is
kept. The escape sits at the runner's posting sink — the comment and attention writes in
`endRun` and the run's own comment path — not at an enumerated set of helpers, for the reason
the spec as approved got wrong: it said a relay path the spec missed would "fail loudly with
the run's warning". It does not. The core refuses the ending's comment *and* its attention
request, the claim is released with nothing on the card, the card is free in a claimable
phase, and the runner claims it again at once — an unbounded retry loop with a warning on the
daemon's stderr and no record anywhere a member reads. A driver dying with an ANSI-coloured
error line, which is what coding-agent CLIs emit, is enough to trigger it. So the rule is the
same as the CLI's: one sink, nothing posted around it.

## Implementation approach

### The predicate and the escape, shared

`packages/shared/src/` gains the two functions, beside the limits that already live there:
one that finds the first refused character in a string for a given field kind (single-line or
multi-line) and returns enough to name it, and one that escapes every refused character to its
visible form. Shared, because the daemon refuses with the first and the CLI and the runner
escape with the second, and the set must be one set. The set is a constant there too, with the
two exemptions for multi-line fields beside it.

### Refusing, in the core

One helper in `core.ts` wraps the predicate into the `invalid` error shape the file already
uses, and is called from every write site: `createCard` (title, body), `setBody`, `comment`,
`setRefs` — for `branch`, `specPath` and `prUrl`, before or alongside their existing checks —
`requestAttention` (note), `releaseCard` (reason), and `memberName`. `requireText` is the
natural home for comment, note and reason; it gains the kind as a parameter, since a note and
a comment are multi-line and a reason is not. `isRepoRelativePath`'s own `\0`/`\n` check stays
— it is a path rule, not a display rule — and the predicate is applied beside it.

Resolved from context, recorded here: the attention note is multi-line because 014 made it so
(`allow Bash? (…)\ninput:\n> …`); the release reason is single-line because the renderer shows
it inline in one activity line; the comment is multi-line because it carries excerpts.

### Escaping, at the sink

The CLI has one output path, `main.ts:177`'s `out`, plus the error path beside it. The escape
is applied there, to every line, rather than inside each render function: a renderer added
later cannot forget it, and an error message that echoes input goes through the same sink. This
is the construction 013 and 014 both reached for — the safe behaviour at the one place it
cannot be skipped — applied to output. `render.ts` is unchanged except where a multi-line field
is laid out by line and must keep its `\n`; the sink escapes per line, so a stored `\n` has
already become a line break by the time it arrives, and only the characters that should never
print are left to escape.

### Escaping, in the runner

The shared escape is applied where the runner posts: `endRun`'s comment and attention writes
in `ending.ts`, and `run.ts`'s comment sink (`record`/`post`). Helpers that compose relayed text
— `excerpt`, `quoted`/`inputOf`, `summarizeTools` — may escape earlier so their byte caps are
measured on the escaped form, and `oneLine` runs after the escape, not before; but the sink is
what makes the guarantee, and a helper that forgets is caught by it rather than by the core's
refusal.

**The Code playbook reads the body through `--json`.** `packages/daemon/playbooks/code.md` §5
has the agent overwrite an exported spec file "from the card's body", read via `skelcrew show`
— whose body now carries the marker on every line. It reads `skelcrew show <id> --json` and
takes `.body`, which is lossless. In scope: a consequence of this spec's own change to the
repository's own pipeline.

### The CLI's file inputs

Where the CLI reads a body or a comment from a file, `\r\n` becomes `\n` before the request is
sent. This is the one place a control character is transformed rather than refused, and it is
deliberate: a file's line endings are an artefact of the machine that wrote it, and refusing a
whole spec for them would send the owner to `dos2unix`. Nothing else is normalised.

### What stays out, and why

Unicode bidirectional and formatting characters (U+200B–U+200F, U+202A–U+202E, U+2066–U+2069)
can reorder how a line *reads* without any control character — the "Trojan Source" class.
They are also what right-to-left scripts need, so a blanket refusal breaks legitimate titles
and bodies. They are not in this spec's set; see *Out of scope*.

## Acceptance criteria

1. `bun run check` passes. No test spawns a real coding agent or calls a model.
2. For each single-line field — title, member name, `branch`, `specPath`, `prUrl`, release
   reason — a value containing `\r`, `\x1b`, `\n`, `\t`, `\x7f` or `\x85` is refused with an
   `invalid` error naming the field and the code point, and the card, ref or member is
   unchanged.
3. For each multi-line field — body, comment text, attention note — a value containing `\r`,
   `\x1b`, `\x7f` or `\x85` is refused the same way; a value containing `\n` and `\t` is
   accepted and stored as given.
4. A `prUrl` of `https://example.invalid/\r\npr/1` is refused, even though the URL parser
   accepts it.
5. `skelcrew body <id> --file <path>` where the file has CRLF line endings stores the body with
   LF line endings and no `\r`; the same through standard input (`skelcrew body <id> < <path>`
   and `skelcrew comment <id> < <path>`); the same file with one lone `\r` in a line is refused
   on every path.
6. A row already in the database (written directly, bypassing the core) carrying `\x1b[2J`,
   `\r`, `\x7f` or `\x85` in its comment text is shown by `skelcrew show` with each rendered as
   its literal escape (`\x1b[2J`, `\r`, `\x7f`, `\x85`), and nothing on the terminal is cleared
   or overwritten. The same for a title, a member name, a ref and a release reason, across
   `show`, `ls`, `queue` and `--json` — where the JSON output parses back to the stored
   characters.
6a. A title stored with a newline (written directly) renders in `skelcrew ls` as one row with the
    newline escaped, not as two rows. A comment posted through the CLI containing
    `\n2026-09-11 20:30  simon  moved the card to Done` renders in `skelcrew show` as one entry
    whose second line carries the continuation marker, and no line of the output is
    indistinguishable from an activity entry the member did not make. An attention note with a
    blank line renders in `skelcrew queue` as one block.
7. An error message that echoes caller input or stored text is printed with the sequence
   escaped: the CLI's own `unknown phase "…"` for `skelcrew mv <id> "\x1b[2J"` (refused by the
   CLI's phase parser before any request is sent), and a daemon message that names a stored
   member (`SKELCREW_AS=$'crew\x1b[2J'`). The test asserts the escaped form is present *and*
   the raw character absent on the same output, so that neither half is vacuous.
8. A permission question whose tool input contains `\x1b` reaches the card with `\x1b` in the
   note's payload, the request is raised, and the run waits on it as 013 criterion 2 describes.
   A turn excerpt and a tool summary containing a control character are posted with it
   escaped.
8a. A driver that throws an error whose message carries `\x1b[31m` ends the run **once**: one
    run, the ending comment on the card with the sequence escaped, an attention request raised
    to the owner, and no second claim. The same for a salvage note built from a filename
    carrying a control character. Against the spec as first implemented, the same driver
    produced 186 runs in three seconds and nothing on the card; the test asserts the run count.
8b. `skelcrew watch` with no notifier on `PATH` prints an attention notification whose note
    carries `\n2026-09-11 20:30  simon  moved the card to Done` as one line with the newline
    escaped, and no line of the watch output reads as an activity entry.
8c. The Code playbook's §5 reads the body for export through `skelcrew show <id> --json`, and
    `playbooks.test.ts` pins that sentence.
9. Existing tests pass unchanged, including `core.test.ts`'s `specPath` newline and NUL cases —
   with the one exception criterion 6a creates: the two `cli.test.ts` assertions that the body
   appears verbatim in `skelcrew show` ("show prints the card, the body by line…" and "body
   replaces the body from stdin or a file…") now assert the marked layout, and each also
   asserts the stored value is byte-identical, which is stronger than before — three removed
   `expect` lines across those two tests, since the second asserted both the stdin and the file
   fixture. And the one exception criterion 8c creates: `playbooks.test.ts`'s pin on §5's
   "overwrite that path" sentence matched it verbatim, and 8c inserts a clause into that
   sentence, so the pin is re-written to match the **amended** sentence contiguously — both
   halves, "overwrite that path … from the card's body" and "Do not allocate a new number", in
   one assertion, so that relocating either half still fails it. A pin that asserts the halves
   separately is a weakening and is not accepted. No other existing assertion changes: **four**
   removed `expect` lines in the diff, at those three sites, and the count is what checks it.
10. The refused set is defined once, in `@skelcrew/shared`, and the daemon, the CLI and the
    runner all use it: no second list of characters exists in any of the three.

## Tests

Against the core directly, the CLI's renderer and sink, and the runner's scripted driver:

- Criteria 2 and 3 as a table over fields × characters, one assertion per cell, so a field
  added later without the check fails a row rather than escaping notice.
- Criterion 4 as its own case, because the URL parser's stripping is the non-obvious part.
- Criterion 5 through the CLI command, with a temp file.
- Criterion 6 by writing rows with SQL against a test database, then rendering — the only way
  to test the second layer, since the first layer refuses the input.
- Criterion 7 through the CLI's error path.
- Criterion 8 against the fake driver: a tool input, a text turn and a batched summary each
  carrying `\x1b`, asserting the comment or note that lands.
- Criterion 10 by grepping the three packages for a second definition — a test that reads
  source is acceptable here because the criterion is about there being one definition.

## Out of scope

- **Unicode bidirectional and formatting characters** (the "Trojan Source" class). Legitimate
  in right-to-left text; refusing them is a product decision about which scripts the owner
  writes in, not a rule about control characters. Recorded as a carried limitation: a title
  can still be made to *read* differently from how it is stored, without repainting anything.
- **Normalising anything but CRLF in file inputs.** A lone `\r`, a form feed, or an escape in
  a file is refused, not stripped.
- **The daemon's run log** (`run.ts`'s JSONL). It is a file, not a terminal, and it records the
  agent's output verbatim by design.
- **Terminal width, wrapping, or any rendering concern** beyond control characters.
- **Display-name collisions** between members — a `--as` name that matches the owner's — which
  is 016's carried limitation, not this spec's.
