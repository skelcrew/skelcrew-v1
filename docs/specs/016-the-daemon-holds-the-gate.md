# 016 — The daemon holds the gate

## Goal

After 013 and 014, the rules that keep a run from crossing a gate — moving its own card past
the artefact check, releasing or archiving it mid-run, answering its own permission question —
are enforced by *omission*: five `skelcrew` verbs are left off the allowlist. 013's review
proved that omission is not a boundary. The repository's own check command runs as a subprocess
with the shim on `PATH` and `SKELCREW_AS=runner` in its environment, and nothing in the
permission layer sees what it does. This spec moves those rules into the daemon, which decides
from state it holds — who has the claim on this card — rather than from what the caller says.

**This is a gate, not a boundary.** What it delivers is that the spawned agent, speaking as
itself, cannot cross a gate by any call it can make: every attempt is refused by the core on its
own facts, whatever the allowlist says and whatever a subprocess runs. What defeats it is a
caller asserting another identity over the socket — `skelcrew --as runner`, or no `--as` at all,
which is the owner. Single-player with no auth cannot tell a lie of that kind from the truth,
and this spec does not pretend to; it records it as the limit and leaves it there.

## Current behavior

- The spawned agent speaks as the **same member that holds the claim**. `agentEnvironment`
  (`packages/daemon/src/runner/shim.ts:51`) sets `SKELCREW_AS=runner`, and the runner claims the
  card as the `runner` member (`packages/daemon/src/main.ts:80`, `RUNNER_MEMBER_NAME`). The
  claim's `by` and the agent's `actorId` are one id.
- The core already refuses a non-human actor acting on **another member's** live claim, and
  fails closed: `moveCard` and `archiveCard` throw `claimConflict` (`core.ts:582-585`,
  `:640-643`); `releaseCard` throws `forbidden` when `card.claim.by !== actorId` (`:782-787`);
  `resolveAttention` throws `forbidden` when the request is addressed to someone else
  (`:687-692`); `claimCard` throws `claimConflict` on a live claim that is not the actor's
  (`:723`). None of these bite today, because the honest answer to "is this your card?" is yes.
- `moveCard` refuses a non-human actor leaving a phase whose `exit` is `"owner"` and logs
  `move_rejected` (`core.ts:571-581`). `code` is the one phase whose exit is `"any"`
  (`packages/shared/src/phases.ts`), with **no check on the destination**: an agent may move a
  card from Code to Done, past the merge gate. `core.test.ts:282` asserts an agent may leave
  Code.
- 014 detects a self-move, self-release or self-archive *after the fact* — `classifyEnding` in
  `packages/daemon/src/runner/ending.ts` returns `self` and the run is failed — and cannot
  prevent it.
- Identity is an assertion. `protocol.ts:163` binds a request to the owner when the client
  says `kind: "human"`, and otherwise to `ensureMember(who.name, "agent")`, creating the member
  if it does not exist. The CLI's default with no `--as` and no `SKELCREW_AS` is the owner
  (`packages/cli/src/main.ts:69,152`).
- 013's `RunQuestion` exists because the agent's `skelcrew attention` and the run's own
  requests share a `raisedBy` — the same member id. The permission question is raised by the
  runner *to the owner*, so `resolveAttention` already refuses the agent-kind runner member
  from answering it; the `resolve` verb's omission from the allowlist was never what stopped
  that.
- `allowlist.ts`'s *What a subprocess reaches* record and `playbooks/code.md`'s paragraph on
  the check subprocess both say the subprocess obtains `skelcrew mv`, `claim`, `release`,
  `archive` and `resolve`. Today that is true.

## Desired behavior

**The spawned agent is a member of its own, and the runner keeps the claim.** A run spawns the
agent as a durable agent member named `crew`, distinct from `runner`. The card's claim is the
runner's throughout. Everything the agent does on the card — comments, body, refs, its own
questions — is attributed to `crew` on the activity feed, and everything the runner does —
the claim, the run-start comment, the ending, the permission question — to `runner`.

**Every gate refuses the agent on the daemon's own facts.** With the claim held by another
member, the existing checks bite: `skelcrew mv`, `release` and `archive` on the card are
refused because the runner holds it; `skelcrew claim` on it is refused for the same reason;
`skelcrew resolve` on the owner's request is refused because the request is not addressed to
`crew`. A subprocess that calls the shim gets the same refusals, because the refusal is in the
core and does not know or care what process is calling. The five verbs stay off the allowlist
— that keeps the agent from *trying* in the ordinary course, visibly — but nothing rests on the
omission any more.

