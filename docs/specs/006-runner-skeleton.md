# 006 — Runner skeleton

## Goal

Give the daemon its execution half without a coding agent in it yet. When a card becomes
claimable, the daemon claims it as the runner member, prepares an isolated git worktree for
it branched from the repo's default branch, records where that worktree is on the card, and
hands the card to the owner with an attention request, since it has no playbook to run. Every
step is visible on the card, and every failure mode of the plumbing — a crash mid-run, a
restart, a worktree left with uncommitted work, a card that moves on while its worktree still
exists — is exercised and made safe before an agent is anywhere near it. The prototype spike
lost work twice in exactly this plumbing; this spec is where those lessons become code.

## Current behavior

The daemon (`packages/daemon/src/main.ts`) opens the core, serves the socket, and after 009
sweeps lapsed claims every five seconds. It runs nothing. Nothing in skelcrew creates a
branch, a worktree, or touches the target repository at all; `AGENTS.md`'s runner half is a
seam with nothing behind it.

The primitives exist. 009 gives `claimCard`, `heartbeat`, `releaseCard`, and `PHASES[].claimable`
(Spec and Code), with a claim released on any phase change or archive. 010 gives
`requestAttention`, so a run can end by handing the card to a person. 002 gives `setRefs`
for the branch name and `comment` for everything else. The daemon's data directory is
`<repo root>/.skelcrew/` (003), gitignored, private, and already home to the socket and
database.

`docs/MILESTONES.md` carries three findings into this spec. From the spike: `git worktree
add -b` branched from wherever the owner's checkout happened to be parked, so the daemon
must branch from an explicit base, the repo's default branch; and the spike force-removed a
dirty worktree and destroyed an uncommitted implementation, so a dirty worktree is salvaged,
never removed. From the 001 run: worktrees inside the target repo leaked into the repo's own
tooling (`biome ci` walked `.claude/worktrees/`), so the runner's worktrees must live where no
target-repo tooling sees them.

The repo's own workflow is the reference: `/develop` enters a worktree branched from HEAD
under `.claude/worktrees/`, works there, and reports the path and branch so the owner can
`cd` into it. That is the exit ramp `AGENTS.md` requires of every piece of skelcrew work.

## Desired behavior

### The runner member

- The daemon joins the core as an agent member named `runner` at startup (`ensureMember`).
  Every action the runner takes is attributed to it. `SKELCREW_RUNNER=0` in the daemon's
  environment disables the runner entirely; the daemon then behaves as before this spec.

### A run, with no playbook

- A card is **ready** when its phase is claimable, it is not archived, it has no live claim,
  and it has no open attention request. The runner notices ready cards at startup and
  whenever the activity stream shows a card becoming ready (a move into a claimable phase,
  a release, a run interrupted, an attention resolved).
- For a ready card the runner, in order: claims it (TTL 120 s, heartbeat every 30 s while the
  run lasts); determines the repo's default branch; creates the branch
  `skelcrew/<id>-<slug>` from that branch's local head, where `<slug>` is the title
  lower-cased, non-alphanumerics collapsed to `-`, at most 40 characters; adds a worktree
  for it at `<data dir>/worktrees/<id>`; sets the card's `branch` ref; comments
  `worktree ready at <path> on <branch> (from <base>)`; raises an attention request to the
  owner with note `no playbook for <phase> yet; work in <path>` and no suggested moves;
  releases the claim with reason `no playbook`. The whole thing is a few hundred
  milliseconds and every step is on the card in that order.
- If the branch or worktree already exists for that card (a previous run), the runner reuses
  them: no new branch, no new worktree, the same comment and attention request.
- One run at a time. If several cards are ready, they are taken in id order, each to
  completion before the next.
