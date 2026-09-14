# 019 — Code is reviewed before the owner sees it

Run record for `docs/specs/019-code-is-reviewed-before-the-owner-sees-it.md`.

## The change, in steps

1. **The verdict as a primitive.** `packages/shared/src/types.ts` gains `ReviewVerdict` and the
   `review_recorded` event; `protocol.ts` gains `reviewCard`; `core.ts` gains
   `review(id, {verdict, text}, actorId)` with `comment`'s checks; `server/protocol.ts` gains the
   handler; `packages/cli/src/commands/review.ts` and `render.ts` give it a surface.
2. **A third playbook.** `packages/daemon/playbooks/review.md`, extracted from
   `.claude/agents/reviewer.md`. `playbooks.ts` loads three (`PlaybookKind = PlaybookPhase |
   "review"`); `PLAYBOOK_PHASES` still names the two claimable phases. `code.md` §1 gains the
   paragraph about a `changes requested` verdict being this run's brief.
3. **The review run's grants.** `allowlist.ts` gains `REVIEW_ALLOWLIST` and
   `REVIEW_DENIED_TOOLS`; `allowlistFor(git, repoRoot, base, path, kind)` takes the run kind.
4. **The review contract.** `contracts.ts` gains `reviewContract`, chosen by run kind;
   `ContractOutcome` carries the verdict the loop acts on.
5. **The loop.** `run.ts`'s `runPlaybook` returns the contract's outcome when it is met rather
   than ending the card; `runner.ts`'s `run(id)` becomes Code → review → Code … under one claim,
   with `REVIEW_ROUNDS_MAX = 3`, and owns the three endings the loop has of its own.
6. **A parked ending.** `ending.ts`'s `endRun` takes the run log path and, when its comment and
   its request both throw, raises one fixed note; if that throws too it releases nothing.
7. **The harness check.** `harness-check.ts` puts the review playbook's instructed commands and
   one representative per review-list entry through the pinned harness, under the review list.

## Files expected to change

- new: `packages/daemon/playbooks/review.md`, `packages/cli/src/commands/review.ts`
- `packages/shared/src/{types,protocol,index}.ts`
- `packages/daemon/src/core/core.ts`, `packages/daemon/src/server/protocol.ts`
- `packages/daemon/src/runner/{playbooks,allowlist,contracts,run,runner,ending,harness-check}.ts`
- `packages/daemon/playbooks/code.md`
- `packages/cli/src/{main,render}.ts`
- tests: `core.test.ts`, `server/protocol.test.ts`, `cli.test.ts`, `render.test.ts`,
  `contracts.test.ts`, `run.test.ts`, `allowlist.test.ts`, `playbooks.test.ts`,
  `harness-check.test.ts`
- this record

## What the spec left open, and how it was decided

- **The verdict text renders on its own lines, every line marked.** The spec says both "through
  the same marked continuation a comment uses" (§ *The verdict is a primitive*) and "with every
  line of the text marked" (criterion 2, and the *Desired behavior* paragraph). A comment's
  `continued()` leaves the first line unmarked, beside its label. Criterion 2 is the binding
  form, so `reviewed: changes requested` stands alone on its line and the text follows through
  `marked()`. No line of the text can then read as a line the CLI composed.
- **A fix run is announced too.** The spec names the comment before a review run
  (`review round N of 3 starting; run log at <path>`) and says nothing about the one before a
  fix run. Each run has a log of its own, and a log path nobody can see is not observable, so a
  fix run posts `fix run starting; run log at <path>`.
- **Every run in the loop gets its `sinceSeq` just before it starts**, which for the first run
  moves it from the `claimed` event to the run's own start comment. Nothing between the two is
  an event any contract or ending counts.
- **A met Code contract goes to review even with the agent's own question standing.** The loop's
  condition is the contract, as the spec words it. The review run's ending then finds that
  request standing, offers no move and releases `blocked`, which is what criterion 10's last
  clause asks for one run later.
- **The scan's narrowing is read from the Code list for both kinds.** `narrowedCommands()` is
  unchanged, so a scanned line naming `git`, `gh` or `skelcrew` contributes nothing to a review
  run either — a review list read on its own would not narrow `git` at all, and a repository
  documenting `git push --force` would have granted it to the reviewer.
- **`problemsIn` takes the lists under test**, rather than one representative array, because
  there are now two lists and each entry's representative has to run under its own list.

## Red, then green

Each slice was written as a failing test first, run, and the failure read before anything was
implemented:

- **The verdict primitive.** `core.test.ts`'s three cases failed with
  `TypeError: core.review is not a function`; over the socket,
  `RpcError: unknown method "reviewCard"`; through the CLI,
  `error: unknown command "review"`; and `render.test.ts` with
  `Expected to end with: "reviewed: approved" / Received: "… simon  undefined"`.
- **The review playbook.** `PLAYBOOK_KINDS` and the two list constants were added as empty
  scaffolding first so the failure would be an assertion rather than an import error; with a
  stub `review.md` in place, five of the seven new playbook tests failed on their assertions
  (the advertisement, the instructed commands, the verdict rules, the diff rule, AGENTS.md).
- **The review list.** Four `allowlist.test.ts` cases failed with the Code list where the
  review list was expected (`allowlistFor` ignored its new argument).
- **The loop.** All ten new `contracts.test.ts` cases failed; the first on
  `expect(round).toBeGreaterThanOrEqual(0) / Received: -1` — no review round had started.
- **The parked ending** was the one place the implementation came first, because `endRun`'s
  signature had to change with the loop. Its two tests were checked for teeth afterwards by
  disabling the park block (`if (false && !said)`): both then failed, waiting for an attention
  request and a warning that never came. Restored, both pass.

**Existing assertions changed in three places, all of them structural:**

- Seven `contracts.test.ts` cases whose Code run meets its contract now use `scripted(…)`
  rather than `fakeDriver(…)`, so the driver also plays the reviewer and approves. No assertion
  in them changed.
- `protocol.test.ts`'s two method-parity tests learned one rename: the core's `review` is
  `reviewCard` on the wire, which is the same stand-in mechanism `ensureMember → hello` uses.
- `harness-check.test.ts` moved from one representative array to the two lists under test,
  because coverage is now counted per list.

## Two places the spec's own wording pulls in two directions

Both are called out rather than silently resolved:

- **The rendering.** *The verdict is a primitive* says "the same marked continuation a comment
  uses" (`continued()`, which leaves the first line beside its label); criterion 2 and *Desired
  behavior* both say "every line of the text marked". The criterion is the binding form, so the
  findings stand on their own lines under the verdict and every one of them carries `> `.
- **What parks an ending.** Criterion 12 says "an ending whose comment **and** request both
  throw". 014's existing case — a core whose `requestAttention` always throws while the comment
  lands — asserts that a met artefact still releases `finished`. So the park fires only when the
  comment itself failed, which is what "nothing on the card says why" means, and 014's assertion
  stands unchanged.

## Checks

- `bun run check` — 706 tests, green.
- `bun run check:harness` — 49 commands under test plus the control: 30 under the Code list
  (the spec and code playbooks' instructions, a representative per entry, the repository's
  fenced `bun run check`) and 19 under the review list (the review playbook's instructions, a
  representative per entry, the same fenced command). Every one ran unprompted;
  `git push origin HEAD:main` was denied; the temporary repository was unchanged.
