# 017 — A playbook's commands are checked against the harness that runs them

Run record for the implementation of `docs/specs/017-playbook-commands-are-checked-against-the-harness.md`.

## The gate, first

The spec's *Implementation approach* makes one thing a precondition: verify, with one command,
that the pinned binary accepts a stub endpoint and emits a tool call, before building anything
else — and stop if it refuses.

Command (a throwaway probe in the session scratchpad, not in the repository):

```
env -u ANTHROPIC_API_KEY bun run probe.ts
```

It started a `Bun.serve` on `127.0.0.1` answering `POST /v1/messages` with the SSE sequence the
spec names, and ran `query()` from the pinned SDK against it with `permissionMode: "dontAsk"`,
`settingSources: []`, `allowedTools: ["Bash(git status)"]`, a dummy `ANTHROPIC_API_KEY`, an empty
temporary `HOME`, and `ANTHROPIC_BASE_URL` pointing at the stub.

Result: **the binary accepts the stub.** It made `HEAD /api/hello` and two `POST /v1/messages`
requests, all to the stub; emitted the `Bash` tool call with `git status`; ran it (exit 128,
"not a git repository", which is the command executing); ended the turn on the `tool_result`;
and returned a result with `permission_denials: []`. `canUseTool` was called 0 times. No login
was needed.

So the rest of the spec is buildable.

## Plan

1. Move `prescribed()` and `commandsNamed()` out of `playbooks.test.ts` into a shared helper
   (`packages/daemon/src/runner/playbook-commands.ts`) that both the check and the test import.
2. Add `packages/daemon/src/runner/harness-check.ts` — a name `bun test`'s default pattern does
   not match — holding: the stub model, the stub `PATH` builder, the pass/fail logic, and a
   `main()` behind `import.meta.main` that builds a temporary repository and worktree, calls
   `allowlistFor` and `buildSdkOptions`, and runs one harness session per command.
3. Unit-test the stub model, the stub `PATH` builder and the pass/fail logic in
   `harness-check.test.ts`, and the moved harvesters where their assertions already live, in
   `playbooks.test.ts` — both collected by `bun test`, and spawning no harness.
4. Root script `check:harness`, naming the file explicitly.
5. Records: `CLAUDE.md`'s *Definition of done*, and `allowlist.ts`'s maintenance contract.

## Decisions the spec left open, and two places it is wrong

- **Which commands the check feeds the harness.** Criterion 3 says "every command
  `commandsNamed()` harvests". Harvested verbatim, that set includes the Code playbook's
  advertisement paragraph and its prohibitions — `skelcrew mv`, `skelcrew claim`,
  `skelcrew release`, `skelcrew archive`, `skelcrew resolve`, `git commit --no-verify` — which
  the playbook names in order to say they are *not* available, and five of which the harness
  must deny by design (rule 4 of `allowlist.ts`). It also includes the Spec playbook's heredoc
  *body* (`# <NNN> — <title>`, `…`, `SPEC`), which are not commands at all. So the check runs
  the commands the playbooks **instruct**, which is `commandsNamed()` with the two exclusions
  `playbooks.test.ts` already documents and applies for exactly this reason (the paragraphs that
  are not instructions, and the bolded prohibitions), plus the heredoc body. Every exclusion is
  pinned by a test naming the strings it drops, so a future drop is deliberate.
- **`decision_reason` is not on `permission_denials`.** In the pinned SDK, `SDKPermissionDenial`
  carries `tool_name`, `tool_use_id` and `tool_input` only; `decision_reason` is on the
  `system`/`permission_denied` message, which the same session emits. The check reads the result's
  `permission_denials` as the verdict (the SDK calls it the authoritative record) and pairs it by
  `tool_use_id` with that message for the reason.
- **The SDK-boundary test.** `claude.test.ts` asserts that exactly one file imports the SDK at
  runtime. The check file has to call `query()` with a `permissionMode` the runner's own builder
  hard-codes, so it is a second importer; the assertion is updated to name both files, and stays
  an exact list. A second test pins that nothing but its own unit test imports the check.

