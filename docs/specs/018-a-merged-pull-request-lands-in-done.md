# 018 — A merged pull request lands the card in Done

*Milestone 008a.*

## Goal

The loop the product exists for ends when the owner merges: Idea → Spec → Code → PR → Done. The
first four arcs turn today — a Spec run's finish carries the move into Code, a Code run's finish
carries the move into PR, and the owner executes each. The last arc does not: after the owner
merges on the forge, the card sits in PR until someone types `skelcrew mv <id> done`. This spec
closes it. The daemon notices that a PR-phase card's pull request has merged, and the card lands
in Done — the merge was the owner's gesture, and Done is its record.

This grants the daemon two things it does not have today, and both are named here rather than
discovered: it spawns `gh` (as it already spawns `git`), read-only, only while a card is in PR;
and it makes one move **as the owner** — PR → Done, when the owner's own merge has already
happened on the forge. That second one is a precedent: the daemon writing a member's action
without that member typing it. It is confined to this one transition, it is preceded on the card
by a comment from the runner saying why, and it is the honest rendering of what happened — "done
is a human's call, the way merging is" (`CLAUDE.md`), and the merge *was* the call. Nothing here
is a boundary; what defeats it is the owner having merged, which is the point.

## Current behavior

- The daemon ticks once every five seconds for lapsed claims: `sweepTick`
  (`packages/daemon/src/sweep.ts`), wired in `packages/daemon/src/main.ts:61-64` with
  `CLAIM_SWEEP_INTERVAL_MS`. Nothing else in the daemon runs on a timer.
- The runner scans claimable phases only (`isReady`, `packages/daemon/src/runner/runner.ts:107`);
  `pr` is `claimable: false, exit: "owner"` (`packages/shared/src/phases.ts`). A card in PR is
  invisible to the runner.
- The daemon runs `git` through `Bun.spawn` (`packages/daemon/src/runner/git.ts:111-125`) and
  never runs `gh`. Git alone cannot reliably tell a squash-merged branch from an unmerged one —
  the merged commit is a different sha — so the forge's own answer is needed.
- Since 016 every phase's exit is the owner's: `moveCard` refuses a non-human actor leaving PR
  (`packages/daemon/src/core/core.ts`, the `from.exit === "owner"` check). The `runner` member
  cannot move a card into Done. Only a human-kind member can.
- A Code run records the pull request on the card as `refs.prUrl` (014, criterion 4), validated
  as an absolute https URL (`core.ts`, `isHttpsUrl`) and free of control characters (015). The
  `crew` member sets it (`skelcrew refs <id> --pr`), and 016 records that `crew` can set refs on
  any card.
- `card_moved` carries `{ from, to }` (`packages/shared/src/types.ts:98`) and no reason.
- Send-back works today: a comment plus `skelcrew mv <id> code` by the owner re-dispatches with
  history intact (014). Done → anything is the owner's and unchanged.

## Desired behavior

**A card in PR whose pull request has merged moves to Done, and the card says why.** Within one
poll interval of the merge, the card's activity shows, in order: a comment by `runner` — `pull
request <url> merged at <time>` — and then a `card_moved` PR → Done whose actor is the owner.
`skelcrew show` reads as: the runner reported the merge, the owner's decision was recorded. No
attention request is raised; nothing waits on the owner.

**The pull request has to be the card's own.** The daemon believes a merge only when the forge
says the pull request at the card's `prUrl` is in this repository, its head branch is **the
branch the runner recorded for this card**, and its state is merged. A `prUrl` pointing
anywhere else — another repository, another branch, a URL `crew` chose — is not a merge of this
card's work, and the card stays in PR with a comment saying what did not match. This is the
composition 016's red-team predicted: `crew` can set refs on any card, and a `prUrl` naming an
already-merged pull request elsewhere would otherwise walk a card into Done past the owner's
merge gate.

The branch compared is not `refs.branch` as it sits on the card, because `crew` can write that
too — `setRefs` has no actor restriction — and review demonstrated, through the real CLI, that
one `skelcrew --as crew refs <id> --branch <other> --pr <other's merged url>` walked a card into
Done with the spec as approved. The runner records the card's branch itself at run start
(`runner.ts`, `setRefs({ branch })` as `runner`), and the owner may record one by hand. The
check reads the branch from the last `refs_set` on the card whose actor is the `runner` member
**or a human member** — the same activity read the once-rule already performs — and compares
the forge's head branch to that. A human-recorded branch binds because the human who wrote it
can `skelcrew mv <id> done` anyway, so accepting it costs nothing and keeps the hand-driven
card (branch and pull request made in a terminal, `skelcrew refs --pr`, moved to PR) able to
land. What then remains is a pull request from this card's own branch merged under a different
number, which is the card's own work and is accepted.

