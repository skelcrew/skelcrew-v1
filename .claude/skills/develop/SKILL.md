---
name: develop
description: Implement an approved specification end to end — isolated worktree, implementer subagent, independent review loop, independent verification, then a GitHub pull request. Stops at the PR; never merges. Takes a spec number such as 004, or a full path such as docs/specs/004-card-due-reminders.md.
argument-hint: <NNN> | docs/specs/<NNN>-<spec-name>.md
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Write, Edit, EnterWorktree, Agent, Bash(git add *), Bash(git commit *), Bash(git push -u origin HEAD), Bash(git push), Bash(git worktree add *), Bash(git worktree remove *), Bash(gh pr create *), Bash(gh pr view *), Bash(gh repo view *), Bash(bun install), Bash(bun run check), Bash(bun run lint), Bash(bun run typecheck), Bash(bun run test), Bash(bun run fix), Bash(bun test *)
---

# Develop an approved specification

Specification: **$ARGUMENTS**

You are the orchestrator. You do not write the implementation yourself — you delegate to
subagents, hold the quality bar between stages, and stop at a pull request awaiting human
review. The user's time is spent on the spec and the PR, not on supervising you.

Work through the stages in order. Do not skip ahead, and do not proceed past a gate that has
not been met.

---

## Stage 1 — Prepare

1. Read `CLAUDE.md` in full, if it exists. It documents the repository's check commands and
   constraints.
2. **Resolve the specification.** The argument may be given in any of these forms; all refer
   to the same file, and you resolve it by listing `docs/specs/` rather than guessing:

   | Given | Resolves to |
   | --- | --- |
   | `docs/specs/004-card-due-reminders.md` | itself |
   | `004-card-due-reminders` | the file with that stem |
   | `004`, `4`, `spec 4` | the single spec whose number is `004` |
   | `card-due-reminders` | the single spec whose name matches |

   Zero-pad a bare number to three digits before matching. If nothing matches, or more than
   one does, stop and list `docs/specs/` so the user can pick — never guess between candidates.

   Then read the **complete** specification. If the file does not exist, stop and ask. If it is
   missing required sections (see `docs/specs/README.md`), say so and stop — do not fill them
   in yourself.
3. Run `git status` and record every file already modified. That is the user's work; it must
   survive this run untouched.
4. Determine the base branch — the current branch, unless `git status` shows you are somewhere
   unexpected. Record its name and HEAD sha.
5. **Preconditions.** Check these now and stop with a plain explanation if one fails:
   - The repository has at least one commit (`git rev-parse HEAD`). A worktree cannot be
     created from an empty repository.
   - A remote named `origin` exists (`git remote`). Without it, Stage 5 cannot push or open a
     PR. If it is missing, you may still run Stages 2–4, but say up front that the run will
     end at a local branch rather than a PR.
6. **Isolate.** Call `EnterWorktree` with a name derived from the spec filename
   (`card-due-reminders.md` → `card-due-reminders`). This project's `.claude/settings.json`
   sets `worktree.baseRef` to `head`, so the worktree branches from your current HEAD and
   leaves uncommitted work in the main checkout alone. Subagents inherit this working
   directory, so the implementer, reviewer, and verifier all operate on the same isolated tree.

   If `EnterWorktree` is unavailable or fails, fall back to
   `git worktree add .claude/worktrees/<name> -b <name>` and then `EnterWorktree` with that
   `path`. If neither works, stop and explain — do not proceed in the main checkout.

Confirm the worktree path and branch before continuing.

---

## Stage 2 — Implement

Delegate to the **implementer** subagent. Give it:

- the absolute spec path, and an instruction to read it in full itself
- the base branch name and sha, for diffing
- the list of files that were already modified before the run
- nothing else — do not summarize the spec for it, and do not pre-decide its design

When it reports back, read its report properly. Then check its claims cheaply yourself:
run `git diff <base>...HEAD --stat` and confirm the diff is real and roughly matches what it
described.

