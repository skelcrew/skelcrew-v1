# 024 — The board explains itself

Run record for `docs/specs/024-the-board-explains-itself.md`.

## The change, in steps

1. **`packages/shared/src/types.ts`** — `AttentionResolution` gains `{ how: "interrupted" }`.
2. **`packages/daemon/src/core/core.ts`** — `sweepClaims` clears the lapsed card's open request
   when `attention.raisedBy === claim.by`, and logs `attention_resolved` with
   `{ how: "interrupted" }` attributed to `claim.by`, after that card's `run_interrupted`.
3. **`packages/cli/src/render.ts`** — `status(card, me, members, now)` returns the table's text;
   `row` prints it as a column between the phase name and the title, `cardView` prints it as a
   `now:` header line first after the title, and `describeResolution` renders the new resolution.
4. **`packages/cli/src/commands/ls.ts`** — fetches `listMembers` (as `queue` does) for
   `waiting on <name>`; `show.ts` passes the invoking member for `waiting on you`.
5. **Tests** — `core.test.ts` beside `sweepClaims`'s cases, `contracts.test.ts` beside the
   lapsed-lease case, `cli.test.ts` for the rendered board and `show`, `render.test.ts` for the
   resolution line.

## Files expected to change

- `packages/shared/src/types.ts`
- `packages/daemon/src/core/core.ts`, `core.test.ts`
- `packages/daemon/src/runner/contracts.test.ts`
- `packages/cli/src/render.ts`, `render.test.ts`
- `packages/cli/src/commands/ls.ts`, `show.ts`
- `packages/cli/src/cli.test.ts`
- this record

## What the spec left open, and how it was decided

- **The status column's width.** Criterion 2 says "the note cut to the column width", and the
  approach says a fixed width cut by characters rather than bytes. A column fixed at its widest
  (`waiting on you: ` plus a note) would push every title right even on a board of `queued`
  cards, so the column is the widest status in *this* listing, capped at `STATUS_WIDTH` (40
  characters), and any status longer than the cap is cut to it with `…`. On a board carrying a
  waiting card the note is the longest status, so the cut width and the column width are the
  same number, which is what the criterion describes.
- **`archived` outranks everything.** The table gives no order for it. The core clears both the
  claim and the request when a card is archived, so no archived card can be in another row of
  the table today; checking it first is what keeps an archived card in a claimable phase from
  reading `queued` if one ever were.
- **A blank status prints no `now:` line.** The table's blank row is "nothing to say"; a `now:`
  label with nothing after it says nothing, and the four states criterion 3 names all have text.
  `ls` still holds the column open for such a card, so the columns line up.
- **`<HH:MM>` is the local time of day**, from `formatTime`'s last five characters. A live claim
  is at most an hour old (`CLAIM_TTL_MAX_SECONDS`), so the date is today's but for a lease that
  crosses midnight; the table asks for `HH:MM` and that is what it gets.
- **Where criterion 5's two raisers are asserted.** The agent-as-`crew` case is end to end in
  `contracts.test.ts` (the request stands *and* no second claim follows); the owner's own note is
  asserted at the core, beside the sweep's other cases, where "the request stands" is the whole
  of it — the runner's `isReady` already refuses any card with an open request, which the `crew`
  case exercises.

## Red, then green

Tests first, in all four files.

- **`core.test.ts`.** Red on the request the sweep left behind:

  ```
  expect(core.getCard(card.id).attention).toBeNull();
  error: expect(received).toBeNull()
  Received: {
    to: 1,
    note: "allow Bash? (skelcrew resolve 1 -m allow | …)",
    moves: [], raisedBy: 2, raisedAt: 1700000000000,
  }
  (fail) claims > sweepClaims withdraws the lapsed holder's own request as interrupted
  ```

- **`contracts.test.ts`.** Red on the same thing through the real runner, with the note the run
  itself raised — the observed shape of 2026-09-14:

  ```
  expect(core.getCard(1).attention).toBeNull();
  error: expect(received).toBeNull()
  Received: {
    note: "allow Bash? (skelcrew resolve 1 -m allow | skelcrew resolve 1 -m deny)\ninput:\n> rm -rf build",
    …
  }
  (fail) a lapsed lease takes the run's own question with it, and the card is claimed again
  ```

- **`cli.test.ts`.** Red three times: no status cell in any row (`- "waiting on you: allow Bash?
  (skelcrew r…"` and five more, against `+ 0` received), `now:` absent from `show`'s header
  (`+ "phase:   Code"` where the second line should be `now:`), and no `resolved attention` line
  at all after the sweep.

- **`render.test.ts`.** Red on `describeResolution`, which had no `interrupted` branch.

Green came from three small changes: the new member of `AttentionResolution`, the withdrawal in
`sweepClaims`, and `status` in `render.ts` with its two callers.

The two cases that were **green on their first run** are both criterion 5's — the sweep leaving
a request raised by anyone else standing, at the core and through the runner. They assert
behaviour that must survive this spec rather than behaviour it adds, which is what criterion 5
asks for; they are guards, and they would have failed against a withdrawal that read the
request's addressee instead of its raiser.

## Checks

- `bun run check` — passes: `biome ci .` clean over 90 files, `tsc` clean in all three packages,
  `768 pass / 0 fail` across 29 files. Eight of those cases are new here (two in `core.test.ts`,
  two in `contracts.test.ts`, three in `cli.test.ts`, one in `render.test.ts`), so the suite
  stood at 760 before.
- `bun run check:harness` — **not run, and not required**: it spawns the pinned coding agent to
  re-evaluate the playbooks' commands and the runner's fixed allowlist, and this spec changes
  neither (the diff touches no file under `packages/daemon/playbooks/` and not `allowlist.ts`).
- No test here spawns a coding agent or calls a model: `contracts.test.ts`'s driver is a
  scripted generator, which is the file's own boundary.
