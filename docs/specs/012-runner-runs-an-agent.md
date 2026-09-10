# 012 — The runner spawns an agent and the card shows what it does

## Goal

The runner prepares a worktree and then hands the card back, because it has nothing to run in
it. This spec puts a coding agent in that worktree, running the playbook for the card's phase,
and streams what the agent does onto the card as it works.

After this, a card moved into Spec is picked up, an agent writes the spec onto it, and every
turn and tool call is visible on the card while it happens. That is the first time skelcrew
does the thing it exists to do — and the first time it touches a subprocess, so the boundary
where that happens is the whole design.

This is the second of four specs replacing 007, which built all of this at once and needed
eight review rounds. `docs/plans/007-spike-retrospective.md` records what that bought; §1 lists
what it settled and this spec should not reopen, and §2 lists domain facts each of which cost a
round to learn.

## Current behavior

- `startRunner` (`packages/daemon/src/runner/runner.ts:108`) watches for claimable cards,
  claims one at a time as the `runner` member, resolves an explicit base branch, creates a
  branch and a worktree, and then — having no playbook — sets `branch` on the card, comments
  `worktree ready at <path> on <branch> (from <base>)`, raises an attention request reading
  `no playbook for <phase> yet; work in <path>`, and releases with reason `no playbook`
  (`runner.ts:242-251`). That is the seam this spec fills.
- A failed step becomes a comment `<step> failed: <error>`, the same text as an attention
  request, and a release with reason `failed` (`runner.ts:266`).
- `packages/daemon/src/runner/` holds only `runner.ts`, `git.ts` and `slug.ts`. There is no
  agent boundary, no driver, no shim, and no playbook.
- `packages/daemon/package.json` has one dependency, the `@skelcrew/shared` workspace link.
  No model SDK is installed anywhere.
- The daemon starts the runner in `packages/daemon/src/main.ts:42`, disabling it when the data
  directory is not inside a git repository, and awaits `runner.stop()` on shutdown (`:55`).

## Desired behavior

**A queued card in a claimable phase is run, not handed back.** The runner claims it, prepares
the worktree exactly as it does today, then spawns a coding agent in that worktree with the
playbook for the card's phase as its instructions and the card as its first message.

**Everything the agent does appears on the card while it happens.** Its assistant turns land as
comments, excerpted rather than dumped: text over a size limit is cut on a character boundary
and marked, with a pointer to the full record. Its tool calls land as periodic batched
summaries — `ran 5 tools: Read ×2, Bash \`bun test\`, Edit, Grep` — never as a code dump, and
the last partial batch still lands when the run ends.

**The full stream is recorded, not the projection of it.** Every message the agent's harness
produces is written to a run log as it arrives, whether or not it shows anything on the card.
The card's first comment names the log's path. A run log is never truncated or shared: two runs
of the same card starting in the same second get separate files.

**Comments reach a running agent.** A comment posted on the card by any member other than the
runner is delivered to the live agent as a message, in order. The runner's own comments are not
— an agent must not be fed its own activity.

**A tool the agent is not pre-allowed is refused, and the refusal is visible.** The agent is
told why, and the card shows that it happened. Asking the owner instead of refusing is 013.

**A run ends, always.** It ends when the agent's session ends, when a time limit is reached,
when the daemon stops, or when the claim is lost — and in every case the card is left in a
state a member can act on, with the reason on the card. When the agent's session ends normally,
the card is handed to the owner the way 006 hands it back today: a comment, an attention
request, and a release. Verifying that the agent produced anything is 014.

**An ending never replaces a question the agent raised.** The playbooks tell an agent that is
blocked to escalate with `skelcrew attention` and stop, and under this spec — where nothing may
be written — that is a Code run's *expected* productive ending, not an edge case. A card carries
one attention record, so a run that raises its own over the agent's would leave the owner's
queue showing a generic "the session ended" note on the one card with a real question on it. So
the ending's comment is always posted, and its request is raised only when nothing is already
waiting. No identity check is involved or possible: the agent raises attention as the `runner`
member too, so `raisedBy` cannot distinguish them. It does not need to — the runner only claims
a card whose attention is `null`, so anything open at the end of a run was raised during it.

