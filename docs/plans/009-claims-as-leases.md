# 009 — Claims as leases: run record

## Plan

1. Red, shared: `phases.test.ts` asserts `claimable` is true for `spec` and `code` only.
   First failure: `claimable` is `undefined` on every phase.
2. Green, shared: `claimable` on `PhaseDef`; `Claim`, `Card.claim`, the three events
   (`claimed`, `released`, `run_interrupted`), and the TTL constants in `types.ts`; the
   three methods in `protocol.ts` and `METHOD_NAMES`.
3. Red then green, core: a `claims` describe in `core.test.ts` over a core opened with an
   injected clock (claim, renewal, conflict, clamping, non-claimable phase, archived card,
   expiry with interrupted-then-claimed, heartbeat, release, clear-on-move and
   clear-on-archive with exact event order, the non-holder move conflict, the sweep);
   `db.test.ts` gains migration from the 010 schema and persistence of a claim. Migration 3
   adds one JSON column `claim`; `openCore(path, { now? })` routes every clock read through
   the option; `claimCard`, `heartbeat`, `releaseCard`, `sweepClaims`, and the release
   hooks in `moveCard` and `archiveCard`.
4. Red then green, wire: `sweepClaims` as a `null` stand-in in the parity test; round trips
   as owner and agent; wrong-shaped params; the three events on the stream. Handlers in
   `server/protocol.ts`.
5. Red then green, daemon: `process.test.ts` spawns the daemon, claims with the minimum TTL,
   and waits a bounded time for `run_interrupted` on a subscription. `main.ts` runs
   `sweepClaims()` on a five-second interval, cleared on shutdown.
6. Red then green, CLI: `claim`, `heartbeat`, `release` commands; `*` / `~` markers behind
   the attention markers in `ls`; the claim in the `show` header and the three activity
   summaries.
7. `docs/MILESTONES.md`: one status bullet for `Card.claim`, unlogged heartbeats, and the
   sweep interval.
8. `bun run check`, then the criteria against the tests and the diff.

Files: `packages/shared/src/{phases,types,protocol,index}.ts` and `phases.test.ts`;
`packages/daemon/src/core/{db,core}.ts` and their tests; `packages/daemon/src/server/protocol.ts`
and `protocol.test.ts`; `packages/daemon/src/main.ts` and `server/process.test.ts`;
`packages/cli/src/{main,render}.ts`, `packages/cli/src/commands/{claim,heartbeat,release}.ts`,
`packages/cli/src/cli.test.ts`; `docs/MILESTONES.md`; this file.

## Decisions the spec left open

- **`Claim` carries `ttlSeconds`.** The spec writes the claim as `{ by, claimedAt,
  expiresAt }` and has `heartbeat` extend "by its original TTL"; nothing in those three
  fields holds the TTL once a heartbeat has moved `expiresAt`. Storing it on the claim is
  the plain fix; the alternative (reading the last `claimed` event back) is a query per
  heartbeat for the same number.
- **A renewal through `claimCard` applies the TTL it was given** (default 120) and keeps
  `claimedAt`; `heartbeat` uses the claim's stored TTL. Both record nothing.
- **One JSON column `claim`**, like `attention`. The claim is written with a conditional
  `UPDATE` (`claim IS NULL`, lapsed, or held by the actor) whose row count is checked, so
  the atomicity does not depend on the transaction alone.
- **A lapsed, unswept claim is released, not interrupted, by a move or an archive**, as the
  spec's wording says; `claimCard` over it records `run_interrupted` first, as the spec
  says for that path. The stored claim is what `releaseCard` acts on, so the holder or the
  owner may release a lapsed one and it records `released`.
- **The claim conflict on `moveCard` comes after the exit gate and records nothing.** An
  agent's gated move still logs `move_rejected`; a non-holder's move of a live-claimed card
  out of `code` is a `conflict` with no event ("nothing changes").
- **`released.data.reason` is `string | null`**, present either way, so the wire shape is
  stable; a given reason is validated like a note (non-empty, comment cap).
- **`ttlSeconds` must be an integer**; anything else is `invalid` before clamping.
- **Every write bumps `updated_at`**, heartbeats included, matching the existing rule that
  each `UPDATE` sets it; the activity log, not `updatedAt`, is what "records nothing" is
  about.
- **The sweep interval lives in `main.ts`** as a constant; the daemon is its only user.
- **CLI output**: `claim` prints the holder, the expiry to the minute, and the TTL in
  seconds; `show` prints `claim:   <holder> (since …, expires …, lapsed)` with the last
  word only when the expiry has passed by the CLI's clock; `ls` marks `*` live and `~`
  lapsed after the attention markers.

