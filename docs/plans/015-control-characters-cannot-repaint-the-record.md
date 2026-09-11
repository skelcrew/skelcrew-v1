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
- **Not escaped, and why:** the tool *name* in `describeCall` and in the question's frame.
  *(Superseded in round 3: the core's refusal is not loud — it loops. Everything the runner
  posts is escaped at its sink, tool names included.)*

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
- Against base `63011e8`, as of round 2, of the 69 tests this branch then added or changed,
  **68 failed**; the one that passed is the characterisation test named above. At HEAD, after
  round 3, the figure is **74 added or changed, 72 failing against base** (verification's own
  count): the two that pass are that characterisation test and the split `playbooks.test.ts`
  pin — a *changed* pre-existing test whose rule already held at base, correctly green.
- The scan tripwire was checked by execution: with the reviewer's `export const CONTROLS =
  /\p{Cc}/u;` added to `render.ts` in a scratch copy, the round-1 regex passed and the round-2
  regex fails, naming `cli/src/render.ts`.

## Round 3 — review findings, against the amended spec

The spec was amended again (`028523f`), and both Criticals were regressions this spec itself
introduced by escaping an *enumerated* set of helpers.

1. **The runner escapes at its posting sink, not in helpers** (Critical 1). `postingCore` in
   `ending.ts` wraps the core the runner half is given — `startRunner` uses it for everything —
   and escapes a comment's text, an attention note and a release reason on the way in. Refs are
   deliberately untouched: a branch or a path is a reference, and an escaped one would name
   something that does not exist, so the core's refusal is the right answer there.

   Why a wrapper rather than the two call sites the finding named: the failure mode was an
   *unenumerated* path. A driver dying with an ANSI-coloured error line had its message posted
   raw as the ending note, the core refused both the comment and the request, `endRun` released
   the claim, and the free card in a claimable phase was claimed again at once. Reproduced here
   before the fix: **13 runs in 200 ms** (the reviewer saw 186 in three seconds). The salvage
   note built from `git status` filenames does the same, and neither is `excerpt`, `quoted` or
   `summarizeTools`. A wrapper is what makes "a path added later inherits it" true.

   The helpers still escape early — the comment in `relayed()` now says why: the byte caps for
   an excerpt, a question and a summary have to be measured on what is actually posted, not on
   what it was before escaping. `describeInput` escapes before `oneLine` for the same reason
   (Minor 6). Every "refused loudly by the core" claim in code comments and in this record is
   corrected.
2. **`watch`'s notification is one line** (Critical 2). `watch.ts` composes the ping from
   `oneLine(card.title)` and `oneLine(event.data.note)`, so the print fallback cannot put a
   line on stdout that reads as an activity entry.
3. **The Code playbook reads the body through `--json`** (Important 3). `playbooks/code.md` §5
   now says so, and `playbooks.test.ts` pins the sentence. One existing pin — "reuses the
   recorded spec path" — matched the old sentence verbatim and now asserts its two halves; the
   rule it pins is unchanged.
4. **`fail` and `warn` escape single-line** (Minor 4), through `safeLine`; only `out` and the
   rendered result keep the multi-line kind, and `fail`'s `extra` is the CLI's own usage block.
5. **One `oneLine`** (Minor 5), exported from `render.ts` and used by `add`, `attention`,
   `claim` and `watch` — every command that composes a line from a stored single-line field.

### Red, then green (round 3)

Against the round-2 commit `1915ef9` (its nine implementation files and `code.md` restored into
a scratch copy, final test files, `bun --cwd`): **5 fail, 149 pass** — exactly the five tests
this round adds or changes, and nothing else, so the fixes changed no other observable.

- `run.test.ts` "a driver error carrying an escape sequence ends the run once…" → `expect(runs)
  .toBe(1)` received **13** here and **14** in the verifier's run. That count is how many
  re-claims fit in the 200 ms the test waits, so it is timing-dependent and machine-dependent;
  nothing rests on the number, which is why the assertion is "exactly one run" rather than a
  ceiling. Where this record and *Verification* below quote different figures, this is why.
- `runner.test.ts` "a salvage note naming a file whose name carries an escape…" → no `kept`
  comment within 2 s; the card got `teardown failed: comment must not contain…` instead.
- `cli.test.ts` "watch's printed notification is one line…" → the ping printed
  `[notify] skelcrew: #1 Watched: ping` and the forged entry on the line after it.
- `cli.test.ts` "a daemon message naming a stored member…" (changed: a second half added) →
  `Received: "error: card 1 is claimed by crew\n2026-09-11 20:30  simon  moved the card to Done
  until …"`, two lines.
- `playbooks.test.ts` "the Code playbook reads the body for export through --json" → the
  playbook did not contain `skelcrew show <id> --json`.

## Review round 3 — APPROVED, five Minors carried

No Critical, no Important. Round 3 re-ran the four forgeries and the loop over a real socket
and with the fake driver; probed a fifth surface (`osascript` present — the AppleScript string
escaping held, a `do shell script` injection did not fire; server-side `unknown method` errors
JSON-escaped on the wire and escaped again on print; `ls --json` round-tripping through a JSON
parser); checked the byte caps at the boundary (an all-ESC note escaped to exactly
`COMMENT_MAX_BYTES / 4 × 4 = 16384` bytes, accepted with nothing to spare); traced the refs
exception (`slug()` maps every non-alphanumeric to `-`, so no control character reaches a
branch ref; `commits` is sha-validated); and reproduced the round-2 restore at exactly the five
named tests. The Minors, with their disposition:

1. **`ending.ts:75-96` overclaims.** `postingCore`'s doc says "every text it writes to a card
   … is escaped" and "a path added later inherits it". The wrapper covers `comment`,
   `requestAttention` and `releaseCard` — the three the runner calls — and passes `createCard`,
   `setBody` and `resolveAttention` through, and its return type is a plain `Core`. True of the
   runner as written; not true of the promise. **Carried**: narrow the sentence, or brand the
   wrapped type so `endRun`/`runPlaybook` cannot take a raw core.
2. **The daemon's own stderr is unescaped** (`ending.ts:335`, `runner.ts:220`, `run.ts:365`).
   `warn()` interpolates the raw note; a git error with `color.ui = always` puts ANSI on the
   daemon operator's console. Can repaint the daemon's console, not the record. Out of the
   spec's second layer, which is scoped to the CLI, and not listed in *Out of scope*.
   **Carried to `docs/MILESTONES.md`** in the follow-up docs commit on `main`.
3. **Criterion 9 was literally unmet** — 6a changed two assertions and the spec said none.
   **Fixed in the spec** (`40aa846`), then found still short by one (see *Verification*).
4. **The playbook's `--json` body read** makes the agent reconstruct a markdown file from a JSON
   string literal, when the body it needs is already in the run's first user message verbatim
   (`cardPrompt`). `jq` is not on the fixed list, so `| jq -r .body` would ask. **Carried**:
   name the first user message as the source, or add a raw-body output mode in a later spec.
5. **The re-claim loop is latent, not gone.** `endRun` catches *any* core refusal of its comment
   and request, warns, and releases; a free card in a claimable phase is claimed again at once
   with no backoff. 015 removed the one reachable trigger (verified: the byte cap cannot be
   overrun by escaping, since `within()` budgets `/4` and the escape expands at most 4×; ending
   notes are non-empty constants). The next refusal at that sink costs 186 runs in three
   seconds and no record. **Carried to `docs/MILESTONES.md`** as a runner finding: a failed
   ending should park the card, not re-enter the queue.

## Verification

**FAILED on criterion 9, by counting; everything else PASS.** The verifier restored the base and
each round's implementation files in scratch copies and ran the final suite against each: base
→ 72 of 74 new-or-changed tests fail (the two passes named above); round 1's implementation →
13 fail (the record's 8 plus round 3's 5); round 2's → exactly the 5 named. The loop test
received **14** against round 2 (13 in the implementer's run; the count is timing-dependent —
see *Red, then green (round 3)*). The shared predicate was executed over U+0000–U+01FF; every
CLI write site was enumerated (`fail`, `VERSION`, `usage()`, `out`, `warn`, `safe`/`safeJson`);
`postingCore` was traced to every runner write but `setRefs`.

What was unmet: criterion 9, amended in `40aa846` to name the two `cli.test.ts` assertions 6a
changed, still said "no other existing assertion changes" — and against `2f6129d` the diff
removed **four** `expect` lines at three sites: three in `cli.test.ts` (`toContain(body)` in
"show prints the card…", and `toContain(fromStdin)` and `toContain(fromFile)` in "body replaces
the body from stdin or a file…", which asserted both fixtures), plus `playbooks.test.ts`'s pin,
required by 8c and committed in `2f6129d` *before* the amendment that missed it. Corrected by
the orchestrator: the spec now names all four, at those three sites, and says the count is what
checks it. Two record gaps were corrected in the same pass: the stale "69/68" figure above, and
this section, which the record lacked. The code was not touched after `2f6129d` except for the
pin below.

A second narrow re-verification then failed on two things: the loop count, quoted as two
different numbers in two places with nothing saying why, and the pin's adjacency — the split
`playbooks.test.ts` pin was mutation-tested by moving `Do not allocate a new number` into an
unrelated appendix of `code.md`, and it still passed. Both are fixed below.

## Fix after verification — the pin restored, the counts corrected

`playbooks.test.ts`'s "reuses the recorded spec path" pin is one contiguous `toContain` again,
over the sentence 8c amended: from `**overwrite that path** from the card's body` through the
`--json`/`.body` clause to `Do not allocate a new number`. Splitting it either side of the
inserted clause left the second half free-floating — the 8c test pins the `--json` clause to the
first half, and nothing pinned the prohibition to the sentence at all.

Red first, the verifier's way, in a scratch copy of the tree with `Do not allocate a new number`
moved out of §5 and into an appendix:

- with the split pin as committed in `2f6129d`: **16 pass, 0 fail** — the hole, reproduced.
- with the contiguous pin: **15 pass, 1 fail**, `expect(received).toContain(expected)` naming
  the whole sentence.
- with the contiguous pin against `code.md` as it is: **16 pass, 0 fail**.

The two count corrections are made above, at the place each number appears.

**And restoring the pin moves criterion 9's own count back to three.** The contiguous pin leaves
that test's `expect(unwrapped(loadPlaybooks().code)).toContain(` line exactly as base wrote it
and changes only the string literal inside it, so the removal disappears along with the
weakening that caused it. Measured, both ways:

```
git diff 63011e8 -- '*.test.ts' | grep -c '^-.*expect('   # 3, as committed here
git diff 63011e8 2f6129d -- '*.test.ts' | grep -c '^-.*expect('   # 4, with the split pin
```

The three are `cli.test.ts`'s, all from criterion 6a. Three *sites* are still touched, as
criterion 9 says, and `playbooks.test.ts` is still one of them — its pinned text changed. So
criterion 9's "**four** removed `expect` lines" was written against the split pin and now reads
one too many: the spec needs the number put back to three, or the sentence rephrased to count
changed assertions rather than removed lines. Flagged rather than implemented around; nothing
in the code depends on it.
