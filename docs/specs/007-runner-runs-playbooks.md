# 007 — Runner runs the phase playbooks

## Goal

Put a coding agent in the worktree 006 prepares, running the playbook for the card's phase
with the card as its input, and stream what it does back to the card. This is the milestone
where skelcrew starts producing work rather than preparing for it: a card moved into Spec
comes back with a spec on it and a request to approve; a card approved into Code comes back
with a branch, commits, a pull request, and a request to review. The three things the
prototype spike could not do become possible: the agent can ask a question and get an
answer on the card, the owner can talk to a running agent through comments, and a finish is
verified against the phase's artefact contract before anything is handed off.

## Current behavior

After 006 the runner (`packages/daemon/src/runner/runner.ts`) claims a ready card, prepares
`<repo root>/.skelcrew/worktrees/<id>` on `skelcrew/<id>-<slug>` from the default branch,
records the branch ref, and hands the card to the owner with `no playbook for <phase> yet`.
It re-checks its claim after every await and abandons with one comment if the card moved on.
It spawns nothing. The daemon has no dependency on any agent harness, and `AGENTS.md` says
skelcrew never calls a model.

The playbooks exist only as this repository's own workflow: `.claude/skills/spec/SKILL.md`
writes a spec from an idea with the section structure in `docs/specs/README.md`;
`.claude/skills/develop/SKILL.md` runs implement, independent review, independent
verification, and stops at a PR, delegating to `.claude/agents/{implementer,reviewer,
verifier}.md`. `AGENTS.md` names these as the reference implementation of the daemon's
built-in playbooks, to be extracted when the runner learns to run phases.

`docs/MILESTONES.md` carries the findings that shape this spec. From the spike:
fire-and-forget `claude -p` left an agent's question unanswerable, so the run must go
through the Agent SDK where `canUseTool` becomes an attention request and streaming input
lets comments reach the agent; the daemon posted "ready for review" on a branch with no
commits, so a finish must be verified against the artefact contract; target-repo permission
allowlists did not reach the sandbox, so the runner pre-allows the commands the playbook
needs. From the 001 run: a spec defect found mid-run is raised as an attention request
naming the conflict, never fixed by editing the spec to match the code. From 006: the CLI
resolves a linked worktree to its main repository, so `skelcrew` works from inside a runner
worktree; and a run must never write to a card whose claim it has lost.

The Agent SDK (`@anthropic-ai/claude-agent-sdk`, 0.3.x, driving the installed Claude Code
2.1.x) offers, verified in its documentation: `query({ prompt, options })` where `prompt`
may be an async iterable of user messages for streaming input; `options.canUseTool(toolName,
input) → { behavior: "allow" | "deny", … }`; `options.cwd`, `options.env`,
`options.allowedTools`, `options.systemPrompt: { type: "preset", preset: "claude_code",
append }`, `options.maxTurns`; and a message stream of `assistant`, `user`, `system`, and a
final `result` carrying success or failure and cost.

## Desired behavior

### A run with a playbook

- A ready card in Spec or Code is claimed and given a worktree exactly as in 006. Then,
  instead of the no-playbook handoff, the runner spawns one coding agent in the worktree
  with the phase's playbook and the card, and keeps the claim heartbeating for the run's
  duration. The 006 claim re-check continues through the run: if the claim is lost, the
  agent is aborted and the run is abandoned with one comment, as in 006.
- The agent sees: the playbook as an appended system prompt; the card's id, title, and body
  as its first user message; `skelcrew` on its `PATH` as a shim that runs this daemon's own
  CLI; `SKELCREW_AS=runner` and `SKELCREW_DIR=<data dir>` in its environment, so every CLI
  call it makes lands on the card attributed to `runner` and reaches this daemon.
- While it runs, the card shows what it does. Each assistant text turn becomes a comment,
  truncated to 2 KiB with a marker; tool calls are summarized into one comment per thirty
  seconds ("ran 4 tools: Read ×2, Bash `bun test`, Edit"); the full message stream is
  appended as JSON lines to `<data dir>/runs/<id>-<started>.jsonl`, whose path is in the
  run's first comment. A card comment by any member other than `runner` while the run is
  live is forwarded to the agent as a user message.
- A tool use the agent's allowlist does not cover becomes an attention request to the owner:
  note `allow <tool> <one-line input>? (resolve with allow or deny)`, no moves. The run
  waits with the claim heartbeating. `skelcrew resolve <id> -m allow` (also `yes`, `ok`)
  allows; `deny`, `no`, or any other text denies, with the text as the reason the agent
  sees. If the request is resolved by a move instead, the run is aborted.
- The allowlist is `Read`, `Glob`, `Grep`, `Edit`, `Write`, `MultiEdit`, `Bash(skelcrew *)`,
  `Bash(git *)`, `Bash(gh pr *)`, `Bash(gh repo view*)`, plus `Bash(<first token> *)` for the
  first line of every fenced shell block in the target repo's `AGENTS.md` or `CLAUDE.md`,
  which is how `bun run check` is pre-allowed for this repo. Everything else asks.
