# 026 — The board on one screen (run record)

## The change, in steps

1. `packages/cli/src/board/ansi.ts` — the only file that spells the escape character: alternate
   screen, cursor, erase, and `bold`/`dim`/`reverse` wrappers. No colour sequence exists here.
2. `packages/cli/src/board/state.ts` — `State`, `load(client)` (one round of requests), and
   `apply(state, event)`, including the last-line rule.
3. `packages/cli/src/board/frame.ts` — `frame(state, size, now)` and `sizeOf(output)`, pure.
4. `packages/cli/src/board/keys.ts` — `press(state, key)` → `{ state, action? }`, pure.
5. `packages/cli/src/board/board.ts` — the terminal loop (`runBoard`, with `input`/`output`
   injected) and the `board` command object `main.ts` reaches for when no command is given and
   stdout is a terminal. The five design choices from `docs/MILESTONES.md` head the file.
6. `packages/cli/src/main.ts` — bare `skelcrew` with a terminal on stdout runs the board; with
   no terminal it stays exactly what it is today. One usage line updated to say so.
7. Tests: `frame.test.ts` (3, 6, 7), `keys.test.ts` (4), `state.test.ts` (5),
   `board.test.ts` (8, 9 — the loop over fake streams, and the tripwire), and one `cli.test.ts`
   case for criterion 2.

## Decisions the spec left open (or got wrong)

- **Bare `skelcrew` without a terminal.** The spec says it "prints the usage and exits 2, as it
  does today". It does not: `main.ts` maps no command to `queue` (spec 010, asserted by
  `cli.test.ts`'s "no command and queue print what waits on the invoking member"). The spec's
  own reason — "so a script or an agent that runs it bare gets the same answer it always did" —
  is what is implemented: without a terminal, bare `skelcrew` is still `skelcrew queue`.
  Changing it would break 010's behaviour and require weakening that test. Reported, not
  silently taken.
- **Who "the runner member" is, for the last-line rule.** `RUNNER_MEMBER_NAME` lives in the
  daemon package, which the CLI does not import. The rule is therefore "a comment by the member
  holding the card's live claim" — the run's own comments — which is the runner in every real
  case and needs no second copy of a daemon constant.
- **No gap without a `seq`.** The spec suggests subscribing from the highest `seq` seen in the
  initial load. Subscribing *before* the reads and buffering what arrives until the state is
  built closes the same gap, keeps `seq` out of `State` (which the spec's own `State` list does
  not carry), and costs at most a re-applied event; `apply` is idempotent for every event it
  handles.
- **The queue half is the invoking member's.** `listAttention({ to: me.id })`, as `queue` does
  without `--all`.
- **`frame` takes `now`** as a third, defaulting parameter, the way `render.ts`'s `row` and
  `cardView` do, so the frame stays pure under test.
- **The card view's scroll** counts lines up from the newest, so the reducer can clamp it
  without knowing the terminal's height.
- **`shared/src/text.test.ts`'s tripwire** allows one more file: `cli/src/board/ansi.ts`. The
  test now also asserts that the only control characters that file spells are the escape
  character and ctrl-c, so the exception cannot grow into a second definition of the refused set.
- **Raw mode is set only when stdin is a terminal.** The screen opens on a terminal on *stdout*;
  with stdin redirected there is no raw mode to set, and the board draws and redraws without
  keys rather than crashing.

## What was checked by hand

`bun run check` passes. Beyond it, the screen was opened for real against a server started
without the runner (so no coding agent was spawned), under a pseudo-terminal: it drew the board,
`j` moved the cursor, `Enter` opened the card view, `q` came back and `q` again exited 0 with
`\x1b[?25h\x1b[?1049l` as the last bytes written. The terminal reports no size under `script`,
so that run exercised the 80×24 fallback.

## Review and verification

### Review cycle 1 — CHANGES REQUESTED

The reviewer ran `bun run check` (green), drove the real binary through a pseudo-terminal
against a scratch daemon with no runner, and read the whole diff.

- **Critical — reopening a card shows a stale feed.** `unread()` in `board.ts` skipped the read
  when `state.detail.id` already matched, and `onEvent` only refreshed the detail while the card
  view was open, so a card opened, closed and reopened showed history. Reproduced end to end.
- **Important — wide characters overrun the width.** `cut` counts code points and `padEnd`
  UTF-16 units, neither display cells; a CJK title at 100 columns wrapped onto a second physical
  line and scrolled the alternate screen. `docs/MILESTONES.md` assigns the display-width measure
  to 026. The frame test measured code points, so it passed while the line did not fit.
