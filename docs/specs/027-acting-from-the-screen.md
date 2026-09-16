# 027 — Acting from the screen

The second half of milestone 026, split out on 2026-09-16 before development: 026 is the
screen, read-only; this spec puts the owner's answers on its keys and adds the exit ramp. Every
key is one CLI call, so this spec grants nothing to any agent; the one thing it runs is the
owner's own shell, as the owner.

## Goal

The owner answers from the screen with one key. Today, after 026, the screen shows a question
and the owner leaves it to type `skelcrew resolve 3 -m allow` in another terminal. After this
spec `a` on that row allows, `d` denies, `m` takes the offered move, `b` sends the card back
with a message, `c` comments, and `o` drops into a shell in the card's worktree and comes back.
The loop of commands 026 removed for looking is removed for acting.

## Current behavior

- After 026, `packages/cli/src/board/` holds a `State`, a pure `frame`, a pure `press` whose
  only action is `quit`, and the terminal loop in `board.ts`. The reducer's action is a
  discriminated union built to be extended here. A status line exists and carries the
  daemon-lost and too-small messages. Criterion 9 of 026 pins that the module makes no
  mutating call and spawns nothing; this spec replaces that tripwire with the table in its
  own criterion 6.
- `packages/cli/src/commands/resolve.ts`, `mv.ts`, `comment.ts`: each makes one call —
  `resolveAttention`, `moveCard`, `comment` — with the parameters this spec's table names.
- The worktree of a card is where `runner.ts` puts it, `worktreesDir(dataDir)/<id>`, and a
  request note that hands work back names it as `the work is in <path>` (006, 014).

## Desired behavior

**The keys.** On the selected row:

| Key | Does | The CLI call |
| --- | --- | --- |
| `a` | allows the open question | `resolve <id> -m allow` |
| `d` | denies it, after an optional one-line message | `resolve <id> -m <message or deny>` |
| `m` | takes the request's offered move (the first, when it offers several) | `mv <id> <phase>` |
| `b` | sends the card back one phase, after a one-line message | `mv <id> <previous phase> -m <message>` |
| `c` | comments, after a one-line message | `comment <id> <message>` |
| `o` | opens a shell in the card's worktree | none |

A key that does not apply to the selected row — `a` on a card with no question, `m` on a
request with no move, `b` on a card in Idea — does nothing and says why on the status line.
The same keys work in the card view, on the card it shows.

**The message line.** `d`, `b` and `c` open a one-line prompt at the bottom of the screen; the
owner types, `Enter` sends, `Esc` cancels. Printable characters and `Backspace` edit it; nothing
else is interpreted. It is the screen's only text input. `d` with an empty message sends `deny`.

**A call's outcome is on the screen.** The frame after a successful call is whatever the
daemon's next events make it: the request disappears, the card moves. A refused call — the
daemon says no, as it does for a request not addressed to the caller — puts the daemon's
message on the status line and changes nothing else.

**`o` is the exit ramp.** It leaves the screen, starts the owner's shell (`$SHELL`, else `sh`)
in the card's worktree, and returns to the screen, redrawn from a fresh load, when that shell
exits. A card with no worktree says so on the status line and does nothing.

**Everything it does is one CLI call.** The screen and the CLI can never disagree about what a
gesture means, because they make the same request with the same parameters.

## Implementation approach

`press(state, key)` gains the actions: `resolve`, `move`, `comment` with the parameters the
commands send, `open-shell` with the card id, and a `prompt` view in `State` holding the text
and what it is for (`deny`, `back`, `comment`) and the card it applies to. The terminal loop
performs an action through `ctx.client.call`, the same methods `resolve.ts`, `mv.ts` and
`comment.ts` call — not by spawning the CLI — and puts a refusal's message on the status line.
`o` restores the terminal, runs `Bun.spawn([shell], { cwd, stdio: inherit })`, awaits it,
re-enters raw mode and the alternate screen, and reloads. The worktree path comes from the
request note's `the work is in <path>` when present and from `worktreesDir(dataDir)/<id>`
otherwise.

Decisions resolved from the repository: `m` takes the first offered move because 010 made
`moves` a list and today every request offers at most one; the previous phase for `b` is the
phase order in `packages/shared/src/phases.ts`, and Idea has none; the calls go through the
client, not a child CLI, because the CLI commands are thin over the same client and a child
process would add a second way to fail.

### Red-team

The one grant is `o`: it runs the owner's shell, in the owner's terminal, as the owner, in a
directory the daemon chose. That is the exit ramp the positioning promises and not a capability
any agent reaches; the directory is a path, never a command. The prompt composes nothing into a
syntax: the text is one argument to the same core call `comment` and `mv` make, under 015's
rules for what a note may contain. `$SHELL` is the owner's own variable and is executed with no
arguments.

## Acceptance criteria

1. `bun run check` passes. No test opens a real terminal, spawns a real shell, spawns a real
   coding agent, or calls a model; `o`'s spawn is behind an injected function in the test.
2. `press` on `a` on a request row yields the resolve action with `allow` for that card, and
   on a card row with no question yields no action and a status message; `m` on a request
   with a move yields the move to it, and on one without yields a status message; `b` on a
   card in Idea yields a status message.
3. `d`, `b` and `c` open the prompt; printable keys and `Backspace` edit it; `Enter` yields the
   call with the typed message (`deny` when `d`'s message is empty); `Esc` yields no action and
   closes the prompt.
4. The same keys in the card view act on the shown card.
5. A refused call puts the daemon's message on the status line and leaves the state otherwise
   unchanged; asserted by driving the loop with a fake client that refuses.
6. Every action the reducer yields corresponds to exactly one of `resolveAttention`, `moveCard`
   and `comment` with the parameters the CLI commands would send; asserted by a table in the
   test, not by reading. This replaces 026's tripwire (its criterion 9), which is removed.
7. `o` on a card with a worktree restores the terminal, calls the injected spawn with the shell
   and the worktree's path, and re-enters the screen when it returns — asserted on the escape
   sequences written to a fake stdout around the spawn; `o` on a card with no worktree yields
   a status message and no spawn.
8. `docs/MILESTONES.md` marks 027 landed at landing.

## Tests

- Criteria 2–4 and 6 in `packages/cli/src/board/*.test.ts` as pure-function tests, extending
  026's.
- Criteria 5 and 7 by driving the loop with injected `stdin`/`stdout`, a fake client and a fake
  spawn; no pty.
- 026's tests unchanged except the removed tripwire.

## Out of scope

- **Recording a review verdict, archiving, claiming, releasing** from the screen.
- **A message longer than one line**, or editing a card's body.
- **Undo.** A sent answer is sent; the card's feed is the record.
- **Colours, mouse, configuration** — 026's decisions stand.
- **`o` into anything but a shell** (an editor, a `git` command). The shell is the ramp.
