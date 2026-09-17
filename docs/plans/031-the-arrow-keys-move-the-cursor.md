# 031 — The arrow keys move the cursor

Run record. Spec: `docs/specs/031-the-arrow-keys-move-the-cursor.md`.

## Plan

1. `ansi.ts` names the four sequences beside `ESCAPE_KEY`, built from the `ESC` constant it
   already spells, so 015's tripwire sees no new control character.
2. `board.ts`'s `keysOf` decodes a chunk that opens with the escape character sequence by
   sequence: a known arrow sequence yields `up` or `down` and the decoder carries on with what
   follows; the escape character alone is still `escape`; any other sequence is still dropped.
3. `keys.ts`'s `press` reads `down` as `j` and `up` as `k` after the Ctrl-C and prompt
   branches, so the reducer gains no second path and the prompt keeps ignoring them.
4. `frame.ts`'s help list names `↑`/`↓` beside `j`/`k`.
5. Tests, red first:
   - `board.test.ts` (criterion 2): the decoder as a table — `keysOf` exported for it, which
     the spec's Tests section allows.
   - `board.test.ts` (criterion 5): the loop with the injected stdin and stdout; `\x1b[B`
     moves the cursor one row down, asserted on the frame's reverse-video row.
   - `keys.test.ts` (criteria 3 and 4): `press` on `down`/`up` equals `press` on `j`/`k`, on
     the board and in the card view, at both ends; with the prompt open both change nothing.
   - `frame.test.ts` (criterion 6): the keys screen names `↑` and `↓` beside `j, k`.
6. `bun run check`.

Files expected to touch: `packages/cli/src/board/ansi.ts`, `packages/cli/src/board/board.ts`,
`packages/cli/src/board/keys.ts`, `packages/cli/src/board/frame.ts`,
`packages/cli/src/board/board.test.ts`, `packages/cli/src/board/keys.test.ts`,
`packages/cli/src/board/frame.test.ts`, this run record.

## Decisions the spec left open

- **`keysOf` is exported for its test**, the first of the two ways the spec's Tests section
  offers. Criterion 2 lists cases — `\x1b[C` and `\x1b[5~` yielding *nothing* — that the loop
  can only show as an absence of movement, which would pass just as well if the bytes were
  decoded as stray printable characters. The table says exactly what each chunk decodes to.
  The loop still carries criterion 5 end to end.
- **A sequence the decoder does not know still drops the rest of the chunk**, as today: only
  the four named sequences advance the decoder. `\x1b[B\x1b[C` is `down` and then nothing.
- **The help list's description column moves four cells right**, because `  j, k, ↓, ↑` is
  four cells wider than `  j, k` and every line of that list is aligned to one column.

## Red, then green

The four new cases failed first, each for its own reason (`bun test packages/cli/src/board/`):

- the decoder table: `keysOf("\x1b[B")` gave `[]`, expected `["down"]`.
- `press` on `down`: cursor 0, where `j` gives 1.
- the keys screen: the line was `  j, k     down and up; in a card, scroll`, with no `↑`.
- the loop: the cursor never moved on the frame.

A fifth case — the prompt ignoring `down` and `up` — was green from the start, because the
prompt branch already ignores every key longer than one character. It is kept as the guard
that the mapping stays below that branch: removing the two lines of `moving` leaves it green,
but moving the mapping above the prompt would fail it.

The 015 tripwire caught the first implementation: a doc comment in `board.ts` spelled the
escape sequence, and `ansi.ts` is the only file allowed to. The comment now names it in words.

## Checks run

- `bun test packages/cli/src/board/ packages/shared/src/text.test.ts` — 53 pass, 0 fail.
- `bun run fix` — Biome reformatted one array in `keys.test.ts`.
- `bun test packages/cli packages/shared` — 148 pass, 0 fail, in 11 seconds.
- `bun run check` — **not green on this machine.** `bun run lint` and `bun run typecheck`
  pass on every run. `bun test` fails one to four tests, a different set each time, over eight
  runs; each run took 230–1990 seconds instead of the usual few minutes.

  The cause is not the code: this laptop is on battery and enters a `Maintenance Sleep` of
  about five minutes every few minutes. `pmset -g log` records "Entering Sleep state due to
  'Maintenance Sleep' … 305 secs" again and again, and every failing test reports "this test
  timed out after 5000ms" (or 45000ms) with 304,000–314,000 ms elapsed — a five-second budget
  measured across a five-minute suspend. The failure lands on whichever test was waiting on the
  clock when the machine went down; over seven runs that was twelve different tests, all of
  them ones that spawn a daemon or wait on a lease. Neither `caffeinate -dimsu bun run check`
  nor `caffeinate -i bun run check` prevented the sleep.

  Nothing in this change is reachable from those tests: the diff is `packages/cli/src/board`
  only, and no file under `packages/daemon/src` imports the board. The three daemon files that
  failed in one full run fail the same way when run alone
  (`bun test packages/daemon/src/runner/run.test.ts packages/daemon/src/runner/allowlist.test.ts
  packages/daemon/src/server/process.test.ts`: 168 pass, 3 fail, the same ~305-second stalls),
  and `bun test packages/daemon/src/runner/contracts.test.ts` alone passed 69 of 69 in a window
  between sleeps. The tests this spec touches run in under a second and passed every time.
  `bun run check` needs one run on mains power.

