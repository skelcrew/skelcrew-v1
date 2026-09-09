# 006 — Runner skeleton: run record

## Plan

1. Red: `packages/daemon/src/runner/runner.test.ts` imports `startRunner` and drives a card
   into `spec` against a real temp git repo; first failure is the missing module.
   `slug.test.ts` and `git.test.ts` alongside.
2. Green, shared: `worktreesDir(dataDir)` in `paths.ts`, exported from `index.ts`.
3. Green, runner: `slug.ts`; `git.ts` (`createGit({ env? })`, a `Git` interface over
   `Bun.spawn` — default branch, ref lookup, branch create, worktree add / list / remove /
   prune, status porcelain — every failure a `GitError` naming the command); `runner.ts`
   (`startRunner({ core, dataDir, repoRoot, git, member, warn? }) → { stop() }`): one
   serial job queue fed by a core subscription — scans for ready cards, teardowns on a move
   out of the claimable phases or an archive, and the startup reconciliation as the first
   job.
4. Green, daemon: `main.ts` joins `runner` and starts the runner after the server unless
   `SKELCREW_RUNNER=0`; shutdown awaits `stop()` before closing the core. `process.test.ts`
   sets `SKELCREW_RUNNER=0` on the existing tests and adds the runner-on / runner-off
   cases against a temp repo.
5. Green, CLI: one test in `cli.test.ts` running the real runner in-process and checking
   `queue` and `show` output.
6. `docs/MILESTONES.md`: one status bullet with the facts 007 builds on.
7. `bun run check`, then walk the criteria.

Files: `packages/shared/src/{paths,index}.ts`; `packages/daemon/src/runner/{runner,git,slug}.ts`
and their tests; `packages/daemon/src/main.ts`; `packages/daemon/src/server/process.test.ts`;
`packages/cli/src/cli.test.ts`; `docs/MILESTONES.md`; this file.

## Decisions the spec left open

- **`member` is the runner's `Member`**, joined by `main.ts` with `ensureMember("runner",
  "agent")`; the runner does not join itself, so a test can pre-seed a stale claim by the
  same member before starting it.
- **`stop()` returns a promise** that resolves once the in-flight job has finished; the
  daemon's shutdown awaits it before `core.close()`, as the spec's "stops it on shutdown
  before closing the core" needs to mean something with an async run in progress.
- **Base branch: the local head of the branch `origin/HEAD` names, else `main`, else
  `master`.** When `origin/HEAD` names a branch with no local head, the run fails naming
  that branch rather than silently falling through to `main`: "no fetch, local head" is
  the rule, and guessing a different base is the spike's bug in another form.
- **An empty slug drops the dash**: an all-symbol title gives `skelcrew/<id>`, not
  `skelcrew/<id>-`. Leading and trailing dashes are trimmed before and after truncation.
- **A registered worktree whose directory is gone is pruned and re-added.** Git refuses to
  add over a "missing but already registered" worktree; pruning only forgets entries whose
  directory no longer exists, so no work can be lost by it.
- **Failure comments read `<step> failed: <error>`**, with the steps named `resolve base
  branch`, `create branch`, `add worktree`; the attention note is the same text.
- **Teardown on a card that is not a card** (a worktree entry whose name is not a card id):
  torn down as for an archived card when it is a registered worktree, with the outcome on
  stderr since there is no card to comment on; anything else under `worktrees/` is left
  alone with a warning.
- **The daemon without a repo root but with `SKELCREW_DIR`** (003's process tests) starts
  no runner and says so on stderr; the runner needs a repository to add worktrees to.
- **A `warn` option** (default `console.error`) for what has no card to land on, matching
  `sweepTick`'s boundary.

## Review round 1

CHANGES REQUESTED: two Important findings and three Minors taken; judgement calls (a),
(b), (c), (e), (f), (h) accepted as they stood.

- **Important 1 — a run kept writing after losing its claim.** Between `claimCard` and
  "update card" the run awaits git several times, and nothing re-checked the claim. Fixed
  in `runner.ts`: `stillHeld()` re-reads the card after every await; when `claim.by` is no
  longer `runner`, the run throws `RunAbandoned`, posts one comment `run abandoned:
  <reason>` (`card archived`, or `claim lost[ to member N]; card is in <phase>`), and
  posts nothing else — no refs, no attention request, no release (the claim is already
  gone; the teardown queued by the move or archive handles any worktree). Three
  regression tests drive it deterministically through a `defaultBranch` gated on a
  promise: the owner moves the card to `pr`, a live-session agent claims it, and the owner
  archives it, each while the run is inside git.
- **Important 2 — `.skelcrew/` was only gitignored in this repo.** `prepareDataDir` now
  writes `<data dir>/.gitignore` containing `*` when absent. A process test runs the
  daemon with the data directory at `<temp repo>/.skelcrew/` (no `SKELCREW_DIR`), lets a
  run create a worktree there, and asserts `git status --porcelain` in the repo is empty
  and `--ignored` lists `.skelcrew/`.
- **Minor 3 — a prunable entry was reused.** An existing directory whose `worktree list`
  entry is `prunable` now fails the add-worktree step like an occupied path; teardown and
  reconciliation treat it as "not a git worktree" and leave it alone. Test: delete the
  worktree's `.git` file, move Spec → Code, the run fails naming the path.
- **Minor 4 — the kept comment was unbounded.** It goes through `within()`; test with
  twenty deep paths whose listing would exceed the bound.
- **Minor 5 — readiness read `Date.now()`.** `RunnerOptions.now` (default `Date.now`) is
  what the lapsed-claim check uses; `main.ts` passes nothing, like the core. Test: a core
  and runner sharing a shifted clock claim over a claim lapsed by that clock but not by the
  wall clock.

## Review round 2

CHANGES REQUESTED: three Important findings and Minors 4 and 6 taken; Minors 5, 7, 8
carried to the PR.

- **Important 1 — the failure path never re-checked the claim.** `run()` now has one
  `lost()` read used by both paths: `stillHeld()` on success, and the `catch` before any
  failure state is posted. A git error after the claim went away posts only the single
  `run abandoned: <reason>` comment — no `<step> failed` comment, no attention request, no
  release. Tests: a gated `defaultBranch` that throws once opened, with (a) the owner
  having moved the card to `pr` and (b) the owner having released and `crew-1` claimed.
- **Important 2 — a queued teardown removed the next run's worktree.** `teardown()`
  re-reads the card first and does nothing when it exists, is unarchived, and is in a
  claimable phase. Test: with the pump busy inside card 1's gated run, card 2 goes
  `spec → pr → spec`; after the gate opens card 2 runs, and its worktree and request
  survive the teardown queued behind the scan.
- **Important 3 — the exit ramp's path had no daemon.** `findRepoRoot` in
  `packages/shared/src/paths.ts` now reads a `.git` file, parses its `gitdir:` line, and
  when it is `<main>/.git/worktrees/<name>` and `<main>/.git` exists, returns `<main>`.
  Any other `.git` file keeps the old behaviour — including the 003 process-test fixture
  pointing at a `/elsewhere` that does not exist, which is why the existence check is
  there. Tests: `paths.test.ts` on a real linked worktree (inside the repo and elsewhere on
  disk, from its root and a nested dir) and on stale, relative, and unparseable `.git`
  files; a CLI test that runs `ls` and `mv` with cwd inside `<repo>/.skelcrew/worktrees/1`
  and no `SKELCREW_DIR`. Recorded in `docs/MILESTONES.md` for 007.
- **Minor 4 — a lapsed runner claim let the run finish.** `lost()` treats `expiresAt <=
  now()` as lost (`claim lapsed; card is in <phase>`). Test: the shared clock jumps 121 s
  while the run is gated; the run is abandoned and posts nothing else. The `daemon
  restarted` note about lapsed claims is in `docs/MILESTONES.md`.
- **Minor 6 — `within()` cut by characters.** It now cuts by UTF-8 bytes with the ellipsis
  inside the budget, at a code-point boundary. Test: twenty files named with sixty
  four-byte characters each; the kept comment is within the budget in bytes, ends with the
  ellipsis, and contains no replacement character.

## Post-review minors

APPROVED with three Minors, all taken.

- **`status()` returned C-quoted paths.** `git status --porcelain` under the default
  `core.quotePath` renders non-ASCII, `"`, and `\` in a path as `"…\360\237…"`. `git.ts`
  now runs `--porcelain -z` and `parseStatus` splits on NUL, skipping the original-path
  record a rename or copy adds. The emoji-filename "kept" test asserts the literal
  filename appears in the comment; red showed the `\360\237\230\200` form.