- A failure at any step (git not found, the base branch missing, the worktree path occupied
  by something that is not that card's worktree) ends the run with a comment naming the
  step and the error, an attention request to the owner carrying the same text, and a
  release with reason `failed`. Nothing is retried automatically; the card is waiting on the
  owner and therefore not ready again until they act.

### Teardown

- When a card with a runner worktree moves to a phase that is not claimable, or is archived,
  the runner tears down: if the worktree is clean (no uncommitted changes, no untracked
  files), it removes the worktree and comments `worktree removed`; the branch is kept. If
  it is dirty, it leaves it in place and comments `worktree kept at <path>: uncommitted
  changes` listing the changed paths, at most twenty. A dirty worktree is never removed by
  skelcrew.
- When a card with a runner worktree moves between claimable phases (Spec to Code), the
  worktree stays; the next run reuses it.

### Startup reconciliation

- At startup, and before taking any new card, the runner lists `<data dir>/worktrees/`. For
  each entry: if its card no longer exists or is archived or in a non-claimable phase, it is
  torn down as above; if the card is claimable and the entry is not a valid git worktree, it
  comments the problem and leaves the entry alone; otherwise it is left for the next run.
  A claim held by `runner` from a previous process is released with reason `daemon
  restarted` before reconciliation, so the card becomes ready again.

### On the card

- `skelcrew show` prints the branch ref as before. The runner's comments and the attention
  request are ordinary events. `skelcrew queue` shows `no playbook for spec yet; work in
  <path>`, which is the exit ramp: the owner can `cd` there and work by hand, then `mv` the
  card on.

## Implementation approach

### Where it lives

- `packages/daemon/src/runner/` — `runner.ts` (`startRunner({ core, dataDir, repoRoot,
  git, member }) → { stop() }`: the ready-card watch, the run loop, teardown, and
  reconciliation, driving the core directly through the same interface the socket uses);
  `git.ts` (a thin `git` wrapper over `Bun.spawn`: default branch, branch exists, worktree
  add / list / remove, status porcelain; every call takes the repo root and returns parsed
  results, and every failure is an error naming the command); `slug.ts`.
- `packages/daemon/src/main.ts` — starts the runner after the server unless
  `SKELCREW_RUNNER=0`; stops it on shutdown before closing the core.
- `packages/shared/src/paths.ts` — `worktreesDir(dataDir)` next to `dataPaths`.
- Tests colocated. Runner tests use a real temporary git repository (created with `git init`,
  one commit, a `main` branch) and `openCore(":memory:")`, and assert on the card's
  activity, refs, attention, and on the filesystem under a temp data dir. The daemon
  process test extends 003's pattern with `SKELCREW_RUNNER` set both ways.

### Decisions resolved from repository context

- **The runner is a module in the daemon, not a process.** `AGENTS.md`: one binary, two
  halves behind an internal seam. The seam is the `Core` interface; the runner is a client
  of it like the socket is, so a remote runner later would be a client over 003 instead.
  Nothing in the runner reaches into the database.
- **The runner is a member named `runner`.** Everything observable requires an actor;
  claims, comments, refs, and attention requests all carry it. One name, since one daemon
  serves one repo. The 008 finding about cross-review by a different member is about a
  second runner, which is a second daemon with a different name; out of scope here.
- **Worktrees live under `<repo root>/.skelcrew/worktrees/`.** The 001 finding says
  "outside the target repo's tree"; what it actually requires is that no target-repo
  tooling sees them. `.skelcrew/` is a gitignored dot-directory: git ignores it, Biome
  with `useIgnoreFile` ignores it, `bun test` skips dot-directories, and the repo's own
  `tsconfig` includes only `src/`. Putting them under the home directory would break "the
  repo is the only container", need a registry, and make the exit ramp a path the owner has
  to look up. Recorded so the finding is read as satisfied by intent, not ignored.
- **Branch from the default branch's local head, no fetch.** The spike's bug was branching
  from the owner's parked checkout. The fix is an explicit base: `refs/remotes/origin/HEAD`
  when it exists, else a local `main`, else `master`, resolved once per run and recorded in
  the comment. Fetching is a network operation with its own failure modes and belongs with
  the conflict handling in 008.
- **A run without a playbook ends in an attention request.** Without this, the skeleton
  would claim, release, and immediately re-claim the same card forever. Handing the card to
  the owner makes it "waiting", which by definition is not "ready", and it doubles as the
  exit ramp: the owner gets a branch and a worktree and can work by hand. 007 replaces the
  attention request with the playbook run and keeps everything before it.
- **Dirty means anything `git status --porcelain` reports.** Untracked files count: an
  agent's half-written file is exactly what the spike lost. The branch is never deleted by
  the runner; branches are cheap and the owner may want them.
- **Teardown on leaving the claimable phases, not on leaving a phase.** Spec to Code keeps
  the worktree because the same branch continues; Code to PR removes it because the work is
  on the branch and the PR, and a clean worktree holds nothing else. Archive removes it for
  the same reason.
- **Reconciliation releases the previous process's claims.** A claim by `runner` that
  survived a restart belongs to a run that no longer exists. Releasing it with a reason,
  rather than resuming, keeps one code path for "the runner is starting" and lets the
  card be picked up again through the normal ready check.
- **One run at a time.** Single-player; a skeleton run is instant, and 007's real runs are
  where concurrency would matter. A second daemon is the concurrency model `AGENTS.md`
  plans for, coordinated by claims alone.
- **Git is a subprocess, injected.** The `git` wrapper is passed to `startRunner`, so runner
  tests can use the real binary against a temp repo and later specs can fake it. Real git
  in tests is fine: it is not a coding agent and not an external service.
- **`SKELCREW_RUNNER=0` rather than a config file.** The only configuration the daemon has
  is environment variables; a switch is needed so 003's process tests and an owner who
  wants a passive board can run the daemon without a runner.

## Acceptance criteria

1. `bun run check` exits 0 with new tests under `packages/daemon/src/runner/` and the daemon
   process test extended.
2. With a temp repo (one commit on `main`), a core, and the runner started, moving a card
   titled `Add login page` into `spec` as the owner results, within two seconds, in: a claim
   by `runner` that is then released with reason `no playbook`; the branch
   `skelcrew/1-add-login-page` existing in the repo at `main`'s commit; a git worktree for it
   at `<data dir>/worktrees/1`; the card's `branch` ref set to that name; a comment
   containing the path, the branch, and `from main`; an open attention request to the owner
   whose note contains `no playbook for spec` and the path. The events on the card appear in
   that order.
3. Moving the card from `spec` to `code` leaves the worktree and branch in place and results
   in a second run with the same branch, no new worktree, and a new attention request.
4. With `refs/remotes/origin/HEAD` pointing at a branch named `trunk`, the run branches
   from `trunk`'s head and the comment says `from trunk`; with no remote and no `main` but a
   `master`, from `master`; with none of the three, the run fails with a comment naming the
   missing base, an attention request with the same text, and a release with reason
   `failed`.
5. With a file added but not committed in the worktree, moving the card to `pr` leaves the
   worktree in place and records a comment containing `kept`, the path, and the file's
   name. With the worktree clean, the same move removes it and records `worktree removed`;
   the branch still exists.
6. Archiving a card with a clean worktree removes the worktree; with a dirty one, keeps it
   and comments as above.
7. Two cards moved into `spec` in one transaction each get a run, in id order, and both
   end waiting on the owner; the runner never holds two claims at once (asserted by a
   subscriber watching the events).
8. A card with an open attention request is not run: raising one on a card in `spec`
   before starting the runner, then starting it, produces no claim. Resolving the request
   makes the card ready and it runs.
9. Startup reconciliation: with a worktree directory left under `<data dir>/worktrees/` for
   a card that is archived, starting the runner removes it if clean and keeps it with a
   comment if dirty; with a claim by `runner` left on a card from a previous core session,
   starting the runner releases it with reason `daemon restarted` and then runs the card.
10. With `git` unavailable (an injected wrapper that fails, or `PATH` without git in the
    process test), a run fails as in criterion 4 and the daemon keeps serving.
11. Process: `bun packages/daemon/src/main.ts` with `SKELCREW_DIR` set and a temp repo as
    cwd runs the runner: a card moved into `spec` over the socket ends waiting on the owner
    with a worktree under `<dir>/worktrees/1`; with `SKELCREW_RUNNER=0` nothing happens to
    the card. 003's process tests pass unchanged with `SKELCREW_RUNNER=0` in their
    environment.
12. `skelcrew queue` for the owner shows the runner's request with the worktree path;
    `skelcrew show 1` shows the branch and the runner's comments attributed to `runner`.
13. No test writes under the repository; every temp repo and data dir is under the OS temp
    dir and removed after.
14. `docs/MILESTONES.md`'s status section records the worktree location, the branch naming,
    the base-branch rule, and the no-playbook handoff, as facts 007 builds on.

## Tests

- Runner, against a real temp git repo: the full run with event order, reuse across Spec to
  Code, base-branch resolution in all four cases, dirty and clean teardown on move and on
  archive, id-order with a single claim at a time, the not-ready rule for open attention,
  reconciliation of orphaned worktrees and stale claims, and git failure.
- Slug: lower-casing, collapsing, truncation, an all-symbol title.
- Process: the runner on and off, and 003's tests under `SKELCREW_RUNNER=0`.
- CLI: `queue` and `show` rendering of a runner-produced card, through the existing
  commands.

Existing suites remain and must pass. Red for this spec is the runner test failing on a
missing `startRunner`.

## Out of scope

- Spawning any coding agent, playbooks, streaming agent output, `canUseTool`, or verifying a
  develop finish against commits: 007.
- Fetching from a remote, rebasing, dry-run merges, or conflict handling: 008.
- More than one run at a time, priorities, or a second runner.
- Deleting branches, ever.
- A CLI command to remove or list worktrees; the paths are on the card.
- Configuration beyond `SKELCREW_RUNNER`; the runner member's name is fixed.
- Running phases other than Spec and Code.