## Orchestrator: stopped at the Stage 2 gate, 2026-09-17 04:31

The implementation is complete and uncommitted; the board and shared tests pass (148 of 148).
`bun run check` could not run green: the laptop is on battery with the lid closed and enters
maintenance sleeps of 89 to 997 seconds (`pmset -g log`), and every daemon test that waits on
a clock times out across one. Not a code failure, but not a passing check either, so review
and verification have not run. Resume with one green `bun run check` on mains power, then the
reviewer and the verifier.

Resumed 2026-09-17 07:51 on AC power: `caffeinate -i bun run check` → Biome clean (100
files), three packages typecheck, `bun test` 857 pass, 0 fail. Stage 2 gate met.

## Review and verification

### Review cycle 1 — CHANGES REQUESTED

Fresh reviewer; `caffeinate -i bun run check` green (857 pass), criteria 1–6 confirmed, the
new tests confirmed to bite by mutation. One Important, sent back verbatim: the decoder only
walks escape sequences while the remainder of the read starts with the escape character, so
`a` followed by Down in one read yields `a`, `[`, `B`, and with the prompt open the text
becomes `a[B` — the spec's "neither becomes text" holds for the reducer but not for the
screen, and the new `ansi.ts` comment asserts the gap away. Fix chosen: the decoder handles
the escape character wherever it occurs in a chunk (the spec cannot be amended by this run).

Minor, carried: a sequence split across two reads yields a spurious `escape` (pre-existing at
read boundaries, wider now); Down and Up close the help screen, as any key does, with no test
pinning it; criterion 7 is the owner's at landing.

### Fix round 1

Resolution (a), as directed: the decoder reads the escape character wherever it falls in a
read, not only at the start of one. The rule for a sequence with no key is unchanged — it
drops itself and the rest of that read.

Red first. Two cases, both failing for the reviewer's reason:

- the decoder table, `keysOf("a\x1b[B")` → `["a","[","B"]`, expected `["a","down"]`;
- a new loop test, "a letter and an arrow in one read leave the prompt's text as the letter":
  the prompt line on the frame read `comment on #1: a[B`.

Green after the change, which is `keysOf` walking the read by code point and taking the escape
branch at any position rather than only while the remainder opens with it. Three files:

- `board.ts` — the decoder, and its comment, which now says "wherever in the read it falls"
  and gives the reason: one read is not one key.
- `ansi.ts` — the sentence the finding named. It claimed the four sequences are "the only ones
  the screen reads; every other one it is sent is dropped", which execution falsified for a
  sequence after a character. It now reads: the only sequences the screen has a key for,
  wherever in a read they arrive, and a sequence it has no key for is dropped with the rest of
  that read.
- `board.test.ts` — four decoder cases (`a` then Down; Down, `a`, Down; `a` then Left; `a`
  then a bare escape character) and the loop test above.

One decision inside the fix worth a reviewer's eye: **a bare escape character at the end of a
read is now `escape` wherever it falls**, where before it was `escape` only when it was the
whole read and dropped when anything preceded it. That is the same rule the decoder already
applied at a read boundary, made uniform rather than positional, and the table pins it
(`"a\x1b"` → `["a","escape"]`). It touches the Minor finding about split sequences: a sequence
split as `a` + escape character, then `[B`, now cancels the prompt instead of typing `[B` into
it. Both outcomes are wrong and both were already reachable — a read of just the escape
character has always cancelled the prompt — so this widens no behaviour that a read boundary
did not already produce.

Checks: `bun test packages/cli/src/board/ packages/shared/src/text.test.ts` — 54 pass, 0 fail.
`bun run lint` — clean. `caffeinate -i bun run check` — **858 pass, 0 fail, exit 0, 87
seconds** on AC power.

### Review cycle 2 — APPROVED

Fresh reviewer over the whole diff. `caffeinate -i bun run check` green (858 pass). The
decoder probed on 26 chunks; four mutations (drop `moving`; decode only at the start of a
read; drop the arrows from the help list; map Down to `G`) each fail their tests. No Critical,
no Important.

Minor, carried: a trailing escape character after other keys now cancels the prompt where it
was swallowed before (spec silent; keeping it makes a real Esc work when it coalesces with a
keystroke); an unknown sequence drops the real keys after it in the same read (the spec's
rule); Down and Up close the help screen with no test naming them; criterion 7 at landing;
the change lands as one or two slices per the AGENTS.md rule.

### Verification — VERIFIED

`caffeinate -i bun run check`, twice: Biome clean (100 files), three packages typecheck,
`bun test` 858 pass, 0 fail. `check:harness` not run (no playbook or allowlist change); no
build step configured. Criteria 1–6 established by execution, including the decoder run
directly on the eight spec cases and on out-of-scope keys, and red-first re-established by
rebuilding the base in a scratch copy: five new cases fail at base, the prompt case is green
at base as the record says. Test count 587 → 593, none removed or weakened; `packages/shared`
has zero changed lines. Criterion 7 deferred to landing by the owner's instruction.