## What was built

- `packages/daemon/src/runner/playbook-commands.ts` — `prescribed()`, `commandsNamed()` (moved
  verbatim out of `playbooks.test.ts`) and `instructedCommands()`, which is `commandsNamed()`
  over the paragraphs that instruct, keeping only a command word with an argument, with
  `<…>` placeholders filled. Checked against the harvester it replaces: for both playbooks it
  yields the same commands `playbooks.test.ts`'s `commandsIn` did — nothing lost, nothing new,
  as a multiset. The *order* differs, since `commandsNamed` yields a playbook's fenced lines
  before its inline ones where `commandsIn` walked the document; nothing asserts on order.
- `packages/daemon/src/runner/harness-check.ts` — the stub model, the stub `PATH` builder, the
  pass/fail logic, and a `main()` behind `import.meta.main`.
- `packages/daemon/src/runner/harness-check.test.ts` — 13 tests over those parts; no harness.
- `package.json` — `check:harness`; `AGENTS.md` (`CLAUDE.md` is a symlink to it) — the sentence
  in *Definition of done*; `allowlist.ts` — what "re-verify" now means.

## The check's own output (round 1; superseded by the round-2 run below)

```
playbooks: spec, code
commands: 18 prescribed (the playbooks' own, and the repository's fenced `bun run check`), plus the control command
allowlist: pre-allowed from the repository's instructions: bun run check
stub executables: skelcrew, git, gh, bun
PATH: <scratch>/bin:<scratch>/data/bin:/usr/bin:/bin:/usr/sbin:/sbin
HOME: <scratch>/home, holding 0 files
the harness's environment: ANTHROPIC_API_KEY, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, HOME, PATH, SKELCREW_AS, SKELCREW_DIR, and the stub's ANTHROPIC_BASE_URL, which is a fresh loopback port per session
ANTHROPIC_API_KEY: the dummy key; the owner's is set here and not passed on

ran     skelcrew attention PLACEHOLDER "PLACEHOLDER"
ran     skelcrew body PLACEHOLDER <<'SPEC'
ran     skelcrew show PLACEHOLDER
ran     git log
ran     skelcrew comment PLACEHOLDER "PLACEHOLDER"
ran     gh pr view --json url --jq .url
ran     skelcrew refs PLACEHOLDER --pr PLACEHOLDER
ran     skelcrew refs PLACEHOLDER --spec docs/specs/PLACEHOLDER-PLACEHOLDER.md
ran     git log PLACEHOLDER..PLACEHOLDER
ran     git status
ran     git diff
ran     git show
ran     git merge-base
ran     git rev-parse
ran     git push -u origin HEAD
ran     skelcrew show PLACEHOLDER --json
ran     skelcrew show
ran     bun run check
DENIED  git push origin HEAD:main — Permission to use Bash has been denied because Claude Code is running in don't ask mode

every one of the 18 commands under test runs unprompted in the harness, `git push origin HEAD:main` is denied, and the repository is unchanged
```

Exit 0. Run with `ANTHROPIC_API_KEY` set to a sentinel, which the stub never saw.

## Its teeth, proven

A fenced `git tag <version>` added to `code.md` for one run:

```
FAIL `git tag PLACEHOLDER` is denied by the harness — Bash: Permission to use Bash has been
denied because Claude Code is running in don't ask mode. IMPORTANT: …
```

Exit 1. The playbook was restored with `git checkout --`.

## Criterion 1, by execution

A sampling loop watched for a process matching the SDK's native binary
(`@anthropic-ai+claude-agent-sdk-darwin-arm64@0.3.266/…/claude`) for the whole of a run:
`bun test` (594 tests, 35s) → 0 samples with such a process; `bun run check:harness` → 172,
whose command line reads `… --setting-sources= --permission-mode dontAsk` with the run's own
`--allowedTools`, the anchored `Edit(//<worktree>/**)`, the scanned `Bash(bun run check *)` and
the two `--disallowedTools` `.git` rules.

