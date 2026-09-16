# 025 — Several cards at once

Run record for `docs/specs/025-several-cards-at-once.md`.

## The change, in steps

1. **`runner.ts`: the setting.** `RUNS_DEFAULT = 2`, `RunnerOptions.slots`, and
   `runsFromEnv(env)` shaped like `runLimitFromEnv` — unset and empty are the default, anything
   that is not a positive whole number throws naming `SKELCREW_RUNS`.
2. **`runner.ts`: runs leave the pump.** `live: Map<number, Promise<void>>`; `scan` claims ready
   cards in id order while `live.size < slots` and starts each `run(id)` detached. The pump
   stays one job at a time.
3. **`runner.ts`: one setup at a time.** A mutex (`exclusive`) the runner owns wraps the base
   branch, the branch creation and `ensureWorktree` in `run`, and the allowlist read, the
   branch-head read, the run log and the run-start comment in `runOnce`. `reconcile` takes it
   too. The agent session, the contract and the endings run outside it. A caller that finds the
   mutex free enters synchronously, because the first job of the runner's life goes through it
   and today's tests stop the runner in that same turn.
4. **`runner.ts`: teardown waits.** `teardown(cardId)` returns at once when the card is back in a
   claimable phase, else awaits `live.get(cardId)`, re-reads the card, and removes the worktree
   under the setup mutex; `stop()` awaits `pumping` and then every live run.
5. **`main.ts`** reads `runsFromEnv(process.env)` with the other settings and passes `slots`.
6. **`runner.test.ts`** gains criteria 3–8 beside the existing one-at-a-time case, with a
   scripted fake driver (the same boundary `run.test.ts` fakes), a barrier, and a per-card hold.
   Criterion 2's parser case goes there too.

## Files expected to change

- `packages/daemon/src/runner/runner.ts`
- `packages/daemon/src/main.ts`
- `packages/daemon/src/runner/runner.test.ts`
- `packages/daemon/src/server/process.test.ts`

## Decisions the spec left open

- **`runsFromEnv` lives in `runner.ts`**, not `run.ts`, because the setting is the runner's
  (`RunnerOptions.slots`) rather than a run's; criterion 2's parser case goes to
  `runner.test.ts` with it, which the spec's *Tests* section allows.
- **A settled run enqueues the scan that fills its slot.** The spec says the run's *release*
  triggers it through `onEvent`. It cannot: `released` is emitted synchronously from inside the
  run, so the scan it queues still counts that run and sees no free slot. The settle handler
  deletes the entry and scans there instead — unless the card still carries a claim of ours,
  which is a lease that lapsed under a working run and that the sweep reports as
  `run_interrupted`; scanning over that would start a second run of the card the first has just
  given up on, and both would be this same member.
- **The pump's "am I running" flag is now a boolean, cleared inside `pump`.** `pumping ??=
  pump().finally(...)` loses a job enqueued in the turn between the pump running out of work and
  its `finally` clearing the handle. With runs inside the pump that turn never came; with runs
  detached it arrives all the time — review round 2 measured the window opening 12 times in one
  suite run. **No test in this branch guards it, and the record first claimed one did.** The
  failure I saw was real but at an intermediate state of this work — slots counted by held
  claims, with no scan queued when a run settled — where "with git unavailable … and the runner
  keeps going" failed with card 2 never claimed, which is what sent me looking. In the final
  build the settle-scan queues another scan after every run, so the old handle passes the whole
  suite (round 2 put it back and got 769 pass). The change stays as a defensive one: the dropped
  job is recovered by any later event, and on a quiet daemon there is no later event, so a ready
  card would sit unclaimed. A deterministic test would have to pin microtask ordering; round 2
  and I agree that is not worth it.
- **Two existing cases gain `slots: 1`**, not one. The spec named the id-order case; the
  `stop()` case ("takes no further card") also pins one claim at a time — with two slots its
  second card is claimed before `stop()` is called. `slots: 1` is what `SKELCREW_RUNS=1`
  promises and leaves both assertions exactly as they are.
- **`teardown` does not take the setup mutex**, only the live run's promise, as the spec's
  implementation approach says. `reconcile` calls `teardown`, and a mutex that is not
  reentrant would deadlock there. *(Reversed in review round 1, below.)*
- **MILESTONES is not touched in this run** (the coordinator's instruction): 023 and 024 are in
  flight and the last to land writes the entry.
- **Criterion 2's parser case was written after `runsFromEnv`**, not before it: the function
  went in with the rest of the `runner.ts` edit. Its red was verified afterwards by stubbing the
  function to `return RUNS_DEFAULT` (`"1"` then answered 2 and none of the five bad values
  threw) and restoring it. Every other behaviour here was red first.

## Review round 1

Two Important findings, both about `teardown`; both fixed, each with a test written first that
fails on the unfixed code and passes on the fixed one.

1. **The wait came before the "did the card come back" check.** A scan ahead of the teardown in
   the queue can start a fresh, healthy run of that same card, and `await live.get(cardId)` then
   held the serial pump for the length of *that* run — up to the hour a run may take — so no
   scan ran and no slot was refilled, silently. The check is now read before the wait as well as
   after it; both are needed, only the order was wrong. Test: *a teardown whose card came back
   does not hold the pump for that card's new run* — with the early check removed it times out
   waiting for the next card to be claimed.
2. **Teardown's git stayed outside the setup mutex.** `worktreeRemove` takes the repository lock
   that `worktreeAdd` takes, and with runs detached the pump can be inside a teardown while a
   just-started run is inside its setup — which the spec's "never contended by the runner
   itself" and the header doc both said could not happen. `teardown` now runs its removal under
   `exclusive`, after the wait for the live run and never while holding the mutex (a run being
   waited on needs the mutex itself). `reconcileAll` calls the new inner form `teardownCard`,
   since it already holds the mutex and `exclusive` is not reentrant. Test: *a teardown's
   removal waits for a run's setup* — a recording `Git` that holds `createBranch` for 300 ms
   shows `enter worktreeRemove` inside that window on the unfixed code.

The header doc at the top of `runner.ts` is rewritten to say what is actually serialised: the
repository is touched by one card at a time, setup and removal alike, at every slot count.

## Review round 2

Approved, with three Minor findings. Two were prose and are fixed here; no code or test changed.

1. **"`SKELCREW_RUNS=1` is 006's behaviour exactly" was false**, in the header doc and in the
   spec's own line 51. `slots` gates how many claims are held and nothing else — `begin` detaches
   the run at every slot count — so at one slot the pump goes on while the run is live, and round
   2 proved by execution that a teardown of another card completes during a live session, which
   006's serial pump would have made wait. The header now says one slot is 006's *dispatch* and
   not the whole of 006, and names the interleaving that stays. **The spec's wording is wrong in
   the same way**; it is frozen this round, so this is the record of it for landing.
2. **The pump-handle justification named coverage that does not exist.** Corrected in the
   decision above: the claim is now that no test guards it, where the failure I did see happened,
   and why a deterministic test is not worth writing.
3. `main.ts` passing `slots` is not covered by a test of its own — for the pull request
   description, not a change here.