**Leaving Code is the owner's, like every other phase.** `code.exit` becomes `"owner"`. An
agent finishing Code hands off the way the runner already does after 014: an attention request
carrying the move to `pr`, which the owner executes. An agent's `skelcrew mv` out of Code is
refused and recorded as `move_rejected`, whatever the destination.

**Archiving is the owner's.** A non-human actor may not archive a card, held or free. "Done" is
a human's call the way merging is, and archiving is the other way a card stops.

**The contracts count the agent's writes.** 014's Spec contract asks for a `body_set` *by this
run*; the Code contract asks for a `refs_set` whose keys include `prUrl` *by this run*. Those
writes are now `crew`'s, and the contracts recognise them as this run's. A body or ref set by
the runner itself — the run-start `refs_set` that records the branch — counts as before.

**013's rule survives, and is now redundant where it was once necessary.** The run's own
permission question is still recorded as a `RunQuestion` and every ending is still handed it.
`raisedBy` can now also tell the agent's question from the run's, but the recorded value stays
what decides — the construction is the point, and a second signal that agrees with it is not a
reason to remove it.

**The record says what a subprocess reaches now.** `allowlist.ts` and `code.md` stop saying
the subprocess obtains the five verbs and say instead that it can call them and the daemon
refuses, and why the refusal holds regardless of what called.

## Implementation approach

### The crew member

`packages/daemon/src/main.ts` ensures a second agent member, `crew` (`CREW_MEMBER_NAME`),
beside `runner`, and passes both to the runner. `agentEnvironment` (`shim.ts`) takes the member
name to speak as rather than hard-coding `runner`. The runner threads the crew member's id into
`runPlaybook` and from there into `ContractInput` (`contracts.ts`) as the id whose `body_set`
and `refs_set` count, and into `EndingInput` where a self-action is looked for. Everything the
runner does as itself — `claimCard`, `heartbeat`, `setRefs({ branch })`, the run-start comment,
`raiseNext`'s permission question, `endRun` — stays as `runner`.

Why a durable member and not one per run: *runs are disposable; identity is durable*
(`CLAUDE.md`). The crew's history across runs is attributable to one name, the way the owner's
is. Why not simply a different name for the same underlying member: the whole mechanism is that
the claim's `by` and the caller's `actorId` differ, so the two must be two rows.

### The gates

- `packages/shared/src/phases.ts`: `code.exit` → `"owner"`. The doc comment there — "the crew's
  only handoff is Code → PR, so `code` is the one phase any member may leave" — describes the
  006-era handoff, which 014 replaced with an attention request carrying the move. No other
  code change is needed for moves: `moveCard`'s existing owner-exit check now covers Code, and
  logs `move_rejected` as it does for the other phases.
- `core.ts` `archiveCard`: a non-human actor is refused outright, with the same `forbidden`
  shape the other refusals use. This is the one new rule in the core, and it is resolved from
  `CLAUDE.md`'s "*done is a human's call, the way merging is*" rather than from the milestone,
  which speaks only of an agent archiving its own card mid-run. An owner who disagrees can
  drop it without touching anything else.
- Nothing else in the core changes. `releaseCard`, `resolveAttention` and `claimCard` already
  refuse on the daemon's own state; what this spec does is put the agent on the other side of
  those checks.

### What 014 built, adjusted

`contracts.ts`'s `ContractInput.memberId` is documented today as "the `runner` member: whose
`body_set` and `refs_set` count as this run's". It becomes the crew member's id. `ending.ts`'s
`classifyEnding` keeps its self-action branch — it is defence in depth, and the branch costs
nothing — but it should look for actions by *either* the crew or the runner, since after this
spec only the runner can still perform one. `runAttention.raise`'s refusal when another member
holds the claim is unchanged: the runner holds it.

The self-action tests in `contracts.test.ts` (criteria 12 of 014) currently drive the agent's
move, release and archive as the runner member. After this spec, two of the three are refused
for the **runner too**: the new rules key on the actor's *kind*, and `runner` is an agent
member, so the runner itself can no longer move its card out of Code or archive it. That is
correct and intended — exempting `runner` by name would be an identity special case, the
opposite of deciding from state the daemon holds — and it means the self-move and self-archive
endings in `classifyEnding` become unreachable through the core. They stay as defence in depth.
The two tests become assertions that the core refuses even the runner's own move and archive,
with the run still ending on its contract; the self-release test keeps its shape, since a
member may still release its own claim. Beside them go the crew-refusal cases below.

