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
4. **Tests**: each refusal its own case through the real core, and all five through the CLI as
   `crew` against a running daemon. Red first where a rule changed — and **not** where one did
   not, which is most of the gates: see *Red, and the cases that were green first* below,
   which says of every new case whether it was red before the change it covers.

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

## Red, and the cases that were green first

This spec changes **two** rules and one identity. Only tests of the two rules could be red
before the implementation; a test of a gate whose rule already existed passes on the base
commit the moment it is written, because what 016 changes for it is *who the agent is*, not
what the core does. Both groups are listed in full below, and nothing was made red by reverting
an implementation.

**Red first, with the failure quoted when it was run** — each was written, run and seen to fail
for the intended reason before the code that makes it pass:

- `phases.test.ts` "every phase is the owner's to leave" — `- "code": "owner" / + "code": "any"`.
- `core.test.ts:287` "an agent may not move a card out of code; the owner moves it…" and the
  `test.each` over all four destinations — the move succeeded on the base commit.
- `core.test.ts` "crew may not move the runner's card to pr|done|idea" (×3) —
  `Expected: "forbidden" / Received: "conflict"`: on the base commit the refusal is the claim's,
  and it records no `move_rejected`, which is what criterion 3 asks for.
- `core.test.ts` "crew may not archive a card the runner holds, nor a free one" — same shape for
  the held card; the free card was archived outright.
- `shim.test.ts` ×3 — `Expected: "crew" / Received: "runner"`.
- `run.test.ts` "the agent speaks as crew, the claim stays the runner's…" — `Expected: "crew" /
  Received: "runner"`.
- `run.test.ts` "a comment the agent posts as crew is not fed back to it…" — red in the
  intermediate state (identity split in, filter not yet): `Expected: "keep going" / Received:
  "my own note"`. It passes at both ends and would not have failed on the base commit, which is
  why the intermediate run is the one quoted.
- `contracts.test.ts`'s thirteen re-pointed contract writes — `Expected: "spec ready" /
  Received: "run finished without a spec…"` once the contract counted the crew's writes.
- `allowlist.test.ts` and `playbooks.test.ts`'s two record assertions — `Expected to contain:
  "the daemon refuses"`.
- `contracts.test.ts` "the agent as crew cannot move, release or archive the card it is
  working…" — the end-to-end composition, red against base on **one** of its four refusals:
  the archive (`Expected to contain: "only the owner may archive a card" / Received: "card 1
  is claimed by runner until …"`). Its move half is *not* red — the test's card is in Spec,
  whose exit was owner-only before 016 — and its release and claim halves are pre-existing
  rules. Written after the rules were in and never run red; it is listed here because it fails
  against base, with the one failing half named, not credited with more than that.

**Green when written.** A copy of the worktree with `core.ts` and `phases.ts` restored to
base runs the new `describe("the daemon holds the gate")` block at 4 pass / 4 fail; these are
the four that pass, and beside them one more that is also green against base, and one that is
not but was written after the wiring it guards:

- `core.test.ts` "crew may not release the runner's claim" — `releaseCard` already threw
  `forbidden` to a non-human actor who is not the holder (`core.ts`, before 016). 016 changes
  only that the agent is no longer the holder. **The red for criterion 4 is the identity**, in
  `run.test.ts` "the agent speaks as crew…" and `shim.test.ts`, above.
- `core.test.ts` "crew may not claim a card the runner holds" — `claimCard` already threw
  `conflict` on another member's live claim. Same reading: criterion 6's red is the identity.
- `core.test.ts` "crew may not resolve the request the runner raised to the owner" —
  `resolveAttention` already refused anyone but the addressee or the owner; 013 says as much in
  so many words. Criterion 7's red is the identity.
