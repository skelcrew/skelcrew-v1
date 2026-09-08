# 002 — Core state

## Goal

Give skelcrew its model: a card that can be filed, moved through the five phases, commented
on, and seen, with every mutation recorded and the owner's gates enforced in one place. This
is the interface every later surface is a client of — the JSON-RPC protocol (003), the CLI
(004), the MCP server (005), the runner (006) — so it has to exist, be small, and be right
before any of them can be specified. "Everything observable" and "approval gates are
human-only" are hard constraints in `AGENTS.md`; this spec is where they become code.

## Current behavior

There is no model. The daemon package is the 001 scaffold: `packages/daemon/src/main.ts`
prints `skelcrew daemon <version>` and exits, and `packages/shared/src/index.ts` exports one
constant, `VERSION`. No SQLite, no types beyond that, no tests beyond the three wiring tests.
The `.gitignore` already lists `.skelcrew/`, a data directory nothing creates yet.

The only prior art is the prototype spike on the `prototype` branch, in a different
architecture (a board server): `prototype:packages/shared/src/index.ts` defines `Member`,
`Lane`, `Card`, `Activity` types and eight lane names; `prototype:packages/board/src/db.ts`
holds a SQLite schema over `node:sqlite` with lanes as rows, UUID ids, JSON `refs`, claim and
attention columns on the card; `prototype:packages/board/src/core.ts` routes every mutation
through one module that appends an activity row, enforces `humanOnlyEntry` on lanes, and
emits activity on an `EventEmitter`. Three patterns from it survive into this spec — one
mutation module that logs, gates enforced in the core, an in-process activity event — and the
rest does not: lanes-as-rows, UUIDs, entry-side gates, and the claim/attention columns
(`docs/MILESTONES.md` moves those to 009 and 010).

`docs/MILESTONES.md` records the decisions this spec builds on: five phases named as states
(Idea, Spec, Code, PR, Done) with queued/running/waiting as a derived status rather than a
phase; the card body is one free markdown text, not fields, and the core does not inspect
it; the repo is the only container; card ids are short integers; archiving belongs here.

## Desired behavior

A caller holding a `Core` opened on a SQLite path sees the following. Every mutation names an
actor, a member id; a mutation by an unknown member fails and changes nothing.

- **Members.** On first open the core has exactly one member: the owner, kind `human`, named
  after the OS user. `ensureMember(name, "agent")` returns the same member on repeated calls
  and records a `member_joined` event only the first time. There is never a second human.
- **Cards.** `createCard({ title, body? })` returns a card in phase `idea` with an integer id
  that increases with each card, an empty refs block, the given body (default empty), and
  timestamps. `listCards()` returns unarchived cards in creation order; `getCard(id)` returns
  one card with its full activity, oldest first. An unknown id fails with a not-found error
  that names the id.
- **Phases.** `PHASES` is an ordered constant exported from `@skelcrew/shared`: `idea`,
  `spec`, `code`, `pr`, `done`, each with a display name (`Idea`, `Spec`, `Code`, `PR`,
  `Done`), a one-line artefact description, and who may move a card out of it. Moving out of
  `idea`, `spec`, and `pr` is the owner's alone; moving out of `code` is any member's. A
  card may be moved to any phase by a member allowed to move it out of its current one.
- **Gates.** A move by an agent out of `idea`, `spec`, or `pr` fails with a forbidden error
  naming the phase and the member; the card does not move, and a `move_rejected` event is
  recorded on the card with the actor, the attempted phase, and the reason. The core never
  inspects the body when moving a card; whether a spec is complete is a judgement the owner
  makes when leaving Spec, and the playbooks make when they read the card.
- **Moves.** A permitted `moveCard(id, phase, actor)` changes the card's phase, updates its
  timestamp, and records a `card_moved` event with from and to. Moving to the current phase
  is a no-op that records nothing.
- **Body.** `setBody(id, markdown, actor)` replaces the body and records a `body_set` event
  carrying the byte length, never the text. A body over 64 KiB is rejected as invalid.
