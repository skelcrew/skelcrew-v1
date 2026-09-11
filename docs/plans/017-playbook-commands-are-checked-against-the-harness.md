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
3. Unit-test the stub model, the stub `PATH` builder, the moved harvesters and the pass/fail
   logic in `harness-check.test.ts` / `playbook-commands.test.ts` — collected by `bun test`, and
   spawning no harness.
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
  yields exactly the same list `playbooks.test.ts`'s `commandsIn` did — nothing lost, nothing new.
- `packages/daemon/src/runner/harness-check.ts` — the stub model, the stub `PATH` builder, the
  pass/fail logic, and a `main()` behind `import.meta.main`.
- `packages/daemon/src/runner/harness-check.test.ts` — 13 tests over those parts; no harness.
- `package.json` — `check:harness`; `AGENTS.md` (`CLAUDE.md` is a symlink to it) — the sentence
  in *Definition of done*; `allowlist.ts` — what "re-verify" now means.

## The check's own output

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
