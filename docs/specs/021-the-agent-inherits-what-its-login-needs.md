# 021 — The agent inherits what its login needs

The first real card through a real daemon failed before the agent said a word: `run failed: Not
logged in · Please run /login`. This spec is that finding. It is small on purpose, and it
supersedes one criterion of 012, which it names.

## Goal

A spawned agent must be able to use the owner's own model login, the way the owner's terminal
does. Today the runner hands the agent a bare environment — `PATH`, `HOME`, and skelcrew's two
variables — because skelcrew holds no credentials and the daemon's environment is none of the
agent's business. That was meant to be enough: `HOME` was passed "so the owner's own harness
login is the one that answers" (`shim.ts`). On macOS it is not enough. The harness keeps a
`claude login` in the Keychain, and reading it needs `USER` as well. And an owner who
authenticates with a key in their shell has no path at all, because nothing but `HOME` is passed
on. After this spec the agent inherits exactly the small set of variables its login can live in,
verbatim from the daemon's environment, and nothing else. Skelcrew still stores no credential; it
stops stripping the ones the harness needs.

This is a **gate**, not a boundary. It governs what the agent's environment contains in the
ordinary course. What it does not do is hide the owner's login from the agent, and it never
could: an agent that can run a check command can read `~/.claude`, and with `HOME` it already
could. For a stored login the passthrough adds convenience for the owner and no new reach for
the agent. For a credential that lives only in the owner's shell it is new reach: before this
spec the run could not see it, and after it any pre-allowed check command can print it. That is
the trade the spec makes, and the playbooks' new rule is its only mitigation. (Review round 1
corrected the first version of this sentence, which claimed no new reach in every case.)

## Current behavior

