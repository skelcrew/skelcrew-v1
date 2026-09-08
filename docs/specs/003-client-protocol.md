# 003 — Client protocol

## Goal

Put a front door on the daemon. After 002 the model exists only in-process; nothing outside
the test suite can file a card or watch it move. This spec makes the daemon a running process
that serves the 002 interface over one local socket as JSON-RPC, with a subscription stream so
every connected client sees moves and comments as they happen. It is the one protocol every
client will ever speak — the CLI (004) for the owner and for agents alike, a TUI later — so
it must expose the whole 002 interface and nothing that is not in it. Every later surface is
a thin client of this.

## Current behavior

There is no protocol and no long-running process. `packages/daemon/src/main.ts` prints
`skelcrew daemon <version>` and exits; `packages/cli/src/main.ts` prints `skelcrew <version>`
and exits. Nothing listens, nothing connects.

The model is 002 (`docs/specs/002-core-state.md`): `openCore(path, { owner? })` returns a
synchronous `Core` whose mutations take `actorId` last, whose errors are `CoreError` with a
`code` in `not_found | forbidden | invalid | conflict`, and whose `subscribe(listener)` and
`activitySince(seq)` expose the activity log. 002 puts the default database path and the
`.skelcrew/` data directory out of scope and says "who chooses it is a later spec"; this is
that spec. `.gitignore` already ignores `.skelcrew/`.

The prototype's front door (`prototype:packages/board/src/server.ts`) was HTTP plus SSE from
a separate board server, in the architecture the project pivoted away from; it is not a
pattern to keep. Verified on Bun 1.3.14 in a scratch probe: `Bun.listen({ unix })` and
`Bun.connect({ unix })` work, Bun removes the socket file when the listener stops, and the
socket file is created world-accessible (mode 755) unless tightened.

## Desired behavior

### The daemon process

- `bun run daemon`, run from anywhere inside a git repository, creates `<repo root>/.skelcrew/`
  if missing (mode 0700), opens the 002 core on `<repo root>/.skelcrew/skelcrew.db`, listens
  on `<repo root>/.skelcrew/skelcrew.sock` (mode 0600), prints exactly one line to stdout —
  `skelcrew daemon <version> listening on <socket path>` — and keeps running. `SKELCREW_DIR`
  overrides the data directory. Outside a git repository with no override it exits 1 with a
  message saying so.
- If the socket path exists and a daemon answers on it, a second `bun run daemon` exits 1
  with a message naming the path and saying a daemon is already running. If the file exists
  but nothing answers (a stale socket from a crash), it is removed and the daemon starts.
- On SIGINT or SIGTERM the daemon stops accepting connections, closes open ones, closes the
  database, removes the socket file, and exits 0.

### The wire

- One connection is one stream of newline-delimited UTF-8 JSON-RPC 2.0 messages in both
  directions: one message per line, no batches. A line over 1 MiB, or one that is not valid
  JSON, gets a JSON-RPC parse or invalid-request error and the connection is closed.
- The first request on a connection must be `hello`. Any other request before it fails with
  the `no_session` error. `hello` names who is speaking: `{ kind: "human" }` binds the
  connection to the owner (the single human member), `{ kind: "agent", name }` binds it to
  that agent member, creating it through the core if new. The result carries the bound member
  and `{ version, protocol: 1 }`. A second `hello` on the same connection fails as `invalid`.
- After `hello`, every 002 mutation and read is a method with the same name and named
  params, minus `actorId`, which is always the connection's member: `createCard`,
  `listCards`, `getCard`, `moveCard`, `setBody`, `comment`, `setRefs`, `archiveCard`,
  `activitySince`, plus `listMembers`. Results are the core's return values as JSON; errors
  are the core's errors mapped as below. A method the daemon does not know fails with the
  JSON-RPC method-not-found error; params of the wrong shape fail with invalid-params before
  the core is touched.
- `subscribe({ since? })` turns on the activity stream for the connection: the daemon sends
  a JSON-RPC notification `activity` with `{ event }` for every event the core records, in
  `seq` order, with no gaps or duplicates, to every subscribed connection. If `since` is
  given, events with `seq > since` are delivered first, then live ones, still without gaps
  or duplicates across the boundary. `unsubscribe` stops it. Subscribing twice is a no-op.