**The daemon still calls no model.** It spawns a subprocess under the owner's own harness login
and holds no credentials. `SKELCREW_AGENT` selects which driver: `claude` to spawn a real
agent, `none` to keep 006's behaviour exactly. An unrecognised value stops the daemon at
startup rather than guessing.

## Implementation approach

### The boundary

One interface in a new `packages/daemon/src/runner/agent.ts`, with everything harness-specific
behind it. This shape is carried over from the 007 spike, where it survived eight review rounds
unchanged:

```ts
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; text: string; isError?: boolean }
  | { type: "result"; ok: boolean; error?: string };

export type ToolDecision = { behavior: "allow" } | { behavior: "deny"; message: string };

export interface AgentRunOptions {
  cwd: string;
  env: Record<string, string>;
  systemPrompt: string;
  allowedTools: string[];
  canUseTool(tool: string, input: Record<string, unknown>): Promise<ToolDecision>;
  input: AsyncIterable<string>;
  log(entry: unknown): void;
  signal: AbortSignal;
}

export interface AgentDriver {
  run(options: AgentRunOptions): AsyncIterable<AgentEvent>;
}
```

`canUseTool` is part of the boundary now even though this spec only ever denies through it, so
that 013 changes an implementation rather than the interface.

`none.ts` turns `SKELCREW_AGENT` into a driver choice. `claude.ts` is the only file in the
repository that imports the harness SDK; it translates SDK messages into `AgentEvent`s and,
critically, **writes each message to `log` on arrival, before projecting it**. §2 of the
retrospective records why: a transcript built from display events silently loses whole message
kinds that display nothing, and duplicates messages carrying several blocks.

The SDK is the single external dependency of `packages/daemon`, pinned exactly. A `bunfig.toml`
at the repository root sets `[install] peer = false` so the SDK's peer packages — which include
an actual model client — are never installed. That this works is not assumed: criterion 11
requires it be shown.

### The shim

`shim.ts` writes an executable `skelcrew` into `<data dir>/bin` and puts that directory first
on the spawned agent's `PATH`, with `SKELCREW_AS=runner` and `SKELCREW_DIR` in its environment,
so the agent reaches skelcrew through the same CLI a human uses and needs no flags. The shim
must `exec` this daemon's own `process.execPath`, not a `bun` found on `PATH` — under launchd
there may not be one.

### The run

`playbooks.ts` reads `packages/daemon/playbooks/{spec,code}.md` at startup and refuses an empty
one, so a broken install fails at boot rather than mid-run. Playbooks ship with skelcrew and are
never written into the target repository; the target repo contributes its own conventions
through its `AGENTS.md`/`CLAUDE.md`, which both playbooks instruct the agent to read first.

`run.ts` owns one run: create the log, spawn through the driver, consume its events, post
excerpts and batched tool summaries, forward comments in, enforce the time limit, and finish.
`runner.ts` calls it where it posts the no-playbook handoff today, and keeps that handoff
verbatim when it has no driver, so 006's tests pass unchanged.

Two mechanisms the spike proved necessary, both from retrospective §2:

- **Run log paths must be unique by construction.** A second-resolution timestamp collides for
  two runs of one card, and opening the file truncates the earlier run's transcript while its
  card comment still points at it. Create exclusively and resolve a collision; do not merely
  add resolution.
- **Comments arriving in a single core dispatch must be held and flushed in order**, and the
  runner's own comments filtered out before forwarding.

### What may run without asking

This is a security boundary, so it is named exactly rather than described. The fixed list for
this spec is **read-only tools plus the CLI verbs the playbooks use for their own bookkeeping**:

```
Read, Glob, Grep
Bash(skelcrew show *), Bash(skelcrew comment *), Bash(skelcrew body *), Bash(skelcrew attention *)
Bash(git log *), Bash(git status *), Bash(git diff *), Bash(git show *)
```