- `core.test.ts` "crew still comments, sets the body and records refs…" — this is the *absence*
  of a rule, by design (the spec's red-team lists exactly these as what `crew` reaches). Nothing
  could make it red without adding a rule the spec does not ask for.
- `run.test.ts` "the agent may not answer its own permission question: the request stands and
  the call waits" — criterion 7 again, one level up: it composes the pre-existing refusal with
  013's pending-ask machinery, neither of which this spec changes.
- `server/process.test.ts`'s widened `listMembers` assertion — a guard over `main.ts`'s two
  `ensureMember` calls, written after them. Not a claim that it could not be red: against the
  base it fails (`["runner"]` where `["runner","crew"]` is expected); it was simply written
  after the wiring it guards.

**One case this section first mis-filed**, corrected by the orchestrator after re-verification
refuted it: `cli.test.ts` "the five gate verbs as crew are refused by the daemon on a card the
runner holds" was listed above as green-first on the grounds that "the CLI cannot be red for
rules already in the core". That reasoning is false as applied — two of the five verbs, `mv`
and `archive`, are rules 016 *adds* — and the case **fails against the base commit** on the
`mv` refusal (`forbidden` expected, `conflict` received). It belongs with the red-first cases,
and the implementer's own account of writing it green after the rules were in stands as the
chronology; the record had turned a chronology into a claim about redability, which it was not.

**Rewrites of tests the change made fail**, which are neither: `core.test.ts:287`,
`cli.test.ts:333`, `contracts.test.ts:713` and `:817`, and the nine plumbing cases listed under
*Where the spec is wrong*. Their previous form failed — that is what forced the rewrite, and the
failures are in the list above where the criterion is 016's — and their new assertions were
written against the implemented rule.

What this means for `CLAUDE.md`'s red-then-green: it applied to the two rules 016 adds —
leaving Code, and archiving, which are two of the five gates — and to the identity split, and
it could not apply to the other three gates (release, claim, resolve), which are 016's subject
but not 016's change. That is the spec's own thesis — "the mechanism is identity, not new
rules" — and the record says so rather than claiming a red for all of it.

## Where the spec is wrong

The spec says only `core.test.ts`'s "an agent may move a card out of code" changes. With
`code.exit = "owner"` and the archive rule in and nothing else touched, **fourteen** existing
tests failed; **three** more changed because `agentEnvironment` took a parameter
(`shim.test.ts` ×2 and one call site in `run.test.ts`), and one was widened to cover the new
daemon wiring — eighteen in all. Every one is a consequence the spec itself requires. In full,
by file, with what changed in each:

**The rule the spec sanctions**

1. `core.test.ts:287` "an agent may move a card out of code…" → "an agent may not move a card
   out of code; the owner moves it, and can send it back". The agent's move is now `forbidden`
   with `move_rejected` logged; the owner's two moves are unchanged.

**The phase table's own assertion**

2. `shared/src/phases.test.ts:17` "only code may be left by any member; the rest are the
   owner's" → "every phase is the owner's to leave"; the exit map's `code` entry goes
   `"any"` → `"owner"`. Nothing else in it changes.

**Tests that used the Code exit or an agent archive as plumbing** — an agent leaving Code and an
agent archiving were the only card-ending mutations an agent could make, so several cases about
something else used them. Each keeps its subject; only the actor, or the expected refusal,
changed.

3. `core.test.ts:697` "subscribe delivers every event in seq order until unsubscribed" — the
   one `moveCard(…, "pr", agent.id)` in the fixture sequence becomes the owner's. The expected
   event list is unchanged.
4. `core.test.ts:1461` "a move out of the phase by the holder records card_moved then released
   { reason: moved }" — the holder is now the owner (claims and moves), because no agent can
   move a card out of any phase. The recorded pair, and that the claim is cleared, are unchanged.
5. `core.test.ts:1489` "a non-holder agent may not move a card with a live claim; the owner may,
   and it releases" — the refusal is now the phase's rather than the claim's: `conflict` →
   `forbidden`, and it now records `move_rejected` where it recorded nothing. The owner's half
   is unchanged. A docstring says why, and where the claim's own refusal is still asserted.
6. `core.test.ts:1509` "a lapsed claim does not block another agent's move…" → "…does not block
   the owner's move…"; the mover is the owner. The assertion — `run_interrupted` for the lapsed
   holder, and no `released` — is unchanged.
7. `core.test.ts:1527` "archiving over a lapsed claim records the interruption, not a release" —
   the archiver is the owner rather than a second agent. The assertion is unchanged.
8. `core.test.ts:1550` "a non-holder agent may not archive a card with a live claim; the owner
   may, and it releases" → "no agent may archive a card, holder or not; the owner may, and it
   releases". The non-holder's refusal goes `conflict` → `forbidden`; the "the holder may
   archive its own claimed card" half becomes "nor may the holder", asserting the refusal and
   that nothing was archived. The owner's half is unchanged.
9. `cli.test.ts:333` "an agent's move through a crew gate succeeds; through an owner gate it is
   refused and posts nothing" → "an agent's move through an owner gate is refused and posts
   nothing". The succeeding half is gone (there is no crew gate); the refusal half keeps its
   assertions — `forbidden`, no comment posted, `move_rejected` last — and the owner's move
   with its note is asserted in its place.
10. `server/protocol.test.ts:523` "every method round-trips as an agent, with the gates in
    place" — the agent's Code→PR move and its archive become expected `forbidden` errors (both
    methods are still exercised on the wire), the owner archives, and the agent's event list
    loses `card_moved`/`card_archived` and gains a second `move_rejected`.
