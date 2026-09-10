# 012 — The runner spawns an agent and the card shows what it does

Run record for `docs/specs/012-runner-runs-an-agent.md`, implemented in the worktree
`.claude/worktrees/runner-runs-an-agent` on branch `worktree-runner-runs-an-agent`.

## The change, in steps

1. **The boundary.** `packages/daemon/src/runner/agent.ts` — `AgentEvent`, `ToolDecision`,
   `AgentRunOptions`, `AgentDriver`, verbatim from the spec. No implementation.
2. **Driver selection.** `none.ts` turns `SKELCREW_AGENT` into `"claude" | "none"`; an
   unrecognised value throws naming the variable.
3. **The SDK driver.** `claude.ts`, the only importer of `@anthropic-ai/claude-agent-sdk`
   (pinned exactly, with root `bunfig.toml` `[install] peer = false`). Logs every message on
   arrival, then projects it to card events.
4. **The allowlist.** `allowlist.ts` holds the fixed list exactly as the spec names it, plus
   the matching semantics it is read with, so criterion 9 can be asserted as behaviour.
5. **The shim.** `shim.ts` writes `<data dir>/bin/skelcrew` (`exec`ing `process.execPath`) and
   builds the spawned environment: exactly `PATH`, `HOME`, `SKELCREW_AS`, `SKELCREW_DIR`.
6. **The playbooks.** `packages/daemon/playbooks/{spec,code}.md`, loaded by `playbooks.ts`,
   which refuses an empty one.
7. **The run.** `run.ts` owns one run: exclusive-create the log, spawn through the driver,
   excerpt turns, batch tool calls, forward comments in, deny tools, enforce the limit, end.
8. **The seam.** `runner.ts` calls `run.ts` where it posts the no-playbook handoff today, and
   keeps that handoff verbatim when it has no driver. `main.ts` selects the driver, loads the
   playbooks before the socket opens, and exits 1 on a bad `SKELCREW_AGENT`.

## Files expected to change

- new: `bunfig.toml`, `packages/daemon/playbooks/{spec,code}.md`,
  `packages/daemon/src/runner/{agent,none,claude,allowlist,shim,playbooks,run}.ts` and the
  tests `{none,claude,allowlist,shim,playbooks,run}.test.ts`
- changed: `packages/daemon/package.json`, `bun.lock`, `packages/daemon/src/runner/runner.ts`,
  `packages/daemon/src/main.ts`, `packages/daemon/src/server/process.test.ts`
- untouched: `packages/daemon/src/runner/runner.test.ts` (must pass unmodified)

## Decisions the spec left open

- **The default when `SKELCREW_AGENT` is unset is `claude`.** The spec names the two values
  and what an unrecognised one does, not the default; running agents is what the daemon is
  for, and 006's behaviour stays reachable with an explicit `none`. `process.test.ts`'s
  helper therefore sets `SKELCREW_AGENT=none` for every existing case, so no test spawns an
  agent.
- **How a normal run ends.** 006's shape, with 006's words replaced: comment and attention
  note `run finished; the agent's session ended — work is in <path>`, release reason
  `finished`. Whether the agent actually produced anything is 014's, so the note claims
  nothing about an artefact.
- **The excerpt marker names the run log's path**, not just "the run log": criterion 3 wants
  the marker to point at it, and a path is the only unambiguous pointer.
- **A denial is posted immediately**, not batched with tool summaries: it is the thing the
  owner has to see, and batching would delay it by up to the summary window.
- **The allowlist's matching semantics live in `allowlist.ts`, next to the list.** The
  harness enforces the list; the model of how it reads it is what makes the list testable as
  a security boundary rather than a string array nobody can assert about.

## Decisions taken while implementing

- **`RunnerOptions.agent` is one object, `{ driver, playbooks }`,** rather than two optional
  fields with a runtime guard that a driver never arrives without its playbooks. The pairing
  is then structural, and there is no untested throw.
- **`RunAbandoned` moved from `runner.ts` into `run.ts`** so both halves raise and catch the
  same class. No behaviour changed; `runner.test.ts` still passes unmodified.
