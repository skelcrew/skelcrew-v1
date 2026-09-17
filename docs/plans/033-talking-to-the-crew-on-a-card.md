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

`frame.test.ts` builds its states by hand rather than reaching the card view through `Enter`, so
none of its tests changed for that reason; the colour test gained the chat as a fifth view.
(Corrected after review round 2, which found this sentence overstated: `81c7112`, the fix that
made `Tab` keep the half-written line, added `text: ""` to six card-view literals in four of its
tests — "the message is the bottom line…", "no frame writes a colour", "the card view is what
show prints…" and "the card view stops with the card's first line at the top of the window" —
and to one in `state.test.ts`'s "a view open on a card that is archived closes to the board".
Every one of them is a state literal gaining a field; no assertion changed.)

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

## Fix round 1

The reviewer's seven findings, in four slices, each a commit that passes `bun run check`.

1. **The board's sentence stays on the board** (finding 1) — and the orchestrator's three spec
   amendments, committed with it.
2. **The chat draws every line the header and a note have** (findings 2 and 7).
3. **Tab keeps the typed line** (finding 3).
4. **A pasted newline that sent nothing does not end the chunk** (finding 6), and the two
   wordings (findings 4 and 5).

Files expected: `packages/cli/src/board/keys.ts`, `frame.ts`, `board.ts`, `state.ts`, and their
tests; `docs/specs/033-talking-to-the-crew-on-a-card.md` (the orchestrator's amendments, as they
stand in the tree).

### Red, then green, per finding

**1. The board's sentence took the chat's listening line** — `7d778c0`. Red through the loop,
`board.test.ts`, "a sentence said on the board does not take the chat's listening line": `a` on
card 2's row, then Enter.

```
expect(listening(terminal)).toContain("crew is listening")
Expected to contain: "crew is listening"
Received: "<dim>#2 has no open question<reset><erase>"
```

and in `keys.test.ts`, "the screen's sentence stays behind on the board, and does not outlast a
key": `expect(openChat(said).message).toBe("")` → `Received: "#7 has no open question"`.

Green: `entersChat` clears `message` on both ways in — `Enter` from the board and `Tab` from the
card view — and `pressChat` clears it on any key at all, so a refusal holds the line until the
owner does something and then gives it back.

**2. The header was not what `show` prints** — `96d655b`. Red in `frame.test.ts`, "a note of two
lines is two lines of the header, as show prints it":

```
expect(shown.slice(0, head.length)).toEqual(head)
-   "note:    why: the pull request conflicts with main",
-   "         > and the branch is behind",
+   "note:    why: the pull request conflicts with main\n         > and the branch is behind",
```

Green: `chatShape` splits `cardHeader`'s entries on the break before slicing, as the reviewer
asked, so the header occupies the lines `show` gives it and the row budget counts them. The test
also pins the narrowest terminal the screen draws on, where the cut of the first line used to
take the second's text with it.

**3. `Tab` threw away the half-written line** — `81c7112`. Red in `keys.test.ts`, "Tab keeps the
half-written line, on the card the chat is on":

```
expect(back.view).toEqual({ kind: "chat", cardId: 7, scroll: 0, text: "half a " })
-   "text": "half a ",
+   "text": "",
```

Green: the card view carries the line. **Where the text is kept, and why**: the spec left it open
("the card view carrying it, or the state holding a draft per card id"). The card view is exactly
as long lived as the flip, so there is nothing to invalidate — a draft held in the state would
need clearing when the chat leaves for the board, or criterion 2's "`Enter` … with empty text"
would fail the next time that card was opened. The card view holds the line and never draws it;
the body is what the flip is for. `pressCard` now takes the view rather than its `cardId` and
`scroll`, which is what lets the flip read the line. The card view's literals in `frame.test.ts`,
`keys.test.ts` and `state.test.ts` gained `text: ""`; no assertion was dropped or loosened.

**4. `turnLines`'s comment** — `6a408b1`. A turn keeps all its lines, each cut to the terminal by
the frame like every other line. Comment only.

**5. The help line for `esc` and `q`** — `6a408b1`. Red in `frame.test.ts`, "the keys screen says
Enter opens the chat, and names the key that flips", which gained two assertions:

```
expect(esc).not.toContain("q")
Expected to not contain: "q"
Received: "  esc, q       back to the board"
```

Green: `esc  back to the board`, and `q  quit; in the card view, back to the board`.

**6. A paste beginning with a newline was swallowed** — `6a408b1`. Red through the loop,
`board.test.ts`, "a chunk that begins with a newline is the line after it, not nothing":
`timed out waiting for the line` — `do the thing` never reached the input. Green: the chunk ends
only when the Enter sent a line (`typed.length > 0`), so the tail of a paste that did send one is
still dropped, as 027's finding says.