Everything else — every write tool, every other `skelcrew` verb, every other `git` subcommand,
`gh`, and any other command — reaches `canUseTool` and is denied.

Three rules behind that list, each from a defect the spike shipped and had to fix:

1. **The wildcard goes after the subcommand, never before it.** `Bash(x *)` matches every
   command beginning with `x`, so `Bash(git *)` would pre-allow `git push origin HEAD:main` and,
   because a wildcard before the subcommand also matches inserted options, `git -c <anything>
   log` — arbitrary execution. Each git verb above is listed separately for that reason.
2. **The CLI is allowed verb by verb.** `mv`, `claim`, `release`, `archive` and `resolve` are
   absent deliberately: they would let the agent move its own card past a gate. `body` is
   present because writing the spec onto the card is the Spec phase's whole output.
3. **No write, network or history-editing tool is pre-allowed at all** in this spec. `Write`,
   `Edit`, `Bash(git commit …)`, `Bash(git push …)` and `gh` are 013's business, together with
   asking.

**The run must not inherit permissions from anywhere else.** The harness loads
`~/.claude/settings.json`, the target repository's `.claude/settings.json`, and its
`settings.local.json` by default, merges their `permissions.allow` rules into the same rule set
as the list above, and matches them *before* `canUseTool` is consulted — so a tool allowed there
is never denied, never asked about, and never appears on the card as refused. A target
repository could therefore grant an unattended run `Write`, `Edit` or `git push` by committing a
settings file. The driver must disable filesystem settings explicitly (the SDK's
`settingSources: []`, documented as "disable filesystem settings"), so the effective permission
set is exactly `allowedTools` plus `canUseTool`. This is part of the same boundary as the list
and is not a detail: a list that another file can widen is not a list.

**Two exceptions are the harness's own, and cannot be closed here.** Claude Code self-approves a
set of read-only Bash commands (`ls`, `cat`, `grep`, `find` without `-exec`, and similar) — after
rule matching and before it would otherwise ask — so those never reach `canUseTool`. Separately,
a tool that defines no permission check of its own is allowed outright by the harness's default
descriptor and never reaches `canUseTool` either; the write path is not among them (`Write`,
`Edit` and `Bash` all carry rule-matched checks), but bookkeeping and sub-agent tools are. The
implementation must record which class each divergence is, and must not claim the fixed list is
the complete set of what runs unprompted. That is a documented divergence from
the list rather than a hole this spec opens: `Read` is itself pre-allowed above, so the agent
can already read any file the owner can. Whether an unattended run should have unbounded read
access at all is a real question, and it belongs to 013 alongside asking — where deny rules and
the harness's policy tier are available. What matters here is that the divergence is written
down rather than contradicted: any claim that the fixed list is the *complete* set of what runs
unprompted would be false.

The consequence is deliberate and should be stated in the playbooks: **a Spec-phase run works
end to end under this list**, and a Code-phase run will hit denials until 013 gives the agent a
way to ask. That is why this spec is worth shipping alone, and why the denial has to be visible
rather than silent.

## Acceptance criteria

1. `bun run check` passes: Biome, `tsc` per package, and the full suite. No test spawns a real
   coding agent or calls a model.
2. With a driver configured, a card moved into Spec is claimed, and the run's first comment on
   the card contains the path of its run log.
3. The agent's assistant turns appear as comments on the card in order. A turn longer than the
   comment limit is cut on a character boundary — never mid-character — and marked, and the
   marker points at the run log.
4. Tool calls appear as batched summaries naming each tool, with `Bash` calls showing their
   command and other tools counted. A batch still pending when the run ends is posted.
5. The run log contains every message the driver received, once each, in arrival order —
   including messages that produce no comment on the card. A message carrying several
   displayable blocks appears in the log once, not once per block.
6. Two runs of the same card whose start times fall in the same second write to different log
   files, and the first run's log is still readable in full after the second starts.
7. A comment posted on the card by a member other than the runner reaches the running agent as
   a message; a comment posted by the runner itself does not. Two comments arriving in one core
   dispatch reach the agent in the order they were posted.
