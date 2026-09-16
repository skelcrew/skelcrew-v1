# 025 — Several cards at once

Milestone 025 in `docs/MILESTONES.md`: the owner's stated goal after the first real cards, the
feeling of a team of developers rather than one contractor. This spec grants nothing new; it
lets the runner hold more than one claim.

## Goal

Several cards should move at the same time. Today the runner works one card at a time: it
claims, runs the card's whole loop, releases, and only then looks for the next ready card. With
three ideas moved to Spec, two of them wait for the third, and the owner's queue fills one card
at a time. After this spec the runner holds up to N claims, each card in its own worktree with
its own agent, and a freed slot is filled from the ready cards on the next scan. Every gate,
contract and playbook is per card already and stays exactly as it is. N is small and
configurable; two by default, because two is a team and one is today.

## Current behavior

- `packages/daemon/src/runner/runner.ts:198-250`: a job queue (`reconcile`, `scan`, `teardown`)
  drained by `pump`, one job at a time. `scan` (`:254-263`) lists ready cards in id order and
  `await`s `run(id)` for each, so the pump is held for the whole of a run and no other job — a
  teardown, another scan — happens until the run ends. The doc says one job at a time on
  purpose, from 006.
- `run(id)` (`:265-590`) does everything for one card: claim, heartbeat, base branch, branch,
  worktree (`ensureWorktree`), allowlist scan, run log, the Code/review loop (019), endings,
  `clearInterval` in `finally`. All of its state is local to the call except the shared
  `stopping` signal, the `attention` helper (stateless) and the `core`.
- `stop()` (`:722-728`) sets `stopped`, aborts `stopping`, and awaits `pumping` — which, with a
  run in flight, is that run.
- `teardown(cardId)` (`:622-640`) is a pump job queued by a move or an archive; it runs after
  the live run has ended because the pump is serial, and relies on that: a worktree is never
  removed under a live run.
- `runner.test.ts:393`, "two cards made ready together run in id order, one claim at a time":
  pins `maxHeld === 1` and the exact interleaving of two runs' events.
- `packages/daemon/src/runner/git.ts`: `createBranch`, `worktreeAdd`, `worktreePrune` and
  `worktreeRemove` each spawn git against the one repository; git takes the repository's lock
  for ref and worktree writes, so two at once can fail with a lock error.
- `main.ts:36`, `runLimitFromEnv` from `run.ts:146`: the pattern for a daemon setting — an
  environment variable, a default constant, and a daemon that stops on a bad value.

## Desired behavior

**Up to N cards run at once.** With N slots and more ready cards than slots, a scan claims the
oldest ready cards (id order, as today) until the slots are full. Each claimed card gets its
own worktree, branch, run log and agent, and its loop proceeds as it does today. When a run ends
and releases its claim, the next scan fills the freed slot from the ready cards. `skelcrew ls`
shows N cards `running` at once (024's column, or today's `*`).

**N is `SKELCREW_RUNS`.** Default two. A value that is not a positive integer stops the daemon
before it creates anything, the way `SKELCREW_RUN_MINUTES` does. `SKELCREW_RUNS=1` is today's
behaviour exactly.

**Setup is one at a time; sessions are not.** Creating a branch, adding a worktree and reading
the allowlist happen for one card at a time, so git's repository lock is never contended by
the runner itself. The agent sessions — where the minutes go — overlap freely.

**Everything per card stays per card.** Each run has its own claim and heartbeat, its own
permission question, its own review budget (019), its own run log and its own endings. One
run's failure, question, time limit or abandonment does not touch another's. A card moved away
while its run is live still ends as an abandonment, and its worktree teardown waits until that
run has ended, never removing a worktree under a live session.

**Stopping stops all.** `stop()` tells every live run to stop; each ends as `daemon stopping`
on its own card and releases its claim; `stop()` resolves after the last one.

**What is shared is the console.** N runs warn into the daemon's stderr interleaved. The card
is the record and this is only the operator's console; recorded, not handled.

## Implementation approach

`runner.ts`:

- `RunnerOptions.slots?: number`, default `RUNS_DEFAULT = 2`; `runsFromEnv(env)` beside
  `runLimitFromEnv`'s shape, read in `main.ts` with the other settings and passed as `slots`.
