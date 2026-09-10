# 007 — Conformance review 3

Date: 2026-09-10  
Branch: `worktree-runner-playbooks`  
Base: `main`  
Reviewed HEAD: `eb02004c90d792f7486d7d8cdd174e795da0e84f`  
Contract: [007-runner-runs-playbooks.md](../specs/007-runner-runs-playbooks.md)

**Verdict: CHANGES REQUESTED.** The previous review's F1 and F2 reproductions are fixed.
One Important defect remains in the deliberately retained self-action exception, and one
Minor defect remains in the Code playbook's Git base selection. Both are implementation
defects, not reasons to amend the approved specification.

I read the complete specification first, including Acceptance criteria and Out of scope,
then [AGENTS.md](../../AGENTS.md), the full [run record](007-runner-runs-playbooks.md),
both earlier reviews, and every changed/new file in full, including the lockfile. I obtained
the branch diff with `git diff main...HEAD` and separately inspected the three follow-up
commits. The earlier reviews and implementation files are unchanged by this review.

Independent validation: **`bun run check` exits 0; 357 tests pass, 0 fail, 2,466 assertions
across 22 files**, with lint and typecheck passing. Additional probes below exercise real
temporary Git repositories and the actual runner/core with fake agents. No coding agent or
external service was invoked. Locations refer to the reviewed HEAD.

## 1. Verification of the three follow-up commits

### b4d5aee — Unambiguous commit range

**The Code gate fix is correct at both endpoints.** `packages/daemon/src/runner/run.ts:627`
now passes `refs/heads/<base>..refs/heads/<branch>` to `revList`. That retains the current
base-branch semantics while preventing a tag from replacing either branch in the range.
`git.ts:196` passes the range through unchanged. Default-branch discovery already uses
qualified local heads (`git.ts:151`, `git.ts:160`); branch creation uses the resolved base
SHA (`runner.ts:272`).

The new test at `run.test.ts:1402` creates a `main` tag behind the `main` branch, records a
PR without making a commit, and asserts the no-commits failure, no commit refs and no
approval moves. I ran this exact test against a temporary copy of the pre-fix runner from
`e3087c3`: it fails waiting for the failed release because the old runner hands the card on.
It passes on HEAD. This independently confirms the record's claimed failure mechanism.

**Neighbor checked:** a tag named `skelcrew/1-shadowed-card` at the base while the card's
branch advances by one commit. A review probe verified attached HEAD, successful completion
and the actual branch SHA in card refs. It passes. Qualifying only the left endpoint would
have left this case broken; the implementation qualifies both.

**The `worktree add` exception is real.** With Git **2.48.1**, I created a branch `feature`
and a same-named tag at different commits, then exercised the actual Git wrapper:

| Argument to `git worktree add <path> …` | Observed result |
| --- | --- |
| `feature` | Attached to `refs/heads/feature`, at the branch's commit rather than the tag's. |
| `refs/heads/feature` | At that same commit, but detached HEAD. |

Leaving `git.ts:174` unqualified is therefore justified; mechanically qualifying that
command would break the branch attachment. I found no remaining equivalent ambiguity in
the runner's TypeScript Git call sites. However, the shipped Code playbook still tells
the agent to calculate its review base from a bare name. That neighboring path is finding
F2 below; it does not invalidate the corrected runner gate.

### 6a1f518 — Completion derived from current card state

**The original owner-release/takeover defect is fixed.** The normal completion decision
at `run.ts:534` checks current ownership, then requires a free, unarchived card still in
the original phase and never moved away before treating an explicit release as a stop.
A claim by another member cannot satisfy that predicate. The old missing-`claimed` case
no longer needs its own event-handler patch.

`run.test.ts:1424` pins owner release followed by owner claim: one abandonment comment,
the owner's claim standing, and no attention. Against the pre-fix runner, the same test
fails because the old stop comment/request appears; on HEAD it passes. Existing plain
release, release-then-move, lapse, shutdown and pending-summary tests are unchanged and
still pass.

