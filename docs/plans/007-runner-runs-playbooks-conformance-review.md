# 007 — Runner runs the phase playbooks: conformance review

Date: 2026-09-09  
Branch: `worktree-runner-playbooks`  
Base: `main`  
Reviewed HEAD: `debb34c`  
Contract: [007-runner-runs-playbooks.md](../specs/007-runner-runs-playbooks.md)

**Verdict: CHANGES REQUESTED.** Four implementation defects remain despite a green check.

The review covered the complete specification, including Acceptance criteria and Out of
scope; [AGENTS.md](../../AGENTS.md); the complete
[run record](007-runner-runs-playbooks.md), including four internal and two external review
rounds; `git diff main...HEAD`; and every changed or new file in full. Run-record claims
were treated as hypotheses rather than evidence.

`bun run check` passed: **350 tests, 0 failures**. The initial sandboxed attempt could not
open local Unix sockets; the successful run was outside that sandbox. No real coding agent
was spawned. Two additional behavioral probes failed for the intended reasons described
below. The temporary test file was removed after the review.

Paths in the acceptance table are relative to `packages/daemon/src/runner/` unless stated
otherwise. Line numbers refer to the reviewed HEAD.

## 1. Acceptance criteria

| AC | Judgment | Implementation and test evidence |
| --- | --- | --- |
| 1 | **Met**, with the accepted dependency interpretation | `packages/daemon/package.json:9` adds one external dependency while retaining the workspace link. Checks pass. Scripted drivers exercise runs; the Claude process test creates no card and therefore spawns no agent. |
| 2 | **Met in letter** | `runner.ts:219` claims; `runner.ts:294` announces the log; `run.ts:452` logs events and posts text; `run.ts:573` checks the Spec artefact. `run.test.ts:218` asserts the complete activity sequence and transcript. However, the real adapter filters messages before this test boundary—finding 3. |
| 3 | **Met** | `run.ts:573` requires a runner-authored `body_set` during this run and a nonblank body. `run.test.ts:265` rejects an unchanged pre-existing body; `run.test.ts:301` rejects an owner-only write. |
| 4 | **Met** for the stated contract | `run.ts:586` checks commits, cleanliness and a PR recording, then writes commits and offers PR approval. `run.test.ts:314`, `:352`, `:370`, `:390`, and `:404` cover success and unmet conditions. `git.test.ts:169` pins ordering and the cap. Revision coverage is at `run.test.ts:1043` and `:1068`. Exceptional verification failures have a separate defect—finding 2. |
| 5 | **Met** for the specified example | `run.ts:153` truncates by UTF-8 bytes; `run.ts:275` batches tools. `run.test.ts:423` checks the character boundary, marker, five-tool summary and complete driver-event log. `run.test.ts:1121` checks separate summary windows. |
| 6 | **Met**, with a documented exception | `run.ts:292` queues comments; `run.ts:359` excludes runner comments. `run.test.ts:454` tests forwarding and exclusion; `:855` tests ordering. Permission answers are deliberately consumed as decisions instead of also becoming user messages; `:498` pins that sensible exception. |
| 7 | **Met at the driver boundary** | `run.ts:311` queues permission requests, `:345` creates them, and `:371` resolves them. `runner.ts:225` heartbeats. Tests at `run.test.ts:498`, `:527`, `:540`, and `:566` cover allow, denial, arbitrary answers, heartbeat advancement and movement. `claude.ts:94` translates decisions into SDK responses. Actual SDK permission matching is not integration-tested. |
| 8 | **Met with justified deviations** | `allowlist.ts:28` defines the narrowed fixed entries; `:104` adds fenced commands. `allowlist.test.ts:68` onward checks entries, excluded verbs, both instruction files and absent files. |
| 9 | **Met** | `run.ts:414` aborts at the limit; `:560` reports failure. `run.test.ts:609` uses a one-second limit and checks the signal and owner attention. `:898` checks an unresponsive driver. |
| 10 | **Not fully met** | The direct-move case works and is pinned by `run.test.ts:626`, through `run.ts:387` and `runner.ts:325`. Release followed by movement takes the wrong terminal path—finding 1. |
| 11 | **Met** | `shim.ts:24` writes the executable; `:38` builds the environment. `shim.test.ts:46` executes it with no Bun on PATH. `run.test.ts:690` verifies what the driver receives and executes that shim. |
| 12 | **Met in letter** | `playbooks.ts:15` loads both files; `runner.ts:311` passes the selected playbook; `claude.ts:108` appends it to the preset. `run.test.ts:690` checks contents and phase wiring. Those assertions do not establish correct playbook behavior; finding 4 remains. |
| 13 | **Met** | `none.ts:8`, `main.ts:36`, and `runner.ts:282` retain the no-driver handoff. `none.test.ts:4`, the unchanged 006 runner tests, and `server/process.test.ts:303` cover selection and behavior. |
| 14 | **Met** | `AGENTS.md:42` contains the reconciliation; `docs/MILESTONES.md:195` onward records the shim, environment, excerpts and approval words. These are verified by inspection, not a dedicated documentation test. |

## 2. Desired behavior: concrete defects

### Finding 1 — Release followed by movement leaves stale runner attention

**Severity:** Important  
**Classification:** Implementation defect  
**Location:** [packages/daemon/src/runner/run.ts](../../packages/daemon/src/runner/run.ts), line 513

`releasedBy` takes precedence over abandonment even if the owner subsequently moves the card.

**Trigger:** While the agent is running, the owner releases the card, then moves it to Idea
before the agent finishes aborting. The release sets `releasedBy`; the move sets
`movedAway` but never invalidates that earlier outcome. The runner then raises
`run stopped: released by simon` on the already-moved card.

