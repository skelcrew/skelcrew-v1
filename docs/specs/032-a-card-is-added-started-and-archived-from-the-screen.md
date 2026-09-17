# 032 — A card is added, started and archived from the screen

Milestone 032 in `docs/MILESTONES.md`, "The rest of a day on the screen", first slice. The
milestone lists five things the owner still leaves the screen for; this spec takes the three
that are one key and one call each — add a card, start it, archive it — and leaves editing a
card in `$EDITOR` and the live feed as a view for the specs after it, because those two each
bring a new mechanism (a second child process like 027's `o`; a third view) and this one brings
none. It grants nothing: every key is a call the CLI already makes for the owner.

## Goal

The owner's most frequent gesture is starting a card: an Idea into Spec, an approved Spec into
Code. After 027 the screen answers questions but cannot make that move, because `m` takes only
the move a request offers and an Idea card has no request; the owner leaves the screen to type
`skelcrew mv 3 spec`. The same for filing a card and for archiving a finished one. After this
spec `n` files a card by title, `s` starts the selected card, and `x` archives it after a
confirmation, so a card's whole life — filed, started, answered, started again, merged,
archived — happens on one screen. And a card that appears while the screen is open, filed from
the screen or from a terminal, appears in the board without a restart, which today it does not.

## Current behavior

- `packages/cli/src/board/keys.ts`: `press(state, key)` yields an `Action` of kind `quit`,
  `resolve`, `move`, `comment` or `open-shell`; `act` maps `a`/`d`/`m`/`b`/`c`/`o` on the
  selected card, on the board and in the card view; `pressPrompt` gives the prompt every key
  while it is open. `m` sends `question.moves[0]`; `b` sends `previousPhase`. There is no
  forward move without a request.
- `packages/cli/src/board/state.ts`: `Prompt` is `deny` | `back` | `comment`, each with a
  `cardId` and `text`. `apply(state, event)` handles `comment`, `card_moved`, `claimed`,
  `released`, `run_interrupted`, `attention_requested`, `attention_resolved` and
  `card_archived` — and not `card_created` (`packages/shared/src/types.ts:103`). (The spec as
  approved concluded "so a card filed while the screen is open is not in `state.cards` until
  the screen is reopened". That was false: `board.ts`'s `onEvent` reads back any card an event
  names that the board lacks and inserts it in id order, 026's design, so a new card already
  appears. The orchestrator corrected it during development, when the implementer found the
  guard test green before writing anything — the third "today" sentence in as many specs
  written without running the code, against the rule 026's landing recorded.)
- `packages/cli/src/board/board.ts:84`, `perform`: makes the call for `resolve`, `move` and
  `comment`; `open-shell` is handled in the loop.
- `packages/cli/src/board/frame.ts:248`, `helpFrame`, lists the keys from a `KEYS` table.
- The CLI commands the keys would mirror: `add <title>` (`packages/cli/src/commands/add.ts`,
  `createCard { title }`), `mv <id> <phase>` (`moveCard`), `archive <id>` (`archiveCard`).
- `packages/daemon/src/core/core.ts:621`, `moveCard`: a human may move a card out of any phase;
  `phases.ts` orders them Idea, Spec, Code, PR, Done. `archiveCard` (`core.ts:725`) sets
  `archived_at`; there is no unarchive, and an archived card refuses every later mutation
  (`core.ts:415`).
- Keys in use after 027 and 031: `j` `k` `g` `G` `Up` `Down` `Enter` `Esc` `?` `q` `a` `d` `m`
  `b` `c` `o` `Ctrl-C`. `n`, `s` and `x` are free.

## Desired behavior

**`n` files a card.** On the board, `n` opens the prompt for a title; `Enter` sends
`add <title>` and the status line says `#<id> <title> added`; `Esc` cancels. An empty title
sends nothing and the status line says a card needs a title. The new card appears as a board
row in id order as soon as its event arrives, whether it was filed from the screen or from a
terminal. The cursor does not move.

**`s` starts the selected card.** On the board and in the card view, on the selected card:

| Card's phase | `s` does | The CLI call |
| --- | --- | --- |
| Idea | moves it to Spec | `mv <id> spec` |
| Spec | moves it to Code | `mv <id> code` |
| Code | nothing; the status line says the run moves it to PR when the pull request exists | none |
| PR | nothing; the status line says to merge the pull request, and the daemon moves it to Done | none |
| Done | nothing; the status line says it is done | none |

`s` sends no message: it is the owner's approval, and the card's body is the artefact being
approved. Feedback with a move is `b`, as 027 made it.

**`x` archives the selected card, after a confirmation.** On the board and in the card view,
`x` opens the prompt as a question — `archive #<id> <title>? Enter archives, Esc keeps it` —
that takes no text: `Enter` sends `archive <id>`, `Esc` cancels, every other key leaves it as
it is. A confirmation, because there is no unarchive, and because the prompt is the screen's
one place for a question. The archived card leaves the board on its event, as 026 already
does for `card_archived`; if it was the open card, the card view closes to the board.

**A refused call says so**, on the status line, as 027 does for every call.

**The keys are listed.** `?` shows `n`, `s` and `x` beside the others.

**Nothing else changes.** `m` still takes only the offered move; `b` is still the way back.

## Implementation approach

`keys.ts`: `Action` gains `{ kind: "add"; title: string }` and `{ kind: "archive"; id: number }`;
`s` yields the existing `move` action with the next phase, or a status message. `act` gains
`s` and `x`; `pressBoard` gains `n`. `Prompt` in `state.ts` gains `{ kind: "add"; text }` and
`{ kind: "archive"; cardId }`; `pressPrompt` sends `add` on Enter (or a status message when
empty) and, for `archive`, accepts only Enter and Esc. `sent` grows two cases. The next phase
for `s` comes from `PHASES` in `@skelcrew/shared`, the way `previousPhase` does, and stops at
Code: the phases whose exit belongs to a run or the daemon are not the owner's to force from a
key, and each gets its sentence. `perform` in `board.ts` makes `createCard` and `archiveCard`,
and puts `#<id> <title> added` on the status line from `createCard`'s result. A new card
reaches the board through the loop's existing read-back of any card an event names (see the
correction above); no `apply` change is needed, and criterion 6's test is the guard that it
stays so. `frame.ts` renders the `add` prompt with a label and the `archive` prompt as its
question; `KEYS` gains three lines.

Decisions resolved from the repository: a confirmation for `x`, because 026 made the prompt the
one place a question is asked and `archiveCard` cannot be undone; no confirmation for `s`,
because a move is reversible with `b` and 027 made moves one key; `n` on the board only,
because the card view is one card and filing another there has no row to land on; `s` stops
at Code, because CLAUDE.md says a phase ends in an artefact the runner verifies, and forcing
Code into PR from a key would skip the contract. (The approved text ended "the `card_created`
gap is fixed here because `n` is unusable without it"; there was no gap.)

## Acceptance criteria

1. `bun run check` passes; no test opens a real terminal, spawns a real coding agent or calls a
   model.
2. `press` on `n` on the board opens an `add` prompt; `Enter` with text yields `{ kind: "add",
   title }`; `Enter` with empty text yields no action and a status message; `Esc` yields none.
   `n` in the card view yields the unchanged state.
3. `press` on `s` yields `{ kind: "move", id, phase: "spec" }` on an Idea card and
   `{ kind: "move", id, phase: "code" }` on a Spec card, with no message; on a Code, PR and
   Done card it yields no action and the status sentence the table gives, each distinct.
   Asserted on the board and in the card view.
4. `press` on `x` opens an `archive` prompt for the selected card; `Enter` yields
   `{ kind: "archive", id }`; `Esc` yields none; a printable key in that prompt leaves the
   state unchanged.
5. Every action the reducer yields corresponds to exactly one of `createCard`, `moveCard` and
   `archiveCard` with the parameters `add`, `mv` and `archive` would send; the table test 027
   added (its criterion 6) gains the two new rows.
6. `apply` on a `card_created` event for a card not in `state.cards` results in the next frame
   showing that card's row in id order; asserted through the loop with a fake client whose
   `getCard` answers for the new id.
7. Through the loop with a fake client: `n`, a title, `Enter` calls `createCard` with that
   title and the status line shows `#<id> <title> added`; `x`, `Enter` calls `archiveCard` and,
   when the archived card was the open card, the view returns to the board; a refused
   `createCard` puts the daemon's message on the status line.
8. The help view lists `n`, `s` and `x`.
9. No 026 or 027 test is weakened or removed; existing tests may gain assertions for the new
   prompts and keys, and an inert-key list may swap a letter that is now bound for one that is
   not. (The approved text said "pass unchanged except the table"; two 027 frame tests gained
   assertions, which is the right place for them. Corrected by the orchestrator after review
   round 1.)
10. `docs/MILESTONES.md` marks 032 landed at landing.

## Tests

- Criteria 2–5 and 8 in `keys.test.ts` and `frame.test.ts`, pure, extending 027's.
- Criteria 6 and 7 in `board.test.ts` with the injected streams and fake client 027 uses.
- Red first: criteria 2, 3, 4 and 6 fail on today's code because the key leaves the state
  unchanged or the card never appears.

## Out of scope

- **Editing a card's title or body from the screen.** The body is a spec; the shape is "open
  it in `$EDITOR`", a second child process like 027's `o`, and the next spec of this milestone.
- **The live feed as a view.** A third view; the spec after that.
- **Forcing a card from Code into PR or from PR into Done.** The runner's contract and the
  merge poll own those moves.
- **Filing a card with a body from the screen.** `add --body` stays a terminal command; a body
  is a spec, and the screen's prompt is one line.
- **Unarchive.** Does not exist anywhere; not this spec's to add.
- **Filters, search, a cost line.** The milestone says why.
