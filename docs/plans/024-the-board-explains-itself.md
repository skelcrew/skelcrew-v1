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
- **`<HH:MM>` is the local time of day**, from `formatTime`'s last five characters. The table
  asks for `HH:MM` and that is what it gets, with no date — which is a real loss of information,
  because a claim is not short-lived: a heartbeat moves only the expiry, never `claimedAt`, so a
  claim is as old as the work it holds (a Code run plus its review rounds, each bounded by the
  runner's run limit), and `running since 23:40` can be from the previous day. The whole
  timestamp is on the card, which `show` prints. (Corrected after review round 1; the bullet
  used to say `CLAIM_TTL_MAX_SECONDS` bounded a claim's age, and it bounds one renewal.)
- **Where criterion 5's two raisers are asserted.** Both end to end in `contracts.test.ts`, as
  one case per raiser over a small table — the agent's own `skelcrew attention` question as
  `crew`, and the owner's note — each asserting that the request stands *and* that no second
  claim follows. The same two raisers are asserted at the core beside the sweep's other cases.

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

The three cases that were **green on their first run** are all criterion 5's — the sweep leaving
a request raised by anyone else standing: at the core, and through the runner for each of the two
raisers the criterion names (the agent as `crew`, and the owner). They assert behaviour that must
survive this spec rather than behaviour it adds, so they are guards. That they bite was checked
by dropping the raiser test from the withdrawal (`card.attention !== null` alone) and re-running
them: two failures in `contracts.test.ts` and one in `core.test.ts`, the condition then restored.

## Checks

- `bun run check` — passes: `biome ci .` clean over 90 files, `tsc` clean in all three packages,
  `769 pass / 0 fail` across 29 files. Nine of those cases are new here (two in `core.test.ts`,
  three in `contracts.test.ts`, three in `cli.test.ts`, one in `render.test.ts`), so the suite
  stood at 760 before.
- `bun run check:harness` — **not run, and not required**: it spawns the pinned coding agent to
  re-evaluate the playbooks' commands and the runner's fixed allowlist, and this spec changes
  neither (the diff touches no file under `packages/daemon/playbooks/` and not `allowlist.ts`).
- No test here spawns a coding agent or calls a model: `contracts.test.ts`'s driver is a
  scripted generator, which is the file's own boundary.

## Fix round 1

Five findings from the review, each with the test that pins it.

**1 (must fix) — the sweep withdrew a human holder's own request.** The condition asked only
`attention.raisedBy === claim.by`, and a human can hold a claim: `skelcrew claim` makes one that
nothing heartbeats, so it lapses after two minutes, and the sweep cleared the owner's own note
with it and handed the card to the runner. `core.ts`'s `sweepClaims` now reads the holder from
the members table and withdraws only when the holder exists and its kind is not `human`, which
is the rule the spec's *Desired behavior* now states; a holder the table cannot identify
withdraws nothing. `types.ts`'s doc comment said the justification was "nothing can answer a
question the run that asked it no longer exists to hear", which is false for a human holder, and
now says so.

Red first, twice:

```
(fail) claims > sweepClaims leaves a human holder's own request standing
expect(core.getCard(card.id).attention).toMatchObject({...})
Matcher error: received value must be a non-null object
```

and through the real runner, which is the criterion-5 case as the reviewer reproduced it:

```
(fail) a lapsed claim held by the owner withdraws nothing, and the runner does not take the card
-   "note": "rebase onto main first",       (expected)
+   "note": "run finished without a spec; the work is in …/worktrees/1",   (received)
```

— the owner's note gone and a Spec run finished over the work the owner had taken by hand.
Pinned by `core.test.ts`'s "sweepClaims leaves a human holder's own request standing" and
`contracts.test.ts`'s "a lapsed claim held by the owner withdraws nothing, and the runner does
not take the card", which asserts the note stands, no `attention_resolved`, one `claimed` event
(the owner's) and no run.

**2 (prose) — "a live claim is at most an hour old" was false.** `heartbeat` moves only
`expiresAt`, so `CLAIM_TTL_MAX_SECONDS` bounds one renewal and not a claim's age. `render.ts`'s
`clockTime` comment and the `<HH:MM>` bullet above now say what does bound it — the runner's run
limit times the review rounds one claim spans — and keep the time-only display.

**4 (minor) — the status column's escaping had no test.** A tab is the one character the column
has to escape itself: a note is a multi-line field, so `main.ts`'s sink keeps it. `cli.test.ts`'s
"a tab in a note is escaped in the status column, and the titles still line up" stores
`allow\tBash?` and asserts the cell reads `allow\\tBash?` with no raw tab on the row. It bites:
with `oneLine` dropped from `firstLine` it fails with
`Received: "!  #1  ○○●○○  Code  waiting on you: allow<TAB>Bash?  Tabbed"`, and `firstLine` was
restored afterwards.

**5 (minor) — `ls --json` made a round trip it does not use.** `listMembers` was awaited before
the result was returned, whichever output mode was in force, so `ls --json` failed when a call
only the renderer needs failed. `ls.ts` now reads the `--json` flag (as `watch` does) and fetches
the members only for the text board. Pinned by `cli.test.ts`'s "ls --json does not need the
member list the status column renders with", which serves a core whose `listMembers` throws:
`ls --json` prints the cards, and the text board fails with that error rather than inventing a
name. (Driven with `--as`, because `hello` lists the members itself for a human.)

**6 (minor) — two rendering redundancies.** An archived row said `archived` in the status column
and `(archived)` after the title; the suffix is gone, since an archived card's status always
says it. And a board where every status is blank still paid for the column's separator, putting
the title four spaces after the phase; the cell is now skipped when the column's width is zero.
The existing expected row in "ls says what each card is doing" asserted the old suffix — a test
of the old behaviour, so its expected string was updated rather than worked around — and
`cli.test.ts`'s "no card with a status means no status column, and the title follows the phase"
pins the spacing on an all-Idea board.

### Checks

- `bun run check` — passes: `biome ci .` clean over 90 files, `tsc` clean in all three packages,
  `774 pass / 0 fail` across 29 files. Five cases are new in this round (one in `core.test.ts`,
  one in `contracts.test.ts`, three in `cli.test.ts`), so the suite stood at 769 before it.
- `bun run check:harness` — not run, and not required: this round changes no playbook and not
  the runner's fixed allowlist.

## Fix round 2 — plan

1. Core: `sweepClaims(runnerId?)` withdraws only when `claim.by === runnerId`; the member-kind
   test and the unreachable holder guard go. `sweep.ts` forwards the id; `main.ts` supplies the
   runner member's id, and nothing with `SKELCREW_RUNNER=0`.
2. CLI: `ls` goes back to fetching `listMembers` unconditionally and knows nothing about
   `--json`; the round-1 test that pinned the reversed design is removed.
3. `render.ts`: `firstLine` falls back to the first non-empty line; `STATUS_WIDTH`'s comment
   records the UTF-16 padding limitation for 026.

Files: `packages/daemon/src/core/core.ts`, `packages/daemon/src/sweep.ts`,
`packages/daemon/src/main.ts`, `packages/cli/src/commands/ls.ts`, `packages/cli/src/render.ts`,
`packages/shared/src/types.ts`, and their tests.

### Fix round 2 — what changed

**1 (must fix) — the withdrawal asked the wrong question.** It asked whether the holder was a
human; what it needed was whether the claim was a run the runner heartbeats, and the core cannot
tell those apart on its own. An agent member that claims a card in a live session and asks the
owner a question looks exactly like a run, so round 1's defect survived for agent members: the
question was cleared 120 seconds later and the runner started a competing run on the card.

`sweepClaims(runnerId?)` now takes the member whose claims are runs and withdraws only when
`claim.by === runnerId` and `attention.raisedBy === claim.by`. `sweep.ts` forwards the id;
`main.ts` sets it where it joins the runner member (`core.ensureMember(RUNNER_MEMBER_NAME, …)`)
and leaves it unset with `SKELCREW_RUNNER=0` or outside a repository, so such a daemon withdraws
nothing. The member-kind test in the core is gone, and with it the `holder !== undefined` guard
and the fail-closed comment the reviewer showed was unreachable; `selectMember` is no longer read
by the sweep. `types.ts`'s justification for `interrupted` says the runner's, not a non-human's.

Pinned by four core cases and one runner case:
`core.test.ts`'s "sweepClaims leaves an agent member's own hand-made request standing" (red
first: the request was gone, `Matcher error: received value must be a non-null object`),
"sweepClaims with no runner id withdraws nothing, even the holder's own request" (red the same
way), the kept "sweepClaims leaves the owner's own request standing" and the renamed "sweepClaims
withdraws the runner's own request as interrupted", both now naming the runner explicitly; and
`contracts.test.ts`'s "a lapsed claim held by an agent member over the CLI withdraws nothing, and
no run starts", which is criterion 5's third half through the real runner. That last one was run
against the old kind-based rule to see it red, and it failed exactly as the review described —
the agent's question replaced by the runner's own `run finished without a spec` request:

```
- "note": "which repo should I use?", "raisedBy": 4,
+ "note": "run finished without a spec; the work is in …/worktrees/1", "raisedBy": 2,
```

`sweep.test.ts` gains "a sweep passes the runner's member id on, and nothing when there is no
runner" for the forwarding. Criterion 4's runner test still passes: the runner's claims carry the
runner's id, and the daemon's sweep is the caller that names it. Every other `sweepClaims` caller
in the tests now passes the runner's id where the daemon would; `db.test.ts`'s and
`protocol.test.ts`'s calls sweep no request and were left alone.

**2 (minor) — `ls` branched on its output mode.** `run` returned `render: () => ""` for `--json`,
which is correct only because `main.ts` never calls the renderer then, and the `Command` contract
exists so that `run` need not know. `ls.ts` is back to its earlier shape: it fetches `listMembers`
unconditionally the way `queue` does, knows nothing about `--json`, and passes `input` to
`listCards` again. Round 1's test "ls --json does not need the member list the status column
renders with" is **removed**: it pinned the design being reversed — with members fetched
unconditionally, `ls --json` against a core whose `listMembers` throws fails, which is what `queue`
does too. The cost is one round trip `--json` does not use, which is the shape the repository
already has.

**3 (minor) — three width units mixed in one column.** Not fixed, as directed: the limitation is
recorded beside `STATUS_WIDTH` instead. `cut` counts code points, `padEnd` counts UTF-16 units and
the terminal counts display cells, so a note of wide characters pushes that row's title right.
026's TUI needs a display-width measure and this column should adopt it then.

**4 (minor) — a note that begins with a newline.** `firstLine` took the literal first line, so
`waiting on you:` rendered with nothing after it. It now takes the first line with something on
it. Pinned by `cli.test.ts`'s "a note that starts with a newline shows its first line with
something on it", red first with
`Received: "!  #1  ○○●○○  Code  waiting on you:   Led with a blank line"`, and asserted on both
`ls` and `show`'s `now:` line with the whole note still on the card.

### Checks

- `bun run check` — passes: `biome ci .` clean over 90 files, `tsc` clean in all three packages,
  `778 pass / 0 fail` across 29 files. The suite stood at 774 after round 1: four cases are new
  (two in `core.test.ts`, one in `sweep.test.ts`, one in `contracts.test.ts`, one in
  `cli.test.ts`) and one was removed.
- `bun run check:harness` — not run, and not required: this round changes no playbook and not the
  runner's fixed allowlist.

## Fix round 3 — plan

One Important finding: the daemon-level wiring (`main.ts` passing the runner's id into
`sweepTick`) has no test, so removing it leaves every check green. Plan:

1. A daemon-level test in `packages/daemon/src/server/process.test.ts`, following its patterns:
   a real daemon with the runner on and `SKELCREW_AGENT=none`, a real lapse, the daemon's own
   five-second sweep.
2. The orchestrator's script claims a card in Idea; Idea is not claimable
   (`packages/shared/src/phases.ts:39`, `core.ts:806`), so the card is set up the way the live
   runner itself sets it up: 006's handoff leaves the card in Spec with a request the runner
   member raised and no claim, and the live runner will not touch it while that request is open
   (`runner.ts` `isReady`). A client that says `runner`/`agent` *is* that member, so it claims
   with a 10 s TTL (the minimum) and goes away.
3. The control beside it: the same lapse under `SKELCREW_RUNNER=0`, where the request stands.
4. Red first by removing `runnerId` from `main.ts`'s `sweepTick` call, then restoring it.

Files: `packages/daemon/src/server/process.test.ts` only, plus this record.

## Fix round 3 — what changed

**1 (important) — the daemon-level wiring had no test.** Fixed in
`packages/daemon/src/server/process.test.ts` with two tests against a real daemon.

"the daemon's sweep takes an interrupted run's own question with it, and the runner takes the
card again" spawns the daemon on a temp repo with the runner on and `SKELCREW_AGENT=none`, lets
006's handoff leave the card in Spec with a request the runner member raised, binds a second
client as `runner`/`agent` (asserting its id *is* the daemon's runner member), claims at the
minimum 10 s TTL and closes, then waits for the daemon's own five-second sweep. It asserts
`attention_resolved` with `{ how: "interrupted" }` attributed to the runner, that it follows
`run_interrupted` in the card's activity, and that the runner claims the card again afterwards —
which it could not while a request was open, so the re-claim is the proof the request went.

The orchestrator's script had the card claimed in Idea, which `claimCard` refuses (Idea is not
claimable); the handoff's own leftovers give the same shape in a phase that can be claimed, and
the live runner does not contest it because a card with an open request is never ready.

The control beside it, "with SKELCREW_RUNNER=0 a lapse withdraws nothing", runs the same lapse on
a daemon with no runner: the sweep expires the claim and the request stands, with the whole
activity asserted.

Red first, by removing `runnerId` from `main.ts`'s `sweepTick` call:

```
error: the daemon's sweep withdrew nothing within 30000 ms
(fail) the daemon's sweep takes an interrupted run's own question with it, and the runner takes
the card again [30150.46ms]
```

The control passed under the same mutation, as a control should. `main.ts` was then restored
unchanged (`git diff packages/daemon/src/main.ts` empty) and both tests pass.

### Checks

- `bun run check` — passes: `biome ci .` clean over 90 files, `tsc` clean in all three packages,
  `780 pass / 0 fail` across 29 files. The suite stood at 778 after round 2; both new cases are
  the ones above, and nothing was removed or changed.
- `packages/daemon/src/server/process.test.ts` run three times over: `18 pass / 0 fail` each
  time, because both new cases wait on real clocks.
- `bun run check:harness` — not run, and not required: this round changes no playbook and not the
  runner's fixed allowlist.