8. A tool outside the fixed list is denied: the agent receives a denial carrying a reason, and
   the card shows that the tool was denied and which one.
9. Every tool in the fixed list is matched by it, and each of these is **not**:
   `git push origin HEAD:main`, `git commit -m x`, `git -c core.pager=x log`, `skelcrew mv 1 code`,
   `skelcrew release 1`, `gh pr create`, `Write`, `Edit`.
10. A run that exceeds `SKELCREW_RUN_MINUTES` is aborted: the driver's signal fires, the card
    carries a comment naming the limit, and the card is left waiting on the owner. `stop()`
    during a live run resolves within a few seconds and leaves the card waiting, not silently
    re-runnable.
11. The harness SDK is imported by exactly one file. With `bunfig.toml`'s `peer = false` and a
    clean install, the SDK's peer packages — `@anthropic-ai/sdk` among them — are absent from
    `node_modules`, and the daemon still starts with `SKELCREW_AGENT=claude`.
15. The driver disables filesystem settings, so a `permissions.allow` rule in a user, project or
    local `.claude/settings.json` cannot widen what the run may do without asking. Asserted on
    the options the driver builds, which is the one part of the real driver testable without
    spawning anything.
16. An agent that raises a question with `skelcrew attention` and then ends its session still has
    that question as the card's open request afterwards, and the run's ending comment is on the
    card beside it. A run that raises no question ends exactly as criterion 2 describes.
12. `SKELCREW_AGENT=none` reproduces 006's behaviour exactly: the existing `runner.test.ts`
    suite passes unmodified, including its `no playbook` assertions. An unrecognised value
    stops the daemon at startup with a message naming the variable.
13. The spawned agent's environment is exactly `PATH` (with the shim's directory first), `HOME`,
    `SKELCREW_AS=runner` and `SKELCREW_DIR`. The shim is executable and works when run with a
    `PATH` that contains no `bun`.
14. Both playbooks exist, are non-empty, instruct the agent to read the target repository's own
    `AGENTS.md`/`CLAUDE.md` first, and tell it to raise a question with `skelcrew attention`
    rather than guess. Loading refuses an empty playbook at startup.

## Tests

Behavioral coverage against a scripted fake driver, asserting what a member sees on the card:

- A full Spec run: the exact activity sequence, the log path in the first comment, the turn
  comments, and the run log's parsed contents (criteria 2, 3, 5).
- Excerpting and batching, including the multi-byte boundary and the final partial batch (3, 4).
- Two runs in one second, with both logs read back from disk (6).
- Comment forwarding, runner-comment exclusion, and two comments in one dispatch (7).
- Denial: a scripted tool call outside the list, asserting both what the driver was told and
  what the card shows (8).
- The fixed list, asserted as a list and as matching behaviour, with each negative in criterion
  9 as its own case (9).
- Time limit and `stop()`, with injected limits so tests do not wait a minute (10).
- Driver selection, including the unrecognised value (12), and the spawned environment and shim
  execution (13).
- `claude.ts` is exercised for its message translation and its logging — a pure function over
  message literals, spawning nothing — including a message kind that displays nothing and one
  carrying several blocks (5). Its type conformance to `AgentDriver` is a compile-time check.
- `runner.test.ts` must pass **unmodified**; if a change to it seems necessary, that is a
  finding to report rather than an edit to make.

## Out of scope

- **Asking the owner for permission.** `canUseTool` exists in the boundary but only ever denies
  here. Routing a denial to an attention request, queuing several, and answering them is 013.
- **The allowlist scan of the target repository's instructions**, and every write, git-mutating,
  or `gh` permission. 013.
- **Artefact contracts and run endings.** Whether the agent actually produced a spec or a
  branch, what happens when the card is moved, archived, released or claimed under a live run,
  and the handoff carrying a phase move: all 014. This spec ends a normal run with 006's
  existing handoff shape.
- **Recording the committed spec path**, which 011 makes possible and 014 enforces.
- **A second real driver**, concurrent runs of different cards, cross-member review, and any
  cost or transcript UI.
