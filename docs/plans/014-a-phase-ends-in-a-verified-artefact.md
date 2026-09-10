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
  `no commits on <branch> past <base>`, `uncommitted changes in the worktree at <path>`,
  `no pull request recorded during this run`, joined with `; ` in that (stable) order, under
  the heading `run finished without the Code phase's artefact:`.
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

Criterion 4 says "all four conditions" where the Code contract has three — as *Desired
behavior* ("commits on its branch past the base, left the worktree clean, and recorded the pull
request URL"), *The contracts* ("**Code**: three conditions") and criterion 5 (which lists
exactly three) all say. Implemented as three. The spec is left as written.

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
