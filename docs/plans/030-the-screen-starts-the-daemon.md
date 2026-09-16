# 030 — The screen starts the daemon (run record)

Spec: `docs/specs/030-the-screen-starts-the-daemon.md`. Base: `main` at 364364e.

## Plan

1. **The daemon's life.** `packages/daemon/src/main.ts` reads one argument, `--stop-when-idle`.
   Under it the daemon ignores SIGHUP and runs the existing `shutdown()` when it has neither a
   connection nor a live run — checked when a connection closes and when a run settles. The two
   counts come from one accessor each: `Server.connections()` (`server/server.ts`) and
   `Runner.liveRuns()` (`runner/runner.ts`), with a callback each for the moment to check
   (`onConnectionClosed`, `onRunSettled`).
2. **The screen's start.** A new module `packages/cli/src/board/start.ts`: connect; on refusal
   spawn the daemon's entry file (found by a path relative to the CLI's own file, never
   imported) with stdout and stderr appended to `<data dir>/daemon.log` and `--stop-when-idle`;
   retry every 100 ms until it answers, the child exits, or 15 s pass. The spawn is injected the
   way 027 injects the shell. The same module prints the exit line after the screen closes.
3. **`--headless`** is a global boolean option in `packages/cli/src/main.ts`: it takes no command
   word and no other option but `--help`, starts the daemon's entry file with inherited stdio,
   forwards SIGINT and SIGTERM to it, and exits with its code.
4. **The messages** in `main.ts`, `board/board.ts` and `commands/watch.ts` name `skelcrew` and
   `skelcrew --headless` instead of `bun run daemon`; `package.json` loses the `daemon` script and
   `README.md` starts the product with `bun run skelcrew`.

Tests, per the spec's Tests section: criteria 2, 3 and 11 in `cli.test.ts`; 4, 5, 9 and 10 in a
new `board/start.test.ts` against the real daemon entry file with a fake terminal; 6 and 8 in
`server/process.test.ts`; 7's live-run half in `runner.test.ts`.

## Decisions the spec left open

- **Where the daemon's entry file is found:** a path relative to the CLI's own file
  (`new URL("../../daemon/src/main.ts", import.meta.url)`), exported from `board/start.ts` and
  used by the headless branch too. Nothing of the daemon's is imported.
- **`<data dir>/daemon.log` is named by the CLI** (`DAEMON_LOG_FILE` in `board/start.ts`), not by
  `@skelcrew/shared`: the daemon inherits the file descriptors and never names the file.
- **The child is `unref`'d.** Measured: without it Bun keeps the CLI alive until the daemon
  exits, which would make `q` with a run in flight hang instead of printing `daemon running`.