# Round 2 — review round 1's findings

The spec was amended twice while round 1 was reviewed (`577053f`, `d7a5933`); both amendments
are implemented here.

## Important 2 — the fixed list is now run through the harness

`instructedCommands()` excludes the "Pre-allowed, so they run unprompted:" paragraph, and the
reason it gives is sound for `playbooks.test.ts` and false for this check: a model built from the
list proves nothing about itself, but *the binary* is not the list. Six entries a Code run's
artefact contract depends on — `git add`, `git commit`, `gh pr create`, `gh pr diff`,
`gh pr comment`, `gh repo view` — are instructed in prose only and were therefore never
evaluated. `FIXED_LIST_REPRESENTATIVES` now carries one command per `Bash(...)` entry (a
representative argument for a wildcard entry, the command itself for an exact one), the check
runs them with everything else, and `problemsIn` fails a run in two new ways: an entry no
representative covers, and a representative this run did not put through the harness.

## Important 1 — the loopback assertion is now about the socket

`startStubModel` composed `url` from the literal it passed to `Bun.serve`, so the assertion could
not see a bind to `0.0.0.0`. `hostname` and `port` are read back off the server (a server with
neither is an error, not a default), and the test asserts the read-back bind *and* that a
connection to this machine's own non-loopback address on the stub's port is refused.

## Minor 3, 4, 5, 6

- `executed` is now a non-error tool result carrying the stub's own `tool_use_id`
  (`ranTheCommand`), since a denial produces a tool result too.
- The import pin matches any specifier ending in `harness-check`, not the `./` spelling alone.
- `instructedCommands` blanks an excluded paragraph's content and **keeps its fence lines**, so
  an odd fence count in an excluded paragraph can no longer invert the in-fence state of
  everything after it.
- The stub records `authorization` and `proxy-authorization` beside `x-api-key`, `Bearer ` off,
  and any credential that is not the dummy fails the check.

## Red, and the cases that were green first

Every test added by this spec, and what it did before the code it covers existed. "Red" means it
failed on its assertion, not on an import.

Round 1, in `playbooks.test.ts` (against `instructedCommands` stubbed to `[]`):

| test | red? |
| --- | --- |
| every command the playbooks run goes unprompted (repointed at the new harvester) | red: `Expected: > 0  Received: 0` |
| the criterion-11 check reads the playbook's instructions (repointed) | red: `Expected to contain: "skelcrew show PLACEHOLDER"  Received: []` |
| the instructed commands are the playbook's commands, not its nouns, prose or prohibitions | red: `Expected to contain: "skelcrew body PLACEHOLDER <<'SPEC'"  Received: []` |

Round 1, in `harness-check.test.ts` (against a skeleton whose stub answered 500, whose `PATH`
builder wrote nothing and whose `problemsIn` returned `[]`) — 11 of the 13 rows below red, 2 green
first:

| test | red? |
| --- | --- |
| the stub answers a prompt with one Bash tool call carrying the command | red |
| the stub ends the turn on a tool result | red |
| the stub records every request it saw | red |
| every command word gets an executable that exits 0 and writes nothing | red |
| a prescribed command the harness denied fails the check | red |
| a control command the harness did not deny fails the check | red |
| a check that never ran the control command fails | red |
| a command the stub saw no request for fails the check | red |
| a command that reached canUseTool fails the check | red |
| a command that ended without executing and without a denial fails the check | red |
| a session where the harness presented a credential other than the dummy fails | red, after the export it needed was added (its first run was an import error, which is a broken test rather than a red one) |
| **the stub listens on the loopback address only** | **green first** — the skeleton already passed `127.0.0.1` to `Bun.serve`, and the assertion read a string built from that literal. This is the hole review round 1 found; the round-2 test below is the fix. |
| **a run where every prescribed command executed and the control was denied passes** | **green first**, vacuously: `problemsIn` returned `[]`. Its partner cases (the rows above) were all red, which is what gives it meaning. |