- Minor, carried to the PR unless fixed in the round: `apply` is not idempotent for
  `member_joined`; `--json` with no command on a terminal stays `queue` and is undocumented;
  `State.message` has no producer; the card view can scroll a screen past the top; `lastLine`
  outlives the run that wrote it; resize and redraw coalescing are untested; the 015 tripwire
  admits a second file (judged acceptable, to be named in the PR); README still describes bare
  `skelcrew` as `queue`; keys typed before the first frame are dropped.
- Also confirmed by the reviewer: the criterion-2 deviation (bare `skelcrew` piped stays
  `queue`, because the spec's "as it does today" is wrong about `main`) is the one the plan
  records, handled without weakening 010's test. Carried to the human.

### Fix round 1

- **The card view is read afresh every time it is opened** (`board.ts`). `unread` became
  `opened(before, after)`: a card view that was not already showing that card is a read,
  however recently it was open. Reproduced the reviewer's case end to end under a
  pseudo-terminal — open #1, `q`, `skelcrew comment 1 "ZZZ-…"` from another client, open #1
  again — and the comment is now on the reopened view.
- **Every line is cut and padded in terminal cells** (`frame.ts`). `Bun.stringWidth` is the
  measure — no dependency, and it counts CJK and emoji as two cells and combining marks as
  none. The board's `cut`/`pad` are local to `frame.ts`, so `render.ts` keeps its own
  code-point cut and `render.test.ts` is untouched; 024's note about the status column's
  UTF-16 padding therefore still stands, and only the screen's own cutting is by cells. The
  frame test measures cells now, which is what makes the case fail before the fix (155 cells
  on a 100-column terminal).
- **The last line goes with the run** (`state.ts`): cleared on `released` and
  `run_interrupted`, and `load` only reads comments posted after the live claim began.
- **`apply` is idempotent for `member_joined`** (`state.ts`): replace-or-append.
- **The card view stops with the card's first line at the top of the window**: `clampScroll`
  in `frame.ts` knows the size, the loop applies it after every key and every resize, and the
  frame draws through the same clamp. The reducer keeps its size-free bound, and
  `keys.test.ts` now names it exactly.
- **Keys typed during startup are held** (`board.ts`): the listener is attached before the
  reads and what arrives is drained once the first frame is up.
- **Two claims now have tests** (`board.test.ts`): a resize below and back above 60×12
  redraws, and a burst of three events at a 30 ms redraw delay is one frame carrying the
  newest.

### Review cycle 2 — APPROVED

A fresh reviewer ran `bun run check` (830 pass, 0 fail) and drove the real binary through a
pseudo-terminal against a scratch daemon with the runner off. Both cycle-1 findings confirmed
fixed by execution: the reopened card view carries a comment posted while it was closed; with
Japanese titles and notes and an emoji comment on a 100-column terminal the widest drawn line
is exactly 100 cells. Also confirmed by running: no colour or OSC sequence is ever emitted, even
with escape sequences written into a card's title and body directly in SQLite; every exit ends
with `\x1b[?25h\x1b[?1049l`; the daemon-lost message is written after the alternate screen is
left.

Minor, carried to the PR:

- `render.ts`'s status column still pads in UTF-16 units and `cut` counts code points, so rows
  with wide characters in a note do not line up. The spec pins `row`/`status` unchanged; the
  MILESTONES finding assigned to 026 stays open and should be carried forward, not closed.
- Spec criterion 2 is wrong about today's behaviour (bare `skelcrew` piped is `queue`, not the
  usage). The spec is the artefact to change.
- `state.cards` receives whole `CardDetail`s for cards first seen through an event.
- The queue half is re-sorted by `raisedAt` while the daemon orders by event seq.
- A failed card read ends the whole screen; the status line has no producer yet.

### Verification — VERIFICATION FAILED, on the spec's wording alone

`bun run check` green (Biome clean, three packages typecheck, 830 pass, 0 fail). No build
step is configured; `check:harness` not applicable (no playbook or allowlist changed). Every
criterion passes except the first clause of criterion 2, which says bare `skelcrew` with stdout
not a terminal "prints the usage and exits 2, as it does today". The verifier ran the binary on
`main`: it prints the queue and exits 0 (spec 010). The criterion contradicts itself, so no
implementation satisfies both halves; the branch keeps `queue`. The fix is one sentence in the
spec, which `/develop` may not make. The run stopped before commit, push and pull request.

The verifier also found by mutation that every new test is load-bearing (six mutations, each
caught), that the widened 015 tripwire refuses a third control character and an escape spelled
in any other board file, and that the new `cli.test.ts` case is green on base (it guards
existing behaviour, not new).
