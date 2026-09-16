# 026 — The board on one screen

Milestone 026 in `docs/MILESTONES.md`: design 1 of the three sketched on 2026-09-16, with the
running rows borrowed from design 3, under the five design choices the milestone records. This
spec grants nothing: the screen is a client of the same socket the CLI uses, and every key is one
CLI call.

## Goal

One screen that shows what is waiting on the owner and what the crew is doing, live, and takes
each answer with one key. Today the owner runs `queue`, then `show`, then types a `resolve` or
`mv` line, and repeats; with several cards moving (025) that is a loop of commands to see a
board that already exists in the daemon. After this spec typing `skelcrew` with nothing after it
opens the queue over the board in the terminal — the screen is the default experience, not a
subcommand — rows redraw as the daemon's events arrive, and `a`, `d`, `m`, `b`, `c`, `o` and
`Enter` do what the commands do. It is the CLI's renderer made live, not a second
product: rows and a phase track, no columns, no colours of its own, no configuration, one
language, and small enough to read in an evening.

## Current behavior

- `packages/cli/src/commands/ls.ts`, `queue.ts`, `show.ts`, `watch.ts`: four commands, each one
  request and one print. `watch` is the only live one (`packages/shared/src/client.ts:37`,
  `subscribe(handler, since)`), and it prints one line per event.
- `packages/cli/src/render.ts`: `rows`, `row`, `queueView`, `cardView`, `activityLine`, and
  after 024 a `status(card, …)` in words. All pure functions of the daemon's data; nothing in the
  CLI keeps state between calls.
- `packages/cli/src/main.ts:220-236`: a command returns an `Outcome` and the CLI prints its
  render once. A command that owns the terminal for its whole life has no precedent except
  `watch`, which streams through `ctx.out`.
- The daemon keeps no "last line" per card. A run's text turns and tool summaries are comments
  by `runner` on the card (012), so the most recent activity of a running card is the last
  comment on its feed.
- Measured 2026-09-16 with Bun 1.3.14 under a pseudo-terminal: `process.stdin.setRawMode` is a
  function and works; `process.stdout.isTTY` is true; `SIGWINCH` can be listened for; `columns`
  and `rows` read as `0` under `script`, which sets no window size. So a hand-rolled screen is
  possible on this runtime with no dependency, and the size needs a fallback.
- Card 2 on the owner's own board (`build a tui …`) is in Spec with an agent writing a spec for
  this. Whatever it produces is input, read after this one; it was written before 022–025.

## Desired behavior

**Bare `skelcrew` opens the screen.** `skelcrew` with no command, when stdout is a terminal, is
the screen; there is no `board` subcommand, because there is one way to open it. `skelcrew` with
no command and stdout not a terminal prints the usage and exits 2, as it does today, so a script
or an agent that runs it bare gets the same answer it always did. On start it draws once from one round of
requests — the cards, the open requests, the members, and for every running card its feed's last
comment — and then redraws as events arrive on the subscription. Nothing animates while waiting;
there is no spinner and no progress bar. The alternate screen is used and restored, and the
terminal is left as it was found on every exit: `q`, `Ctrl-C`, a lost daemon (exit 1 with
`watch`'s message), or an error.

**Two halves, rows, no columns.** The top half lists what is waiting on the owner, oldest first:
one row per request with the card id, title, and the note's first line (022's `why:` where the
note has one). The bottom half lists every unarchived card in id order: the marker, id, phase
track, phase name, status in words (024), and title. A running card's row carries, after the
title, the first line of the last comment its run posted, cut to the width, so a row changes as
the agent works and a row that has not changed stands out. A single horizontal rule separates
the halves. Nothing else is drawn: no borders, no headers beyond one dim word per half.

**One cursor, vim keys.** `j` and `k` move the cursor through the queue rows and then the board
rows as one list; `g` and `G` go to the top and bottom. The selected row is shown in reverse
video. On the selected row:

| Key | Does | The CLI call |
| --- | --- | --- |
| `a` | allows the open question | `resolve <id> -m allow` |
| `d` | denies it, after an optional one-line message | `resolve <id> -m <message or deny>` |
| `m` | takes the request's offered move (the first, when it offers several) | `mv <id> <phase>` |
| `b` | sends the card back one phase, after a one-line message | `mv <id> <previous phase> -m <message>` |
| `c` | comments, after a one-line message | `comment <id> <message>` |
| `o` | opens a shell in the card's worktree | none |
| `Enter` | opens the card | none |
| `?` | shows the keys | none |
| `q` | quits | none |

