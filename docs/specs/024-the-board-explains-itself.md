# 024 — The board explains itself

The third of three specs from the first evening of real use (022, 023, 024).

## Goal

`skelcrew ls` should say what each card is doing and what, if anything, it needs from you, in
words. Today it shows one character — `!`, `?`, `*`, `~` or a space — and a row of circles, and
`show` prints every event since the card was made, oldest first, with the thing you need on the
last line. Last night the owner could not tell from the board that a run had been interrupted
and was waiting on a question nobody could answer. After this spec one `ls` reads as a status
report, `show` leads with the card's current state, and a run interrupted by a lapsed lease takes
its own stale question with it so the card goes back to the queue on its own. This spec grants
nothing.

## Current behavior

- `packages/cli/src/render.ts:92-96`, `marker`: `!` waiting on me, `?` waiting on someone else,
  `*` live claim, `~` lapsed claim not yet swept, space otherwise. `row` prints the marker, the
  id, the phase track, the phase name and the title.
- `render.ts:245`, `cardView`: header lines (`phase:`, a claim line, attention lines, refs,
  created, updated), then the body, then the whole activity oldest first.
- `packages/daemon/src/core/core.ts:879`, `sweepClaims`: clears a lapsed claim and records
  `run_interrupted`; it does not touch the card's attention request.
