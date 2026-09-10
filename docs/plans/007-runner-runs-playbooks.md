# 007 — Runner runs the phase playbooks: run record

## Plan

1. Red: `packages/daemon/src/runner/run.test.ts` starts the runner with a scripted
   `AgentDriver` against a real temp git repo and a Spec card, expecting the run log
   comment, the two text-turn comments, and `spec ready` / `finished`; it fails because the
   runner still posts `no playbook`. `allowlist.test.ts`, `shim.test.ts`, and a type-only
   `claude.test.ts` alongside.
2. Green, boundary: `agent.ts` (`AgentDriver`, `AgentEvent`, `AgentRunOptions`); `none.ts`
   (`SKELCREW_AGENT` → `claude` | `none`); `claude.ts` (the SDK-backed driver, the only
   file importing `@anthropic-ai/claude-agent-sdk`).
3. Green, run: `allowlist.ts`, `shim.ts`, `playbooks.ts` (reads `packages/daemon/playbooks/
   {spec,code}.md`), `run.ts` (one run: spawn, stream, forward comments, approvals through
   attention, time limit, contract, hand off or fail). `runner.ts` calls `runPlaybook`
   where 006 posted the handoff, when it has a driver.
4. Green, daemon: `main.ts` selects the driver, writes the shim, loads the playbooks, reads
   `SKELCREW_RUN_MINUTES`. `process.test.ts` sets `SKELCREW_AGENT=none`.
5. `AGENTS.md` (which `CLAUDE.md` links to): the one reconciling sentence.
   `docs/MILESTONES.md`: status line, and a bullet with the shim, the agent's environment,
   the excerpt rules, and the approval words.
6. `bun run check`, then walk the criteria.

Files: `packages/daemon/package.json`, `bun.lock`; `packages/daemon/playbooks/{spec,code}.md`;
`packages/daemon/src/runner/{agent,none,claude,run,allowlist,shim,playbooks}.ts` and tests;
`packages/daemon/src/runner/runner.ts`; `packages/daemon/src/main.ts`;
`packages/daemon/src/server/process.test.ts`; `AGENTS.md`; `docs/MILESTONES.md`; this file.

## Decisions the spec left open

- **"Exactly one dependency" reads as one external dependency.** `packages/daemon/
  package.json` already carries `@skelcrew/shared: workspace:*`; removing the workspace
  link would break the daemon. The SDK is pinned exactly (`0.3.266`), no caret.
- **The driver is an option of `startRunner`; absent means 006's behaviour.** `none.ts`
  only turns `SKELCREW_AGENT` into `claude` or `none`; an unrecognised value stops the
  daemon at startup rather than guessing. `runner.ts` posts the no-playbook handoff exactly
  as before when it has no driver, so 006's tests pass unchanged.
- **The run log path goes into the worktree-ready comment** when there is a driver:
  `worktree ready at … (from main); run log at <path>`. That keeps 006's comment first and
  makes the run's first comment name the log, as criterion 2 reads. Without a driver the
  comment is 006's verbatim. The log is `<data dir>/runs/<id>-<started>.jsonl` with
  `<started>` as a compact UTC timestamp (`20260909T104500Z`).
- **A run ends at the driver's first `result` event.** With streaming input the SDK session
  would otherwise idle for more input; the playbook's session is one task.
- **The claim watch during the run is a core subscription plus the heartbeat.** A
  `released`, `run_interrupted`, `card_moved`, or `card_archived` event on the card, or a
  heartbeat that fails, re-checks the claim and aborts the driver through its signal;
  every driver event is followed by the 006 `stillHeld()` check before anything is posted.
- **Approval answers come from the `resolve -m` comment.** `resolveAttention` records the
  text as a comment immediately before `attention_resolved { how: "answered" }`, in one
  dispatch; the run reads the answer from that comment and does not also forward it to the
  agent as a user message (every other comment by a member other than `runner` is
  forwarded). A resolve without text denies with `denied`.
- **Tool summaries flush every 30 s and at the end of the run**, so a short run still posts
  its one summary. `Bash` calls are listed with their command; other tools are counted.
- **`AgentEvent` stays the four kinds the spec names**, and the transcript is not made of
  them: the driver writes every message it receives to `AgentRunOptions.log`, once, as it
  arrives, while the events are what the card displays. This first read "each with an
  optional `raw` the SDK driver fills with the SDK message, so the transcript holds the full
  stream", which was false — external round 3 says why and what replaced it.
- **Contract failures name every unmet condition**, joined with `; `, in the order commits,
  clean worktree, `prUrl`.