**7. Criterion 5's fixture had a single-line note** — `96d655b`. The conversation fixture's
request now carries `why: two frame cases are red` and a second line, the test asserts the quiet
lines against `activityLine`'s own split, and the frame draws both of them dim. **This one had no
red**: `conversationLines` already split an entry on its breaks, which is why the reviewer called
the behaviour unpinned rather than wrong. To establish that the new assertions pin it, the split
was taken out of `conversationLines` by hand and the test failed (`Expected - 2 / Received + 4`,
the two lines arriving as one string); the change was reverted and none of it is in any commit.

### Checks run

`bun run check` after each of the four commits: Biome (104 files), `tsc` for all three packages,
`bun test`. Green every time — **901**, **902**, **903**, **904** pass, 0 fail, 35 files, five
new tests over the 899 this round started from. `bun run fix` once, for Biome's formatting of a
test literal. `bun run check:harness` was not run again: it spawns the pinned coding agent and
covers the playbooks and the runner's allowlist, and this round changes neither.

**The flake recorded above got worse, and then went away.** After the fourth commit's green run
(85 s), four full runs in a row stalled: one or two tests each, never the same ones, every one of
them a test that spawns a real process and waits on a 5-second deadline — `cli.test.ts`'s
`--headless` and `ls marks a card waiting on me`, `process.test.ts`'s `--stop-when-idle` and
sweep cases, `runner.test.ts`'s teardown case. Each stalled test reported ~300 s elapsed against
its 5 s deadline, and the suite took 388–697 s instead of 85 s, while the machine sat at a load
of 1.6 with nothing burning CPU (an Apple software-update daemon had been at 30 % earlier, and a
skelcrew daemon left behind by a stalled run was found and killed). Every one of them passed when
its file was run alone, in seconds. The last full run, on the final tree, was **904 pass, 0 fail,
exit 0, 100 s**. Nothing on this branch touches `packages/daemon` or `packages/shared`: both are
byte-identical to `main`, and `packages/cli` alone is 159 pass in 7 s.

## Fix round 2

Plan, four slices, each green under `bun run check`:

1. The critical finding — a pasted tab in the chat flips the view and the rest of the read runs
   as card-view keys. Red through the loop with the reviewer's chunk, then end the chunk when
   the chat flips away. The orchestrator's uncommitted amendment to criterion 5 goes in this
   commit.
2. The keys screen gains a chat section, and the `j, k` line is qualified.
3. `frame.test.ts:315`'s brittle `not.toContain("q")`.
4. The run record's criterion-9 list, and this section.

3 and 4 landed as one commit in the end: neither changes behaviour or adds a test.

Files: `packages/cli/src/board/board.ts`, `packages/cli/src/board/board.test.ts`,
`packages/cli/src/board/frame.ts`, `packages/cli/src/board/frame.test.ts`,
`docs/specs/033-talking-to-the-crew-on-a-card.md`, this record.

### Red, then green, per finding

**1. A pasted tab ran the rest of the read as card-view keys** — `4474030`. Red through the
loop, `board.test.ts`, "a pasted tab in the chat flips the view, and the rest of the read is not
keys", with the reviewer's own chunk `name<TAB>age` on card 1, which has an open question:

```
expect(calls("resolveAttention")).toEqual([])
- []
+ [ [ "resolveAttention", { "id": 1, "text": "allow" } ] ]
```

Green: one line beside the two that already end a chunk —
`if (before.kind === "chat" && state.view.kind !== "chat") return;` — so leaving the chat
mid-read drops what follows, whichever exit it took, the way the prompt's close already does.
The test's second half pastes `!<TAB>deny it` and asserts no prompt opened.