11. `server/protocol.test.ts:787` "an agent claims, another agent gets conflict, the owner
    releases; forbidden and invalid map" — the non-holder's move goes `conflict` → `forbidden`,
    and the holder's closing move becomes the owner's, with the card's event list gaining the
    two `move_rejected`s. Every claim/heartbeat/release assertion is unchanged.
12. `server/server.test.ts:76` "two subscribers each receive five mutations in seq order;
    unsubscribe stops one" — the move and the archive are made by the owner's client instead of
    the agent's. The counts, the seq ranges and the unsubscribe assertions are unchanged.

**014's self-action endings** (criterion 10 here) — these cannot hold: the two new rules are
about `actor.kind`, so they refuse the `runner` member too, and only the self-*release* ending
is still reachable through the core (four cases keep it, unchanged).

13. `contracts.test.ts:713` "an agent that moves its own card fails the run, naming what it did"
    → "the core refuses even the runner's own move out of Code, and the run still ends on its
    contract": the move is refused, `move_rejected` is recorded against the runner, and the run
    ends on its met contract with the move to PR *offered*.
14. `contracts.test.ts:817` "an agent that archives its own card fails the run, and nothing is
    raised on it" → "the core refuses even the runner's own archive, and the card is still there
    at the end". `classifyEnding` keeps both branches as defence in depth.

**Changed for the new signature, not the new rules**

15. `shim.test.ts:47` "the spawned environment is exactly PATH, HOME, SKELCREW_AS and
    SKELCREW_DIR" — the call takes the member name and the expected `SKELCREW_AS` is that name
    rather than the literal `runner`. What it asserts — that the environment is exactly those
    four variables — is unchanged.
16. `shim.test.ts:61` "with no PATH to inherit the shim's directory is the whole PATH, and an
    absent HOME is not invented" — the same, with the `PATH`/`HOME` assertions unchanged. (A
    third, new case at `:74` asserts the name is the one given.)
17. `run.test.ts:264` — the same call site inside "a Spec run: the log path, the turn, the
    batched tools, and the handoff, in order"; the assertion is unchanged.

**Widened to cover new wiring**

18. `server/process.test.ts:422` "with SKELCREW_AGENT=claude the daemon loads the driver and its
    playbooks and serves…" — `listMembers` was asserted with `toContain("runner")`; it now
    asserts the agent members are exactly `["runner", "crew"]`, which is the only coverage of
    `main.ts` joining the crew member.