- **The fenced-block scan takes blocks with no language tag or a shell one** (`sh`, `bash`,
  `shell`, `zsh`, `console`), strips a leading `$ `, and reads `AGENTS.md` and `CLAUDE.md`
  at the repo root (the owner's checkout).
- **`runLimitMs` and `heartbeatMs` are runner options** so the time-limit and
  "expiry advances while waiting" tests do not wait a minute; `main.ts` sets the limit from
  `SKELCREW_RUN_MINUTES` (default 60).

## Review round 1

CHANGES REQUESTED: five Important findings, all taken; Minors 6, 8, 10, 11 taken; Minors 7
and 9 carried to the PR. Red first for each (12 failing tests), then green.

- **Important 1** — a failed run no longer replaces an open request that is not the run's
  own permission request: `fail()` posts the comment and releases `failed`, and raises
  nothing when the card already waits on something else (the agent's `skelcrew attention`
  question). The run's own request is recognised by what the core recorded for it
  (`raisedAt`, `note`, `raisedBy`). A permission request is also never raised over an open
  question: it waits for that question's `attention_resolved`. Tests for spec and code.
- **Important 2** — permission requests queue: `asks[]` plus one `current`; the next is
  raised inside the `attention_resolved` dispatch (the core queues nested mutations). If the
  agent's own question replaces the open request, the request goes back to the front of
  the queue. Test: two concurrent `canUseTool`s, one request on the card at a time, both
  answered in order.
- **Important 3** — comments seen in one dispatch are held as a list and flushed in order
  on the next microtask; only the comment whose `seq` is `attention_resolved.seq - 1` by
  the same actor is taken as the answer to the run's own request. Test: two comments in
  one tick.
- **Important 4** — `stop()` fires a `stopping` signal the run listens on; the run aborts
  the agent and fails with `run aborted: daemon stopping`, release `failed`. Chosen over
  `daemon restarted` so the card is waiting on the owner after a restart rather than
  silently re-run; `main.ts`'s shutdown already awaits `stop()`. Test: `stop()` resolves
  within three seconds during an endless run.
- **Important 5** — tried `bunfig.toml` `[install] peer = false` with a clean install:
  the peers (`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `zod`, express, hono, …)
  are gone from `node_modules/.bun`; the SDK still imports (`typeof query === "function"`)
  and the `SKELCREW_AGENT=claude` process test passes. `bun.lock` still names them — Bun
  records every resolution regardless of `peer` — so the lock is unchanged in content.
  Kept `peer = false`; `AGENTS.md` and `MILESTONES.md` now say exactly this. The `ajv`
  `require` strings in `sdk.mjs` are ajv's own bundled code-generation templates, not
  imports.
- **Minor 6** — the shim runs `process.execPath`, not `bun` from `PATH`; the test runs it
  with `PATH=/usr/bin:/bin`.
- **Minor 8** — after `abort()` the loop races the driver's next event against a grace
  timer (`abortGraceMs`, default 5 s); on expiry the run warns and proceeds, and the
  iterator's `return()` is fired without being awaited. Test: a driver that never yields
  again, limit 300 ms, grace 300 ms.
- **Minor 10** — the note reads `allow <tool> <input>? (skelcrew resolve <id> -m allow |
  skelcrew resolve <id> -m deny)`.
- **Minor 11** — the first user message is `Card <id>: <title>` / `Branch: <branch> (from
  <base>)` / blank / body; `code.md` states the numbering rule and says to ask when unsure.

## Review round 2

CHANGES REQUESTED: three Important findings, all taken; Minors 4, 5, 6, 8 taken; Minor 7
carried. Red first (six failing tests: self-move, self-release, owner release, stale
prUrl, two summary windows, the fixed list), then green.

- **Important 1** — (a) the fixed allowlist names the CLI verbs the playbooks use
  (`show`, `comment`, `body`, `refs`, `attention`) instead of `Bash(skelcrew *)`, so `mv`,
  `release`, `claim`, `archive`, and `resolve` ask; (b) a `card_moved`, `released`, or
  `card_archived` whose actor is `runner` during the run sets `selfAction`, aborts the
  driver, and ends as `run failed: the agent moved its own card (to pr)` / `released its
  own card (<reason>)` / `archived its own card` — comment plus request, no handoff, no
  `run abandoned`. Posted through `stopWith`, which tolerates the claim being gone and an
  archived card refusing the request (warned, not thrown). MILESTONES records the rule and
  why.
- **Important 2** — a `released` event by someone other than `runner` that is not the
  core's own release after a move or an archive (`movedAway` is set by the preceding
  `card_moved`/`card_archived` in the same dispatch) sets `releasedBy`; the run ends as
  `run stopped: released by <name>`, comment plus request, so the card waits. A lapse
  still abandons and re-queues; tested with the injected clock and `sweepClaims()`.
  Tests: agent release and owner release each start no second run.
- **Important 3** — the Code contract compares the card's `prUrl` at the run's start with
  the value at its end and requires it present and different; the `refs_set`-by-runner
  check is gone. Tests: stale prUrl plus `--commit` refs fails; a new prUrl passes.
- **Minor 4** — `main.ts` loads the playbooks next to the driver import, inside the same
  try, before the socket opens, with the same `skelcrew daemon: <message>` exit.
- **Minor 5** — `claude.ts` calls `session.close()` from the abort listener as well as the
  iterator's `finally`.
- **Minor 6** — `Agent` and `TodoWrite` are on the fixed list (both are SDK tool names:
  `AgentInput`, `TodoWriteInput` in `sdk-tools.d.ts`). Whether Claude Code still prompts
  for `Agent` under `permissionMode: "default"` is unverified until the first real run.
- **Minor 8** — `summaryMs` is a runner option (default 30 s) passed to the run; test with
  a 100 ms window and a 250 ms gap produces two summary comments.

## Review round 3

CHANGES REQUESTED: two Important findings, both taken; Minors 3, 4, 5 taken (5 is
carry-only). Red first for the two Importants (four failing tests), then green.

- **Important 1** — the Code contract broke the revision loop: `prUrl` was required to be
  present *and* different from its value at the run's start, and nothing ever clears it, so
  a card sent back from PR to Code could never pass again — the agent pushes to the same
  branch, GitHub keeps the same PR, the URL is unchanged, and the run failed with `no prUrl
  ref set during the run` while the work sat correct on the PR. Resolution A, the owner's
  choice: the "must be different" requirement is gone. The contract is commits past the
  base, a clean worktree, and a `prUrl` present; the lazy-run case round 2's Important 3
  guarded against is already caught by the commits. `prUrlBefore` and the comparison are
  removed, the unmet message is now `no prUrl ref set`, and the comment above the check
  states the new rule. Round 2's stale-prUrl test asserted the old rule, so it became its
  own inverse — *the revision loop: a card sent back to Code with its prUrl still on it
  finishes on new commits* — asserting `ready for review: <PR>` with moves `["pr"]` and the
  commits on the refs. The other stale-prUrl test (round 1's "every unmet condition is
  named") only had two conditions because the carried URL was one of them; it now leaves an
  uncommitted file in the worktree instead, so it still names two joined conditions and
  additionally pins that a carried URL satisfies the URL requirement. The no-commits and
  no-prUrl tests are unchanged apart from the message.
- **Important 2** — `Bash(gh pr *)` pre-allowed `gh pr merge` and `gh pr close`: Claude
  Code matches Bash patterns by prefix, and merging is a human-only transition the daemon
  can neither detect nor undo, so playbook prose (`code.md`: "never merge the pull
  request") was the only guard. The fixed list now names the verbs the playbooks use:
  `Bash(gh pr create *)`, `Bash(gh pr view *)`, `Bash(gh pr diff *)`, `Bash(gh pr comment
  *)`. `gh pr create` is the only `gh pr` verb either playbook actually invokes; the other
  three are the read-only companions a review step reaches for, and anything else asks.
  `allowlist.ts`'s header comment now explains the prefix-matching reason next to the
  verb-by-verb CLI rule. Test: a `preAllows` helper mimicking prefix matching shows `gh pr
  create` and `gh pr view` covered, `gh pr merge` and `gh pr close` not.
  **This deviates from the spec**, which names `Bash(gh pr *)` literally (spec line 74).
  The deviation is deliberate: the spec's letter conflicts with a hard constraint in
  `CLAUDE.md` ("'done' is a human's call, the way merging is"), and the constraint wins.
  `docs/MILESTONES.md` records the narrowing and why.
- **Minor 3** — the self-archive branch had no test. Added: the agent runs
  `skelcrew archive` on its own card mid-run; the run posts exactly one `run failed: the
  agent archived its own card`, raises no attention request (an archived card refuses one,
  which `stopWith` tolerates and reports through `warn`), and no second run starts. The
  branch already existed, so this test is coverage, not red-then-green; it was checked
  against a deliberately disabled `selfAction ??= "archived its own card"`, where it fails
  with `run failed: the agent released its own card (archived)` — the archive-specific path
  is what it pins.
- **Minor 4** — `AgentRunOptions.prompt` was dead: `run.ts` also pushed the card as the
  first item of `input`, and `claude.ts` reads only `input`, so a second driver written
  against the interface would have sent the card twice. `prompt` is dropped; the `input`
  doc comment now states the rule ("the card first, then every card comment … sent here and
  nowhere else"). The test that asserted `runs[i].prompt` now reads the first message off
  each run's `input` and asserts both runs got the card there. This is a refactor with
  existing coverage rather than a red-then-green change: the test was pointed at the
  surviving path first and stayed green, then the field was removed and `tsc` confirmed
  nothing else read it.
- **Minor 5** — carry only, as instructed: `SKELCREW_AS=runner` is unscoped, so a run on
  card 1 can write to card 7 attributed to `runner`, kept on its own card by playbook text
  alone. Not fixed here — the daemon has no scoped-identity primitive and 007 did not ask
  for one. Recorded in `docs/MILESTONES.md` as a carried finding for the milestone that
  gives a run a claim-bound identity.

## Review round 4

CHANGES REQUESTED: two Important findings, both taken; Minors 1–5 taken. Red first for the
two Importants and for Minors 4 and 5 (five failing tests); Minor 3 is coverage of existing
code, checked against a deliberately broken translation.

- **Important 1** — the Code contract no longer accepted an artefact an earlier run had
  earned. Round 3 removed "set during the run" along with round 2's "must be different", so
  a card sent back from PR whose agent did nothing still passed: `git rev-list
  <base>..<branch>` returns the previous run's commits, the worktree is clean, the carried
  `prUrl` is on the refs, and the card was handed on with `ready for review: <url>` — the
  spike's "ready for review on a branch with no commits", reappearing on the revision path.
  The reviewer's fix (a) is taken: the contract now also needs a `refs_set` by `runner`
  between the run's start seq and its end whose refs carry a `prUrl`, with no requirement
  that the value changed, so a revision run that re-records the same URL passes. `since`,
  already computed for the Spec contract, is what it reads; the unmet message is `no prUrl
  ref set during the run` again. **The `refs_set` payload is the merged refs, not the keys
  the call set** (`core.ts`: `log(id, actorId, { type: "refs_set", data: { refs: merged }
  })`), so "carrying a `prUrl`" is checkable but "the call set `prUrl`" is not: a run that
  records only `--commit` while a URL sits on the card satisfies it too. That residue is
  narrower than fix (b)'s cost — (b) would fail a revision run that legitimately produces no
  new commit — so (a) stands and `docs/MILESTONES.md` records both the rule and the residue
  for the milestone that could make the core record which keys were set. Tests: a card run
  through Code once (commits, PR recorded, `finished`), moved to PR and back to Code, whose
  second run does nothing, fails with that message and stays in Code — it released
  `finished` before the fix; round 3's revision-loop test now has the agent re-record the
  same URL, as `code.md` tells it to; round 1's "every unmet condition" test now names three
  conditions, since a URL carried onto the card by the owner is no longer one this run set.
  The false justification in the comment above the check and in `docs/MILESTONES.md` — that
  a run which did nothing is caught by the commits — is gone; it was only ever true of a
  card's first Code run.
- **Important 2** — `Bash(git *)` pre-allowed `git push origin HEAD:main`, which lands work
  on the default branch with no prompt (the same human-only transition `gh pr merge` is),
  and `git -c <anything> log`, which runs arbitrary commands through git's own options. The
  fixed list now names the verbs the playbooks use — `status`, `log`, `diff`, `show`,
  `merge-base`, `rev-parse`, `branch`, `add`, `commit` — plus push in exactly the two forms
  `code.md` needs: `Bash(git push -u origin HEAD)` and `Bash(git push)`, both without a
  wildcard, so any other refspec or a force push asks. **This is the second deliberate
  deviation from the spec**, which names `Bash(git *)` (spec line 74); the owner chose it,
  for the same reason as round 3's `gh pr` narrowing, and `docs/MILESTONES.md` records both
  narrowings together and what they actually cover: what the agent may do *unprompted*.
  Everything narrowed is still available by asking the owner, and a bare `git push` under a
  repo-level `push.default = matching` could still push more than the card's branch.
  One consequence the tests caught: the fenced-block scan re-added `Bash(git *)` from a
  target repo whose instructions show `git status` in a fence, undoing the narrowing, so the
  scan now skips the commands the fixed list narrows on purpose (`skelcrew`, `git`, `gh`);
  the existing "a token already covered is not repeated" test is what failed, and it holds
  unchanged. Test: `git push origin HEAD:main`, `git push --force`, and `git -c foo=bar log`
  are not pre-allowed; `git status`, `git status --short`, `git commit -m "…"`, `git diff
  main...HEAD`, and `git push -u origin HEAD` are.
- **Minor 1** — the matching rule is stated correctly now, in `allowlist.ts`, the test's
  `preAllows`, and `docs/MILESTONES.md`: `Bash(x *)` is wildcard matching — Claude Code
  builds an anchored regular expression with `*` as `.*` and a single trailing ` *` as
  `( .*)?`, so `Bash(git status *)` covers `git status` and `git status --short` and nothing
  that merely begins with those letters, and a rule with no `*` matches exactly. `Bash(x:*)`
  is the legacy prefix form. `preAllows` now models that regex instead of `startsWith`; every
  assertion it already carried still holds.
- **Minor 2** — `code.md` Stage 5 has the revision path: when the branch already has an open
  pull request `gh pr create` fails, so the URL is read with `gh pr view --json url`, and
  `skelcrew refs <id> --pr <url>` is run on every run, including one where the URL has not
  changed. With Important 1 in place this is load-bearing: nothing recorded, no handoff.
- **Minor 3** — `toEvents` has a table test over the message kinds it handles: an assistant
  turn with thinking, text, an empty text block and two `tool_use` blocks; a `tool_result`
  as a string and as blocks with `is_error`; a success result, a success result with
  `is_error`, an `error_max_turns` with `errors`, an `error_during_execution` without; a
  system message and a message whose content is not blocks. It is a pure function over
  message literals — nothing is spawned and no model is called; the type-level conformance
  check stays alongside it. This is coverage of code that already existed, not red-then-green:
  its teeth were checked by dropping the empty-text guard and the `is_error` branch, where it
  fails, before restoring them.
- **Minor 4** — the abort grace timer is armed when the signal has already fired. `onStop()`
  aborts before the `graceExpired` listener is registered, so a run that started while the
  daemon was stopping had nothing to end it: a driver ignoring its own signal left
  `Promise.race([events.next(), graceExpired])` unsettled, and `stop()` — which `main.ts`
  awaits on SIGTERM — never returned. Test: a `Git` whose `worktreeAdd` waits on a gate, so
  `stop()` lands while the run is between git steps, and a driver that never yields; `stop()`
  resolves and the card carries `run aborted: daemon stopping`. Before the fix the race
  reported `hung` and the `afterEach` hook timed out with it.
- **Minor 5** — pending tool summaries are flushed on the two paths that return early: the
  agent moving, releasing, or archiving its own card, and the owner taking the card back.
  The claim is gone on both, so the flush goes through `say` (a comment that lands whether or
  not the claim survived, warning if the card refuses it) rather than `post`, exactly as the
  `stopWith` comment beside it already did. Test: the agent runs one tool, the owner releases
  the card, and the card shows `ran 1 tool: Read` before `run stopped: released by simon`.

## External review (Codex)

Two findings on the pushed branch, both real against the code, both taken. Red first for the
first (three failing tests); the second is documentation, so it has no red phase.

- **Finding 1** — the success path discarded an unresolved blocker. Round 1's Important 1
  taught `fail()` not to clobber a question the agent raised (`open === null || isOwn(open)`);
  `finish()` never learned it. An agent that writes the card's body, then finds a genuine
  conflict and raises it with `skelcrew attention <id> "<question>"`, then ends its session
  normally, satisfies the Spec contract — so `finish("spec ready", ["code"])` replaced the
  question with `spec ready` and offered the owner an approval into Code over a question they
  had never seen. The Code path is reachable the same way: nothing clears an open request, so
  an agent that commits, pushes, records the PR, and then asks a question still passes the
  contract and reached the same `finish`. The red run showed it exactly — two
  `attention_requested` events after the move, the second the runner's, and the release
  `finished` where the test expected `blocked`.
  The fix mirrors `fail()`: when the card's open request is not the run's own, `finish()`
  posts the artefact as a comment — `spec ready; not handed on while the agent's question is
  open — answering it runs the phase again`, and the same suffix after `ready for review:
  <url>` — raises nothing, and releases with reason **`blocked`**. `finished` would say the
  phase was handed on and `failed` would say the artefact was not earned; neither is true, so
  the reason is its own word. The Code path still writes `commits` to the refs before the
  release: the artefact and its references are on the card, only the handoff is withheld.
  **What the owner sees**: the card is in its phase with no claim, its attention request is
  the agent's question with no moves (so `mv`-by-approval is not among the resolving
  choices), and the last comment says the artefact landed and why the card stopped there.
  **What happens after they answer**: `runner.ts`'s `isReady` requires `card.attention ===
  null`, so the card sits out of the queue while the question stands, and answering it
  (`skelcrew resolve <id> -m "<answer>"`) makes the card ready again — the runner claims it
  and the phase runs **afresh** in the same worktree, with the answer on the card as a comment
  for the new run's `skelcrew show <id>`. It does not resume, and it does not advance: a
  fresh run has to satisfy the contract again before the owner is offered anything. Resolving
  by moving the card is still the owner's other exit. Tests: a spec run and a code run where
  the agent raises its own question and finishes successfully (the question survives, the
  artefact is a comment, exactly one request after the move, release `blocked`), and a third
  that answers the question and asserts the second run happens and hands the card on with
  `spec ready` / moves `["code"]`. **This deviates from the spec**, which gives the Spec and
  Code contracts one success shape each (`attention … moves … release finished`); the
  deviation is the same one round 1 made on the failure path, for the constraint that
  attention requests are first-class and that what an agent does is visible on its card.
  `docs/MILESTONES.md` now records the whole rule in one place instead of the failure half.
- **Finding 2** — `code.md` Stage 1 step 6 mishandled a revision run. The branch a card sent
  back from PR returns to already carries the spec this card committed on its first run, so
  a card that names its number hit "the card names a number that is already taken … do not
  guess: ask … and stop" — its own spec deadlocking the revision loop — and a card that names
  none allocated the next free number and committed a duplicate. Stage 5 step 4 had been
  taught about revision runs in round 4; Stage 1 had not. The step now looks for this card's
  spec under `docs/specs/` first — a file whose number the card names or whose content is
  this card's spec is done, left alone — and only a number belonging to a *different* spec is
  a collision worth stopping for. "Do not edit it" is untouched: reusing means leaving the
  committed file alone. No test asserts this prose (the playbook tests assert non-emptiness
  and `skelcrew attention`), so nothing needed updating; `bun run check` is green.

### Round 2

Two more findings on the branch, both real against the code, both taken. The first is
documentation and has no red phase — said plainly rather than dressed up as one; the second
is red first (one failing test).

- **Finding 1 — a stale spec survived an approved revision, and the regression was `ce6da7a`'s
  own wording.** Round 1 of this external review taught `code.md` Stage 1 step 6 to reuse a
  spec an earlier run of the same card had already committed, so a revision run would not
  deadlock on its own file. The wording it chose — "a file whose number the card names, **or**
  whose content is this card's spec, is done — leave it alone and go on" — made a match on the
  *number alone* sufficient. That is exactly the revision path `AGENTS.md` supports: a Code
  card goes back to Spec, the owner approves a revised body, the card returns to Code, and the
  next run finds `docs/specs/<NNN>-<name>.md` by number, calls it done, and leaves the old text
  committed. The PR then ships the previous specification while the card carries the approved
  one, silently. The fix that caused it is worth recording as such, not smoothed over: the
  deadlock was real and the reuse rule is right, but "or" made the number a sufficient
  condition where it is only an identifier.
  Step 6 now names the file by number (or, when the card names none, by content), then **reads
  it and compares it with the card's body before treating it as done**: identical means done,
  leave it alone; different means the card was revised after that run, so the card's body is
  written over the file verbatim — same number, same name — and committed as the first commit,
  the way a fresh one would be. `Do not edit it` stays and is now unambiguous about what it
  forbids ("the committed file says what the card says, and a spec that is wrong is raised
  (Stage 6), never reworded to suit the code") and about what it does not ("bringing the file
  back into line with the card is not the editing this step forbids — the file follows the
  card, never the card the file"). What `ce6da7a` fixed is preserved: a number the card names
  is still this card's spec and never a collision, so no deadlock and no duplicate number; only
  a number belonging to a *different* spec, or a number that cannot be told, still stops the
  run with `skelcrew attention`. No test asserts this prose (the playbook assertions are
  non-emptiness and `skelcrew attention`), so nothing needed updating.
- **Finding 2 — two runs of one card in the same second destroyed the first run's log.**
  `runLogPath` dropped the milliseconds (`.replace(/\.\d{3}Z$/, "Z")`), so the stamp had
  one-second resolution, and `runPlaybook` opened the file with `writeFileSync(logPath, "")` —
  a truncation. A run that failed fast and was re-claimed within the second wrote over the
  transcript the first run's `run log at <path>` comment still points at, which is a silent
  loss of the record `AGENTS.md`'s "everything observable" says must be there.
  **Mechanism chosen: exclusive create with a `-<nth>` on collision, not finer resolution.**
  A new `createRunLog(dataDir, cardId, startedAt)` makes `runs/`, then tries
  `<id>-<stamp>.jsonl` with `writeFileSync(path, "", { flag: "wx" })` and, on `EEXIST`, the
  next free `<id>-<stamp>-2.jsonl`, `-3`, …, returning the path it actually created.
  `runner.ts` calls it where it used to build a name, so the path it announces on the card is
  the one it opened; `runPlaybook` no longer creates or truncates anything and only appends.
  Milliseconds were rejected as the mechanism: they narrow the window without closing it and
  leave the truncation in place, and they cost readability in the name for nothing the
  exclusive create does not already give. `runLogPath` stays exported as the name builder with
  an `nth` parameter (default 1, so every existing name is unchanged) and a doc comment saying
  the stamp is second-resolution and `createRunLog` is what picks the suffix.
  **Red evidence**: a new test runs one Spec card twice on a frozen clock (`now: () => frozen`,
  the runner's injected clock, so both runs start at one instant) — the agent raises a question
  on the first run and finishes, the owner answers, the phase runs again — and reads the log
  paths off the card's own comments. Before the fix:
  `expect(received).not.toBe(expected) / Expected: not ".../data/runs/1-20200101T000000Z.jsonl"`
  — both runs announced the same path. After it the two paths differ and each file still holds
  its own run's events. Callers and existing assertions were kept, not loosened: `run.test.ts`'s
  `run log at <dataDir>/runs/1-` assertion holds unchanged, and its `runLogPath(cardId)` helper
  still insists the path is in the card's *first* comment; the new `runLogPaths` helper reads
  all of them alongside it.

### Round 3

Four findings on the branch (`docs/plans/007-runner-runs-playbooks-conformance-review.md`,
committed here as the external review record); the first two are one defect and were taken
as one. Red first for that one and for the transcript; the playbook fix is documentation and
has no red phase, said plainly rather than dressed up as one. Three commits, one per item, so
the red-before-green order is in the branch history and not only in this file.

- **Findings 1 and 2 — the attention invariant was hand-copied, so two of five raises did not
  have it.** Round 1 taught `fail()` not to clobber a question the agent raised
  (`open === null || isOwn(open)`); external round 1 taught `finish()` the same; `stopWith()`
  and `runner.ts`'s outer catch were never taught it, and neither would the sixth site be.
  Codex injected a rejecting `git.revList()` during Code contract verification and got the
  agent's `Which schema is correct?` replaced by `run playbook failed: git unavailable during
  verification` — the exception escapes `runPlaybook` and never reaches its guarded `fail()`.
  **Mechanism: one helper, not the core.** The core route — `requestAttention` refusing to
  replace an open request raised by a *different* member — was surveyed and rejected on
  evidence, not on cost: the agent's `skelcrew attention` runs under `SKELCREW_AS=runner`, so
  its question is raised by the **same** member as the run's own requests
  (`run.test.ts`'s `askOwner` uses `runnerMember.id` for exactly that reason). "A different
  member" cannot tell the agent's question from the runner's own note; only the run can, from
  what the core recorded for its own request (`raisedAt`, `note`, `raisedBy`). A core rule
  would therefore have been the wrong rule, whatever its architectural appeal — so
  `runner/attention.ts` holds it instead: `raiseAttention(core, id, request, actor, mine?)`
  raises unless a request the caller did not raise for itself is open, and returns `undefined`
  when it declines, which each caller reports its own way (`fail` says nothing more, `finish`
  posts the artefact and releases `blocked`, `stopWith` leaves its comment, `runner.ts`
  releases `failed`). All five raises go through it and nothing under `runner/` calls
  `core.requestAttention` any more; `raiseNext`'s hand-written `attention !== null` check and
  the two copies of the guard are gone into it. `raiseNext` now peeks at the head of the queue
  and only shifts once the raise succeeded, which keeps round 1's queueing behaviour exactly.
  Also taken: `releasedBy` ignored a move that followed the release, so an owner who released
  a card and then moved it got `run stopped: released by simon` on a card already in Idea.
  `card_moved` and `card_archived` now clear `releasedBy`, so the move supersedes it and the
  run abandons and leaves the new card state alone — which is what the `!movedAway` condition
  already intended for the other order. `selfAction` is deliberately not cleared the same way:
  round 2 designed it to speak on a card the agent itself moved, and the finding did not name
  it.
  **Red**, three tests: `expect(received).toMatchObject(expected)` /
  `- "note": "Which schema is correct?"` / `+ "note": "run playbook failed: git unavailable
  during verification"` for the git exception, the same with
  `+ "note": "run failed: the agent released its own card (done, I think)"` for `stopWith`,
  and for release-then-move `no matching event within 2000 ms; saw … 1:released 1:card_moved
  1:comment 1:attention_requested 1:comment` — the run stopped instead of abandoning.
- **Finding 3 — the run log was the display projection, not the stream.** `toEvents` ends in
  `default: return []` and `run.ts` wrote the log from events, so an SDK `system/init`, a
  plain user message and a thinking-only assistant turn reached the log not at all, while a
  turn with several recognised blocks was written once per event through its `raw`. This
  file's own "so the transcript holds the full stream" was false and is corrected above;
  `docs/MILESTONES.md`'s "every driver event is a JSON line" is corrected too.
  **Mechanism: a `log` callback on `AgentRunOptions`, and the driver writes.** `agent.ts`
  already said the transcript is the driver's business; the run owns the file
  (`log: (entry) => appendLog(logPath, entry)`), the driver owns what goes in it. `claude.ts`
  gains `drive(messages, log)` — log the message, then yield what the card shows of it, and
  return at the first result — which is also the first thing in that file testable without a
  spawn. `AgentEvent` keeps its four kinds and loses `raw`: it existed only to carry the
  transcript, and the union is now what the spec describes. The card's display is untouched.
  The scripted test driver logs each event it yields, as the real one logs each message it
  receives, so every existing run-log assertion holds verbatim.
  **Red**: a new `claude.test.ts` test drives `[system/init, plain user, thinking-only,
  two-block turn, result, one more]` and expects the first five in the log —
  `expect(received).toEqual(expected)` with `- { "subtype": "init", … "type": "system" }`
  received as `+ { "raw": { … }, "text": "Reading the card.", "type": "text" }`: three
  messages missing and the one turn present twice. The table test at `claude.test.ts:27` was
  fixed rather than kept: it still asserts that the system message and a message whose content
  is not blocks produce no *display* event, and now also that both are in the transcript.
- **Finding 4 — an unnumbered card lost its committed spec across a revision.** `code.md`
  step 6 re-derived the file every run, by number or by content; a card with no number whose
  approved text changed matches neither, so the refresh branch was unreachable and the
  fallback allocated a second number. **Mechanism: record it, do not re-derive it.**
  `skelcrew refs` carries `branch`, `commits`, and `prUrl` and has no key for a path, and
  adding one is more core and CLI surface than this finding warrants — so the run posts
  `spec committed: <path>` on the card and the next run reads it back from `skelcrew show
  <id>`, which is only what exists today and is what "everything an agent does is visible on
  its card" asks for anyway. The step is now three named parts — which file, what to write,
  record the path — with number and content demoted to fallbacks for a card whose spec
  predates the record, and every identified file compared against the card's body rather than
  declared done, which is what keeps the revision loop from deadlocking and from duplicating.
  `Do not edit it` is unchanged. **No red phase**: it is playbook prose, and the playbook
  tests assert non-emptiness and `skelcrew attention` only. Nothing here was verified by
  spawning a model.
- **Not taken: amending the spec.** Codex asked for `code.md`'s three-round review budget
  (`:101`, `:118`) to be reconciled by clarifying the specification. `AGENTS.md` forbids
  editing an approved spec — it is the only record of what was intended — so the spec and the
  playbook are both left alone and the tension is recorded in `docs/MILESTONES.md` as a note
  for 008, which distinguishes the playbook's in-session bound from the runner-managed cycle
  machinery 007 defers.

`bun run check`: green, 354 tests.

### Round 4

Two findings (`docs/plans/007-runner-runs-playbooks-conformance-review-2.md`, committed here
as the external review record), both implementation defects, both real against the code, both
taken. Red first for each, one commit per finding, F2 first because it is the smaller.

- **Finding 2 — a tag named after the base branch let a Code run with no work pass the
  artefact contract.** The gate built its range from short names,
  `revList(repoRoot, "<base>..<branch>", …)`, and git resolves a bare name by precedence:
  `refs/tags/<name>` outranks `refs/heads/<name>`. In a repository that tags a release with
  its branch's name — the tag `main` a commit behind the branch `main` —
  `rev-list main..skelcrew/1-x` counts the base branch's own commits as this branch's work
  (git says `warning: refname 'main' is ambiguous` and carries on), so a run that committed
  nothing was handed on with `ready for review: <url>`, moves `["pr"]` and release `finished`.
  That is precisely the spike finding this milestone exists to close — "the daemon posted
  ready for review on a branch with no commits" — reachable in any repo that tags releases
  after their branch.
  **Mechanism chosen: qualify both ends of the range, not resolve both to shas.**
  `refs/heads/<base>..refs/heads/<branch>` is what `defaultBranch` already uses to find the
  base (`git.ts`) and what `runner.ts` already uses to ask whether the card's branch exists,
  so the gate stops being the one place that discards that protection; and it keeps the
  range's meaning unchanged (the base branch's current head, not the sha the branch forked
  from, so work merged into the base during the run still does not count as this run's).
  Both ends, because a tag colliding with the card's branch name must not shift that side
  either. Resolving each end through `revParse` was the alternative: it gives the same answer
  and costs two more git calls and a second failure mode to report. The rest of the runner was
  checked for the same class: `revList` was the only bare name. `git worktree add <path>
  <branch>` looks ambiguous and is not — with the branch present git attaches
  `refs/heads/<branch>` even when a tag shadows it, while the qualified form detaches HEAD, so
  qualifying there would have broken it (checked against git 2.48.1 in a scratch repository,
  both ways). `git.ts` now says on `revList` that the ends of the range are the caller's to
  spell unambiguously.
  **Red**: a Code card in a repository where `git tag main` sits one commit behind branch
  `main`, with a driver that records a PR and commits nothing, never released `failed` —
  `no matching event within 2000 ms; saw 1:card_created 1:card_moved 1:claimed 1:refs_set
  1:comment 1:refs_set 1:refs_set 1:attention_requested 1:released` — the second `refs_set`
  is the runner writing commits onto the refs and the request is the handoff. Green, it fails
  with `run finished with no commits on skelcrew/1-tagged-base past main`. The repository
  shape is the test, not a unit test of range forwarding: `run.test.ts`'s no-commits case and
  `git.test.ts`'s range case both use unambiguous names and cannot see this.
- **Finding 1 — a new claim did not supersede the release it followed.** The event switch
  kept three flags (`selfAction`, `movedAway`, `releasedBy`) and the completion path chose
  from them. There was no `claimed` case, so an owner who released a running card and
  immediately claimed it — both calls legitimate, no move involved — left `releasedBy` set,
  and the old run posted `run stopped: released by simon` plus an attention request onto a
  card the owner now holds. The spec carries "a run must never write to a card whose claim it
  has lost" forward from 006.
  **Mechanism chosen: re-derive the ending from the card, not another case in the switch.**
  `case "claimed"` would have been the fourth incremental patch to this mechanism — round 3
  had just added the `card_moved`/`card_archived` clears for the same shape — and the fifth
  event kind would have been forgotten the same way; this is the "enforced by convention at
  each site" failure the attention helper was introduced to cure, one mechanism over. So the
  flags no longer decide anything. At completion the run reads the card and asks who holds
  the claim and where the card is: **the claim still this run's** is the contract path;
  **free, unarchived, still in this phase and never away during the run** is the owner's exit
  ramp, reported as `run stopped: released by <name>` so the card waits rather than being
  re-dispatched at once; **anything else** — a claim by another member, a move, an archive, a
  lapse — is an abandonment, the runner's one comment and nothing more. The recorded events
  supply the *reason* (`releasedBy` is now only the name to report, with the supersession
  clears gone from `card_moved` and `card_archived`), never the *decision*. The structural
  point is the inversion: the write now needs the card itself to say the card is free and
  still here, so an event kind nobody taught this switch about can no longer end in a stale
  write — it can only fall through to the safe outcome.
  **`selfAction` is deliberately outside the derivation**, as this record has it above: what
  this run's own agent did is the one question the card cannot answer, because the state the
  card is in is the agent's own doing rather than evidence about who owns it. An agent that
  moved, released, or archived its own card is still reported on wherever the card ended up —
  the accountability record round 2 designed and round 3 kept. `movedAway` survives too, but
  no longer as supersession: it says the card left this phase at some point during the run,
  which the card's current phase cannot show for a card moved away and back, and it can only
  ever suppress a write, never cause one.
  **Red**: with the owner releasing and immediately claiming mid-run, `no matching event
  within 2000 ms; saw … 1:released 1:claimed 1:comment 1:attention_requested` — the run wrote
  its stop and its request onto the owner's card instead of abandoning. Green, the same test
  sees `run abandoned: claim lost to member 1; card is in spec`, the owner's claim standing
  and no attention request. Everything the old behaviour got right still holds and its tests
  are unchanged: the plain owner release still stops the run with its comment and request
  ("the owner releasing a running card…"), release-then-move still abandons, a lapse still
  abandons and re-queues, the agent's own hand still fails the run on all three of its paths,
  and the pending tool-summary window still lands on the stop paths ("the last window of tool
  activity…"). Release-then-archive was added beside them and passes before and after the
  change: it pins behaviour the re-derivation had to preserve, and is written up as a
  preservation test rather than dressed up as a red one.
  `docs/MILESTONES.md` records this as the fourth instance of the half-fix pattern and the
  rule it teaches: wherever it recurs the cure is construction, not vigilance.

`bun run check`: green, 357 tests.

### Round 5

Two findings (`docs/plans/007-runner-runs-playbooks-conformance-review-3.md`, committed at
`aab1f22` as the external review record), both real against the code, both taken and now
resolved. Red first for F1; F2 is playbook prose and has no red phase, said plainly rather
than dressed up as one. One commit per finding.

- **Finding 1 — accountability also raised attention on a card someone else had taken over.**
  Round 4 put `selfAction` deliberately outside the card-derived ending: what this run's own
  agent did is the one question the card cannot answer, so an agent that moved, released, or
  archived its own card is reported wherever the card ended up. That record is right and
  stays. What was wrong is that it was two effects and not one: `stopWith` posted the comment
  **and** raised an attention request, so an owner who claimed the card between the agent's
  own release and the end of the abort found the old run's failure in their queue — the same
  stale write to a card whose claim the run has lost that the card-derived path had just been
  built to prevent, reached through the branch that runs before the card is read.
  **Mechanism: split the two effects, not the branch.** The comment is the record of what
  happened, which the card is owed either way; a request is a claim on a member's queue,
  which a run that no longer holds the card has no standing to make. `stopWith(note, raise)`
  always comments and raises only when asked, and the `selfAction` branch reads the card for
  the one thing it *can* answer — whose claim it is now — and raises unless another member
  holds it. Preventing an immediate re-dispatch is what the request was for, and the new
  holder's claim already does that. Nothing else moved: the owner's release still stops the
  run with its comment and its request, and the archived card still gets the raise attempted,
  refused by the core, and warned about in the runner's log, which is why that test's
  `could not say so` warning still stands. The three plain self-action tests are unchanged
  and pass.
  **Red**, two tests — the twins the review asked for, one per self-action that leaves a
  claimable card: the agent releases its own card and the owner claims it at once, and the
  agent moves its own card out of Code and the owner claims it in Spec. Both failed on
  `expect(received).toBeNull()` for `card.attention`, receiving
  `{ to: 1, note: "run failed: the agent released its own card (done, I think)", moves: [],
  raisedBy: 2 }` and the same with `"run failed: the agent moved its own card (to spec)"` —
  the comment had already landed, so what the assertions caught is exactly the second effect.
  Green, each card carries the failure comment, no `attention_requested` event at all, and
  the owner's claim standing.
- **Finding 2 — the Code playbook computed its review base from a bare name.** Stage 1 step 5
  said `git merge-base HEAD <base branch>`, and Stages 3, 4 and 5 diff against the sha it
  returns. That is round 4's F2 one file over: `refs/tags/<name>` outranks `refs/heads/<name>`,
  so a repository that tags a release with its branch's name hands the reviewer and the
  verifier the base branch's own work as this card's. Reproduced with the playbook's own
  commands — branch `main` at A → B, the tag `main` at A, a card branch forking at B and
  adding one file: the bare name gives A and `git diff <base>...HEAD` shows
  `base.ts feature.ts`, qualified it gives B and shows `feature.ts`. The step now says
  `git merge-base HEAD refs/heads/<base branch>`, says why, and says that `<base>` in every
  diff below is that sha and never a name; Stage 4 now hands its subagent the base sha the
  way Stage 3 already did. `git worktree add <path> <branch>` in `git.ts` stays unqualified
  on purpose and was left alone — with the branch present git attaches `refs/heads/<branch>`
  even when a tag shadows it, while the qualified form detaches HEAD. No test asserts this
  prose (the playbook tests assert non-emptiness and `skelcrew attention`), and nothing here
  was verified by spawning a model.

`bun run check`: green, 359 tests.
