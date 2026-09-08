# 003 — Client protocol: run record

## Plan

1. Red: `packages/daemon/src/server/protocol.test.ts` (method parity against the core's
   keys, framing and session errors over a raw socket, error mapping and round trips through
   the shared client), `packages/daemon/src/server/server.test.ts` (streaming: fan-out,
   ordering, `unsubscribe`, `since` replay, disconnects), `packages/daemon/src/server/
   process.test.ts` (spawned daemon: start line, files and modes, SIGTERM, second daemon,
   stale socket, repo-root discovery, no-repo failure), `packages/shared/src/client.test.ts`
   (`connect` rejects on a failed `hello`; a pending `call` rejects on close, against a
   scripted `Bun.listen` server). Run `bun test`; they must fail on the missing
   `packages/shared/src/protocol.ts` / `client.ts` / `server/*.ts` modules.
2. Green, `shared`: `protocol.ts` (method table with param and result shapes, `hello` and
   the `activity` notification, the error table, `PROTOCOL_VERSION`, `MAX_LINE_BYTES`, line
   framing), `client.ts` (`connect(socketPath, hello)` over `Bun.connect({ unix })`),
   re-exported from `index.ts`. No dependencies.
3. Green, `daemon`: `src/server/protocol.ts` (request parsing, param validation, dispatch
   to a `Core`, error mapping), `src/server/server.ts` (`startServer({ core, socketPath })`,
   per-connection session, subscription fan-out), `src/server/paths.ts` (repo root,
   `SKELCREW_DIR`, modes, stale socket), and `src/main.ts` as the process.
4. `docs/MILESTONES.md` status: data directory and per-connection identity recorded.
5. `bun run check`, then walk the criteria against the tests and the diff.

Files: `packages/shared/src/{protocol,client,index}.ts`, `packages/shared/src/client.test.ts`,
`packages/daemon/src/server/{protocol,server,paths}.ts`, `packages/daemon/src/server/
{protocol,server,process}.test.ts`, `packages/daemon/src/main.ts`, `docs/MILESTONES.md`,
this file. `packages/cli/`, `main.test.ts`, the core, both `package.json`s and `bun.lock`
untouched.

## Decisions the spec left open

- **`ensureMember` and `getMember` have no wire method of their own.** The spec's method
  list is explicit and calls `listMembers` "the one addition". `hello` is the wire form of
  `ensureMember` (it is how an agent joins), and `listMembers` covers `getMember`. The parity
  test enumerates `Object.keys(core)` and requires every key to be a same-named wire method
  or one of three named exceptions (`ensureMember` → `hello`, `getMember` → `listMembers`,
  `close` → process lifecycle), so a new core method fails the test until the wire has it.
- **Line framing lives in `packages/shared/src/protocol.ts`** next to the wire types and the
  1 MiB limit, because both ends decode the same lines and must agree; the daemon's
  `server/protocol.ts` applies the limit, the client does not.
- **`subscribe` and `unsubscribe` return `null`.** They have nothing to say beyond success.
  On `subscribe({ since })` the replayed events are sent before the response, so when the
  call resolves the client is caught up; live events follow in `seq` order.
- **An oversize line is a `parse` error (-32700)**, the spec allowing either; the message
  names the limit. A JSON-RPC notification from a client (no `id`) is `invalid_request` and
  closes the connection, since client notifications are out of scope.
- **Params are validated strictly**: an object with exactly the documented keys, ids and
  seqs integers, `phase` one of the five ids. A wrong value type or an unknown key is
  `invalid_params` before the core is touched; semantic rules (caps, gates, archived) stay
  the core's and surface as its codes. `params` may be omitted for methods whose params
  are all optional.
- **Internal errors carry the thrown message and no stack.** The fan-out listener never
  throws, so the 002 note about a listener's error replacing a mutation's error cannot
  happen through the daemon.
- **The data directory is always `chmod 0700`**, whether created or pre-existing (as with
  `SKELCREW_DIR` pointing at a temp directory), because it holds the socket and database.
- **The second-daemon probe connects and closes without `hello`.** The running daemon sees a
  connection that says nothing and goes away; nothing is recorded.
- **The client exposes `member`**, the bound member from the `hello` result, beside the four
  methods the spec names; the result is otherwise discarded and 004 needs to know who it is.

## Environment

Bun 1.3.14, macOS. `bun install` in the fresh worktree left `bun.lock` unchanged. Baseline
`bun run check` on the base commit: green, 73 pass.

## Implementation run

Red: with the four test files written and no source, `bun test` on them reported 0 pass,
4 errors: `error: Cannot find module './client' from .../packages/shared/src/client.test.ts`,
`error: Cannot find module './server'` from both daemon socket test files, and
`SyntaxError: Export named 'connect' not found in module .../packages/shared/src/index.ts`
from the process test.

Green: after the seven source files, 47 of 50 passed; the three failures were in the tests.
The raw-socket helper called `socket.write(bytes, offset)` without a length (Bun defaults
`byteLength` to the whole buffer, so the 1 MiB line threw `ERR_OUT_OF_RANGE`), and two
expectations had not counted the `member_joined` an agent's first `hello` records — an
event attributed to the agent, which is the correct observable. `bun run fix` reformatted
six of the new files; six typecheck errors, all in new code (a `Bun.Socket` generic, the
weak-type check on `process.env`, and `readonly MethodName[]` vs `string` in the parity
test), were fixed without changing behaviour. Refactor with the tests green: `hello` moved
out of the member-taking handler table so `handleRequest` needs no cast.

`bun run check`: exit 0 — `biome ci .` 33 files, typecheck clean in all three packages,
`bun test` 123 pass / 0 fail across 10 files (50 new: 26 in `server/protocol.test.ts`, 9 in
`server/server.test.ts`, 7 in `server/process.test.ts`, 8 in `shared/src/client.test.ts`).
The socket and process tests were run five more times in isolation: 50 pass each time.

Mechanical checks: `git diff <base> -- packages/cli packages/*/package.json package.json
bun.lock` is empty; the only module imports in new and changed sources are workspace
relatives, `@skelcrew/shared`, `bun:test`, and `node:{fs,os,path,url}`; `find . -name
.skelcrew` and `find . -name '*.sock'` under the repo find nothing.

## Review outcomes (orchestrator)

- Round 1: APPROVED. Judgement calls (a) hello/listMembers as the wire forms of
  ensureMember/getMember, (b) framing in shared, (c) client exposes `member`, (e) error
  messages forwarded without stack, (g) rmSync after stop and process.exit in the signal
  handler were all accepted. Minors carried to the PR: MAX_LINE_BYTES doc should say it
  bounds only lines the daemon receives (responses are unbounded); prepareDataDir chmods a
  pre-existing SKELCREW_DIR and the database file is created 0644; the per-connection
  outbound queue is unbounded for a stalled subscriber; daemonAnswers removes a non-socket
  file at the socket path; the multi-chunk LineDecoder path has no test; two client tests
  rely on Bun.sleep(10).