- Runs leave the pump. `scan` no longer awaits `run(id)`: it counts live runs, claims ready
  cards in id order while `live.size < slots`, and starts each `run(id)` detached, recording its
  promise in `live: Map<number, Promise<void>>` and deleting it when it settles. The pump goes
  on to its next job at once, so a teardown or a later scan no longer waits behind a run. A
  run's release already triggers a scan through `onEvent`, which is what fills a freed slot.
- The setup steps inside `run` — resolve base, create branch, `ensureWorktree`, `allowlistFor`,
  `createRunLog`, the run-start comment — go through one mutex (a promise chain the runner owns),
  so at most one card is in setup at a time. The agent session, the contract, the review loop
  and the endings run outside it. `reconcile` runs before the first scan, as today, and also
  takes the mutex so a startup prune cannot cross a first run's `worktreeAdd`.
- `teardown(cardId)` awaits `live.get(cardId)` before touching the worktree. Today the serial
  pump gave that ordering for free; with detached runs it has to be explicit.
- `stop()` awaits `Promise.all(live.values())` as well as `pumping`. `stopping` is already one
  signal every run listens to.

The claim itself is what makes N safe: `claimCard` is atomic in the core, `isReady` reads the
card's claim, and a card claimed by one run is not ready for the scan's next iteration. Nothing
in `run(id)` reads runner-wide state that another run writes.

Decisions resolved from the repository: id order stays the scheduling order (006; the milestone
says no priority); the default is two rather than one because the milestone is the owner's
stated goal and one would ship the feature off; the setup mutex is the runner's rather than
retries around git, because the collision is the runner's own doing and a retry would paper
over the lock error 006 chose to surface. `runner.test.ts`'s one-claim-at-a-time case passes
`slots: 1` and is otherwise unchanged; it is what `SKELCREW_RUNS=1` promises.

## Acceptance criteria

1. `bun run check` passes; no test spawns a real coding agent or calls a model.
2. `runsFromEnv({})` is `2`; `SKELCREW_RUNS=3` is `3`; `0`, `-1`, `1.5`, `abc` and `" "` throw
   naming the variable; the daemon started with `SKELCREW_RUNS=every` exits 1 with that message
   before creating its data directory (`process.test.ts`, the shape of the `SKELCREW_RUN_MINUTES`
   case).
3. With two slots and three cards made ready together: cards 1 and 2 are both claimed before
   either is released, card 3 is claimed only after one of them is released, and all three end
   on the owner with their own worktree present. `maxHeld` is 2.
4. With one slot the existing case holds unchanged: id order, `maxHeld` 1, the exact event
   interleaving it asserts today.
5. With two slots, a `Git` wrapper recording entry and exit of `createBranch`, `worktreeAdd` and
   `worktreePrune`: no two of those calls overlap across the two runs, while the two scripted
   agent sessions do overlap (each waits on a barrier the test releases only once both are
   live).
6. With two slots and two live runs, the owner moves card 1 to Done mid-run: card 1's run ends as
   an abandonment, its worktree is torn down only after that run has ended (asserted by the
   teardown comment following the abandonment comment, and the session's driver having
   returned), and card 2's run is unaffected: no comment, no release, its driver still live until
   the test ends it.
7. With two live runs, `stop()`: both cards carry `run aborted: daemon stopping`, both claims are
   released, and `stop()` resolves only after both drivers have returned.
8. Two live runs post distinct run log paths in their run-start comments, and each run's
   permission question, when its driver asks, lands on its own card only.
9. `runner.ts`'s doc records: jobs stay serial and runs are detached; setup is serialised and
   why; teardown waits for the live run; `SKELCREW_RUNS=1` is 006's behaviour. MILESTONES marks
   025 landed at landing.

## Tests

- Criteria 3–8 in `runner.test.ts` beside the existing one-at-a-time case, with the scripted
  driver and a barrier helper so two sessions can be held live together.
- Criterion 2 in `run.test.ts` or `runner.test.ts` for the parser, and `process.test.ts` for the
  daemon.
- Existing 006–021 runner coverage passes unchanged except the one case that gains `slots: 1`.

## Out of scope

- **A second runner or a second machine.** The internal seam, MILESTONES's "Later".
- **Priority or dependencies between cards.** Ready cards run oldest first, as today.
- **A watcher for a run that is alive but stuck.** N runs make the gap N times wider; it is
  still its own milestone.
- **Per-card resource limits** (CPU, disk) and any change to the run time limit, which stays
  per run.
- **Any change to gates, contracts, playbooks or the allowlist.** N agents each get exactly
  what one gets today.
- **Retrying git lock errors.** Setup is serialised instead.