`run.test.ts:1449` is correctly described as a **preservation test**. I ran it against both
the pre-fix runner and HEAD; it passes in both. The record does not count it as a defect
that this commit newly fixed.

The three uncertainties require separate judgments:

**(a) `movedAway` is justified historical state.** Consider Spec → Idea → Spec while the
old agent is aborting. At completion the card can be free and back in Spec, which looks
like a plain release if only its current phase is inspected. The old run must abandon so
the newly queued phase can run. A probe performed both moves synchronously and observed
abandonment, no stop request, and a second fresh run. `movedAway` at `run.ts:253`/`:393`
preserves information the current card snapshot cannot express. It only rules out the
exceptional stop; retaining it is not needless residue.

**(b) Member-level ownership is sufficient for this daemon's serial scheduling, not a
general claim-identity guarantee.** `runner.ts:181` awaits each job; `runner.ts:205` awaits
each card run; that run awaits `runPlaybook` before returning. Events queue subsequent
work rather than starting a second run alongside the first. Thus a second run scheduled
by this runner cannot acquire the card before the first finishes its completion path.
Even when a fake driver ignores cancellation and outlives the grace period, the old
orchestrator's completion occurs before the next scheduled run starts.

The plain-release path may safely use that same test under this architecture. It has no
additional asynchronous gap between deriving the ending and applying it. An external
client acting as the same `runner` member could still create a different claim that
`input.lost()` mistakes for this one's. That is a limit of the existing shared identity,
not evidence that the pump starts overlapping runs. I do not reopen the recorded identity
scope work or require a new claim-identity subsystem for this fix.

**(c) The self-action exception is too broad.** At `run.ts:531`, it selects a stop before
reading ownership. `stopWith` then both records the failure and raises attention. These
are different effects: a failure comment preserves accountability; a new attention request
changes the new holder's workflow. Both self-release-then-claim and self-move-then-claim
probes reproduced unwanted attention. See F1.

The refactor is a real improvement, but it does **not** make all late attention safe by
construction. Its normal path has that protection; the explicit self-action exception
bypasses it. The record's “flags no longer decide anything” is also too absolute:
`releasedBy !== undefined` still distinguishes an explicit release from a lapse, and
`movedAway` still distinguishes a phase restart from a plain release. Those uses are
reasonable historical facts, but the claimed invariant must be stated with its actual
boundary. The remaining problem is the scope of the exception, not the mere presence of
state variables.

### eb02004 — Record of the previous round

This commit preserves review 2 and adds external round 4; it contains no hidden runtime
change. The descriptions of the two reproduced defects and the archive preservation test
are substantiated by the independent checks above. The record explicitly acknowledges
`selfAction` and `movedAway`, so neither is concealed. I disagree with the breadth of the
self-action judgment, not with the claim that it was deliberate.

The bundled test/implementation commits do not prove the order of local test execution.
Running the new regressions against the old implementation independently establishes
their sensitivity without treating the record's red-before-green chronology as evidence.

## 2. Every numbered acceptance criterion

Runner paths in this table are relative to `packages/daemon/src/runner/`. “Met” includes
the explicitly justified interpretations below. A passing example is not treated as proof
of all Desired behavior.

