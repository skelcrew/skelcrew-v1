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

## Criterion 7 — the owner's card run

**Not performed in this run.** It is the owner's, after merge: card 1 (`Write the README`)
resolved and re-run on a daemon started from a logged-in shell, reaching a Spec ending other than
`Not logged in`. No test here spawns the real harness against a real login.