- **Comments.** `comment(id, text, actor)` records a `comment` event carrying the text. Empty
  or whitespace-only text is rejected; text over 16 KiB is rejected as invalid.
- **References.** `setRefs(id, refs, actor)` merges `{ branch?, commits?, prUrl? }` into the
  card's refs and records a `refs_set` event with the resulting refs. `branch` is a non-empty
  string of at most 256 bytes, `commits` is an array of lowercase hex strings of 7 to 40
  characters, `prUrl` is an absolute `https` URL; anything else, including unknown keys, is
  rejected as invalid.
- **Archiving.** `archiveCard(id, actor)` marks the card archived, records `card_archived`,
  and removes it from `listCards()`; `listCards({ includeArchived: true })` and `getCard`
  still return it with its history. Mutations other than `comment` on an archived card are
  rejected as invalid. Archiving an archived card is a no-op that records nothing.
- **Activity.** Every event has a monotonically increasing `seq`, the card id (null for
  `member_joined`), the actor's member id, a type from a closed union, a data object, and a
  timestamp. `subscribe(listener)` delivers every event as it is recorded, in `seq` order, and
  returns an unsubscribe function. `activitySince(seq)` returns all events after `seq`.
- **Persistence.** Closing and reopening the core on the same path shows the same members,
  cards, and activity. Opening on `:memory:` gives a fresh, empty core for tests. Opening a
  database written by an older schema version migrates it forward; the core refuses to open a
  database whose version is newer than it knows.
- **Nothing else.** No claims, no leases, no attention requests, no network, no process
  lifecycle. `packages/daemon/src/main.ts` is unchanged.

## Implementation approach

### Where it lives

- `packages/shared/src/` — the types every client renders and the phase constant: `Card`,
  `Member`, `Activity` (and its typed event union), `CardRefs`, `Phase`, `PHASES`. Pure
  types and constants; `shared` stays dependency-free. Add `index.ts` re-exports.
- `packages/daemon/src/core/` — the implementation: `db.ts` (open, pragmas, migrations),
  `core.ts` (the `Core` interface and its SQLite implementation), `errors.ts` (`CoreError`).
  The daemon's `package.json` gains no dependencies; `bun:sqlite` is built in.
- Tests colocated as `*.test.ts` next to the modules, per 001's pattern, all against
  `openCore(":memory:")`.

### The interface

`openCore(path: string, options?: { owner?: string }): Core`. `Core` is a plain object of
methods, not a class hierarchy. Each mutation takes `actorId` last. Reads are synchronous;
`bun:sqlite` is synchronous and the core is in-process, so there is no reason to promise.

Every mutation is one `db.transaction`: read, validate, write, append activity, emit. The
event is emitted after the transaction commits, so a subscriber never sees an event whose
row could roll back.

### Schema

Three tables, integer primary keys, millisecond epoch timestamps, `PRAGMA journal_mode=WAL`
and `foreign_keys=ON` on open, schema version in `PRAGMA user_version` with an ordered
migration list applied in one transaction.

- `members(id, name, kind, created_at)` with a unique index on `(name, kind)`.
- `cards(id, title, body, phase, refs, archived_at, created_at, updated_at)`. `phase` is a
  text column constrained to the five ids; `refs` is a JSON text column; the phase list is
  not a table — it is the `PHASES` constant, and the constraint is the closed set of ids.
- `activity(seq, card_id, actor_id, type, data, created_at)` with an index on
  `(card_id, seq)`.

No column can hold a repository file: `body` and `data` are the only text columns of any
size, and both are capped in the core before they reach SQLite.

### Decisions resolved from repository context

- **The repo reference is not a column yet.** `docs/MILESTONES.md` says cards carry a repo
  reference so a second repo is additive. With no daemon lifecycle until 006 there is nothing
  to populate it from, and a column nothing reads is the kind of anticipation the owner asked
  to avoid. The core opens on one database; the daemon that owns a repo owns a database. 006
  adds the reference when the runner needs to know where to branch. Recorded here so 006
  does not treat its absence as an oversight.
- **Order is creation order.** The milestone's "order within the repo" is the id. No position
  column, no reorder operation; bulk filing from a milestones file (004) preserves file order
  by filing in sequence.
