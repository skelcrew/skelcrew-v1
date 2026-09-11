# 017 — A playbook's commands are checked against the harness that runs them

## Goal

Review round 1 of 014 found the Code playbook prescribing a command the harness asks about
outright, so every unattended Code run would have stopped on a permission question to satisfy
the one condition that decides whether the phase can finish. Nothing in the repository could
have caught it: `allowlist.ts` models the harness's permission rules for tests and records that
the model is deliberately *looser* than the harness about compound commands, and a playbook
line is exactly the kind of claim — "this runs unprompted" — that a loose model cannot make. The
test added afterwards hard-codes an operator set from the model's own prose: one more model of
the thing the bug hid behind.

This spec adds a check that runs every command the playbooks prescribe through the harness's
own permission evaluation — the pinned binary, not a model of it — and fails when one would
ask. It is a guard on the playbooks' ergonomics, not a boundary, and it lives beside the
definition of done rather than inside it: run when a playbook or the SDK pin changes, which the
existing version-pin test already signals.

## Current behavior

- The harness exposes no way to evaluate a permission without a tool call proceeding.
  `canUseTool` is invoked only when the evaluation flow resolves to a prompt, and a `PreToolUse`
  hook runs before the flow and short-circuits it. Verified against the pinned SDK's types and
  its documentation for this spec.
- The pinned SDK (`@anthropic-ai/claude-agent-sdk@0.3.266`, `claude` 2.1.266) supports
  `permissionMode: "dontAsk"` — "deny anything not pre-approved instead of prompting" — and its
  result message carries `permission_denials`, documented as *the authoritative record* of what
  was denied. The binary honours `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`.
- `packages/daemon/src/runner/claude.ts:121-162` builds the SDK options a run uses:
  `allowedTools` and `disallowedTools` from `allowlistFor`, `canUseTool`, `permissionMode:
  "default"`, `settingSources: []`, and `env` from `agentEnvironment`.
- `packages/daemon/src/runner/playbooks.test.ts:229-255` harvests the commands both playbooks
  prescribe (`prescribed()` for fenced lines, `commandsNamed()` for those plus inline spans
  starting with a command word) and, at `:295`, rejects any carrying a shell operator — the
  operator set transcribed from `allowlist.ts`'s prose.
- `allowlist.ts`'s maintenance contract above `TRANSCRIBED_FROM` names four transcriptions
  that age and three responses to a failure. "Re-verify" there means extracting functions from
  the binary by hand, which is how every 013 and 014 review round did it: a method, not a test.
- `bun run check` is the definition of done (`CLAUDE.md`), and tests never spawn a real coding
  agent or call an external service.

## Desired behavior

**A command the playbooks prescribe runs unprompted in the real harness, or the check says
which one does not.** `bun run check:harness` spawns the pinned harness against a local stub
that plays the model, emits each prescribed command as a `Bash` tool call, and reads the
result's `permission_denials`. Every instructed command must execute — appear as a tool result,
not as a denial — and the check fails naming any that was denied, with the reason the harness
reports for it. (In the pinned SDK the result's `permission_denials` carries the tool, its
`tool_use_id` and its input, and the reason lives on the `system`/`permission_denied` message
the stream emits, documented as best-effort; the check pairs the two by `tool_use_id` and says
"no reason reported" when the message did not arrive. The spec as approved said
`decision_reason` was on the result; it is not.)

**"Instructed" is narrower than "named", and has to be.** The playbooks name commands they
*forbid* — `skelcrew mv`, `claim`, `release`, `archive`, `resolve`, `git commit --no-verify` —
in the paragraphs that forbid them, and the harness denies five of those by design (013's rule
4). They name bare nouns (`skelcrew`, in "the `skelcrew` CLI") and heredoc bodies. And an
instruction's `<id>` placeholder is a shell redirection: unsubstituted, `skelcrew show <id>` is
refused for its target and `skelcrew show <id> --json` **executes**, creating a file named
`--json`. So the list the check runs is the list the playbook test already checks for
criterion 11 of 013: commands from the paragraphs that instruct, with a command word and an
argument, placeholders filled — `instructedCommands()`, defined beside the harvesters — plus
the fenced `bun run check` the scan contributes and the control. Every exclusion is pinned by a
test so the narrowing cannot widen silently.