A behavioral probe reproduced exactly that attention request where it expected `null`:

```text
Expected: null
Received attention.note: "run stopped: released by simon"
```

**Expected instead:** A subsequent move or takeover must supersede the release-only
handling: abort, post the abandonment comment, and leave the new card state alone.
Existing tests cover release and movement separately.

### Finding 2 — A Git exception during verification overwrites the agent’s question

**Severity:** Important  
**Classification:** Implementation defect  
**Location:** [packages/daemon/src/runner/runner.ts](../../packages/daemon/src/runner/runner.ts), line 338

The outer exception handler unconditionally replaces attention.

**Trigger:** A Code agent raises `Which schema is correct?`, ends successfully, and
`git.revList()` or `git.status()` rejects during contract verification. That exception
escapes `runPlaybook()` and bypasses its question-preserving `fail()`.

A behavioral probe injected a rejecting `revList()` and reproduced:

```text
Expected attention.note: "Which schema is correct?"
Received attention.note: "run playbook failed: git unavailable during verification"
```

**Expected instead:** The error should become a comment and failed release while preserving
the unanswered question. This is another failure path missing the rule described as settled
in the run record.

### Finding 3 — The transcript is not the full SDK message stream

**Severity:** Important  
**Classification:** Implementation defect; the record overstates coverage  
**Location:** [packages/daemon/src/runner/claude.ts](../../packages/daemon/src/runner/claude.ts), line 78

Unrecognized or displayless messages produce no events. User messages without tool results
are also dropped, as are assistant messages containing only thinking blocks.

**Trigger:** An SDK `system/init` message, ordinary user message, or thinking-only assistant
message arrives. Passing all three through `toEvents()` returned `[]` for each.
Consequently, `appendLog()` never receives them. Conversely, a message containing several
recognized blocks is duplicated through several events’ `raw` fields.

**Expected instead:** Record the full transcript independently of the card-display
projection, preserving each SDK message once. The record’s claim that adding `raw` means
“the transcript holds the full stream” is false. `claude.test.ts:27` actually expects the
system message to disappear; the scripted transcript tests cannot catch this.

### Finding 4 — Approved revisions of unnumbered cards lose the committed-spec association

**Severity:** Important  
**Classification:** Implementation/playbook defect  
**Location:** [packages/daemon/playbooks/code.md](../../packages/daemon/playbooks/code.md), line 37

An unnumbered card identifies its existing spec solely by matching its current content.

**Trigger:** An unnumbered card’s first Code run commits `docs/specs/012-feature.md`; the
owner sends it through Spec again and approves changed text, still without a number. The
next Code run cannot match the old file by number or content. The “different” update branch
is unreachable through the prescribed identification rule; the fallback allocates another
number, leaving the stale spec alongside a duplicate.

**Expected instead:** Recover the existing path from this card’s earlier activity or branch
history, or record that path when first allocating it. If the association cannot be
established, ask before allocating another file. The last external fix handles **numbered**
revisions, but its claimed general revision behavior remains incomplete. Current playbook
tests cannot detect this. This finding follows the written instructions; it was not tested
by spawning a model.

### Judgment of the four deliberate deviations

- **Narrowed `gh pr` permissions:** Appropriate protection for the owner’s merge gate;
  correctly represented in the list and tests, and explicitly recorded.
- **Narrowed Git permissions:** Appropriate for the identified commands; exact push entries
  and suppression of widening through fenced-command scanning are implemented and tested.
  The record appropriately limits its claim.
- **`blocked` success outcome:** Appropriate when the artefact exists but an unanswered
  question prevents handoff. Both phase paths and redispatch after answering are tested.
  Finding 2 concerns a neighboring exceptional path, not the justification for `blocked`.
- **One external dependency:** Correct reconciliation with the pre-existing workspace
  dependency, honestly recorded.

Other additions beyond the literal Desired behavior—serialized permission requests,
shutdown failure handling, bounded abort grace, explicit-release handling, and suppression
of duplicate permission-answer forwarding—serve the specified workflow and are recorded.
The release handling needs the correction above.

The three residues identified in the review request are not repeated as findings.

## 3. Out of scope

No second real driver, concurrent card execution, cross-member review, merge automation,
conflict bouncing, partial-text streaming, cost UI, transcript viewer, or repository-specific
playbook override was found.

There is one literal scope expansion: `packages/daemon/playbooks/code.md:101` and `:118`
prescribe a three-round review/verification budget although the spec defers “cycle budgets.”
Retain that useful bound and clarify the **specification**: distinguish an in-session
playbook limit from the runner-managed cycle machinery deferred to 008. Likewise, its
expressly required subagents must be understood as permitted within one card run despite
“running two agents at once.”

## 4. Test strength and loosening

- The run tests generally have teeth: exact activity sequences, real temporary Git
  branches, persisted artefacts, attention contents and release reasons. The two additional
  failing probes demonstrate missing combinations rather than broadly ineffective tests.
- The SDK type-conformance assertion cannot verify runtime wiring. The allowlist matcher
  is a local imitation, not an SDK enforcement test. These are evidence limits, not grounds
  to spawn a real agent.
- Playbook tests establish presence and wiring only. They would remain green after removing
  most of the workflow.
- No existing main-branch assertion was weakened in this diff. The run record openly
  describes the internal PR-rule reversals; the final tests again reject a revision that
  records nothing. Most internal rounds are contained in one commit, so their claimed
  red-before-green chronology cannot be independently established from branch history.

The review itself made no implementation changes. This report is the only retained file
added afterward.