Round 1, in `claude.test.ts`:

| test | red? |
| --- | --- |
| the harness SDK is named by exactly one source file, imported by exactly two | red: the existing one-element assertion failed the moment the check imported the SDK (`+ "packages/daemon/src/runner/harness-check.ts"`), and was updated deliberately |
| **nothing the daemon runs imports the harness check** | **green first**: it asserts an existing fact. Made red on purpose in round 2 — see below. |

Round 2:

| test | red? |
| --- | --- |
| the stub listens on the loopback address **and refuses every other** | red: `Expected: "127.0.0.1"  Received: undefined` against the round-1 stub, which had no readable bind. Then re-run against the reviewer's break (`Bun.serve` bound to `0.0.0.0`) → `Expected: "127.0.0.1"  Received: "0.0.0.0"`. The connection half was checked to discriminate too: bound to `127.0.0.1`, `192.168.111.4:<port>` is **refused**; bound to `0.0.0.0` it is **answered**. |
| the stub records every request it saw, with the credentials it was given | red: `- credentials: ["the-dummy-key"]  + apiKey: "the-dummy-key"` |
| the stub records a credential in any of the three headers it could arrive in | red: `TypeError: undefined is not an object (evaluating 'stub.requests[0]?.credentials.toSorted')` — the field did not exist yet |
| the command ran when its own tool call came back as a result that is not an error | green first against the loose stub (`type === "user"`), which is the one case the old reading got right |
| a denied call did not run, however much of a tool result its refusal is | red: `Expected: false  Received: true` |
| another tool call's result is not this command running | red: `Expected: false  Received: true` |
| an excluded paragraph holding a lone fence does not swallow the instructions after it | red against the committed round-1 harvester: `Expected to contain: "git commit -m PLACEHOLDER"  Received: []` |
| every Bash entry of the fixed list has a representative command | red: `Expected: 14  Received: 0` against an empty representative list |
| a fixed-list entry whose representative is missing is named | red: `Expected ["Bash(git add *)"]  Received: []` |
| a fixed-list entry with no representative fails the check | red: `Expected: 1  Received: 0` |
| a representative the run never put through the harness fails the check | red: `Expected [ "`git add -A` is a representative…" ]  Received: []` |
| nothing the daemon runs imports the harness check (round 2 rewrite) | red on demand: with `import { CONTROL_COMMAND } from "../runner/harness-check";` temporarily in `runner.ts`, the round-1 regex passed and the round-2 one failed with `+ "packages/daemon/src/runner/runner.ts"`. The import was removed; `runner.ts` is unchanged in the diff. |

## `bun run check:harness`, round 2

```
playbooks: spec, code
commands: 30 (the playbooks' own instructions, one representative per fixed-list entry, and the repository's fenced `bun run check`), plus the control command
allowlist: pre-allowed from the repository's instructions: bun run check
stub executables: skelcrew, git, gh, bun
PATH: <scratch>/bin:<scratch>/data/bin:/usr/bin:/bin:/usr/sbin:/sbin
HOME: <scratch>/home, holding 0 files
the harness's environment: ANTHROPIC_API_KEY, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, HOME, PATH, SKELCREW_AS, SKELCREW_DIR, and the stub's ANTHROPIC_BASE_URL, which is a fresh loopback port per session
ANTHROPIC_API_KEY: the dummy key; the owner's is set here and not passed on

ran     skelcrew attention PLACEHOLDER "PLACEHOLDER"
ran     skelcrew body PLACEHOLDER <<'SPEC'
ran     skelcrew show PLACEHOLDER
ran     git log
ran     skelcrew comment PLACEHOLDER "PLACEHOLDER"
ran     gh pr view --json url --jq .url
ran     skelcrew refs PLACEHOLDER --pr PLACEHOLDER
ran     skelcrew refs PLACEHOLDER --spec docs/specs/PLACEHOLDER-PLACEHOLDER.md
ran     git log PLACEHOLDER..PLACEHOLDER
ran     git status
ran     git diff
ran     git show
ran     git merge-base
ran     git rev-parse
ran     git push -u origin HEAD
ran     skelcrew show PLACEHOLDER --json
ran     skelcrew show
ran     skelcrew show 1
ran     skelcrew comment 1 "a comment"
ran     skelcrew body 1 --file a-spec.md
ran     skelcrew refs 1 --pr https://example.invalid/pull/1
ran     skelcrew attention 1 "a question"
ran     git add -A
ran     git commit -m "a message"
ran     git push
ran     gh pr create --title "a title" --body "a body"
ran     gh pr diff --name-only
ran     gh pr comment 1 --body "a comment"
ran     gh repo view --json defaultBranchRef
ran     bun run check
DENIED  git push origin HEAD:main — Permission to use Bash has been denied because Claude Code is running in don't ask mode

every one of the 30 commands under test runs unprompted in the harness, `git push origin HEAD:main` is denied, and the repository is unchanged
```