**And every entry of the fixed list itself, with a representative argument.** The playbook's
"pre-allowed, so they run unprompted" paragraph is excluded from `instructedCommands()` on the
argument that checking it against a model derived from the same list proves nothing. That
argument is true of `playbooks.test.ts` and **false of this check**, which asks the binary — and
the entries a Code run's artefact contract depends on (`git add`, `git commit`, `gh pr create`,
`gh pr diff`, `gh pr comment`, `gh repo view`) are instructed only in prose, so `instructedCommands()`
never yields them. The check therefore also runs each `FIXED_ALLOWLIST` `Bash(...)` entry once,
with a representative argument for a wildcard entry (`git add -A`, `git commit -m "a message"`,
`gh pr create --title "a title" --body "a body"`) and verbatim for an exact one, so that a green
run means what it is for: no command the runner pre-allows would ask. The representative
arguments are one list beside the control, and a fixed-list entry with no representative fails
the check rather than being skipped.

**The check can fail.** A control command that the harness must ask about — `git push origin
HEAD:main` — is included and must appear in `permission_denials`. A check that cannot fail is
decoration; this one proves its own teeth on every run.

**The options under test are the run's options.** The check builds its SDK options through the
same function the runner uses, with a real temporary worktree and a target repository whose
`AGENTS.md` fences `bun run check`, so `allowlistFor`'s fixed list, its anchored `Edit` rule,
its deny rules and its scanned entry are all what the harness evaluates. Only four things are
overridden, and they are named: `permissionMode` is `dontAsk`; `env` gains the stub's
`ANTHROPIC_BASE_URL` and a dummy `ANTHROPIC_API_KEY`; `HOME` is a temporary directory; `PATH`
begins with a directory of stub executables.

**Nothing runs and nothing leaves the machine.** The stub model listens on `127.0.0.1` only.
The stub `PATH` holds executables named for every command word the playbooks use — `git`,
`gh`, `skelcrew`, `bun` — that exit 0 and print nothing, so a pre-allowed command "executes"
without touching a repository, a forge, or the daemon. The owner's login and settings are not
in reach: `HOME` is empty, `settingSources` is already `[]`, and non-essential traffic is off.
The check fails closed if the stub saw no request — a harness that reached something other
than the stub is a failed check, not a passed one.

**It is not part of `bun run check`.** The file is not collected by `bun test`, and
`CLAUDE.md`'s definition of done gains one sentence saying when to run it: after changing a
playbook, or when the SDK version-pin test fails. `allowlist.ts`'s maintenance contract names
it as what "re-verify" now means for the flag tables and the operator set.

**One list of commands.** The check and `playbooks.test.ts` harvest prescribed commands with
the same function; there is no second harvester.

## Implementation approach

### Where it lives

A file under `packages/daemon/src/runner/` whose name `bun test`'s default pattern does not
match — the implementer chooses the suffix — run by a root `check:harness` script that names
the file explicitly. The harvesters `prescribed()` and `commandsNamed()` move out of
`playbooks.test.ts` into a small shared test helper both files import, so criterion 8's "one
list" is a fact about the code rather than a discipline.

### The stub model

A `Bun.serve` on `127.0.0.1` with an ephemeral port, answering `POST /v1/messages` with a
streamed Messages-API response: for a request whose last message is the prompt, a single
`tool_use` block naming `Bash` with `{ command }`; for a request whose last message carries a
`tool_result`, an `end_turn` with a short text. One harness session per command keeps the
attribution simple and is the recommended shape; the implementer may batch if startup cost
proves prohibitive, provided each denial is still attributed to its command. The stub records
every request it receives.

The SSE event sequence the pinned binary expects — `message_start`, `content_block_start`,
`content_block_delta` with `input_json_delta`, `content_block_stop`, `message_delta` with a
`tool_use` stop reason, `message_stop` — is the one unverified-by-reading part of this spec.
**The implementer verifies first**, with one command, that the pinned binary accepts the stub
and emits a tool call, before building the rest. If the pinned binary refuses to run against
a stub endpoint at all — a login check that cannot be satisfied with a dummy key — the
implementer stops and reports rather than working around it, because the workaround would be
a real login, which this spec forbids.

### Running the harness

Through `claude.ts`'s option builder, called with the same inputs a run gives it — a temporary
target repository with a fenced `bun run check` in its `AGENTS.md`, a worktree created the way
`runner.ts` creates one, `allowlistFor`'s output for that worktree — and the four overrides
above applied after. `canUseTool` is supplied and must never be called: under `dontAsk` a
prompt is a denial, and a call reaching `canUseTool` is itself a failure of the check, since
it means the mode was not honoured.

### The stub `PATH`

Built per run in a temporary directory from the set of first words in the harvested commands,
plus a shell the harness's Bash tool can find. `PATH` is that directory followed by the system
directories the shell needs and nothing from the owner's environment.

### The records that change

