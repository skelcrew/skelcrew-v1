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