Exit 0, with `ANTHROPIC_API_KEY=sk-ant-owner-sentinel` in the calling environment and the stub
seeing only the dummy. `bun run check`: 603 pass, 0 fail.

One run was instrumented to print `executed` per command, for Minor 3: every allowed command
reads `executed=true` and the denied control reads `executed=false`, where round 1 read it as
`true` because the refusal is itself a tool result. The instrumentation was removed.

# Round 3 — review round 2's findings

**APPROVED**, no Critical, no Important, eight Minors — all eight fixed. The spec was amended
again for Minor 5, twice: `fa2eb6e` corrected the count in *Desired behavior* and `1c4f425` the
second count of the same thing in *Implementation approach*, which the first correction missed.
Four amendments in all (`577053f`, `d7a5933`, `fa2eb6e`, `1c4f425`).

| # | finding | disposition |
| --- | --- | --- |
| 1 | SIGINT/SIGTERM orphaned a live `claude` and left a registered worktree; the stub was started outside the `try` | fixed: `RunState`/`letGo`, handlers for both signals, the stub started inside the `try` |
| 2 | the control was identified by string equality | fixed: `CommandOutcome.control`, tagged where the control is appended; a *prescribed* control is its own problem |
| 3 | the import pin required `from` | fixed: any quoted specifier naming the module |
| 4 | named members were pinned, not the difference set | fixed: `DROPPED` per playbook, compared after the same placeholder substitution through the exported `filled` |
| 5 | "four overrides" is five | fixed, matching the amended spec's wording |
| 6 | "any header it could arrive in" was a three-item list | fixed: reworded as a tripwire over three named headers, with the containment named |
| 7 | the maintenance contract miscounted and left `redirectionsIn` unassigned | fixed: model-by-model coverage in `allowlist.ts`, and both sentences name the fixed-list representatives |
| 8 | `cwd` was the `mkdtempSync` spelling while `editsIn` realpaths it | fixed: the scratch root is `realpathSync`'d, as `runner.ts` does |
| — | the "fourth reading of entry syntax" justification was a strawman | replaced with the real reasons: independence from the model, and `allowsTool`'s `xargs` widening |

## Red, round 3