| AC | Judgment | Implementation and test evidence |
| --- | --- | --- |
| **1** | **Met with the external-dependency interpretation.** | `packages/daemon/package.json:9` adds the one external harness SDK and retains the pre-existing workspace link. `bunfig.toml` disables peer installation. `bun run check` passed independently. Runs use scripted drivers; `server/process.test.ts:85` defaults to `none`; its Claude-startup test has no card and spawns no agent. |
| **2** | **Met.** | `runner.ts:219` claims and `:299` announces the log before spawning. `run.ts:456` supplies the JSONL callback; its event loop posts text; `:606` checks this run's runner-authored body write before Spec completion. `run.test.ts:223` asserts exact activity, first comment, two text comments, log contents, attention/moves and release. `claude.test.ts:31` separately pins full raw-message logging. |
| **3** | **Met.** | `run.ts:608` requires a body-set event plus a nonblank current body, otherwise calls the exact no-spec failure. `run.test.ts:270` checks failure comment, no-move attention, failed release and unchanged phase/body; `:306` rejects an owner-only body write. |
| **4** | **Met for the stated finish contract, with the already accepted recording semantics.** | `run.ts:620` checks this run's PR recording, `:627` compares qualified branch refs, and `:633` checks cleanliness before setting commits and offering PR review. `run.test.ts:319`, `:357`, `:375`, `:395`, `:409` cover success and every missing condition, including preserved worktrees. `git.test.ts:169` checks newest-first order and cap. `run.test.ts:1048`/`:1073` cover revisions. The new base-tag test at `:1402` and the additional card-branch-tag probe pass. Previous F2 is closed at this gate. |
| **5** | **Met for the specified excerpt/summary behavior.** | `run.ts:155` cuts text at UTF-8 boundaries and adds the marker; `:183` summarizes tools; `:283` batches and flushes the window. `run.test.ts:428` checks the 2 KiB boundary, five-tool summary and complete log; `:1126` checks two windows; `:1185` checks the pending window on a plain release. |
| **6** | **Met, with the documented permission-answer exception.** | `run.ts:297` queues comments and `:360` excludes the runner. `run.test.ts:459` checks owner delivery and runner exclusion, and `:860` checks two comments in one dispatch. Permission answers go to the permission decision rather than being duplicated into ordinary input; `:503` pins that behavior. |
| **7** | **Met at the fake-driver boundary.** | `run.ts:350` asks through attention; `:176` recognizes approval words; the attention-resolution handler allows/denies or aborts on movement. `runner.ts:227` heartbeats. `run.test.ts:503` checks note, allow, continued run and advancing expiry; `:532` checks no/reason; `:545` checks arbitrary/no text; `:571` checks move/abort/release. `:803`/`:829` cover queued permissions behind questions and each other. `claude.ts:115` adapts the decision to the SDK. |
| **8** | **Met with justified narrowed entries.** | `allowlist.ts:30`, `:77`, `:105` provide the fixed list and fenced-command scan. `allowlist.test.ts:98`, `:102`, `:110`, `:116`, `:122`, `:144` cover absent instructions, Bun, CLAUDE, both files/symlink, first lines and malformed input. `:68`, `:76`, `:90` pin narrowing; the scanner cannot widen git/gh/skelcrew back to wildcards. |
| **9** | **Met.** | `run.ts:420` arms timeout/abort and `:589` reports the timeout failure. `run.test.ts:614` checks a one-second endless run, signal, comment and owner attention. `:903` covers ignored abort; `:1145` covers shutdown during preparation. |
| **10** | **Met on the specified owner-move path; broader claim-loss behavior is incomplete.** | `run.ts:391` reacts to moves; `runner.ts:257` posts abandonment. `run.test.ts:631` and `:571` assert one abandonment comment and no new run attention; `:1379` checks release then move. The separate inherited worktree-removal comment is teardown activity, explicitly asserted in these tests. The move-away/back probe passes. F1 concerns the preceding self-action exception, outside these fixtures, and means the overall abandonment contract is not fully met. |
| **11** | **Met.** | `shim.ts:23` writes the executable and `:38` supplies PATH, identity and data directory. `run.test.ts:695` checks the actual driver options and executes the shim's `--version`; `shim.test.ts:18`, `:30`, `:39`, `:46`, `:65` check contents, reuse/rewrite, execution and environment. |
| **12** | **Met in letter; the complete Code playbook still has a defect.** | `playbooks.ts:16` loads the nonempty files, `runner.ts:280` selects the phase, and `claude.ts:128` appends the system prompt. Both files require conflict attention. `run.test.ts:695` checks files and phase wiring; `:744` rejects missing playbooks. These assertions remain green despite the erroneous review-base instruction in F2. Fresh review and verification are instructed, but their diff can include pre-existing base work. |
| **13** | **Met.** | `none.ts:9`, `main.ts:40` and `runner.ts:283` preserve the no-driver path. `none.test.ts:4`/`:11`, unchanged 006 runner tests, and the `none` process tests all pass. No old process assertion was removed to obtain this result. |
| **14** | **Met by direct inspection.** | `AGENTS.md:37` onward reconciles the harness SDK with the no-model-client rule; `docs/MILESTONES.md:198` onward records the shim, environment, excerpt/transcript rules and approval words. No dedicated prose test establishes these facts; I inspected the documents themselves. |