- **The excerpt limit is 2 KiB, not the core's 16 KiB comment cap.** The spec asks for turns
  "excerpted rather than dumped"; a 15 KiB turn posted whole is a dump. The marker names the
  run log's full path.
- **A pending tool batch is dropped, not posted, when the claim is gone.** `post()` is the
  one guarded write, and §3's first invariant — never write to a card this run has lost —
  outranks the batch. On every ending the run still holds, the batch lands first.
- **`allowsTool` in `allowlist.ts` models the harness's matching but does not enforce it.**
  Enforcement is the harness's (it never asks about a call the list covers) and `canUseTool`
  only ever denies, per the spec's *Out of scope*. The model exists so criterion 9 is a
  behavioural assertion rather than a string comparison.
- **Verified against the shipped harness rather than the spec's description:** the CLI binary
  describes a Bash rule ending in `:*` or ` *` as "any Bash command starting with <content
  minus those two characters>", and its own allow-rule validator warns that a wildcard before
  the rest of a command "also matches any options inserted at that position … For git,
  options such as -c and --exec-path can run arbitrary commands. … only use * after the
  subcommand (for example Bash(git status *))". Both confirm the spec's rule 1.

## Review round 1

Three findings, all about the same thing: what the boundary actually is, as against what the
code said it was. The spec was amended under the first two — two new paragraphs at the end of
*What may run without asking*, and criterion 15 — and this round implements the amendment.
`runner.test.ts` stayed untouched; `bun run check` is green at 344 tests (342 before, plus the
two written here).

### Critical — the run inherited permissions from filesystem settings

`sdkOptions` in `claude.ts` never set `settingSources`. The SDK's shipped types say what that
means (`node_modules/.bun/@anthropic-ai+claude-agent-sdk@0.3.266/…/sdk.d.ts:2076-2086`):

> Control which filesystem settings to load. … When omitted, all sources are loaded (matches
> CLI defaults). Pass `[]` to disable filesystem settings (SDK isolation mode). Must include
> `'project'` to load CLAUDE.md files.

So `~/.claude/settings.json`, the target repository's `.claude/settings.json` and its
`settings.local.json` were all loaded, their `permissions.allow` rules merged into the same
rule set as `allowedTools`, and a match there returns allow before `canUseTool` is reached — a
target repository could grant an unattended run `Write`, `Edit` or `git push` by committing a
file, with no denial and nothing on the card. The fixed list was not a list.

Criterion 15 asks for this to be asserted on the options the driver builds, so the
construction is now `buildSdkOptions(options)` — an exported function returning the `Options`
and the `AbortController` that ends the run — with `claudeDriver.run` calling it. That
extraction was made first, with the suite still green, and the assertion written against it
after; the red it was written against:

```
189 |   expect(sdkOptions.settingSources).toEqual([]);
error: expect(received).toEqual(expected)
Expected: []
Received: undefined
```

`settingSources: []` makes it pass, and the test names the whole permission surface —
`settingSources`, `allowedTools`, `permissionMode` — because the claim is that those are all
of it. The one thing `[]` costs is automatic `CLAUDE.md` loading, which was checked rather
than assumed: neither playbook mentions settings, skills, hooks or MCP, and both open with
"Read `AGENTS.md` or `CLAUDE.md` at the repository root in full, first", so the repository's
own instructions still reach the agent — by the route the architecture says they should.

### Important — the fixed list is not the complete set of what runs unprompted

`allowlist.ts` told the next reader that the model diverges from the harness in one direction
only (compound commands). It does not. The harness holds a fixed read-only Bash set the list
never names and allows those commands rather than asking about them, so they never reach
`canUseTool` either — visible in the shipped binary as a set built from
`["cal","uptime","cat","head","tail","wc","stat",…]`, a companion set of `find` flags
(`-delete`, `-exec`, `-execdir`, …) that disqualify a command from it, and a Bash permission
path that returns allow on `isReadOnly` before it falls through to asking. (One detail the
spec's new paragraph puts slightly differently: that check runs *after* rule matching, not
before it. The consequence the paragraph turns on — those calls never reach `canUseTool` —
is the same either way, so the comment states the consequence and not an order.) The module
comment now records this as the second divergence, says it is why
this list is not the complete set of what runs unprompted, and points at 013 for constraining
it — matching the spec's new paragraph. Nothing about it is closed here.

