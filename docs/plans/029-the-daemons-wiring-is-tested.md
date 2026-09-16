# 029 — The daemon's wiring is tested

Run record. Spec: `docs/specs/029-the-daemons-wiring-is-tested.md`.

## Plan

1. Two process tests in `packages/daemon/src/server/process.test.ts`, beside 025's refusal
   test, both starting a real daemon with the runner on and `SKELCREW_AGENT=none`:
   - `SKELCREW_RUNS=1`: two cards moved to Spec, the second card's `claimed` comes after the
     first card's `released`.
   - `SKELCREW_RUNS` unset (default two): both `claimed` events precede the first `released`.
2. Red first: delete `slots: runs` from `startRunner`'s options in `main.ts`, show the first
   test failing, restore the file, show it passing. The second test is the control and passes
   either way.
3. A comment block at the top of `main.ts` stating the rule, and one clause beside each of the
   five handoffs naming the test that observes it (or, for the run limit, why none can).
4. `bun run check`, then commit.

Files expected to touch: `packages/daemon/src/server/process.test.ts`,
`packages/daemon/src/main.ts`, this run record.

## Baseline

`bun install` first (a fresh worktree has no `node_modules`; without it 16 tests error on
`Cannot find module '@skelcrew/shared'`). Then:

```
$ bun test
 797 pass
 0 fail
Ran 797 tests across 29 files. [80.35s]
```

## What observes each handoff

| Handoff in `main.ts` | Observed by |
| --- | --- |
| `selectAgent` → the driver import | `process.test.ts`: "an unknown SKELCREW_AGENT stops the daemon before it creates anything"; "with SKELCREW_AGENT=claude the daemon loads the driver and its playbooks and serves" |
| `runLimitFromEnv` → `startRunner({ runLimitMs })` | No process test can: under `SKELCREW_AGENT=none` a run has no agent session, so the limit never fires. `run.test.ts`: "SKELCREW_RUN_MINUTES sets the limit; unset is an hour; anything else is refused", and the limit itself against a run (`runLimitMs: 50`) |
| `runsFromEnv` → `startRunner({ slots: runs })` | `process.test.ts`: "with SKELCREW_RUNS=1 the daemon holds one claim at a time…" and its control "with SKELCREW_RUNS unset the daemon claims two cards at once…"; the refusal in "a SKELCREW_RUNS that is not a count stops the daemon" |
| `mergePollIntervalFromEnv` → `setInterval(poll.tick, mergePollMs)` | `process.test.ts`: "the poll asks gh on its interval…" (with `mergePollSeconds: "1"`) |
| runner member id → `sweepTick(core, warn, runnerId)` | `process.test.ts`: "the daemon's sweep takes an interrupted run's own question with it…", and its counterpart "with SKELCREW_RUNNER=0 a lapse withdraws nothing" |

## Decisions the spec left open

- The two cards are moved to Spec with two sequential `moveCard` calls on one client, not
  concurrently: the ordering assertions are per card, and two socket round trips are far
  shorter than the run's async worktree setup that follows the synchronous claim.
- The tests wait for two `released` events (the ending of a no-playbook run) and then assert
  on the index of each of the four `claimed`/`released` events, rather than on wall-clock
  timing.
- `SKELCREW_RUNNER` is named in the runner block's comment beside the five handoffs, since the
  block it guards is where three of them live.

- The header block sits above the imports, the way `announce.ts` and `runner/runner.ts` carry
  their module comments, rather than between the imports and the first constant.

## Red

Both tests written first. Then `slots: runs` deleted from `startRunner`'s options in
`main.ts` (`git diff --stat packages/daemon/src/main.ts` → `1 file changed, 1 deletion(-)`):

```
$ bun test packages/daemon/src/server/process.test.ts -t "SKELCREW_RUNS"

708 |   expect(claimsAndReleases(events)).toEqual([
                                          ^
error: expect(received).toEqual(expected)

@@ -2,5 +2,5 @@
    "claimed 1",
-   "released 1",
    "claimed 2",
+   "released 1",
    "released 2",

- Expected  - 1
+ Received  + 1

      at .../packages/daemon/src/server/process.test.ts:708:37
(fail) with SKELCREW_RUNS=1 the daemon claims the second card only after it has released the first

 2 pass
 23 filtered out
 1 fail
```

That is the intended reason: with the handoff gone the daemon runs on the default of two
slots, so card 2 is claimed while card 1's run is still live. The control test — `SKELCREW_RUNS`
unset — passed under the mutation too, which is what a control is for.

`main.ts` restored (`git diff --stat packages/daemon/src/main.ts` prints nothing):

```
$ bun test packages/daemon/src/server/process.test.ts -t "SKELCREW_RUNS"
 3 pass
 23 filtered out
 0 fail
```

Repeated five times, all green, to check the ordering is not a race.

## Checks

```
$ bun run check
  biome ci .                 Checked 91 files. No fixes applied.
  typecheck                  shared, cli, daemon all exited 0
  bun test                   799 pass, 0 fail, across 29 files
```

797 tests before, 799 after: the two new process tests.

`bun run check:harness` was not run — no playbook and no entry of the runner's allowlist
changed.
