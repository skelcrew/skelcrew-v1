# 020 — A conflicting pull request asks to go back to Code

Run record for `docs/specs/020-a-conflicting-pull-request-asks-to-go-back-to-code.md`.

## `gh`'s two new fields, verified first

`gh version 2.86.0 (2026-01-21)`, against real pull requests, before any code was written —
`gh pr view <url> --json state,mergedAt,headRefName,url,mergeable,baseRefName`:

- Merged (this repository's own #7):
  `{"baseRefName":"main","headRefName":"worktree-runner-skeleton","mergeable":"UNKNOWN","mergedAt":"2026-09-09T08:44:11Z","state":"MERGED","url":"…/pull/7"}`
  — a merged pull request answers `UNKNOWN`, as the spec records.
- Open and mergeable (`cli/cli#14373`): `"mergeable":"MERGEABLE"`, `"baseRefName":"trunk"`.
- Closed without merging (`cli/cli#14423`): `"mergeable":"MERGEABLE"` — the field says nothing
  about whether the pull request is still open.
- **Open and conflicting**, which the spec records as *not observed* because none existed while
  it was written: `cli/cli#14285`, 2026-09-14 —
  `{"baseRefName":"trunk","headRefName":"williammartin-audit-spam-labeling","mergeable":"CONFLICTING","mergedAt":null,"state":"OPEN","url":"https://github.com/cli/cli/pull/14285"}`.
  `gh pr list -R cli/cli --limit 40 --json number,mergeable` answered `CONFLICTING` for 13 of 40.
  So `forge.ts` records this as observed rather than as open, which is the one place this run
  knows more than the spec did.

## The change, in steps

1. **`forge.ts`** — `PR_FIELDS` gains `mergeable` and `baseRefName`; `PullRequest` gains
   `mergeable: "mergeable" | "conflicting" | "unknown"` and `baseRefName: string`;
   `parsePullRequest` maps the two known enum values and everything else to `unknown`.
2. **`merges.ts`** — `visit`'s open pull request is no longer an early return: when the answer is
   this card's own work by 018's check and `mergeable === "conflicting"`, the poll raises the
   conflict request (`moves: ["code"]`) through the closed path's once-rule and comments after a
   raise that took; when it is mergeable and the poll's own conflict request is open, one
   "no longer conflicts" comment. The card is never moved.
3. **`allowlist.ts`** — `allowlistFor` composes `Bash(git fetch origin <base>)` and
   `Bash(git merge --no-edit refs/remotes/origin/<base>)` for a Code run, only when the base
   name is one word of `LINE_CHARS`; otherwise nothing is added and the `scanned` clause says so.
4. **`code.md`** — a *When the card says the pull request conflicts* section with the two
   commands fenced, and never rebase.
5. **`harness-check.ts`** — the Code list under test gains the two entries composed for `main`,
   and `FIXED_LIST_REPRESENTATIVES` the two commands themselves.
6. **Tests** — `forge.test.ts` (criterion 2), `merges.test.ts` (3–7), `contracts.test.ts` (8),
   `allowlist.test.ts` and `run.test.ts` (9), `playbooks.test.ts` (10), and the record
   assertions of criterion 11.

## Files expected to change

- `packages/daemon/src/runner/forge.ts`, `forge.test.ts`
- `packages/daemon/src/merges.ts`, `merges.test.ts`
- `packages/daemon/src/runner/allowlist.ts`, `allowlist.test.ts`
- `packages/daemon/src/runner/harness-check.ts`, `harness-check.test.ts`
- `packages/daemon/src/runner/playbook-commands.ts`, `playbooks.test.ts`
- `packages/daemon/playbooks/code.md`
- `packages/daemon/src/runner/contracts.test.ts`, `run.test.ts`
- this record

## What the spec left open, and how it was decided

- **`baseRefName` is read as strictly as `headRefName`; `mergeable` is not.** The spec asks that
  an absent `mergeable` degrade to `unknown` and says nothing about an absent `baseRefName`. It is
  a parse failure here — "cannot answer", the path a logged-out `gh` already takes — because the
  base branch is what the note names and there is nothing to degrade to that a card could be told
  (`conflicts with ` reads as a defect). In practice neither branch is reachable: `gh` rejects a
  field it does not know with a non-zero exit, so a partial answer is not a shape it produces.
- **The two entries are a Code run's, not a review run's.** The spec's implementation section
  puts no `kind` condition on `allowlistFor`, and criterion 9 says "a Code run's `allowedTools`".
  A review run writes nothing — no `git add`, `git commit` or `git push` on its list, and its
  contract fails a run whose branch moved — so `git merge` there would contradict 019. A Spec run
  does get them, because the "Code list" is the list both claimable phases share.
- **The `scanned` clause is two clauses joined by `; `**, base branch first, so the run-start
  comment says what the scan did as well. `RunAllowlist` is unchanged in shape, as the spec asks.
- **`<base>` fills with a branch name, not with `PLACEHOLDER`** (`FILLED_BASE` in
  `playbook-commands.ts`). This is the one thing the spec does not reconcile: criterion 1 asks
  `check:harness` to report `git fetch origin main` *as a command the Code playbook instructs*,
  and criterion 10 asks `code.md` to fence `git fetch origin <base>`. `filled()` turned every
  `<…>` into `PLACEHOLDER`, so the instructed command would have been
  `git fetch origin PLACEHOLDER` — denied under an **exact** entry composed for `main`, failing
  the check on a substitution of the check's own making. So `<base>` — the one placeholder whose
  value a run really knows — fills with `FILLED_BASE`, and both checkers compose their list for
  that same name (`playbooks.test.ts` against the model, `harness-check.ts` against the harness,
  whose temporary repository is created on it). One constant, so the two cannot drift.
- **One session covers both roles in `check:harness`.** The representative and the instructed
  command are the same string, and `commandsFor` de-duplicates, so `git fetch origin main` is run
  once and counts for both. `harness-check.test.ts` asserts the membership in each.

## Red, and the cases that were green first

Red first, failing on their assertions:

- `forge.test.ts`, the four recorded payloads and the mergeability cases — 6 of 9 failing, each
  as *`- "baseRefName": "main"` / `- "mergeable": "unknown"`* against a parser that returned
  neither field.
- `merges.test.ts`, the five cases that expect something to happen (the raise, the once-rule
  after a send-back, the unknown-then-conflicting tick, the cleared comment, the raise after
  another member's request is answered): *`Expected: "pull request … conflicts with main; … needs
  refs/remotes/origin/main merged in"  Received: undefined`*.
- `allowlist.test.ts`, the composition, the character check and the run-start clause — plus the
  14 existing scan cases, which read "everything past the fixed list" and so moved with `floor()`.
- `harness-check.test.ts`, both coverage cases: *`- "Bash(git fetch origin main)"`* from
  `unrepresentedEntries`, and the representative membership as `- true + false`.
- `playbooks.test.ts`'s new case: *`Expected to contain: "git fetch origin <base>"`* against a
  playbook with no such block. (Its first version failed on `FILLED_BASE` not existing yet —
  an import error is a broken test, not red, so the constant was added and the case re-run.)

Green first, each checked by mutation instead:

- **`merges.test.ts`'s four "nothing on the card" cases** (criterion 4, and the crew-recorded
  branch): they assert that nothing happens, which a poll doing nothing satisfies. Dropping the
  `wrong === undefined` guard on the open path fails exactly those four and nothing else.
- **`contracts.test.ts`'s criterion 8 case**: written after `merges.ts` was green, because it
  composes behaviour already driven red there with 014's move and claim. Mutation — `moves: []`
  in the raise — fails it, along with four of the unit cases.
- **`run.test.ts`'s run-start comment case** and `spawnedWith`'s two new entries: written after
  `allowlistFor`. Mutation — dropping the `LINE_WORD` check — fails that case and the two
  `allowlist.test.ts` character cases.
- **The record assertions (criterion 11)**: the prose was written with the code. Mutation —
  replacing "This is a gate, not a boundary…" with "This is safe" — fails the `allowlist.ts`
  record case.

## Existing tests that changed, and why

No assertion was weakened; three kinds of change, all forced by the new fields or the new entries:

- **Faked forge answers gain `baseRefName` and `mergeable`** (`merges.test.ts`,
  `contracts.test.ts`, and `process.test.ts`'s `gh` shim), with the values the real `gh` gives —
  `unknown` for a merged pull request, `MERGEABLE` for the shim's open one. This is the exception
  the spec names.
- **`floor()` / `spawnedWith()` / `CODE_LIST.list` gain the two entries**, because they spell out
  what a run is spawned with and that changed. `floor()` took a base parameter so the
  "no remote-tracking head" case can name its own.
- **`playbooks.test.ts`'s "every command goes unprompted" now composes the list** it checks
  against (`FIXED_ALLOWLIST` plus `baseBranchGrants(FILLED_BASE)`), because the list is no longer
  a constant: two of its entries are built per run from the base branch's name.

## Checks

- `bun run check` — 739 tests, green.
- `bun run check:harness` — 52 commands under test plus the control: 33 under the Code list and
  19 under the review list. `git fetch origin main` and `git merge --no-edit
  refs/remotes/origin/main` are among the Code list's, each as a list representative and as a
  command the Code playbook instructs. Every one ran unprompted; `git push origin HEAD:main` was
  denied under **each** list; the temporary repository was unchanged.

## Review round 1, and what each finding became

One Important, four Minor, no Critical. The spec was amended first (`docs:` commits `b22507d`,
`2c0a965`) and the amended wording is what the code now matches. One finding changes behaviour
(Minor 4); it was driven red first. The other three are prose the tests pin.

- **Important 1 — the fix run's merge commit pollutes the next review run's diff and the card's
  recorded commits.** Recorded as a limit, which is what the amended spec asks for ("Two more
  limits, found by review round 1 and recorded rather than fixed here, because the fix belongs to
  the base every run is measured against and not to this spec"). `code.md` §6 gained a paragraph,
  *Name the merge commit on the card*: the review that follows diffs against the **local** base,
  nothing fetches that ref, so every commit that came in with the merge appears in that diff and
  in the commits recorded on the card — and the fix run posts `skelcrew comment <id> "<text>"`
  with the merge commit's sha so the reviewer, which reads the card first, knows which commits
  are not this card's. The same limit is recorded beside `baseBranchGrants` in `allowlist.ts`
  rather than in `merges.ts`, because the grant is what makes the merge possible and the merge is
  what widens the diff; it names the real fix (measure a run against the newer of the local and
  remote-tracking base, which moves 014's contract and 019's review playbook together) as carried
  to MILESTONES. Nothing in `contracts.ts` or `review.md` moved. Red first, both halves:
  *`Expected to contain: "**Name the merge commit on the card.**"`* in `playbooks.test.ts`, and
  *`Expected to contain: "the next review's diff is wide"`* in `allowlist.test.ts`'s criterion 11
  record case.
- **Minor 2 — §6 told the run to conclude the merge with a bare `git commit`, which opens an
  editor.** §6 now says "conclude the merge with `git commit --no-edit` — the message the merge
  prepared; without `--no-edit` git opens an editor and an unattended run hangs there". Red first:
  *`Expected to contain: "conclude the merge with \`git commit --no-edit\`"`*. The reason is
  written *without* naming a bare `git commit` in backticks on purpose: `INSTRUCTION` matches
  `git commit`, so an inline span of it in an instructing paragraph would have made the playbook
  "instruct" a bare commit — which the first draft did, and `playbooks.test.ts`'s
  "what the instructed list drops" case caught it (`git commit` left the `DROPPED` table).
  `instructedCommands(code)` gains exactly one command, `git commit --no-edit`, and
  `check:harness` runs it under the Code list unprompted (`Bash(git commit *)` covers it): 52
  commands now, up from 51.
- **Minor 3 — a conflict that returns after "no longer conflicts" is never said again.** Recorded
  as a limit in `merges.ts`'s doc point 6, as the amended spec asks: the once-rule is keyed to the
  conflict note since the card entered PR, so conflict → clears → conflicts again leaves "no
  longer conflicts" as the runner's last word while the open request still carries the conflict
  and the move to Code. The owner's queue is right; the feed's last line is stale. No behaviour
  changed, and the once-rule was not re-keyed — so there is no test here, in the shape of
  `merges.ts`'s other five doc points, none of which a test reads.
- **Minor 4 — `baseBranchGrants`' doc said "What a Code run may do", but every non-review run got
  it.** `allowlistFor` now composes the entries for `kind === "code"` alone, and the run-start
  comment's unwritable-base clause with them: a Spec run shares the Code list, has no conflict to
  fix, and instructs neither command. Red first, in two places:
  - `run.test.ts`'s Spec-run case, after `spawnedWith` stopped spelling the two entries out:
    *`expect(received).toEqual(expected)` … `+ "Bash(git fetch origin main)" + "Bash(git merge
    --no-edit refs/remotes/origin/main)"` / `- Expected - 0 + Received + 2`* — plus three more
    cases in that file that share the helper.
  - `allowlist.test.ts`'s new "a Spec run gets neither entry, whatever its base branch is named",
    which failed on a Spec run's tools containing both, and which also asserts that a Spec run
    with an unwritable base says nothing about a base branch in its run-start comment.

  **`run.test.ts`'s Spec-run expectation was corrected, not weakened.** `spawnedWith` said what a
  run is spawned with, and what it said for a Spec run was the behaviour the finding names as
  wrong; it now spells out the Spec list, and the case asserts in addition that neither entry is
  on it (`toEqual` plus an explicit `not.toContain` per entry). `run.test.ts`'s unwritable-base
  case (criterion 9's run-start-comment half) now runs a **Code** card — `runCard` took a `phase`
  parameter, defaulting to `spec` — because that is the run the clause belongs to. Every other
  assertion in both files is unchanged. `harness-check.ts`'s Code list stays composed with the two
  entries: it is the Code list under test.
- **Minor 5 — the run record had no definition-of-done section.** Added above, in 019's shape.
