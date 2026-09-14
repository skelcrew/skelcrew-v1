# 019 — Code is reviewed before the owner sees it

This is 008b from `docs/MILESTONES.md`. The milestone entry says the Code playbook "already
instructs its own review rounds". It does not, and never has: `packages/daemon/playbooks/code.md`
has no review step in any version of its history, and the sentence came from the 007 spike's
playbook, which was never shipped. So this spec has to build the loop as well as the count and
the stop. It is written as the smallest slice that does both.

## Goal

Today a Code run that produces a branch and a pull request hands the card straight to the owner.
The owner is the first reader of every change. In the file workflow that built this repository,
a fresh-context reviewer reads the diff first, sends findings back, and the implementer fixes
them, at most three times, before a human sees the pull request. `docs/plans/007-spike-retrospective.md`
§6 records why that budget must be the runner's: in the spike it never fired, because only a
human steering each round by hand held it.

After this spec, the runner runs the review itself. When a Code run meets its contract, the
runner starts a reviewer in a fresh subprocess in the same worktree. The reviewer records a
verdict on the card. Changes requested start a fix run; approval hands the card to the owner;
a third changes-requested verdict ends the run with what is still open and hands the card to the
owner anyway. The count is the runner's, held for the claim, and nothing the agent does moves
it.

This is a **gate**, not a boundary. It governs the ordinary course of a Code phase. What defeats
it is a reviewer that records an untrue verdict, and what that reaches is exactly what a Code
finish reached before this spec: the owner's own review of the pull request.

## Current behavior

- `packages/daemon/playbooks/code.md` §4: the phase ends in the artefact the runner verifies.
  There is no review step. The `Agent` tool is on the fixed allowlist (`allowlist.ts:226`), so an
  agent *could* delegate to a subagent, but nothing instructs it to and nothing could count it.
- `packages/daemon/src/runner/run.ts`, the end of `runPlaybook`: a met Code contract ends the
  card at once, `end(settled.note, ["pr"], "finished")`, which raises `ready for review: <url>`
  offering the move to `pr` and releases the claim.
- `packages/daemon/src/runner/runner.ts`, `run(id)`: one claim, one worktree, one call to
  `runPlaybook`, one ending. `playbooks.ts` types the playbooks as `Record<"spec" | "code", string>`.
- `packages/daemon/src/runner/allowlist.ts`: one `FIXED_ALLOWLIST` for both phases, with the
  write verbs a Code run needs (`git add`, `git commit`, `git push`, `gh pr create`) and the
  `Edit(//<worktree>/**)` anchor. `allowlistFor(git, repoRoot, base, path)` builds one list.
- `packages/daemon/src/runner/contracts.ts`: two contracts, Spec and Code. Nothing describes
  what a review run must produce.
- `packages/shared/src/types.ts:96-117`: the activity event kinds. There is no event for a
  review verdict; a reviewer's only way to say anything is a comment, which the runner would
  have to parse.
- `packages/daemon/src/runner/ending.ts`, `endRun`: when the comment or the request throws, it
  warns to stderr and releases the claim. A free card in a claimable phase is claimed again at
  once. 015's run record measured this at 186 runs in three seconds with nothing on the card.
  `docs/MILESTONES.md` files the fix under 008b.
- `.claude/agents/reviewer.md` and `.claude/skills/develop/SKILL.md` are the reference
  implementation: findings in three classes, a verdict line, three cycles, then stop.

## Desired behavior

