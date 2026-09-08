# 009 — Claims as leases

## Goal

Let work be handed out without anyone coordinating, and let a dead worker be noticed. A
member takes a card by claiming it; the claim is a lease that expires unless renewed by
heartbeat, so a crash, a kill, or a sleeping laptop all end the same way: the lease lapses,
the card returns to its queue, and a first-class "run interrupted" event says so on the card.
Two runners can never start the same card, and nothing stays stuck in "someone is on this"
forever. The runner (006) is the first consumer, but an agent in a live session claims through
the same CLI, so this stays a member primitive rather than a runner-only one. With 010's
attention request, this also completes the card's derived status: queued, running, or
waiting on you.

## Current behavior

Nothing represents who is working on a card. The core (`packages/daemon/src/core/core.ts`)
has cards, phases, members, activity, refs, archiving, and after 010 an attention request on
the card; a `Card` has no claim. Two agents can both act on one card and only the activity
log would show it. The prototype spike had `claimed_by` / `claim_expires_at` columns, an
atomic claim via a conditional `UPDATE`, `heartbeat`, `releaseCard`, and a `startSweeper`
timer that expired stale leases with a `claim_expired` event
(`prototype:packages/board/src/core.ts`); `docs/MILESTONES.md` lists "lease claims +
sweeper" among the things that worked as designed, and "two daemons sharing one board
coordinated by claims alone, no collisions".

The daemon process (`packages/daemon/src/main.ts`) opens the core, starts the server, and
waits for a signal; it runs no periodic work. The protocol's method table
(`packages/shared/src/protocol.ts`) and the parity test
(`packages/daemon/src/server/protocol.test.ts`, with a `standIns` map for core methods that
reach the wire under another name or not at all) will need the new methods. The CLI
(`packages/cli/src/`) has one module per verb; after 010, `ls` has a marker column before
the id (`!` waiting on you, `?` waiting on someone else).

`PHASES` in `packages/shared/src/phases.ts` declares each phase's display name, artefact, and
`exit` rule. Nothing says which phases are places where a member works.

`docs/MILESTONES.md` places this after 010 and before 006, records the decision that
queued / running / waiting is a derived status rather than a phase, and carries the spike's
"stage lanes should be claim-sources, not work-sites" finding: approval ends the human
gesture, the runner claims from the queue, and position plus status always reflect true state.

## Desired behavior

### In the model

- `PHASES` gains `claimable`: true for `spec` and `code`, false for the rest. A card is
  claimable when its phase is claimable, it is not archived, and it has no live claim.
- A card has at most one claim: `{ by, claimedAt, expiresAt }`, exposed on the `Card` as
  `claim` (or `null`). A claim is live while `expiresAt` is in the future.
- `claimCard(id, { ttlSeconds? }, actor)` is atomic: it succeeds when the card is claimable,
  or when the actor already holds the claim (renewing it), and otherwise fails with
  `conflict` naming the holder and the expiry, or `invalid` when the phase is not claimable
  or the card is archived. A new claim records `claimed { ttlSeconds, expiresAt }`; a renewal
  through `claimCard` records nothing. `ttlSeconds` defaults to 120 and is clamped to 10
  through 3600. An expired claim counts as absent: claiming over it succeeds and records
  `run_interrupted` for the previous holder first, then `claimed`.
- `heartbeat(id, actor)` extends a live claim held by the actor by its original TTL and
  records nothing; by anyone else, or when no live claim exists, it fails with `conflict`.
- `releaseCard(id, { reason? }, actor)` clears the claim and records `released { reason }`.
  The holder or the owner may release; another member gets `forbidden`. Releasing an
  unclaimed card is a no-op that records nothing.
- A `moveCard` that changes the phase clears any claim and records `released { reason:
  "moved" }` after `card_moved`, in the same transaction. An agent that is not the holder
  cannot move a card with a live claim held by someone else: `conflict`. The owner always
  can. `archiveCard` clears a claim the same way with `reason: "archived"`.
- `sweepClaims()` expires every lapsed claim: each records `run_interrupted { by,
  expiresAt }` attributed to the former holder, and the card's `claim` becomes `null`. It
  returns the affected card ids. Nothing else changes; the card stays in its phase, which is
  what "returns to its queue" means now that the queue is a status.
- `listCards` and `getCard` report `claim` exactly as stored; a lapsed claim not yet swept
  is still visible with its past `expiresAt`, so a reader can tell "lapsed, not yet
  swept" from "live".

### In the daemon

The daemon calls `sweepClaims()` every five seconds while running; the events reach
subscribers like any other. Sweeping is not a member action and has no wire method.

### On the wire