- Requests on one connection are answered in the order they arrived. A connection's own
  mutations appear in its activity stream like anyone else's.
- Closing the connection, from either side, releases everything about it. Nothing about a
  connection is persisted; identity is re-established with `hello` every time.

### Error mapping

| Core / protocol condition | JSON-RPC `code` | `error.data.code` |
| --- | --- | --- |
| line not JSON | -32700 | `parse` |
| not a JSON-RPC 2.0 request, or a batch | -32600 | `invalid_request` |
| unknown method | -32601 | `method_not_found` |
| params wrong shape | -32602 | `invalid_params` |
| request before `hello` | -32000 | `no_session` |
| `CoreError` `not_found` | -32001 | `not_found` |
| `CoreError` `invalid` | -32002 | `invalid` |
| `CoreError` `forbidden` | -32003 | `forbidden` |
| `CoreError` `conflict` | -32009 | `conflict` |
| anything else thrown | -32603 | `internal` |

`error.message` is the core's message where there is one. Internal errors carry no stack.

### The client

`@skelcrew/shared` exports a small client every thin client and every test uses:
`connect(socketPath, hello)` resolves to `{ call(method, params), subscribe(handler,
since?), unsubscribe(), close() }` once `hello` has succeeded, rejects with the daemon's
error otherwise, and rejects `call` promises with an error carrying the JSON-RPC code and
`data.code`. It does no reconnection, no retries, and no timeouts.

## Implementation approach

### Where it lives

- `packages/daemon/src/server/` — `protocol.ts` (framing, request validation, method
  dispatch to a `Core`, error mapping), `server.ts` (`startServer({ core, socketPath }) →
  { stop() }` over `Bun.listen({ unix })`, per-connection session state, subscription
  fan-out), `paths.ts` (repo-root discovery, `SKELCREW_DIR`, directory and mode handling,
  stale-socket detection).
- `packages/daemon/src/main.ts` — becomes the process: resolve paths, `openCore`,
  `startServer`, print the line, handle signals. The version import from `@skelcrew/shared`
  stays; the 001 wiring test in `main.test.ts` is untouched.
- `packages/shared/src/protocol.ts` — the wire types: method names and their param and
  result shapes, the `activity` notification, the error table. `packages/shared/src/client.ts`
  — the client over `Bun.connect({ unix })`. `shared` gains no dependency; Bun's built-ins
  are not dependencies.
- Tests colocated as `*.test.ts`. Protocol tests run `startServer` in-process against
  `openCore(":memory:")` on a socket path under the OS temp directory and talk to it through
  the shared client and, for framing cases, a raw `Bun.connect`. One process test spawns
  `bun packages/daemon/src/main.ts` with `SKELCREW_DIR` set to a temp directory.

### Decisions resolved from repository context

- **Unix domain socket, NDJSON, JSON-RPC 2.0.** `AGENTS.md` fixes "one JSON-RPC socket
  protocol" and "localhost-only surfaces". A unix socket is localhost by construction and
  needs no port allocation or auth; file mode is the access control, which is all single-player
  needs. Newline framing keeps the wire inspectable with `nc -U` and works unchanged over any
  byte stream (an SSH-forwarded socket, TCP later), which is what "should not assume same-host
  beyond transport" asks for. WebSocket over HTTP would add an upgrade handshake and a second
  framing layer for nothing a local client needs.
- **Identity is per connection, established by `hello`.** `AGENTS.md`: agents are members
  using the same primitives a human does. Binding the member once per connection means the
  wire has no `actorId` to forge or forget, every mutation is attributable by construction,
  and an agent's CLI invocation (004, `--as <name>`) is a client that says `hello` as an
  agent. The owner needs no name because there is exactly one human (002).
- **Method names mirror the core one to one.** The milestone says the protocol must be
  complete: anything a client will ever do goes through it. Mirroring 002's names makes
  completeness checkable by reading two files side by side and keeps 004 from inventing
  verbs. `listMembers` is the one addition, needed to render an actor's name next to an
  event; if 002 shipped without a `listMembers` read on the core, add it as a read (reads
  record no activity).
