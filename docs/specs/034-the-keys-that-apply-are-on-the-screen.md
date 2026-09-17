# 034 — The keys that apply are on the screen

Milestone 034 in `docs/MILESTONES.md`, asked for by the owner on first use of the screen with
032's keys: the shortcuts should be visible somewhere. The milestone settles the shape — the
keys that apply to the selected row, on the bottom line, dim, and `?` for the full list — and
this spec makes it checkable. Written against 033's spec, not its code: 033 is in development
and lands first; the implementer reads the code as landed. This spec grants nothing: it draws
text, and every key it names already exists.

## Goal

A first-time owner learns `s`, `a` and `n` from the screen itself, and a returning owner never
opens the keys list to remember which letter answers a question. Today the bottom line is empty
whenever no prompt is open and nothing has been said (`frame.ts`, `bottomLine`: `return
state.message.length === 0 ? "" : …`), and the only teaching is `?`, whose list has fifteen
lines and does not fit below eighteen rows on a screen that accepts twelve (032's carried
finding, measured by its round-2 reviewer). After this spec the bottom line names, dim, the
keys that do something on the selected row, ending in `? keys`, whenever it has nothing more
important to show; and the keys list scrolls, so no terminal the screen accepts hides a key.

## Current behavior

- `packages/cli/src/board/frame.ts`, `bottomLine`: the prompt while one is open (label plus
  text plus a reverse-video caret; the archive question has no caret), otherwise the message
  dim, otherwise the empty string. Drawn as the last line of every frame by `screenful`.
- `state.message` is set by `says` in `keys.ts` (a key that does not apply), by the loop after a
  call (`board.ts:330`, the call's own sentence or `""`; `:333`, a refusal's message; `:281`,
  `o` with no worktree), and cleared when a prompt opens (`keys.ts:43`). It is not cleared by a
  cursor move, so a sentence set by `s` on a Done card stays on the line through `j`, `k` and
  `Enter` until a prompt opens or a call completes.
- `frame.ts`, `KEYS`: fifteen lines; `helpFrame` draws a dim `keys` header, a blank line, and
  the lines, then `screenful` cuts the tail. `press` on any key in the help view returns to
  `view.from` (`keys.ts`, `press`, the `help` case).
- `keys.ts`, `act`: on the selected card, `a` and `d` apply when `questionOf` finds a question,
  `m` when it offers a move, `b` when the card is not in Idea, `s` when it is in Idea or Spec,
  `c`, `x` and `o` always; `n` on the board only; `Enter` opens the card; after 033, `Enter`
  opens the chat and `Tab` flips between chat and card. A queue row and a board row of the same
  card select the same card (`cardIdAt`).
- 033's chat view: the bottom line is the input, the line above it says who is listening.
- `MIN_COLUMNS` 60, `MIN_ROWS` 12 (`frame.ts:21-22`).

## Desired behavior

**The bottom line teaches.** When no prompt is open and there is no message to show, the bottom
line is a dim hint: the keys that do something where the cursor is, each as `<key> <verb>`,
separated by ` · `, ending in `? keys`. The hint is cut to the width by dropping items from
the end, except `? keys`, which is always present. What the hint says, by where the cursor is:

| Where | The hint, in order |
| --- | --- |
| board, a queue row (a request to the owner) | `a allow · d deny · m move` (m only when the request offers one) `· enter chat · ? keys` |
| board, a card row in Idea or Spec | `s start · enter chat · c comment · b back` (not in Idea) `· x archive · o shell · n new · ? keys` |
| board, a card row in Code, PR or Done | `enter chat · c comment · b back · x archive · o shell · n new · ? keys` |
| board, no rows | `n new · ? keys` |
| card view | `tab chat · s start` (Idea, Spec only) `· c comment · b back` (not Idea) `· x archive · o shell · j k scroll · q back · ? keys` |
| chat view (033) | no hint; the bottom line is the input |
| keys list | `j k scroll · q close` |

A card row with an open question shows the queue row's hint, since `a`, `d` and `m` apply
there too. The card view of a card with an open question puts `a allow · d deny · m move`
(m only when the request offers one) before its own items, for the same reason. (Both
"enter chat" and this sentence were amended by the orchestrator after implementation: the
spec said "enter open" from before 033 landed, and was silent on the card view with a
question open.)