- `packages/daemon/src/runner/runner.ts`: an abandoned run writes `run abandoned: <reason>` and
  nothing else (014's rule). If the run was waiting on its own permission question when the
  lease lapsed, that question stays open, addressed to the owner, and 013 records that nothing
  can answer it once the run is gone: `resolve -m allow` allows nothing.
- `runner.ts:107`, `isReady`: a card with an open attention request is not ready, so the card
  above is neither running nor queued until the owner clears the request by hand.
- Observed 2026-09-14 on card 1: the laptop slept, the claim lapsed at 20:11, the sweep wrote
  `run_interrupted` at 20:13, the run wrote `run abandoned`, and the card sat with `!` and
  `allow Bash?` for a day.

## Desired behavior

**`ls` says the status in words.** After the phase name and before the title, a status column:

| Card state | Status |
| --- | --- |
| attention addressed to me | `waiting on you: <note's first line, cut>` |
| attention addressed to someone else | `waiting on <name>` |
| live claim | `running since <HH:MM>` |
| lapsed claim, not yet swept | `interrupted` |
| no claim, no attention, claimable phase | `queued` |
| no claim, no attention, other phase | *(blank)* |
| archived | `archived` |

Waiting outranks running, as the marker does today. The marker column stays, so a reader who
learned it loses nothing. The note is cut to fit a terminal width the way titles are, with the
whole note still on the card.

**`show` leads with now.** The header gains a `now:` line carrying the same status text as `ls`,
first after the title. The activity order is unchanged (oldest first; 015's marking depends on
the layout), and the header answers without the feed, so a reader who reads only the top has
the answer. (The spec as approved said the feed's last line "is the same fact" as the `now:`
line; it is not, a running card's last line is usually a comment. The orchestrator corrected
the sentence after review round 1.)

**`queue` is unchanged**, except that its entries carry the `why:` line 022 adds.

**An interrupted run takes its question with it.** When the sweep lapses a claim held by a
non-human member and the card's open attention request was raised by that lapsed holder, the
sweep resolves that request as `interrupted` and records it, attributed the way
`run_interrupted` is. The card is then free in its phase and the runner claims it again on the
next scan. A request raised by anyone else — the agent's own `skelcrew attention` question as
`crew`, the owner's note — stands, because it is not the run's and can still be answered. A
lapsed claim held by a human (the owner took the card by hand with `skelcrew claim`, and
nothing heartbeats a human's claim) withdraws nothing: the owner is still there to answer,
and the request is not a run's. When the holder's kind cannot be established the request
stands, failing closed. `show` renders the resolution as `resolved attention: interrupted`.
(The spec as approved said "raised by the lapsed holder" with no condition on the holder's
kind; review round 1 showed that clearing the owner's own note and handing the card to the
runner. The orchestrator added the condition after that round.)

## Implementation approach

CLI: `render.ts` gains `status(card, me, members, now)` returning the table's text and used by
`row` and `cardView`. `rows` needs member names for `waiting on <name>`, so `ls` fetches
`listMembers` as `queue` already does. Column widths follow the existing `padEnd` pattern; the
note is cut with `oneLine` and a fixed width, not by bytes, since this is a screen column. The
phase track stays.

Core: `sweepClaims` reads each lapsed card's `attention`; when `attention.raisedBy ===
claim.by` and the holder is a member whose kind is not `human`, it clears it and logs
`attention_resolved` with `{ how: "interrupted" }`, a new member of `AttentionResolution`,
attributed to `claim.by` as `run_interrupted` is. The runner's existing endings are unaffected:
an abandoned run still writes its one comment, and finds no request of its own to worry about.
One edge, recorded rather than handled: `endRun` raises its failure request and releases the
claim in separate mutations, but `endRun` is synchronous and the sweep is a timer on the same
thread, so a lapse cannot fall between them. The edge is reached another way: when the release
itself fails (`ending.ts` warns and goes on), the claim outlives the ending, and the next lapse
withdraws the ending's request, including 019's parked note; the card then re-runs, visibly,
which is the lease's ordinary answer. (The spec as approved said "the same synchronous
mutation" and did not name the failed-release path; the orchestrator restated it after review
round 1.)

Decisions resolved from the repository: the sweep withdraws rather than the runner, because the
core refuses a non-human actor clearing a request addressed to the owner (010's fail-closed
rule) and that rule is right; the sweep already acts on the core's own facts (the lapse) and this
is one more fact about the same claim. Status is derived from `claim`, `attention` and `phase`
and stored nowhere, which is what CLAUDE.md says a card's status is. `updatedAt` is not shown as
"last activity" because a heartbeat does not move it and a comment does; a truthful "last
activity" needs the feed, which `ls` does not fetch.

## Acceptance criteria

1. `bun run check` passes.
2. `skelcrew ls` on a board holding one card of each row in the table prints the status column
   as the table says, in that column position, with the note cut to the column width and the
   marker column still present. Asserted through the real CLI against a real core.
3. `skelcrew show <id>` prints `now: <status>` as the second header line for a waiting card, a
   running card, an interrupted card and a queued card; the activity order is unchanged.
4. A claim that lapses while the card's open request was raised by the claim's holder: after
   `sweepClaims`, the card has no attention request, the activity carries `run_interrupted`
   followed by `attention_resolved` with `how: "interrupted"` attributed to the holder, and the
   runner claims the card again on the next scan. Asserted against the real runner with a
   scripted driver that asks a permission question and a fake clock that lapses the lease.
5. A claim that lapses while the open request was raised by someone else (the agent as `crew`;
   the owner): the request stands and the card is not re-claimed. A claim held by the owner
   (`skelcrew claim`, never heartbeated) that lapses while the owner's own request is open: the
   request stands, and the card is not re-claimed by the runner. (Added after review round 1.)
6. `show` renders the new resolution as `resolved attention: interrupted`; `--json` carries it
   as stored.
7. 010's and 009's existing tests pass unchanged; `render.test.ts`'s row tests are extended, not
   rewritten (the marker assertions stay).

## Tests

- Criteria 2, 3 and 6 in `cli.test.ts` and `render.test.ts`.
- Criteria 4 and 5 in `contracts.test.ts` or `runner.test.ts`, whichever holds the lease-lapse
  cases today, with the fake `now`.
- Core-level: the sweep's new behaviour in `core.test.ts` beside `sweepClaims`'s cases.

## Out of scope

- **A "last activity" column.** Needs the feed; a TUI's job.
- **Reversing the activity order** in `show`. 015's line marking assumes the layout.
- **The TUI.** Card 2 on the board; this spec makes the CLI honest until it exists.
- **Reminders for a request that stays open** (023's finding).
- **Any change to what a permission question says** — 022.
