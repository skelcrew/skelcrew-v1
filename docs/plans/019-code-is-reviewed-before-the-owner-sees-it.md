# 019 — Code is reviewed before the owner sees it

Run record for `docs/specs/019-code-is-reviewed-before-the-owner-sees-it.md`.

## The change, in steps

1. **The verdict as a primitive.** `packages/shared/src/types.ts` gains `ReviewVerdict` and the
   `review_recorded` event; `protocol.ts` gains `reviewCard`; `core.ts` gains
   `review(id, {verdict, text}, actorId)` with `comment`'s checks; `server/protocol.ts` gains the
   handler; `packages/cli/src/commands/review.ts` and `render.ts` give it a surface.
2. **A third playbook.** `packages/daemon/playbooks/review.md`, extracted from
   `.claude/agents/reviewer.md`. `playbooks.ts` loads three (`PlaybookKind = PlaybookPhase |
   "review"`); `PLAYBOOK_PHASES` still names the two claimable phases. `code.md` §1 gains the
   paragraph about a `changes requested` verdict being this run's brief.
3. **The review run's grants.** `allowlist.ts` gains `REVIEW_ALLOWLIST` and
   `REVIEW_DENIED_TOOLS`; `allowlistFor(git, repoRoot, base, path, kind)` takes the run kind.
4. **The review contract.** `contracts.ts` gains `reviewContract`, chosen by run kind;
   `ContractOutcome` carries the verdict the loop acts on.
5. **The loop.** `run.ts`'s `runPlaybook` returns the contract's outcome when it is met rather
   than ending the card; `runner.ts`'s `run(id)` becomes Code → review → Code … under one claim,
   with `REVIEW_ROUNDS_MAX = 3`, and owns the three endings the loop has of its own.
6. **A parked ending.** `ending.ts`'s `endRun` takes the run log path and, when its comment and
   its request both throw, raises one fixed note; if that throws too it releases nothing.
7. **The harness check.** `harness-check.ts` puts the review playbook's instructed commands and
   one representative per review-list entry through the pinned harness, under the review list.

## Files expected to change

- new: `packages/daemon/playbooks/review.md`, `packages/cli/src/commands/review.ts`
- `packages/shared/src/{types,protocol,index}.ts`
- `packages/daemon/src/core/core.ts`, `packages/daemon/src/server/protocol.ts`
- `packages/daemon/src/runner/{playbooks,allowlist,contracts,run,runner,ending,harness-check}.ts`
- `packages/daemon/playbooks/code.md`
- `packages/cli/src/{main,render}.ts`
- tests: `core.test.ts`, `server/protocol.test.ts`, `cli.test.ts`, `render.test.ts`,
  `contracts.test.ts`, `run.test.ts`, `allowlist.test.ts`, `playbooks.test.ts`,
  `harness-check.test.ts`
- this record

## What the spec left open, and how it was decided

- **The verdict text renders on its own lines, every line marked.** The spec says both "through
  the same marked continuation a comment uses" (§ *The verdict is a primitive*) and "with every
  line of the text marked" (criterion 2, and the *Desired behavior* paragraph). A comment's
  `continued()` leaves the first line unmarked, beside its label. Criterion 2 is the binding
  form, so `reviewed: changes requested` stands alone on its line and the text follows through
  `marked()`. No line of the text can then read as a line the CLI composed.
- **A fix run is announced too.** The spec names the comment before a review run
  (`review round N of 3 starting; run log at <path>`) and says nothing about the one before a
  fix run. Each run has a log of its own, and a log path nobody can see is not observable, so a
  fix run posts `fix run starting; run log at <path>`.
- **Every run in the loop gets its `sinceSeq` just before it starts**, which for the first run
  moves it from the `claimed` event to the run's own start comment. Nothing between the two is
  an event any contract or ending counts.
- **A met Code contract goes to review even with the agent's own question standing.** The loop's
  condition is the contract, as the spec words it. The review run's ending then finds that
  request standing, offers no move and releases `blocked`, which is what criterion 10's last
  clause asks for one run later.