A key that does not apply to the selected row — `a` on a card with no question, `m` on a
request with no move — does nothing and says why on the status line. A message is typed on one
line at the bottom, `Enter` sends it, `Esc` cancels; that line is the screen's only text input.

**The card view.** `Enter` shows the selected card the way `show` renders it — header, body,
feed — scrolled to the newest, with `j`/`k` to scroll, the same action keys, and `q` or `Esc` to
return. It redraws as the card's events arrive.

**`o` is the exit ramp.** It leaves the screen, starts the owner's shell (`$SHELL`, else `sh`)
in the card's worktree, and returns to the screen when that shell exits. A card with no worktree
says so on the status line and does nothing.

**Calm, plain, and the terminal's own.** No colour escape is ever written: emphasis is bold,
dim and reverse only, so the screen takes the terminal's theme. Box drawing is one rule
character. Redraws are coalesced so a burst of events is one frame. Below sixty columns or
twelve rows the screen shows one line asking for a larger terminal, and redraws when it gets
one. There is no configuration: no flags beyond the CLI's global ones, no file, no environment
variable of its own.

**Everything it does is one CLI call.** The screen and the CLI can never disagree about what a
gesture means, because they make the same request.

## Implementation approach

A small module beside `render.ts`, `packages/cli/src/board/`, in the CLI package, entered from
`main.ts` when no command is given and stdout is a terminal (today that path prints the usage;
it keeps doing so when stdout is not a terminal). Not a command in the `COMMANDS` table, so the
usage listing does not advertise a `board` verb. No new package and no dependency: the terminal is
driven with escape sequences the module writes itself, and Bun 1.3.14's `setRawMode`,
`isTTY`, `columns`/`rows` and `SIGWINCH` are all it needs (measured above). This is the
"legible" choice: the loop fits in one file, and reading it is reading the product.

Three parts, and the split is what makes it testable without a terminal:

- **A model.** `State`: the cards, the open requests, the members, a `lastLine` per card id,
  the cursor, which view is open (board, card, help, prompt), the card view's scroll, the
  prompt's text and what it is for, and a status-line message. Built from the daemon's data and
  updated by `apply(state, event)` for each activity event — including the `lastLine` rule: a
  `comment` by the runner member on a card with a live claim replaces that card's line.
- **A frame.** `frame(state, size): string[]` — one string per terminal row, pure. Uses
  `render.ts`'s `row`, `status`, `phaseTrack`, `activityLine` and `oneLine` so the board is the
  CLI's rendering, not a copy of it; the queue row and the running-card suffix are the only new
  layouts. Emphasis via `\x1b[1m`, `\x1b[2m`, `\x1b[7m` and reset only.
- **A reducer.** `press(state, key): { state, action? }` — pure; the action is one of the CLI
  calls in the table, or `open-shell`, or `quit`. The terminal loop reads keys, calls `press`,
  performs the action through `ctx.client.call` (the same methods `resolve.ts`, `mv.ts` and
  `comment.ts` call), and redraws.

The terminal loop in `board.ts`: raw mode, alternate screen (`\x1b[?1049h`/`l`), cursor hidden,
`SIGWINCH` re-reads the size (with `80×24` when the runtime reports `0`), events from
`ctx.client.subscribe` from the highest `seq` seen in the initial load, a redraw coalesced on a
short timer, and a `finally` that restores everything. `o` restores the terminal, runs
`Bun.spawn([shell], { cwd, stdio: inherit })`, awaits it, and re-enters. Keys are read from raw
stdin as bytes: `j`, `k`, `g`, `G`, `Enter`, `Esc`, `Ctrl-C`, printable characters for the
prompt, and `Backspace`.

Decisions resolved from the repository: a CLI command rather than a package, because the CLI is
the one client and "one binary, thin clients" is settled; status from `render.ts` rather than
recomputed, which closes the milestone's drift catch; the last line from the run's comments,
because that is what 012 made the card's record of a run, so the screen shows what `show` would;
`m` takes the first offered move because 010 made `moves` a list and today every request offers
at most one; the worktree path for `o` comes from the request note's `the work is in <path>`
when present and from the runner's `worktreesDir(dataDir)/<id>` otherwise, which is where
`runner.ts` puts it.

