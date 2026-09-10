# 007 — Spike retrospective: what building the runner taught

007 (*Runner runs the phase playbooks*) was specified, implemented, reviewed eight times and
then **parked rather than merged**, so it could be split into smaller specs. This file exists
so that split costs a fraction of what the spike cost: it carries the knowledge forward, and
the specs that replace 007 should read it before they are written.

**Where the work is.** Branch `worktree-runner-playbooks` on `origin`, tip `3cb6d64`,
14 commits, never merged. `docs/specs/007-runner-runs-playbooks.md` is the spec it was
built against and is left in place unchanged — it is the record of what was intended, and the
numbering rule forbids reuse. The detail behind everything below:

- `docs/plans/007-runner-runs-playbooks.md` — the run record: the plan, the decisions the spec
  left open, four internal review rounds and five external ones.
- `docs/plans/007-runner-runs-playbooks-conformance-review{,-2,-3}.md` — three independent
  conformance reviews by a different vendor's model (Codex/`gpt-6-astra`).

Its final state was green — `bun run check`, 359 tests — with every finding from all eight
rounds landed. It was parked because the spec was too large to review well, not because the
code was failing.

## 1. What the spike settled, and should not be re-litigated

These held up under eight rounds of adversarial review. The replacement specs should build on
them rather than reopen them:

- **The agent boundary is one interface with the SDK behind it.** `AgentDriver` with a `none`
  and a `claude` implementation; exactly one file imports the SDK. Every test runs against a
  fake driver, so no test spawns an agent or calls a model. This is what makes the "skelcrew
  never calls a model" constraint checkable rather than aspirational.
- **`bunfig.toml` with `[install] peer = false`** keeps the SDK's peer packages —
  `@anthropic-ai/sdk` among them, an actual model client — off disk entirely, while the SDK
  still imports and runs. Verified by inspection of `node_modules`, not assumed.
- **The agent reaches skelcrew through a generated shim on its `PATH`**, speaking as the
  `runner` member, with `SKELCREW_AS` and `SKELCREW_DIR` in its environment. The shim `exec`s
  `process.execPath`, not a `bun` found on `PATH`, so it works under launchd where `PATH` is
  minimal. No agent-only surface was needed: the agent uses the same CLI a human does.
- **Phase handoffs as context boundaries work, and are the source of most review value.** The
  reviewer never inherits the implementer's context. Every finding that mattered came from a
  reviewer with no memory of why the code looked the way it did.
- **A different vendor's model as an independent reviewer found what four rounds of the same
  vendor's reviewers missed.** Two Important findings on its first pass, on code that had
  already been through four internal rounds and a verification.

## 2. Domain facts, dearly bought

Each of these cost at least one review round to discover. A replacement spec that does not
encode the relevant ones will rediscover them the same way.

**The core queues nested mutations.** A mutation raised from inside a dispatch handler is
queued, not applied immediately. Anything that must happen *as part of* resolving an event —
raising the next queued permission request inside `attention_resolved`, for instance — has to
be written with that in mind.

**Several events can arrive in one dispatch, and order matters.** Comments seen in a single
dispatch have to be held and flushed in order. Only the comment whose `seq` is
`attention_resolved.seq - 1`, by the same actor, is the answer to a request.

**`moveCard` emits its own `released` afterwards.** A release with `reason: "moved"` from the
core is not a member releasing the card. Telling those apart is required, and getting it wrong
means either re-dispatching a card the owner just moved, or failing to notice a real release.

**Member identity cannot distinguish the agent's question from the runner's own note.** The
agent runs as `SKELCREW_AS=runner`, so `skelcrew attention` raised by the agent and an
attention request raised by the runner have the same `raisedBy`. Any rule phrased as "do not
replace another member's request" is therefore the *wrong rule* — only the run knows which
request is its own. **This is the concrete cost of the runner's unscoped identity**, and it
blocks the architecturally cleaner fix (putting the invariant in the core). Sequence the work
that gives a run a claim-bound identity accordingly.

**`refs_set` records the merged refs, not the keys the call set.** So "did this run record a
PR?" cannot be answered precisely from the event; a run that writes any other ref while a
`prUrl` sits on the card satisfies the same check. Closing that needs the core to record which
keys a `setRefs` touched.

**Git resolves a bare ref name by precedence, and `refs/tags/<name>` outranks
`refs/heads/<name>`.** A repository with a tag named after its base branch makes
`git rev-list <base>..<branch>` compute against the tag. Reproduced: a tag one commit behind
the branch reports one commit where the truth is zero, so a run that committed nothing passes
a commits-based artefact check. Qualify **both** endpoints. The exception, verified: `git
worktree add <path> <branch>` must stay unqualified — the qualified form detaches HEAD.

**A second-resolution timestamp is not a unique filename.** Two runs of one card starting in
the same second collide, and an open-and-truncate destroys the first run's transcript while
its card comment still points at it. Exclusive create (`flag: "wx"`) with a suffix, not finer
resolution: resolution narrows the window, exclusivity closes it.

**`Bash(x *)` matches every command beginning with `x`.** That is wildcard matching; `Bash(x:*)`
is the legacy prefix form. Verified against the installed Claude Code, whose own rule validator
warns that a wildcard before the subcommand also matches inserted options — so `git -c
<anything> log` is arbitrary execution. A permission list that reads as a convenience is a
security boundary; see §4.

**The SDK stream is not the display projection.** Translating SDK messages into what a card
shows silently drops kinds that display nothing — `system/init`, plain user messages,
thinking-only assistant messages — and duplicates messages that contain several blocks. If the
transcript is written from display events, it is not a transcript. Log at the driver boundary,
on arrival, independent of the projection.