- `CLAUDE.md`, *Definition of done*: one sentence naming `bun run check:harness` and when to
  run it.
- `allowlist.ts`, the maintenance contract: "re-verify" for `SAFE_GIT_FLAGS` and for the
  operator set means running this check; the extraction-by-hand method stays described as the
  fallback when the check itself is what has broken.
- `playbooks.test.ts:295`'s operator-set test stays: it is fast, runs on every check, and
  catches the common case; this spec is what catches the case it cannot.

### Resolved from context

Opt-in rather than in `bun run check`: the owner's decision, for the reasons in the Goal. The
control command is `git push origin HEAD:main` because 013 names it as the example of what
must ask, and it is not on any list. Stub binaries rather than a sandbox because the check's
question is "would this ask", not "what would this do"; the command's effect is not under test
and must not happen.

## Acceptance criteria

1. `bun run check` passes, and does not spawn the harness: the check file is not collected by
   `bun test`, and no test under `packages/` starts a `claude` process.
2. `bun run check:harness` exists as a root script, runs the check file explicitly, and passes
   against the pinned SDK with the two playbooks as they are.
3. For every command `instructedCommands()` yields from both playbooks — plus one
   representative command per `FIXED_ALLOWLIST` `Bash(...)` entry, the fenced `bun run check`,
   and the control — the harness executes it: a tool result that is not an error, not a
   denial, under the run's own options with the named overrides. A fixed-list entry with no
   representative fails the check. A command the harness denies fails
   the check, naming the command and the reason the harness reported (or that none was). What
   `instructedCommands()` excludes relative to `commandsNamed()` — forbidden verbs, bare
   nouns, heredoc bodies, unfilled placeholders — is pinned by a test.
4. `git push origin HEAD:main` appears in `permission_denials` on every run of the check, and
   the check fails if it does not.
5. The scanned entry is exercised: `bun run check` is fenced in the temporary repository's
   `AGENTS.md`, and `bun run check` as a tool call executes.
6. No request leaves the machine: the stub is bound to `127.0.0.1`; the check fails if the stub
   recorded no request; `HOME` is a temporary directory containing no login; the owner's
   `ANTHROPIC_API_KEY`, if set, is not in the harness's environment.
7. No prescribed command has an effect: every executable on the stub `PATH` exits 0 and writes
   nothing, and the temporary repository is unchanged after the check.
8. `prescribed()`, `commandsNamed()` and `instructedCommands()` are defined once, in one module
   outside any test file, and both the check and `playbooks.test.ts` take their command lists
   from it: no second harvester exists, and `instructedCommands()` yields exactly what the
   playbook test's own harvester yielded before the move.
11. `claude.test.ts`'s assertion that exactly one source file imports the SDK becomes an exact
    two-element list — `claude.ts` and the check — and a second assertion pins that nothing the
    daemon runs imports the check. This is the one existing assertion the spec changes; it
    could not stay as written, since the check must import the SDK to spawn the harness.
9. `CLAUDE.md`'s definition of done names `check:harness` and when to run it, and
   `allowlist.ts`'s maintenance contract names it as what re-verifying now means.
10. `canUseTool` is never called during the check; a call to it fails the check.

## Tests

The check is itself the test, and it is not run by `bun test`. What `bun test` covers:

- The stub model, in isolation: given a prompt it emits one `Bash` tool call with the command;
  given a tool result it ends the turn; it records requests. Against a plain HTTP client, no
  harness.
- The harvesters, after the move: `playbooks.test.ts`'s existing assertions pass unchanged
  through the shared helper.
- The stub `PATH` builder: every first word of the harvested commands has an executable; each
  exits 0 with no output.
- The check's own pass/fail logic against a scripted `permission_denials`: a listed prescribed
  command fails it; a missing control command fails it; a clean run with the control denied
  passes.

Criteria 2–7 and 10 are established by running `bun run check:harness`, and the run record
under `docs/plans/` carries its output.

## Out of scope

- **Making the check part of `bun run check`.** Decided against; the trigger is a playbook
  change or the version-pin test failing.
- **Checking commands the scan adds for repositories other than this one.** The scan's grant is
  the target repository's; this check exercises the mechanism with one fenced command.
- **Verifying the harness's *file* rules** — the `Edit` anchor, the `.git` deny, symlinks. Those
  were verified by extraction during 013 and are covered by `allowlist.test.ts`'s model with
  its divergences recorded; a stub model emitting `Write` calls is a natural extension and a
  separate spec.
- **A sandbox for the commands.** Their effect is not under test.
- **Replacing `playbooks.test.ts`'s operator-set test.** It stays as the fast path.
