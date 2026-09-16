# 029 — The daemon's wiring is tested

A finding made twice in one day, 2026-09-16: 024's review round 3 found the line handing the
runner's member id to the sweep untested, and 025's review found the line handing the
runs-at-once count to the runner untested. In both cases deleting the line left `bun run check`
green, because every part is tested with fakes and the startup file that connects them is not.
024 fixed its own line. This spec fixes 025's, and states the rule so the next setting does not
ship the same way. It grants nothing.

## Goal

Every setting the daemon reads and hands to one of its parts is observed by a test that starts
the real daemon, wherever the effect is observable without a coding agent. Today `SKELCREW_RUNS`
is parsed and its refusal is tested, but a daemon that ignored the parsed value and ran with the
default would pass every check. After this spec a daemon started with `SKELCREW_RUNS=1` is shown
to hold one claim at a time, and the startup file says which test observes each handoff, so the
gap cannot reopen silently.

## Current behavior

- `packages/daemon/src/main.ts` reads six settings and hands five of them on: `selectAgent` →
  the driver import; `runLimitFromEnv` → `startRunner({ runLimitMs })`; `runsFromEnv` →
  `startRunner({ slots: runs })`; `mergePollIntervalFromEnv` → `setInterval(poll.tick,
  mergePollMs)`; `SKELCREW_RUNNER` → whether the runner and the poll start at all; and the
  runner's member id → `sweepTick(core, warn, runnerId)`.
- `packages/daemon/src/server/process.test.ts` observes, through the real daemon: the driver
  selection (`:675`, `:667`), `SKELCREW_RUNNER=0` (`:365`, `:501`), the poll interval (`:570`,
  with `mergePollSeconds: "1"`), the sweep's runner id (`:440`, added by 024's last fix round),
  and the announcer's terminal check and `SKELCREW_NOTIFY` (`:818`–`:975`, 023).
- `SKELCREW_RUNS` reaches the process tests only as a refusal (`:651`, a value that is not a
  count stops the daemon). Nothing observes the count itself. `runner.test.ts` covers `slots`
  through `startRunner` with a fake driver, and would pass if `main.ts` passed nothing.
- `SKELCREW_RUN_MINUTES` reaches no process test at all. With `SKELCREW_AGENT=none` a run has no
  agent session, so the limit never fires and cannot be observed; `runLimitFromEnv` itself is
  tested in `run.test.ts`.
- `docs/MILESTONES.md`'s 025 entry carries the finding: "the same gap 024's round 3 found for
  the sweep's runner id, in the same file. Two specs in a row found the daemon's wiring
  untested; `process.test.ts` can cover it, and the next change to `main.ts` should."

## Desired behavior

**`SKELCREW_RUNS` is observed through the daemon.** A daemon started with the runner on,
`SKELCREW_AGENT=none` and `SKELCREW_RUNS=1`, given two cards moved to Spec in one breath,
claims the second only after it has released the first: in the card activity as a subscriber
sees it, the second card's `claimed` comes after the first card's `released`. The same daemon
with `SKELCREW_RUNS` unset (the default, two) claims both before either is released: both
`claimed` events precede the first `released`. The scan claims synchronously and the worktree
setup that follows is not, so this ordering is deterministic, not a race.

**The startup file says what observes it.** The comment block at the top of `main.ts` states
the rule — a setting that crosses this file into a part is observed by a test that starts the
daemon, or the comment beside its handoff says why it cannot be — and each handoff's comment
names its test or its reason. For `runLimitMs` the reason is that no agent session exists
under `none`, and the limit is observed in `run.test.ts` against the run, not the daemon.

**Nothing behaves differently.** No setting, default or message changes.

## Implementation approach

Two process tests beside 025's refusal test in `process.test.ts`, using `spawnDaemon` with
`runner: true` (agent `none` is the helper's default) and `env: { SKELCREW_RUNS: "1" }` for
the first, nothing for the second. Each creates two cards as the owner, subscribes, moves both
to Spec, waits for two `released` events, and asserts the order of the four `claimed`/`released`
events for the two cards. Red first: the first test must fail when `slots: runs` is removed
from `startRunner`'s options in `main.ts` (the default is two, so both are claimed at once),
and pass with it; the file is restored afterwards and `git diff --stat packages/daemon/src/main.ts`
is empty. The second test is the control and passes either way, which the run record says.

The comment block in `main.ts`: the rule at the top, and one clause beside each handoff. The
existing comments beside the sweep (024) and the runner block are extended rather than
replaced.

Decisions resolved from the repository: observe the count through claim ordering rather than
by counting worktrees or reading the runner's state, because CLAUDE.md's tests assert what a
member sees on the cards, and the ordering is on the cards; do not add a test-only driver to
observe the run limit through the daemon, because `SKELCREW_AGENT` accepting a third value
would be a switch in production code for the sake of a test, and `none` is already that switch
for everything it can reach; state the rule in the file rather than in `CLAUDE.md`, because the
rule is about one file and CLAUDE.md's definition of done already says tests assert observable
behaviour.

## Acceptance criteria

1. `bun run check` passes; no test spawns a real coding agent or calls a model.
2. A process test starts the daemon with the runner on, `SKELCREW_AGENT=none` and
   `SKELCREW_RUNS=1`, moves two cards to Spec, and asserts from the subscriber's events that
   the second card's `claimed` follows the first card's `released`. With `slots: runs` removed
   from `main.ts` the test fails; with it, it passes. The run record quotes the red output.
3. A process test starts the same daemon with `SKELCREW_RUNS` unset and asserts both cards'
   `claimed` events precede the first `released`.
4. `main.ts`'s header comment states the rule, and each of the five handoffs (driver, run
   limit, runs, poll interval, sweep's runner id) carries a comment naming the process test
   that observes it, or, for the run limit, why none can and where it is observed instead.
   Checkable by reading `main.ts` against the list in this spec's *Current behavior*.
5. No production behaviour changes: `git diff` of `main.ts` is comments only, and the
   existing process tests pass unchanged.

## Tests

- Criteria 2 and 3 in `process.test.ts`, in the shape of 024's daemon-level tests (`:440`).
- Criterion 5 is the existing suite.
- The run record lists, for each of the five handoffs, the test that observes it — the table
  criterion 4's comments are written from.

## Out of scope

- **Observing the run limit through the daemon.** Needs an agent session; `none` has none, and
  a test-only driver is rejected above. `run.test.ts` covers the limit against the run.
- **A process test for every future setting**, written now. The rule in `main.ts` is what
  makes the next one get written.
- **Changing what any setting does, or its default.**
- **`SKELCREW_DIR` and `SKELCREW_NOTIFY`**, already observed (`:141`, `:417`, `:818`–`:975`).