No supplied numbered happy/negative fixture is currently failing. AC12 establishes only
the letter of file presence and wiring in the face of F2; the wider claim-loss requirement
and correct review behavior remain unmet as described below. This distinction is why the
green suite does not yield an approval verdict.

## 3. Desired behavior: concrete defects

### F1 — Important: self-action can raise attention after another member takes the card

**Classification:** implementation defect in the breadth of a deliberate exception.  
**Locations:** `packages/daemon/src/runner/run.ts:531`, `:548`, `:506`.

**Trigger A:** a live Spec run's agent releases its own claim; before the abort finishes,
the owner claims the card:

```ts
core.releaseCard(1, { reason: "done" }, runnerMember.id);
core.claimCard(1, {}, owner.id);
```

**Trigger B:** a live Code run's agent moves its own card back to Spec; the owner then
claims it:

```ts
core.moveCard(1, "spec", runnerMember.id);
core.claimCard(1, {}, owner.id);
```

Both sequences are legal core operations. In each review probe, the owner's claim remained
and exactly one agent-failure comment appeared. The assertion that attention remained null
failed, receiving respectively:

```text
run failed: the agent released its own card (done)
run failed: the agent moved its own card (to spec)
```

These are new owner attention requests with no moves, raised by the old run. The
`selfAction` branch returns `stop` before any ownership check; the common stop handler
unconditionally calls `stopWith`, which combines the historical comment with a new
workflow request. The shared attention helper preserves an existing question, but does
not prevent an unwanted request when the new holder has none.

**Expected:** retain the truthful self-action failure comment, but leave the new holder's
claim and attention untouched. The authorization to record accountability must not also
authorize a new attention request after takeover. Apply that distinction to both
self-release and self-move; preserve the existing question-protection rule and the plain
self-action behavior when nobody has superseded it. An archived card already rejects
attention, so the existing archive test does not exercise this takeover case.

The stated reason for the exception is defensible for the comment. Once someone else
holds the card, preventing automatic redispatch no longer requires attention from the old
run. This is the same stale workflow mutation corrected on the owner-release path, now
through the intentionally earlier branch. It violates the specification's carried-forward
claim-loss rule without needing to suppress accountability.

My previous written review accepted the exception too broadly. This finding narrows that
judgment explicitly; it does not portray the implementer as accidentally dropping a rule
that the previous review had required here. The record is candid about the choice, but the
choice remains incorrect on these combined inputs.

**Missing tests:** pair the ordinary self-release/self-move tests at `run.test.ts:947` and
`:924` with a subsequent claim by another member. Assert the failure comment survives,
the new claim survives, and no attention is created. Keep both twins; the new owner-release
test at `:1424` cannot cover either one.

### F2 — Minor: the Code playbook still computes its review base from an ambiguous name

**Classification:** implementation/playbook defect.  
**Location:** `packages/daemon/playbooks/code.md:30`; the resulting SHA is used by the
review/verification instructions at `:83` and `:106` and the final diff at `:127`.

**Trigger:** branch `main` has A → B; tag `main` points to A. B introduces `base.ts` before
the card run. The card branch forks at B and its work introduces only `feature.ts` in C.
The first message names the base branch `main`, and step 5 directs the agent to execute:

```sh
git merge-base HEAD main
```

