# 023 — A question is announced

Run record for `docs/specs/023-a-question-is-announced.md`.

## The change, in steps

1. **Move the notifier into shared.** `packages/cli/src/notify.ts` and its test become
   `packages/shared/src/notify.ts` and `packages/shared/src/notify.test.ts`, exported from the
   shared index; `watch.ts` imports `notify` and `selectNotifier` from `@skelcrew/shared`. The
   file's behaviour is 010's, with one addition: `notify` now returns the notifier command's
   exit status, because the daemon warns on a non-zero exit and `watch` does not. `watch`
   ignores the value, so nothing it does changes.
2. **`packages/daemon/src/announce.ts`** — `startAnnouncing({core, env, isTerminal, out, warn})`
   subscribes to the core and returns the unsubscribe. It subscribes at all only when
   `isTerminal` and `SKELCREW_NOTIFY !== "none"`. On an `attention_requested` whose `to` is a
   human member it writes `\x07` to `out` and sends one notification: title `skelcrew`, text
   `#<id> <title>: <first line of the note>`. A notifier that cannot be spawned or exits
   non-zero is one warning per process. The listener never throws — the core rethrows a
   listener's error at the mutation that caused it.
3. **`main.ts`** — `startAnnouncing` beside the sweep, with the comment criterion 8 asks for
   (why a headless daemon says nothing, and that `watch` is the ping for that case), torn down
   in `shutdown` with the timers.
4. **`process.test.ts`** — criteria 3–7 against the real daemon, with a recording notifier like
   010's and a pseudo-terminal for the ones that need a terminal, plus a fifth test for the
   other half of "cannot be spawned or exits non-zero": a notifier that runs and exits 3.

## Red, then green

The two tests that assert something happens failed for the intended reason before the daemon
announced anything — `the notifier was not invoked within 5000 ms` and `the failing notifier
was not reported within 5000 ms`, both from the real daemon under a pseudo-terminal. Criteria 5
and 6 are absence criteria, so their tests passed before the change as well as after; what they
guard is that the terminal check and `none` keep the daemon quiet, and the criterion-3 test is
what shows the same daemon is otherwise loud.

## Files expected to change

- `packages/cli/src/notify.ts`, `notify.test.ts` → `packages/shared/src/` (git mv)
- `packages/shared/src/index.ts`, `packages/cli/src/commands/watch.ts`
- `packages/daemon/src/announce.ts` (new), `packages/daemon/src/main.ts`
- `packages/daemon/src/server/process.test.ts`
- `packages/shared/src/text.ts` — the bell is a control character, and 015 lets one file spell
  one out, so `BELL` is exported from there rather than written in the daemon
- `packages/cli/src/cli.test.ts` — `watch` under `SKELCREW_NOTIFY=none` (cycle 1), the
  `pending()` accessor that test needs, and `spawnWatch` dropping an inherited
  `SKELCREW_NOTIFY` (cycle 2)

## Decisions the spec left open

- **The pseudo-terminal, criterion 3.** The test spawns the daemon under BSD `script`:
  `script -q /dev/null /bin/sh -c 'echo $$ > <pid>; exec <bun> <main.ts> 2> <err>'`. The shell
  writes the daemon's pid (`exec` makes it the shell's own pid) so a test can SIGTERM the daemon
  rather than `script`, and the daemon's stderr is redirected to a file so the two streams stay
  apart inside the one pty. `script`'s copy of the pty output is the test's view of the daemon's
  stdout, which is where the bell is asserted. This is the `script` option the spec offers, not
  the injectable-TTY one: nothing in the daemon learns it is under test. The same helper takes
  `terminal: false` for criterion 5, where the shell redirects stdout to a file instead — the
  criterion's own wording — so the two cases differ in exactly the pty and nothing else. BSD
  `script`'s argument form is macOS's; a Linux checkout would need util-linux's `-c` spelling.
- **"The first line of the note"** is taken literally — the note up to its first `\n`, escaped
  as a single-line field. `watch` escapes the whole note instead, so for a multi-line note the
  two texts differ after the first line. The coordinator confirmed first-line-only for the
  daemon; `watch` is out of scope here.
- **`notify`'s return value.** Added rather than making `notify` throw on a non-zero exit,
  because throwing would change what `watch` does with a notifier that runs and fails, and the
  spec says `watch` is unchanged.
- **The bell lives in `shared/src/text.ts`.** 015's tripwire test allows exactly one file to
  spell a control character out, and the bell is one. It is exported as `BELL` from the file
  that owns the set rather than written `"\x07"` in the daemon, which would have failed
  `text.test.ts` — a test this run must not weaken.
- **Criterion 8, second half.** `docs/MILESTONES.md`'s "local ping" wording is *not* touched in
  this run: the owner's instruction is that it is updated on `main` at landing, by someone else.
  The `main.ts` half of criterion 8 is done here.

## Review and verification

### Review cycle 1 — CHANGES REQUESTED