### Minor — a test that enshrined a false statement

`allowlist.test.ts` asserted that bare `git log` is not allowed, on the theory that
`Bash(git log *)` means "any command starting with `git log `". The shipped comparator says
otherwise: it compiles a rule whose single `*` is a trailing ` *` into `( .*)?`, i.e.
`^git log( .*)?$`, so the arguments are optional and bare `git log` is covered. The test now
asserts the harness's behaviour, red first:

```
103 |   expect(allowsTool(...bash("git log"))).toBe(true);
error: expect(received).toBe(expected)
Expected: true
Received: false
```

and `entryAllows` matches `command === prefix || command.startsWith(prefix + " ")`. The
`git logs --all` and `skelcrew showcase 1` cases are unchanged and still fail the list, as do
all of criterion 9's negatives.

## Review round 2

Four findings, one of them a defect in the spec rather than in the code: the spec has been
amended with a closing paragraph on *A run ends, always* and a criterion 16, and this round
implements the amendment. Files touched:
`packages/daemon/src/runner/{run.ts,run.test.ts,claude.ts,allowlist.test.ts}`.
`runner.test.ts` stayed untouched; `bun run check` is green at 348 tests (344 before, plus the
four written here).

### Important — an ending replaced the question the agent raised

`end` called `core.requestAttention` unconditionally, and a card carries one attention record:
the playbooks tell a blocked agent to escalate with `skelcrew attention <id> "<the conflict>"`
and stop, so the common productive ending of a Code run under this spec was the run
overwriting the agent's question with `run finished; the agent's session ended`. The owner's
home view is the attention queue, so the question then survived only in the activity feed.

**The single check is inside `end` in `run.ts`** — the run's one exit, which every ending goes
through: normal, time limit, daemon stopping, driver error, no result, and error result all
reach it through `end`/`fail`, so there is no per-call-site rule to forget at the next call
site added. The comment is still posted every time; only the request is conditional:

```ts
core.comment(id, text, member.id);
if (core.getCard(id).attention === null) {
  core.requestAttention(id, { to: ownerId, note: text }, member.id);
}
```

No identity check, per the spec: the agent raises attention as the `runner` member too, so
`raisedBy` cannot tell its question from the run's own note — and does not need to, because
`isReady` only claims a card whose `attention` is `null`, so anything open here was raised
during this run. The red the change was written against, from the normal ending:

```
609 |   expect(card.attention).toMatchObject({ to: owner.id, note: "which base branch?" });
error: expect(received).toMatchObject(expected)
-   "note": "which base branch?",
+   "note": "run finished; the agent's session ended — the work is in …/data/worktrees/1",
```

and from the time-limit ending, which is the second call site — the kind of "next one down"
that the finding says this rule has been half-fixed at three times:

```
630 |   expect(core.getCard(1).attention?.note).toBe("the repository has no check command");
Expected: "the repository has no check command"
Received: "run aborted: time limit of 0.05 seconds reached"
```

Criterion 16's second half — "a run that raises no question ends exactly as criterion 2
describes" — is its own test, and it passed before the change as well as after: it is there to
hold the unchanged half of the behaviour, and the full-run test already asserts the same
handoff from the other side.

### Minor — an unbounded tool summary was dropped from the card

`summarizeTools` was the one card write with no cap, and a window holding enough distinct
`Bash` commands produced a comment over `COMMENT_MAX_BYTES` — rejected by the core, caught by
`post`, and reduced to a line on stderr, which "everything observable" makes a defect. It is
now cut to `COMMENT_MAX_BYTES / 4` and marked with `…`, the same budget and marker as
`runner.ts`'s `within` and `end`'s own note. Red, with a batch of 1000 calls: the summary was
not merely uncut but absent, and the comment in its place was the ending.

```
336 |   expect(summary.startsWith("ran 1000 tools: Bash `git log --oneline --skip=0`")).toBe(true);
Expected: true
Received: false
```

### Minor — a test documented CLI syntax that does not exist

`allowlist.test.ts` gave `skelcrew comment 1 -m 'on it'`, `skelcrew body 1 -f spec.md` and
`skelcrew attention 1 -m '…'` as the calls the list is there for. Prefix matching ignores the
tail, so the assertions passed either way — but this file is where the security boundary is
written down, and its examples are what the next reader takes for the CLI's shape. They are
now the real invocations: `comment <id> [<text>]` and `attention <id> <note>` take their text
positionally, `body <id> [--file <path>]` uses `--file`, as the playbooks already do.

### Minor — the cost of `settingSources: []` was recorded in one place only

The comment in `claude.ts` named the `CLAUDE.md` consequence and stopped there. Disabling
filesystem settings also makes a configured `model`, an `env` block, `apiKeyHelper`, hooks,
project skills and MCP servers inert for skelcrew runs — and an owner who authenticates
through `apiKeyHelper` rather than a stored login gets runs that die at spawn with a raw
harness error and nothing explaining it. `docs/MILESTONES.md` on `main` carries this; the
comment now carries it too, beside the isolation it pays for.

### Important — the failed-step handler raised without the guard (round 2, continued)

The guard above lived inside `end` in `run.ts`, which is every ending `run.ts` produces — but
not every ending. `runner.ts`'s `<step> failed` handler still called `core.requestAttention`
unconditionally, and a throw out of `runPlaybook` after the agent had escalated ends the card
there rather than in `run.ts`. §3 of `docs/plans/007-spike-retrospective.md` records this exact
rule being half-implemented five times in the parked spike, each round finding the next call
site with a good argument for why that site did not matter; its conclusion is that the cure is
construction, not vigilance.

**What was extracted.** `packages/daemon/src/runner/ending.ts` — one exported `endRun`, taking
the card, the members, the note and the release reason, and doing what an ending does: post the
reason as a comment always, raise the request only when `core.getCard(id).attention === null`,
release. `run.ts`'s `end` is now a four-line call to it (it still cuts the note to the comment
cap first), and `runner.ts`'s failed-step handler is the same call with `within(…)` and
`reason: "failed"`. No behaviour changed on the `run.ts` side; the guard is not copied
anywhere.

**The property.** The rule is no longer a check a call site performs but the body of the only
function in the runner that raises attention at the end of a run — `grep -rn requestAttention
packages/daemon/src/runner/*.ts` leaves two non-test hits: `ending.ts:45`, and `runner.ts:283`,
which is 006's no-playbook handoff. That one is not an ending: no agent has run in the worktree
when it fires, so there is no question it could replace, and its comment and its note are
different texts. It is now commented as such, pointing at `ending.ts` for everything that *is*
an ending. Routing it through `endRun` would mean widening the helper to two texts and
swallowing errors the outer handler currently reports, and `runner.test.ts` must pass
unmodified.

**Red.** A driver whose iterator throws when the run closes it — a throw past every ending
`run.ts` handles, so the runner's handler is what ends the card — with the agent escalating
first (`run.test.ts`, "a throw out of the run does not replace the agent's question either"):

```
664 |   expect(core.getCard(1).attention?.note).toBe("the spec contradicts CLAUDE.md");
error: expect(received).toBe(expected)
Expected: "the spec contradicts CLAUDE.md"
Received: "run playbook failed: the harness died on cleanup"
```

The failure's own text is asserted as a comment on the card in the same test, and that half
passed before the change as well as after: the comment is always posted. `bun run check` is
green at 349 tests (348 before, plus this one); `runner.test.ts` is untouched.

## Review round 3

Five findings, one of them a test that could not fail and one an amendment to the spec — the
paragraph *Two exceptions are the harness's own* now names a second harness divergence, and
this round writes it down. Files touched:
`packages/daemon/src/runner/{run.ts,run.test.ts,ending.ts,allowlist.ts,runner.ts}`.
`runner.test.ts` stayed untouched (`git status` still shows it unmodified); `bun run check` is
green at 350 tests (349 before, plus the one written here).

### Important — "the agent is never fed its own activity" had no discriminating test

The forwarding test asserted that no message reaching the agent contained `worktree ready` —
but that comment is posted by `runner.ts` *before* `runPlaybook` subscribes, and that test's
driver yields only a result, so the run posted nothing of its own while its subscription was
live. The guard in `run.ts` (`if (event.actorId === member.id) return;`) was therefore
unasserted: removing it left the whole suite green, and without it every excerpted turn and
every `ran N tools: …` summary would be delivered straight back to the live agent as a user
message mid-session.

The new case scripts a driver that yields a `text` event — which the run posts as a comment
authored by the `runner` member — and then reads its next input message, while the test posts
the owner's comment after that turn has landed. **The red was verified by actually deleting
the guard**, since "the test cannot fail" is the finding:

```
463 |   expect(received[1]).toBe("keep going");
error: expect(received).toBe(expected)
Expected: "keep going"
Received: "I have read CLAUDE.md."
```

The guard was then restored and the file re-run green. The existing test is kept unchanged: it
is not wrong, only insufficient — it holds the forwarding and the ordering halves of criterion
7, and this one holds the exclusion half.

### Minor — the refactor made `ownerId()` eager, outside the try

Extracting `endRun` moved the owner lookup into an argument list, so a throw from it skipped
the comment, the request *and* the release, leaving the card claimed until its lease expired —
where before it was caught, warned, and the card released. Practically unreachable (the core
seeds an owner and never removes one), which is also why there is no test for it: there is no
owner-less core to construct and no seam to inject one through. The fix is structural rather
than tested — `RunEnding.ownerId` is now `ownerId(): number`, resolved inside `endRun`'s
existing try, and both call sites pass `runner.ts`'s `ownerId` function rather than its result.

### Minor — the ordering test does not exercise the buffering, and now says so

`held` + `queueMicrotask` in `run.ts` cannot change the order the agent reads comments in:
`dispatch` in `core.ts` already documents and enforces that "listeners see events in `seq`
order even when one of them mutates from inside its callback", and it drains that queue in
`seq` order to every listener regardless of subscription order — so a listener pushing
straight into the inbox sees the same order, and no ordering test here can fail with the
buffer removed. **The buffering is kept and recorded as belt and braces**, rather than replaced
by a test that would fail without it, because no such test exists to write: the guarantee it
doubles belongs to the core. The comment in `run.ts` now says that in those terms, and the
test's own comment attributes the ordering to `dispatch` rather than to the run.

### Minor — the divergence claim was stronger than what was verified

`allowlist.ts` said the harness diverges from the fixed list in exactly one way
(self-approved read-only Bash commands). There is a second, now named by the spec: a tool that
defines no permission check of its own is allowed outright and never reaches `canUseTool`. The
mechanism is visible in the shipped binary — its tool builder falls back to a default
descriptor whose check is `checkPermissions:(e,o)=>Promise.resolve({behavior:"allow",updatedInput:e})`
— and the module comment now lists three divergences with the class of each: the first is this
module erring wide about compound commands, the second is what a *listed tool's arguments* may
be, the third is *which tools* run unprompted. The write path is not in the third class
(`Write`, `Edit` and `Bash` all carry their own rule-matched checks); bookkeeping and
sub-agent tools are. Wording only; nothing about the boundary changed.

### Minor — 006's handoff is exempt on "nothing has run", not on "nothing can be waiting"

`runner.ts`'s no-playbook handoff still calls `core.requestAttention` directly, which is
correct there and stays. But the reason is narrower than it looks: three awaits in git sit
between the claim and that point, so an owner who raised their own request in that window
would have it replaced. `ending.ts`'s header now records exactly that, so whoever next touches
that path adopts the guard rather than inheriting the exemption as settled.

### Minor — the ending note was cut without a marker

`end` in `run.ts` used `cutBytes`, while every other card write in this change cuts *and*
marks. The only note that can reach 4 KB is `run failed: ${driverError}`, so a verbose harness
error was amputated mid-sentence with nothing saying so — the defect round 2 fixed for tool
summaries. It now uses `cutMarked`, the same budget and `…` marker as `summarizeTools` and
`runner.ts`'s `within`.