- **The scan's narrowing is read from the Code list for both kinds.** `narrowedCommands()` is
  unchanged, so a scanned line naming `git`, `gh` or `skelcrew` contributes nothing to a review
  run either — a review list read on its own would not narrow `git` at all, and a repository
  documenting `git push --force` would have granted it to the reviewer.
- **`problemsIn` takes the lists under test**, rather than one representative array, because
  there are now two lists and each entry's representative has to run under its own list.

## Red, then green

Each slice was written as a failing test first, run, and the failure read before anything was
implemented:

- **The verdict primitive.** `core.test.ts`'s three cases failed with
  `TypeError: core.review is not a function`; over the socket,
  `RpcError: unknown method "reviewCard"`; through the CLI,
  `error: unknown command "review"`; and `render.test.ts` with
  `Expected to end with: "reviewed: approved" / Received: "… simon  undefined"`.
- **The review playbook.** `PLAYBOOK_KINDS` and the two list constants were added as empty
  scaffolding first so the failure would be an assertion rather than an import error; with a
  stub `review.md` in place, five of the seven new playbook tests failed on their assertions
  (the advertisement, the instructed commands, the verdict rules, the diff rule, AGENTS.md).
- **The review list.** Four `allowlist.test.ts` cases failed with the Code list where the
  review list was expected (`allowlistFor` ignored its new argument).
- **The loop.** All ten new `contracts.test.ts` cases failed; the first on
  `expect(round).toBeGreaterThanOrEqual(0) / Received: -1` — no review round had started.
- **The parked ending** was the one place the implementation came first, because `endRun`'s
  signature had to change with the loop. Its two tests were checked for teeth afterwards by
  disabling the park block (`if (false && !said)`): both then failed, waiting for an attention
  request and a warning that never came. Restored, both pass.

**Existing assertions changed in three places, all of them structural:**

- Seven `contracts.test.ts` cases whose Code run meets its contract now use `scripted(…)`
  rather than `fakeDriver(…)`, so the driver also plays the reviewer and approves. No assertion
  in them changed.
- `protocol.test.ts`'s two method-parity tests learned one rename: the core's `review` is
  `reviewCard` on the wire, which is the same stand-in mechanism `ensureMember → hello` uses.
- `harness-check.test.ts` moved from one representative array to the two lists under test,
  because coverage is now counted per list.

## Two places the spec's own wording pulls in two directions

Both are called out rather than silently resolved:

- **The rendering.** *The verdict is a primitive* says "the same marked continuation a comment
  uses" (`continued()`, which leaves the first line beside its label); criterion 2 and *Desired
  behavior* both say "every line of the text marked". The criterion is the binding form, so the
  findings stand on their own lines under the verdict and every one of them carries `> `.
- **What parks an ending.** Criterion 12 says "an ending whose comment **and** request both
  throw". 014's existing case — a core whose `requestAttention` always throws while the comment
  lands — asserts that a met artefact still releases `finished`. So the park fires only when the
  comment itself failed, which is what "nothing on the card says why" means, and 014's assertion
  stands unchanged.

## Checks

- `bun run check` — 706 tests, green.
- `bun run check:harness` — 49 commands under test plus the control: 30 under the Code list
  (the spec and code playbooks' instructions, a representative per entry, the repository's
  fenced `bun run check`) and 19 under the review list (the review playbook's instructions, a
  representative per entry, the same fenced command). Every one ran unprompted;
  `git push origin HEAD:main` was denied; the temporary repository was unchanged.

## Review round 1, and what each finding became

One Important, six Minor, no Critical. Every finding is fixed. The spec was amended first
(`docs:` commits `6aeb9ff`, `fa89dc0`) and the amended wording is what the code now matches.
Three of the seven change behaviour, and each of those was driven red first.

