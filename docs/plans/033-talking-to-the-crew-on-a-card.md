# 033 — Talking to the crew on a card

Run record. Spec: `docs/specs/033-talking-to-the-crew-on-a-card.md`. Worktree
`.claude/worktrees/talking-to-the-crew-on-a-card`, branch `worktree-talking-to-the-crew-on-a-card`,
base `main` at `8ecaec8`.

Baseline before any change: `bun run check` green, **887 pass, 0 fail, 35 files**.
After: **899 pass, 0 fail** (+12).

## The slices, planned before starting

Each is a commit that passes `bun run check` on its own; the failing test and the change that
makes it pass land together.

1. **`keysOf` decodes Tab** — `133014d`. `board.ts` and its decoding table in `board.test.ts`.
   No view reads the key yet.
2. **The chat view** — `188897b`. `state.ts` gains the `chat` view kind, `render.ts` exposes
   the card header it already composes, `frame.ts` draws the four parts, `keys.ts` opens and
   works the view, the help screen names the two keys, and the loop reads the open card's
   detail for it. One feature, whole.
3. **A refused line is not lost** — `8bfce7b`. The daemon's sentence on the listening line, the
   typed text back in the input, and a chunk that ends at its newline.
4. **MILESTONES marks 033 landed** — *not done here*, see below.

The plan was to split slice 2 in two — the frame, then the keys — and that was dropped after
writing it: `frame()` and `press()` both switch exhaustively on `View`, so either half alone
leaves the other with a case that does not compile, and the commit in between would hold a
stub rather than a working view. The slice is one feature (Enter opens a chat on the card),
not three.

## Decisions the spec left open

- **A comment is somebody's turn, attributed by the member's name**: `<time>  <name>  > <line>`,
  with the lines after the first indented under the name and marked as `show` marks a body
  (015). The criterion asks for a three-line comment to be three marked lines, so the
  attribution shares the first of them rather than taking a line of its own.
- **`conversationLines(detail, members)` does not take `me`.** The spec's implementation
  approach names a third parameter. The owner's lines are told apart by the name they carry,
  which is the same name the dim event lines carry — using `me` to write "you" on the turns
  would have made one view say "you" and "simon" about the same person in adjacent lines. The
  parameter would then have been unused, so it is gone.
- **An event whose `activityLine` is several lines is several dim lines**, as the card view
  already draws them; cutting to the first would drop a note's or a review's text.
- **The middle pads at the bottom**, as the card view does: a short conversation sits under
  the header rather than floating above the listening line.
- **The input line carries no label.** The listening line above it says what a line does.
- **The daemon's last sentence takes the listening line** until the next call, the way the
  board's bottom line holds a message until the next action.
- **A chat open on a card that is archived closes to the board**, as a card view does (032).
  The spec does not name it; it is the same situation, and `apply` already had the rule for
  the card view — the condition now covers both kinds.
- **A chunk with a newline in it ends there in the chat too.** The spec's out-of-scope says a
  paste "sends and drops the tail as 027 does"; without the rule the tail becomes the next
  line's text instead of being dropped.
- **`docs/MILESTONES.md` is not marked here.** Criterion 11 says "at landing", and landing is
  the pull request merging; 027's and 032's implementation commits did not touch the file
  either.

## Red, then green

**Slice 1**, `bun test packages/cli/src/board/board.test.ts -t "arrow keys"`, before `keysOf`
knew the character:

```
expect(keysOf(chunk)).toEqual([...keys])
- [ "tab" ]
+ []
```

**Slice 2.** The frame tests were written first and failed to import
(`SyntaxError: Export named 'conversationLines' not found`), which CLAUDE.md counts as a broken
test rather than a red one. So `conversationLines` was given its signature returning `[]` and
the chat frame a body returning empty rows, and the four tests then failed on what they assert:

- `expect(text[0]).toContain("moved Spec → Code")` → `Received value must be an array type, or
  both received and expected values must be strings` — `text[0]` was `undefined`, because the
  conversation was empty.
- the chat frame: `expect(shown[0]).toBe("#3 running now")` → `Received: ""`.
- the scroll: `expect(drawn[0]).toBe("#3 running now")` → `Received: ""`.
- the listening line: `Expected: "crew is listening · running since 09:55"`, `Received: ""`.

`keys.test.ts`, before `keys.ts` had the view — the four new and rewritten tests, each
receiving the card view where the chat was asserted:

```
expect(opened.state.view).toEqual({ kind: "chat", cardId, scroll: 0, text: "" })
-   "kind": "chat",  -   "text": "",
+   "kind": "card",
```

