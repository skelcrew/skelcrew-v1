# 020 — A conflicting pull request asks to go back to Code

This is 008c from `docs/MILESTONES.md`. The milestone marks it deferred until two cards land close
together; the owner chose to specify it now. So this is the smallest slice that closes the gap
the milestone names, and everything it does not do is in *Out of scope* with a reason.

## Goal

When the owner merges one pull request, the default branch moves, and another card's pull
request can stop being mergeable. Today nothing notices. The card sits in PR looking ready, the
owner finds the conflict when they try to merge, and the fix — merge the base into the branch,
resolve, push, re-review — starts from a terminal, which is what skelcrew exists to avoid.

After this spec, the merge poll that 018 built also reads whether each PR card's pull request
conflicts with its base. A conflict raises an attention request to the owner with the move back
to Code attached and the fix spelled out. One gesture, `skelcrew mv <id> code`, starts a Code run
that merges the base in, resolves the conflict, pushes to the same pull request, and (with 019)
goes through review again before the card returns to PR.

The daemon does not move the card itself. `merges.ts` records the one condition under which the
daemon acts as the owner: a gesture the owner has already made, about this card, that the daemon
can verify. Merging another card's pull request is not a gesture about this one. So the bounce is
offered, not made, and the attention queue is where it shows.

This spec grants a Code run two exact commands. That grant is a **gate**, not a boundary: the
subprocess a check command starts can already do anything (016), and what defeats the grant is
that. What the grant governs is that a fix run does not stop on a permission question for the
two commands its brief tells it to run.

## Current behavior

- `packages/daemon/src/merges.ts`: once a minute, for every unarchived card in PR with a `prUrl`,
  the poll asks `gh pr view <url> --json state,mergedAt,headRefName,url` (`forge.ts`, `PR_FIELDS`),
  compares the pull request's repository and head branch against what a run or the owner
  recorded, lands a merge in Done, comments a mismatch, and raises attention on a pull request
  closed without merging. An open pull request is nothing on the card, whatever state it is in.
