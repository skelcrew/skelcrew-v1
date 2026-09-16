# 028 — The runner's name is reserved

Run record. Spec: `docs/specs/028-the-runners-name-is-reserved.md`.

## Plan

1. `startServer` takes an optional `reserved` list of member names; the dispatcher's context
   carries it as a set. `hello` with `kind: "agent"` refuses a name that normalises to one of
   them with `invalid_params`, beside the "already said hello" check. The normalisation is the
   core's own `memberName`, exported for the purpose, so the check and `ensureMember` agree by
   construction.
2. `main.ts` passes `[RUNNER_MEMBER_NAME]` unconditionally — outside the
   `SKELCREW_RUNNER !== "0"` block — so the server never imports from the runner half, and the
   name is reserved whether or not the runner is on. A comment names the test that observes the
   handoff, as that file's rule requires.
3. Tests, red first:
   - `protocol.test.ts` (criteria 2–3): the refusal through the real socket, the connection
     staying unbound and usable, `" runner "` refused and `"Runner"` accepted.
   - `process.test.ts` (criterion 4): a real daemon with `SKELCREW_RUNNER=0` refuses it.
   - `cli.test.ts` (criterion 5): `skelcrew --as runner ls` exits 1 with the daemon's message.
   - `process.test.ts` (criterion 6): 024's two tests set the runner's claim and request up
     through `openCore` on the data directory before the daemon starts; assertions unchanged.
4. `bun run check`, then commit.

Files expected to touch: `packages/daemon/src/server/server.ts`,
`packages/daemon/src/server/protocol.ts`, `packages/daemon/src/core/core.ts`,
`packages/daemon/src/main.ts`, `packages/daemon/src/server/protocol.test.ts`,
`packages/daemon/src/server/process.test.ts`, `packages/cli/src/cli.test.ts`, this run record.

## Decisions the spec left open

- **The normalisation is shared, not copied**: `memberName` in `core.ts` becomes an export and
  the protocol calls it. The spec allowed either that or checking before `ensureMember`.
- **`protocol.test.ts` passes the literal `["runner"]`** rather than importing
  `RUNNER_MEMBER_NAME`: that test is about the server reserving a name it is given, and its
  `hello` lines are raw JSON with the name spelled out, so a constant on one side only would
  make a rename look like a failure of the mechanism. The wiring from `RUNNER_MEMBER_NAME` to
  the server is observed instead by the process tests, through the real daemon.
- **`cli.test.ts`'s shared server reserves the name too**, rather than a second server for one
  test: that is what the real daemon does, and no other CLI test speaks as `runner` over the
  socket (the one that needs the member makes it through `core.ensureMember`, which is not the
  socket and is unaffected).

## Baseline

`bun install` first (a fresh worktree has no `node_modules`).

```
$ bun test
 799 pass
 0 fail
Ran 799 tests across 29 files. [91.61s]
```

## Red

Each new test, run before the refusal existed. Every failure is the `hello` succeeding.

`protocol.test.ts`, both new cases (`bun test packages/daemon/src/server/protocol.test.ts -t
"reserved"`):

```
335 |     expect(refused.error.code).toBe(-32602);
                         ^
TypeError: undefined is not an object (evaluating 'refused.error.code')
(fail) hello as a reserved name is refused, and the connection stays free to be someone else
(fail) a reserved name is refused as the core would trim it; another case is another member
```

`process.test.ts` (`-t "still refuses hello"`):

```
expect(caught).toBeInstanceOf(RpcError)
Expected constructor: [class RpcError extends Error]
Received value: undefined
(fail) with SKELCREW_RUNNER=0 the socket still refuses hello as the runner
```

`cli.test.ts` (`-t "as runner is refused"`), through `failed(1, ...)`:

```
expect(run.code).toBe(1)
Expected: 1
Received: 0
(fail) --as runner is refused by the daemon: the runner's name is its own (028)
```

024's two rewritten tests are the other way round, as the spec asks: they were made to pass on
the unchanged code first (`-t "withdraw"` and `-t "interrupted run"`, both green before the
refusal was written), and they pass after it.

## The spec's setup does not work for the first 024 test