`claimCard`, `heartbeat`, and `releaseCard` are protocol methods with the same names and
named params minus `actorId`; `sweepClaims` is a named exception in the parity test. The
three new events flow through the `activity` stream.

### In the CLI

- `skelcrew claim <id> [--ttl <seconds>]` claims as the invoking member and prints the expiry;
  `skelcrew heartbeat <id>` renews; `skelcrew release <id> [-m <reason>]` releases.
- `skelcrew ls` marks a card with a live claim `*` in the marker column; a lapsed unswept
  claim shows `~`. Attention markers from 010 take precedence when both apply. `skelcrew
  show` prints the claim (holder, since, expires) in the header block and the new events in
  the activity.
- `skelcrew queue` (010) is unchanged; the runner's queue of claimable cards is `ls`
  filtered by eye until 006 needs more.

## Implementation approach

### Where it lives

- `packages/shared/src/phases.ts` — `claimable` on `PhaseDef`. `packages/shared/src/types.ts`
  — `Claim`, `Card.claim`, the three event types, `CLAIM_TTL_DEFAULT_SECONDS`,
  `CLAIM_TTL_MIN_SECONDS`, `CLAIM_TTL_MAX_SECONDS`. `packages/shared/src/protocol.ts` — the
  three methods.
- `packages/daemon/src/core/db.ts` — the next migration adding claim columns to `cards`
  (numbered after whatever 010 added). `core.ts` — `claimCard`, `heartbeat`, `releaseCard`,
  `sweepClaims`, and the clear-on-move and clear-on-archive hooks inside the existing
  transactions, next to 010's attention resolution.
- `packages/daemon/src/server/protocol.ts` — handlers and param shapes.
- `packages/daemon/src/main.ts` — the five-second sweep timer, cleared on shutdown.
- `packages/cli/src/commands/{claim,heartbeat,release}.ts`, the `ls` markers and `show`
  header in `render.ts`.
- Tests colocated as before; time-dependent behaviour is tested by passing `ttlSeconds` at
  the minimum and by an injectable clock on the core (`openCore(path, { now? })`) so expiry
  is exercised without sleeping.

### Decisions resolved from repository context

- **Claims live on the card, like attention.** One holder per card is the whole point;
  a table would only allow what must not happen. The prototype stored it the same way.
- **Claimable is a property of the phase.** `AGENTS.md`: work exists because a card entered
  a claimable phase. Spec and Code are the phases where a run happens; Idea, PR, and Done
  are the owner's. Declaring it on `PHASES` keeps every client and the runner agreeing
  without a schema read, matching how `exit` is declared.
- **Expiry is enforced by the core's checks and by a sweep, not by a timer per claim.**
  A conditional `UPDATE` makes claiming atomic under SQLite's serialization, and treating a
  lapsed claim as absent at claim time means correctness never depends on the sweep. The
  sweep exists so a lapsed run becomes visible promptly even when nobody tries to claim
  the card, which is the "run interrupted" event the milestone asks for. Five seconds is
  the prototype's interval and is negligible load.
- **Heartbeats and renewals record nothing.** A heartbeat every minute per running card
  would drown the log the owner reads. The claim's `expiresAt` on the card is the
  observable; "everything observable" is satisfied by the state, and every transition
  (claimed, released, interrupted) is logged.
- **A phase change releases the claim.** The claim is "I am working on this card in this
  phase"; when the card moves, the work in that phase is over. Making the release part of
  the move keeps position and status consistent without a second call, and matches how
  010's attention resolves on a move.
- **A non-holder agent cannot move a claimed card.** Otherwise a second agent could hand
  off someone else's half-done work. The owner is exempt, as everywhere.
- **Owner may release anyone's claim.** The exit ramp: when a run is wedged, the owner takes
  the card back with `release`, and the reason is logged.
- **`run_interrupted` is attributed to the former holder.** It is the event of their run
  ending, and the queue view should show whose run it was. The sweep itself is the daemon,
  which is not a member.
- **TTL bounds 10 to 3600, default 120**, the prototype's numbers: long enough that a busy
  agent's heartbeat cadence is comfortable, short enough that a dead one is noticed within
  minutes.
- **An injectable clock rather than sleeps in tests.** The core's `Date.now()` calls go
  through one function that `openCore` accepts as an option; the daemon passes nothing.
  This is the only new pattern and it exists so expiry tests run in milliseconds.
- **Lapsed-but-unswept claims are visible as such.** Hiding them would make the core lie
  between sweeps; showing `expiresAt` in the past lets the CLI mark `~` and lets 006 reason
  about it.

## Acceptance criteria

1. `bun run check` exits 0 with new tests under `packages/shared/src/`,
   `packages/daemon/src/core/`, `packages/daemon/src/server/`, and `packages/cli/src/`.