```
expect(typing(chat, [..."allow", "enter"]).action).toEqual({ kind: "resolve", id: 7, text: "allow" })
+ undefined
```

`frame.test.ts`, the help screen: `Expected to contain: "chat"`, `Received: "  enter        open
the card under the cursor"`.

`state.test.ts`, the chat open on an archived card: `Expected: { kind: "board" }`, `Received:
{ kind: "chat", cardId: 3, scroll: 0, text: "half a line" }`.

**Slice 3**, `board.test.ts` through the loop:

- the refused line: `expect(input(terminal)).toContain("some news")` →
  `Received: "[7m [0m[K[J"` — the input was empty, the line gone with
  the call.
- the pasted tail: `expect(input(terminal)).not.toContain("allow")` →
  `Received: "allow[7m [0m..."`.

**One test passed the moment it was written.** The loop test for criterion 8's first half — a
line typed in the chat becomes a `comment` call, `allow` becomes `resolveAttention` — was green
on its first run, because the reducer and the frame it exercises had just landed in the same
slice. Its red is the `keys.test.ts` and `frame.test.ts` failures quoted above; it is kept as
the guard that the loop wires them together.

## The tests that changed, and why (criterion 9)

The spec expects "two that pin `Enter` opening the card view". There are thirteen: every test
that reached the card view by pressing `Enter` now presses `Enter` then `Tab`. None lost an
assertion.

`keys.test.ts`, through a new `openCard()` helper that presses both keys:

1. "Enter opens the card under the cursor, and q or Esc comes back" — rewritten as "Enter opens
   the chat on the card under the cursor, and Tab flips to the card view"; this is the test that
   pins the new behaviour, and it still pins `Esc`/`q` back to the board with the cursor kept.
2. "Down is j and Up is k, on the board and in the card view"
3. "? opens the keys and any key closes them again"
4. "archiving the card the keys were opened from leaves the keys open over the board"
5. "q quits the board, ctrl-c quits from anywhere, and nothing else acts" — and the chat was
   added to the views Ctrl-C is pressed on, where `q` is a letter.
6. "j and k scroll the card view, newest first, and stop at both ends"
7. "the same keys act on the card the card view shows"
8. "n opens the prompt for a title; Enter files it, an empty title says a card needs one"
9. "s starts the card, and says why it does not on the phases a run or the merge ends"
10. "x asks before archiving: Enter archives, Esc keeps it, and nothing else is read"

`board.test.ts`, which types `\r` and now types `\t` after it:

11. "reopening a card reads it again, rather than drawing the feed it had"
12. "x archives the card, and the card view closes when it was the open card"
13. "a card archived under the open question takes the question with it"

`frame.test.ts` builds its states by hand, so no test there changed; the colour test gained the
chat as a fifth view.

## What the spec says about today's code that is no longer true

Reported rather than edited, as asked.

- **Criterion 9's "two tests"** — thirteen, above.
- **Line numbers** in "Current behavior" are from before 030–032 (`state.ts:20`, `frame.ts:135`,
  `frame.ts:219`, `board.ts:161`, `render.ts:301`, `:334`). The code they name is still there,
  a few lines lower.
- **`Prompt` is `deny` | `back` | `comment`** — 032 added `add` and `archive`, and the keys in
  use are short by `n`, `s` and `x`. Every one of them still works.
- **"031 changes this function for the arrow keys"** — 031 has landed; `keysOf` already decodes
  the arrows, and Tab was added beside them.

## Checks run

- `bun install` — 20 packages.
- `bun test` before any change — 887 pass, 0 fail, 35 files.
- `bun run check` after each slice — Biome (104 files), `tsc` for all three packages, `bun test`.
  `bun run fix` was run three times for Biome's formatting of new blocks.
- `bun run check` after the last slice — 899 pass, 0 fail.
- `bun run check:harness` was **not** run: it spawns the pinned coding agent and covers the
  playbooks and the runner's allowlist, and this spec changes neither.

**A flake worth knowing about.** Several full runs on this machine failed one daemon test each,
never the same one twice: `process.test.ts`'s "a stale socket left behind by SIGKILL…", "the
daemon's sweep takes an interrupted run's own question with it…", "with the runner on, a
--stop-when-idle daemon…", `harness-check.test.ts`'s "every command word gets an executable…",
and `runner.test.ts`'s "with two live runs a card moved to done is abandoned…". All of them
spawn real processes and wait on wall-clock deadlines (5 s, 30 s), all passed when their file
was run alone, and the whole suite passed clean several times. Two shell processes belonging to
another session were burning a core each throughout (22 hours old, `ps` at 100% CPU). This
diff touches `packages/cli` only.
