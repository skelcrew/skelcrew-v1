# skelcrew

A crew of coding agents that builds your ideas through fixed phases, on your own machine, while
you hold the gates.

You write an idea as a card. An agent turns it into a spec. You approve it. An agent implements
it, a second agent reviews it, up to three rounds, and the card stops at a pull request. You
merge. The card lands in Done on its own. Every step is on the card, and nothing moves past a
gate because an agent said so: a phase is complete when its artefact exists, and the runner
checks.

Skelcrew is not a chat. It is a headless daemon with a SQLite file, a socket, and thin clients
over it. It never calls a model itself. The intelligence comes in through members: you at the
CLI, and the coding agents the daemon spawns in git worktrees, each speaking to the board through
the same CLI you use.

## Status

Early, and used to build itself. The first real cards ran on 2026-09-14. The loop is closed on
paper and tested against faked agents; what real use finds goes into `docs/MILESTONES.md`, which
is the plan and the record of every finding. Expect the first cards you run to find things.

## Try it

You need [Bun](https://bun.sh) and, for the agents, a Claude Code login (`claude login`) or an
API key in your shell. For the merge and conflict polls you need `gh` logged in.

```
git clone https://github.com/skelcrew/skelcrew
cd skelcrew
bun install
bun run skelcrew
```

That is the product running: it starts the daemon if none is listening and opens the board over
it. `q` leaves the board, and takes the daemon with it when nothing is running. For an always-on
machine, or a second terminal, `bun run skelcrew --headless` is the daemon alone.

From the same repository, in any terminal:

```
bun run skelcrew add "Write the README"      # an idea, as a card
bun run skelcrew mv 1 spec                   # the runner claims it and writes the spec
bun run skelcrew queue                       # what is waiting on you
bun run skelcrew show 1                      # the card, its body, its activity
bun run skelcrew mv 1 code -m "approved"     # the Code phase: implement, review, PR
bun run skelcrew watch                       # the live feed, with a desktop ping when you are needed
bun run skelcrew                             # the board on one screen, live; q leaves it
```

When a run needs you, the board shows it live, `watch` pings you wherever you are running it,
and a `--headless` daemon in its own terminal sends a desktop notification. The card and `queue`
say what it needs, with the command that answers:

```
bun run skelcrew resolve 1 -m allow          # a permission question
bun run skelcrew resolve 1 -m "use the existing helper"   # a question from the agent
bun run skelcrew comment 1 "look at the ordering test"    # reaches a live run as a message
```

Merge the pull request on GitHub. The card moves to Done within a minute.

To look without running anything: `SKELCREW_AGENT=none bun run skelcrew` claims cards, makes
worktrees, and hands them back to you with no agent spawned. `SKELCREW_RUNNER=0` is the board
alone.

## The phases

Idea → Spec → Code → PR → Done. Cards render as rows with a phase track, not as columns.

| Phase | Who moves a card in | What ends it |
| --- | --- | --- |
| Idea | you, by filing a card | you, moving it to Spec |
| Spec | you | a spec on the card, written by a run; you approve |
| Code | you | a branch with new commits, a clean worktree, and a pull request, checked by the runner, after review rounds inside the phase; the run offers you the move into PR |
| PR | you | your merge on the forge |
| Done | the daemon, when your merge is seen | |

Inside Code, a fresh-context reviewer reads the diff and records a verdict on the card. Changes
requested start a fix run; approval hands the card to you; a third changes-requested hands it
to you anyway with what is open. Whether a card is queued, running, or waiting on you is derived
from its claim and its open request, never stored.

## What the daemon holds and what it does not

- State: cards, their bodies, members, claims, attention requests, and an append-only activity
  log, in `.skelcrew/skelcrew.db` inside the repository.
- Never a checkout: cards carry branch names, commit shas, pull request URLs. Code lives in
  your repository and in the runner's worktrees under `.skelcrew/worktrees/`.
- Never a credential: the agent inherits your own login from the environment the daemon was
  started in, and skelcrew stores none of it.
- Never a model call: no API key, no client, no SDK, except the harness SDK the runner uses to
  spawn Claude Code as a subprocess.

## Settings

There is no configuration file. The daemon reads a handful of environment variables:

| Variable | Default | What it does |
| --- | --- | --- |
| `SKELCREW_AGENT` | `claude` | `none` spawns no agent; runs end handed to you |
| `SKELCREW_RUNNER` | `1` | `0` runs the board with no runner at all |
| `SKELCREW_RUNS` | `2` | how many cards run at once, each in its own worktree |
| `SKELCREW_RUN_MINUTES` | `60` | time limit per run |
| `SKELCREW_MERGE_POLL_SECONDS` | `60` | how often `gh` is asked about PR cards |
| `SKELCREW_NOTIFY` | `osascript` on macOS, `notify-send` on Linux, else a printed line | a command that receives a notification's title and text; `none` for quiet |
| `SKELCREW_DIR` | `<repo>/.skelcrew` | where the state lives |

## Checks

```
bun run check          # lint, typecheck, tests; never writes
bun run check:harness  # every command the playbooks instruct, through the pinned harness
```

Tests never spawn a real agent or call a model. `check:harness` spawns the pinned Claude Code
against a local stub and asks one question of each command: would it stop to ask?

## How it is built

With the workflow it generalises. `/spec` writes a spec into `docs/specs/`; `/develop` runs an
implementer, an independent reviewer and an independent verifier in a worktree and stops at a
pull request; findings carry forward through `docs/MILESTONES.md`. The playbooks the daemon
injects into its agents are extracted from those skills. Read `CLAUDE.md` for the constraints
every change is held to, and `docs/specs/` for what was intended, one file per unit of work.