### Red-team

The screen grants nothing to any agent. One thing worth naming: `o` runs the owner's own shell
in the owner's own terminal, as the owner; it is the exit ramp the positioning promises, not a
grant to a run. The message prompt composes nothing into a syntax: the text is passed as one
argument to the same core call `comment`/`mv` make, under 015's rules.

## Acceptance criteria

1. `bun run check` passes. No test opens a real terminal, spawns a real coding agent, or calls
   a model; the frame and the reducer are tested as pure functions, and the command's refusal
   without a terminal is tested through the CLI.
2. `skelcrew` with no command and stdout not a terminal prints the usage and exits 2, exactly as
   today; `skelcrew` with no command and stdout a terminal enters the screen (asserted by the
   loop being driven with a fake terminal stream in criterion 9, since no test opens a real
   one). No `board` subcommand exists: `skelcrew board` is an unknown command.
3. `frame(state, {columns: 100, rows: 24})` for a state holding two requests and five cards in
   every 024 status renders: a dim `waiting on you` header, one row per request with id, title
   and the note's first line; one rule line; a dim `board` header; one row per card with marker,
   id, phase track, phase name, status and title; and, for the running card, the last line after
   the title, cut so the row fits the width. The selected row is wrapped in reverse video. No
   string in the frame contains a colour escape (`\x1b[3`, `\x1b[9`, `38;`, `48;`).
4. `press` on `j`/`k`/`g`/`G` moves the cursor through queue rows then board rows and stops at
   the ends; `a` on a request row yields the resolve-allow action for that card and on a card
   row with no question yields no action and a status message; `m` on a request with a move
   yields `mv` to it and on one without yields a status message; `b`, `c` and `d` open the
   prompt, and `Enter` in the prompt yields the call with the typed message, `Esc` yields none;
   `Enter` on a row opens the card view and `q`/`Esc` returns; `?` opens help; `q` yields quit.
5. `apply` for a `comment` event by the runner on a running card replaces that card's last line;
   for a comment by another member, or on a card with no live claim, leaves it; for
   `attention_requested`/`attention_resolved`/`card_moved`/`claimed`/`released` updates the
   request list and the card so the next frame reflects it.
6. The frame at `{columns: 50, rows: 10}` is a single line asking for at least 60×12, and at a
   size the runtime reports as 0×0 the fallback 80×24 is used.
7. The card view's frame renders the header, the body marked line by line, and the feed's last
   lines scrolled to the newest, with the same action keys mapped.
8. Every action the reducer yields corresponds to exactly one of `resolveAttention`, `moveCard`
   and `comment` with the parameters the CLI commands would send; asserted by a table in the
   test, not by reading.
9. The terminal loop restores the alternate screen and raw mode on `q`, `Ctrl-C`, a lost
   daemon and a thrown error — asserted by inspecting the escape sequences the loop writes to a
   fake stdout in a test that drives it with a fake stdin, without a real terminal.
10. `docs/MILESTONES.md` marks 026 landed at landing, and `board.ts` records the five design
    choices at the top of the file as the constraints it was built under.

## Tests

- Criteria 3–8 in `packages/cli/src/board/*.test.ts` as pure-function tests over fixtures of
  states and sizes, in the shape of `render.test.ts`.
- Criterion 2 in `cli.test.ts` through the real binary with stdout piped.
- Criterion 9 by driving the loop with injected `stdin`/`stdout` streams; no `script`, no pty.
- Existing `render.test.ts` cases unchanged; `row`/`status` gain no new behaviour here.

## Out of scope

- **Colours, themes, configuration of any kind.** By decision.
- **Mouse support, arrow-key navigation, resizable panes.** By decision.
- **Design 3, the room with one pane per run.** After 025 has run for a while.
- **Filtering, searching, sorting** beyond id order and oldest-first requests.
- **Writing or editing a card's body**; `skelcrew body` and the runs do that.
- **Recording a review verdict, archiving, claiming, releasing** from the screen. The CLI has
  them; the first screen has what the owner does daily.
- **A daemon-side "last line".** The screen builds it from the feed; if a second client ever
  needs it, that is when it moves into the daemon.
- **Multiple daemons or repositories** on one screen.