| test | red? |
| --- | --- |
| a prescribed command that is the control command fails the check on its own account | red: `Expected to contain: "prescribes"  Received: "…is denied by the harness — Bash: dontAsk mode"` |
| two outcomes tagged as the control fail the check | red: `Expected to contain: "once"  Received: "…is denied by the harness…"` |
| an interrupt closes the live session and the stub and removes the scratch directory | red: `Expected: true  Received: false` against `letGo` stubbed empty |
| **an interrupt with nothing yet to let go of does nothing** | **green first**, vacuously — it asserts that the empty case does not throw, and the empty implementation did not throw either. Its partner (the row above) is what gives it meaning. |
| nothing the daemon runs imports the harness check (round-3 rewrite) | red on demand: with both `import "../runner/harness-check";` and `await import("./harness-check")` planted in `runner.ts`, the round-2 regex passed and this one failed with `+ "packages/daemon/src/runner/runner.ts"`. Both were removed; `runner.ts` is unchanged in the diff. |
| what the instructed list drops from the named list is exactly this, per playbook | **green first by nature** — it pins existing behaviour. Its teeth were then demonstrated: adding `"gh pr view --json url"` to `NOT_INSTRUCTIONS` (hiding a real instruction, which is exactly the hole Minor 4 names) made *only this test* fail, with `+ "gh pr view --json url --jq .url"` in the dropped set, while every named-member assertion stayed green. Reverted. |
| the stub records a credential in each of the three headers it reads (renamed from round 2) | unchanged behaviour; the rename and the comment are the fix |

## Minor 1, by hand

`bun packages/daemon/src/runner/harness-check.ts` in the background, signalled 2s in, three times:

```
SIGTERM exit=143 scratch-dirs-left=0 harness-children=0
SIGINT  exit=130 scratch-dirs-left=0 harness-children=0
SIGTERM exit=143 scratch-dirs-left=0 harness-children=0
```

What the unit test covers is `letGo`: the session closed, the listener refusing connections, the
directory gone. What only the hand runs cover is the signal plumbing itself, the exit codes, and
the absence of a `claude` child afterwards.

The grace period is measured, not guessed. At 750ms the directory came back between the removal
and the process exiting: a killed harness writes its own session transcript under the temporary
`HOME` as it goes down, and `find` showed exactly that one path recreated
(`home/.claude/projects/…/<uuid>.jsonl`) — no repository, no worktree. At 2500ms, three runs left
nothing at all. So the handler ends the session, waits, and *then* removes.

## `bun run check:harness`, round 3

```
playbooks: spec, code
commands: 30 (the playbooks' own instructions, one representative per fixed-list entry, and the repository's fenced `bun run check`), plus the control command
allowlist: pre-allowed from the repository's instructions: bun run check
stub executables: skelcrew, git, gh, bun
PATH: <scratch>/bin:<scratch>/data/bin:/usr/bin:/bin:/usr/sbin:/sbin
HOME: <scratch>/home, holding 0 files
the harness's environment: ANTHROPIC_API_KEY, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, HOME, PATH, SKELCREW_AS, SKELCREW_DIR, and the stub's ANTHROPIC_BASE_URL, which is a fresh loopback port per session
ANTHROPIC_API_KEY: the dummy key; the owner's is set here and not passed on

ran     skelcrew attention PLACEHOLDER "PLACEHOLDER"
ran     skelcrew body PLACEHOLDER <<'SPEC'
ran     skelcrew show PLACEHOLDER
ran     git log
ran     skelcrew comment PLACEHOLDER "PLACEHOLDER"
ran     gh pr view --json url --jq .url
ran     skelcrew refs PLACEHOLDER --pr PLACEHOLDER
ran     skelcrew refs PLACEHOLDER --spec docs/specs/PLACEHOLDER-PLACEHOLDER.md
ran     git log PLACEHOLDER..PLACEHOLDER
ran     git status
ran     git diff
ran     git show
ran     git merge-base
ran     git rev-parse
ran     git push -u origin HEAD
ran     skelcrew show PLACEHOLDER --json
ran     skelcrew show
ran     skelcrew show 1
ran     skelcrew comment 1 "a comment"
ran     skelcrew body 1 --file a-spec.md
ran     skelcrew refs 1 --pr https://example.invalid/pull/1
ran     skelcrew attention 1 "a question"
ran     git add -A
ran     git commit -m "a message"
ran     git push
ran     gh pr create --title "a title" --body "a body"
ran     gh pr diff --name-only
ran     gh pr comment 1 --body "a comment"
ran     gh repo view --json defaultBranchRef
ran     bun run check
DENIED  git push origin HEAD:main — Permission to use Bash has been denied because Claude Code is running in don't ask mode

every one of the 30 commands under test runs unprompted in the harness, `git push origin HEAD:main` is denied, and the repository is unchanged
```

