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