- `packages/daemon/src/runner/shim.ts:46-60`, `agentEnvironment(base, dataDir, memberName)`:
  returns `PATH` (the shim's directory first), `HOME` when the daemon has one, `SKELCREW_AS` and
  `SKELCREW_DIR`. Nothing else from `base` survives. Its doc says why: "skelcrew holds no
  credentials, and what it does hold is none of the agent's business."
- `docs/specs/012-…md`, criterion 13: "The spawned agent's environment is exactly `PATH` (with
  the shim's directory first), `HOME`, `SKELCREW_AS` and `SKELCREW_DIR`." `shim.test.ts:47`
  pins that sentence, and `run.test.ts:283` asserts the real runner spawns with exactly
  `agentEnvironment({ PATH, HOME }, dataDir, "crew")`.
- `packages/daemon/src/runner/claude.ts:129-130` passes that environment to the SDK as
  `env`. `settingSources: []` (013) keeps `~/.claude/settings.json` inert, so an `apiKeyHelper`
  or an `env` block there cannot supply a login either; `claude.ts:150-152` records that.
- What happened on 2026-09-14, card 1 in this repository: the runner claimed, made the worktree,
  spawned the agent (the SDK's bundled Claude 2.1.266), and the session's first and only text
  was `Not logged in · Please run /login`. The run log records `apiKeySource: "none"`. The card
  ended `run failed`, waiting on the owner, which is the right ending for the wrong reason.
- Measured by hand on that machine (macOS, the owner logged in with `claude login`, no
  `ANTHROPIC_*` in the shell): the installed Claude binary with the owner's full environment
  answers a prompt; with only `PATH` and `HOME` it says `Not logged in`; with `PATH`, `HOME`
  and `USER` it answers. `TMPDIR`, `SHELL` and `TERM` change nothing. The Keychain lookup is what
  needs `USER`.
- `harness-check.ts:806-808` builds its environment from `agentEnvironment({ PATH, HOME }, …)`
  and then sets its own stub `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL`, so the check never
  depends on a real login and must go on not depending on one.

## Desired behavior

**The agent's environment is a fixed short list, taken verbatim from the daemon's.** It holds:

- `PATH`, with the shim's directory first, and `HOME`, as today;
- `USER` and `LOGNAME`, because the macOS Keychain login is read under the user's name;
- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and
  `ANTHROPIC_BASE_URL`, the four variables the harness reads a login or an endpoint from, so an
  owner who authenticates with a key or a long-lived token in their shell is served too;
- `CLAUDE_CONFIG_DIR`, because an owner who moved `~/.claude` keeps their login there;
- `SKELCREW_AS` and `SKELCREW_DIR`, set by the runner as today.

A variable on the list that the daemon's environment does not have is absent from the agent's,
not invented as empty. Every other variable in the daemon's environment is dropped, as today: a
`SECRET`, an `AWS_PROFILE`, a `SKELCREW_AS` the owner exported, none of them reaches the agent.

**On the owner's machine, a card runs.** With the daemon started from a shell where `claude`
itself is logged in, moving a card to Spec produces a Spec run that reads the card and writes a
body, rather than `run failed: Not logged in`. This is the acceptance the owner performs after
the change lands; no test may spawn the real harness.

**Nothing else changes.** The shim, `SKELCREW_AS`, the worktree, the allowlist and every gate
from 013 and 016 are untouched. 012's criterion 13 is superseded by the list above and says so
in its own record when this lands.

## Implementation approach

`agentEnvironment` in `shim.ts` gains one exported constant, the list of variable names it
passes through from `base` verbatim when present — the seven named above beyond `PATH` and
`HOME` — and copies each one that `base` holds. `PATH` and `HOME` keep their existing handling
(the shim prefix; an absent `HOME` not invented). `SKELCREW_AS` and `SKELCREW_DIR` are still set
by the runner after the copy, so a value the owner exported cannot survive. The doc comment says
what each variable is for and that skelcrew stores none of them: they are read from the process
the owner started and written into the process the owner's harness runs, and nowhere else.

An enumerated list rather than a blanket passthrough, deliberately. A blanket passthrough is
containment's opposite: it would hand the agent whatever the owner's shell happened to hold. The
list is a maintenance obligation, so it is written against something: the variables the pinned
harness (`claude` 2.1.266, SDK 0.3.266) documents as its login and endpoint inputs, plus the two
the Keychain needs. When the harness pin moves and a login stops working, this list is the place
to look, and `claude.test.ts`'s version pin is what says the pin moved.

`harness-check.ts` keeps passing a base of `{ PATH, HOME }` and then setting its stub key, so
no variable from the operator's environment reaches its sessions. Since the check's base holds
none of the listed variables, the change cannot make it depend on a real login; criterion 4
asserts that stays true.

`docs/specs/012-…md` is not edited (specs are durable and record what was intended); this spec
records the supersession, and `shim.test.ts`'s "exactly PATH, HOME, SKELCREW_AS and
SKELCREW_DIR" case is corrected to the new list, with the reason in the test.

### Red-team

This spec grants the agent the owner's login variables, so the check applies.

1. **Gate.** Said in the Goal. What defeats it is nothing new: the agent could already read the
   owner's `~/.claude` through a check command, and 016 records that a subprocess reaches
   anything the daemon's user can.
2. **What each variable reaches.** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and
   `CLAUDE_CODE_OAUTH_TOKEN` are credentials: an agent that prints one to the card, or to a
   test file it commits, has published it. With a Keychain login the same agent could run
   `security find-generic-password -w` from a check command and print that token instead; this
   was not run while writing the spec (it may prompt on screen), and is marked unverified. The
   exposure is the owner's own login to the owner's own agent, which is 012's design.
   `ANTHROPIC_BASE_URL` lets the owner route the agent through a proxy; the agent inherits the
   owner's choice, not its own. `CLAUDE_CONFIG_DIR` names a directory the agent could already
   reach under `HOME`. `USER` and `LOGNAME` are names.
3. **Composed.** With `Edit(//<worktree>/**)` and `git push`: a key written into a committed file
   is pushed to the forge. That composition existed for anything in `~/.claude` already; what
   changes is that reading an environment variable is easier than reading a file. The playbooks
   say nothing about secrets today; a sentence in each playbook telling the agent never to write a
   credential into the repository costs nothing, and criterion 5 asks for it.
4. **The real enforcer** is the harness's own login lookup. It was run by hand (see *Current
   behavior*): the installed binary with `PATH`, `HOME` and `USER` logs in from the Keychain on
   this machine. Not run: the SDK's bundled binary under the runner, which is the same code at
   2.1.266; the owner's post-merge card run is that test. Not run: a key-based login through the
   passthrough, since this machine has none; `check:harness` proves the SDK honours a key in
   `env`, which is the same path.
5. **What parses the string.** Nothing composes these values into a syntax; they are copied
   verbatim into an environment map. Control characters cannot occur in a login the harness
   accepted.

Open, recorded as such: the Keychain-from-a-subprocess claim in item 2 is unverified; whether
`USER` alone suffices on every macOS version is verified on one machine; a Bedrock or Vertex
login needs variables not on this list and is out of scope.

## Acceptance criteria

1. `bun run check` passes. No test spawns a real coding agent or calls a model.
2. `agentEnvironment` given a base holding every listed variable returns each of `USER`,
   `LOGNAME`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
   `ANTHROPIC_BASE_URL` and `CLAUDE_CONFIG_DIR` with the base's value, unchanged; given a base
   with none of them, returns none of them (no key present, not an empty string); given a base
   holding `SECRET`, `AWS_PROFILE` and `SKELCREW_AS`, drops the first two and sets `SKELCREW_AS`
   to the member's name regardless of the base. `PATH` and `HOME` behave exactly as before.
3. The real runner spawns the agent with `agentEnvironment(<the daemon's environment>, dataDir,
   "crew")`: a daemon started with `USER` and `ANTHROPIC_API_KEY` in its environment hands both
   to the driver, and one started without them hands neither (`run.test.ts`, through the scripted
   driver's `options.env`).
4. `bun run check:harness` passes, and its sessions' environment holds the stub key and no
   variable from the operator's shell: the check's base is still `{ PATH, HOME }`.
5. Each of the three playbooks — `code.md` in the rules the list cannot enforce, and `spec.md`
   and `review.md` in the matching place — says never to write a credential from the environment
   into the repository, the card, or a pull request; `playbooks.test.ts` pins the sentence in
   all three. All three kinds of run receive the same environment, and a Spec run's card body
   is later exported into the repository by a Code run, so the door is at every playbook.
   (Review round 1 found the rule in `code.md` alone; the orchestrator widened this criterion.)
6. `shim.ts`'s doc names the list, says what each variable is for, says skelcrew stores none of
   them, and names the harness version the list was written against. This spec is named as
   superseding 012's criterion 13, and `shim.test.ts`'s corrected case says so.
7. After merge, on the owner's machine with the daemon started from a logged-in shell, card 1
   (`Write the README`) resolved and re-run reaches a Spec ending other than `Not logged in`.
   Performed by the owner, recorded in the run record as done or not done, not a test.

## Tests

- Criterion 2 in `shim.test.ts`, replacing the "exactly PATH, HOME, SKELCREW_AS and SKELCREW_DIR"
  case with the new list and the reason, and keeping the "absent HOME is not invented" case.
- Criterion 3 in `run.test.ts`, beside the existing environment assertion at line 283, with a
  runner started under an explicit `env`.
- Criterion 4 in `harness-check.test.ts` if the check's environment construction is unit-tested
  there; otherwise the run of `check:harness` itself, recorded.
- Criterion 5 in `playbooks.test.ts`, the way the other rules in `code.md` are pinned.
- Existing 012, 013 and 016 coverage passes unchanged except the one corrected `shim.test.ts`
  expectation.

## Out of scope

- **A blanket environment passthrough.** Argued against above.
- **Bedrock and Vertex logins** (`CLAUDE_CODE_USE_BEDROCK`, `AWS_*`, `CLOUD_ML_REGION`, and
  the rest). A second short list when an owner needs one.
- **A startup check that a login is visible.** The card already says `Not logged in` when a run
  fails, which is what happened; a daemon that refuses to start without a key would break
  `SKELCREW_AGENT=none` and the harness check.
- **The SDK's `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning**, printed with a stack trace on every
  run. It reports the five bare tool names on the allowlist, which 013 pre-allows on purpose. It
  is noise; silencing it is a separate small change, carried to MILESTONES.
- **`apiKeyHelper` and settings-file logins.** `settingSources: []` keeps them inert by 013's
  design; `claude.ts` records the consequence.
- **The Claude binary on the owner's `PATH`** (2.1.268 here). The SDK spawns its own bundled
  2.1.266; the runner never uses the `PATH` binary, and the version pin stands.
