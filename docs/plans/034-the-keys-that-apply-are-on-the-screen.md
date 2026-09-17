# 034 — The keys that apply are on the screen

Run record. Spec: `docs/specs/034-the-keys-that-apply-are-on-the-screen.md`. Worktree
`.claude/worktrees/the-keys-that-apply-are-on-the-screen`, branch
`worktree-the-keys-that-apply-are-on-the-screen`, base `main` at `b310d5c`.

Baseline before any change: `bun test` green, **907 pass, 0 fail, 35 files**.
After: **914 pass, 0 fail, 35 files** (+7).

## The slices, planned before starting

Each is a commit that passes `bun run check` on its own; the failing test and the change that
makes it pass land together.

1. **The bottom line teaches** — `2143d9a`. `frame.ts` gains `hint(state)` beside `bottomLine`,
   which returns the prompt, else the message, else the dim hint cut to the width by dropping
   items from the end. Tests in `frame.test.ts`. (Criteria 2, 3, 6, and the frame half of 4.)
2. **A message shows once** — `5d085f0`. `press` clears `state.message` before dispatching, so
   a sentence lives one frame. Tests in `keys.test.ts` and `board.test.ts`. (The loop half of 4.)
3. **The keys list scrolls** — `7ffaf04`. `View`'s `help` case gains `scroll`, `helpFrame`
   windows the lines, `press`'s `help` case handles `j`/`k`/`Down`/`Up` and closes on anything
   else. Tests in `frame.test.ts` and `keys.test.ts`. (Criterion 5.)
4. **The run record** — this file.

`docs/MILESTONES.md` is not marked here: criterion 8 says "at landing", and landing is the
pull request merging. 027's, 032's and 033's implementation commits did not touch the file
either (033's record says so explicitly, and `b310d5c` marked 033 landed on `main` after the
merge).

## What the spec says that the code no longer does

The spec was written against 033's spec while 033 was in development. 033 has landed, so these
sentences in *Current behavior* are stale. Nothing is edited in the spec; they are recorded
here for the orchestrator. Every line number below is read at base `b310d5c`, before this
branch's own changes moved them.

