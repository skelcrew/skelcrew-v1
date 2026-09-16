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
   arithmetic. The kept text is cleared at every boundary a turn can end on — a `tool_result`, a
   member's comment reaching the agent, and this run's own question being answered — so a
   sentence from an earlier turn is not attached to a later ask. *(Corrected in review round 1:
   this said "cleared when a `result` arrives and when this run's own question is answered", and
   the `tool_result` boundary was missing, which is the Critical finding below.)*
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
- **When a turn ends.** The stream does carry turn markers, and the kept text is cleared on each
  of them: a `tool_result` (the agent's tool came back, so what it says next it says in a new
  turn), a member's comment reaching the agent as a new user message, and this run's own question
  being answered. Criterion 4's governing sentence is the general one — "a text event in an
  earlier turn is not attached" — and the two boundaries it names in brackets are examples of it,
  not the whole of it. An ask copies the text when the call is made rather than when the question
  is raised, so a queued ask keeps the sentence from its own turn even if it reaches the card
  later. *(Corrected in review round 1: this said "the stream carries no turn marker, so the kept
  text is cleared on a `result` and on this run's own question being answered — the two
  boundaries criterion 4 names". `tool_result` is a turn marker, the loop already receives it,
  and reading criterion 4 as naming only two boundaries is what let the defect through.)*

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

Nothing, after review round 1: every reset has a case in `run.test.ts`. *(Corrected in review
round 1: this section said the reset on a `result` was implemented and unreachable from a test.
That reset was indeed unreachable — the loop breaks as soon as a `result` arrives, so no ask can
be raised after one, and an ask made after the abort is settled by `over` with no question at
all — which is why it is now gone rather than untested. The boundaries that a test can see, and
does, are the three the run has: `tool_result`, a member's comment, and the owner's answer.)*

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

## Review round 1

Verdict: one Critical, one Important, two Minor. The Critical and the Important are fixed here,
one Minor is fixed here, and the last Minor goes to MILESTONES as the reviewer asked. The spec is
unchanged this round: its *Implementation approach* already says the kept text is reset "when a
`result` arrives or a new turn begins", and criterion 4 already says a text event in an earlier
turn is not attached — the first round read the bracketed examples as the whole rule, which is
the defect.

- **Critical — a sentence from an earlier turn was attached to a later turn's question.**
  `turnText` was reset in two places only: `case "result"` (unreachable — the loop breaks on a
  `result`) and `answered`. Nothing reset it when a turn ended on a tool coming back, which is
  the common shape after this spec: the playbooks now push reads onto `Read`, `Glob` and `Grep`,
  so a turn ends on a `tool_result` with no owner answer to clear anything. Red first, in
  `run.test.ts`, on the reviewer's own script — text, `tool_use` `Read`, `tool_result`, then an
  ask with no text of its own:

  ```
  expect(core.getCard(card.id).attention?.note).toBe(
  @@ -1,3 +1,3 @@
    "allow Bash? (skelcrew resolve 1 -m allow | skelcrew resolve 1 -m deny)
  + why: TURN ONE: reading CLAUDE.md to find the check command.
    input:
  (fail) a reason written before a tool result is not attached to the next turn's question
  ```

  A member's comment is the other unhandled boundary — it reaches the agent as a new user
  message, exactly as the owner's answer does — so it gets a case of its own, red first on the
  same shape:

  ```
  expect(note).not.toContain("why:");
  Expected to not contain: "why:"
  Received: "allow Bash? (skelcrew resolve 1 -m allow | skelcrew resolve 1 -m deny)\nwhy:
  Reading the manifests to see how the packages are laid out.\ninput:\n> sed -n 1,60p
  package.json"
  (fail) a reason written before a member's comment is not attached to the next question
  ```

  Green from two lines: `turnText = undefined` under `case "tool_result"` in the event loop, and
  the same in `flushHeld` when it forwards at least one comment. The `case "result"` reset is
  **removed** rather than kept: it was dead before this round and is dead after it — the loop
  breaks on a `result`, and a call made after that is settled by `over` with no question raised —
  and `turnText`'s doc now names the three live boundaries and says why a `result` needs none.
  No existing assertion changed; the two new cases are additions.

- **Important — the record asserted criterion 4 was met, and gave a false reason.** Both
  sentences are corrected in place above, each marked as corrected: the steps list (step 3) now
  names the three boundaries, and "When a turn ends" no longer claims the stream carries no turn
  marker — `tool_result` is one, and the loop was already receiving it and ignoring it. The
  "What is not covered by a test" section went with them: it described the `result` reset as
  implemented-but-unreachable, and that reset is gone.

- **Minor — two questions raised in one turn share one sentence.** Reproduced by the reviewer:
  one text turn followed by two parallel `canUseTool` calls puts the same sentence on both
  questions, beside two different commands. No change here — the spec asks for the agent's last
  text turn and this is that — and it goes to `docs/MILESTONES.md` as the orchestrator's at
  landing. Recorded here so it is not lost.

- **Minor — the playbook paragraphs omitted `gh`.** `code.md` and `review.md` both said the shell
  is for "this repository's own checks, git, and the `skelcrew` CLI" while both lists pre-allow
  the `gh pr` verbs and both playbooks instruct them. Both now read "this repository's own
  checks, git, gh, and the `skelcrew` CLI". Unbackticked, like `git` beside it: a bare backticked
  `gh` span would be harvested by `commandsNamed` (and dropped by `instructedCommands` as an
  argument-less noun), which would move a recorded list for no gain. `spec.md` is left alone —
  the finding names the two playbooks whose lists carry `gh`. The pinned head of the paragraph
  ends at "cannot do", so the pin is untouched and `playbooks.test.ts` needed no change.

Checks for this round: `bun run fix` (no fixes applied), `bun run check` — `biome ci .` clean
over 90 files, `tsc` clean in all three packages, `757 pass / 0 fail` across 29 files (755 before
this round; +2 question cases) — and `bun run check:harness`, exit 0, "every one of the 71
commands under test runs unprompted in the harness under its own list, `git push origin
HEAD:main` is denied under each list, and the repository is unchanged": the same 71, with 71
`ran` lines in its output. `instructedCommands` after the playbook edit is **spec 6, code 25,
review 12** with the same command lists as the first round, and `commandsNamed` is unchanged too
(spec 11, code 47, review 21), which is what an unbackticked word in prose has to mean.
