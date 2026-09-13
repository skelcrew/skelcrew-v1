# 018 — A merged pull request lands the card in Done

Run record for `docs/specs/018-a-merged-pull-request-lands-in-done.md`.

## `gh`'s field names, verified first

`gh version 2.86.0 (2026-01-21)`, against real pull requests, before any code was written:

- `gh pr view <url> --json state,mergedAt,headRefName,url` works.
  Merged: `{"closed":true,"headRefName":"worktree-runner-skeleton","mergedAt":"2026-09-09T08:44:11Z","state":"MERGED","url":"…/pull/7"}`.
  Open: `{"closed":false,"headRefName":"patch-1","mergedAt":null,"state":"OPEN",…}`.
  Closed unmerged: `{"closed":true,"headRefName":"bump-go-1.27.1","mergedAt":null,"state":"CLOSED",…}`.
  `state` is upper-case; `mergedAt` is `null` unless merged.
- **`baseRepository` does not exist.** The spec names it as a candidate; `gh` 2.86.0 rejects it
  (`Unknown JSON field: "baseRepository"`) and its field list has no base-repository entry at
  all. `headRepository.nameWithOwner` comes back as `""`. So the repository a pull request lives
  in is taken from the canonical `url` `gh` itself returns: `<origin>/<owner>/<repo>/pull/<n>` →
  `<origin>/<owner>/<repo>`.
- Every failure exits non-zero: a missing pull request (exit 1, GraphQL error), a URL that is
  not a pull request URL (exit 1 — `gh` falls back to reading the argument as a branch name),
  a missing binary (spawn fails). All of them are "cannot answer".

## The change, in steps

1. **`packages/daemon/src/runner/forge.ts`** — a `Forge` beside `Git`, `Bun.spawn`-shaped like
   `git.ts`. `pullRequest(repoRoot, url)` → `{ url, state, mergedAt?, headRefName, baseRepo }`
   or `undefined`; `repoRoot`'s own repository URL via `repoUrl(repoRoot)` (`gh repo view --json
   url`), also `undefined` when `gh` cannot answer. Parsing is an exported pure function tested
   against the recorded real output above; no test spawns `gh`.
2. **`packages/daemon/src/merges.ts`** — `mergePoll({core, forge, repoRoot, runnerId, warn})`
   with `tick()`, in `sweep.ts`'s shape: list unarchived `pr` cards with a `prUrl`, return
   without touching the forge when there are none, else ask and act (merge → comment then move
   as the owner; mismatch → one comment; closed → one comment plus an attention request; open
   or no answer → nothing). `MERGE_POLL_INTERVAL_MS` = 60 s, `mergePollIntervalFromEnv`
   mirroring `runLimitFromEnv`.
3. **`packages/daemon/src/main.ts`** — the interval beside the claim sweep, in the branch that
   has a `repoRoot`.
4. **Tests** — `merges.test.ts` (criteria 2–7 against the real core and a faked forge, plus the
   ownership table and criterion 8 end to end against the runner with a scripted driver) and
   `forge.test.ts` (the recorded `gh` output, parsed).

## Files expected to change

- new: `packages/daemon/src/runner/forge.ts`, `runner/forge.test.ts`, `merges.ts`,
  `merges.test.ts`
- `packages/daemon/src/main.ts`
- `packages/daemon/src/runner/contracts.test.ts` (criterion 8, beside 014's send-back cases) and
  `packages/daemon/src/server/process.test.ts` (the interval read from the environment)
- this record

## What the spec left open, and how it was decided

- **Two forge methods, not one.** The spec's one method cannot answer "is this pull request in
  *this* repository" on its own, because `gh pr view` takes the URL as authority and ignores the
  cwd's repository (verified: it answers about another repository's pull request from inside
  this one, and even from outside any repository). So `repoUrl(repoRoot)` is the second method,
  asked once per tick and only when a candidate card exists.
- **`baseRepo` is a repository URL** (`https://host/owner/repo`), not an `owner/repo` slug, so
  that two hosts with the same slug cannot match. Both sides of the comparison come from `gh`'s
  own canonical output.
- **The owner is resolved inside the tick** (`listMembers().find(kind === "human")`, as
  `runner.ts` does), so `main.ts` wires no member and a missing owner is one warning, not a
  crash.
- **`mergePoll` is a closure with a `tick()`**, not the spec's free `mergeTick(…)` function: the
  "warn once per process" the spec asks for is state between ticks, and a closure is where a
  test can drive many ticks and count the warnings. The interval, and the guard against a slow
  tick overlapping the next, live in it too.
- **`undefined` carries no detail**, so the warning names the URL and asks whether `gh` is
  installed and logged in rather than quoting `gh`'s stderr. That is what the spec's return
  shape allows.
- **The mismatch comment names every mismatch at once**, repository before branch, the way a
  Code run's unmet contract names its conditions in a stable order. A card in PR with a `prUrl`
  but no `refs.branch` is a mismatch too — there is nothing for the head branch to equal.