Beside those: `contracts.test.ts`'s thirteen `setBody`/`setRefs` lines inside fake drivers and
its `agentAsks` helper are re-pointed at `crew` — which the spec asks for — with every
assertion kept.

Two spec defects with nothing to fix in the code: the run-start comment criterion 11 asks about
never named the five verbs, so that clause is vacuous; and the red-team's "what remains open"
list says three limits are recorded in `allowlist.ts` where only one was.

**The spec was amended in five places across three commits over these rounds**, each time by
the coordinator, and each correction is one this work forced:

1. `261af08` — the self-action paragraph and criterion 10: the runner cannot move its own card
   out of Code or archive it either, because the two rules key on the actor's *kind*.
2. `261af08` — criterion 12: more than one existing assertion changes, and what those changes
   may be (subject kept, only the actor or the expected refusal changed, nothing weaker), with
   each to be enumerated here.
3. `f152b4d`, first half — the red-team's *what the grant reaches*, which claimed to enumerate
   and did not: `crew` can also **create a card** (it lands in Idea, a phase `crew` cannot
   leave) and its raise **overwrites the card's one open request**, the runner's own permission
   question included — which 013 designed for, since the run re-queues the ask it was waiting
   on. Neither crosses a gate; both belong in a list that says it is complete.
4. `f152b4d`, second half — criterion 11's run-start-comment clause dropped as vacuous.
5. `279c90f` — the red-team's compositions: `--move done` on a request `crew` raises, and the
   `runner`/`crew` name-join. Recorded in `allowlist.ts` too, by Minor 4 of round 2.

Both claim-conflict guards — in `moveCard` and in `archiveCard` — are now unreachable, because
a non-human actor is turned away before either is read. Both are kept and commented as such:
the spec says an owner may drop the archive rule "without touching anything else", and dropping
it must not silently drop the claim protection under it. The same is true of `classifyEnding`'s
self-archive and self-move branches, which is why their notes carry a line saying the wording
would need revisiting if a rule ever revives them. `PhaseDef.exit`'s `"any"` variant is in the
same position — no instance since 016 — and says so beside the `moveCard` guard it re-arms.

## Review round 1 — changes requested, two Important and six Minor

Fixed in `685f6df`, documentation and comments only:

- **Important 1** — this record counted the changed tests behind four group labels where
  criterion 12 asks for each one named with what changed in it; the enumeration above is the
  fix, and `process.test.ts` had been left out of it entirely.
- **Important 2** — `run.test.ts`'s `agentAsks` kept raising as the runner (correct: it is the
  one fixture where the agent's question and the run's own share a `raisedBy`, so it is what
  would fail if 013's `RunQuestion` construction were ever replaced by a `raisedBy` comparison)
  while its docstring said that was forced rather than chosen. The comment now says why.
- **Minors** — `ending.ts`'s unreachable branches note that their "the agent …" wording is
  stale if a rule revives them; `allowlist.ts` records all of 016's open limits rather than one,
  and its `--as` bullet no longer credits the omission of `resolve` with what the daemon
  refuses; the CLI gate test names the refusal per verb (`forbidden` for mv/release/archive/
  resolve, `conflict` for claim) instead of accepting either.

## Review round 2 — approved, five Minor

The reviewer re-derived the gate from four sides — the owner's (every phase still leaves as the
owner, and the queue's offered move is still executed by a human), the runner's (the claim is
`runner`'s for the whole run and every ending is attributed to it), startup (`main.ts` joins
both members, and `process.test.ts` pins it), and the shim (`SKELCREW_AS=crew`, so a subprocess
inherits the crew's identity and meets the core's refusals) — and confirmed each red by
reverting the change in a scratch copy.

Disposition of the five:

1. **`PhaseDef.exit: "any"` has no instance, and `moveCard`'s claim guard beneath it has no
   coverage** — fixed here: a note on `PhaseDef.exit` and one beside the guard, each pointing at
   the other. The variant and the guard stay.