- **Gates are on exit, not entry.** The prototype gated entry into Ready and Done. With five
  phases, what the owner controls is what gets worked on (leaving Idea), what gets built
  (leaving Spec), and what ships (leaving PR). Gating exits gives one rule per phase and
  makes "send back with feedback" from PR an owner move like any other. The crew's only
  handoff is Code → PR, which is why `code` is the one phase anyone may leave.
- **The body is opaque to the core.** An earlier draft checked for Goal, Acceptance
  criteria, and Out of scope headings on entry to `code`; the owner dropped it to keep the
  model simple. The push toward those sections lives in the spec playbook's template (007)
  and in the develop playbook refusing a card without them, the way `/develop` does by hand
  today — not in the state.
- **Rejected gate moves are logged.** "Everything observable" applies to what an agent tried,
  and 010's attention queue will want the signal. The cost, noise from a misbehaving agent,
  is visible noise, which is the point.
- **Body cap 64 KiB, comment cap 16 KiB.** Spec 001 is 12 KiB; the largest plausible spec is
  a few times that. A comment is an excerpt by construction at 16 KiB. Both are named
  constants in `shared` so clients can validate before sending.
- **`body_set` carries length, not text.** The body is readable on the card; duplicating it
  into the log doubles storage for no reader. Comments carry their text because the log is
  where a comment lives.
- **Integer ids everywhere**, per the milestone: typeable at a CLI. Members too, for
  uniformity; members are addressed by id in the interface and by name only when joining.
- **Owner name from the OS user**, the prototype's pattern, overridable via
  `openCore(path, { owner })` so tests are deterministic.
- **Errors are one class with a code**: `CoreError` with `code` in `not_found | forbidden |
  invalid | conflict` and a message that names the thing (card id, phase, member).
  003 maps codes to JSON-RPC errors without parsing messages.

## Acceptance criteria

1. `bun run check` exits 0, and `bun test` reports tests under `packages/daemon/src/core/`
   and `packages/shared/src/` beyond 001's three wiring tests.
2. `openCore(":memory:")` yields a core with exactly one member, kind `human`; opening with
   `{ owner: "simon" }` names that member `simon`. `ensureMember("crew-1", "agent")` twice
   returns the same id both times and the activity log holds exactly one `member_joined`.
3. `createCard({ title: "x" }, ownerId)` returns a card in phase `idea` with an integer id;
   a second card's id is greater than the first's; `listCards()` returns both in that order;
   `getCard(id)` returns the card with one `card_created` event whose actor is the owner.
4. `getCard(999)` on an empty core throws a `CoreError` with code `not_found` whose message
   contains `999`. Any mutation with an unknown `actorId` throws `not_found` and leaves
   `listCards()` and the activity log unchanged.
5. `PHASES` from `@skelcrew/shared` has exactly five entries in the order `idea`, `spec`,
   `code`, `pr`, `done`, with display names `Idea`, `Spec`, `Code`, `PR`, `Done`; `exit` is
   `owner` for `idea`, `spec`, `pr`, and `done`, and `any` for `code`.
6. With a card in `idea`, `moveCard(id, "spec", agentId)` throws `forbidden` with a message
   containing `idea` and the agent's name; the card is still in `idea`; its activity gains
   one `move_rejected` event with the agent as actor and `spec` as the attempted phase. The
   same holds for an agent moving out of `spec` and out of `pr`.
7. With a card in `code`, `moveCard(id, "pr", agentId)` succeeds, records `card_moved` with
   from `code` and to `pr`, and the owner can then `moveCard(id, "code", ownerId)` (send
   back), recording another `card_moved`.
8. `moveCard(id, "code", ownerId)` succeeds on a card with an empty body; the core does not
   inspect the body on any move.
9. `moveCard(id, currentPhase, ownerId)` returns the card unchanged and records no event.
10. `setBody(id, "…", actor)` records `body_set` whose data has the byte length and no text
    field; a body of 64 KiB + 1 byte throws `invalid` and the body is unchanged.