One Important finding: `SKELCREW_NOTIFY=none` switched the daemon off but broke `watch`,
because the shared selector took any value as a command name and `watch` then printed
`Executable not found in $PATH: "none"` once per question. The spec's sentence that "010
already made that variable the notifier's switch" is wrong about existing code: 010 made it a
selector, and `none` had no meaning anywhere. The spec is not edited by this run; the intended
behaviour (the variable is the switch) is unambiguous, so `none` is given its meaning in the
shared notifier where the variable is owned, and the wrong sentence is recorded here and in
the PR for the spec's author.

Minor findings carried to the PR: the warn-once flag also silences internal errors in the
announcer; the pseudo-terminal tests use BSD `script`'s argument form and would fail on Linux;
`watch` and the daemon word the same request differently (first line versus whole note);
shutdown does not await an in-flight notification; `findOnPath` is exported with no consumer.

**What the fix does.** `none` now has its meaning in `packages/shared/src/notify.ts`, where the
variable is read, so both readers honour it without knowing anything: `selectNotifier` returns
`{ name: "none" }` — no command, no PATH scan — and `notify` on it spawns nothing, prints
nothing and resolves 0. `watch` therefore tails on silently instead of failing to run a command
called `none`, and the docstring says so. The daemon keeps its own check, because that is what
also silences the *bell*, which is not the notifier's: under `none` it subscribes to nothing at
all. Red first, all three for the reviewer's reason — the selector test got `"custom"`, `notify`
threw `Executable not found in $PATH: "none"`, and the new `watch` test found
`error: Executable not found in $PATH: "none"` on stderr. Criterion 6's process test keeps
asserting the absence of the bell, which is now the only part of `none` the daemon decides; its
comment was reworded to stop claiming a missing command as the reason.

Two Minor findings taken, both inside this run's own code: the announcer's warn-once flag now
covers notifier failures only, and anything else thrown while announcing is reported every time
under its own wording (`announcing a request failed: …`) rather than hidden by the first
notifier failure; and `findOnPath` is no longer re-exported from the shared index, which leaves
`notify`, `selectNotifier` and `Notifier` as the notifier's surface. The other three Minor
findings are untouched and stay on the PR.

### Review cycle 2 — CHANGES REQUESTED

The cycle-1 fix was confirmed red-first by execution at base. One Important finding: the
`watch` test helper `spawnWatch` in `packages/cli/src/cli.test.ts` copied `process.env` and
deleted only `SKELCREW_AS`, so an owner with `SKELCREW_NOTIFY` exported in their shell would
have a `watch` test fire a real notification and fail `bun run check`. Pre-existing from 010,
but criterion 1 of this spec asserts the opposite; fixed by deleting `SKELCREW_NOTIFY` from the
inherited environment, as the new daemon helper already does. Minor: the run record's file list
omitted `text.ts` and `cli.test.ts`; `watch`'s behaviour under `none` did change (it now tails
silently instead of erroring), to be recorded in the PR.

**What the fix does.** `spawnWatch` now deletes `SKELCREW_NOTIFY` beside `SKELCREW_AS`, with a
line saying why, so every `watch` test's notifier comes from its own `env` argument alone.
Reproduced the reviewer's run first: with `SKELCREW_NOTIFY` pointing at a recording script in
the shell, `bun test packages/cli/src/cli.test.ts` gave `1 fail` — "watch's printed notification
is one line" timed out at `no line within 4s`, because the ping went to the script instead of
stdout — and the script's log held `skelcrew\t#1 Watched: ping\n2026-09-11 20:30…`. With the fix
and the same environment, the whole suite is `768 pass, 0 fail` and the script is never run: the
log file does not exist. The file list above now names `text.ts` and `cli.test.ts` with their
reasons.

### Review cycle 3 — APPROVED

A fresh reviewer confirmed the cycle-2 fix from both directions (an exported recording
notifier, and fake `osascript`/`notify-send` on `PATH` with the variable unset: nothing fired
across 768 tests), re-ran the new tests at base (red for the intended reasons), and drove the
real daemon under `script` with a fake `osascript` and no `SKELCREW_NOTIFY`: one invocation
with title `skelcrew`, one bell, and none for a request to an agent. No Critical or Important
findings. Minor findings carried to the PR: `"none"` is spelled in both packages rather than
exported once; `getCard` loads a card's whole activity to read two fields; the spec's "`watch`
is unchanged" is now false for the `none` value; the BSD `script` form; shutdown not awaiting
an in-flight notification; `announce.ts`'s docstring still calls the notifier "unchanged".

### Verification — VERIFIED

`bun run check` passes (Biome clean, three typechecks, 768 tests). No build script is
configured; `check:harness` was not run because no playbook or allowlist changed. The verifier
drove the real daemon by hand under `script` for criteria 3–7 and confirmed every one,
reproduced the cycle-2 leak at base, and re-ran the new tests at base (three red for the
intended reasons; the run record's "two tests" above under-counts, it is three). No unrelated
changes; +362/-0 across test files.