- **Reconciliation mapped `01` to card 1.** `Number(name)` accepted `01`, `1e0`, ` 1`;
  the entry now needs `/^\d+$/` and `String(Number(name)) === name`, else it is "no
  card" and goes down the stderr path. Test: a stray `worktrees/01` with a file, card 1
  in `spec`; red showed the "left alone" comment landing on card 1.
- **`findRepoRoot` and `--separate-git-dir`.** Docs only: one sentence in the 006
  bullet of `docs/MILESTONES.md` recording that the rule needs the gitdir's grandparent
  to be `.git`, so such a repository's runner worktrees fall back to their own directory.

## Review outcomes (orchestrator)

- Round 1: CHANGES REQUESTED — Important: the run kept writing to the card after losing its
  claim; `.skelcrew/` was only gitignored in this repo, so target repos would see the
  worktrees. Fixed (`lost()` re-check with a single `run abandoned` comment;
  `prepareDataDir` writes `.gitignore` `*`). Minors taken: prunable entries not reused, kept
  comment bounded, injectable `now`.
- Round 2 (fresh reviewer): CHANGES REQUESTED — Important: the failure path still wrote to a
  lost card; a queued teardown removed a worktree a later run had just handed over; the CLI
  did not work from inside a runner worktree (`findRepoRoot` stopped at the worktree's `.git`
  file). Fixed (`lost()` in the catch path; teardown re-reads the card; `findRepoRoot`
  resolves a linked worktree to its main repo when `<main>/.git` exists). Minors taken:
  lapsed claim treated as lost; `within()` bounds by bytes. Carried: shutdown can hang on a
  stuck git hook; `registered()` under a symlinked ancestor with the dir absent;
  `prepareDataDir` writes `.gitignore` into any `SKELCREW_DIR`.
- Round 3 (fresh reviewer): APPROVED. Three Minors, two fixed after approval and covered by
  verification (`status()` uses `-z` so non-ASCII paths come back unquoted; reconciliation
  accepts only canonical numeric entry names), one documented (`--separate-git-dir` mains
  do not resolve through the linked-worktree rule).
