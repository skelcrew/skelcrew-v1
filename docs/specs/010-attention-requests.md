# 010 — Attention requests

## Goal

Make "waiting on you" a thing the system knows. Every agent run ends in a decision only a
person can make: approve this spec, merge this PR, answer this question, deal with this
failure. Today a card with a finished draft looks exactly like one nobody has touched, and
the owner would have to read every card's activity to find out which ones are blocked on
them. This spec adds the attention request: a card handed to a member with a note and the
moves that would resolve it, recorded as activity, shown as the CLI's home view, and pushed
to the owner as a notification so nothing waits unnoticed. `AGENTS.md` calls the owner's
queue the most important thing to show, because the human is the bottleneck by design.

## Current behavior

Nothing represents a pending decision. The core (`packages/daemon/src/core/core.ts`) has
cards, phases, members, comments, refs, and archiving; a `Card` carries no notion of who it
is waiting on. The prototype spike had `waiting_on` / `waiting_note` columns and an
`attention_requested` event (`prototype:packages/board/src/core.ts`, `requestAttention`,
`clearAttention`), cleared whenever the card moved or was claimed; `docs/MILESTONES.md`
records the spike's finding that such a request "should offer Approve → next lane / Send
back with feedback, not rely on the human knowing which drag resolves it". The spike's
"lane" is now a phase and "drag" is `skelcrew mv`.

The protocol (`packages/shared/src/protocol.ts`) has a closed `Methods` table mirroring the
core, and `packages/daemon/src/server/protocol.test.ts` enumerates the core's keys against it,
so a core method without a wire method fails a test. The CLI (`packages/cli/src/main.ts`)
has one module per verb under `packages/cli/src/commands/`; with no command it prints a
usage error and exits 2. `skelcrew ls` rows are id, phase track, phase name, title
(`packages/cli/src/render.ts`). The shared client (`packages/shared/src/client.ts`) already
exposes `subscribe(handler, since?)`, which nothing in the CLI uses yet.

`docs/MILESTONES.md` places this spec after 004 because agent invocations of the CLI are the
first real producers, and records the decision that queued / running / waiting on you is a
status within a phase rather than a phase; this spec supplies the "waiting" half of that
status. The 001 run produced the case that shapes the note field: an implementer found a
contradiction in its spec and needed to hand the card to the owner naming the conflict.

## Desired behavior

### In the model

- A card has at most one open attention request: `{ to, note, moves, raisedBy, raisedAt }`.
  `to` is a member id, `note` is text, `moves` is a possibly empty list of phase ids the
  raiser suggests as resolutions. It appears on the `Card` as `attention` (or `null`).
- `requestAttention(id, { to, note, moves? }, actor)` sets it and records an
  `attention_requested` event with the same fields. Any member may raise one, to any member,
  including themselves. Raising while one is open replaces it and records a new event. A
  `note` that is empty, or over the comment cap, or a `to` that is not a member, or a phase
  id not in `PHASES`, is `invalid` / `not_found`, and nothing changes. An archived card
  cannot be waited on.
- It resolves in three ways, each recording an `attention_resolved` event carrying `how`
  and the resolving actor: any `moveCard` that changes the card's phase (`how: "moved"`,
  with the phase); `archiveCard` (`how: "archived"`); or `resolveAttention(id, text?,
  actor)` (`how: "answered"`), which records the optional text as a `comment` event first.
  A comment on its own does not resolve anything. Only the addressee or the owner may call
  `resolveAttention`; another member gets `forbidden` and a `move_rejected`-style
  `resolve_rejected` event is not needed: nothing is recorded, the error is enough.
  Resolving when nothing is open is `invalid`.
- `listAttention({ to? })` returns the open requests, oldest first, each with its card id,
  optionally filtered to one addressee.

### On the wire

`requestAttention`, `resolveAttention`, and `listAttention` are protocol methods with the
same names and named params minus `actorId`; the two new events flow through the existing
`activity` stream. The parity test keeps passing because every core addition has a wire
method.

### In the CLI

- `skelcrew` with no command, and `skelcrew queue`, print what is waiting on the invoking
  member, oldest first: one block per request with the card id and title, its phase, who
  raised it and when, the note verbatim, and the suggested resolutions written as the
  commands that perform them (`skelcrew mv 12 code`, `skelcrew resolve 12 -m "…"`). When
  nothing is waiting it says so. `--json` prints the `listAttention` result. `queue --all`
  shows every open request regardless of addressee.
- `skelcrew attention <id> <note> [--to <member>] [--move <phase>]...` raises a request;
  `--to` defaults to the owner, so an agent's usual call is `skelcrew attention 12 "spec
  ready" --move code`. `--to` takes a member name.
- `skelcrew resolve <id> [-m <text>]` resolves the open request on the card with an optional
  answer.