What this binds, stated without the overclaim the spec made on its first correction: a wrong,
stale or copied `prUrl`, and an agent that keeps the identity the runner gave it. It does
**not** bind a caller that asserts `runner` — the spec as corrected said `crew` "cannot produce
a `refs_set` as `runner`", and review walked it live: `skelcrew --as runner refs <id> --branch
<other>` joins the `runner` member, because names are not credentials (`allowlist.ts`, since
016) and `hello` reserves none. That caller is owner-equivalent by choosing no `--as` at all,
and 016 records the limit. If a real bind is ever wanted, "`hello` refuses the reserved member
names" is its own finding, carried to MILESTONES, and it interacts with the deliberate
`--as crew` join `allowlist.ts` documents.

**The tick acts on the card as it is now, not as it was.** A tick reads the card, then awaits
the forge — one `gh` round-trip per card, and for the *n*-th card in the list *n* of them. The
owner can move a card back to Code inside that window, and a run can start on it. So before the
comment and the move, the tick re-reads the card and proceeds only if it is still in PR, still
unarchived, and still carries the `prUrl` the forge was asked about; otherwise it does nothing
and says nothing. Review demonstrated the alternative: a card sent back to Code mid-await was
moved **Code → Done** as the owner, releasing the fresh claim mid-run — the owner's own
decision undone, in the owner's name.

**The daemon polls only while something is in PR.** No unarchived card in PR with a `prUrl`, no
`gh` call. A card in PR without a `prUrl` — the owner moved it there by hand — is left alone.
The interval is slow (a minute by default) and configurable the way the run limit is.

**A pull request closed without merging is the owner's to decide.** The card gets a comment and
an attention request to the owner — `pull request <url> closed without merging` — with no move
attached. Sending it back to Code, or archiving, is the owner's call, and the queue shows it.

**`gh` that cannot answer is said once and then waited out.** The daemon warns once per process
per cause (not per tick) — the repository's own URL, or a pull request — the cards stay in PR,
and `skelcrew mv <id> done` by hand still works. A `gh` that is absent or logged out surfaces on
the repository line, since that is every tick's first call, and the warning says which it could
not answer rather than guessing why. **A `gh` that hangs is bounded**: each spawn has a timeout
after which the child is killed and the call counts as "cannot answer", so a stalled network
collapses into the warned-once path instead of holding the poll's one-tick-at-a-time guard for
the life of the process. Review found the unbounded version: one `gh` call, then eight silent
ticks, no warning, no recovery short of a restart — the last arc of the product stopped turning
and nothing said so. A tick skipped because one is still in flight is said too, once.
The daemon holds no credential for the forge: `gh` uses the owner's own login, the way the agent
already does.

**Nothing else changes.** Send-back from PR is unchanged. Done → anything is unchanged. The
runner's phases, contracts and endings are unchanged. Branch deletion, worktree cleanup after a
merge, and anything on the forge beyond reading the pull request's state are out of scope.

## Implementation approach

### A forge, beside git

A `Forge` interface in `packages/daemon/src/runner/forge.ts` with two methods:
`pullRequest(repoRoot, url)` returning `{ url, state: "open" | "merged" | "closed", mergedAt?,
headRefName, baseRepo }` or `undefined` when `gh` cannot answer (absent, not logged in, the URL
not a pull request); and `repoUrl(repoRoot)` returning the repository's own URL, or `undefined`.
Both implemented with `Bun.spawn(["gh", ...])` and an argv array, following `git.ts`'s shape
exactly — the same error wrapping, the same "spawn failed" distinction. Tests fake it; no test
runs `gh`.

Why two and not the one the spec as approved named: `gh pr view <url>` takes the URL as its
authority and **ignores the directory it runs in** — verified against the installed `gh`, which
answered about another repository's pull request from inside this one — and the installed `gh`
(2.86.0) has **no base-repository field** at all (`baseRepository` is "Unknown JSON field";
`headRepository.nameWithOwner` comes back empty). So "is this pull request in this repository"
cannot be read off the pull request. It is read by comparing the canonical `url` `gh` returns for
the pull request against the repository's own URL from `gh repo view --json url`, both `gh`'s own
output, asked once per tick and only when a candidate card exists. `baseRepo` is that URL —
`https://host/owner/repo` — so two hosts with the same slug cannot match.

Why `gh` and not git: a squash merge leaves no ancestry to check, and a deleted remote branch
is a setting, not a signal. Why a URL and not a number: `prUrl` is what the card carries, and
`gh pr view` accepts a URL.

### A merge tick, beside the sweep

