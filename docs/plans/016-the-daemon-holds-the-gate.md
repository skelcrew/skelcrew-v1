# 016 — The daemon holds the gate

Run record for `docs/specs/016-the-daemon-holds-the-gate.md`.

## The change, in steps

1. **The crew member.** `CREW_MEMBER_NAME = "crew"` beside `RUNNER_MEMBER_NAME` in
   `runner/runner.ts`; `main.ts` ensures it and passes it to `startRunner` as `crew`.
   `agentEnvironment` takes the member name to speak as. The runner threads the crew id into
   `runPlaybook` → `ContractInput.memberId` (whose writes count as this run's) and into
   `EndingInput.crewId` (a self-action is looked for by either member). Everything the runner
   does as itself stays `runner`: claim, heartbeat, run-start refs and comment, the permission
   question, the ending.
2. **The gates.** `shared/phases.ts`: `code.exit` → `"owner"`. `core.ts` `archiveCard`: a
   non-human actor is refused `forbidden`. Nothing else in the core changes — `releaseCard`,
   `claimCard` and `resolveAttention` already refuse, and the identity split is what puts the
   agent on the other side of them.
3. **The records.** `allowlist.ts`'s *What a subprocess reaches* and rule 4, and
   `playbooks/code.md`'s subprocess paragraph: the five verbs are reachable and the daemon
   refuses them.
4. **Tests**, red first, each refusal its own case through the real core, and all five through
   the CLI as `crew` against a running daemon.

## Files expected to change

- `packages/shared/src/phases.ts`, `phases.test.ts`
- `packages/daemon/src/core/core.ts`, `core.test.ts`
- `packages/daemon/src/main.ts`, `runner/runner.ts`, `runner/run.ts`, `runner/shim.ts`,
  `runner/contracts.ts`, `runner/ending.ts`, `runner/allowlist.ts`, `playbooks/code.md`
- their tests: `shim.test.ts`, `run.test.ts`, `contracts.test.ts`, `allowlist.test.ts`,
  `playbooks.test.ts`, `runner.test.ts`
- `packages/cli/src/cli.test.ts`, `packages/daemon/src/server/protocol.test.ts`,
  `server/server.test.ts` (call sites that used the Code exit or an agent archive as plumbing)

## What the spec left open, and how it was decided

- **`archiveCard`'s refusal sits after the already-archived no-op return.** Archiving an
  archived card changes nothing, so refusing it would buy no gate and would break an existing
  assertion (`core.test.ts` "archiving an archived card records nothing").
- **`ContractInput.memberId` is the crew id alone**, not "crew or runner": the runner writes no
  body, and its only `refs_set` is the branch, which no contract condition reads.
- **`classifyEnding` looks for crew or runner** as the spec asks, and is now unreachable through
  the core for the move and archive branches — defence in depth, recorded as such.
- **A comment the agent posts as `crew` is not fed back to it.** `run.ts` already refuses to
  feed the run its own activity; with the identity split that filter has to know both members,
  or every `skelcrew comment` the agent makes returns to it as a user message.

## Where the spec is wrong

The spec says only `core.test.ts`'s "an agent may move a card out of code" changes. With
`code.exit = "owner"` and the archive rule in and nothing else touched, fourteen existing tests
failed. Every one is a consequence the spec itself requires, and they fall in three groups:

1. **The phase table's own assertion** — `shared/phases.test.ts` asserts `code: "any"`.
2. **Plumbing that used the Code exit or an agent archive** because they were the only mutations
   an agent could make: `core.test.ts`'s claims and activity cases, `protocol.test.ts`'s
   round-trip and claims-on-the-wire cases, `server.test.ts`'s streaming case, `cli.test.ts`'s
   crew-gate case. Re-pointed at the owner, or at the refusal, with the assertion's subject kept.
3. **014's self-move and self-archive endings** (criterion 10 here), which cannot hold: the two
   new rules are about `actor.kind`, so they refuse the `runner` member too. Only the
   self-release ending is still reachable through the core. Those two tests now assert the
   refusal, and `classifyEnding` keeps its branches as defence in depth.

Two smaller ones: `agentEnvironment`'s signature change makes `shim.test.ts`'s two environment
assertions change with it; and the run-start comment criterion 11 asks about never named the
five verbs, so that clause is satisfied vacuously.

Both claim-conflict guards — in `moveCard` and in `archiveCard` — are now unreachable, because
a non-human actor is turned away before either is read. Both are kept and commented as such:
the spec says an owner may drop the archive rule "without touching anything else", and dropping
it must not silently drop the claim protection under it.