- `skelcrew ls` marks a card that is waiting on the invoking member with `!` in a column
  before the id, and a card waiting on someone else with `?`. `skelcrew show` prints the
  open request in the header block and the two new events in the activity.
- `skelcrew watch` subscribes to the activity stream and stays running: it prints one line
  per event as it happens (the same line `show` renders), and when an `attention_requested`
  event addresses the invoking member it sends an OS notification whose title is
  `skelcrew` and whose text is the card id, title, and note. The notification command is
  `osascript` on macOS and `notify-send` where present; if neither exists it prints a marked
  line instead. `--since <seq>` replays from a sequence number first. Ctrl-C exits 0.

## Implementation approach

### Where it lives

- `packages/shared/src/types.ts` — `Attention` shape, `Card.attention`, the two new event
  types in `ActivityEvent`. `packages/shared/src/protocol.ts` — the three methods.
- `packages/daemon/src/core/` — a migration adding the attention columns (or one JSON
  column) to `cards`; `requestAttention`, `resolveAttention`, `listAttention` on `Core`;
  the resolution hook inside `moveCard` and `archiveCard`, in the same transaction as the
  move so the two events commit together.
- `packages/daemon/src/server/protocol.ts` — handlers and param shapes for the three
  methods.
- `packages/cli/src/commands/{queue,attention,resolve,watch}.ts`, the `ls` marker and
  `show` header in `render.ts`, and `main.ts` routing no-command to `queue`. The notifier
  is a small module taking the command to run, injected so tests replace it.
- Tests colocated as before: core tests through `openCore`, protocol round trips through
  the shared client, CLI tests spawning the CLI against an in-process daemon. The watch
  test spawns the CLI with an environment variable pointing the notifier at a script that
  appends its arguments to a file, and asserts on the file.

### Decisions resolved from repository context

- **One open request per card, on the card.** The card is the unit and "waiting on" is a
  property of it, like phase. A separate table would allow several open requests on one
  card, which has no consumer and complicates every view. Replacing on re-raise is what an
  agent updating its note wants; the log keeps both.
- **Resolution is a move, an archive, or an explicit answer; never a bare comment.** The
  milestone says resolving is "an ordinary move or comment through the 002 interface". A
  move resolves because it is the decision. A comment cannot, because agents comment on
  cards all the time and a stray remark must not clear a request addressed to the owner;
  `resolve -m` is the comment that means "answered". This is the one place a new verb was
  needed, and it exists so that a comment stays a comment.
- **`moves` are phase ids, not free-text actions.** With five phases and one comment verb,
  every resolving action is either `mv <id> <phase>` or `resolve <id>`, so the request can
  carry the phases and the CLI renders the commands. Free-text action labels were the
  prototype's shape and would have to be kept in sync with the phase names.
- **Only the addressee or the owner may answer.** Fails closed, like the gates: an agent
  cannot clear a request addressed to the owner by answering it itself. The owner may
  answer anything because the owner may do anything.
- **The queue is the no-command default.** `AGENTS.md`: the owner's home view is this queue.
  Today no-command is a usage error, so nothing breaks; `help` still prints usage.
- **`--to` defaults to the owner and takes a name.** The overwhelming case is an agent
  handing off to the human; names are what the CLI shows and what `--as` takes. The daemon
  resolves the name to an id (`listMembers`), so the wire method takes an id.
- **The ping is a subprocess, injected.** `osascript -e 'display notification …'` is the
  zero-dependency mechanism on macOS, `notify-send` on Linux; both verified present or
  absent by `which`. Spawning a notifier is not spawning a coding agent, but tests still
  never fire a real notification: the notifier command comes from an environment variable
  (`SKELCREW_NOTIFY`, a command that receives title and text as arguments) which tests
  point at a recording script. When unset, the platform default is used.
- **`watch` also tails.** Subscribing only to ping would leave the terminal blank; printing
  every event costs nothing and is the live form of the card's run record. It is not the
  TUI: no screen, no cursor, one line per event.
- **No expiry, no reminders, no snooze.** A request stays open until resolved. Reminders are
  a later finding if the queue proves easy to ignore.
- **Status derivation.** With this spec a card is "waiting" when `attention` is non-null;
  "queued" and "running" arrive with 009. The CLI shows only what exists.

## Acceptance criteria

1. `bun run check` exits 0 with new tests under `packages/daemon/src/core/`,
   `packages/daemon/src/server/`, and `packages/cli/src/`.
2. Core: `requestAttention(id, { to: ownerId, note: "spec ready", moves: ["code"] },
   agentId)` sets `getCard(id).attention` to those fields plus `raisedBy: agentId` and a
   timestamp, and records one `attention_requested` event with the same data. Raising again
   replaces the request and records a second event. An empty note, a note over the comment
   cap, an unknown `to`, or a move `"review"` throws `invalid` or `not_found` and changes
   nothing. Raising on an archived card throws `invalid`.