- `packages/daemon/src/runner/forge.ts`: `PullRequest` carries `url`, `state`, `mergedAt`,
  `headRefName`, `baseRepo`. `gh pr view --json` also offers `mergeable` (`MERGEABLE`,
  `CONFLICTING`, `UNKNOWN`) and `baseRefName`; neither is asked for. The enum values were read
  from the GraphQL schema while writing this; a merged pull request answers `UNKNOWN` for both
  `mergeable` and `mergeStateStatus` (run against PR #16).
- `packages/daemon/src/runner/git.ts`, `defaultBranch`: "No fetch: the local head is the base."
  The runner reads `refs/heads/<base>` and never fetches, so after a merge on the forge the
  local base is behind until the owner pulls. A Code run that merged the local base into its
  branch would not pick up the commits that conflict.
- `packages/daemon/src/runner/allowlist.ts`, `FIXED_ALLOWLIST`: no `git fetch`, no `git merge`.
  A run that needs either stops on a permission question. `git push` is granted in two exact
  forms, so a force-push asks; `code.md` says never to force-push.
- `packages/daemon/playbooks/code.md`: nothing about conflicts or about bringing the base into
  the branch.
- `packages/daemon/src/core/core.ts`, `moveCard`: a move by the owner resolves any open
  attention request as `moved`. `resolveAttention` refuses a non-human actor clearing a request
  addressed to someone else, so the runner cannot clear a request it raised to the owner.
- 018's carried findings name `gh pr view --json mergeCommit` as a stronger ownership check
  for this milestone. It is not taken here; see *Out of scope*.

## Desired behavior

**The poll notices a conflict.** For a card in PR whose pull request is open, is this card's own
work by 018's check, and whose forge answer says it conflicts with its base, the card gets an
attention request to the owner: `pull request <url> conflicts with <base>; <branch> needs
refs/remotes/origin/<base> merged in`, with the move to `code` attached, raised by `runner`, and
the same text as a comment immediately after. The card stays in PR. Nothing moves it.

**Once, and only for the card's own pull request.** The request is raised once per entry into
PR, the way 018's closed-without-merge request is: an identical comment by the runner since the
card entered PR means nothing is said again. A conflicting pull request that is not this card's
work (another repository, another branch) is nothing on the card. An open request the poll did
not raise stands, and nothing is said over it. `unknown` mergeability is nothing on the card; the
next tick asks again.

**When the conflict clears while the request is open**, the poll comments once: `pull request
<url> no longer conflicts with <base>`. The request stands until the owner acts, because the core
does not let the runner clear a request addressed to the owner, and the comment says what
changed.

**The owner's one gesture is a move.** `skelcrew mv <id> code` resolves the request as `moved`,
the runner claims the card, reuses or re-adds its worktree on the same branch, and the Code run
starts with the card as its first user message, the conflict note on it.

**The Code run can bring the base in without asking.** Two exact commands run unprompted in a
Code run: `git fetch origin <base>` and `git merge --no-edit refs/remotes/origin/<base>`, where
`<base>` is the runner's default branch name. `code.md` tells a run whose card carries a conflict
note to run exactly those two, resolve what conflicts, `git add`, `git commit`, `git push`, and
record the pull request again as §4 already requires. It says never to rebase, because a rebase
needs a force-push, which asks and which the run never does. The Code contract applies
unchanged: the merge commit moves the branch, the worktree is clean, the pull request is
recorded, and the run ends in the review loop 019 builds, or, before 019 lands, in the handoff
014 built.

**A base name that cannot be written into a rule is not written.** A branch name may contain
`)`, and a `)` inside a `Bash(...)` entry ends the rule early. When the default branch's name is
not made only of the characters the allowlist already permits in a scanned line, the two entries
are left off, the run-start comment says so, and the two commands ask like anything else.

## Implementation approach

### The forge answers one more question

`forge.ts`: `PR_FIELDS` gains `mergeable` and `baseRefName`. `PullRequest` gains
`mergeable: "mergeable" | "conflicting" | "unknown"` and `baseRefName: string`. `parsePullRequest`
maps `MERGEABLE` and `CONFLICTING` to the two named values and anything else, including an absent
field, to `unknown`, so an older `gh` that does not return the field degrades to "nothing on the
card" rather than to a parse failure. The recorded real output in `forge.test.ts` gains the two
fields as `gh` 2.86.0 renders them.

What is verified and what is not, recorded in `forge.ts`: the three enum values are from the
schema; a merged pull request answers `UNKNOWN`; the answer for a live conflicting pull request
was not observed while writing this spec, because none existed — the implementer then observed
one (`cli/cli#14285`, `"mergeable":"CONFLICTING"`), and `forge.ts` records the real answer
(orchestrator's note, added during development). GitHub computes mergeability
lazily and answers `UNKNOWN` until it has, which is why `unknown` is nothing and the poll simply
asks again.

### The poll's fourth outcome

`merges.ts`, `visit`: after the re-read, an open pull request is no longer an early return. When
`mismatch(card, pr, repoUrl, binds)` is undefined and `pr.mergeable === "conflicting"`, the
conflict path runs in the shape of the closed path: `saidSince` on the note, `attention.raise`
with `moves: ["code"]` through `ownRequest(note)`, the comment after a raise that took. When the
pull request is open and mergeable and the card's open request is the poll's own conflict
request for this URL, the "no longer conflicts" comment goes through `record`. Everything else
about an open pull request stays nothing.

Which branch name the note uses: the pull request's `baseRefName`, because that is what the
forge merged against; the grant below uses the runner's default branch name, because that is
what the runner knows before any forge is asked. In a repository where the two differ the note
and the grant disagree, and the run asks. That is recorded as a limit, not handled.

The precedent paragraph in `merges.ts` (point 1) is the reason this spec raises rather than
moves. Add one sentence there naming this spec as the first that argued against it and did not
take the exception.

### Two exact grants, composed per run

`allowlist.ts`: `allowlistFor` already receives the default branch name. It adds
`Bash(git fetch origin <base>)` and `Bash(git merge --no-edit refs/remotes/origin/<base>)` as
exact entries, no wildcard, only when `<base>` matches the single-word form of `LINE_CHARS`.
Otherwise it adds nothing and the `scanned` line says `base branch "<name>" cannot be written into
a rule: git fetch and git merge will ask`. `RunAllowlist` is unchanged in shape.

`harness-check.ts`: the list under test includes the two entries composed for `main`, and
`FIXED_LIST_REPRESENTATIVES` gains the two commands themselves, since an exact entry's
representative is the entry. `unrepresentedEntries` already handles exact entries.

`code.md` gains a short section, *When the card says the pull request conflicts*, with the two
commands in fenced blocks (so 017's `prescribed` harvests them), the never-rebase rule, and the
rest of the fix in prose that names commands already on the list.

### Red-team

1. **Gate.** Said in the Goal.
2. **What each grant reaches.** Both are exact strings, so the flag surface is what is written.
   `git fetch origin <base>` updates `refs/remotes/origin/<base>` from origin, and nothing else:
   no `--upload-pack`, no refspec of the run's choosing. `git merge --no-edit
   refs/remotes/origin/<base>` writes the worktree and the branch head, runs the repository's
   merge hooks and any merge driver the repository's own config names, and cannot name a
   strategy (`-s <name>` runs `git-merge-<name>` from `PATH`, which is why a wildcard form of
   this entry does not exist). `--no-edit` is there so the command never waits on an editor.
3. **Composed.** With `git push` (bare): the merge commit is pushed to the card's branch, which
   is the point; local `<base>` does not move, so `push.default = matching` pushes nothing more
   than it would have. With the scan: the allowlist reads instruction files from
   `refs/remotes/origin/<base>` because no tool call could write that ref. After this spec one
   can, but only to what origin holds, and the only thing that puts content on origin's `<base>`
   is the owner merging. `allowlist.ts`'s sentence about that ref changes to say exactly that.
   With `git add` and `git commit`: they conclude a conflicted merge, as intended. With the
   check commands: a subprocess could already fetch, merge, rebase and force-push (016); this
   grant adds nothing to that.
4. **The real enforcer.** 017's `check:harness` is the enforcer run, and criterion 1 requires it
   to cover both entries and both instructed commands. Neither existed while writing this, so it
   was not run; the claim that an exact entry composed from a branch name matches the command
   exactly rests on 013's verified `Bash(git push)` and `Bash(git push -u origin HEAD)` entries,
   which are the same shape.
5. **What parses the string.** The base name goes into a `Bash(...)` rule the harness re-reads
   character by character (`allowlist.ts`, the transcription of `td`): `)` closes the rule early
   and space or comma opens another. The single-word `LINE_CHARS` check is the allowlist, and
   omitting the entries is the loud failure. The base name also goes into the attention note
   and the comment; git refuses control characters in ref names, and the note goes through
   `postingCore`.

Open, recorded as such: `mergeable` on a live conflicting pull request was observed once during
development, not by a test, and never on a pull request of this repository's own; the
grant uses the runner's default branch name while the note uses the pull request's base, and the
two can differ; a subprocess reaches past every entry here (016).

## Acceptance criteria

1. `bun run check` passes. No test runs the real `gh` or a real coding agent. `bun run
   check:harness` passes and reports `git fetch origin main` and `git merge --no-edit
   refs/remotes/origin/main` among the commands it checked, both as list representatives and as
   commands the Code playbook instructs.
2. `parsePullRequest` maps `"mergeable":"MERGEABLE"` to `mergeable`, `"CONFLICTING"` to
   `conflicting`, `"UNKNOWN"` and an absent field to `unknown`, and carries `baseRefName`. The
   recorded merged, open and closed outputs in `forge.test.ts` include both fields and still
   parse as 018's tests expect.
3. A card in PR whose faked forge answer is open, conflicting, in this repository and from the
   card's recorded branch, after one tick: an open attention request to the owner, raised by
   `runner`, note `pull request <url> conflicts with <base>; <branch> needs
   refs/remotes/origin/<base> merged in`, moves `["code"]`; a comment with the same text
   immediately after the `attention_requested` event; the card still in PR; no `card_moved`. A
   second tick adds nothing.
4. The same answer for a pull request in another repository, or from another branch, or on a
   card no run or human recorded a branch on: nothing on the card.
5. An open, mergeable answer, and an open, unknown answer: nothing on the card (018's
   criterion, re-asserted with the new fields present).
6. With the poll's own conflict request open and the next answer open and mergeable: one comment
   `pull request <url> no longer conflicts with <base>`, the request still open, and a further
   tick adding nothing.
7. With a request the poll did not raise open, a conflicting answer raises nothing and says
   nothing; once the owner resolves it, the next tick raises the conflict request.
8. After the conflict request, `skelcrew mv <id> code` by the owner: the request is resolved as
   `moved`, the runner claims the card, and the Code run's first user message is the card whose
   activity includes the conflict comment. Against the real runner and a scripted driver.
9. A Code run's `allowedTools` contains `Bash(git fetch origin <base>)` and `Bash(git merge
   --no-edit refs/remotes/origin/<base>)` for a repository whose default branch is `main`, and
   neither entry when the default branch is named `main)` or `main,x`; in that case the
   run-start comment says the base branch cannot be written into a rule and that the two
   commands will ask. No wildcard form of either entry exists on any list.
10. `code.md` instructs the two commands in fenced blocks, says never to rebase, and
    `instructedCommands(code)` includes both.
11. `merges.ts` says why the bounce is offered and not made, naming the precedent paragraph;
    `forge.ts` records what was and was not observed about `mergeable`; `allowlist.ts` records
    the two entries as a gate, what defeats it, and the change to its sentence about the scan's
    ref.

## Tests

- Criteria 2 in `forge.test.ts` against recorded `gh` output.
- Criteria 3–7 in `merges.test.ts` against the real core and the faked forge, in the shape of
  018's closed-path cases, including the once-rule after a send-back and return to PR.
- Criterion 8 in `contracts.test.ts` beside 018's end-to-end case: conflict request, owner
  moves to Code, the run starts and sees the card.
- Criterion 9 in `allowlist.test.ts` for the composition and the character check, and in the
  runner's tests for the run-start comment.
- Criterion 10 in `playbook-commands` or `harness-check` tests, the way 017 tests its own.
- Existing 018 tests pass unchanged except where a faked answer gains the two new fields; no
  assertion changes.

## Out of scope

- **Moving the card to Code as the owner.** Argued against in *Goal*; the daemon offers the
  move and the owner makes it.
- **A local dry-run merge** (`git merge-tree`) instead of the forge's answer. The forge is what
  will merge, its answer is one field on a call the poll already makes, and a local check would
  need the runner to fetch, which it does not do today.
- **The runner fetching before every Code run.** It would change every existing run against a
  repository with no remote, and a fix run fetches for itself.
- **`mergeCommit` ancestry as a second ownership check** (018's carried finding). 018's check
  held through three review rounds and no case fails it; hardening it is its own small spec.
- **`BEHIND` and branch-protection "update branch" rules.** A mergeable pull request behind its
  base merges; only a conflict stops the owner.
- **Rebasing, and any force-push grant.** A merge commit is the fix.
- **Re-running the review** is 019's, and happens because the fix is a Code run.
- **Taking an offered move from `skelcrew resolve`.** `resolve` clears; `mv` moves and clears.
  A `resolve --move` is a CLI finding for MILESTONES, not this spec.
- **Reconciling the pull request's base branch with the runner's default branch** when they
  differ. Recorded as a limit.
