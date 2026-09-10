# 007 — Conformance review, follow-up

Reviewed 2026-09-10 at `e3087c3605fc2fb379eb07be6fc5ffbf33750a73`, branch
`worktree-runner-playbooks`, against `main`, using `git diff main...HEAD`.

**Verdict: CHANGES REQUESTED.** The four previously reported cases are fixed. Two
Important implementation defects remain: release followed by a new claim produces stale
attention, and an ambiguous Git reference can approve a Code run that made no commits.
The committed suite passes: **354 tests, 0 failures**, plus lint and typecheck.

This is a specification-conformance review, not a general code review. I read the complete
specification first, including Desired behavior, all fourteen acceptance criteria, and Out
of scope; then the repository constraints, the complete run record and previous review,
and every changed/new file in the branch diff, including the lockfile. Paths and line
numbers below refer to the reviewed commit. The previous review is unchanged.

## 1. Verification of the four follow-up commits

### 4893b71 — Shared attention rule and release supersession

**The original cases are fixed; a neighboring ownership transition is still wrong.**

`packages/daemon/src/runner/attention.ts:26` implements one synchronous read-and-raise
operation: preserve an open request unless the caller identifies it as its own replaceable
request. All production attention raises under `runner/` now use it. This covers queued
permissions, ordinary failure, successful completion, `stopWith`, the no-driver handoff,
and the outer exception handler. The helper itself is the only production direct call to
`core.requestAttention` in that directory.

The decision against an actor-ID rule in the core is correct. Agent CLI questions and
orchestrator notes both come from the `runner` member. Equality of member IDs cannot
distinguish them. The run tracks the particular permission request it owns; ordinary
agent questions must survive even though their `raisedBy` is also `runner`. Keeping that
knowledge at the runner boundary preserves the shared member-facing core API.

The helper's conservative default is appropriate: without proof of ownership, it keeps
the existing question. It does not, and should not be mistaken for something that does,
validate whether the run still owns the card.

Evidence:

- `run.test.ts:1334` makes `revList` reject during Code verification and asserts the
  agent's question remains, the error is commented, and the claim is released as failed.
- `run.test.ts:1358` covers the previously unguarded `stopWith` path after an agent release.
- `run.test.ts:1379` covers owner release followed by a move. Both `card_moved` and
  `card_archived` clear `releasedBy` at `run.ts:395` and `run.ts:401`.
- Additional review probes passed for release followed by archive, owner release with an
  agent question already open, and `status` throwing instead of `revList` throwing.
- Release followed by a **new claim** fails. See finding F1 below.

The deliberate persistence of `selfAction` is a separate policy: report that the agent
bypassed its gate even if a later move occurs. The record explicitly retains that policy
at `docs/plans/007-runner-runs-playbooks.md:439`. I accept that accountability exception;
F1 concerns an owner taking over without any agent self-action.

### 18a3302 — Transcript at the driver boundary

**Fixed, with the display projection unchanged.**

`claude.ts:90` consumes the SDK stream once. At `claude.ts:98`, it logs the complete
message before converting it into display events. Zero display events therefore lose no
transcript entry, and multiple display events duplicate no transcript entry. Arrival order
is preserved. `claude.ts:140` passes the actual run callback to this function;
`run.ts:458` connects that callback to the JSONL append operation at `run.ts:233`.

This applies through the first terminal result, which ends the session. The driver does
not promise to consume hypothetical later sessions from the streaming-input iterator;
ending at the first result is unchanged behavior, and the specification describes a final
result. A thrown stream retains the messages already consumed.

I compared `toEvents` before and after the commit: its text, tool-use, tool-result, success,
and error projections remain the same, apart from removing the unused `raw` property.
System messages, plain user messages, and thinking-only messages still display nothing.
Existing text-block boundaries are also unchanged.

`claude.test.ts:31` checks exact ordered transcript equality for displayless and multi-block
messages. `claude.test.ts:69` separately checks the display mapping. The fake's logging at
`run.test.ts:107` implements the new driver responsibility; it does not write expected
contents directly to a file or replace the runner's callback. Existing assertions still
read real JSONL files and compare their entries, including two distinct runs in the same
second (`run.test.ts:1295`). They would fail if the callback stopped appending.

I additionally connected the real `drive` function to a fake SDK stream through the real
runner and file callback. A system message, thinking-only message, multi-block assistant
message, plain user message, and result appeared in the file exactly once, in order; the
two text blocks appeared as the same two card comments. This probe passed without
spawning Claude Code.

### fa26fd9 — Durable association between the card and its committed spec

**The reported revision defect is fixed in the playbook.**

