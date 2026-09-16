# 030 — The screen starts the daemon

Milestone 030 in `docs/MILESTONES.md`. Decided by the owner on 2026-09-16, the first time
`skelcrew` was typed after 026 landed and answered `no daemon is listening`. This spec grants
nothing to any agent: the one process it starts is the daemon, started by the owner from the
owner's terminal, exactly as `bun run daemon` starts it today.

## Goal

One command is the product running. `skelcrew` in a terminal starts the daemon when none is
listening and opens the screen over it; `skelcrew --headless` is the daemon alone, in the
foreground, for an always-on machine or a second terminal. `bun run daemon` goes away. Today
the screen costs two terminals — one for the daemon, one for the board — and the positioning
says adding a card must cost less than opening a terminal tab. After this spec it costs one
word.

The daemon stays the product and the client stays thin: the CLI starts the daemon as a child
process and never loads its code. What this spec settles is the daemon's life when the screen
started it.

## Current behavior

- `package.json` has two scripts: `daemon` runs `packages/daemon/src/main.ts` and `skelcrew`
  runs `packages/cli/src/main.ts`. `README.md:32` tells a new user to run `bun run daemon`
  first and everything else in another terminal.
- `packages/cli/src/main.ts:210-224`: the CLI resolves the data directory, connects, and when
  nothing answers prints `no daemon is listening on <socket>; run \`bun run daemon\` from the
  repository` and exits 1. `cli.test.ts:655` ("every command names the socket path and bun run
  daemon when nothing listens") pins the sentence. `commands/watch.ts:89` and
  `board/board.ts:379` say the same when the daemon goes away mid-way. No client ever starts a
  daemon; 004 decided "a dead socket is reported, never removed or auto-started, by a client".
- `packages/daemon/src/main.ts`: reads its seven settings from the environment, refuses to start
  when a daemon already answers on the socket (`daemonAnswers` in `server/paths.ts`, which also
  removes a socket file nobody answers on), prints `skelcrew daemon <version> listening on
  <socket>` as its last startup line, warns to stderr, and on SIGINT or SIGTERM runs
  `shutdown()`, which awaits `runner.stop()` — every live run is told to stop and ends as
  `daemon stopping` — then closes the server and the database. SIGHUP is not handled: closing
  the terminal kills the daemon.
- `packages/daemon/src/announce.ts` (023): a daemon whose stdout is a terminal rings the bell
  and sends a desktop notification for a request raised to a human; a daemon whose stdout is
  not a terminal announces nothing, and `watch` is that owner's ping.
- `packages/daemon/src/server/server.ts:55` keeps `connections`, the set of open sockets, and
  `packages/daemon/src/runner/runner.ts:259` keeps `live`, the map of card id to running run.
  Neither is exposed outside its file.
- `packages/shared/src/paths.ts`: `resolveDataDir(env, cwd)` is the one walk the CLI and the
  daemon share, so a daemon started with the CLI's `cwd` and environment finds the same
  directory and the same socket.
- `packages/daemon/src/server/process.test.ts:102` (`spawnDaemon`) starts the daemon's entry
  file with `process.execPath`, stripping every setting the daemon reads from the inherited
  environment first (029's rule). `cli.test.ts:81` starts the CLI the same way.
- `packages/cli/package.json` depends on `@skelcrew/shared` only. The daemon package carries
  the harness SDK; `bunfig.toml`'s `peer = false` keeps the SDK's model client off disk (012).
- 026: bare `skelcrew` with a terminal on stdout is the screen; piped it is the queue.

## Desired behavior

**`skelcrew` in a terminal is the product running.** When a daemon answers on the socket, the
screen opens over it, as today. When none does, `skelcrew` starts one, waits until it is
listening, and opens the screen. Nothing is printed while the daemon starts; the screen appears
when the daemon is ready. If the daemon exits instead of listening — a typo in
`SKELCREW_AGENT`, a data directory outside any repository with the runner on — the CLI prints
the daemon's own error line and exits 1. If it is neither listening nor gone after fifteen
seconds, the CLI exits 1 naming the log file.

**The daemon the screen started is the daemon.** It serves the same repository and data
directory the CLI resolved, reads the same environment (so `SKELCREW_AGENT=none skelcrew` is
the look-but-do-not-run mode `README.md` describes today, and `SKELCREW_RUNNER=0 skelcrew` is
the board alone), and runs the runner unless told not to. Its stdout and stderr go to
`<data dir>/daemon.log`, appended, so the listening line and every warning are there to read.
It survives the terminal it was started from closing: a window closed over a live run is not a
`run_interrupted`.

**It stops when nothing needs it.** A daemon the screen started exits on its own when no client
is connected and no run is live. So `q` with nothing running takes the daemon with the screen;
`q` with runs in flight leaves them to finish, and the daemon exits when the last one ends with
nobody connected. A later `skelcrew` attaches to a daemon that is still running, and a command
run meanwhile (`skelcrew add …` from another terminal) is a client like any other. After the
screen closes, the CLI prints one line when it started the daemon: `daemon stopped` if it has
exited, `daemon running; it stops when its runs finish` if not. When the screen attached to a
daemon it did not start, it prints nothing.

**`skelcrew --headless` is the daemon alone.** In the foreground, in this terminal, exactly what
`bun run daemon` is today: the same lines on stdout and stderr, 023's bell and notification when
stdout is a terminal, Ctrl-C stops it, exit 1 naming the socket when one is already listening,
and it never stops itself. `--headless` takes no command word and no other option but `--help`;
`skelcrew --headless ls` is a usage error, exit 2. The `daemon` script is removed from
`package.json` and `README.md` says `bun run skelcrew` and `bun run skelcrew --headless`.

**Nothing else starts a daemon.** Bare `skelcrew` without a terminal, every command, and
`watch` fail as they do today when nothing listens, and the sentence now says what to run:
`no daemon is listening on <socket>; run \`skelcrew\` in a terminal, or \`skelcrew
--headless\``. The lost-daemon messages of `watch` and the board change the same way. An agent
inside a run is piped, so an agent never starts a daemon.

## Implementation approach

**The CLI starts the daemon as a child process and never imports it.** `main.ts` starts
`packages/daemon/src/main.ts` with `process.execPath`, the CLI's own `cwd` and environment, so
`resolveDataDir` gives the daemon the directory the CLI just resolved. The CLI process must not
load the daemon's code or the SDK: "one headless daemon, thin clients" and 012's SDK isolation
both depend on the halves staying in separate processes. How the entry file is located — a
workspace dependency on `@skelcrew/daemon` used only to resolve the path, or a path relative to
the CLI's own file — is the implementer's choice; the constraint is that `bun run skelcrew`
from any directory inside the repository finds it, and that nothing of the daemon's is imported.

**`--headless`** is a global boolean option beside `--as`, `--json` and `--version`. It starts
the daemon's entry file with inherited stdio and exits with the child's exit code; Ctrl-C
reaches both through the terminal's process group and the daemon's own `shutdown()` does the
rest. `process.test.ts` keeps starting the entry file directly and needs no change.

**Starting for the screen** lives in a small module beside the board, with the spawn injected
the way 027 injects the shell, so no test starts a daemon it did not mean to. It connects; on
refusal it starts the child with stdout and stderr appended to `<data dir>/daemon.log` and an
argument telling the daemon it was started by the screen, then retries the connection every
hundred milliseconds until it answers, the child exits, or the deadline passes. A child that
exits because a daemon was already listening (two screens started at once) is not an error: the
screen attaches to the one that won. Only then does `board.run` take the terminal, so the
alternate screen is never entered before there is a daemon to draw from.

**The daemon's life is the daemon's.** The entry file takes one argument, `--stop-when-idle`,
set only by the screen. Under it the daemon ignores SIGHUP, and exits through the existing
`shutdown()` when it has no connection and no live run — checked when a connection closes and
when a run settles. `startServer` exposes its connection count (the set at `server.ts:55`) and
`Runner` its live count (the map at `runner.ts:259`); both are one accessor each. The rule is
in the daemon rather than the client because the daemon is the one that knows who is connected
and what is running; a client deciding the daemon's life would be a client holding state, and a
pid file would be a second record of a fact the socket already answers. Under 029's rule the
handoff in `main.ts` names the process test that observes it.

**The exit line** is printed by `main.ts` after `board.run` returns, when it started the daemon:
it waits up to two seconds for the child to exit and prints `daemon stopped` or `daemon
running; it stops when its runs finish`. No count of runs: which claims are runs is the
daemon's knowledge (024), and the sentence is the same either way.

Decisions resolved from the repository:

- **A log file, not a pane.** The data directory is private (mode 0700) and ignores itself, so
  the daemon's console — which 015 records as unescaped — lands where nothing renders it.
  Showing the log in the screen is a later spec; the file is what makes that possible.
- **023's announcements are off under the screen.** The daemon's stdout is the log file, not a
  terminal, so the bell and the notification do not fire. The screen shows the request live,
  and `watch` still pings whoever runs it. A ping from the screen is its own small spec; this
  one changes nothing in `announce.ts`.
- **018's merge poll stops with the daemon.** A card in PR whose pull request merges while no
  daemon runs lands in Done the next time one starts, within the poll's minute, rather than
  within a minute of the merge. Accepted for a single owner: the daemon works while the owner
  is looking or while runs are in flight, and a merged pull request is not a run.
- **Surviving the terminal is ignoring SIGHUP**, not a new session. It is one line, it is the
  whole of what "closing the window must not interrupt a run" needs, and `shutdown()` on
  SIGTERM still works for whoever wants the daemon gone now.
- **A run is a live claim held by the runner**, the rule 024 settled. A claim made by hand from
  a live session keeps no daemon alive; the runner's `live` map is the count.

### Red-team

This spec grants one thing: `skelcrew` in a terminal starts the daemon. The daemon is started
as the owner, from the owner's shell, with the owner's environment, which is what `bun run
daemon` does today; nothing about what the daemon may do changes. It is a gate, not a boundary:
its job is to make the ordinary start cheap. What defeats it is what defeats `bun run daemon`
now — a process running as the owner can start anything. The two things checked: the start is
reached only through the screen's path (a terminal on stdout, no command word), so a piped
invocation — every agent's — never spawns; and the flag the screen passes the daemon composes
into no syntax, since it is one fixed argv entry and the child's arguments are a list, never a
shell line. Left open: the log file is the daemon's unescaped console, so `cat`ing it in a
terminal has the exposure 015 recorded for the daemon's own stderr.

## Acceptance criteria

1. `bun run check` passes. No test opens a real terminal or spawns a coding agent; every test
   that starts a daemon sets `SKELCREW_AGENT=none` and strips the daemon's settings from the
   inherited environment, as `process.test.ts` does.
2. `skelcrew --headless` with `SKELCREW_DIR` set prints `skelcrew daemon <version> listening
   on <socket>` as its first stdout line, answers `skelcrew ls` from another process, and exits
   0 on SIGTERM. A second `skelcrew --headless` on the same directory exits 1 naming the socket,
   and the first is unaffected. `skelcrew --headless ls` exits 2 with the usage.
3. `package.json` has no `daemon` script. `README.md` tells a new user to run `bun run
   skelcrew`, and names `bun run skelcrew --headless` for the daemon alone.
4. With nothing listening, the screen's start (the module, driven under test with the real
   daemon and a fake terminal) starts a daemon, and once the screen is up `<data dir>/daemon.log`
   exists with the listening line as its first line and the socket answers.
5. With a daemon already listening, the screen's start attaches to it and starts no process:
   the injected spawn is not called and no log file is created.
6. A daemon started with `--stop-when-idle` exits 0 on its own within five seconds of its last
   client disconnecting when no run is live. A daemon started without the flag does not exit
   when its last client disconnects.
7. With a run live, a daemon started with `--stop-when-idle` does not exit when its last client
   disconnects, and exits after the run ends. Observed against the runner with a fake driver
   that holds a run open, since under `SKELCREW_AGENT=none` a run ends at once; the no-run half
   is criterion 6, through the real daemon.
8. A daemon started with `--stop-when-idle` keeps serving after SIGHUP. One started without the
   flag exits on SIGHUP, as today.
9. After the screen closes, the CLI prints `daemon stopped` when the daemon it started has
   exited, `daemon running; it stops when its runs finish` when it has not, and nothing when it
   attached to a daemon it did not start.
10. With `SKELCREW_AGENT=bogus` and nothing listening, `skelcrew` in a terminal (the start
    module, under test) exits 1 with the daemon's own error line, and no daemon is left running.
11. Every "no daemon is listening" and "lost the daemon" message names `skelcrew` and
    `skelcrew --headless` and no longer says `bun run daemon`; `cli.test.ts`'s existing case is
    updated to the new sentence, not loosened.
12. `docs/MILESTONES.md` marks 030 landed at landing.

## Tests

- Criteria 2, 3 and 11 in `cli.test.ts`, through the real binary the way its `cli()` helper
  runs every other command, with the daemon's settings stripped from the environment.
- Criteria 4, 5, 9 and 10 by driving the start module with a fake terminal against the real
  daemon's entry file, `SKELCREW_RUNNER=0 SKELCREW_AGENT=none`, in a temporary data directory;
  the spawn is the injected one except where the criterion is that the real daemon comes up.
  No `script`, no pty.
- Criteria 6 and 8 in `process.test.ts`, beside the existing SIGTERM, SIGINT and second-daemon
  cases, with `--stop-when-idle` passed as an argument.
- Criterion 7's live-run half in `runner.test.ts` with the scripted fake driver 025 uses, over
  the runner's live count; the idle rule itself as a pure function of the two counts if the
  implementer separates it.
- 026's and 027's board tests unchanged: the board loop is given a connected client as before.

## Out of scope

- **A ping from the screen.** 023's bell and notification are the terminal daemon's; under the
  screen they are off, and `watch` remains the ping. A bell or a desktop notification raised by
  the screen itself is its own small spec.
- **`skelcrew stop`, `skelcrew status`, or any new verb.** The idle rule is the whole of how a
  screen-started daemon ends; a headless one ends with Ctrl-C or SIGTERM, as today.
- **A supervisor, launchd, log rotation, or a new session for the daemon.** Ignoring SIGHUP is
  the whole of surviving the terminal.
- **Showing the daemon's log in the screen**, or on the status line.
- **Changing any setting's name or default.** The seven environment variables are the whole of
  the configuration, as 026's design choices say.
- **Anything 027 covers** — the keys, the prompt, `o`.