That returns A because the bare name resolves to the tag. Following the subsequent
`git diff <base>...HEAD` instruction therefore includes both `base.ts` and `feature.ts`.
I reproduced this using the playbook's actual commands in a temporary worktree:

```text
Expected reviewed files: ["feature.ts"]
Actual reviewed files:   ["base.ts", "feature.ts"]
```

**Expected:** derive the review base from the named branch unambiguously, for example
`git merge-base HEAD refs/heads/<base branch>`, and pass that SHA to both fresh contexts
and the final diff. Existing base changes must not be presented as this card's changes.

The runner's finish gate is fixed and does not make this mistake anymore. The playbook
still feeds the independent reviewers an overbroad diff, which can produce unrelated
findings, unnecessary fixes or an avoidable owner escalation. Those downstream agent
choices are risks, not outcomes I claim to have observed; the incorrect diff itself is
deterministically reproduced. That narrower impact makes this Minor rather than another
false-approval finding.

The run record scopes its bare-ref survey to the runner. That survey does not establish
that the shipped instructions are free of the same error. The spec asks for review of the
card's change; it does not require ambiguous Git names, so this is not a spec defect.

**Missing coverage:** the playbook wiring test only checks nonempty content and the
attention command. It would pass if this base-selection instruction were removed or
broken. A fixture with branch/tag collision can pin the intended diff without spawning a
model or asserting the entire markdown verbatim.

## 4. Remaining Desired behavior and deliberate deviations

The normal member-visible lifecycle conforms: one ready card is claimed, its worktree and
log path are announced, the driver receives the phase playbook/card/environment, excerpts
and tool summaries arrive on the card, comments and permission answers reach the run, and
verified artefacts become owner attention rather than an automatic phase move. Failure
paths name the unmet conditions and retain dirty worktrees. F1 is the remaining late-state
mutation exception; F2 concerns the correctness of the instructed review stage.

The previous transcript fix remains intact: `claude.ts:98` logs every consumed SDK message
once before display projection, through the first terminal result. Displayless messages
are retained and multi-block messages are not duplicated. `claude.test.ts:31` and `:69`
pin these independently of the scripted run logger. Collision-safe exclusive log creation
at `run.ts:115` and `run.test.ts:1295` preserve earlier transcripts.

Both playbooks start with repository constraints, use the shared CLI, and raise conflicts
instead of silently editing the approved spec to match implementation. The durable
`spec committed: <path>` comment in `code.md:36`/`:49` still lets an unnumbered revised
card update the same file. Identical content is reused; changed/missing content is written
at that path; ambiguous legacy associations escalate. The later ship stage re-records an
existing PR URL. No new regression in those instructions was found. These conclusions
come from reading the instructions and card surfaces, not from claiming a model executed
them in tests.

The four requested deviations remain justified and honestly recorded:

| Deviation | Judgment |
| --- | --- |
| Narrowed `Bash(gh pr *)` | Corrects a literal permission rule that preallowed the human's merge operation. Create/view/diff/comment are explicitly listed; excluded verbs and scanner behavior are tested. |
| Narrowed `Bash(git *)` | Corrects a wildcard that preallowed arbitrary refspec pushes and leading Git execution options. Required verbs and exact push forms remain available; widening through instruction fences is suppressed. This is a permission reduction, not a complete shell security boundary. |
| Successful result with an unanswered question releases `blocked` | Correctly preserves the question, reports the artefact as a comment and withholds approval. Both Spec and Code are pinned at `run.test.ts:1212`/`:1240`, and answer/re-run at `:1268`. The literal spec omitted this necessary outcome. |
| “Exactly one dependency” means one external dependency | Correctly retains the already-required `@skelcrew/shared` workspace link while adding one external harness driver. The SDK exception and peer-resolution/install distinction are documented. |