**Gate:** do not proceed while required implementation checks are failing. If the implementer
reports failing checks, send them back with the failures. If it reports that a check does not
exist in this repository, that is acceptable — record it and move on.

---

## Stage 3 — Review

Run the **reviewer** subagent in a fresh context. It must never be the same agent instance that
wrote the code. Give it the spec path and the base branch, and let it obtain the diff itself.

Read the verdict on the final line.

- **`APPROVED`** → continue to Stage 4. Carry any Minor findings forward; they go in the PR.
- **`CHANGES REQUESTED`** → send the concrete Critical and Important findings back to the
  **implementer**, verbatim, then run a **fresh** reviewer again.

**Maximum 3 review cycles.** If Critical or Important findings remain after the third, stop.
Return control to the user with: what remains unresolved, what was attempted each cycle, and
where the branch and worktree are. Do not start a fourth cycle, and do not proceed to Stage 4.

Record each cycle's outcome in `docs/plans/<spec-name>.md`.

---

## Stage 4 — Verify

Run the **verifier** subagent. Give it the spec path and the base branch.

- **`VERIFIED`** → continue to Stage 5.
- **`VERIFICATION FAILED`** → send the concrete failures to the implementer, then re-run
  review and verification as needed. This is bounded by the same budget: **at most 3 total
  fix rounds across Stages 3 and 4 combined.** If verification still fails, stop and return
  control to the user with the failing checks and criteria.

Do not ship on anything other than `VERIFIED`. If the verifier reports a check as
"not configured", that is not a failure — but say so explicitly when you report to the user.

---

## Stage 5 — Ship

Only after: implementation checks pass, review is `APPROVED`, and verification is `VERIFIED`.

1. Run `git status`.
2. Read the **complete** final diff, `git diff <base>...HEAD`. Not the stat — the diff.
3. Confirm only intended files are included. If anything unrelated crept in, remove it from
   the commit rather than explaining it away in the PR description.
4. Stage and commit. One commit if the change is coherent; a few if it genuinely separates.
   Write a real message: what changed and why, referencing the spec path.
5. Push the feature branch to `origin`.
6. Create the pull request with `gh pr create`, base = the base branch from Stage 1.

The PR body has exactly these sections:

```markdown
## Summary
What changed and why.

## Specification
`docs/specs/<name>.md`

## Implementation
The approach, in a short paragraph. Say *why* it works this way and what trade-offs it
makes — not merely what was added.

## Testing
The commands actually run, with their results. Note any check not configured in this repo.

## Agent review
Review outcome, verification outcome, number of review cycles, and any unresolved
Minor findings carried forward.
```

Report to the user:

- the pull request URL
- the worktree path, and that **the feature branch is checked out there**. Say so explicitly:
  `gh pr checkout <n>` will fail with *"already used by worktree at ..."* until the worktree is
  released, because git refuses to check out one branch in two places. To review the change,
  `cd` into the worktree; to move it into the main checkout instead, run
  `git worktree remove <path>` first. That command refuses if there is uncommitted work, so it
  cannot discard anything silently.
- how to run the checks from the worktree, since the branch is not on the base branch yet and
  the main checkout will not have the new tests.

---

## Hard boundaries

These are not defaults to be weighed against progress. They are absolute.

- **Never merge the pull request.** The user is the only merge authority.
- **Never force push.** Not with `--force`, not with `--force-with-lease`.
- **Never bypass a failing test or check**, and never use `--no-verify`.
- **Never modify the specification.** If it is wrong, stop and say so. Changing it to match
  the code destroys the only record of what was intended.
- **Never expand scope.** Anything the spec does not require, and anything in its *Out of
  scope*, stays out — no matter how small or how tempting.
- **Never touch the user's uncommitted work** in the main checkout.
- **Never edit test fixtures or eval data** to make something pass.
- **Never claim a stage happened when it did not.** If you skipped review, say you skipped
  review. A truthful report of a partial run is a good outcome; a fabricated clean one is the
  worst thing you can produce.

If you cannot finish, stop and hand back control with the current state, the branch name, and
what remains. Stopping is always available and always acceptable.
