# 028 — The runner's name is reserved

A finding from 024's review round 3, recorded in `docs/MILESTONES.md` under 024. This spec
grants nothing; it removes one thing the socket accepts today. It is a gate, not a boundary: the
socket is local and `hello` as the owner needs no credential, so any process that can reach it
is already the owner. What this closes is an accident and a confusion, not an attacker.

## Goal

Nothing that connects over the socket can become the daemon's runner. The runner is the member
whose claims are runs: the sweep withdraws its own question when its lease lapses (024), and
`release` and `heartbeat` on its claims are how a run ends or continues. Today a client that
says `hello` as an agent named `runner` is handed that member, id and all, because members are
looked up by name and kind and created when missing. An agent in a live session that picks
`--as runner` — a plausible name — then holds claims the sweep treats as runs, and can release
or renew the real runner's leases. After this spec that `hello` is refused with a message that
says why, and the only way to be the runner is to be the daemon.

## Current behavior

- `packages/daemon/src/server/protocol.ts:159-170`, `hello`: an agent `hello` calls
  `core.ensureMember(who.name, "agent")`, which finds the member by trimmed name and kind or
  creates it (`packages/daemon/src/core/core.ts:567-583`). No name is refused.
- `packages/daemon/src/main.ts:115`: the daemon creates the runner's member in-process with
  `core.ensureMember(RUNNER_MEMBER_NAME, "agent")`, where `RUNNER_MEMBER_NAME` is `"runner"`
  (`packages/daemon/src/runner/runner.ts:75`). The runner never connects over the socket; it
  calls the core directly. `main.ts:123` creates `crew` the same way, but `crew` *does* speak
  over the socket: the shim sets `SKELCREW_AS=crew` for every spawned agent
  (`packages/daemon/src/runner/shim.ts:112`), and the agent's CLI calls `hello` as it.