**The card view flipping *into* the chat is left unguarded**, which the orchestrator asked to be
thought about and said. (This paragraph said something false until fix round 3; what follows is
what the code does, run.) A chunk pressed on the card view with a tab in it flips to the chat,
the letters after it become the line being written — and a newline still inside the same chunk
sends that line, because the guard above only fires for the chat→elsewhere direction and only
after the call. So the flip makes a pasted chunk safer than base in every case but one, and in
that one it is no worse: a paste whose tail is exactly `allow`, or `deny …`, followed by a
newline answers the open question here exactly as it does at base, where 027's finding still
stands outside the chat (the spec's Out of scope keeps it there).

**Esc inside a chunk was already closed, one layer lower.** The sibling test, "a pasted Esc in
the chat acts on nothing after it either", was green before the guard and after it: `keysOf`
drops an escape character together with everything following it whenever the sequence is not one
the screen knows (026), so `<ESC>age` in the chat is not Esc-then-three-letters — it is nothing
at all, and the line keeps what it held. Written as a pin rather than as red, and honest about
which layer holds it: the guard covers Esc if that ever changes.

**2. The keys screen described the board only** — `baa1757`. Red in `frame.test.ts`, "the keys
screen has a chat section, drawn on a 24-row screen":

```
expect(shown.some((line) => line.includes("in the chat"))).toBe(true)
Expected: true
Received: false
```

Green: four lines at the end of `KEYS` — `enter, esc`, `↑, ↓, tab`, `allow, deny`, under a line
saying every letter is text there — and the `j, k` line now reads `down and up; in a card,
scroll; in the chat, the arrows scroll`. Four lines and not six because the list has to fit:
with them the content is exactly 23 lines, which is what a 24-row terminal leaves above the
bottom line, and the test asserts the last of them is on the screen at 100×24. `?` stays a
printable character in the chat, as the orchestrator directed.

**3. `expect(esc).not.toContain("q")` was brittle** — it fails for any sentence with a `q` in
it, while what it means is that `esc` is alone in the key column. Now `not.toMatch(/^\s*esc,/)`.
**No red**: the assertion pins what the line already says. To establish it still catches the
regression it was written for, `KEYS`'s `esc` line was put back to `"  esc, q       back to the
board"` by hand and the test failed (`Received: "  esc, q       back to the board"`); the change
was reverted and is in no commit.

**4. The criterion-9 section overstated `frame.test.ts`** — corrected above, with the four tests
and the `state.test.ts` one named.

### Checks run

`bun run check` after each commit: Biome (104 files), `tsc` for all three packages, `bun test`.
Green every time — **906** pass after the first, **907** after the second and again after the
third, 0 fail, 35 files; three new tests over the 904 this round started from, the third commit
adding none. No `bun run fix` was needed.
`bun run check:harness` was not run: it spawns the pinned coding agent and covers the playbooks
and the runner's fixed allowlist, and this round changes neither.

## Fix round 3

Documentation only, by the orchestrator's direction: the review's one finding is that this
record stated an absolute that is false, and the fix is to the record, not to the code. No
source and no test changed this round. One commit, carrying the corrected paragraph above, this
section, and the orchestrator's uncommitted amendment to criterion 9's count in the spec.

**The false sentence.** Round 2's paragraph on the card view said of a chunk with a tab in it:
"no call is made, nothing is answered". A call is made, and the question is answered. The
paragraph above now says what happens instead.

**Run before writing it.** The reviewer's scenario went through the loop test harness — the fake
client, the injected streams, no real terminal — as a temporary test appended to
`board.test.ts`, which logged the calls and was reverted afterwards (`git checkout --`; the file
is untouched in this round's commit). On card 1, which has an open question, `Enter` then `Tab`
to reach the card view, then the chunk `<TAB>allow<NEWLINE>` in one read:

```
CALLS AFTER THE CHUNK: [["resolveAttention",{"id":1,"text":"allow"}]]
LISTENING LINE: "why: ready · allow · deny · or write"
INPUT LINE: ""
```

One call, and it is the answer. The same probe with `<TAB>xyz<NEWLINE>`, the case that is not
`allow` or `deny`:

```
3b CALLS AFTER THE CHUNK: [["comment",{"id":1,"text":"xyz"}]]
```

A comment, which is the safer half of the trade: the reviewer checked both pastes against base
`8ecaec8` and got, for the first, the same answer by another route — base's `keysOf` drops a
`\t` (`char >= " "` is what it keeps, `board.ts` at base) so the `a` of `allow` reaches
`pressCard`'s `case "a"` and resolves the question directly — and for the second, an archived
card, because base's `x` opens the archive question and the newline confirms it. Neither
behaviour is a regression, and the second is an improvement; the record now says so rather than
claiming nothing happens.

**The spec's criterion 9** gains the orchestrator's count correction, as it stands in the tree:
thirteen tests pinned the card view through `Enter`, and a fourteenth site in `board.test.ts`
presses `Enter` only to trigger a failing read and never pinned the view. The
criterion-9 section above names the thirteen and is unchanged.

**No guard was added**, as directed. The card view's exposure to a pasted chunk is 027's
carried finding, which this spec's Out of scope leaves standing everywhere but inside the chat.

### Checks run

`bun run check`: Biome (104 files), `tsc` for all three packages, `bun test` — **907** pass, 0
fail, 35 files, unchanged from round 2, since nothing outside `docs/` changed.
`bun run check:harness` was not run: it spawns the pinned coding agent and covers the playbooks
and the runner's fixed allowlist, and this round changes neither.