- **`subscribe` takes `since`.** Without it a client that lists cards and then subscribes can
  miss events in between, and every client would reimplement the catch-up. With it, the
  daemon does the replay-then-live join once, using 002's `activitySince`.
- **Data directory is `<repo root>/.skelcrew/`.** The `.gitignore` entry already exists, the
  repo is the only container (`docs/MILESTONES.md`, settled 2026-09-08), and one daemon
  serves one repo, so the repo is the natural place for its state and socket. A home-directory
  layout keyed by repo would need a registry to find the socket from a shell inside the repo;
  walking up to `.git` needs nothing. `SKELCREW_DIR` exists for tests and for running against
  a directory that is not a repository.
- **Repo root discovery walks up for `.git`** (a directory or a file, to cover worktrees).
  No `git` subprocess.
- **Socket mode 0600, directory 0700**, set explicitly after creation, because Bun creates
  the socket world-accessible. Nothing else on the machine should be able to move cards.
- **Stale sockets are detected by connecting**, not by pid files: a successful connect means
  a daemon is alive, a refused connect means a leftover file. No pid file to go stale.
- **One request at a time per connection, in order.** The core is synchronous and
  in-process; there is no concurrency to gain and ordering makes the activity stream trivially
  consistent with responses.
- **The client lives in `shared`.** 001 described `shared` as "types shared across them", and
  a client is runtime code. It goes there anyway because every client package (004, a TUI)
  and every protocol test needs the same forty lines, and `shared` remains free of external
  dependencies, which was the actual constraint. Recording this so 001's description is read
  as updated rather than violated.
- **Line limit 1 MiB.** 002 caps a body at 64 KiB and a comment at 16 KiB; the largest
  legitimate message is a `getCard` result with a full activity log. 1 MiB is a defence
  against a runaway client, not a design limit; the implementer may pick a larger round number
  and must document it in the wire types.

## Acceptance criteria

1. `bun run check` exits 0 with tests under `packages/daemon/src/server/` and
   `packages/shared/src/` beyond those of 001 and 002.
2. With `SKELCREW_DIR` set to an empty temp directory, `bun packages/daemon/src/main.ts`
   prints exactly one stdout line matching `skelcrew daemon <version> listening on <dir>/
   skelcrew.sock`, creates `<dir>/skelcrew.db` and `<dir>/skelcrew.sock`, and keeps running.
   The socket's mode is 0600 and the directory's is 0700. On SIGTERM it exits 0 and the
   socket file is gone; the database file remains.
3. Run a second time while the first is running, `bun packages/daemon/src/main.ts` exits 1
   with a message containing the socket path and "already running", and the first daemon is
   unaffected. With the first daemon killed with SIGKILL so the socket file is left behind, a
   new daemon starts normally and replaces the file.
4. Run from a subdirectory of a git repository with no `SKELCREW_DIR`, the data directory is
   `<repo root>/.skelcrew/`. Run from a directory with no `.git` in any ancestor and no
   `SKELCREW_DIR`, it exits 1 with a message saying it is not inside a git repository, and
   creates nothing.
5. Over a raw socket, sending `{"jsonrpc":"2.0","id":1,"method":"listCards","params":{}}`
   before `hello` returns an error with code -32000 and `data.code` `no_session`. Sending a
   line that is not JSON returns code -32700 and the daemon closes the connection. Sending a
   JSON array returns -32600 and closes. Sending a line longer than the documented limit
   returns -32700 or -32600 and closes. The daemon keeps serving other connections.
6. `hello` with `{ kind: "human" }` returns the owner member and `{ version, protocol: 1 }`,
   where `version` equals `VERSION` from `@skelcrew/shared`. `hello` with `{ kind: "agent",
   name: "crew-1" }` on two separate connections returns the same member id both times and
   the activity log has one `member_joined`. A second `hello` on a connection returns
   `invalid`.
