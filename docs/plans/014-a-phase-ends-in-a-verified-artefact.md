# 014 — A phase ends in a verified artefact — run record

## The base this was built on

The spec's *Current behavior* says "after 012 and 013". **013 is not on `main`** — it is
unmerged on `worktree-agent-asks-the-owner`. The base for this run is `main` at `30f2821`,
which has 011 and 012. Two consequences, both recorded rather than worked around:

- There is no `RunEnding.question` to build the attention construction on; the construction is
  built here from scratch (below).
- The fixed allowlist still denies every writing tool, so a *real* Code run cannot satisfy the
  Code contract today. The contract and its tests are still built and tested against the
  scripted driver, which is what the spec's *Tests* section asks for. 013 landing is what makes
  a real Code run able to meet it. Changing the allowlist is out of scope for 014.

The spec also says `git.ts` "can list commits in a range". It cannot — `Git` has no such
method, so one is added here.

## The steps

1. `git.ts`: `commitsBetween(repoRoot, base, branch)`, qualifying **both** ends as
   `refs/heads/<name>` inside the method, so no caller can pass a bare name.
2. `ending.ts`: three pieces.
   - `RunCore = Omit<Core, "requestAttention">` — the type run.ts and ending.ts see. A future
     ending path that raises attention directly does not compile.
   - `runAttention(core, memberId)` — the one helper every raise goes through. It refuses to
     replace a request it did not raise itself (matched against what the core recorded when it
     raised it), refuses on an archived card, and refuses when another member holds the claim.
     Returns whether it raised.
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

## Two places the spec did not match the tree

- The spec is written as though 013 had landed; it has not (see the top of this file).
- Criterion 4 says "all four conditions" where the Code contract has three, as *Desired
  behavior*, *The contracts* and criterion 5 all say. Implemented as three.