## Run notes

- Red was as planned: `claimable` undefined on every phase; then `core.claimCard is not a
  function`; then `-32601 method_not_found` for `claimCard`; then the CLI exiting 2 on
  `claim` and printing a blank marker; then no `run_interrupted` from the spawned daemon
  within the budget.
- The CLI's `~` case is produced by opening the test core on a clock offset from the
  CLI's real one (`clockOffsetMs`), so the lapse is real to the CLI without a sleep.
- The daemon sweep test claims with the minimum TTL (10 s) and waits at most 20 s past the
  lapse; it took about 10 s in the run. `bun run check` went from 2.6 s to 13.4 s.
- `biome ci` flagged three files for formatting after the first green; `bun run fix`
  rewrapped them and nothing else.

## Review round 1

CHANGES REQUESTED: one Important, three Minors, all taken. Judgement calls (a), (b), (c),
(d), (f), (g) accepted as reviewed; (e) resolved the reviewer's way (Minor 1).

- **Important — `archiveCard` failed open on someone else's live claim.** An agent that
  was not the holder could archive a card another member held live, ending their run and
  releasing the lease under them, with no equivalent of the move path's guard. Now
  `archiveCard` applies the same check as `moveCard`: a live claim held by someone else is a
  `conflict` naming the holder for an agent, nothing is written; the owner and the holder
  may archive. Test: "a non-holder agent may not archive a card with a live claim; the
  owner may, and it releases".
- **Minor 1 — a lapsed claim cleared by a move or an archive is an interruption.**
  `releaseOn` now records `run_interrupted { by, expiresAt }` attributed to the former
  holder when the claim's `expiresAt` is at or before the clock, and `released` only for a
  live one, so a run that died is never logged as a clean handoff even inside the sweep
  window. The event follows `card_moved` / `card_archived`, where the release would have
  gone. The earlier decision "released, not interrupted, by a move or an archive" above is
  superseded. Tests: the lapsed-move test now expects the interruption, plus "archiving over
  a lapsed claim records the interruption, not a release".
- **Minor 2 — `releaseCard` validates `reason` before the unclaimed early return**, so an
  empty or oversized reason is `invalid` whatever the card's state. Test covers both
  branches.
- **Minor 3 — `docs/MILESTONES.md`** now says a renewal via `claimCard` takes the TTL it is
  given and `heartbeat` is the call that preserves it, and records the archive guard and
  Minor 1's interruption rule.

## Post-review minors

Round 2 APPROVED with two Minors, both taken.

- **`releaseCard` over a lapsed claim** now goes the same way as every other path that
  clears one: `run_interrupted { by, expiresAt }` for the former holder, no `forbidden` for
  anyone, since a lapsed claim counts as absent. A live claim is unchanged (holder or owner
  releases, others `forbidden`). Test: "releasing a lapsed claim records the interruption
  for the former holder, whoever asks", with the injected clock, for a non-holder agent and
  for the owner. A reason given on a lapsed release is still validated but has no event
  to ride on.
- **The sweep timer has an error boundary.** `packages/daemon/src/sweep.ts` exports
  `sweepTick(core, warn)`: the tick's exception is written as one stderr line,
  `skelcrew daemon: sweep failed: <message>`, and the timer keeps running; `main.ts` calls
  it from `setInterval`. Unit-tested in `sweep.test.ts` with a throwing fake core (Error
  and non-Error throws) and a succeeding one.

## Review outcomes (orchestrator)

- Round 1: CHANGES REQUESTED — Important: a non-holder agent could archive a card another
  member held with a live claim (the move path guarded this, archive did not). Fixed with
  the same conflict check. Minors taken: a move/archive over a lapsed claim records
  `run_interrupted`; `releaseCard` validates its reason before the unclaimed return; the
  MILESTONES bullet reworded (renewal via `claimCard` takes the given TTL).
- Round 2 (fresh reviewer): APPROVED. Confirmed no remaining path lets a non-holder agent
  end, shorten, or take over a live claim; exact-expiry instant consistent everywhere. Two
  Minors, both fixed after approval and covered by verification: `releaseCard` over a
  lapsed claim now records the interruption for the former holder (no `forbidden`); the
  daemon's sweep tick has an error boundary (`sweep.ts`) so a throwing sweep costs one
  tick, not the process.