2. `PHASES` reports `claimable` true for `spec` and `code` only.
3. Core: with a card in `spec`, `claimCard(id, {}, agentId)` returns the card with `claim.by`
   = the agent, `expiresAt` 120 s after the clock, and records one `claimed` event; calling
   it again as the same agent returns the renewed claim and records nothing; as another
   agent it throws `conflict` naming the holder; `{ ttlSeconds: 5 }` is clamped to 10 and
   `{ ttlSeconds: 9999 }` to 3600. On a card in `idea` it throws `invalid`; on an archived
   card `invalid`.
4. Core: with the clock advanced past `expiresAt`, another agent's `claimCard` succeeds and
   the activity shows `run_interrupted` attributed to the first holder followed by `claimed`
   for the second; `heartbeat` by the first holder then throws `conflict`.
5. Core: `heartbeat` by the holder extends `expiresAt` by the original TTL and records
   nothing; by a non-holder it throws `conflict`; with no live claim it throws `conflict`.
6. Core: `releaseCard` by the holder clears the claim and records `released { reason }`; by
   the owner likewise; by another agent it throws `forbidden` and the claim stands; on an
   unclaimed card it records nothing.
7. Core: `moveCard` by the holder from `code` to `pr` records `card_moved` then `released
   { reason: "moved" }` and clears the claim; by another agent while the claim is live it
   throws `conflict` and nothing changes; by the owner it succeeds and releases.
   `archiveCard` releases with `reason: "archived"`. A same-phase move leaves the claim
   alone.
8. Core: `sweepClaims()` with two lapsed claims and one live one records two
   `run_interrupted` events attributed to their holders, clears those two claims, leaves the
   live one, and returns the two card ids; a second sweep returns nothing. Before the
   sweep, `getCard` shows the lapsed claim with its past `expiresAt`.
9. Core: a database created by the previous schema migrates forward and its cards read
   back with `claim: null`; claims survive close and reopen.
10. Wire: the parity test passes with `sweepClaims` as a named exception; `claimCard`,
    `heartbeat`, and `releaseCard` round-trip through the shared client as owner and agent
    with the shapes in `protocol.ts`; the three events reach a subscriber in `seq` order.
11. Daemon: a spawned daemon on a temp `SKELCREW_DIR` sweeps a claim made with the minimum
    TTL within 20 s of its lapse without any client action: a subscribed client receives
    `run_interrupted`, and `getCard` shows `claim: null`.
12. CLI: `skelcrew claim 1 --as crew-1` prints the expiry and `show 1` names `crew-1` as
    holder; `skelcrew claim 1 --as crew-2` exits 1 with `conflict`; `skelcrew heartbeat 1
    --as crew-1` exits 0 and `--as crew-2` exits 1; `skelcrew release 1 -m done --as crew-1`
    records the reason; `skelcrew release 1 --as crew-2` on `crew-1`'s claim exits 1 with
    `forbidden`; `skelcrew release 1` as the owner succeeds. `claim 1 --ttl abc` exits 2.
13. CLI: `skelcrew ls` marks a card with a live claim `*` and, after the clock lapses it
    without a sweep, `~`; a card with an open attention request shows `!` or `?` rather than
    the claim marker; `show 1` prints holder, since, and expiry.
14. `docs/MILESTONES.md`'s status section records that "running" is a live `Card.claim`,
    that heartbeats are not logged, and the sweep interval, as facts 006 builds on.

## Tests

- Core: claim, renewal, conflict, TTL clamping, non-claimable phase, archived card; expiry
  through the injected clock with the interrupted-then-claimed sequence; heartbeat rules;
  release rules; clear-on-move and clear-on-archive with the exact event order; the
  non-holder move conflict; the sweep with mixed claims, its return value, its idempotence,
  and the visibility of a lapsed claim before it; migration and persistence.
- Shared: the `claimable` flags.
- Protocol: parity with the exception, round trips as owner and agent, events on the stream.
- Daemon: the spawned-process sweep, with the minimum TTL and a bounded wait.
- CLI: each command's success and failure paths with exit codes, the markers, and `show`.

The 002, 003, 004, and 010 suites remain and must pass; `ls` tests that assert exact rows
account for the marker column. Red for this spec is the shared test for `claimable` failing.

## Out of scope

- The runner itself: watching claimable cards, creating worktrees, spawning agents (006,
  007). This spec gives it the primitives and the daemon-side sweep.
- Choosing which card to claim next, priorities, or a "queued" listing beyond `ls`.
- Distinguishing a runner's claim from a live-session agent's; both are members.
- Heartbeat logging, claim history views, or per-claim statistics.
- Releasing a claim when an attention request is raised; the runner does that explicitly
  in 007.
- Any change to 010's attention semantics beyond marker precedence in `ls`.
