# 031 — The arrow keys move the cursor

Milestone 031 in `docs/MILESTONES.md`. Asked for by the owner on 2026-09-16, the first day of
using the screen: `Up` and `Down` beside `k` and `j`. This spec grants nothing: it reads two
more key sequences and maps them onto moves the screen already makes.

## Goal

The owner moves through the rows with the arrow keys as well as with `j` and `k`. 026 put
arrow-key navigation out of scope by decision, and its design choice "no navigation that
*needs* the arrow keys" still stands: `j`/`k` keep working everywhere, and nothing is reachable
by arrows alone. What changes is that a hand already on the arrows does not have to move.

## Current behavior

- `packages/cli/src/board/board.ts` `keysOf(chunk)`: a chunk that opens with the escape
  character and carries more bytes is a sequence — an arrow key, a mouse report — and yields no
  key at all, by 026's decision; the escape character alone is `escape`. `Up` arrives as
  `\x1b[A` and `Down` as `\x1b[B` (or `\x1bOA`/`\x1bOB` from a terminal in application cursor
  mode, which this screen never turns on but a multiplexer may), so today both are dropped.
- `packages/cli/src/board/keys.ts` `press(state, key)`: `j` and `k` move the cursor on the
  board and scroll the card view; the help screen lists them. 027's prompt takes printable
  characters and Backspace only, and closes on `Enter` or `Esc`.
- `docs/specs/026-the-board-on-one-screen.md` *Out of scope*: "Mouse support, arrow-key
  navigation, resizable panes. By decision." `keys.test.ts` pins that every other key yields
  the same state and no action; an escape sequence never reaches the reducer.

## Desired behavior

`Down` does what `j` does and `Up` what `k` does, on the board and in the card view. In the
prompt both do nothing, and neither becomes text. `?` lists them beside `j`/`k`. Every other
escape sequence is still dropped, and the escape character alone is still `Esc`. Nothing else
about the keys changes; `Left`, `Right`, `Page Up`, `Home` and the rest stay uninterpreted.

## Implementation approach

`keysOf` recognises exactly four sequences — `\x1b[A`, `\x1b[B`, `\x1bOA`, `\x1bOB` — as the
keys `up` and `down`, and keeps dropping any other chunk that opens with the escape character.
`press` treats `up` as `k` and `down` as `j`, so the reducer gains no second path; the prompt's
branch, which already ignores keys longer than one character, ignores them too. The help frame
gains the two names. `ansi.ts` stays the only file that spells the escape character; the
sequences are named there beside `ESCAPE_KEY`, and 015's tripwire, which pins the exact control
characters that file may spell, needs no change because no new control character is spelled.

Decisions resolved from the repository: the mapping lives in the key decoder, not the reducer,
so `keys.test.ts`'s pure cases keep pressing named keys; a chunk that is an arrow sequence
followed by more bytes (a fast repeat delivered as one read) is decoded sequence by sequence,
since the terminal sends each press as its own three bytes and a read can join them.

## Acceptance criteria

1. `bun run check` passes; no test opens a real terminal.
2. Decoding `\x1b[B` yields `down`, `\x1b[A` yields `up`, `\x1bOB` and `\x1bOA` the same, the
   escape character alone yields `escape`, `\x1b[C` (Right) and `\x1b[5~` (Page Up) yield
   nothing, and `\x1b[B\x1b[B` in one chunk yields `down` twice.
3. `press` on `down` and `up` yields the state `j` and `k` yield, on the board and in the card
   view, including at the ends of the list.
4. With the prompt open, `down` and `up` yield the same state: the text is unchanged and the
   prompt stays open.
5. Driving the loop with the chunk `\x1b[B` moves the cursor one row down, asserted on the
   frame written to the fake stdout.
6. The help frame names `↑`/`↓` beside `j`/`k`.
7. `docs/MILESTONES.md` marks 031 landed at landing.

## Tests

- Criterion 2 as a pure test over the decoder (exported for the test, or tested through the
  loop's key path in `board.test.ts`).
- Criteria 3, 4 and 6 in `keys.test.ts` and `frame.test.ts`, extending 026's and 027's cases.
- Criterion 5 in `board.test.ts` with the injected stdin and stdout.
- 026's "every other key yields the same state" case unchanged.

## Out of scope

- **`Left`, `Right`, `Page Up`/`Page Down`, `Home`/`End`**, and any cursor movement inside the
  prompt's text.
- **Mouse support**, and application cursor mode being turned on by the screen.
- **Any other key or binding.** 026's decisions stand.
