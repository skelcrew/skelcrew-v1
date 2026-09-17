# 032 — A card is added, started and archived from the screen

Run record. Spec: `docs/specs/032-a-card-is-added-started-and-archived-from-the-screen.md`.

## Plan

1. `state.ts`: `Prompt` gains `{ kind: "add"; text }` and `{ kind: "archive"; cardId }`;
   `apply` closes the card view when the open card is archived.
2. `keys.ts`: `Action` gains `add` and `archive`; `act` gains `s` and `x`; `pressBoard` gains
   `n`; `pressPrompt` answers the `archive` prompt with Enter and Esc only, and an empty `add`
   title sends nothing and says so; `sent` grows the two cases. `s` reads the next phase from
   `PHASES` and stops at Code, with one sentence per phase it does not move.
3. `board.ts`: `perform` makes `createCard` and `archiveCard`, and returns the sentence the
   status line shows for a filed card.
4. `frame.ts`: the `add` prompt's label, the `archive` prompt as its question, three more
   lines in `KEYS`.
5. Tests, red first: `keys.test.ts` (criteria 2, 3, 4), `frame.test.ts` (criterion 8),
   `board.test.ts` (criteria 5, 6, 7).
6. `bun run check`.

Files expected to touch: `packages/cli/src/board/state.ts`, `keys.ts`, `board.ts`, `frame.ts`
and their four test files, plus this run record.

## Decisions the spec left open

- **An empty title closes the prompt** and puts "a card needs a title" on the status line.
  The prompt covers the status line while it is open (026), so a message written with the
  prompt still open would not be read.
- **The `archive` prompt draws no caret**, because it takes no text; the question itself is
  the whole line, and the card's title is cut rather than the instruction after it.
- **`s` on a card the board does not have** says so rather than doing nothing silently. The
  only rows are cards, so this is the queue row of a card the board is missing.
- **`docs/MILESTONES.md` is not marked here.** Criterion 10 says "at landing", and the row is
  updated when the pull request merges — 027's implementation commit did not touch the file
  either.

## Red, then green

`bun test packages/cli/src/board/keys.test.ts`, before `keys.ts` had the three keys — each
failed because the key left the state exactly as it was:

- `n`: `expect(opened.state.prompt).toEqual({ kind: "add", text: "" })` → received `null`.
- `s`: `expect(started.action).toEqual({ kind: "move", id: 7, phase: "spec" })` → received
  `undefined`.
- `x`: `expect(opened.state.prompt).toEqual({ kind: "archive", cardId: 7 })` → received `null`.

`bun test packages/cli/src/board/frame.test.ts`, before `frame.ts` knew the two prompts:

- the `add` prompt's line was `"undefineda new card "` — `promptLabel` had no case for it.
- the keys screen: no line starting with `n`.

`bun test packages/cli/src/board/board.test.ts`, before `perform` made the two calls:

- the table test: `screenCalls(["n", ..."a new card", "\r"])` gave `[]` where `add "a new card"`
  gives `[["createCard", { title: "a new card" }]]`.
- `n` through the loop: timed out waiting for the status line.
- `x` through the loop: timed out waiting for the call.

And the card view closing on the archive of the open card, asserted separately by taking the
one line back out of `apply`: "timed out waiting for the board again".

**One criterion was already met.** Criterion 6 — a card filed while the screen is open appears
as a row without a restart — passed the moment its test was written. 026's `onEvent` already
reads back any card an event names that the board does not have and inserts it in id order, so
`card_created` needs nothing in `apply`; the spec's "Current behavior" bullet is out of date
rather than the code. The test is kept as the guard for it, and `apply` is unchanged for that
event: the event carries only a title, so the card has to be read whole either way.

Test count: 879 before, 885 after (three in `keys.test.ts`, three in `board.test.ts`;
`frame.test.ts` gained assertions inside two existing tests).

## Checks run

- `bun install` — 20 packages.
- `bun test` before any change — 879 pass, 0 fail.
- `bun run check` — Biome (104 files), `tsc` for all three packages, `bun test`: 885 pass,
  0 fail. `bun run fix` was run once for Biome's formatting of a new block in `board.test.ts`.
- `bun run check:harness` was **not** run: it spawns the pinned coding agent and covers the
  playbooks and the runner's allowlist, and this spec changes neither.

## Fix round 1

Review round 1 found one must-fix and three minor ones. The must-fix was the history itself:
one 472-line commit carried three independent keys, against CLAUDE.md's rule that a commit is
a vertical slice passing `bun run check` on its own. The branch was unpushed, so it was re-cut
from `00e8566` into four commits, each of which was checked before it was made:

| Commit | What | `bun run check` |
| --- | --- | --- |
| `776e734` | The spec's two amendments and this run record | 879 pass, 0 fail |
| `ed8dc8b` | `s` starts the selected card | 880 pass, 0 fail |
| `c7377df` | `n` files a card by title | 883 pass, 0 fail |
| this one | `x` archives after a question | 886 pass, 0 fail |

The three minor findings, all landed in the slice they belong to:

- **`s` had no coverage above the reducer** (in `ed8dc8b`). The table test's fixture held one
  card in Code, where `s` does nothing, so no row pressed it. The fixture gained a card in
  Idea, and the table a row: `G` then `s` sends exactly what `mv 4 spec` sends.
- **`STAYS` was a partial record** (in `ed8dc8b`), so a sixth phase would have got a silent
  `s`-move. It is now `Record<Phase, ((id: string) => string) | null>` with `idea: null` and
  `spec: null` named, so a new phase is a compile error.
- **The archive question emptied if the card left the board under it** (in this commit).
  `archiveQuestion` looked the title up in `state.cards`, so a card archived by someone else
  while the question was open left the line reading `archive #1 ? …` over a call the daemon
  would refuse. The title is now taken into the prompt when the question opens, and `apply`
  closes that question when its card leaves `state.cards` on `card_archived`. Red first, all
  three failing for the intended reason: `expect(opened.state.prompt).toEqual({ kind:
  "archive", cardId: 7, title: "asking" })` received the prompt without a title; the frame
  gave `"archive #1 ? Enter archives, Esc keeps it"` where `"archive #1 gone? …"` was
  expected; and through the loop, "timed out waiting for the question gone". Only the
  `archive` prompt is closed this way — the other prompts' same shape is 027's and pre-existing,
  and the review said to leave it.

Test count: 879 before the branch, 886 after. Two daemon tests — `process.test.ts`'s sweep
tests — timed out once each under a full `check` mid-round and passed on every other run,
including in isolation; nothing on this branch touches `packages/daemon`.