`packages/daemon/playbooks/code.md:36` now first selects the newest
`spec committed: <path>` comment, and step 6 requires recording that path on every run
(`code.md:49`). Number and content matching are fallbacks. `skelcrew show` exposes the
full activity, including those comments (`packages/cli/src/render.ts:179`); replacing the
card body does not replace its activity.

I traced the revision cases through these instructions and the existing card/branch
lifecycle:

| Case | Result required by the current playbook |
| --- | --- |
| New numbered card | Use its number, checking that any existing file is this spec; commit the verbatim body and record the path. |
| New unnumbered card | Allocate the next free number when no existing match is identifiable, then record the chosen path. |
| Later run, same body | Read the recorded path, leave identical content alone, record the path again. |
| Later run, changed body, including an unnumbered card | Read the recorded path independently of the new text; overwrite that same file with the approved body and commit it. No duplicate spec is needed. |
| Recorded path no longer exists | Recreate that same path from the body under the explicit “not there yet” rule. |
| No recorded path, existing legacy spec | Use content/number fallbacks; an ambiguous association must raise a question instead of guessing. |

The Code revision ship path still reuses the existing PR and records its URL again
(`code.md:137`); the runner tests pin same-URL acceptance and rejection when nothing is
recorded (`run.test.ts:1048`, `run.test.ts:1073`).

These are executable instructions for the coding agent, not a deterministic spec-file
writer in the daemon. There is no automated test that executes this markdown revision
workflow. The record correctly calls this a documentation change without a red phase.
The durable marker fixes the specified ordinary sequence; it is not an atomic transaction
between a Git commit and its later card comment. Interrupted legacy cases still depend on
the stated fallbacks and escalation.

### e3087c3 — Previous review and external round 3

**The prior review is preserved, and the corrective decisions are recorded.** The record
explicitly retracts its old claim that `raw` made a full transcript, explains the shared
helper and rejected core alternative, records `selfAction`, and describes the durable spec
path. I found no hidden runtime change in this documentation commit.

One evidentiary qualification: `docs/plans/007-runner-runs-playbooks.md:409` says the
red-before-green order is in the branch history. The fix commits bundle tests and their
implementations. That history establishes the changes, not the order in which tests were
run locally. I treat the recorded red runs as testimony, not independent proof of execution
order. This review independently establishes the current behavior.

## 2. Every numbered acceptance criterion

In the table, runner source/test paths are relative to
`packages/daemon/src/runner/`. “Met” includes the justified interpretations discussed
below; it does not claim that a mocked test proves a real coding agent will obey a playbook.

