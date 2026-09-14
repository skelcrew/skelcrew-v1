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