**A message shows once.** A sentence set by a key or a call is shown on the frame that follows
it and on no later one: the next key returns the hint (or sets its own sentence). So `s` on a
Done card says "is done" until the owner presses anything, and then the line teaches again.

**The keys list scrolls.** In the keys view, `j`, `k`, `Down` and `Up` scroll the list a line at
a time when it does not fit; `q`, `Esc` and `?` close it; every other key still closes it, as
today. At twelve rows every key is reachable by scrolling. After 033 the list also names `Tab`
and says `Enter` opens the chat.

**Calm.** The hint is dim, one line, and never animates. It is not shown while a prompt is
open or a message is showing, so the line never has two things on it.

## Implementation approach

`frame.ts`: a pure `hint(state): string` beside `bottomLine`, tested on its own; `bottomLine`
returns the prompt, else the message, else `dim(hint)`, cut by dropping items from the end
before the last. The items come from the same facts `act` reads — `questionOf`, the card's
phase, whether the row is a queue row — so the hint and the reducer cannot disagree about what
applies; if a later spec adds a key, it adds an item next to its `act` case. `keys.ts`: `press`
clears `state.message` before dispatching, so a sentence lives one frame; `says` still sets it
in the same press. The help view gains `scroll`, kept in `View`'s `help` case, and `helpFrame`
windows the lines the way `cardFrame` does; `press`'s `help` case handles `j`/`k`/`down`/`up`
and closes on anything else. `KEYS` gains 033's two lines when 033 has landed (the implementer
checks; this spec does not add them if they are there).

Decisions resolved from the repository: a hint rather than a fixed strip, because `act` already
knows what applies and 026's "calm" rule says the screen should not name keys that do nothing
here; on the bottom line rather than a new row, because 026 fixed the layout at two halves, a
rule and one line, and the line is empty most of the time; items dropped from the end rather
than abbreviated, because 60 columns is the floor and a card row's full hint is longer than
that, so what survives must be what the owner presses most (the order in the table); the
message cleared on the next key rather than on a timer, because the screen never animates;
the keys list scrolling rather than two columns, because the lines are wider than half of 60
columns, and scrolling is the card view's mechanism already.

## Acceptance criteria

1. `bun run check` passes; no test opens a real terminal, spawns a real coding agent or calls a
   model.
2. `hint(state)` for each row of the table renders the listed items in the listed order, and
   only those: asserted for a queue row with and without an offered move, a card row in each
   of the five phases, a card row whose card has an open question, an empty board, and the
   card view in Idea and in Code. Every hint ends in `? keys`.
3. At 60 columns a card row's hint is cut by dropping items from the end and still ends in
   `? keys`; at 100 columns it is whole.
4. The bottom line is the prompt while one is open, the message on the frame after the key or
   call that set it, and the hint otherwise; asserted through `frame` for all three, and
   through the loop: `s` on a Done card shows its sentence, `j` then shows the hint.
5. The keys view at 12 rows shows the first lines, `j` scrolls until the last key line is
   visible, `k` scrolls back; `q`, `Esc` and `?` close it; another key closes it. Asserted
   through `press` and `frame`.
6. No frame contains a colour escape; the hint uses dim only.
7. 026's, 027's and 032's tests pass, except those that assert a message persisting across a
   later key, which now assert it gone after that key (say which, in the run record), and the
   ones that assert an empty bottom line where the hint now is.
8. `docs/MILESTONES.md` marks 034 landed at landing.

## Tests

- Criteria 2, 3 and 5's frame half in `frame.test.ts`, pure, in the shape of the existing
  `bottomLine` and keys-screen tests.
- Criteria 4 and 5's key half in `keys.test.ts` and `board.test.ts` with the injected streams
  and fake client.
- Red first: criteria 2, 3 and 5 fail on today's code because the line is empty and the list
  does not scroll.

## Out of scope

- **A hint in the chat view.** 033 owns that line; the listening line is its hint.
- **Rebinding or renaming any key.** The hint names what exists.
- **A fixed strip of "most used" keys**, or a footer that stays under the prompt. Rejected by
  the milestone.
- **Two-column keys list.** Scrolling instead.
- **The status column's UTF-16 padding**, carried since 024. Still open; not this spec's line.