| AC | Judgment | Implementation and test evidence |
| --- | --- | --- |
| **1** | **Met with the agreed external-dependency interpretation.** | `packages/daemon/package.json` adds only the external harness SDK and retains the workspace link. `bunfig.toml` disables peer installation. `main.ts:40` loads the driver only when selected. Scripted drivers exercise runs; process tests default to `none`. Independently ran `bun run check`: exit 0, lint/typecheck pass, 354 tests pass. The Claude startup process test has no card and spawns no coding agent. |
| **2** | **Met.** | `runner.ts:299` announces the log before the driver; `run.ts:458` supplies the file logger, the event loop posts text, and `run.ts:584` checks a runner-authored body write during this run before the Spec finish. `run.test.ts:223` asserts the claim, first comment, both text comments, exact log, attention/moves and release. `claude.test.ts:31` and the additional boundary-to-file probe establish complete raw SDK logging. |
| **3** | **Met.** | `run.ts:584` requires a body-set event and nonblank current body, otherwise calls `fail`. `run.test.ts:270` pins the exact failure comment, attention without moves, failed release and unchanged Spec phase. `run.test.ts:306` rejects an owner-only body write. |
| **4** | **Not met in full. The supplied ordinary cases pass.** | `run.ts:597` checks a PR recording, computes commits, checks clean status, sets capped commits and finishes. `run.test.ts:319`, `:357`, `:375`, `:395`, `:409` pin success and each missing condition, including retained worktrees. `git.test.ts:169` pins ordering and cap. However, F2 demonstrates that the commit range can use a tag instead of the base branch, accepting a run with no work. Passing the named fixture is only letter-level coverage of this broader contract. |
| **5** | **Met.** | `run.ts:155` truncates by UTF-8 bytes with a marker; `run.ts:183` summarizes tools; `run.ts:282` batches on the configured window and flushes at completion. `run.test.ts:428` checks the long text, five-tool summary and full transcript. `run.test.ts:1126` checks two windows; `:1185` checks the pending summary on explicit release. |
| **6** | **Met.** | The event subscriber at `run.ts:360` excludes runner comments, queues other members' comments, and forwards them through the inbox. `run.test.ts:459` checks owner delivery and runner exclusion; `:860` checks two comments in one dispatch in order. Permission answers are intentionally consumed as answers, not duplicated as conversational input. |
| **7** | **Met.** | `run.ts:350` queues permission requests, `run.ts:176` interprets answers, and attention-resolution handling returns the decision or aborts on a move. `runner.ts:224` maintains heartbeat during the wait. `run.test.ts:503` checks the note, allow, continued execution and advancing expiry; `:532` checks deny/reason; `:545` checks other/no text; `:571` checks move/abort/release. `:803` and `:829` cover an existing question and concurrent permission requests. |
| **8** | **Met with justified allowlist corrections.** | `allowlist.ts:30`, `:77`, `:105` provide the fixed list and scan both instruction files. `allowlist.test.ts:98`, `:102`, `:110`, `:116`, `:122`, `:144` cover absent files, Bun, CLAUDE, symlinks, language/first-line selection and malformed blocks. `:68`, `:76`, `:90` pin the intentional narrowed commands. The scanner does not widen git/gh/skelcrew back to wildcards. |
| **9** | **Met.** | `run.ts:422` sets the timeout and aborts; completion selects the timeout failure. `run.test.ts:614` uses one second and checks signal, comment, owner attention and release. `:903` checks a signal-ignoring fake; `:1145` checks shutdown during preparation. |
| **10** | **Met for the specified owner-move path and the inherited teardown interpretation.** | `run.ts:391` detects moves and aborts; `runner.ts:257` posts abandonment. `run.test.ts:631` and `:571` assert one run-abandonment comment and no new run attention; `:1379` covers release then move. The separate 006 worktree teardown still posts its own removal comment, explicitly asserted in these tests. “Nothing else” applies to the abandoned run, not removal activity. F1 violates the wider claim-loss behavior, rather than this particular move fixture. |
| **11** | **Met.** | `shim.ts:23` writes an executable shim using this daemon's Bun executable; `shim.ts:38` prepends PATH and sets both identity/location variables. `run.test.ts:695` inspects the actual driver options and executes `--version`; `shim.test.ts:18`, `:30`, `:39`, `:46`, `:65` check permissions, reuse, rewrite and environment. |
| **12** | **Met; automated coverage is structural.** | `playbooks.ts:16` reads and rejects empty playbooks; both shipped files require repository instructions first and conflict attention. `runner.ts:280` selects the phase and `claude.ts:128` appends the prompt to the preset. `run.test.ts:695` loads both real files, checks their conflict command, and asserts phase-specific driver options; `:744` rejects missing playbooks. Actual independent review/verification is instructed in `code.md:81` and `:104`; no test proves model compliance with those instructions. |
| **13** | **Met.** | `none.ts:9`, daemon selection, and `runner.ts:283` retain the no-playbook handoff. `none.test.ts:4` and `:11` check selection/errors. Existing 006 runner tests pass unchanged; `packages/daemon/src/server/process.test.ts:85` selects `none` for the relevant process fixtures, whose old assertions remain. |
| **14** | **Met by direct document inspection.** | `AGENTS.md:37` explains the harness-driver exception and isolation. `docs/MILESTONES.md:198` onward records the shim/environment, excerpts/transcript, approval words and lifecycle. No behavioral test pins prose, nor would a keyword-only test independently establish its accuracy. |

Thus AC4 is substantively unmet despite green ordinary fixtures. The remaining criteria
are met on their stated surfaces, with the explicit interpretations above. AC12's tests
alone establish only the letter of file presence/wiring; reading the playbooks supplies
the separate evidence for their required instructions.

## 3. Desired behavior as a whole: concrete defects

### F1 — Important: a new claim does not supersede the old release

**Implementation defect.** Location:
`packages/daemon/src/runner/run.ts:405` and `run.ts:525`;
the unguarded attention mutation is at `run.ts:511`.

**Trigger:** while an endless fake driver is running on a Spec card, the owner releases
the runner's claim and immediately claims the card personally, without moving it:

```ts
core.releaseCard(1, { reason: "taking over" }, owner.id);
core.claimCard(1, {}, owner.id);
```

Both calls succeed. After the old driver aborts, the owner's claim remains, but the old
run adds attention `run stopped: released by simon` with no moves. The review probe's
assertion that the owner owns the claim passed; its assertion that attention is null failed
with precisely that request.