2. **`allowlist.test.ts` pinned the previous wording** (`not.toContain("obtained anyway")`)
   rather than the forbidden claim — fixed here: `not.toContain("obtain")` and
   `not.toContain("withhold")`, as `playbooks.test.ts` already does. Checked by inserting "A
   subprocess obtains all five verbs regardless." into the record: the new assertion fails, and
   the two old pins would both have passed. The insertion was reverted.
3. **The `--move done` composition and the `runner`/`crew` name-join** — recorded in the spec's
   red-team by the coordinator.
4. **Those two limits belong in `allowlist.ts`'s record too**, since the spec says each open
   limit is written down there — added: a caller asserting `--as crew` joins the crew member
   itself (so its `body_set` satisfies a Spec contract and its comments hit the self-echo
   filter), and a request `crew` raises may name any destination, which the owner's queue prints
   as a ready-to-run `mv` indistinguishable from a met contract's. Neither crosses a gate; the
   owner still executes the move.
5. **The record's arithmetic** — three tests changed for `agentEnvironment`'s new parameter, not
   two; items 15-18 are now split one per test and the count reads eighteen.

## Verification — failed on this record's fidelity, and on nothing else

All twelve acceptance criteria **PASS**, checked against the code rather than against this
record: the identity split and the two rules do what criteria 2-9 describe; 014's endings hold
where they still can (criterion 10, as amended); the two records say reachable-and-refused
(criterion 11); every changed existing test keeps its subject with nothing weaker (criterion 12,
as amended); `bun run check` is green and no test spawns an agent or calls a model (criterion 1).
Scope is clean, and every absolute in the new prose traces to a check in `core.ts` that cannot
see what transport the call arrived on.

**What failed was this file.** Step 4 above said "Tests, red first" without exception, and the
two reports on this work named two green-first tests. The verifier copied the worktree, restored
`core.ts` and `phases.ts` to base, and ran the new `describe("the daemon holds the gate")` block:
**4 pass / 4 fail**. Four cases in that block — release, claim, resolve, and the
comment/body/refs case — were green before any implementation, and none was disclosed.

The finding is about the record, not the tests: those four characterise rules the core already
had, under the new identity, and could not be made red without weakening the core. But
red-then-green was claimed where it did not and could not apply. Corrected here:

- *Red, and the cases that were green first* now says of **every** new case which it was,
  with the quoted failure for each red one and, for each green one, whether it could have been
  red — the verifier's four, plus `run.test.ts`'s permission-question case (which my reports
  missed), plus the `process.test.ts` assertion (which they disclosed). Two cases first filed
  green there were found red against base by later re-verification and moved: the CLI refusal
  test, and `contracts.test.ts`'s end-to-end composition (red on its archive half only).
- Step 4's claim is replaced by one that points at that section.
- Rewrites of tests the change made fail are named as a third category, credited with neither.

**Re-verification, twice more, on this record alone.** The section above was itself wrong
when first written, in the same way it was written to correct: it filed the CLI refusal test as
green-first "because the CLI cannot be red for rules already in the core" (two of the five
verbs are rules 016 adds; the test fails against base on `mv`), said red-then-green could not
apply to "the five gates" (it applied to two), and introduced a five-item list with "four
times". Corrected by the orchestrator, whose file this is, after the implementer's three fix
rounds were spent. A second re-verification then found the correction had left three counts
stale ("eight cases", "four more beside them", and the enumeration in this section still
naming the CLI test as green) and one inherited error: the composition test's move half was
called red when its card is in Spec, already owner-exit at base — only its archive half is red.
All corrected in the same way. What the record now claims about each new case is what running
it against base shows.

`f152b4d`'s first half — the red-team's *what the grant reaches* widened to include `crew`
creating a card and `crew`'s raise overwriting the card's one open request — was missing from
the list of spec amendments above, and is now item 3 there.