`packages/daemon/src/merges.ts`, in `sweep.ts`'s shape but with one difference the spec as
approved missed: `mergePoll({ core, forge, repoRoot, runnerId, warn })` returns a `tick()` the
daemon calls on an interval — `MERGE_POLL_INTERVAL_MS`, sixty seconds, overridable by
`SKELCREW_MERGE_POLL_SECONDS` the way `SKELCREW_RUN_MINUTES` overrides the run limit. A closure
rather than the free `mergeTick(...)` first written, because "warn once per process" is state
that lives *between* ticks, and a free function has nowhere to keep it; the closure is also where
a test drives many ticks and counts the warnings. The owner's id is resolved inside the tick, the
way `runner.ts` resolves it. The poll runs where the runner runs — off under `SKELCREW_RUNNER=0`
and without a `repoRoot` — because it spawns a subprocess against the repository. Each tick: list unarchived cards in `pr` with a `prUrl`; if none, return without
spawning; otherwise ask the forge about each, and:

- merged, and the pull request is this repository's and its head is the branch the runner
  recorded for the card (the last `refs_set` by the `runner` member naming `branch` — never
  `refs.branch` as it sits on the card, which `crew` can rewrite):
  `core.comment(id, "pull request <url> merged at <mergedAt>", runnerId)` then
  `core.moveCard(id, "done", ownerId)`. The comment first, so the move's reason precedes it on
  the feed.
- merged, but the repository or head branch does not match: one comment naming the mismatch,
  once (a tick must not repeat it — see below), and the card stays.
- closed without merging: comment plus `requestAttention` to the owner with no moves, once.
- open, or the forge cannot answer: nothing on the card. `gh` unavailable warns once per
  process via the same `warn` the sweep uses.

"Once" is derived from the card, not remembered in the daemon: before posting a mismatch or a
closed-without-merge record, the tick reads the card's activity for an identical comment by the
runner since the card entered PR, and posts only if there is none. The daemon holds no state
between ticks — the card does, which is 014's rule about endings applied to a tick.

### The move as the owner

`core.moveCard(id, "done", ownerId)` — the owner's id, resolved the way `endRun` resolves it.
No change to the core, no new rule, no exemption for the runner: the existing owner-only exit
is exactly what makes this the one way the move can happen. The precedent is confined by
construction to this call site and this transition; `merges.ts`'s doc says so, and says why the
attribution is honest (the comment above it names the merge as the cause). If a later spec
needs the daemon to act as the owner elsewhere, this is the sentence it argues against.

The exception this makes to *everything observable*: the owner's name on a move the owner did
not type. Resolved by the comment that precedes it — a reader of the feed sees `runner:
pull request … merged`, then `<owner>: moved PR → Done`, and the second follows from the first.
Recorded as a decision rather than left for review.

### Resolved from context

- **Polling rather than a member action** was the owner's decision (see the run record's
  question). Polling only while a PR-phase card exists is what keeps *cards drive the runner*
  true: entering PR is the card asking to be watched, and leaving it ends the watch.
- **The ownership check** (repository, and the head branch the runner recorded) is not optional
  and not a later hardening: without it, `crew`'s ability to set `prUrl` on any card is a way past the merge
  gate. It is the composition 016's red-team named and this spec would otherwise reintroduce.
- **No attention request on a successful merge.** The point is one gesture; a request would be
  the second. The owner's queue stays for things that need the owner.
- **Closed-without-merge asks rather than moves.** Sending back to Code is a judgement (was the
  work wrong, or the PR superseded?), and *feedback is a comment plus a move back a phase* is
  the owner's mechanism, not the daemon's.

### Red-team

This spec grants the daemon a command and a member's action, so the check applies.

1. **Gate or boundary:** neither is against the agent. What the spec guards is the owner's merge
   gate against a card reaching Done without a merge of its own work; what defeats that is a
   merge, which is the gate working.
2. **What `gh pr view` reaches.** Read-only: it returns JSON about a pull request. Its `--json`
   fields are enumerated in the call; no `--web`, no `--comments`, nothing that runs a program.
   The daemon passes the card's `prUrl`, an https URL validated at write time and free of control
   characters (015), as one argument; `gh` treats it as a URL or rejects it. No shell is involved
   (`Bun.spawn` with an argv array, as `git.ts`).
3. **Composed with what `crew` can do.** `crew` can set any card's `prUrl` (016, recorded). Without
   the ownership check, a `prUrl` naming a merged pull request in any repository moves a card to
   Done as the owner. With it, the pull request must be this repository's and its head must be
   the branch **the runner recorded** — not `refs.branch` as `crew` may have rewritten it, since
   `setRefs` has no actor restriction and review walked a card into Done with two `crew` writes
   under the spec as approved. `crew` cannot merge (`gh pr merge` asks — 013) and cannot move
   the card (016). What remains: `crew` could set `prUrl` to a *different* pull request from
   this card's own branch, if one existed and had merged — which means the card's own work
   merged, under another number. That is the same outcome, recorded with a different URL, and
   it is left as it is. And what this check is *for*, stated without overclaiming: it binds a
   wrong, stale or copied `prUrl`, and it binds an agent that keeps the identity it was given.
   It does not bind a caller asserting another identity over the socket — `allowlist.ts` records
   that `runner` and `crew` are names, not credentials, so `skelcrew --as runner` *joins* the
   runner member and can write the `refs_set` this check reads; and no `--as` at all is the
   owner, who can `skelcrew mv <id> done` directly. That is 016's recorded limit, and it is a
   gate, not a boundary, here as there. (The spec's first correction said `--as runner` "is the
   owner" and that `crew` "cannot write a `refs_set` as `runner`"; both were wrong, and review
   demonstrated the second live.)
