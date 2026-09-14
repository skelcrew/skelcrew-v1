# 021 — The agent inherits what its login needs

Run record for `docs/specs/021-the-agent-inherits-what-its-login-needs.md`.

## The change, in steps

1. **`shim.ts`** — one exported constant, the list of variable names `agentEnvironment` copies
   verbatim from `base` when `base` has them: `USER`, `LOGNAME`, `ANTHROPIC_API_KEY`,
   `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
   `CLAUDE_CONFIG_DIR`. `PATH` and `HOME` keep their handling; `SKELCREW_AS` and `SKELCREW_DIR`
   are still written after the copy, so an exported `SKELCREW_AS` cannot survive. The doc says
   what each variable is for, that skelcrew stores none of them, the harness version the list
   was written against, and that this supersedes 012's criterion 13.
2. **`shim.test.ts`** — the "exactly PATH, HOME, SKELCREW_AS and SKELCREW_DIR" case becomes the
   new list, with the supersession as its reason; the "absent HOME is not invented" case stays;
   a case for a base holding none of the listed variables (no key, not an empty string).
3. **`run.test.ts`** — `start` takes the runner's `env`, and two tests assert what the real
   runner hands the driver: a daemon started with `USER` and `ANTHROPIC_API_KEY` passes both on,
   one started without them passes neither.
4. **`code.md`** — a fourth rule in *the rules the list cannot enforce*: never write a credential
   from the environment into the repository, the card or a pull request.
5. **`playbooks.test.ts`** — pins that sentence.

`harness-check.ts` is not touched: its base is `{ PATH, HOME }`, which holds none of the listed
variables, so its sessions still see only the stub key.

## Files expected to change

- `packages/daemon/src/runner/shim.ts`, `shim.test.ts`
- `packages/daemon/src/runner/run.test.ts`
- `packages/daemon/playbooks/code.md`
- `packages/daemon/src/runner/playbooks.test.ts`
- this record

## What the spec left open, and how it was decided

- **The constant's name.** The spec says "one exported constant" without naming it.
  `INHERITED_VARIABLES` in `shim.ts`, beside `agentEnvironment`, which is the only caller.
- **Where the new `code.md` rule goes.** Criterion 5 says "in the rules the list cannot
  enforce", so the existing three-bullet list becomes four and its lead-in says "Four rules".

## Red, then green

Tests first, in all three files, then the implementation.

- **`shim.test.ts`.** The first run failed at the import — `SyntaxError: Export named
  'INHERITED_VARIABLES' not found in module '…/shim.ts'` — which is a broken test rather than a
  red one, so the constant was added on its own (no copy in `agentEnvironment`) and the test run
  again. That is the behavioural red:

  ```
  error: expect(received).toEqual(expected)
  -   "ANTHROPIC_API_KEY": "sk-ant-key",
  -   "ANTHROPIC_AUTH_TOKEN": "token",
  -   "ANTHROPIC_BASE_URL": "https://proxy.invalid",
  -   "CLAUDE_CODE_OAUTH_TOKEN": "oauth",
  -   "CLAUDE_CONFIG_DIR": "/home/simon/elsewhere",
  -   "LOGNAME": "simon",
  -   "USER": "simon",
  (fail) the spawned environment is PATH, HOME, the inherited login variables, and the two skelcrew ones
  ```

- **`run.test.ts`.** Red on the values the driver was handed, with the runner started under a
  daemon environment carrying both:

  ```
  expect([spawned.USER, spawned.ANTHROPIC_API_KEY]).toEqual(["simon", "sk-ant-key"]);
  -   "simon",
  -   "sk-ant-key",
  +   undefined,
  +   undefined,
  (fail) a daemon started with USER and a key hands both to the agent
  ```

- **`playbooks.test.ts`.** Red on the sentence `code.md` did not yet carry:

  ```
  Expected to contain: "**Never write a credential into the repository, the card, or a pull
  request.** …"
  (fail) the Code playbook says never to write a credential from the environment anywhere
  ```

Green came from the four-line copy loop in `agentEnvironment` and the fourth bullet in `code.md`.

## Checks

- `bun run check` — passes: `biome ci .` clean over 90 files, `tsc` clean in all three packages,
  `747 pass / 0 fail` across 29 files.
- `bun run check:harness` — passes: "every one of the 71 commands under test runs unprompted in
  the harness under its own list, `git push origin HEAD:main` is denied under each list, and the
  repository is unchanged". Criterion 4's second half is the line it prints about its own
  sessions: `the harness's environment: ANTHROPIC_API_KEY, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
  HOME, PATH, SKELCREW_AS, SKELCREW_DIR, and the stub's ANTHROPIC_BASE_URL, which is a fresh
  loopback port per session` — the stub key and nothing from the operator's shell (this shell has
  `USER` set, and it is not there). The check's base is still `{ PATH, HOME }`; `harness-check.ts`
  is unchanged by this run.

## Review round 1

Verdict: approved, with five Minor findings. Four are fixed here; the fifth (the MILESTONES
entry) is the orchestrator's at landing. The spec was amended at `94d0012` first: criterion 5
now asks for the credential rule in all three playbooks, and the Goal's "no new reach" sentence
is narrowed to stored logins.

- **Minor 1 — the comment at `shim.ts` naming the wrong reason.** It said the `SKELCREW_AS`
  assignment sits after the copy loop "so a `SKELCREW_AS` the owner exported cannot survive",
  which the ordering does not do: `SKELCREW_AS` is not in `INHERITED_VARIABLES`, so the loop
  never writes it, and the reviewer moved the assignment above the loop with every shim test
  still green. The comment now names the enumerated list as the reason and calls the ordering
  belt-and-braces. Prose only; no test change.

- **Minor 2 — an exported-but-empty variable was forwarded as an empty string.** `PATH` one
  line above already read `""` as absent, so an owner with `ANTHROPIC_API_KEY=` in a shell
  profile handed the agent an empty key. Red first, in `shim.test.ts`:

  ```
  expect([...INHERITED_VARIABLES].filter((name) => name in env)).toEqual([]);
  - []
  + [ "USER", "ANTHROPIC_API_KEY" ]
  (fail) a login variable the daemon exported empty is absent too, not passed on as an empty string
  ```

  Green from one condition in the copy loop — `value !== undefined && value !== ""` — and the
  doc says so. `HOME`'s own handling is untouched: the finding names the loop, and widening it
  would be a change nothing asked for.

- **Minor 3 — the credential rule was in `code.md` alone.** All three kinds of run get the same
  environment, and a Spec run writes the card body that a later Code run exports into the
  repository and pushes. The same rule is now in `spec.md` (at the end of §3, where the phase's
  other prohibitions are — no bullet list there, so no "Four rules" lead-in) and in `review.md`
  (after the paragraph on what asks the owner, which is where `code.md` has it). The middle
  sentence is adapted per playbook: the card body's export for Spec, findings that stay on the
  card for review. Red first, in `playbooks.test.ts`, which pins the rule and its closing
  sentence in all three:

  ```
  expect([kind, text.includes(CREDENTIAL_RULE)]).toEqual([kind, true]);
    "spec",
  - true,
  + false,
  (fail) every playbook says never to write a credential from the environment anywhere
  ```

  The existing `code.md`-only assertion is kept as it was. **The new sentence harvests no
  command**, checked by `instructedCommands` per playbook before and after the edit: spec 6,
  code 25, review 12 both times, with identical command sets. `bun run check:harness` still
  reports 71 commands under test, the same number as the first round.

- **Minor 4 — the doc claimed the passthrough hides nothing the agent could not already
  reach.** True of a stored login, false of a credential that lives only in the owner's shell:
  before this change the run could not see it, and now `echo $ANTHROPIC_API_KEY` from any
  pre-allowed check command prints it. The sentence is narrowed to stored logins and says the
  playbooks' rule is the only mitigation, matching the amended Goal. Prose only.

Checks for this round: `bun run fix` (no fixes applied), `bun run check` — `biome ci .` clean
over 90 files, `tsc` clean in all three packages, `749 pass / 0 fail` across 29 files — and
`bun run check:harness`, exit 0, "every one of the 71 commands under test runs unprompted in the
harness under its own list, `git push origin HEAD:main` is denied under each list, and the
repository is unchanged". Its sessions' environment line is unchanged: `ANTHROPIC_API_KEY,
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, HOME, PATH, SKELCREW_AS, SKELCREW_DIR, and the stub's
ANTHROPIC_BASE_URL`.

## Criterion 7 — the owner's card run

**Not performed in this run.** It is the owner's, after merge: card 1 (`Write the README`)
resolved and re-run on a daemon started from a logged-in shell, reaching a Spec ending other than
`Not logged in`. No test here spawns the real harness against a real login.