The spec says to make the runner's member, card, claim and request through `openCore` before
spawning the daemon, for both tests. That works for the `SKELCREW_RUNNER=0` one and cannot work
for the other: `reconcileAll` in `runner.ts` releases every claim held by the runner member at
startup — "A claim by this member that survived a restart belongs to a run that no longer
exists" — so with the runner on, a pre-made claim is released seconds before the first sweep and
never lapses. Observed: the card's activity ended `claimed, attention_requested, released`, with
no `run_interrupted` and no withdrawal, and the test failed with "the daemon's sweep withdrew
nothing".

What landed instead: the member, the card in Spec and the request are pre-made through `openCore`
as specified, and only the claim is taken — through the same `openCore` handle, still not over
the socket — after the daemon is listening. That is also the truer scenario, since a run's claim
that lapses is one the daemon was live for. The assertions are unchanged.

## Checks

```
$ bun run check
 803 pass
 0 fail
Ran 803 tests across 29 files. [76.64s]
$ bun run check:harness
every one of the 71 commands under test runs unprompted in the harness under its own list,
`git push origin HEAD:main` is denied under each list, and the repository is unchanged
exit=0
```

799 tests before, 803 after: two in `protocol.test.ts`, one in `process.test.ts`, one in
`cli.test.ts`.

## Comments corrected, because the change made them false

- `runner/allowlist.ts` listed `skelcrew --as runner` as a way round the daemon's gates.
- `merges.ts` and `merges.test.ts` recorded that `hello` reserves no name, and that a real bind
  "would be `hello` refusing the reserved names, which is its own finding" — this spec.

Each keeps its history and gains the sentence that says 028 refuses that `hello` now.

# Fix round 1

Plan, one line per finding:

1. Commit the orchestrator's uncommitted spec amendment with this round's changes, text untouched.
2. Add a process test that refuses `hello` as the runner on a daemon with the runner *on* — a
   second case beside the `SKELCREW_RUNNER=0` one, with a temp repo so the runner really starts.
   Red first by mutating `main.ts` to reserve only when `SKELCREW_RUNNER === "0"`; then restore.
   `main.ts`'s comment beside `reserved` names both tests verbatim.
3. `merges.ts`: restore "It does **not** bind a caller that asserts `runner` over the socket" and
   let the sentences after it say 028 closed that `hello`.
4. `startServer`'s `reserved` becomes required; the test servers that reserve nothing pass `[]`.
5. A comment in the runner-on 024 test where the second core handle is opened, naming the
   `busy_timeout = 0` hazard and why the claim sits after the socket round trips.

Files: `docs/specs/028-the-runners-name-is-reserved.md` (commit only), `packages/daemon/src/main.ts`,
`packages/daemon/src/merges.ts`, `packages/daemon/src/server/server.ts`,
`packages/daemon/src/server/process.test.ts`, `packages/daemon/src/server/server.test.ts`,
`packages/daemon/src/server/protocol.test.ts`, `packages/cli/src/cli.test.ts`.

## Red, for the runner-on refusal

With `main.ts` mutated to `reserved: process.env.SKELCREW_RUNNER === "0" ? [RUNNER_MEMBER_NAME] : []`
— the reviewer's mutation, which the landed suite could not see — the new test fails because the
`hello` succeeded and nothing was thrown:

```
$ bun test packages/daemon/src/server/process.test.ts -t "with the runner on the socket refuses hello as the runner"
611 |   expect(caught).toBeInstanceOf(RpcError);
error: expect(received).toBeInstanceOf(expected)
Expected constructor: [class RpcError extends Error]
Received value: undefined
(fail) with the runner on the socket refuses hello as the runner, whose member the daemon made itself
 0 pass
 1 fail
```

`main.ts` restored, the same test passes (7 expect() calls).

`startServer`'s `reserved` is required now, and the typecheck is what says so — with `reserved: []`
removed from `server.test.ts`:

```
$ bun run --filter '@skelcrew/daemon' typecheck
src/server/server.test.ts(22,24): error TS2741: Property 'reserved' is missing in type
'{ core: Core; socketPath: string; }' but required in type
'{ core: Core; socketPath: string; reserved: readonly string[] }'.
```

## Checks, round 1

```
$ bun run check
 804 pass
 0 fail
Ran 804 tests across 29 files. [81.43s]
```

803 tests before this round, 804 after: the one new process test. `check:harness` was not run
again — this round touched no playbook and not `allowlist.ts`.