4. **The enforcer is the core's `moveCard`**, run directly by the tests, plus the daemon's own
   ownership check, which the tests drive with a faked forge returning every mismatch shape.
   `gh`'s real output shape is verified once by the implementer against the installed `gh`
   (`gh pr view <a real URL> --json state,mergedAt,headRefName,url` and `gh repo view --json
   url`) and the field names recorded in `forge.ts`; that is the one semantics this spec takes
   from a tool, and it is pinned by the `gh` version the implementer ran. The spec as approved
   named `baseRepository` here; the installed `gh` has no such field, which is what forced the
   second method above. `state` is upper-case and `mergedAt` is `null` unless merged.
5. **What parses the string.** The URL is an argv element to `gh`, never composed into a shell
   line; the comment text the daemon posts is built from the URL and a timestamp and goes through
   `postingCore` (015), so it cannot be refused.

**Open, and written down:** the daemon acting as the owner for this one move; `gh`'s JSON field
names being a tool's contract pinned by version; and a pull request from the same branch merged
under a different number reading as a merge of the card's work.

## Acceptance criteria

1. `bun run check` passes. No test spawns `gh`, a real coding agent, or calls a model; the
   forge is faked.
2. A card in PR with a `prUrl` whose faked forge answer is merged, in this repository, from the
   card's branch, is in Done after one tick, with a comment by `runner` naming the URL and the
   merge time immediately before a `card_moved` PR → Done whose actor is the owner. No attention
   request is raised.
3. The same card whose forge answer is merged but from a different head branch, or from a
   different repository, stays in PR with one comment naming the mismatch; a second tick adds
   nothing.
4. The same card whose forge answer is closed and not merged stays in PR with a comment and an
   attention request to the owner carrying no moves; a second tick adds nothing.
5. A card in PR with no `prUrl`, a card in PR that is archived, and a card in any other phase
   are not asked about: a tick with only such cards makes no forge call.
6. A tick where the forge cannot answer (`gh` absent or not logged in) changes no card, warns
   exactly once across many ticks in one process, and a later tick where it can answer proceeds
   normally.
7. The poll interval defaults to sixty seconds and `SKELCREW_MERGE_POLL_SECONDS` overrides it;
   the daemon does not tick while no PR-phase card with a `prUrl` exists (observable: a faked
   forge records zero calls).
8. After a merge lands the card in Done, `skelcrew mv <id> code` by the owner still works and
   the card re-dispatches as 014 describes; the daemon does not move it back.
9. `merges.ts` documents that its `moveCard` as the owner is the one place the daemon acts as
   the owner, why the attribution is honest, and that this is a precedent a later spec must argue
   against; `forge.ts` records the `gh` version its field names were verified against.
10. Existing tests pass unchanged.

## Tests

Against the core and a faked forge, asserting what a member sees on the card:

- Criteria 2–4 as their own cases, each also asserting the *order* of the comment and the move
  on the activity feed, and the once-only behaviour over two ticks.
- Criterion 5 as a table over the card shapes that must not be polled.
- Criterion 6 with a forge that answers `undefined` for N ticks and then answers.
- Criterion 7 through the daemon's wiring: interval from the environment, and no call while the
  board holds no PR-phase card with a `prUrl`.
- Criterion 8 end to end against the runner with the scripted driver, as 014's send-back tests
  do.
- The ownership check as a table: matching / other branch / other repository / merged elsewhere
  from the same branch (the last documented as passing).

## Out of scope

- **008b** — the in-run review loop and the runner-enforced cycle budget, and the finding
  carried there that a failed ending must park the card rather than re-enter the queue.
- **008c** — dry-run merging when the default branch moves, rebase briefs, conflict bouncing.
- **Deleting the branch or the worktree after a merge**, on the forge or locally. 006's teardown
  runs at the end of a run; a merged branch left in place costs nothing.
- **Anything on the forge beyond reading a pull request's state.** The daemon never merges,
  closes, comments on, or edits a pull request.
- **A merge-detection path that does not need `gh`.** A forge abstraction is introduced so one
  could be added; none is.
- **The daemon acting as the owner anywhere else.** This spec confines it to PR → Done on a
  verified merge and says so.