The event switch clears `releasedBy` for moves and archives but ignores `claimed`. The
completion path then takes the stored release branch before `input.stillHeld()` and calls
`stopWith`. The shared attention helper cannot prevent this when no question is already
open. This is the unfixed twin of release-then-move.

**Expected:** a new claim supersedes the old release's pending stop/handoff behavior.
Abort and abandon the old run with its one abandonment comment; leave the new holder's
claim and attention untouched. Recheck ownership/supersession before performing the
exceptional post-release mutations, including the pending tool-summary path. Retain the
documented stop request for a plain owner release that has not been superseded.

The specification explicitly carries forward “a run must never write to a card whose
claim it has lost” and the one-comment abandonment behavior. The deliberate plain-release
exception prevents an unclaimed card immediately rerunning; that reason no longer applies
once another member owns the card. This is not the previously recorded subprocess identity
scope issue: it is the orchestrator itself writing stale state.

**Missing regression:** beside `run.test.ts:1379`, add release-then-claim with a held driver;
assert the new claim survives, no attention is added, and only abandonment comes from the
old run. The existing move and plain-release tests do not exercise this transition.

### F2 — Important: a tag can satisfy the Code commit contract instead of the base branch

**Implementation defect.** Location:
`packages/daemon/src/runner/run.ts:598`, passed verbatim to
`packages/daemon/src/runner/git.ts:192`.

**Trigger:** start with a valid repository where branch `main` has commits A then B, and
tag `main` points to A. Both commits predate the run. The runner creates the card branch
at B. The Code fake only records a PR URL and returns success; it makes no commits and
leaves the worktree clean.

The review probe created this state using the existing hermetic Git fixture:

```ts
await initRepo();                          // main at A
await sh(repo, "tag", "main");             // tag main at A
await sh(repo, "commit", "-q", "--allow-empty", "-m", "existing base work"); // B
// Driver: core.setRefs(1, { prUrl: PR }, runnerMember.id); yield successful result.
```

**Observed:** the release reason was `finished`, not the expected `failed`. The gate runs
`git rev-list main..skelcrew/1-no-work`; Git resolves ambiguous short `main` to the tag,
so B is counted as a new commit. That puts the card at “ready for review” even though its
branch has no commits past the actual base branch.

Default-branch discovery already avoids this ambiguity with `refs/heads/<name>`
(`git.ts:147`, `git.ts:156`), and branch creation uses its resolved SHA
(`runner.ts:272`). The new contract check discards that protection by rebuilding a range
from short names.

**Expected:** compare the intended branch references, or their unambiguously resolved
commit IDs. In this sequence the range must be empty, the card must get the no-commits
failure without approval moves, and the release must be `failed`. Qualify both endpoints;
a colliding tag should not change either side of the contract.

**Missing regression:** add this repository shape to the Code no-commits test, not only a
unit test of arbitrary range forwarding. `run.test.ts:357` and `git.test.ts:169` use
unambiguous names and therefore cannot catch the false approval.

The specification's required branch/base relationship is clear here. No change to the
approved spec is needed to fix either F1 or F2.

### Other observable differences and their merits

The normal outside view matches the specified lifecycle: a queued card gets one worktree
run, excerpts and a log reference, live comment input, owner-resolvable permissions, an
artefact check, and an owner gate without an automatic phase move. Failures preserve work
and identify their cause. The daemon remains a coordinator of subprocesses rather than a
model caller.

The following additions or literal deviations deserve explicit judgment:

- **Narrowed `gh pr` entries:** justified correction to an unsafe specification wildcard.
  Create/view/diff/comment are present; merge/close are absent. Tests pin both the allowed
  and excluded forms. The scanner preserves this narrowing. This is correctly implemented
  and honestly recorded, not an implementation violation.
- **Narrowed `git` entries:** likewise justified. The playbook's exact push is available;
  arbitrary refspecs, force-push forms and leading `git -c` are not blanket-preallowed.
  The list and scanner tests pin that policy. This is a reduction of permission exposure,
  not proof of a complete shell security boundary. The already recorded residual judgment
  does not need reopening in this review.
- **`blocked` after a successful result with an open question:** justified. `run.ts:545`
  keeps the question, reports the artefact as a comment and releases `blocked`, rather than
  offering approval over it. Both phase twins are tested (`run.test.ts:1212`, `:1240`),
  and answering/re-running is tested at `:1268`. This addresses a missing outcome in the
  literal spec and is honestly recorded.
- **One external dependency:** justified interpretation of a spec that overlooked the
  existing workspace dependency. Removing `@skelcrew/shared` would damage the daemon;
  retaining it adds no second external dependency. The SDK stays behind `claude.ts`, and
  the lockfile's peer resolutions are distinguished from installed/imported model clients.