Exit 0, with `ANTHROPIC_API_KEY=sk-ant-owner-sentinel` in the calling environment. `PATH` and
`HOME` now read `/private/var/…` rather than `/var/…`, which is Minor 8's `realpathSync` visible
in the output. `bun run check`: 608 pass, 0 fail.

# Verification — FAILED on prose, all eleven criteria passing

The independent verification found **every one of the eleven acceptance criteria satisfied by
execution**, and failed the round on a comment that was not true. What it established, and how:

- **Criterion 1** by sampling for the SDK's native binary across a whole `bun test` run: none,
  against 172 samples during `check:harness` — the same sampler, so the negative is not blind.
- **Criteria 2–7 and 10** by running `bun run check:harness`, three times, stable at about 4.4 s:
  30 commands executed, the control denied, the repository unchanged, `canUseTool` never reached.
  It broke the check both ways in a scratch copy — a fenced `gh repo delete` in a playbook → FAIL
  naming it; the control removed → FAIL saying the check proves nothing — planted a side-effect
  file and saw criterion 7 catch it, and confirmed the missing-binary failure is named rather than
  silent.
- **Criterion 6** by `ps eww` on a spawned `claude` child: exactly eight environment variables, no
  owner credential among them; and by sampling `lsof` across a run: no non-loopback socket.
- **Minor 1**, the interrupt path, by `SIGINT` mid-run: exit 130, the grace observed at 2527 ms,
  the scratch directory gone and the `claude` child dead afterwards.
- **Criterion 8 and the harvesters** by rebuilding every red-first row from `git archive` at each
  stage, and by checking `instructedCommands()` against the `commandsIn` it replaced as a
  multiset.
- **`unrepresentedEntries`** by running per-entry `allowsTool` over all 196 entry–representative
  pairs: zero disagreements with the hand-rolled `covers`.
- And it established that the fast operator test in `playbooks.test.ts` and the harness genuinely
  differ — `git add -A && git commit -m "a message"` is rejected by the fast test and *allowed* by
  the harness — so keeping both guards is right rather than redundant.

## What this round corrected

- **The false claim.** `unrepresentedEntries`'s comment said `allowsTool` "reads a wildcard rule as
  covering `xargs <that command>` too … so `xargs git add -A` would count as covering
  `Bash(git add *)`". Executed here, on the same code: `allowsTool("Bash", {command: "xargs git add
  -A"}, …)` is **`false`** against `FIXED_ALLOWLIST` and against `["Bash(git add *)"]` alone. The
  widening is the *harness's*, and `allowlist.ts` records it as a divergence in exactly the
  opposite direction ("allows `xargs git add` **there** and asks **here**") — so the comment
  attributed the harness's behaviour to the model, in the sentence whose job is to say why the
  model is kept out of the decision. Rewritten: the reasons are independence and the fact that
  `allowsTool` answers a different question (whole-list permission, not which entry a command
  stands for — `gh pr view --json url --jq .url` is `false` against `["Bash(gh pr create *)"]` and
  `true` against the full list, both executed). The `xargs` widening is kept only where it is true:
  as a reason the harness would be no better an oracle for "stands for" either.
- **This record.** It named three spec amendments; there are four (`1c4f425` added). "10 of 12 red"
  did not match its own 13-row table; it now says 11 red, 2 green first.
- **`claude.ts`'s header** said the check is imported by nothing; its own unit test imports it, and
  what the test pins is that nothing *the daemon runs* does. Corrected to that.
- **The version-pin comment** in `claude.test.ts` said that file "is the one place the SDK is
  named"; the naming list it sits beside has three entries. It now says what it is: the one test
  file that names the SDK, with the list pinned at three.

Nothing in this round changed behaviour: comments and this record only. `bun run check` 608 pass,
`bun run check:harness` exit 0.