- A run ends when the agent's session ends, when it exceeds the time limit (60 minutes,
  `SKELCREW_RUN_MINUTES` overrides), or when the claim is lost. The result is then verified
  against the phase's contract.

### Finish contracts

- **Spec.** The card's body was set during the run by `runner` and is non-empty. Then the
  runner raises attention to the owner with note `spec ready` and moves `["code"]`, and
  releases the claim with reason `finished`. Otherwise the run failed: comment `run finished
  without a spec`, attention with that note and no moves, release with reason `failed`.
- **Code.** The branch has at least one commit past its base, the worktree is clean, and
  the card's refs carry a `prUrl` set during the run (the playbook opens the PR itself with
  `gh pr create` and records it with `skelcrew refs`). Then the runner sets `commits` on the
  refs to the branch's new shas (newest first, at most the cap), raises attention with note
  `ready for review: <prUrl>` and moves `["pr"]`, and releases with reason `finished`. Any
  unmet condition is a failed run: a comment naming exactly which condition failed,
  attention with that note, release with reason `failed`. A dirty worktree is left in place.
- A run the agent ended with an error result, or that was aborted by the time limit, is a
  failed run with the error or the reason in the comment. A failed run never moves the card.
  An abandoned run (claim lost) posts only its one comment.

### Playbooks