- `packages/daemon/src/server/process.test.ts:458` and `:510` (024's daemon-level tests) rely
  on the hole: they `connect(socketPath, { kind: "agent", name: "runner" })` to make a claim the
  sweep will treat as the runner's. They assert the impersonation works
  (`members.find(... "runner" ...)?.id).toBe(runner.member.id)`).
- Observed by 024's round-3 reviewer, 2026-09-16: `ensureMember("runner", "agent")` twice
  returns the same id, and a client as `runner` can `claimCard`; the sweep then withdraws its
  question and the real runner takes the card.
- The name is checked nowhere else: the CLI's `--as` accepts any string
  (`packages/cli/src/main.ts:196`).

## Desired behavior

**`hello` as `runner` is refused.** A `hello` with `kind: "agent"` and a name that, trimmed the
way the core trims member names, equals the runner's member name is refused with an
`invalid_params` error whose message names the member and says it is the daemon's own and
cannot be joined over the socket. No member is created or bound, and the connection may say
`hello` again as someone else, as it can after any refused `hello`. Through the CLI,
`skelcrew --as runner ls` prints that message and exits 1, the way any refused request does.

**Reserved whether or not the runner is on.** A daemon started with `SKELCREW_RUNNER=0`
refuses the name too. The member may already exist from an earlier start, and a runner that
starts next time must not inherit claims an impersonator made.

**Nothing else changes.** `crew` is not reserved: spawned agents must join as it over the
socket, and an agent that joins as `crew` from a live session is an agent member doing what
agent members do. The owner's `hello` is unchanged. Every other agent name is accepted as
today.

## Implementation approach

The refusal lives in `protocol.ts`'s `hello`, beside the "already said hello" check, against a
set of reserved names the server is given when it is built. `main.ts` passes
`[RUNNER_MEMBER_NAME]` — always, not only when the runner is on — so the server does not import
from the runner: coordination and execution stay on their two sides of the seam (CLAUDE.md,
"one binary, two halves"), and the daemon, which owns both, is what says which member is its
own. The comparison uses the same trim the core applies (`memberName`, `core.ts:195`), so
`" runner "` is refused as `runner` is; the core exports that normalisation or the protocol
calls `ensureMember` only after the check, whichever the implementer finds cleaner, as long as
the two agree by construction rather than by copy.

**The two 024 daemon-level tests are rewritten**, not weakened. Today they impersonate the
runner over the socket; after this spec that is refused, and the behaviour they pin is still
required. The clean setup is the data directory: before spawning the daemon, open the core on
`<data>/skelcrew.db` with `openCore`, create the runner member with `ensureMember("runner",
"agent")`, the card, the claim at the shortest TTL and the request raised by that member, and
close it; then spawn the daemon, whose own `ensureMember` finds the same member, and whose
sweep lapses the pre-made claim. That is the daemon's real state on a restart after a sleep,
which is the scenario 024 exists for, so the tests get closer to the truth by losing the
impersonation. The assertions stay as they are. One correction, made by the orchestrator
during development: with the runner on, a claim pre-made before the daemon starts is never
swept, because `reconcileAll` in `runner.ts` releases every claim held by the runner member at
startup — a claim that survived a restart belongs to a run that no longer exists, which is
006's rule and the right one. So for the runner-on test the member, the card in Spec and the
request are pre-made through `openCore`, and the claim alone is taken through the same core
handle after the daemon reports listening — still never over the socket. The control under
`SKELCREW_RUNNER=0` follows the paragraph above exactly, since nothing reconciles there. (The
spec as approved said the claim was pre-made in both; the implementer found the release in the
activity and the sweep withdrawing nothing.)

Decisions resolved from the repository: a set passed in rather than a constant imported by
the protocol, for the seam; `crew` not reserved, because the shim needs it to join over the
socket and CLAUDE.md's "agents are members, not plugins" says an agent joining as an agent
member is the normal case; refusal at `hello` rather than at `claimCard`, because the confusion
is the identity, not one call — a client that is the runner can also `release` and
`heartbeat`, and 010's fail-closed rule already covers what it may resolve.

### Red-team

This grants nothing. It enumerates one name, and the enumeration is against the daemon's own
constant, so it moves when the constant moves. What it does not close, written down as a
decision: the owner's `hello` needs no credential, so any local process is the owner and can
do everything the owner can, including release a runner's claim by hand (`skelcrew release`).
That is single-player first (CLAUDE.md) and not this spec's concern. It also does not close a
process that opens the SQLite file directly, which is the owner's file on the owner's disk.

## Acceptance criteria

1. `bun run check` passes; no test spawns a real coding agent or calls a model.
2. `hello` with `{ kind: "agent", name: "runner" }` on a fresh connection fails with an
   `invalid_params` error whose message contains `runner` and says it is the daemon's own
   member; `listMembers` afterwards shows no member was created by it, and a subsequent `hello`
   on the same connection as `crew-1` succeeds. Asserted through the real socket in
   `protocol.test.ts`, the way `hello as an agent on two connections` is.
3. The same with `name: " runner "` (surrounding whitespace) is refused, because the core would
   have trimmed it to the reserved name. `name: "Runner"` is accepted, because the core does not
   fold case and it is a different member.
4. A daemon started with `SKELCREW_RUNNER=0` refuses the name the same way. Asserted in
   `process.test.ts` with the real daemon.
5. `skelcrew --as runner ls` through the real CLI prints the daemon's message on stderr and
   exits 1.
6. 024's two daemon-level tests in `process.test.ts` no longer connect as `runner`; they set
   up the runner's member, card and request through `openCore` on the data directory before
   spawning the daemon (and the claim too under `SKELCREW_RUNNER=0`; with the runner on, the
   claim is taken through the same core handle after the daemon is listening, because the
   runner releases pre-existing claims of its own at startup — amended during development),
   and their assertions (the withdrawal, the re-claim, the control under `SKELCREW_RUNNER=0`)
   are unchanged. `git diff` of those tests shows setup changed and no
   `expect` removed.
7. The runner's own `hello`-free path is untouched: a daemon with the runner on still claims a
   card moved to Spec and raises its request as the `runner` member (the existing process test
   for the handoff passes unchanged).

## Tests

- Criteria 2–3 in `protocol.test.ts` beside the existing `hello` cases.
- Criteria 4, 6 and 7 in `process.test.ts`; 6 is a rewrite of the two 024 tests' setup.
- Criterion 5 in `cli.test.ts` through the real binary.
- Red first: criteria 2–5 fail on the current code because the `hello` succeeds; criterion 6's
  rewritten setup must pass before the refusal is added (it does not depend on it) and after.

## Out of scope

- **Reserving `crew`, the owner's name, or any name pattern.** `crew` must join over the socket;
  the owner is one member by kind, already enforced by the core.
- **Authenticating the socket.** Single-player first; any local process is the owner.
- **A separate wire identity for the runner** (a token, a socket the runner alone uses). The
  runner does not use the socket.
- **Refusing `--as` names in the CLI before the daemon sees them.** The daemon is the
  authority; the CLI relays its answer.