3. Core: with a request open, `moveCard` to a different phase clears `attention` and
   records `card_moved` then `attention_resolved { how: "moved", phase }` in the same
   transaction (both present after, neither present if the move is rejected). A same-phase
   move leaves the request open and records nothing. `archiveCard` resolves with `how:
   "archived"`. `comment` leaves it open.
4. Core: `resolveAttention(id, "yes", ownerId)` records `comment { text: "yes" }` then
   `attention_resolved { how: "answered" }` and clears the request; without text only the
   resolution is recorded. Called by the addressee (an agent the owner asked) it succeeds;
   called by another agent it throws `forbidden` and the request stays open; called with no
   open request it throws `invalid`.
5. Core: `listAttention()` returns open requests oldest first with card ids;
   `listAttention({ to: ownerId })` filters; a resolved request no longer appears; the list
   survives close and reopen of the database.
6. A database created by 002's schema migrates forward on open, and its cards read back
   with `attention: null`.
7. Wire: the parity test passes; `requestAttention`, `resolveAttention`, `listAttention`
   round-trip through the shared client with the shapes in `protocol.ts`; a subscribed
   client receives `attention_requested` and `attention_resolved` events in `seq` order.
8. CLI: with a request raised by `crew-1` to the owner on card 1 with `--move code`,
   `skelcrew` (no command) and `skelcrew queue` both print a block containing `#1`, the
   title, the phase name, `crew-1`, the note, and the literal `skelcrew mv 1 code` and
   `skelcrew resolve 1`; `queue --json` equals `listAttention({ to: ownerId })`. With nothing
   open, the output says so and exits 0. `queue --as crew-1` shows only requests addressed
   to `crew-1`; `queue --all` shows every open request.
9. CLI: `skelcrew attention 1 "spec ready" --move code --as crew-1` raises to the owner;
   `--to crew-2` raises to that agent; `--to nobody` exits 1 with `not_found`; `--move
   review` exits 2 listing the phase ids; `skelcrew attention 1` with no note exits 2.
10. CLI: `skelcrew mv 1 code` resolves the request (the queue is then empty); `skelcrew
    resolve 1 -m "looks fine"` records the comment and resolves; `resolve 1` again exits 1
    with `invalid`; `resolve 1 --as crew-9` on a request addressed to the owner exits 1 with
    `forbidden`.
11. CLI: `skelcrew ls` marks the waiting card with `!` for the addressee, `?` for anyone
    else, and nothing once resolved; `skelcrew show 1` prints the open request (addressee,
    raiser, note, suggested moves) in the header and both events in the activity.
12. CLI: `skelcrew watch` with `SKELCREW_NOTIFY` pointing at a recording script prints one
    line per event as another client comments and moves, invokes the script exactly once
    when a request is raised to the invoking member (with `skelcrew` and a text containing
    `#1`, the title, and the note), does not invoke it for a request to someone else, and
    exits 0 on SIGINT. `watch --since 0` replays existing events first, in order.
13. With `SKELCREW_NOTIFY` unset, `watch` selects `osascript` on macOS or `notify-send`
    where found on `PATH`, and otherwise prints the notification as a marked line; a unit
    test covers the selection without running anything.
14. `docs/MILESTONES.md`'s status section records that "waiting" is `Card.attention` and
    that `SKELCREW_NOTIFY` overrides the notifier.

## Tests

- Core: raise, replace, validation, resolution by move / archive / answer with the exact
  event sequences, permission on answer, the same-phase and comment non-resolutions, the
  list and its filter, persistence, and migration from a 002-schema file.
- Protocol: parity, round trips for the three methods as owner and agent, the two events on
  the stream.
- CLI: the queue in both forms and both filters, raising with each flag, resolving by move
  and by answer including the forbidden and invalid cases, the `ls` markers, `show`
  rendering, and `watch` with the recording notifier including the negative case and
  `--since`. The notifier selection is a unit test over a fake `PATH` and platform.

Existing tests for 002, 003, and 004 remain and must pass; `ls` and `show` tests that assert
exact row text may need the new marker column accounted for, which is a widening, not a
loosening. Red for this spec is the core test failing on a missing `requestAttention`.

## Out of scope

- Claims, leases, and the "queued" and "running" statuses: 009. The runner raising requests
  automatically at the end of a phase or from `canUseTool`: 007.
- Reminders, expiry, escalation, snoozing, or more than one open request per card.
- Notification channels beyond the local OS notification (Slack, email, push).
- A TUI or any screen-based view; `watch` is a line-per-event tail.
- Free-text action labels; resolutions are phase moves and answers only.
- Resolving by comment alone.
- Rendering markdown in the note.