- Two playbooks ship with the daemon as markdown files, `spec` and `code`, extracted from
  this repository's skills and agents and rewritten to address one agent working on a card:
  read the target repo's `AGENTS.md`/`CLAUDE.md` first; `skelcrew show <id>` for the card,
  `skelcrew comment` to report; for `spec`, write the spec with the sections from
  `docs/specs/README.md` and set it with `skelcrew body <id> --file`; for `code`, implement
  with failing tests first, run the repo's checks, review the diff in a fresh subagent
  context, verify, commit, push, `gh pr create`, and `skelcrew refs <id> --pr <url>`. Both
  say: if the card's spec is wrong, do not edit it to match the code; raise `skelcrew
  attention <id> "<conflict>"` and stop. Neither is ever written into the target repository.

### Configuration

- `SKELCREW_AGENT` selects the driver: unset or `claude` uses the Agent SDK; `none`
  restores 006's no-playbook handoff. The daemon's process tests use `none`.

## Implementation approach

### Where it lives

- `packages/daemon/src/runner/agent.ts` — the `AgentDriver` interface: `run({ cwd, env,
  systemPrompt, prompt, allowedTools, canUseTool, input, signal }) → AsyncIterable<AgentEvent>`
  where `AgentEvent` is a small union: `text`, `tool_use`, `tool_result`, `result`. This is
  the boundary tests fake. `claude.ts` — the SDK-backed driver, the only file importing
  `@anthropic-ai/claude-agent-sdk`. `none.ts` — the 006 behaviour.
- `packages/daemon/src/runner/run.ts` — one run: spawn, stream to the card, forward
  comments, handle `canUseTool` through attention, enforce the time limit, verify the
  contract, hand off or fail. `runner.ts` calls it where 006 posted the handoff.
- `packages/daemon/src/runner/allowlist.ts` — the fixed list plus the fenced-block scan.
- `packages/daemon/playbooks/spec.md`, `code.md` — read at startup; shipped in the package.
- `packages/daemon/src/runner/shim.ts` — writes `<data dir>/bin/skelcrew`, an executable
  script running `bun <absolute path to packages/cli/src/main.ts> "$@"`, at startup.
- Tests: `run.test.ts` with a scripted fake driver against a temp repo and an in-memory
  core, covering every branch of the run and both contracts; `allowlist.test.ts`;
  `shim.test.ts`; `claude.ts` has only a type-level check that it satisfies the driver
  interface, never a spawn. The process tests run with `SKELCREW_AGENT=none`.
- `packages/daemon/package.json` gains `@anthropic-ai/claude-agent-sdk` as its first and
  only dependency.

### Decisions resolved from repository context

- **The Agent SDK is a harness driver, not a model client.** `AGENTS.md` forbids LLM API
  keys, clients, and SDKs; `docs/MILESTONES.md` requires the Agent SDK for `canUseTool` and
  streaming input. These reconcile: the SDK spawns the owner's installed Claude Code under
  the owner's login, skelcrew passes it no key and has no model API access, and the
  dependency lives in one file behind an interface the rest of the daemon never sees
  through. This spec adds one sentence to `AGENTS.md` saying so, next to the constraint.
  The alternative, driving `claude -p --input-format stream-json` by hand, needs an MCP
  permission-prompt tool for approvals, which is more machinery for the same two features.
- **Identity is `runner` for the agent's CLI calls**, via `SKELCREW_AS`. Runs are
  disposable, identity is durable; the run is the subprocess, the member is the runner.
- **`SKELCREW_DIR` is set for the agent anyway.** 006 made discovery work from inside a
  worktree, but the variable costs nothing and removes a dependency on the `.git` file
  parsing for the one process that must never reach the wrong daemon.
- **A shim on `PATH` rather than teaching the playbook a path.** The playbooks say
  `skelcrew …`; the shim makes that true in any target repo. It needs `bun` on the owner's
  `PATH`, which the daemon itself already requires.
- **Excerpts on the card, transcript on disk.** `docs/MILESTONES.md`: output posted to the
  card is excerpts and status, never a code dump. A run log under the data directory is the
  runner's territory like the worktree; the card carries its path. Assistant text is what a
  reader wants; tool calls are batched so a busy agent does not post ten comments a minute.
- **Approval answers are words, not a new verb.** `resolve -m allow` reuses 010; a
  dedicated command would be a second vocabulary. The recognised words are in the note.
- **Pre-allow by scanning fenced blocks.** The milestone says playbooks know the repo's check
  commands from `AGENTS.md`; a fenced shell block's first token is the least surprising
  reading and matches this repo's `bun run check`. Anything the scan misses asks once.
- **The Code playbook does review and verify inside one session.** The repo's `/develop`
  spawns three subagents; Claude Code has the same Agent tool, so the playbook instructs the
  agent to review its own diff in a fresh subagent and verify in another. Cross-member
  review stays deferred to 008 as MILESTONES says.
- **The PR is opened by the playbook, verified by the runner.** `gh` runs under the owner's
  login in the agent's shell, as in `/develop`; the runner only checks the URL landed in
  refs and the commits exist. No credentials in skelcrew.
- **60 minutes, then abort.** A bound has to exist for an unattended process; the number is
  an environment variable because the right value depends on the repo.

## Acceptance criteria

1. `bun run check` exits 0 with new tests under `packages/daemon/src/runner/`; no test
   spawns a real agent; `packages/daemon/package.json` has exactly one dependency,
   `@anthropic-ai/claude-agent-sdk`.
2. With a scripted driver that emits two text turns and a `result`, and a Spec card, the run
   produces: the claim, a first comment naming the run log path, two comments with the
   turns' text, and, because the script also sets the body through the core as `runner`,
   the finish: attention `spec ready` with moves `["code"]`, release `finished`. The run log
   contains every driver event as JSON lines.
3. The same script without the body write ends in a comment `run finished without a spec`,
   attention with that note and no moves, release `failed`; the card is still in Spec.
4. A Code run whose script commits to the branch, leaves the worktree clean, and sets a
   `prUrl` ref ends with `commits` set on the refs, attention `ready for review: <url>` with
   moves `["pr"]`, release `finished`. Missing commits, a dirty worktree, or no `prUrl` each
   end as a failed run whose comment names that condition; the worktree is left in place.
5. A text turn over 2 KiB is posted truncated with a marker; five tool events within a
   second produce one summary comment listing them; the transcript file has all five.
6. A comment posted by the owner during a live run is delivered to the driver as a user
   message; a comment by `runner` is not.
7. A driver requesting a tool outside the allowlist causes an attention request whose note
   starts `allow Bash`; `resolve -m allow` returns allow to the driver and the run continues;
   `resolve -m no` returns deny with `no` as the reason; while waiting, the claim's expiry
   advances. Resolving by moving the card aborts the run and the claim is released by the
   move.
8. The allowlist contains the fixed entries and `Bash(bun *)` when the temp repo's
   `AGENTS.md` has a fenced block starting with `bun run check`; a repo without such a
   block gets only the fixed entries.
9. With the limit set to one second and a driver that never ends, the run is aborted (its
   signal fires), the comment says so, and the card is waiting on the owner.
10. Moving the card as the owner during a live run aborts the driver and the run posts one
    `run abandoned` comment and nothing else.
11. The environment passed to the driver contains `SKELCREW_AS=runner`, `SKELCREW_DIR`
    equal to the data dir, and a `PATH` whose first entry holds an executable `skelcrew`;
    running that shim with `--version` prints the CLI's version.
12. Both playbook files exist, are non-empty, mention `skelcrew attention` for a spec
    conflict, and are passed to the driver as the system prompt append for their phase.
13. `SKELCREW_AGENT=none` restores 006's behaviour; 006's tests pass with it.
14. `AGENTS.md` gains the sentence reconciling the SDK with the no-model-SDK constraint;
    `docs/MILESTONES.md` records the shim, the environment the agent gets, the excerpt
    rules, and the approval words.

## Tests

- Run: every branch above with the scripted driver, asserting on the card's activity, refs,
  attention, claim, the run log, and the temp repo's branch state.
- Allowlist: fixed entries, the fenced-block scan on `AGENTS.md` and `CLAUDE.md`, and a
  repo with neither.
- Shim: written once, executable, runs the CLI.
- Playbooks: present and wired.
- Process: 003's, 006's, and 009's tests under `SKELCREW_AGENT=none`.

Red for this spec is the run test failing because the runner still posts `no playbook`.

## Out of scope

- The full loop, cycle budgets, cross-member review, dry-run merges, and conflict bounces:
  008.
- Any second driver, or running two agents at once.
- Streaming partial text deltas to the card; turns are the unit.
- Cost or token reporting beyond what lands in the run log.
- Editing playbooks per repository; skelcrew ships them.
- A transcript viewer; the run log is a file.
