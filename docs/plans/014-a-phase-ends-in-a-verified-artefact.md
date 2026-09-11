# 014 — A phase ends in a verified artefact — run record

## The base this was built on

014 was first built on `main` at `30f2821`, which had 011 and 012 but **not** 013 — 013 was
merged on the remote and had not been pulled into the local `main` the worktree was cut from.
The work was committed as `32e0a0f` and `origin/main` (carrying 013) was then merged into the
branch; *Composing the two constructions* below is that resolution. Everything above it
describes the first pass, and two of its notes are now obsolete: the allowlist no longer denies
every writing tool, so a real Code run can meet the Code contract, and `RunEnding.question`
does exist to build on.

The spec also says `git.ts` "can list commits in a range". It cannot — neither 011 nor 013
added such a method, so `commitsBetween` is added here. (013 added `showFile`, which does not
overlap it.)

## The steps

1. `git.ts`: `commitsBetween(repoRoot, base, branch)`, qualifying **both** ends as
   `refs/heads/<name>` inside the method, so no caller can pass a bare name.
2. `ending.ts`: three pieces.
   - `RunCore = Omit<Core, "requestAttention">` — the type run.ts and ending.ts see. A future
     ending path that raises attention directly does not compile.
   - `runAttention(core, memberId)` — the one helper every raise goes through. It refuses to
     replace a request that is not this run's own, refuses on an archived card, and refuses
     when another member holds the claim. (In the first pass it matched "this run's own"
     against a private set; after the merge it takes 013's `RunQuestion` — see below.)
   - `classifyEnding(...)` — the ending derived from the card's state at completion:
     self-action first (from the events, because the card cannot report it), then held, then
     released, then abandoned.
   - `endRun` gains a required `moves` and the `attention` helper; it releases as `blocked`
     when the raise was refused because a question of the agent's is standing.
3. `contracts.ts`: the Spec and Code contracts, read-only, returning
   `{ met, note, moves, refs? }`.
4. `run.ts`: the tail becomes — early reason, contract (read-only, awaits git), classify, act.
   `RunInput` gains `git`, `repoRoot`, `sinceSeq` and a narrowed `phase: PlaybookPhase`.
5. `runner.ts`: creates the attention helper, records the run's first sequence number after
   claiming, and passes the narrowed phase.
6. `playbooks/code.md`: record the PR on every run, name the base branch qualified in every
   diff, and export a spec file only where the repository already keeps specs — recording the
   path, and reusing the recorded one on a revision.

## Decisions the spec left open

- **Condition wording.** The Code failure names its unmet conditions as
  `no new commits on <branch> past <base>`, `uncommitted changes in the worktree`,
  `no pull request recorded during this run`, joined with `; ` in that (stable) order, under
  the heading `run finished without the Code phase's artefact:` and ending with
  `; the work is in <path>`. (First written without the exit ramp and with the path inside the
  dirty-worktree clause — round 1's Minor 6 — and without `new` — round 2's Important.)
- **The release reason when a question is standing** is `blocked`, on every path, not only on
  the artefact-complete one — the card is waiting on the owner's answer whatever the run's own
  outcome was, and one rule at one place is what the spec asks for.
- **Where the contract check runs relative to the classification.** The check is read-only and
  runs first; the card is then classified *after* those awaits, and the classification decides.
  A card that moved while git was running is therefore abandoned, not written to.
- **Spec body emptiness** is `body.trim().length > 0`: a body of whitespace is not a spec.
- **Commit list cap.** `rev-list` is newest-first and the card's refs hold at most
  `COMMITS_MAX_COUNT`; a longer range records the newest that many rather than failing the
  contract.

## Red, then green

Three rounds, in `packages/daemon/src/runner/contracts.test.ts` and `playbooks.test.ts`.

1. **The contracts** (13 cases). Every one failed with
   `run finished; the agent's session ended — the work is in …` — 012's ending, which reported
   a finish whatever the run produced.
2. **The endings** (16 cases). These were written after the ending code, so the red was taken
   by reverting the ending code — `run.ts` back to `input.stillHeld()` with no classification,
   and `endRun` back to releasing with the caller's reason. 9 of the 16 failed: the four
   self-action cases and the release-stop case timed out waiting for a comment that path never
   wrote, and the two blocked-release cases reported `finished` where a standing question means
   `blocked`. The other 7 — the abandonments, the lapse, and two question-stands paths — were
   already green under 012 and are regression coverage the spec asks for by name.
3. **The playbook** (4 cases). Failed on `refs/heads/`, `docs/specs`, `specPath` and
   `gh pr view --json url`, none of which `code.md` contained.

## A spec defect, reported and not edited

Criterion 4 said "all four conditions" where the Code contract has three — as *Desired
behavior* ("commits on its branch past the base, left the worktree clean, and recorded the pull
request URL"), *The contracts* ("**Code**: three conditions") and criterion 5 (which lists
exactly three) all said. Implemented as three, reported, and the spec left as written; the
owner corrected it in `b682c24`, alongside round 2's larger amendment.

## Composing the two constructions (the 013 merge)

013 and 014 answer the same recurring finding — *a rule enforced by convention at each call
site will be half-implemented* — at two different layers, and both layers are kept.

**013 answers "which request may this run replace?"** with a recorded value rather than an
inference: `RunQuestion` holds what the core wrote for the run's *own* permission question, and
`RunEnding.question` is required so a new ending path has nothing to leave out. That is a
better answer than 014's first pass, which matched the open request against a private set of
everything the run had raised: 013's is scoped to the one request that is genuinely dead once
the run is over, and it says why. 014's set is gone.

**014 answers "can a call site raise at all without going through the rule?"** with a type:
`RunCore = Omit<Core, "requestAttention">` is what `run.ts` and `ending.ts` see, so a direct
raise does not compile.

Composed: `runAttention.raise(cardId, request, question)` is the only way to raise, and it takes
013's `RunQuestion` as the answer to which open request it may replace. Both call sites in
`run.ts` go through it — 013's `raiseNext`, which raises the permission question and records
what came back, and 014's `endRun`. `RunEnding` requires `attention`, `question` and `moves`.
The helper also refuses on an archived card and on another member's claim, which is 014's
criterion 12.

### The one behaviour the merge had to change

013's `a claim released while the run waits ends the run` asserted an abandonment, and that the
run's permission question was left open. 014 criterion 10 says an explicit release that nothing
supersedes **stops** the run with a comment and a request, so the card waits rather than being
picked up again. The two rules meet on that path, and 013's own rule then applies to the open
request: it is the run's own dead question, so the ending replaces it — leaving it would put a
`resolve -m allow` that allows no tool on the owner's queue, which is the thing 013 exists to
prevent. The test now asserts the stop, the replacement, and that the question still stands in
the card's activity where it was raised. Its other assertions — the pending call denied, no
"proceeding", a later answer changing nothing — are unchanged.

## Review round 1

CHANGES REQUESTED: three Important, four Minor, no Criticals. The reviewer confirmed the two
constructions compose, the changed 013 test, criterion 13's per-path coverage, and
`classifyEnding`'s two event queries. What follows is what changed.

### The PR-recording command would have stalled every Code run (Important 2)

`code.md` prescribed `skelcrew refs <id> --pr "$(gh pr view --json url --jq .url)"`. The harness
asks outright for a command carrying a substitution (`bashMissKind:"shell-operators"`), whatever
the pre-allowed list says; `allowlist.ts` records both that refusal and that this repository's
*model* of it is deliberately looser, so `runsUnprompted` answered `true` and the discrepancy was
invisible from here. Every Code run — including every revision run, which criterion 6 requires to
re-record — would have stopped on a permission question to satisfy the one condition that decides
whether the phase can complete, and unattended would have hit the time limit and failed it.

Now two prescribed calls, each matching a fixed-list entry on its own: `gh pr view --json url
--jq .url`, then `skelcrew refs <id> --pr <the URL that printed>`, with a paragraph saying why
they must not be joined.

The guard is structural rather than a one-off fix: `no command either playbook prescribes carries
a shell operator` walks every fenced line in both playbooks and rejects `$(`, a backtick, `&&`,
`||`, `|` and `;`. It went red on exactly the one line, which also establishes nothing else in
either playbook carries one. A redirection is deliberately not in that set — the harness matches
its rule against the command with redirections stripped, which is what makes `spec.md`'s heredoc
fine.

### Re-deriving the ending assertions (Important 1)

The 16 ending cases were written after the ending code — disclosed under *Red, then green*, and a
real deviation from red-then-green, since these cover the invariant the spike half-implemented
five times. History cannot be rewritten, so instead every assertion was re-derived from criteria
8-14 **as the spec words them**, and each case now names the clause it checks. What changed:

- **An abandonment is checked against the spec's sentence**, "one comment saying so, and nothing
  else", through one `expectAbandoned` helper: the single comment, no request, and no release by
  the run. Previously the moved and archived cases only checked that the note was not the stop's.
  The helper deliberately does *not* assert the runner wrote nothing at all — a move or an
  archive queues 006's teardown, whose comment is not part of the ending.
- **Criterion 10** (the case the reviewer named) is now asserted clause by clause: the run stopped
  (`runs === 1`), the card is unclaimed *and* unarchived so only the open request keeps it out of
  the queue, the request is addressed to the owner, the comment and the note are the same text,
  the card is in the phase it was claimed in — which is what "not superseded" means, and what the
  release-then-move case above proves is decisive — and exactly one `claimed` event exists. The
  two readings the reviewer flagged are kept but re-grounded: the note says the run stopped rather
  than that it finished, and it offers no move because the spec attaches a phase move only to a
  met contract.
- **Criterion 12** now asserts `run failed` in the note, not only the description of what the
  agent did: "fails the run" is a clause of the criterion. The self-release case also asserts the
  body this run wrote is on the card and was still not accepted — the artefact check is skipped,
  not merely failed. The taken-over case asserts exactly one failure comment.
- **Criterion 11** now goes through `expectAbandoned` too, and says why the lapse is the reason
  and never the decision: a swept card is free and in its own phase, which is criterion 10's
  shape.

**No assertion had to change because it was wrong.** Every re-derived case passed unchanged; what
changed was the addition of clauses the criteria state and the tests had not checked. That is the
outcome to be sceptical of, so it is recorded plainly rather than claimed as vindication.

### The rest

- **Minor 4** — criterion 13 gained its lapsed-lease case: the agent asks, the lease lapses, the
  sweep runs, the question is still the card's request. It passed on first run; the finding was
  missing coverage, not wrong behaviour.
- **Minor 6** — every unmet contract note now ends `; the work is in <path>`, which is the
  owner's exit ramp from their queue. The dirty-worktree condition no longer repeats the path in
  its own clause, since the note now always carries it.
- **Minor 7** — `endRun` told a refusal apart from a throw. `raised === false` covered both, so a
  `ownerId()` lookup that threw — resolved inside the `try` on purpose, so a throwing lookup still
  releases — would have released a finished artefact as `blocked`. Now only the helper returning
  `undefined` means `blocked`. Red first, against a core whose `requestAttention` throws.
- **Minor 5** — the playbook assertions matched single words (`toContain("refs/heads/")` passes on
  §4's condition list alone). They now assert the sentence carrying each rule, against a
  whitespace-collapsed copy so a wrapped sentence can be asserted whole, and the prescribed
  commands as exact fenced lines. Verified by deleting §1's rule from `code.md`: the tightened
  test fails, the old one would not have.
- **Important 3** is a spec amendment — the *Tests* line "Existing 012 and 013 coverage must pass
  unchanged" cannot hold once criterion 10 reclassifies 013's release-while-waiting case — and
  goes to the owner. The spec file is not edited here.

## Review round 2

CHANGES REQUESTED: one Important, four Minor. Round 2 confirmed the re-derived ending
assertions clause by clause, the playbook guard, and both round-1 regression fixes.

### The Code contract was met by a revision run that did nothing (Important)

**A spec defect, faithfully implemented.** Condition 1 checked that the *range* past the base
was non-empty, not that this run added to it, and the spec relied on condition 3 — the PR
recorded by this run — for freshness. But the same spec's playbook section says to record the
pull request on *every* run, so recording is bookkeeping every run does regardless of work. A
card sent back for revision, a run that does exactly what §4 prescribes and commits nothing:
commits exist (the previous run's), worktree clean, PR recorded — **met**, and the card goes
back "ready for review" with the owner's feedback untouched. That is this spec's own Goal
sentence reproduced inside the mechanism built to stop it.

The red test reported it verbatim:

```
Expected to contain: "no new commits on skelcrew/1-idle-but-tidy past main"
Received: "ready for review: https://example.invalid/skelcrew/pull/1"
```

with the same test asserting `git rev-list --count refs/heads/main..refs/heads/skelcrew/1-idle-but-tidy`
is `1` — so the range genuinely is non-empty and nothing but freshness separates the two.

The owner amended the spec (`b682c24`): condition 1 gains a freshness clause. `runner.ts`
already resolved the branch head before the agent started and discarded it; it is kept and
threaded through `RunInput` and `ContractInput`, so the contract compares rather than making a
new git call. Both halves are one condition and name themselves as one —
`no new commits on <branch> past <base>` — because either way no new commits landed. The other
seven places asserting the old `no commits on` wording were updated.

`code.md` §4 states the clause, and adds what a revision run with nothing to do must do
instead: raise it and stop, rather than end a run that committed nothing. The time-limit edge
the spec calls out is left exactly as the spec decided — a run that did the work and timed out
before recording fails its next dispatch with the no-commits note, visibly and with an exit
ramp, and the owner moves the card by hand.

### The rest

- **Minor 1** — `"stopped"` was passed to `endRun` as a release reason on a path whose claim is
  by definition already gone, so it could never be recorded, and the criterion 10 test did not
  assert `lastRelease` at all. Kept as the ending's stated reason — `RunEnding.reason` is
  required by construction and making it optional would reopen the hole that requirement
  closes — with the call site saying plainly that it is never recorded, and the test now
  asserting the card's *one* release is the owner's, carrying the owner's reason. A future
  change that made the run release here fails that assertion.
- **Minor 2** — the playbook guard walked fenced lines only, while both playbooks name commands
  inline as often (`git push -u origin HEAD`, `skelcrew show <id>`). It now reads inline code
  spans too, but only those starting with a command word (`skelcrew`, `git`, `gh`, `bun`),
  which keeps ref names, flags and rule patterns out and needs no exclusion for §4's deliberate
  counter-example — that span starts with `--pr`. Verified by inserting an inline
  `git add -A && git commit -m wip`: the widened guard catches it. The rationale was also
  wrong and is corrected: a substitution or subshell is asked about *outright*, a list or
  pipeline is split and allowed when every part is. Lists and pipelines are still barred, now
  stated as a rule about what a playbook may set out rather than as a claim about the harness.
- **Minor 3** — `flushTools()` posted through `post`, which drops once the claim is gone, so on
  the stop and self-action endings up to one batching window of tool calls vanished while the
  ending's own comment landed. `post` is now `record` plus a claim check, and the flush happens
  after the ending is classified, using `record` on exactly the two endings that write to a
  card the run no longer holds. An abandonment still drops it — "one comment saying so, and
  nothing else" — and a test asserts each of the three.
- **Minor 4** — the *Decisions* entry quoted pre-round-1 condition wording; it now quotes what
  ships, and says which round changed each part.

## Review round 3

APPROVED. No Critical, no Important. Three Minor, carried to the pull request rather than fixed
in that round:

1. **The merged condition-1 note hides which half failed.** `no new commits on <branch> past
   <base>` is one message for a condition with two halves — an empty range, and a branch that
   did not move — so an owner reading it cannot tell which. That is what the spec asks for
   (criterion 6 and criterion 7 both say "the no-commits condition"), and the wording was chosen
   to be true of both; but the time-limit case the spec deliberately accepts is exactly the one
   where the distinction would help.
2. **`run.ts`'s header invariant was false.** Fixed below, in the round-3 fix pass.
3. **`commandsNamed`'s docstring overclaims inline coverage.** It reads inline spans starting
   with a command word, which is narrower than "every command a playbook names" — a command
   written without backticks, or one starting with a word outside `COMMAND_WORDS`, is not seen.
   Carried, not fixed: the fix round named the three prose absolutes and this was not one of
   them.

The round-3 review also checked ground no earlier round had named. The implementer declined to
reproduce that list from memory — inventing a reviewer's checks would be worth less than
nothing — so it is transcribed here by the orchestrator from the round-3 report, verbatim in
substance:

- `core.heartbeat` uses `liveClaim`, so it cannot revive a lapsed lease into a false `held`.
- The runner's pump is serial, so a same-member re-claim cannot make run *N*'s
  `classifyEnding` read run *N+1*'s claim.
- `isReady` requires `attention === null`, so a failed contract cannot loop the card through
  re-dispatch.
- The `refs_set` the runner writes at run start carries `set: ["branch"]` and cannot satisfy
  condition 3.
- The `no playbook` exemption from `runAttention` is unreachable today — only `spec` and `code`
  are claimable and both have playbooks — and is documented with the right caveat.
- The 013 test change is the single collision the spec names; nothing else in 012/013 coverage
  moved.

## Verification

FAILED, on documentation only. All 15 acceptance criteria PASS, the diff is within scope, and no
test, fixture or assertion was weakened. The failure was three prose absolutes in changed files,
each contradicted by code in the same file or the next one — fixed in the round-3 fix pass:

- `run.ts`'s header claimed "nothing is posted after an await without the claim still being this
  run's". False since round 2's Minor 3: `record` exists precisely so the stop and self-action
  endings can write to a card the run no longer holds, and two tests assert it. The header now
  names both exceptions and why the spec wants them.
- `ending.ts` claimed "every way a run can end goes through `endRun`", contradicted ninety lines
  below by `abandoned`, whose whole observable is written by `runner.ts`. It now says every
  ending that *hands the card to a member* goes through `endRun`, and that an abandonment does
  not and cannot.
- `code.md` claimed a command carrying any shell operator "is put to the owner whatever the
  pre-allowed list says". True of a substitution or a subshell; wrong of a list or a pipeline,
  which the harness splits and allows when every part is. It now matches the accurate version
  `playbooks.test.ts` already carried.

| # | Criterion | Where it is established |
|---|---|---|
| 1 | `bun run check`; no agent, no model | 489 tests green; every driver in these files is `fakeDriver` |
| 2 | Spec run with a body finishes | `a Spec run that writes a body hands the card on with the move into Code`; `a body that was on the card before the run is not this run's spec` |
| 3 | Spec run with no body fails | `a Spec run that writes no body fails, and the request offers no move` |
| 4 | Code run meeting all three finishes | `a Code run that commits, leaves the worktree clean and records its PR hands the card on` |
| 5 | Each unmet condition named; worktree kept | one test per condition, plus `a Code run failing two conditions names both` and `all three unmet are named at once`; the met test asserts no `specPath` |
| 6 | The three revision cases | `…re-records the same PR and makes new commits passes`; `…records nothing fails`; `…records the same PR but commits nothing fails` |
| 7 | Tag shadowing, both shapes | `a tag named after the base branch…`; `a tag named after the card's branch…` — but see the carried limitation below |
| 8 | Another member's claim abandons | `a card another member claims mid-run ends the run as an abandonment` |
| 9 | Move or archive abandons; ordering pairs | `a card moved mid-run…`; `a card archived mid-run…`; `a card moved away and back mid-run…` |
| 10 | Explicit release stops; no second run | `an explicit release stops the run with a comment and a request, and no second run starts` |
| 11 | Lapsed lease abandons and re-queues | `a lapsed lease abandons the run and returns the card to its queue as run_interrupted` |
| 12 | Self-action fails the run | three self-action tests, plus `a self-action after another member takes the card lands as a comment and nothing else` |
| 13 | A question stands on every path | seven cases here, one per path, plus 012's abort and throw cases in `run.test.ts` |
| 14 | Complete artefact, question standing | `a question stands when the artefact is complete…`, including the re-dispatch after the answer |
| 15 | The playbook's export and PR rules | four `playbooks.test.ts` cases, plus `no command either playbook names carries a shell operator` |

## Carried limitations

- **Criterion 7's fixtures no longer isolate the tag defect.** Since round 2's freshness clause,
  the branch in both tag-shadowing fixtures is created at the base and never moves, so
  `head === branchHead` fails condition 1 whatever the range resolves to — **both tests would
  now pass with bare names**. The protection itself is real and unchanged: `commitsBetween`
  qualifies both ends of the range inside the method, so no caller can pass a bare name, and the
  head is read through `refs/heads/<branch>`. What is gone is the independent pin: nothing now
  fails if someone unqualifies the range. Pinning it again needs a fixture where the branch
  *does* move during the run and the tag still shadows — a tag named after the base branch,
  placed at the branch's new head, so the bare range reads empty while the qualified one holds
  the run's commit, and only the qualification separates pass from fail. Named here, deliberately
  not added: it is outside the round-3 fix scope.
- **The runner's identity is not scoped to its card**, carried from 007 §7 and untouched here. It
  is why the attention helper lives at the runner boundary rather than in the core.
- **`runner.ts` still raises attention directly** for 006's no-playbook handoff, the one call
  site outside `runAttention`. Both 013's and 014's `ending.ts` record the exemption and what it
  rests on. It is where 016's identity check would sit.
