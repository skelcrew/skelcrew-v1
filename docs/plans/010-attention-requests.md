# 010 — Attention requests: run record

## Plan

1. Red, core: `packages/daemon/src/core/core.test.ts` gains an `attention` describe (raise,
   replace, validation, resolution by move / archive / answer with exact event sequences,
   permission on answer, same-phase and comment non-resolutions, the list and its filter)
   and `db.test.ts` gains persistence of the list and migration from a literal 002-schema
   file. First failure: `core.requestAttention is not a function`.
2. Green, `shared`: `Attention` and `OpenAttention` in `types.ts`, `Card.attention`, the two
   events in `ActivityEvent`; the three methods in `protocol.ts` and `METHOD_NAMES`.
3. Green, core: migration 2 adds one JSON column `attention` to `cards` (NULL when none);
   `requestAttention`, `resolveAttention`, `listAttention`; the resolution hook in
   `moveCard` and `archiveCard` inside the same `mutate` transaction.
4. Red then green, wire: `protocol.test.ts` round trips as owner and agent, wrong-shaped
   params, the two events on the stream; handlers in `server/protocol.ts`.
5. Red then green, CLI: `queue`, `attention`, `resolve`, `watch` commands, `notify.ts`
   (selection over `SKELCREW_NOTIFY` / platform / PATH, injected), the `ls` marker column,
   the `show` header block and the two activity summaries, no-command routed to `queue`.
   Watch tests use a recording shell script named by `SKELCREW_NOTIFY`.
6. `docs/MILESTONES.md`: one status bullet for `Card.attention` and `SKELCREW_NOTIFY`.
7. `bun run check`, then the criteria against the tests and the diff.

Files: `packages/shared/src/{types,protocol,index}.ts`, `packages/daemon/src/core/{db,core}.ts`
and their tests, `packages/daemon/src/server/protocol.ts` and its test,
`packages/cli/src/{main,render,notify}.ts`, `packages/cli/src/commands/{command,queue,attention,
resolve,watch,ls,show,mv}.ts`, `packages/cli/src/{cli,notify}.test.ts`, `docs/MILESTONES.md`,
this file. `bun.lock`, `server.ts`, `main.ts` of the daemon untouched.

## Decisions the spec left open

- **One JSON column.** `cards.attention` holds `{ to, note, moves, raisedBy, raisedAt }` as
  JSON or NULL; `listAttention` filters on `json_extract(to)`. Five columns would buy a
  foreign key on `to` and nothing else.
- **"Oldest first" is raise order, keyed on the activity seq.** A first draft ordered by
  `raisedAt` with the card id as tiebreaker; the core test raised two cards in the same
  millisecond and got id order, which is wrong. The list now orders by the seq of each
  card's latest `attention_requested` event (a subquery over the `(card_id, seq)` index),
  which is exact and needs no schema change.
- **`watch` installs its signal handlers before anything is awaited.** With `--since`, the
  replayed lines print during `subscribe`; a ctrl-c between the first line and the ready
  line hit Bun's default handler and exited 130. Found by the `--since <seq>` test.
- **Event payloads.** `attention_requested.data` is `{ to, note, moves }`; `raisedBy` and
  `raisedAt` are the event's `actorId` and `createdAt`, the way `card_moved` does not repeat
  its actor. `attention_resolved.data` is `{ how: "moved", phase }`, `{ how: "archived" }`,
  or `{ how: "answered" }`.
- **`requestAttention` and `resolveAttention` return the card**, like the other card
  mutations. `moves` is stored as given (no dedupe). `resolveAttention` with `text: ""` is
  `invalid`, the same as `comment`; only an absent text means "no comment".
- **Wire params are flat**: `requestAttention { id, to, note, moves? }`, matching how `setRefs`
  flattens `id` next to its payload.
- **`--to` resolution is client-side** through `listMembers`, and an unknown name is
  reported as a `not_found` `RpcError` built in the CLI so the message has the same
  `(not_found)` suffix a daemon refusal would.
- **`ls` always has the marker column** (`!`, `?`, or a space) so rows align whether or not
  anything is waiting.
