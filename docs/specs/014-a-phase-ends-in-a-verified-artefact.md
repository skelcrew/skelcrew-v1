# 014 — A phase ends in a verified artefact

## Goal

After 012 and 013 an agent runs, asks, and finishes — and the runner takes its word for it. A
run that did nothing at all hands the card to the owner as though it had worked. This spec makes
the runner check: a phase advances only when the artefact that phase promises actually exists.

It also decides what a run does when the world changes underneath it — the card moved, archived,
released, claimed by someone else, or acted on by the agent itself. That is where the 007 spike
spent most of its eight review rounds, and `docs/plans/007-spike-retrospective.md` §3 records
both the invariants and the shape of fix that finally held. **Read §3 before designing this**:
the same rule was half-implemented five times, each round finding the next call site that lacked
it, and the cure was construction rather than vigilance.

## Current behavior

After 012 and 013:

- A run that ends normally hands the card back with 006's shape — a comment, an attention
  request, a release — regardless of what the agent produced
  (`packages/daemon/src/runner/runner.ts`, and the run's completion in `run.ts`).
- Nothing inspects the worktree, the branch, or the card's refs before that handoff, and the
  attention request carries no phase move, so every finish needs the owner to decide what
  happened as well as whether to accept it.
- A run whose card is moved, archived or released mid-run aborts the agent, and the outcome is
  decided from flags a core-event handler accumulates as those events arrive.
- 011 gives `CardRefs` a `specPath` and makes `refs_set` record which keys a call set. Nothing
  reads either yet.
- `packages/daemon/src/runner/git.ts` can list commits in a range and report a worktree's status.

## Desired behavior

**Spec finishes when there is a spec.** A Spec run that wrote a non-empty body onto its card
during the run hands the card to the owner with the move into Code attached, and releases as
finished. One that did not fails, says so, and asks — the card stays in Spec.

**Code finishes when there is a branch, a spec and a pull request.** A Code run must have
produced commits on its branch past the base, left the worktree clean, and recorded during this
run both the path where it committed the card's spec and the pull request URL. Meeting all four
hands the card on with the move into PR attached. Failing any of them names **every** unmet
condition, keeps the worktree, and asks.

Two things the artefact rule turns on, both learned the hard way:

- **The recording must be new, not the value.** A card sent back from PR for revision pushes to
  the same branch and keeps the same pull request, so requiring a *different* URL would strand
  every revision. Requiring nothing lets an idle revision run hand the card on again using the
  previous run's commits. What must be new is that this run recorded it — which 011's recorded
  keys make exact.
- **A branch name is not a ref.** Git resolves a bare name by precedence and `refs/tags/<name>`
  outranks `refs/heads/<name>`, so a repository holding a tag named after its base branch makes
  a commit-range check compare against the tag — and a run that committed nothing passes. Both
  ends of the range are qualified.

**A run never writes to a card whose claim it has lost.** If the card has moved, been archived,
or been claimed by someone else while the run was live, the run abandons: one comment saying so,
and nothing else. An explicit release by the owner that has *not* been superseded stops the run
with a comment and a request, so the card waits rather than being picked up again a moment
later. A lapsed lease abandons and re-queues, as 009 intends.

**An agent that moves, releases or archives its own card fails the run.** The phase ends in a
verified artefact and a card the agent moved has skipped that check. The failure is recorded on
the card wherever it ended up — but if another member now holds the card, the record is a
comment only, because this run's failure is not the new holder's queue to fill.

**A question the agent raised is never replaced by the run's own note**, on any path — success,
failure, abort or stop. When the agent has an open question and the artefact is nonetheless
complete, the run says the artefact landed, leaves the question standing, and releases as
blocked rather than offering the owner an approval over an unanswered blocker. Answering the
question makes the card ready again, and the phase runs afresh.

## Implementation approach

### The contracts

In `run.ts`, at the end of a run whose session ended normally and whose claim is still held.

**Spec**: a `body_set` event by the runner with a sequence number inside this run, and a
non-empty body on the card now. Met → attention request `spec ready` carrying the move to
`code`, release `finished`. Unmet → `run finished without a spec`.

**Code**: four conditions, and the failure message names every one that is unmet, joined, in a
stable order:

1. commits in `refs/heads/<base>..refs/heads/<branch>`, both ends qualified;
2. a clean worktree;
3. a `refs_set` by the runner within this run whose recorded keys include `specPath`;
4. a `refs_set` by the runner within this run whose recorded keys include `prUrl`.

Met → the commits are written to the card's refs, an attention request `ready for review: <url>`
carries the move to `pr`, release `finished`.

Conditions 3 and 4 are what 011 exists for. Without the recorded keys they could only be
approximated, and the approximation is what shipped a stale spec and passed an idle revision.

### The endings

**Derive the ending from the card's state when the run completes; consult the recorded events
only for the reason, never for the decision.** A handler that accumulates flags as events arrive
must remember to update them for every event kind, and the spike proved it will not: the flags
were corrected four times and the fifth case — a new claim after a release — was still wrong.
A derivation reading the card cannot be wrong about an event kind nobody thought of, because it
does not depend on having handled one.

The shape: what the agent itself did is answered first, because the card cannot report it — the
state the card is in is the agent's own doing. Then, if the claim is still this run's, the
contract runs. Otherwise the card is read: free, unarchived, still in this run's phase and never
moved away means an explicit release, reported so the card waits; anything else — another
member's claim, a move, an archive, a lapse — is an abandonment, one comment and nothing more.

### One place raises attention

Every attention request a run makes goes through a single helper that refuses to replace a
request the caller did not raise for itself. This is the construction that ends the recurring
class: `fail`, `finish`, the stop paths and the runner's outer exception handler all raise
through it, and a future call site cannot skip a rule it cannot reach around.

**The rule cannot be phrased as "another member's request".** The agent runs as
`SKELCREW_AS=runner`, so its `skelcrew attention` question and the run's own requests share a
`raisedBy`. Only the run knows which request is its own, from what the core recorded when it
raised it — which is also why this helper belongs at the runner boundary and not in the core.

### The playbooks

`code.md` gains the parts the contract now requires: record the committed spec's path with
`skelcrew refs --spec` on every run; on a card returning from PR, read that recorded path back
and bring the file into line with the card's body if the owner revised it, rather than matching
by number or content; record the pull request on every run, reading the existing URL with
`gh pr view --json url` when the branch already has one; and name the base branch unambiguously
wherever it computes a diff.

## Acceptance criteria

1. `bun run check` passes. No test spawns a real coding agent or calls a model.
2. A Spec run that writes a non-empty body finishes: the card carries `spec ready`, the request
   offers the move to `code`, and the claim is released `finished`. A body that existed before
   the run does not count.
3. A Spec run that writes no body fails with `run finished without a spec`, the card stays in
   Spec, and the request carries no moves.
4. A Code run meeting all four conditions finishes: the card's refs carry the run's commits, the
   request reads `ready for review: <url>` and offers the move to `pr`, release `finished`.
5. Each unmet Code condition produces a failure naming it, the worktree is left in place, and
   the card stays in Code: no commits; a dirty worktree; no `specPath` recorded during the run;
   no `prUrl` recorded during the run. A run failing two conditions names both.
6. A revision run that re-records the **same** `prUrl` and the **same** `specPath`, and makes
   new commits, passes. A revision run that records neither fails, even though the card already
   carries both values and the branch already carries the previous run's commits.
7. In a repository holding a tag whose name equals the base branch's, and whose card branch has
   no commits past the base branch, the Code run fails with the no-commits condition. A tag whose
   name equals the card's branch does not change the result either.
8. A card claimed by another member while a run is live ends that run as an abandonment: one
   comment, no attention request, and the other member's claim intact.
9. A card moved or archived while a run is live ends it as an abandonment, and a move that
   follows a release supersedes the release.
10. An explicit release by the owner that is not superseded stops the run with a comment and a
    request, and no second run starts.
11. A lapsed lease abandons and returns the card to its queue as `run_interrupted`.
12. An agent that moves, releases or archives its own card fails the run with a comment naming
    what it did. If another member holds the card by then, the comment lands and no attention
    request is raised.
13. On every path — success, failure, abort, daemon stop, and each ending above — an open
    question raised by the agent is still the card's attention request afterwards.
14. A run whose artefact is complete but whose agent left a question open comments that the
    artefact landed, leaves the question standing, offers no phase move, and releases as
    blocked. Resolving the question makes the card ready and a fresh run starts.
15. A Code playbook run on a card returning from PR reuses the recorded spec path rather than
    allocating a new number, and updates that file when the card's body has changed.

## Tests

Against the scripted driver and real temporary git repositories, asserting what a member sees:

- Both contracts, met and unmet, with each unmet condition as its own case and the joined
  message for two (2–5).
- The revision cases in criterion 6, which are the ones three earlier attempts got wrong.
- The tag-shadowing repository shapes in criterion 7, built as fixtures rather than asserted at
  the unit level — the bug is invisible to a test using unambiguous names.
- Every ending in criteria 8–12, each as its own case, including the ordering pairs
  (release-then-move, release-then-claim, release-then-archive).
- Criterion 13 on each path separately. This is the invariant that was half-implemented five
  times; a test per path is the point, not redundancy.
- Criterion 14 including the re-dispatch after the answer.
- Existing 012 and 013 coverage must pass unchanged.

## Out of scope

- **Cycle budgets and in-run review loops.** The Code playbook instructs its own review rounds;
  runner-managed cycle machinery, and bouncing a card between phases automatically, belong to
  008. The distinction is deliberate: an in-session instruction and a runner-enforced budget are
  different things.
- **Merging, and anything after the PR phase.** The owner merges.
- **Dry-run merging PR branches when the default branch moves**, conflict bouncing, and rebase
  briefs. 008.
- **Scoping a run's identity to its card.** Still carried; it is why the attention helper lives
  at the runner boundary rather than in the core, but this spec does not fix it.
- **Recording which keys a `setRefs` call set** — that is 011, and this spec consumes it.
- **Changing the allowlist or the asking flow** from 013, or streaming and the transcript from
  012.