## 3. Invariants — and every place they were violated

The pattern that dominated this spike: **a rule enforced by convention at each call site will
be half-implemented, and each round finds the next site that lacks it.** Six findings came from
this. The cure is construction, not vigilance.

**A run must never write to a card whose claim it has lost.** Violated by: a failed run
replacing a question the agent raised (round 1); a *successful* finish doing the same thing
(external round 1 — the unfixed twin of the round 1 fix); `stopWith` and the runner's outer
exception handler, neither of which had the guard (external round 3); a release followed by a
new claim, because the event switch cleared its flags for moves and archives but not claims
(external round 4); and a self-action raising attention into a new holder's queue (external
round 5).

*What finally worked:* one helper that every raise goes through, plus deriving the run's ending
from **the card's current state at completion** rather than from flags an event switch has to
remember to maintain. Consult the recorded events for the *reason*, never for the *decision* —
then an unhandled event kind cannot silently change the outcome.

**A phase ends only in a verified artefact.** The Code contract was rewritten three times and
each version admitted a different wrong run: requiring a *new* PR URL stranded every revision;
dropping "recorded during the run" let an idle revision hand the card on using the previous
run's commits; a bare ref name let a run with no commits at all pass. The spec's own words —
*a `prUrl` set during the run* — were right the whole time, and both wrong versions came from
drifting off them.

**Artefact identity must be recorded, not re-derived.** Three rounds of playbook prose failed
to answer "is this the card's spec, or a different one?" — matching by number deadlocked
revision runs, matching by content broke when the owner revised the text, matching by "number
or content" left a stale spec in the PR. It was only fixed by *recording the path* when the
spec is first committed. The same shape appears in the PR question ("same PR or a new one?").
**This is the single strongest signal for the replacement specs:** the card needs honest
identity for the artefacts it produces — a spec path alongside `branch`, `commits` and `prUrl`
— rather than heuristics that re-derive it.

## 4. The spec's own defects

Two of the eight rounds were spent on defects that were **in the spec and implemented
faithfully**. Both were permission grants: `Bash(gh pr *)` pre-allowed `gh pr merge`, and
`Bash(git *)` pre-allowed `git push origin HEAD:main` and arbitrary execution via `git -c`.
Each dissolved the attention gate that same spec exists to build, and no amount of
implementation quality would have caught them.

A spec that grants an agent permissions is specifying a security boundary and must be reviewed
as one, against the matching semantics of whatever enforces it, before implementation starts.
This is now in `.claude/skills/spec/SKILL.md`, with the reviewer given "spec defects,
faithfully implemented" as a named finding class.

Related, and easy to miss: the allowlist also absorbs commands from fenced blocks in the
*target* repository's `AGENTS.md`/`CLAUDE.md`. Narrowing the fixed list is undone by any repo
whose instructions show a `git status` line, unless the scan is forbidden from widening a
command the fixed list narrowed.

## 5. Why it was split

007 was 3,576 insertions across 25 files in one spec: the agent boundary, the SDK driver, the
shim, the permission allowlist, two playbooks, activity streaming, the transcript, permission
routing, both artefact contracts, and the whole claim lifecycle — leases, heartbeats, aborts,
daemon shutdown, and every way a card can move out from under a running agent. It was also the
first spec where skelcrew touches the outside world: subprocesses, the network, and actions
that cannot be undone.

Eight review rounds found roughly twenty-one real defects and no hallucinated ones. The
findings did not scatter — they converged on the structural causes recorded above. But a spec
that needs eight rounds is a spec that could not be reviewed in one, and the phases that touch
the outside world are exactly where the combinatorial cases live.

## 6. Process lessons, already applied

In `.claude/` on `main` (commit `3818ab5`), and due to be extracted into the daemon's built-in
playbooks when the runner learns to run review phases:

- **`/spec`** — a permission grant is a security boundary, not a configuration detail.
- **reviewer** — "spec defects, faithfully implemented" is a finding class; a finding that
  proposes relaxing a rule the spec states must argue against the spec's own wording.
- **implementer** — change exactly what the finding names; the neighbouring condition dropped
  "while in there" is what opened the next round's hole, four times.

Two more, not yet applied anywhere:

- **A fix is not done when its reported case passes** — it is done when the cases next to it
  have been looked at. Every "fixed" written into a run record was read as settled by every
  later reviewer, which is how five half-fixes survived multiple rounds.
- **Commit each review round separately.** The internal rounds were squashed into one commit,
  and an external reviewer correctly noted that the claimed red-before-green chronology could
  not be verified from history at all.

`/develop` budgets three review cycles and this run took eight. The budget never fired, because
nothing in the loop surfaces it — it held only because a human was steering each round by hand.
A gate that depends on someone remembering to read it is not a gate; the playbooks the daemon
ships should count their own rounds and stop.

## 7. Carried limitations, still open

- **The runner's identity is not scoped to its card.** A run on card 1 can write to card 7,
  attributed to `runner`; only playbook text keeps it on its own card. See §2 for why this is
  more than hygiene — it blocks the correct place for the attention invariant.
- **Nothing sandboxes the agent.** The narrowed allowlist governs what the agent may do
  *unprompted*; everything else remains available by asking the owner. A bare `git push` under
  a repo-level `push.default = matching` can still push more than the card's branch.
- **`selfAction` after another member takes the card** still records a comment on a card the
  run no longer holds. Deliberate — it is an accountability record — but it is a real
  exception to §3's first invariant.
- **The Code playbook budgets its own review cycles** while the spec defers cycle budgets. An
  in-session limit and runner-managed cycle machinery are different things; the distinction
  belongs in whichever spec introduces the latter.