11. `comment(id, "  ", actor)` throws `invalid`; `comment(id, "hello", agentId)` records a
    `comment` event whose data text is `hello` and whose actor is the agent; a 16 KiB + 1
    byte comment throws `invalid`.
12. `setRefs(id, { branch: "feat/x" }, actor)` then `setRefs(id, { prUrl:
    "https://github.com/o/r/pull/1" }, actor)` leaves the card with both, and the second
    `refs_set` event's data contains both. `setRefs` with `commits: ["abc"]`, with
    `prUrl: "http://…"`, or with an unknown key throws `invalid` and changes nothing.
13. `archiveCard(id, actor)` records `card_archived`; the card is absent from `listCards()`
    and present in `listCards({ includeArchived: true })` and `getCard(id)`; `moveCard` and
    `setBody` on it throw `invalid`; `comment` on it succeeds; a second `archiveCard` records
    nothing.
14. A listener registered with `subscribe` receives every event from criteria 3 through 13
    in increasing `seq` with no gaps or duplicates; after the returned unsubscribe function
    is called it receives nothing. `activitySince(n)` returns exactly the events with
    `seq > n`.
15. A core opened on a temporary file path, mutated (one member, two cards, three events on
    one of them), closed, and reopened on the same path shows identical members, cards, and
    activity. Its `PRAGMA user_version` equals the core's current schema version.
16. Opening a file whose `user_version` is greater than the core's schema version throws a
    `CoreError` with code `conflict` naming both versions and does not modify the file.
17. `packages/daemon/src/main.ts` and `packages/cli/` are unchanged from the base branch.
    Neither package has gained a dependency; `bun.lock` differs from the base only if Bun
    rewrites it for an unchanged manifest.
18. No source under `packages/` imports `node:sqlite`, and the only SQLite import is
    `bun:sqlite`.

## Tests

All behavioral, through `openCore` and the returned `Core`, against `:memory:` except the
persistence pair. Required coverage, each of which maps to a criterion above:

- Seeding: the single owner, its name override, and idempotent agent joining.
- Card creation, ordering, retrieval, and the not-found error for cards and actors.
- The `PHASES` constant's shape and order (in `shared`).
- Exit gates: an agent rejected out of `idea`, `spec`, and `pr`, with the `move_rejected`
  event and the card unmoved; an agent permitted out of `code`; the owner permitted
  everywhere. Send-back from `pr` to `code`.
- A move into `code` with an empty body succeeds.
- Same-phase move is a no-op.
- Body cap and `body_set` payload; comment validation, cap, and payload; refs merge, each
  invalid shape, and the `refs_set` payload.
- Archive semantics: listing, allowed and rejected mutations, idempotence.
- Subscription order, unsubscribe, and `activitySince`.
- Persistence round trip on a temp file, the recorded schema version, and refusal of a
  newer version. The temp file lives under the scratch directory Bun's test runner is given,
  never under the repo.

The three 001 wiring tests remain and must still pass. No test spawns a process or touches
the network.

Red for this spec is the `shared` test for `PHASES` and the first `openCore` test failing on
a missing export; each criterion's test should be written before the code that satisfies it,
per `AGENTS.md`'s definition of done.

## Out of scope

- Claims, leases, heartbeats, expiry, and the "run interrupted" event: 009.
- Attention requests, their actions, the owner's queue, and the ping: 010.
- Any network surface or process: JSON-RPC (003), CLI (004), MCP (005). `main.ts` stays a
  one-liner.
- The repo reference on a card and any notion of which repository the daemon serves: 006.
- Reordering cards, unarchiving, deleting, editing a title, or changing the owner's name.
- A default database path, the `.skelcrew/` data directory, or its creation. `openCore`
  takes a path; who chooses it is a later spec.
- Card status (queued, running, waiting on you) — derived from 009 and 010 once they exist.
- Rendering markdown, validating anything about the body beyond the size cap, or storing
  the spec anywhere but the card. Whether a body has Goal, Acceptance criteria, and Out of
  scope sections is the playbooks' concern (007), never the core's.
- Enforcing that only the runner may move `code → pr`; in this spec any member may.