Other described additions are reasonable support for the unattended workflow: narrowed
skelcrew verbs, the Agent/TodoWrite tools, branch/base context in the first message, a shim
using the daemon's own Bun executable, queued permission requests, suppression of duplicate
permission-answer input, bounded cancellation grace, shutdown failure reporting, and a
plain-release stop request to prevent instant redispatch. The last policy needs the
self-action boundary correction above; it need not be removed wholesale.

## 5. Out of scope

No second real driver, concurrent card-run scheduler, cross-member review protocol,
dry-run merge, conflict-bounce machinery, partial-text UI, cost/token UI, per-repository
playbook override or transcript viewer was added. `none` is expressly required compatibility
behavior. Fresh Agent subcontexts are expressly required within the Code playbook; they
are not an unauthorized second runner.

The three-round in-session prose budget remains explicitly carried to 008 in
`docs/MILESTONES.md:306`. I accept the recorded distinction from runner-managed cycle
budgets and do not request an amendment of the approved spec. The other known residues
listed in the review request have not been re-reported as new defects.

The helper, transcript callback and spec-path comment use the existing internal driver
boundary and member-facing card primitives. No new agent-only surface or repository-content
store was introduced. The SDK remains a subprocess harness behind `claude.ts`, not a model
client called by the daemon.

## 6. Test strength, preservation and independent probes

The committed tests meaningfully check card activity, refs, attention actions, exact
failure text, release reasons, lease progression, filesystem retention and JSONL contents.
Real temporary Git repositories give the contract tests evidence beyond mocked return
values. Failed/successful questions, queued permissions and error/abort paths are paired
in several places. Their green result is meaningful but does not cover every combination.

This round's `run.test.ts` diff is indeed **68 insertions, zero deletions**. No existing
assertion or fixture was loosened. The full branch also preserves the old process checks,
with the spec-required `SKELCREW_AGENT=none` fixture change. Earlier same-URL revisions now
explicitly record the URL during the run, and the paired no-recording regression remains.
Moving logging into the fake driver's callback did not replace the real file assertions
or erase the separate raw-SDK projection tests.

The two new corrective tests have demonstrated sensitivity: against temporary copies of
`run.ts` and `runner.ts` from `e3087c3`, they fail for the expected stale-attention and
false-handoff sequences; the new archive test passes there. All three pass on HEAD.
This verifies correction versus preservation without stashing or modifying tracked code.

Additional independent probes on HEAD:

| Probe | Result |
| --- | --- |
| Self-release, then owner claim: retain failure comment but no new attention | **FAIL**, F1. |
| Self-move from Code to Spec, then owner claim: same expected outcome | **FAIL**, F1's twin. |
| Owner moves Spec → Idea → Spec during the old run | **PASS**: abandonment, no stop attention, fresh run starts. |
| A tag shadows the card branch while that branch gains a commit | **PASS**: attached HEAD and actual branch commit on successful card refs. |
| Bare versus qualified `worktree add` with a colliding tag | **PASS**: bare attaches to the branch; qualified detaches at its commit. |
| Playbook's bare-name merge-base followed by its prescribed review diff | **FAIL**: pre-existing base file appears, F2. |

Final probe result: **3 pass, 3 fail**. During probe construction I corrected two fixture
errors: an attempted agent move out of owner-gated Spec, and branch creation without an
explicit SHA in the ambiguous-name repository. The corrected probes use legal Code → Spec
movement and the same explicit-base branch creation as the runner. Those setup failures
are not counted as product findings. All temporary source/test copies were removed.

Coverage limits remain explicit: permission matching is approximated in a local test;
SDK process/callback integration is not tested by spawning a real coding agent; playbook
tests establish presence/wiring rather than agent obedience; documentation is checked by
inspection. None justifies violating the repository's no-real-agent test constraint.

## Final verdict

**CHANGES REQUESTED.** Previous F1 and F2 are fixed on their reported paths. Keep those
fixes. Narrow the self-action exception so accountability cannot add attention after
another member takes ownership, and make the playbook's review-base command unambiguous.
The state-derived normal path is stronger, but its explicit exception still leaves the
claim-loss contract incomplete.