7. Through the shared client bound as the owner: `createCard({ title: "x" })` returns the
   card; `listCards({})` includes it; `getCard({ id })` returns it with a `card_created`
   event whose actor is the owner. Through a second client bound as agent `crew-1`,
   `comment({ id, text: "hi" })` records a `comment` event whose actor is the agent's id.
8. Through the agent client, `moveCard({ id, phase: "spec" })` on a card in `idea` rejects
   with JSON-RPC code -32003 and `data.code` `forbidden`, the card is still in `idea`, and a
   `move_rejected` event exists. Through the owner client the same move succeeds.
9. `getCard({ id: 999 })` rejects with -32001 / `not_found` and a message containing `999`.
   `setBody` with a body over the 002 cap rejects with -32002 / `invalid`. `moveCard` with
   `phase: 7` rejects with -32602 / `invalid_params` and no `move_rejected` event is
   recorded.
10. `frobnicate` rejects with -32601 / `method_not_found`.
11. Every method in the 002 spec's *Desired behavior* except `subscribe` has a same-named
    protocol method that succeeds through the client with the shapes in `packages/shared/src/
    protocol.ts`, and `listMembers` returns every member including the owner. A test
    enumerates the method table against the 002 list so a future core method cannot be added
    without a wire method.
12. With two subscribed connections and a third performing five mutations, both subscribers
    receive five `activity` notifications carrying those events, in increasing `seq`, with no
    gaps or duplicates. After `unsubscribe` on one, it receives nothing while the other still
    does.
13. A connection that subscribes with `since: n` after `m > n` events exist receives events
    `n+1..m` and then live ones, in order, with no gap or duplicate across the join, when
    mutations are being made concurrently by another connection while it subscribes.
14. Closing a subscribed client removes it from fan-out: the daemon keeps serving the others
    and records no error. Closing the client mid-request rejects the pending `call` promise.
15. `packages/cli/` is unchanged from the base branch. No package gains a dependency; the
    only new imports are Bun built-ins and `node:` modules.
16. `docs/MILESTONES.md`'s status section records that the data directory is
    `<repo root>/.skelcrew/` and identity is per connection via `hello`, as decisions later
    specs build on.

## Tests

All through observable behavior: the shared client and raw sockets against a server started
in-process on a temp socket path, plus one spawned process for the lifecycle criteria. No
test touches the repository's own `.skelcrew/` or any path under the repo.

- Process lifecycle: start line, files and modes, SIGTERM cleanup, second-daemon refusal,
  stale-socket recovery, repo-root discovery from a subdirectory of a temp git repository
  (create it with `git init` in the temp directory, or a bare `.git` directory), and the
  no-repository failure.
- Framing and session: request before `hello`, non-JSON, batch, oversize line, second
  `hello`, unknown method, invalid params, and that a failing connection does not affect
  another.
- Method parity: the enumeration test in criterion 11, and a round trip for each method
  through the client as owner and as agent, including the forbidden gate and the not-found and
  invalid mappings.
- Streaming: fan-out to multiple subscribers, ordering, `unsubscribe`, `since` replay with
  concurrent mutations, and disconnect handling.
- Client: `connect` rejects when `hello` fails; a pending `call` rejects on close.

The 002 core tests and the 001 wiring tests remain and must still pass. Red for this spec is
the parity test failing because `packages/shared/src/protocol.ts` does not exist.

## Out of scope

- CLI commands (004) and the runner (006). This spec produces a daemon and a client library,
  not a user interface.
- Claims, leases, attention requests, and their wire methods: 009 and 010 add methods to
  this protocol the same way they add them to the core.
- TCP, TLS, remote access, authentication, or any transport other than the unix socket.
  The framing is transport-agnostic; the transport is not this spec's to widen.
- Client reconnection, backoff, request timeouts, or request cancellation.
- JSON-RPC batch requests, and notifications from client to server.
- A daemon that serves more than one repository, or a registry of running daemons.
- Daemonization, log files, or running under a supervisor. `bun run daemon` runs in the
  foreground; putting it in the background is the shell's job for now.
- Changing anything in the 002 core beyond adding a `listMembers` read if it is missing.