- "`state.message` is set … by the loop after a call (`board.ts:330` … `:333` … `:281`)". The
  three places are `board.ts:343` (`message: said ?? ""`), `:351` (a refusal's message) and
  `:292` (`o` with no worktree).
- "cleared when a prompt opens (`keys.ts:43`)" — `opens` is `keys.ts:68-70` today, and
  `entersChat` (`keys.ts:33-35`) clears it as well (033).
- "`frame.ts`, `KEYS`: fifteen lines" — 21 lines today: sixteen key lines, a blank, and 033's
  four-line chat section. With the header and its blank line the keys screen is 23 lines, so
  it fills a 24-row terminal exactly (033's carried finding).
- "`MIN_COLUMNS` 60, `MIN_ROWS` 12 (`frame.ts:21-22`)" — the two constants are at
  `frame.ts:34-35`.
- "`KEYS` gains 033's two lines when 033 has landed (the implementer checks; this spec does not
  add them if they are there)" — they are there: `enter` says it opens the chat, and `tab`
  flips between the chat and the card. Nothing added.

## Decisions the spec left open

- **The card view's hint does not name `a`, `d` and `m`, even when the card has an open
  question.** The desired-behavior table fixes the card view's items, and the sentence that
  adds `a`/`d`/`m` says "a card row", which is the board's. Following the table literally.
- **`enter open` keeps the spec's wording** on the board, though Enter opens the chat since
  033. The table spells the item; renaming it is the spec's call, not the implementer's.
- **`hint(state)` is the whole hint; the cut belongs to the bottom line.** `hint` is pure and
  takes no width, as the spec's approach describes it; `bottomLine` drops items from the end —
  never the last one — until the line fits.
- **The chat view's `hint` is the empty string.** The chat draws its own two bottom lines and
  never calls `bottomLine`.
- **`press` clears the message once, at the top.** 033's clear inside `pressChat` became
  unreachable and is gone; the rule it stated is now the general one.

## Red, then green

**Slice 1.** The three new `frame.test.ts` tests were written against a `hint` that returned the
empty string — the signature, and nothing else, because a test that fails to import is a broken
test rather than a red one (033 did the same for `conversationLines`):

```
expect(hint(state())).toBe("a allow · d deny · m move · enter open · ? keys")
Expected: "a allow · d deny · m move · enter open · ? keys"
Received: ""
```

```
expect(bottom()).toContain(`${ESC}[2m`)   // the dim hint on the bottom line
Expected to contain: "[2m"
Received: ""
```

```
expect(Bun.stringWidth(whole)).toBeGreaterThan(MIN_COLUMNS)   // the cut at 60 columns
Expected: > 60
Received: 0
```

**Slice 2**, `keys.test.ts` — `s` on a card in Done, then any other key:

```
expect(press(said, key).state.message).toBe("")
Expected: ""
Received: "#7 is done"
```

and `board.test.ts`, through the loop, where the hint never came back:

```
error: timed out waiting for the hint again
      at until (packages/cli/src/board/board.test.ts:316:13)
```

**Slice 3**, `frame.test.ts` with the scroll on the view but the frame still drawing from the
top:

```
expect(shown(1)[0]).toBe("")
Expected: ""
Received: "keys"
```

and `keys.test.ts`, where `j` still closed the list instead of moving through it:

```
expect(down.state.view).toEqual({ kind: "help", from: { kind: "board" }, scroll: 1 })
-   "from": { "kind": "board" },
-   "kind": "help",
-   "scroll": 1,
+   "kind": "board",
```

## The tests that changed, and why (criterion 7)

Criterion 7 expects two kinds of change, and **neither happened**: no 026, 027 or 032 test
asserted a message persisting across a later key, and none asserted an empty bottom line. Every
one of them passed unchanged. What did change are two tests that closed the keys list by
pressing `j`, which the spec's desired behaviour turns into a scroll:

1. `keys.test.ts`, "? opens the keys and any key closes them again" — rewritten as "? opens the
   keys; j and k scroll them and every other key closes them". It still asserts that `?`, `x`,
   Enter, Esc and `q` close the list, from the board and from a card; it gains the scrolling.
2. `keys.test.ts`, "archiving the card the keys were opened from leaves the keys open over the
   board" — the key that closes the list at the end is `q` rather than `j`. Nothing else moved.

Six `frame.test.ts` help states and the two above gained `scroll: 0`, which the `View` type now
requires. No assertion was loosened or removed.

## What is not done

- **The keys lines wider than 60 columns are still cut with an ellipsis.** 033's carried
  finding in `docs/MILESTONES.md` asks 034 to "also shorten the lines that exceed the floor";
  the spec does not, and its criterion 5 asks only that every key be reachable by scrolling,
  which it is. The finding stands for whoever takes it.
- **The status column's UTF-16 padding**, carried since 024 — out of scope in the spec.

## Amendment round (pre-review)

The orchestrator amended the spec in the tree and this commit carries that amendment with the
code that satisfies it. Two things changed, and they overturn the first two entries under
*Decisions the spec left open* above:

1. **The item reads `enter chat`, not `enter open`**, everywhere in the hint. Enter opens the
   chat since 033, so the item now says what the key does. Three lines of the desired-behaviour
   table, two strings in `frame.ts` (`answering`, `rowItems`), and eight assertions in
   `frame.test.ts` and `board.test.ts`.
2. **The card view of a card with an open question puts `a allow · d deny · m move` first**
   (`m` only when the request offers a move), before the card view's own items. `pressCard`
   already routes `a`, `d` and `m` through `act`, so those keys worked there and the line did
   not say so. `answering` now returns just the three answering keys; the board row appends
   `enter chat · ? keys` to them, and `cardItems` puts them in front of its own.

Red first, in two steps, so each change failed on its own before it was made:

```
expect(hint(state())).toBe("a allow · d deny · m move · enter chat · ? keys")
Expected: "a allow · d deny · m move · enter chat · ? keys"
Received: "a allow · d deny · m move · enter open · ? keys"
```

```
expect(bottom(terminal)).toContain("enter chat")     // board.test.ts, through the loop
Expected to contain: "enter chat"
Received: the dim line, still "enter open · c comment · b back · x archive · o shell · n new · ? keys"
```

then, with the rename made and the new card-view case reached:

```
expect(hint(reading("code", { attention: CONFLICT }))).toBe(...)
Expected: "a allow · d deny · m move · tab chat · c comment · b back · x archive · o shell · j k scroll · q back · ? keys"
Received: "tab chat · c comment · b back · x archive · o shell · j k scroll · q back · ? keys"
```

`bun run check` green after: **914 pass, 0 fail, 35 files** - the same count as before, because
the card-view cases are two more assertions inside the existing hint test rather than a new
test. The second of them is the no-move card view, which pins the `m`-only condition the
amended sentence states.

## Fix round 1

The plan, before starting. Four slices, each a commit that passes `bun run check`.

1. **The card view's hint puts `q back` after `tab chat`** (finding 4), and the commit carries
   the orchestrator's two spec amendments: the card view's row of the desired-behaviour table,
   and criterion 2's "every hint ends in `? keys`" scoped to the board and the card view.
2. **The loop clears the sentence, not the reducer** (finding 1). `press` stops clearing
   `state.message`; the loop draws any pending frame before the next key is processed and
   clears the sentence then, so a sentence set and replaced inside one 16 ms redraw burst is
   still on a frame.
3. **A test that pins `act`'s keys against the hint's** (finding 2), so the two cannot drift.
4. **The keys list's scroll survives an archive** (finding 7), and this record.

### What landed, per finding

**Finding 4 — the card view's order** (`9b5410d`). `cardItems` puts `q back` after `tab chat`,
ahead of the keys that act, so the one key the line names for leaving the view is not the first
thing the cut takes. The commit carries the orchestrator's two spec amendments with it. Red:

```
expect(hint(reading("idea"))).toBe(
Expected: "tab chat · q back · s start · c comment · x archive · o shell · j k scroll · ? keys"
Received: "tab chat · s start · c comment · x archive · o shell · j k scroll · q back · ? keys"
```

**Finding 1 — a sentence can be shown on no frame at all** (`9e76fba`). The clearing moved out
of `press` and into the loop: `onKey` flushes the pending redraw before it processes the next
key while `state.message` is set, and clears the sentence after that frame is on the screen.
Two new `board.test.ts` tests, one for two keys in one read of stdin and one for two reads
inside the same redraw burst, both red the same way before the change:

```
expect(terminal.frames().slice(drawn).some((each) => each.includes("is done"))).toBe(true)
Expected: true
Received: false
```

**033's clear inside `pressChat` comes back.** The orchestrator left the choice open: it is
back, because 033's own test presses six keys in the chat on a state carrying a refusal and
asserts the reducer clears it — the listening line is where the chat reads a sentence, and that
rule is the reducer's rather than the loop's. Restored exactly as `b310d5c` had it.

**The one test that changed.** `keys.test.ts`, "a sentence does not outlast the key after it,
wherever it was said" — the reducer no longer clears, so the claim moved to the loop, where
`board.test.ts` now holds it three times over (the existing `s` then `j` test and the two new
ones). What is left in `keys.test.ts` is the other half of the same rule, renamed "the reducer
leaves the sentence where it is; a key with one of its own replaces it": the message survives
`j`, `k`, `g`, `G`, `z`, `?` and Esc in the reducer, a key with a sentence of its own replaces
it, and Enter into the chat clears it (033). No assertion was dropped.

**Finding 2 — nothing checked that the hint and the reducer agree** (`71bc037`). A test in
`keys.test.ts` presses all 95 printable keys on each of: a queue row (with and without an
offered move), a card row in each of the five phases with and without an open question, the
card view of each of those, and an empty board. It collects the keys that do something and
asserts that set is exactly the set the hint names, then presses every key the hint names —
Enter and Tab included — and asserts each does something.

- **"Does something" is an action, or a change to the state other than the sentence.** A key
  whose whole effect is a sentence has done nothing: `says` is what the reducer answers when a
  key does not apply to the row it was pressed on, and the spec's calm rule says the screen
  does not name keys that do nothing here. So `a` on a card with no open question, and `s` on a
  card in Code, are not expected on the line. The reviewer's example was a fake `case "u":
  return says(state, …)`, and that shape is **not** caught, by this reasoning; a fake `u` that
  yields an action is.
- **The deliberate omissions, as two named lists.** `NOT_ABOUT_THE_ROW` is `j`, `k`, `g`, `G`
  and `q` — the cursor and the way out, which belong to the screen rather than to the row, and
  which the spec's table names on no board row. `NOT_ABOUT_THE_REQUEST` is `s`, `b`, `c`, `x`,
  `o` and `n`, which work on a queue row (a queue row and the board row of the same card are
  the same card) and which the spec's table deliberately leaves off it. A key on either list
  that the hint names anyway — `q` and `j`/`k` in the card view — still has to do something.
- **The chat and the keys list are left out**, because in both every printable key does the
  same thing: text in the chat, closing the list in the keys view. Their hints are fixed
  strings and `frame.test.ts` asserts them.
- **The hint is read whole**, not as the bottom line, so `n new` falling off a card row at 60
  columns is a cut and not an omission.

Red, in both directions, by making the fake the reviewer's finding describes and reverting it:

```
// with `case "u": return { state, action: { kind: "open-shell", id: cardId } };` in `act`
expect({ where, keys: acting.sort() }).toEqual({ where, keys: keys.filter(oneCharacter).sort() })
@@ -6,3 +6,3 @@       "m",
+     "u",

// with `"u undo"` added to `rowItems`
@@ -7,3 +7,3 @@       "s",
-     "u",
```

`frame.ts`'s comment on `hintItems` no longer says the line and the reducer cannot come to
disagree. It says what is true: this is a second list written by hand, and that test is what
holds the two together. The spec's sentence at `:83-84` is the orchestrator's to reword or
leave; the test is what makes it hold.

**Finding 7 — the keys list's scroll across an archive** (this commit). The existing
`keys.test.ts` test "archiving the card the keys were opened from leaves the keys open over the
board" now scrolls the list two lines first and asserts the scroll survives `card_archived`.
This one **could not be red**: `closed()` already carried the scroll, and the finding is that
nothing checked it. What it does catch, shown by making `closed()` return `scroll: 0` and then
reverting it:

```
expect(apply(scrolled, event).view).toEqual({ kind: "help", from: { kind: "board" }, scroll: 2 })
-   "scroll": 2,
+   "scroll": 0,
```

**Findings 3, 5 and 6** are the orchestrator's to carry: criterion 2's wording is amended and
committed with slice 1; `n new` off every card row at 60 columns is the spec's order and stands;
`hint` stays exported with no production caller, because the spec's implementation approach asks
for it as a pure function tested on its own.

`bun run check` green at each of the four commits. **917 pass, 0 fail, 35 files** at the end
(+3 on the 914 this branch had before the round: the two loop tests and the agreement test.
Finding 7's and finding 4's assertions went into tests that already existed.)