- **Important 1 — the playbook told the reviewer a second verdict fails the run, and it does
  not.** `reviewContract` takes `recorded.at(-1)`, criterion 9 blesses it, and
  `contracts.test.ts`'s "a review run that records two verdicts is judged by the last" passes.
  So the playbook was the artefact to change: §5 now says a run that ends without a verdict is a
  failed run, then "Record one verdict and mean it. If you record a second, the last one you
  recorded is the one that counts." No code moved. The cost of the old sentence was concrete —
  a reviewer that changed its mind and then raised `skelcrew attention` about it would have its
  approval ending refuse the raise and release `blocked`, parking a clean approval on the owner.
- **Minor 2 — `allowlist.ts` counted one defeat and then named three.** The paragraph now says
  "defeated in three recorded ways, of which the contract catches one" and numbers them: the
  check command's subprocess (the contract catches it), a push of another ref (nothing here
  does), and an untrue `approved` (which reaches the owner's own review, as every Code finish
  did before 019). Prose only.
- **Minor 3 — a met Code contract started a review under the agent's own standing question.**
  Settled by the spec amendment at `fa89dc0`: before each review run the loop reads the card's
  request and, when one stands that this run may not replace (`question.isOpen` is false), ends
  there with 014's ending for a met artefact under a standing question — `endRun` comments that
  the artefact landed, its own raise is refused for the same reason, no move is offered and the
  claim is released `blocked`. Red first, in the finding's own shape: *`Expected: false Received:
  true`* on "no `review round 1 of 3 starting` comment". The new case also asserts one system
  prompt seen by the driver, no verdict on the card, the question still the card's request, and
  `blocked`. Criterion 10's case — the reviewer's own question at the end of an approved review
  run — still passes, because the check runs before a review rather than after one.
- **Minor 4 — the step label before the branch-head read said "open the run log".** `step` is
  now `read the ${kind} branch head` before the `revParse` and `open the ${kind} run log` just
  before `createRunLog`. Red first, with a git whose `revParse` fails once the Code run's commits
  are recorded: *Expected to contain "read the review branch head failed"; received "open the
  review run log failed: fatal: ambiguous argument"* — which is exactly the misreport the finding
  named.
- **Minor 5 — every run's prompt came from the `Card` read at claim time.** `runOnce` now passes
  `core.getCard(id)`, so a fix run's brief is the card as it is now. Red first, with the owner
  editing the body while the review run is live: *Expected to contain "Goal: ship it, and the
  second half too."; received the body the first run read.* Criterion 5's own case asserted byte
  identity with the first run's brief (`toBe(briefs[0])`); it now asserts the brief carries the
  card's body as it stands, which is what "the first user message is the card" means. Nothing
  else in that case changed.
- **Minor 6 — nothing told the reviewer the findings are capped.** §5 gained one paragraph: the
  findings are a field under a comment's cap, 16 KiB; a longer text is refused, the call exits
  non-zero and nothing is recorded; cut the findings rather than lose the verdict. Written
  without a backticked command, so `instructedCommands` harvests nothing new — `check:harness`
  still puts 49 commands through the harness, 19 of them under the review list.
- **Minor 7 — the time-limit case's budget also bounded the Code run before it.** The runner's
  limit is one number for every run in the loop, so 1500 ms bounded five real git spawns as well
  as the reviewer. The budget is now 3000 ms with the case's own 20 s timeout, and the comment
  says why. Nothing about the limit can be driven from `now()`: it is a `setTimeout` on the real
  clock, and the runner has no per-kind limit to give the review run a shorter one without
  widening the spec.

**Knowingly unchanged.** The guard is on the Code → review transition alone, which is what the
amended spec settles. A *reviewer* that raises its own question and records `changes_requested`
still starts a fix run under that standing request; that run cannot raise a permission question
either, and its ending releases `blocked` with the question standing. Naming it here rather than
widening the rule the spec states.

**Checks after the round.** `bun run check` — 709 tests, green (706 before, plus the three new
cases). `bun run check:harness` — 49 commands under test plus the control, all unprompted,
`git push origin HEAD:main` denied, the temporary repository unchanged.

## Review round 2, and what each finding became

One Critical, one Important, three Minor. Every finding is fixed. The spec was amended first
(`docs:` commit `6a6b644`) and the amended wording is what the code now matches. Three of the
five change behaviour, and each of those was driven red first. The Critical is the case round 1
named as **knowingly unchanged** above: the orchestrator settled it the other way, and that
paragraph is superseded by this one.

- **Critical 1 — the guard ran at the top of the round, so it bound the Code → review
  transition and not the review → fix one.** A reviewer that raised its own `skelcrew attention`
  question and recorded `changes_requested` — both of which its playbook instructs — left the
  loop free to start a fix run under that unanswered request, and that run could raise no
  permission question of its own and would block until its time limit. The check is now one
  helper, `endedUnderAStandingQuestion()` in `runner.ts`, called at both transitions; it ends
  with the same `end(met.note, met.moves, "finished")`, which `endRun` turns into the comment,
  no move and `blocked`. Red first, in the finding's own shape: *Expected: false Received: true*
  on "no `fix run starting` comment". The new case also asserts two system prompts and no more,
  the reviewer's question still the card's request, and `blocked`.
- **Important 1 — the playbook prescribed the findings double-quoted.** Against the pinned
  harness a backtick or a `$(` inside double quotes is a command substitution and is asked about
  outright, and `.claude/agents/reviewer.md` — the source of this playbook — writes locations in
  backticks, so backticked findings are the ordinary case. Unattended that costs the whole round:
  nobody answers, the run burns its time limit and the contract fails with `review run ended
  without a verdict`. §5 now prescribes `skelcrew review <id> changes-requested '<the findings,
  Critical first>'` with the reason and two rules — write locations as `path:line` with no
  backticks, and never an apostrophe in the findings, because an apostrophe ends the string —
  the way `code.md` §4 warns about its own one required call. The check could not have caught it:
  the playbook's template fills to a bare `'PLACEHOLDER'`. So the review list's representative for
  `Bash(skelcrew review *)` is now ``skelcrew review 1 changes-requested 'Critical: runner.ts:480
  calls `endRun()` too late'`` — a backtick inside single quotes — and `check:harness` reports it
  `ran` unprompted.
- **Minor 3 — the control command was appended to the Code list's sessions alone.** A
  review-list session that allowed everything would still have passed on the strength of the
  Code list's one denial. The control is now appended to every list under test and `problemsIn`
  requires one denial per list, for the same reason coverage is counted per list: a command is
  only evidence about the list it ran under. Red first, on two new cases — a list with no
  control of its own, and a list whose control the harness allowed — each failing with the old
  whole-run rule (*Expected: 1 Received: 2*, the second control read as a duplicate).
- **Minor 4 — the guard excludes the run's own permission question.** Kept, as the amended spec
  says, with the reason now in `runner.ts` beside the check: an ending replaces that question
  (013), so a met contract under it hands the card on with the offer, and widening the guard
  would let a run that triggered a permission question and then finished skip the review.
  Whether the harness can end a session with an ask outstanding is recorded there as unverified.
  Prose only.
- **Minor 5 — `logPath` survived from one round to the next.** A review run whose
  `allowlistFor` or `revParse` threw before it opened its own log parked the card pointing at the
  *Code* run's log. `runOnce` now clears `logPath` first, so the parked note is
  `run ended and could not record why` with no path rather than a wrong one. Red first, with the
  round-1 branch-head failure and a core that refuses that ending's comment and request:
  *Expected to not contain "…/runs/1-…jsonl" / Received: "run ended and could not record why; see
  the run log at …/runs/1-…jsonl"*.

**Checks after the round.** `bun run check` — 714 tests, green (709 before, plus five new cases).
`bun run check:harness` — 49 commands under test plus the control under each of the two lists;
every one ran unprompted, including the verdict representative with its backtick in single
quotes; `git push origin HEAD:main` was denied under each list; the temporary repository was
unchanged.