**A Code run that meets its contract is reviewed before anyone is asked anything.** The card
shows, in order: the Code run's activity; a comment by `runner`, `review round 1 of 3 starting;
run log at <path>`; the reviewer's activity; the verdict. The claim stays the runner's the whole
time. No `released` event and no attention request sit between the Code run and the review.

**The reviewer records a verdict with a primitive of its own.** `skelcrew review <id> approved`
or `skelcrew review <id> changes-requested "<findings>"` writes a `review_recorded` event carrying
the verdict and the text. It is a member primitive: the owner can record one too, from the
terminal, and it renders on the card like a comment does, `reviewed: changes requested` followed
by the text with every line marked (015). The text is a multi-line field under 015's rule and
the comment byte cap. Findings are required with `changes-requested`; with `approved` the text
is optional and carries Minor findings, if any.

**Approved hands the card to the owner.** The card carries `ready for review: <url>`, the request
offers the move to `pr`, and the claim is released `finished`. This is 014's criterion 4 exactly,
now behind a review.

**Changes requested starts a fix run.** Under the same claim, in the same worktree, a new Code
run starts with the Code playbook. Its brief is the card: the findings are on it as the last
verdict. The Code contract applies to it unchanged, so a fix run that commits nothing fails the
way any Code run does, with the no-commits condition named, and the loop ends there. A fix run
that meets its contract is reviewed again: `review round 2 of 3 starting`.

**The third changes-requested verdict ends the run.** The runner comments and raises `review
budget spent: changes requested 3 times; the last review names what is open; the work is in
<worktree>`, offers the move to `pr`, and releases `finished`. No fourth review starts. The owner
decides: approve into PR as it stands, or comment and resolve, which makes the card ready and
starts a fresh run with a fresh budget.

**The count is the runner's.** It lives in the runner for the life of the claim. A verdict the
owner records, or one the agent records during a Code run rather than a review run, is activity
on the card and nothing more: the loop counts only verdicts recorded by `crew` during a review
run the runner started. A daemon restart releases the claim as `daemon restarted` (existing) and
the next run begins a new loop with a new budget. That is a recorded limit, not a feature.

**A review run has a contract of its own.** It must record a verdict, and it must leave the
branch where it found it and the worktree clean. A review run that ends without a verdict fails
with `review run ended without a verdict; the work is in <worktree>`. One that moved the branch or
left the worktree dirty fails naming that, whether or not it recorded a verdict. Either failure
keeps the worktree, raises with no moves, and the card stays in Code.

**A review run may read and run, and may not write.** Its tools are the read-only part of the
Code run's list plus `skelcrew review`: no file edits, no `git add`, `commit` or `push`, no `gh pr
create` or `gh pr comment`. File edits are refused outright rather than asked about, so a
reviewer that reaches for one gets a refusal and carries on instead of stopping the run on a
question. The repository's check commands run unprompted, the same way they do for a Code run,
because "absolutes are checked by running" is the reviewer's job.

**Every existing ending applies to every run in the loop.** The time limit is per run. The
daemon stopping, the owner releasing the card, another member claiming it, the card moving or
being archived, the agent leaving a question open: each ends the loop on the run it happened
in, with the ending 014 gives it. Comments the owner posts while a run is live reach that
agent; comments between runs are on the card for the next one.

**A run that cannot say why it ended parks the card.** When an ending's comment and request
both fail, the runner raises one fixed note, `run ended and could not record why; see the run log
at <path>`, so the card waits on the owner rather than going back into the queue. If that raise
fails too, the runner does not release the claim: the lease lapses on its own, `run_interrupted`
lands as 009 intends, and the card returns to its queue once per lease rather than at once.

**Spec runs are unchanged.** A Spec run that meets its contract hands the card to the owner as
today. Reviewing specs is out of scope.

## Implementation approach

### The verdict is a primitive, not a comment convention

*Conversation is never load-bearing.* A runner that read the last line of the reviewer's last
comment would be parsing chat, and 015 spent a spec on what a member can make a comment look
like. So the verdict is its own event and its own call, with the same shape and the same
validation as a comment:

- `packages/shared/src/types.ts`: `ReviewVerdict = "approved" | "changes_requested"`, and an
  activity event `{ type: "review_recorded"; data: { verdict: ReviewVerdict; text: string } }`.
- `packages/shared/src/protocol.ts`: `reviewCard: { params: { id; verdict; text? }; result: Activity }`.
- `packages/daemon/src/core/core.ts`: `review(id, { verdict, text }, actorId)` beside `comment`,
  with `comment`'s checks: the card exists and is not archived, the text passes 015's multi-line
  predicate, and the byte cap is `COMMENT_MAX_BYTES`. Any member may call it. A
  `changes_requested` with empty text is refused as invalid; the CLI refuses it first as a usage
  error.
- `packages/cli/src/commands/review.ts` in `attention.ts`'s shape: `review <id> <verdict>
  [text]`, where the verdict word is `approved` or `changes-requested`. `render.ts` renders the
  event as `reviewed: approved` or `reviewed: changes requested` on a line of its own, then the
  text with every line marked the way a comment's continuation lines are (015). The first line
  of the findings is marked too, unlike a comment's, because criterion 2 asks for every line and
  a finding quoting an activity entry is the ordinary case. (The spec as approved said "the same
  marked continuation a comment uses", which leaves the first line unmarked; the orchestrator
  aligned this sentence to criterion 2 during development.) `show --json` carries the event as
  stored.

### A third playbook, for a run kind rather than a phase

`packages/daemon/playbooks/review.md`, extracted from `.claude/agents/reviewer.md` the way the
two existing playbooks were extracted from `.claude/`: read `AGENTS.md`/`CLAUDE.md` first, read
the card, obtain the diff yourself as `git diff refs/heads/<base>...refs/heads/<branch>` with both
ends qualified, run the repository's checks, verify every acceptance criterion on the card's spec
against the code, check absolutes by running, never modify anything, classify findings
Critical/Important/Minor, and end with exactly one `skelcrew review` call. It says plainly that
`approved` requires no Critical and no Important findings, and that the reviewer's session ending
without that call is a failed run.

`Playbooks` in `playbooks.ts` becomes `Record<"spec" | "code" | "review", string>` and
`loadPlaybooks` reads all three. `PLAYBOOK_PHASES` stays the two claimable phases: review is a
run kind inside Code, not a phase, which is the settled architecture ("review cycles happen
inside a phase and show as activity, never as phases of their own").

`code.md` §1 gains one paragraph: a `changes requested` verdict on the card since this branch's
last run is the brief for this run. Address every Critical and Important finding. A finding you
believe is wrong is answered on the card, in a comment, not skipped; the next review reads the
card too. A fix run that concludes nothing should change raises that with `skelcrew attention`
rather than ending with no commits, which §4 already says.

### The loop runs under one claim

In `runner.ts`, `run(id)` for a card in Code becomes a loop rather than one call: a Code run;
if its contract is met, a review run; on `changes_requested` under budget, a Code run again; and
so on. `REVIEW_ROUNDS_MAX = 3` is a constant in `runner.ts`. Reasons for one claim rather than a
release between rounds:

- The count is then a number the runner holds and the agent cannot reach. 016's lesson is that
  a rule the agent can route around is not a rule; a count derived from the card's activity would
  be read from events the agent can write, since names are not credentials (018's record).
- No window opens between rounds for the card to be claimed by something else, and no dispatch
  logic has to derive "which kind of run comes next" from the card.
- The card reads as one run with rounds inside it, which is what the settled architecture asks.

What each run in the loop gets of its own: a `runQuestion`, a run log (`createRunLog` already
takes an ordinal), a `sinceSeq` read from the card just before it starts, and, for a Code run,
a `branchHead` re-read from `refs/heads/<branch>` just before it starts, so "moved during this
run" means this round. Between runs the runner calls the existing `stillHeld()`; a claim lost
between rounds abandons exactly as one lost during a round does.

`runPlaybook` in `run.ts` returns the contract's outcome to the caller when the contract is met,
rather than ending the card itself. Every other outcome — an unmet contract, a time limit, the
daemon stopping, a driver error, a self-action, a stop, an abandonment — still ends the card
inside `runPlaybook` through `endRun`, unchanged, and the loop stops when it sees the run ended.
The loop's own three endings go through `endRun` as well: approved (`ready for review: <url>`,
moves `["pr"]`, release `finished`), budget spent (the note above, moves `["pr"]`, release
`finished`), and a review contract unmet (`fail`).

Offering the move to `pr` on budget spent is a decision: the artefact exists and the runner
verified it, the review is a gate inside the phase, and an attention request carries its
resolving choices. The owner can also comment and resolve, which starts a fresh loop.

### The review contract

`contracts.ts` gains a third contract, chosen by run kind. Met: a `review_recorded` event by
`crew` with a sequence number inside this run, and `refs/heads/<branch>` resolving to the same
commit it did when the run began, and a clean worktree. Unmet names each failing condition in a
stable order: verdict, branch, worktree. The verdict the loop acts on is the last one recorded
during the run.

### The review run's grants

`allowlistFor` takes the run kind. For a review run the fixed part is: `Read`, `Glob`, `Grep`,
`Agent`, `TodoWrite`; `Bash(skelcrew show *)`, `Bash(skelcrew comment *)`,
`Bash(skelcrew attention *)`, `Bash(skelcrew review *)`; `Bash(gh pr view *)`,
`Bash(gh pr diff *)`, `Bash(gh repo view *)`. The scanned check commands are added the same way
they are for a Code run. The deny list is `Edit`, `Write` and `NotebookEdit`, path-less: every
file write is refused without asking. No `Edit(//<worktree>/**)` anchor exists on this list, so
nothing needs the `.git` deny entries either.

`harness-check.ts` (017) covers the review playbook's instructed commands and one representative
per entry of the review list, so `bun run check:harness` is the enforcer run for this list, as
it is for the Code list.

### Parking a failed ending

In `endRun`, the catch that today only warns also tries one more raise, through the same
`attention.raise`, with the fixed note above. The note is a constant plus the run log path, which
the runner itself made, so it cannot fail 015's predicate or the byte cap. If that raise throws,
`endRun` returns without releasing. `run.ts` and `runner.ts` pass the log path in for the note.

### Red-team

This spec grants a review run a tool list, so the check applies.

1. **Gate.** Said in the Goal. The subprocess a check command starts is outside every rule here
   (016), so a reviewer can write, commit and push through one. The review contract catches a
   moved branch and a dirty worktree; it does not catch a push of another ref, which 013 records
   for Code runs and which is no wider here.
2. **What each grant reaches.** `gh pr view *` and `gh pr diff *` are on the Code list already
   and 013 enumerated them; `--web` opens a browser and is the widest thing either does.
   `gh repo view *` likewise. `skelcrew review *` writes a verdict, which is the purpose; a
   verdict is text on the card and moves nothing by itself. `skelcrew comment *` and
   `skelcrew attention *` are 013's. No git write verb is on the list; git reads go through the
   harness's own flag-by-flag recognition, as for Code runs. `Edit`, `Write` and `NotebookEdit`
   are denied outright, and a deny outranks any allow.
3. **Composed.** `skelcrew review approved` recorded by anyone other than `crew` during the
   review run is ignored by the loop; recorded by `crew` during a *Code* run, through a check
   command or otherwise, it falls outside the review run's `sinceSeq` and is ignored too. A
   check-command subprocess plus nothing else can commit: the contract's branch-head comparison
   fails the run. A reviewer that approves untruthfully hands the card to the owner with
   `ready for review`, which is what every Code finish did before this spec, so the composition
   reaches nothing new. A caller asserting `crew` over the socket during the review window is
   the reviewer's own identity; a caller asserting `runner` is ignored by the actor rule. Both
   are 016's recorded limit, names are not credentials, and they are not made worse here.
4. **The real enforcer.** 017's `check:harness` runs the pinned harness on every instructed
   command and one representative per list entry. This spec's list does not exist yet, so it
   was not run while writing this; criterion 1 requires it to pass before the change ships,
   and every claim above about what runs unprompted is unverified until then. The one new entry
   shape, `Bash(skelcrew review *)`, is the shape of five entries 013 and 017 already verified.
5. **What parses the string.** The verdict text is a stored multi-line field: 015's predicate at
   the core, a marker on every line at the CLI. The runner's notes compose a count and the
   worktree path, both the runner's own. The review playbook's prescribed commands use `<id>`
   placeholders, which 017's `filled` already handles.

Open, and recorded as such: a restart resets the count; a subprocess reaches outside the
worktree (016); names are not credentials (016, 018).

## Acceptance criteria

1. `bun run check` passes. No test spawns a real coding agent, calls a model, or runs the real
   `gh`. `bun run check:harness` passes and reports the review playbook's instructed commands
   and one representative per entry of the review list among the commands it checked.
2. `skelcrew review <id> changes-requested "<text>"` records a `review_recorded` event with
   verdict `changes_requested`, that text, and the caller as actor. `skelcrew review <id>
   approved` records `approved` with empty text. `changes-requested` with no text is a usage
   error and records nothing. Text containing `\r` or ESC is refused and records nothing; text
   containing `\n` is stored as given. Text over `COMMENT_MAX_BYTES` is refused. A human member
   and an agent member can each record one. An archived card refuses. `skelcrew show` renders
   the event as `reviewed: changes requested` with every line of the text marked, and `--json`
   carries the event as stored.
3. A Code run that meets its contract is followed, under the same claim, by a review run in the
   same worktree whose system prompt is the review playbook: the card shows the Code run's
   activity, then `review round 1 of 3 starting; run log at <path>` by `runner`, then the review
   run's activity. Between the two there is no `released` event and no `attention_requested`,
   and the claim's holder is `runner` throughout. The review run's log is a separate file.
4. A review run that records `approved` ends the loop with `ready for review: <url>`, a request
   offering the move to `pr`, and the claim released `finished`. This is 014's criterion 4
   observed after a review.
5. A review run that records `changes_requested` on round 1 or 2 is followed, under the same
   claim, by a Code run whose system prompt is the Code playbook and whose first user message is
   the card, then by `review round N+1 of 3 starting`. The Code contract applies to that run: a
   fix run that commits nothing fails with the no-commits condition named, the worktree is kept,
   the card stays in Code, and no further review starts.
6. A third `changes_requested` verdict ends the loop: a comment and a request `review budget
   spent: changes requested 3 times; the last review names what is open; the work is in <path>`,
   the request offers the move to `pr`, the claim is released `finished`, and no fourth review
   run starts. The card carries exactly three `review_recorded` events by `crew` under that claim.
7. A review run that ends without recording a verdict fails with `review run ended without a
   verdict; the work is in <path>`, no moves, the worktree kept, the card in Code. A review run
   that moved the branch, or left the worktree dirty, fails naming that condition even when it
   recorded a verdict; the verdict is ignored.
8. The driver sees the review run's grants: `allowedTools` holds exactly the review list plus
   the scanned check commands, with no `Edit(` entry, no `git add`, `git commit`, `git push`,
   `gh pr create` or `gh pr comment` entry; `disallowedTools` holds `Edit`, `Write` and
   `NotebookEdit`. A Code run in the same loop sees the Code list unchanged from 013 and 016.
9. Verdicts outside a review run do not count: an `approved` recorded by the owner before the
   review run starts, and an `approved` recorded by `crew` during the Code run, each leave the
   review run's outcome to the verdict the review run records. A review run that records two
   verdicts is judged by the last.
10. Each existing ending, on the review run: the time limit ends the loop with 014's time-limit
    note; the daemon stopping ends it as `daemon stopping`; the owner releasing the card ends it
    as a stop; another member claiming it ends it as an abandonment; the agent leaving a question
    open at the end of a review run that recorded `approved` leaves the question standing,
    comments that the artefact landed, offers no move, and releases as blocked. In each case the
    ending is the only one recorded for the claim.
11. A comment the owner posts while a review run is live reaches that run's agent as a user
    message.
12. An ending whose comment and request both throw raises the fixed note `run ended and could
    not record why; see the run log at <path>` as the card's attention request, and no second run
    starts. When that raise also throws, the claim is not released, no second run starts before
    the lease lapses, and `run_interrupted` lands when it does.
13. A Spec run that meets its contract hands the card to the owner with `spec ready` and no
    review run, exactly as 014 criterion 2.
14. `runner.ts` says the count is held for the claim and that a restart begins a new budget;
    `allowlist.ts` records the review list, that it is a gate, and what defeats it; `ending.ts`
    says what a parked ending looks like on the card.

## Tests

Against the scripted driver and real temporary git repositories, asserting what a member sees:

- The `review` primitive, criterion 2, at the core, over the socket, and through the CLI,
  including the refusals. 015's existing field tests are the pattern.
- The loop end to end in `contracts.test.ts`: approve on round 1 (4); changes then approve (5,
  with the fix run's first user message asserted to be the card); three changes (6); a fix run
  that commits nothing (5); a review run with no verdict, one that commits, one that leaves the
  worktree dirty (7). The scripted driver branches on `options.systemPrompt` to play the
  reviewer or the implementer.
- Criterion 3's ordering and the claim's holder, from the card's activity.
- Criterion 8 from the options the driver receives, for both run kinds in one loop.
- Criterion 9's three cases.
- Criterion 10, one case per ending, on the review run. These are 014's criteria 8 through 14
  moved one run later, and a test per path is the point.
- Criterion 12's two cases, driving `endRun` with a core whose `comment` and `requestAttention`
  throw, and then one whose `requestAttention` always throws, asserting no second run starts.
- Criterion 1's `check:harness` coverage in `harness-check.test.ts`, the way 017 tests its own.

**Existing tests change in one way.** Ten cases in `contracts.test.ts` end a Code run with a
met contract and assert `ready for review`. After this spec that ending comes after a review
run, so each of those scripts must also play the reviewer and approve. Their final assertions
do not change; only the script gains the review branch. Any other change to an existing
assertion is a finding.

## Out of scope

- **Reviewing Spec runs.** The Spec contract stands as 014 built it.
- **A verifier run** after approval, as `/develop` has one. The Code contract is the runner's
  verification of the artefact; a separate acceptance-criteria pass is a later slice if the
  loop proves too permissive.
- **Cross-member review** by a second runner, and any second-machine tier.
- **Making the budget configurable** by environment or by repository. Three is `/develop`'s
  number and the milestone's.
- **A count that survives a daemon restart.** Recorded as a limit above.
- **The owner steering the loop with their own verdict.** `skelcrew review` by a human is
  activity only.
- **Killing a subprocess's process group**, and OS-level sandboxing of the reviewer (016).
- **`hello` refusing the reserved member names** (018's carried finding).
- **Anything after the PR phase**: merging is 018, the default branch moving is 008c.
- **A raw-body output mode for `skelcrew show`** (015's carried Minor), though the review
  playbook will read the spec from the card the way `code.md` §5 does.