- **The merge poll runs where the runner runs** — `SKELCREW_RUNNER=0` turns it off with the
  execution half, and no `repoRoot` disables it — because it spawns a subprocess against the
  repository. State-only daemons (and `main`'s own tests) spawn no `gh`.

## Red, and the cases that were green first

Written before the implementation, run, and failing on their assertions (the stubs existed, so
no case failed on an import):

- `forge.test.ts`, all five positive parse cases (four, then the `parseRepoUrl` one added with
  its own stub) — the parsers returned `undefined`: *"Expected: … Received: undefined"*.
- `merges.test.ts`, 17 of 21 cases, against a `mergePoll` whose `tick()` did nothing and a
  `mergePollIntervalFromEnv` that returned 0. Criterion 2: *"expect(received).toBe(expected)
  Expected: "done" Received: "pr""*. Criterion 3 and 4 and the mismatch table: the comment the
  card should carry was absent. Criterion 6: *"expect(received).toHaveLength(1) received has
  length 0"* for the warning. Criterion 7: `0` instead of `60000`.

Green first, each with its reason:

- **`merges.test.ts` "a board with nothing in PR carrying a pull request makes no forge call"**
  and the three *stays in PR* rows of the ownership table: they assert that nothing happens, and
  a `tick()` that does nothing satisfies that. Their meaning comes from the implementation
  existing, so both were checked by mutation instead: with `watched()`'s phase condition dropped
  (`card.archivedAt === null && card.refs.prUrl !== undefined`), exactly three cases fail — the
  criterion 5 table, criterion 2's second tick, and criterion 8's "does not move it back".
- **`forge.test.ts` "output that is not an answer about a pull request is no answer at all"** —
  the stub returned `undefined`, which is what the case asserts. It earns its keep against the
  finished parser, which returns an object for every other input in the file.
- **`contracts.test.ts` "a merged pull request lands the card in Done; the owner can still send
  it back to Code"** (criterion 8) — written after `merges.ts` was green, because it composes
  behaviour already driven red-first there with 014's send-back, which predates this spec. Its
  last assertion is one of the three the mutation above breaks.
- **`process.test.ts` "a SKELCREW_MERGE_POLL_SECONDS that is not seconds stops the daemon"** —
  written after the wiring in `main.ts`. Checked by mutation: with `main.ts` taking
  `MERGE_POLL_INTERVAL_MS` instead of reading the environment, it is the one case that fails.

## Review round 1, and what each finding became

Two Important, five Minor, no Critical. Every finding is fixed; the spec was amended first
(`docs:` commits `df668e6`, `562ec23`) and the amended wording is what the code now matches.

- **Important 1 — the tick acted on a stale snapshot.** `visit` now re-reads the card after the
  forge answers (`stillWatched`) and writes nothing unless it is still in PR, still unarchived,
  and still carrying the `prUrl` the forge was asked about. Red first, in the reviewer's own
  shape: with the owner moving the card back mid-await, *`Expected: "code" Received: "done"`* —
  the tick had moved a card in Code to Done as the owner. Four new cases: sent back to Code,
  archived, `prUrl` replaced, and the same for the mismatch comment.
- **Important 2 — the check compared two fields `crew` can write.** `recordedBranch` reads the
  branch from the last `refs_set` whose actor is `runner` and whose `set` names `branch`; a card
  no run has recorded a branch on is a mismatch. Red first: *`Expected: "pr" Received: "done"`*
  for the two-`crew`-writes case. Four new cases (`crew` rewrites both refs; a branch only `crew`
  ever recorded; a re-run's branch is the one that binds; plus the real-runner version in
  `contracts.test.ts`), and `cardInPr` now records the branch as `runner` and the pull request as
  `crew`, which is who writes each in a real run. The doc says what the check binds and what it
  does not — a caller asserting the owner's identity over the socket is 016's recorded limit.
- **Minor 3** — the precedent paragraph now says the daemon records a member's *decision*, and
  names the sweep's `run_interrupted` as the event it is not.
- **Minor 4** — the closed path raises through `runAttention` (the helper the runs use) with a
  `runQuestion` that records nothing, so *any* open request refuses the raise; the comment is
  posted only after a raise that took. Red first: the request the poll did not raise was
  overwritten, and a throwing `requestAttention` left a comment that suppressed every retry. Two
  new cases; criterion 4's order assertion is now request-then-comment, for that reason.
- **Minor 5** — the merged comment goes through the once-rule too, while the move is still
  attempted every tick. Red first: two ticks against a throwing `moveCard` gave two identical
  comments (*`Expected - 0 Received + 1`*).
- **Minor 6** — `process.test.ts` now drives the real daemon with a `gh` shim first on `PATH`
  that records its arguments: a board holding the two shapes that must not be polled spawns no
  `gh` across two intervals, and a card in PR with a `prUrl` is asked about within one.
  Mutations: `setInterval(…, 60_000)` fails it (*"gh was not asked within 5000 ms"*), and
  dropping `watched()`'s phase condition fails it on the "no `gh` yet" assertion.
- **Minor 7** — one flag per cause. The repository line names the repository root and does not
  guess at a login; the pull-request line still does, because there it is the likely cause. A new
  case drives both causes and counts one line each.

Green first in this round, with reasons: `contracts.test.ts`'s "crew pointing a card's refs at
another merged pull request leaves it in PR" (the same composition already driven red in
`merges.test.ts`, here against a real run's `refs_set` — checked by mutation: reverting the check
to `card.refs.branch` fails it and the two unit cases), and `process.test.ts`'s poll-interval case
(written after the wiring; checked by the two mutations above).