(This paragraph was corrected during implementation: the spec as approved said the tests
"keep their runner-as-actor shape", which assumed the runner could still perform the actions.
It cannot, and the correction is the stronger reading of the spec's own principle.)

### Records

`allowlist.ts`'s *What a subprocess reaches* and rule 4, and `playbooks/code.md`'s subprocess
paragraph. Each says the verbs are reachable and refused, and that the refusal is the daemon's.
(The spec as approved also named the run-start comment; it never mentioned the verbs, and the
clause was dropped during implementation rather than satisfied by absence.) 013's criterion 10f
("no artefact claims a boundary a subprocess does not respect") is the standard: after this
spec the claim is that the daemon refuses, and that claim must be true.

### The existing tests this spec changes

`core.test.ts:282` — "an agent may move a card out of code, and the owner can send it back" —
asserts the behaviour this spec removes. It becomes its negation: the agent's move is refused
with `forbidden` and `move_rejected` is logged, and the owner's move out of Code succeeds.

It is not the only one, and the spec as approved was wrong to say so. Two rules that refuse
every agent — leaving Code, and archiving — necessarily change every existing test in which an
agent did either as a *fixture step* rather than as the subject: a test that had an agent move
a card to PR to set up a later assertion, or archive a card to test what archiving resolves.
Those tests keep their subject and change only the actor (to the owner) or the expected outcome
(to the refusal). The implementer enumerates every one in the run record, with what changed in
each, and the reviewer checks each against this rule: the subject is kept, and nothing is
asserted more weakly than before. A change that does not fit that description is a finding.

Also changed by consequence, and in scope: `phases.test.ts`'s exit map; `shim.test.ts` and
`protocol.test.ts` where they assert the member the agent speaks as; and `run.ts`'s filter that
keeps the agent from being fed its own comments back as user messages, which must learn the
crew member or the identity split introduces a self-echo loop. That last is a change the spec
did not name; it preserves an invariant `run.ts` already documents.

### Red-team

This spec grants a role — the `crew` member — so the check applies.

1. **Gate or boundary:** gate; see the Goal. Defeated by asserting another identity.
2. **What the grant reaches.** `crew` is an ordinary agent member: it can read any card;
   create a card, which lands in Idea, a phase it cannot leave; and on any card comment, set
   the body, set refs and raise attention — including on cards the runner does not hold, and
   including *over* the card's single open request, the runner's own permission question among
   them (013 designed for that: the run re-queues its ask). It can claim a *free* card in a
   claimable phase and then release its own claim. It cannot move any card, archive any card,
   resolve a request not addressed to it, or release or claim a card another member holds.
3. **Composed.** `crew` raising a request *to itself* and resolving it crosses nothing — the
   owner's gate is the owner's request. `crew` raising a request to the owner with `--move pr`
   is the intended handoff; the owner executes the move. But nothing limits the destination
   `crew` may *propose*: `validateMoves` accepts any phase, `Bash(skelcrew attention *)` is
   pre-allowed, so `crew` can raise `--move done` from Code and the owner's queue prints
   `skelcrew mv <id> done` as a ready-to-run line beside the agent's own note. Nothing is
   crossed — the owner is the gate and the queue shows who raised it — but the queue does not
   distinguish a move a met contract attached (always `pr` or `code`) from one the agent chose.
   Recorded; closing it is a spec of its own. `crew` setting `refs --pr` is the intended
   recording. `crew` claiming a *different* free card is the carried limitation from
   014 ("the runner's identity is unscoped"), now the crew's: out of scope, still recorded.
   `crew` setting the body of a card it does not hold is the same limitation.
4. **The enforcer is the core**, and it is run directly by every test in this spec; there is
   no model of it in between. The CLI path — `skelcrew --as crew mv 1 pr` against a running
   daemon — is exercised by at least one test so the refusal is seen where the agent sees it.
5. **What parses the identity.** `SKELCREW_AS` and `--as` name a member; `ensureMember`
   validates the name and creates an agent member on first use. A caller may name the owner's
   own name with kind agent and get a second member that renders under the same name — a
   display collision, not a gate crossing, and 015's ground. Out of scope, recorded.

**What remains open, and is not this spec's to close:** identity is an assertion over a local
socket with no auth — and `runner` and `crew` are names any caller can assert and thereby
*join*, so a live session speaking `--as crew` shares one member id with every spawned run,
its `skelcrew body` satisfies a Spec contract and its comments are swallowed by the self-echo
filter; a process the run spawned that outlives it is still `crew` (or whatever it says it is)
after the runner releases; `crew` is not scoped to its card. Each is written down in
`allowlist.ts`'s record.

## Acceptance criteria

1. `bun run check` passes. No test spawns a real coding agent or calls a model.
2. A spawned run's agent speaks as a member named `crew` of kind agent, distinct from `runner`:
   the card's claim is `runner`'s for the whole run, and a comment the agent posts is attributed
   to `crew` on the activity feed.
3. `skelcrew mv <id> pr` as `crew` on a card the runner holds is refused with a `forbidden`
   error, `move_rejected` is logged with `crew` as the actor, and the card's phase and claim are
   unchanged. The same for `mv <id> done` and `mv <id> idea`.
4. `skelcrew release <id>` as `crew` on a card the runner holds is refused, and the claim is
   unchanged.
5. `skelcrew archive <id>` as `crew` is refused, on a card the runner holds and on a free card
   alike; the card is not archived.
6. `skelcrew claim <id>` as `crew` on a card the runner holds is refused with a conflict, and
   the runner's claim is unchanged.
7. `skelcrew resolve <id> -m allow` as `crew` while the runner's permission question is open is
   refused, the request still stands, and the run's pending tool call is still pending.
8. A Spec run whose agent — as `crew` — writes a non-empty body finishes exactly as 014
   criterion 2 describes; one whose agent writes none fails as 014 criterion 3 describes. A Code
   run whose agent records `--pr` as `crew` and meets the other conditions finishes as 014
   criterion 4 describes.
9. The owner may move a card out of Code to any phase; a member of kind agent may not move a
   card out of Code to any phase.
10. Of 014's self-action endings (criterion 12 there), self-release still holds when the actor
    is the runner member itself; the runner's own move out of Code and its own archive are
    refused by the core like any agent's, the run still ends on its contract, and
    `classifyEnding`'s self-move and self-archive branches remain in place as defence in depth.
11. `allowlist.ts`'s *What a subprocess reaches* record and `playbooks/code.md`'s subprocess
    paragraph say the five verbs are reachable and refused by the daemon, and neither says the
    subprocess obtains them.
12. Existing 012, 013 and 014 coverage passes unchanged except where an agent left Code or
    archived a card, as a subject or as a fixture step: each such test keeps its subject and
    changes only the actor or the expected refusal, every one is enumerated in the run record,
    and none asserts anything more weakly than before. `core.test.ts`'s "an agent may move a
    card out of code" case asserts its negation.

## Tests

Against the core directly and, for the refusals, through the CLI as `crew` against a running
daemon, asserting what a member sees on the card:

- Each refusal in criteria 3–7 as its own case, each asserting the card's state is unchanged
  afterwards and, where the core logs a rejection, that it was logged with `crew` as the actor.
- The attribution in criterion 2, from a run against the scripted driver.
- 014's contracts with the writes coming from `crew` (criterion 8) — the existing contract
  tests re-pointed at the crew member, not duplicated.
- Criterion 9 for each phase as a destination.
- The runner-as-actor self-action cases kept (criterion 10).
- The two record assertions in criterion 11, following `playbooks.test.ts`'s existing pattern
  of asserting the sentence that carries the rule.

## Out of scope

- **Authenticating the socket.** Peer credentials, per-run tokens, or any mechanism that would
  let the daemon distinguish a spawned process asserting `--as runner` from the runner. Not
  possible for one OS user without OS-level sandboxing, and not this spec's claim.
- **Scoping `crew` to its card.** `crew` can still comment on, set the body of, or claim a
  card the runner does not hold. Carried from 014, now named against the right member.
- **Recording every refusal as a card event.** `moveCard` logs `move_rejected`; the release,
  archive, claim and resolve refusals throw without logging. A refused attempt is visible in the
  run's tool summary and log, not on the card's feed. Worth doing, and it is a small spec of its
  own so this one stays a change of identity and two rules.
- **Display-name collisions** between an agent member and the owner — 015's ground.
- **OS-level sandboxing of the check subprocess.** The only thing that would stop it writing
  outside the worktree, and a different milestone with a different cost.
- **Removing `RunQuestion`** now that `raisedBy` distinguishes the questions. The construction
  stays.
