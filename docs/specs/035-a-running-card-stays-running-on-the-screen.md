# 035 — A running card stays running on the screen

Milestone 035 in `docs/MILESTONES.md`, found on 2026-09-17 in the first afternoon of real use
of the chat view. This spec grants nothing: it changes which clock the screen believes.

## Goal

A run that is alive looks alive on the screen for as long as it is alive. Today every run
looks dead two minutes in: the board row says `interrupted` and the chat's listening line says
`no run is live; the next run reads what you write here`, while the daemon's lease is being
renewed and the agent is working. The owner read that line, thought an allowed permission had
gone nowhere, and asked. After this spec the screen trusts the daemon's events about whether a
run is live, and only the daemon's own `run_interrupted` turns a running row into a free one.

## Current behavior

Every claim below was run, on 2026-09-17, against the owner's daemon and the code at `b310d5c`.

- `packages/daemon/src/core/core.ts:853`, `heartbeat`: renews the lease (`expiresAt = now +
  ttlSeconds`) inside `mutate(() => …)` with no `log` call. A heartbeat writes no activity
  event. Verified: `skelcrew show 3 --json` at 16:28:08 showed the claim expiring at 16:29:49
  while the card's last event was at 16:26.
- `packages/cli/src/board/state.ts:213`, `apply` on `claimed`: sets the card's claim from the
  event's data — `expiresAt: event.data.expiresAt`, the first expiry, two minutes out for a
  120-second lease. `:224`, `released` and `run_interrupted`: clears the claim.
- `packages/cli/src/board/board.ts:381-390`, `onEvent`: reads a card back with `getCard` when
  it is missing from the board or is the open card; the read replaces `detail` and appends a
  missing card, but a card already on the board is left as it was (`: state.cards`). So a
  running card's `expiresAt` on the screen is the one from the `claimed` event, forever.
- `packages/cli/src/render.ts:161`, `status`: `card.claim.expiresAt > now ? running since … :
  "interrupted"`. `:100`, `marker`: `*` live, `~` lapsed. Both take `now` from the caller;
  the screen passes `Date.now()` at each frame (`frame.ts`, `frame(state, size, now)`), and
  `ls` passes it once against a card it just fetched.
- `frame.ts`, `listeningLine` (033): `crew is listening · running since …` when `status`
  starts with `running since`; otherwise `no run is live; …`. So the chat inherits the same
  falsehood.
- `packages/daemon/src/sweep.ts` and `core.ts`, `sweepClaims` (009, 024): every five seconds
  the daemon expires lapsed claims, whoever holds them, and logs `run_interrupted`. A real
  lapse is announced on the card within five seconds.
- Observed on card 3: claimed 16:23; at 16:26 the chat said no run was live and the row said
  `interrupted`; `skelcrew ls` in a terminal said `running since 16:23`; the agent posted
  further tool summaries at 16:26. Reviewers of 026, 027, 032 and 033 never saw it because
  their live sessions were shorter than a lease and their tests use fake clocks.

## Desired behavior

**The screen believes events, not its clock, about a lease.** A card the screen holds with a
claim shows `running since <time>` on its row, `*` in the marker column, and `crew is listening
· running since <time>` on the chat's listening line, until an event on that card says the
claim is gone: `released`, `run_interrupted`, `card_moved`, `card_archived`. The `~` marker
and the word `interrupted` no longer appear on the screen for a live-looking claim; they
remain the terminal's, where `ls` and `show` fetch fresh and the clock is right.

**A real lapse still shows, within the sweep's interval.** When a lease truly lapses (the
laptop slept, the daemon was killed under the run), the daemon's sweep logs `run_interrupted`
within five seconds and the screen's row goes to `queued` or `waiting on you` on that event,
as it does today. In the seconds between the lapse and the sweep the screen still says
running, which is honest: the daemon has not said otherwise.

**A refetched card refreshes the board too.** When the loop reads a card back because it is
the open card, the board's copy is replaced as well as `detail`, so the row and the chat never
disagree about the same card.

**`ls`, `show` and `queue` are unchanged.** They fetch and print once; the clock is fresh
there and 024's words stand.

## Implementation approach

`render.ts`: `status` and `marker` take, in place of `now: number`, a clock that is either a
time or the instruction to trust events — the smallest honest shape is `now: number |
"events"`, where `"events"` means a claim present on the card is live. `ls.ts`, `show.ts` and
`queue.ts` keep passing `Date.now()`. `frame.ts` passes `"events"` everywhere it calls
`status` or `marker` (the board rows, the card header's `now:` line through `cardHeader`, the
listening line); `clockTime` still formats `claimedAt`. `board.ts`'s `onEvent`: when the read
card is already on the board, replace it in `state.cards` in place; the `missing` branch stays.

Decisions resolved from the repository: trust events rather than have the daemon log a
heartbeat, because a heartbeat every thirty seconds is not activity and CLAUDE.md's "everything
observable" is about what an agent does, not the lease's plumbing; a clock argument rather than
a separate `screenStatus`, because 024 put the derivation in one place so `ls` and `show`
cannot disagree, and the screen must not become a second derivation; the `~` marker becomes
terminal-only rather than being removed, because `ls` still sees lapses the sweep has not
reached and 024's row test pins it; refreshing the board copy on refetch is included because
it is the second half of the same lie (the board and the chat showing different claims for one
card) and is three lines in the same function.

## Acceptance criteria

1. `bun run check` passes; no test opens a real terminal, spawns a real coding agent or calls a
   model.
2. `status(card, me, members, "events")` for a card whose claim's `expiresAt` is in the past
   returns `running since <time>`; `status(card, me, members, Date.now())` for the same card
   returns `interrupted`. The same pair for `marker`: `*` and `~`.
3. Through the loop with a fake clock or a fixture claim already expired: a board frame drawn
   an hour after a `claimed` event, with no other event on the card, still shows `running since
   <time>` and `*`; the chat's listening line still says `crew is listening`.
4. Through the loop: a `run_interrupted` event on that card turns the row to `queued` (Spec
   phase) and the listening line to `no run is live; …`; a `released` event does the same.
5. Through the loop: when the open card is read back on an event, the board's row for it
   reflects the read card (assert on a field the event did not carry, such as a changed
   title or the claim's `expiresAt`), not the pre-event copy.
6. `ls` and `show` through the real CLI on a card with an expired claim still print
   `interrupted` and `~`; 024's tests pass unchanged.
7. No frame contains a colour escape.
8. `docs/MILESTONES.md` marks 035 landed at landing.

## Tests

- Criterion 2 in `render.test.ts`, pure.
- Criteria 3–5 in `board.test.ts` with the injected streams and fake client, in the shape of
  033's loop tests; the fake client's card can carry an already-expired claim.
- Criterion 6 is 024's existing tests in `cli.test.ts`.
- Red first: criteria 2, 3 and 5 fail on today's code.

## Out of scope

- **A heartbeat event.** Rejected above.
- **The five-second window** between a lapse and the sweep's event. Honest as it is.
- **Refetching every card on every event.** Only the open card and missing cards are read
  back today; a quiet running card that is not open updates on its own events, which a run
  posts often.
- **The status column's UTF-16 padding.** Carried since 024. This spec touches `status`'s
  clock only; the padding is `row`'s and the next spec that touches `row` owes it.