- **`--headless` forwards SIGINT as well as SIGTERM**, so the CLI reports the daemon's exit code
  rather than dying first; the daemon's `shutdown()` is guarded so the second signal of a Ctrl-C
  (one from the terminal's process group, one forwarded) does not run it twice.
- **A child that loses the two-screens race** (it exited because another daemon was already
  listening) leaves the screen attached to the winner, and the screen then prints nothing on the
  way out: it is not the daemon this CLI started.

## What was built

- `packages/daemon/src/server/server.ts` — `Server.connections()` and an `onConnectionClosed`
  hook, fired after the connection has been released.
- `packages/daemon/src/runner/runner.ts` — `Runner.liveRuns()` and an `onRunSettled` hook, fired
  after the settling run has left the live map *and* after the scan that may have filled its
  slot, so the rule reads the count it should.
- `packages/daemon/src/main.ts` — `--stop-when-idle`: SIGHUP ignored, `stopIfIdle()` wired to
  both hooks, and `shutdown()` guarded so it runs once.
- `packages/cli/src/board/start.ts` (new) — `DAEMON_ENTRY`, `spawnDaemon`, `startForScreen`,
  `reportDaemon`.
- `packages/cli/src/main.ts` — the `--headless` branch, the screen's start, the exit line, and
  the new "no daemon is listening" sentence.
- `packages/cli/src/commands/command.ts` — `START_A_DAEMON`, the one sentence; used by
  `main.ts`, `board/board.ts` and `commands/watch.ts`.
- `package.json`, `README.md` — the `daemon` script is gone; one command starts the product.

## Checks run

- Red first, each time: `bun test packages/cli/src/cli.test.ts -t headless` (no `--headless`
  option), `bun test packages/daemon/src/server/process.test.ts -t stop-when-idle` (the idle
  daemon never exited; SIGHUP killed it), `bun test packages/daemon/src/runner/runner.test.ts -t
  "idle rule"` (`running.liveRuns is not a function`), `bun test
  packages/cli/src/board/start.test.ts` (`not implemented`).
- `bun run fix` — 5 files formatted.
- `bun run check` — lint, typecheck (3 packages) and 865 tests pass.
- Two smoke tests by hand, each against a temporary `SKELCREW_DIR` with
  `SKELCREW_RUNNER=0 SKELCREW_AGENT=none SKELCREW_NOTIFY=none`, stopped by pid: `bun run
  skelcrew --headless` (listening line, `add` and `ls` from another process, exit 0 on SIGTERM),
  and bare `bun run skelcrew` under `script` (daemon started, board drawn, `q` printed
  `daemon stopped`, socket gone, `daemon.log` holding the listening line).
- `bun run check:harness` was not run: no playbook or allowlist changed.

## Review and verification

### Review cycle 1 — CHANGES REQUESTED

Fresh reviewer, against `main` @ 364364e. `bun run check` green (865 pass). Five Important
findings, sent back verbatim:

1. A failed start leaves an un-ignored `.skelcrew/` in the user's repository: `spawnDaemon`
   creates the directory and the log before the daemon runs, so `prepareDataDir`'s `.gitignore`
   is never written when the daemon refuses to start (reproduced with `SKELCREW_AGENT=bogus`).
2. "The daemon's own error line" is Bun's crash footer when the daemon crashes rather than
   exits tidily (`lastLine` takes the last line of the log; reproduced with `skelcrew.db` as a
   directory: `error: Bun v1.3.14 (macOS arm64)`).
3. Two `skelcrew` at once on a fresh data directory fail, both, most of the time: both pass
   `daemonAnswers` and both run the migration on the same new database (4 of 6 rounds failed).
4. A socket probe that never says `hello` can kill an idle screen-started daemon: `stopIfIdle`
   runs on every close, `daemonAnswers` is such a connection, and the screen attaches only
   after a 100 ms sleep (reproduced: `Bun.connect` + `end()` made the daemon exit 0).
5. Criterion 7's first half (a live run holds the daemon when the last client disconnects) is
   tested nowhere: deleting the live-run term from `stopIfIdle` leaves `bun run check` green.

Minor, carried: the exit line says "runs" when another screen is what keeps the daemon alive
(spec-dictated); the daemon entry accepts any argv silently; a runner comment states an
absolute that is false while the pump is draining; the new sentence names `skelcrew`, which is
not on PATH (spec-dictated); criterion 9 is asserted at the helper, not through the CLI.

### Fix round 1

All five Important findings fixed. The two Minor ones the coordinator marked spec-dictated
(6 and 9) were deliberately not touched.

**1 — a failed start left an un-ignored data directory.** `prepareDataDir` moved from
`packages/daemon/src/server/paths.ts` into `packages/shared/src/paths.ts`, which the daemon now
re-exports; `spawnDaemon` calls it instead of its own `mkdirSync`. Whoever writes into the
directory first makes it, and it ignores itself from the first byte. New test in
`start.test.ts`: "the data directory the screen made ignores itself, even when the daemon could
not start" (red: `ENOENT … /.gitignore`).

**2 — "the daemon's own error line".** `lastLine` became `whyItIsGone`, which takes the last
line *prefixed `skelcrew daemon:`* and otherwise falls back to naming `daemon.log`. New test:
"a daemon that crashes without a word of its own names the log rather than its last line",
which makes the daemon crash by putting a directory where its database goes (red: the message
was `Bun v1.3.14 (macOS arm64)`).

**3 — two screens at once on a fresh data directory.** Serialised in the implementation, in
four places, each found by running the race and reading the log:
- `openDb` sets `busy_timeout` before the first *read* of the file (a database another process
  is creating answers "locked", not "empty") and keeps it on until `finishOpening`, which
  `openCore` calls after seeding the owner — the daemon's first write.
- the migration runs in `BEGIN EXCLUSIVE` with the version re-read inside the lock, so the
  loser applies nothing instead of migrating in parallel.
- `enableWal` tries once and tolerates a refusal: SQLite declines a journal-mode change while
  another connection holds the database and does not run the busy handler for it, so making the
  two wait for each other deadlocks them both (measured: 10 s, then both died).
- `seedOwner` treats the unique-index collision as the state it wanted.
- and the bind is the decider: `startServer` failing with `EADDRINUSE`/`EEXIST` prints the same
  `a daemon is already running on <socket>` the probe prints, instead of an uncaught throw.
New test: "two screens starting at once on a fresh data directory both end up on one daemon",
five rounds per run, asserting one board seen from both clients, the loser's own line in the
log, no crash dump, and exactly one daemon left. Red before the fix (round 0), green over 8
consecutive runs (40 rounds).

**4 — an anonymous probe could end an idle daemon.** `Server.connections()` became
`clients()`, counting only connections bound to a member by `hello`, and `onConnectionClosed`
became `onClientClosed`, fired only for those. New test in `process.test.ts`: "a connection that
never said hello cannot end a --stop-when-idle daemon", driven with the real `daemonAnswers`
(red: the daemon had already exited 0).

**5 — criterion 7's first half.** The rule is now `nothingNeedsTheDaemon` in
`packages/daemon/src/idle.ts`, and `stopIfIdle` is its only caller. `idle.test.ts` covers the
rule; `runner.test.ts`'s 030 test now wires a real `startServer`, a real client, the real runner
with a held-open scripted driver, and the rule between them — the last client leaves while the
run is live and the rule does not fire; it fires when the run ends. Both were red against the
rule written without its live-run term, which is the reviewer's mutation.

Checks: `bun run fix` (1 file), `bun run check` green — lint, 3 packages typecheck, **870 pass,
0 fail**. Both smoke tests re-run after the changes (headless: listening line, `add`/`ls`,
exit 0 on SIGTERM; screen under `script`: board drawn, `daemon stopped`, socket gone).

One Minor finding was fixed too, because it named a comment of this spec's own that said
something false: the `onRunSettled` comment in `runner.ts` claimed the scan queued beside it has
always run by then. It has, when the pump is free; behind a busy pump it has not, and the
comment now says so and says what follows (the card stays queued in its phase for the next
daemon). Minors 6 and 9 are spec-dictated and untouched, as instructed.

### Review cycle 2 — CHANGES REQUESTED

Fresh reviewer over the whole diff. `bun run check` green (870 pass); all five cycle-1 fixes
confirmed by execution. Sent back verbatim:

- Critical 1: a daemon the screen started can exit before the screen ever connects. With the
  runner on and a card already queued, the run settles at once under `SKELCREW_AGENT=none`,
  `stopIfIdle` reads clients 0 / runs 0 and shuts the daemon down before the CLI's first retry;
  `skelcrew` then exits 1 (reproduced 2/2). The rule must not fire before a client has ever
  connected. The spec is not amended by this run; the reading is that a daemon started for the
  screen has a client on its way.
- Important 2: no test starts a `--stop-when-idle` daemon with the runner on, so the
  daemon's own wiring of the live-run half of the rule is observed by nothing that runs
  `main.ts`; replacing the live-run count with 0 at the call site ships green.

Minor, carried: a failed `BEGIN EXCLUSIVE` is masked by `ROLLBACK`'s own error; `whyItIsGone`
can name a stale `skelcrew daemon:` warning; the fifteen-second timeout branch is untested;
`--headless --json --help` exits 0; a claim made by hand does not keep the daemon alive
(spec-dictated).

### Fix round 2

Both findings fixed. No spec edit; Critical 1 is fixed in the implementation, as instructed.

**Critical 1 — the rule now reads: *nothing needs the daemon once a client has been and gone
and no run is left*.** In full, `nothingNeedsTheDaemon` is now

```
clientsEver > 0 && clients === 0 && runs === 0
```

where `clientsEver` is how many clients have said `hello` since this daemon started, from a new
`Server.clientsEver()` counter incremented where a connection becomes a client. Zero means none
ever has, and a daemon no client has reached yet is needed whatever else is true of it — the
screen starts one and *then* waits for it to answer, so a client is always on its way. The daemon
therefore survives anything it does in its first milliseconds, including a run it takes from the
queue and finishes before the screen's first retry, which is exactly the failure the reviewer
reproduced. `main.ts` passes the third count beside the other two; nothing else changed.

Red first: the new case in `idle.test.ts` ("a daemon no client has reached yet is needed, even
with nothing running") → `Expected: false, Received: true`; and the new process test below →
`expect(daemon.proc.exitCode).toBeNull()` / `Received: 0`, the reviewer's failure exactly.

**Important 2 — two process tests now spawn the entry file with the runner on and
`--stop-when-idle`.** `spawnDaemon` already took the options; what was missing was using them
together.

- "…stays for the client on its way, through a run that came and went": a card in Spec written
  into the database before the daemon starts, so the runner takes it on its first scan with
  nobody connected. The run is watched through a second core (there is no client yet, which is
  the point), then the daemon must still be there for the screen, which finds the card waiting
  on it.
- "…outlives its last client while a run is live, and goes when the runs end": a `git` shim
  first on `PATH` that sleeps in `worktree add` — the mechanism `process.test.ts` already had for
  `gh` — holds a real run open, with `SKELCREW_RUNS=1` and two cards queued. The screen leaves
  during the first run; a command from another terminal still finds the daemon serving; the
  daemon exits 0 only after both runs have ended, and **both cards were run**. The second card
  is what makes the assertion bite: `shutdown()` waits for a live run either way, so a daemon
  that stopped when its last client left would still finish run one — but a stopping runner
  takes no further card, so the queue after the daemon is gone says whether the rule read the
  live run or ignored it.

Both mutations the reviewer named were run against the new test, each on otherwise-green code:
`runs: runner?.liveRuns() ?? 0` → `runs: 0` fails it (the second card was never run), and
deleting `onRunSettled` fails it (`Expected: 0, Received: "still running"` after 30 s). The
comments in `main.ts` now name these two tests where they used to name none, which is what that
file's own header asks for. The absolute in `idle.ts` and in `runner.test.ts` ("the one shape a
spawned daemon cannot be put into") is corrected: what a spawned daemon cannot hold open is an
*agent session*, which is why the driver-held test stays; a live run it can hold open, and now
does.

Checks: `bun run fix` (nothing to fix), `bun run check` green — lint, 3 packages typecheck,
**873 pass, 0 fail**. The screen smoke test re-run (board drawn, `daemon stopped`, socket gone),
plus a by-hand reproduction of the reviewer's Critical 1 in a throwaway git repo — card queued,
runner on, `SKELCREW_AGENT=none`, nothing listening, bare `skelcrew` under `script`: the board
opened over the daemon showing "no playbook for spec yet", zero `error:` lines, `daemon stopped`
on the way out.

### Review cycle 3 — CHANGES REQUESTED; run stopped

Fresh reviewer over the whole diff. `bun run check` green (873 pass). Both cycle-2 fixes
confirmed by mutation through spawned daemons; the open-time busy timeout confirmed
load-bearing by a third mutation. End-to-end smoke of the real path passed (daemon started,
board drawn, `q` → `daemon stopped`, socket gone, log and `.gitignore` in place); piped bare
CLI starts nothing.

One Important remains, so the run stops at the review-cycle cap without a fourth cycle and
without verification:

- The board's "lost the daemon" message (`board.ts:379`) has no test asserting the new
  sentence; putting the old `bun run daemon` sentence back leaves `bun test packages/cli/src`
  green. Fix is test-only: strengthen `board.test.ts:394`.

Minor, carried: a daemon the screen started but never reached stays up forever, and the spec's
sentence "exits on its own when no client is connected and no run is live" no longer describes
the rule (`clientsEver > 0 && clients === 0 && runs === 0`); the exit line can say `daemon
stopped` for a loser child not yet reaped; a persistent WAL refusal is silent; ROLLBACK masks a
failed BEGIN EXCLUSIVE; `whyItIsGone` may name a stale warning; the 15 s timeout branch is
untested; `--headless <x> --help` exits 0; README's `q` sentence is unconditional; a hand-made
claim does not keep the daemon alive (spec-dictated).

State at stop: all work uncommitted in this worktree on branch `the-screen-starts-the-daemon`;
verification not run; 031 not started.

### Fix round 3

Authorised by the owner beyond the cycle cap, for the one Important finding. Test-only: no
production file changed this round.

**The board's "lost the daemon" message.** `board.test.ts`'s "losing the daemon says so, exits,
and leaves the terminal as it found it" asserted only that the message names the socket. It now
also reads the thrown message and asserts it contains ``run `skelcrew` in a terminal, or
`skelcrew --headless` `` and does not contain `bun run daemon` — the two assertions `cli.test.ts`
already makes for the commands' message and for `watch`'s. Criterion 11's third message is now
covered the same way as the other two.

Red shown the way the reviewer found it: the old sentence was put back into `board.ts`
temporarily and the test failed with `Expected to contain: "run \`skelcrew\` in a terminal, or
\`skelcrew --headless\`" / Received: "lost the daemon on /tmp/skelcrew.sock; run \`bun run
daemon\` from the repository and open the board again"`. `board.ts` was then restored — its diff
against `main` is again only the round-1 change (the `START_A_DAEMON` import and the sentence).

Checks: `bun run fix` (nothing to fix), `bun run check` green — lint, 3 packages typecheck,
**873 pass, 0 fail** (5918 assertions, two more than round 2: the two added here). Minor findings
left alone, as instructed.

### Review cycle 4 — APPROVED (authorised by the owner beyond the cap)

Fresh reviewer over the whole diff. `bun run check` green (873 pass). Round-3 test confirmed
red under the old sentence; both cycle-2 fixes re-confirmed by mutation through spawned
daemons. End to end on a real pty: bare `skelcrew` started the daemon, drew the board, `q` →
`daemon stopped`; with `watch` connected from another process, `q` → `daemon running; it
stops when its runs finish` and the daemon left within 3 s of `watch` dying. Piped bare CLI
spawned nothing. No Critical, no Important.

Minor, carried to the PR: a never-reached screen-started daemon never stops and the timeout
branch does not kill it; the exit line blames runs when a client holds the daemon
(spec-dictated); the spec's red-team absolute about piped invocations ignores `--headless`;
the spec's idle sentence omits the "a client has been and gone" term; ROLLBACK masks a failed
BEGIN EXCLUSIVE; a refused WAL conversion is silent; `whyItIsGone` may name a warning;
`--headless <word> --help` exits 0; a hand-made claim does not keep the daemon alive
(spec-dictated).

### Verification — VERIFIED

`bun run check`: Biome clean (104 files), three packages typecheck, `bun test` 873 pass, 0
fail. `check:harness` not run (no playbook or allowlist change); no build step configured.
Criteria 1–11 established by execution, including real-pty runs of the screen (start, attach,
exit line in all three cases, `SKELCREW_AGENT=bogus`), `--headless` by hand, SIGHUP by hand,
and four mutations re-run on the real tree (board sentence, `clientsEver` term, live-run count,
`runs === 0` term), each failing its test. Test count 587 → 608, none removed, none weakened.
Criterion 12 deferred to landing by the owner's instruction. Scope: the SQLite open-time
serialisation in `db.ts`/`core.ts` and `prepareDataDir` moving to shared are the two changes
the spec does not name by file; both trace to the spec's two-screens case and the log file.
