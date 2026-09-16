# 022 — A run explores without asking

Run record for `docs/specs/022-a-run-explores-without-asking.md`.

## The change, in steps

1. **The three playbooks** — one contiguous paragraph in each, where the playbook already says
   what runs unprompted (`code.md` and `review.md` after *Past the list above…*; `spec.md` has
   no such section, so the paragraph opens §1). It names `Read`, `Glob` and `Grep` as the way to
   read, the shell as the way to run — one command at a time, never joined with `&&`, `;` or a
   pipe and never a loop — and asks for one sentence saying what a command that will stop to ask
   is for. Prose only: no fence, and no backticked span starting with a command word, so
   `instructedCommands` harvests nothing new.
2. **`playbooks.test.ts`** — the paragraph pinned in all three, the way `CREDENTIAL_RULE` is: a
   shared head and a shared tail, asserted to be in the *same* paragraph, plus the three tool
   names and the two rules criterion 2 lists.
3. **`run.ts`** — the run keeps the text of the last `text` event; an ask takes a copy of it when
   it is made; `questionFor` puts it on a `why:` line between the frame and the input, escaped,
   flattened to one line and cut to `WHY_LINE_MAX` bytes, inside the note's existing cap
   arithmetic. The kept text is cleared when a `result` arrives and when this run's own question
   is answered, so a sentence from an earlier turn is not attached to a later ask.
4. **`run.test.ts`** — criteria 3, 4 and 5 beside 013's question cases.
5. **`cli.test.ts`** — criterion 3's rendered half: a scripted driver through a real runner, and
   the note as `skelcrew queue` prints it through the real CLI.

## Files expected to change

- `packages/daemon/playbooks/spec.md`, `code.md`, `review.md`
- `packages/daemon/src/runner/playbooks.test.ts`
- `packages/daemon/src/runner/run.ts`, `run.test.ts`
- `packages/cli/src/cli.test.ts`
- this record

## What the spec left open, and how it was decided

- **Where the CLI case lives.** The spec's *Tests* section puts criteria 3–5 in `run.test.ts`
  and adds "one case through the real CLI's `queue`". `run.test.ts` has no server and never
  spawns the CLI; `cli.test.ts` is the file that spawns the real binary against a real core, so
  the rendered case goes there, with a scripted driver on a real runner.
- **`quoted` on the `why:` line.** The spec's *Implementation approach* says the line goes
  through "the same `relayed`/`quoted` treatment the input does"; its *Desired behavior* example
  renders the line as `> why: checking whether …` in the queue — one marker, the CLI's own,
  where the input line has two. The two cannot both hold. The example wins, so the line is
  `relayed` (escaped, as every relay here is) and flattened to one line rather than prefixed
  `> `: with no newline in it the agent's text cannot become a line of its own, which is what
  015's reason asks of it. Recorded here because it is a deviation from the approach's wording.
- **The budget's unit.** The approach says "200 bytes, in the shape of `INPUT_LINE_MAX`", and
  `INPUT_LINE_MAX` is used with `oneLine`, which cuts by character. `WHY_LINE_MAX` is 200 and the
  cut is made in bytes (`cutMarked` over `oneLine`'s result), so the "200 bytes" half is the
  literal one.
- **When a turn ends.** The stream carries no turn marker, so the kept text is cleared on a
  `result` and on this run's own question being answered — the two boundaries criterion 4 names.
  An ask copies the text when the call is made rather than when the question is raised, so a
  queued ask keeps the sentence from its own turn even if it reaches the card later.

## Red, then green

Tests first, in all three files.

- **`playbooks.test.ts`.** Red on the paragraph none of the three playbooks carried:

  ```
  expect([kind, paragraph.includes(READ_WITH_TOOLS)]).toEqual([kind, true]);
    "spec",
  - true,
  + false,
  (fail) every playbook says to read with Read, Glob and Grep, and to run one shell command at a time
  ```

- **`run.test.ts`.** Red on the note the question carried, which had no reason on it:

  ```
  - "allow Bash? (skelcrew resolve 1 -m allow | skelcrew resolve 1 -m deny)
  - why: Checking whether Bun can put the terminal into raw mode, which a TUI needs.
  - input:
  - > script -q /dev/null bun -e 'x'"
  + "allow Bash? (skelcrew resolve 1 -m allow | skelcrew resolve 1 -m deny)
  + input:
  + > script -q /dev/null bun -e 'x'"
  (fail) a question carries the agent's own reason for it, between the frame and the input
  ```

  and, for criterion 4, on the first question's own note (`why:` absent), and for criterion 5 on
  the cut line.

- **`cli.test.ts`.** Red on the rendered block, which was missing its `> why:` line.

Green came from `whyLine` in `run.ts`, the one interpolation in `questionFor`, the kept
`turnText` and its two resets, and the paragraph in each playbook.

## Criterion 6 — which of 013's question tests changed

**None of them.** Both tests that assert the exact note — `a tool outside the fixed list becomes
a question on the card, and the run waits for it` and `a permission question carries the tool's
input with its escape sequence escaped` — script the ask *before* any `text` event, so there is
no reason to attach and the note they assert is the note they get. Every other question case
(the two-at-a-time ordering, the forged frame, the truncation cases, `askAndAnswer`'s five
answers) is untouched for the same reason. The first of those two is also criterion 4's first
half: a question raised with no preceding text has no `why:` line, asserted as an exact string.

## What is not covered by a test

Criterion 4 names two boundaries for the kept text, and only one of them is observable. The
reset on a `result` is implemented and cannot be reached from a test: the event loop breaks out
as soon as a `result` arrives (`run.ts`, `if (result !== undefined) break;`), so no ask can be
raised after one — an ask made after the abort is settled by `over` with no question at all. The
reset that a test *can* see, and does, is the one on this run's question being answered.

## Checks

- `bun run check` — passes: `biome ci .` clean over 90 files, `tsc` clean in all three packages,
  `755 pass / 0 fail` across 29 files (749 before this spec; +1 playbook case, +4 question cases,
  +1 CLI case).
- `bun run check:harness` — passes, exit 0: "every one of the 71 commands under test runs
  unprompted in the harness under its own list, `git push origin HEAD:main` is denied under each
  list, and the repository is unchanged". 71 is the same number 021 recorded, which is criterion
  1's command-count claim.
- `instructedCommands` per playbook, before and after the edit and again after the reflow:
  **spec 6, code 25, review 12** all three times, with identical command lists — so the new
  paragraph harvests nothing. (Measured from a scratch script over `playbook-commands.ts`, the
  way 021 measured it.)
- `bun run fix` — applied formatting twice, to `run.test.ts` and then to `playbooks.test.ts`.