- **`watch` prints a ready line to stderr** (`watching as <name>; ctrl-c to stop`) once
  subscribed, so a caller — and the test — knows live events will now arrive. Event lines go
  to stdout. The notification for an addressed request is sent (and awaited) before that
  event's line is printed, so the line is proof the ping went out. `--json` is not given a
  meaning for `watch`.
- **Notifier selection** scans `PATH` itself for an executable rather than spawning `which`,
  so the unit test runs nothing: `SKELCREW_NOTIFY` first; then `osascript` on darwin; then
  `notify-send` on any platform; else a `[notify]` line on stdout.
- **The existing `await failed(2, [])` assertion** in the usage test is removed: the spec
  makes no-command the queue, so that line is contradicted by the spec, not weakened.

## Review round 1

Two Important findings and Minors 3–5 fixed; judgement calls (b), (d), (e), (f) stand as
reviewed. Minor 6 is carried to the PR by the coordinator.

- **Important 1 — the ping was keyed on two clock reads.** `raisedAt` came from the
  mutation's `Date.now()` and the event's `createdAt` from `log`'s own, so a millisecond
  straddle (measured by the reviewer at 32 in 20,000) made `watch` treat a brand-new live
  request as history and skip the notification, silently. Now `attention_requested.data` is
  the full `Attention` record — `{ to, note, moves, raisedBy, raisedAt }` from the one `now`,
  the spec's "with the same fields" — and `watch` matches the card's open request by
  `data.raisedAt` and `data.raisedBy`. Tests: the core assertion compares `event.data` to
  `card.attention` by value, and the protocol stream test asserts the two fields; neither
  depends on `createdAt`.
- **Important 2 — `watch` outlived its daemon.** `run` only returned on SIGINT/SIGTERM and
  the client had no way to observe close, so a stopped daemon left a tail that looked alive.
  `Client` gains `closed: Promise<void>` (resolved on close from either side; tested in
  `client.test.ts`), `Context` gains `socketPath`, and `watch` races the signal promise
  against `closed`: losing the daemon throws, so the CLI prints `error: lost the daemon on
  <socket>; run \`bun run daemon\` …` and exits 1. Test: "watch exits 1 with an error
  naming the socket when the daemon goes away" stops the in-process server under a
  subscribed `watch`.
- **Minor 3 — a failing notifier hid the event line.** The line is now printed first and
  unconditionally; the ping follows, and its failure is an `error:` line on stderr while the
  tail continues. Test: "watch still prints the event line when the notifier fails…" points
  `SKELCREW_NOTIFY` at a missing script. Reordering meant the first watch test could no
  longer use "the line is out, so the ping is done"; it now waits for a following comment's
  line, and raises the request to someone else on a second card so the watcher's request is
  not replaced before its ping is checked (replacement would correctly suppress it).
- **Minor 4 — `watch --json` printed `null` on exit.** It is now a usage error (exit 2),
  the simpler of the two options offered.
- **Minor 5 — duplicated comment validation.** `comment()` calls `requireText("comment",
  text)`; the existing comment tests cover it.

## Review outcomes (orchestrator)

- Round 1: CHANGES REQUESTED — Important: the watch ping compared two independent clock
  reads (raisedAt vs the event's createdAt), silently skipping ~0.16% of live requests;
  watch hung forever when the daemon exited. Both fixed (event data carries the attention
  record; the client exposes `closed` and watch races it). Minors taken: tail line printed
  independently of the ping; `watch --json` is a usage error; `comment()` reuses
  `requireText`. Carried: an agent can clear an owner-addressed request by archiving or by
  re-raising to itself and answering, both permitted by the spec and logged.
- Round 2 (fresh reviewer): APPROVED. Both fixes reproduced; notifier argv verified with
  quotes, `$`, backticks, and a raw newline; no test fires a real notification. New Minors
  carried to the PR: the tail waits on each ping's subprocess with no timeout, so a hung
  notifier stalls later lines; `SKELCREW_NOTIFY` is spawned as a bare executable path while
  the docs call it a "command".