- **CLI narrowing, `Agent`/`TodoWrite`, explicit-stop and self-action handling:** these
  extend the literal fixed list/lifecycle. CLI narrowing supports human-only gates; the
  Agent tool supports the explicitly required fresh-context work. Explicit release stops
  automatic redispatch, and self-action is visibly reported. Their purposes are reasonable
  and recorded; F1 is an incomplete boundary of the stop policy, not a rejection of it.
- **Other small additions:** first-message branch/base context, a shim pinned to the running
  Bun executable, collision-safe log filenames, permission-answer suppression from chat,
  queued permissions, bounded abort grace, and shutdown failure reporting are coherent
  support for the specified unattended run. They do not introduce a new product surface.

There is no remaining transcript or ordinary unnumbered-spec revision defect established
by this review. Actual coding-agent behavior remains outside the deterministic tests;
presence of a playbook is evidence of what the harness instructs, not proof that a model
will always follow it.

## 4. Out-of-scope check

No second real driver, concurrent card-run scheduler, cross-member review protocol,
dry-run merge, conflict-bounce machine, partial-text UI, cost/token UI, per-repository
editable playbook system, or transcript viewer was added. `none` is the explicitly required
compatibility selection. Agent subcontexts for review/verification are explicitly required
by the spec's own resolved decisions, not an unauthorized second runner.

The in-session three-round instruction remains at `code.md:100` and `code.md:117`. The
record explicitly distinguishes it from the deferred runner-managed budget and carries
the tension to 008 (`docs/MILESTONES.md:306`). I accept that recorded treatment and do not
re-report it as a new finding or request an unauthorized amendment of the approved spec.

The shared attention helper, transcript callback and spec-path comment do not add an
agent-only API or persistence subsystem. The path comment uses the existing member-facing
surface. No additional unrecorded scope expansion was found.

## 5. Test strength and independent verification

**Committed checks:** `bun run check` exited 0: lint and typecheck passed; **354 tests,
0 failures, 2,454 assertions across 22 files**. Process checks used local sockets. No real
coding agent or external service was invoked.

**Additional probes:** I copied the existing run-test fixture into a temporary test file
and exercised the actual runner/core with hermetic temporary Git repositories. Final
results were **4 pass, 2 fail**:

| Probe | Result |
| --- | --- |
| Owner release, then new owner claim | FAIL: stale stop attention, F1. |
| `main` tag behind `main` branch; Code driver records PR but makes no commit | FAIL: `finished`, F2. |
| Owner release, then archive | PASS: abandonment, no attention. |
| Owner release with an existing agent question | PASS: question preserved. |
| Actual `drive` through the runner's real JSONL callback | PASS: exact full stream, unchanged text projection. |
| Code status verification throws with an existing question | PASS: question preserved, failure reported. |

The temporary test file was removed; production code and committed tests were not changed.
The first draft of the archive probe expected different abandonment wording; I corrected
that probe to the existing valid wording, then reran all six. That fixture correction is
not counted as a product failure or a red-before-green implementation cycle.

The substantive tests have teeth: they compare member-visible attention and actions,
release reasons, activity ordering, exact text, on-disk transcripts, actual Git state and
retained worktrees. Negative Spec/Code cases, unanswered questions on both outcomes,
permission sequencing, ignored cancellation and rapid repeated runs meaningfully constrain
the implementation. F1 and F2 passed the old suite because their inputs were absent, not
because an existing assertion explicitly allowed those wrong outcomes.

I found no weakening of a base-branch assertion or fixture to get this change green. The
process fixture's `SKELCREW_AGENT=none` is required by the spec and leaves its old lifecycle
assertions in place. The revised same-PR fixture now explicitly records the same URL during
the run; the paired no-recording test still fails that run, matching the contract rather
than weakening it. Moving fake logging to the callback is a necessary boundary adaptation,
and the direct `drive` tests cover what that fake cannot establish about raw SDK messages.

Limits are material: allowlist tests use a local approximation of permission matching,
not a real harness; the SDK adapter's actual process/callback integration is not exercised
by spawning Claude; playbook tests establish presence and wiring rather than agent
obedience; documentation checks are manual. The spec explicitly chooses the fake spawning
boundary, so these are evidence limits rather than requests to violate the no-real-agent
test constraint.

## Final verdict

**CHANGES REQUESTED.** Fix F1 and F2 with regressions that assert the card's resulting
state. The original four findings are addressed, the accepted specification deviations
remain justified, and the committed checks pass, but ownership supersession and the Code
artefact gate still admit concrete incorrect outcomes.
