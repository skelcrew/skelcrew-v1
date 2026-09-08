# 002 — Core state: run record

## Plan

1. Red: `packages/shared/src/phases.test.ts` asserting the shape and order of `PHASES`, and
   `packages/daemon/src/core/core.test.ts` + `db.test.ts` covering every criterion through
   `openCore`. Run `bun test`; both must fail on missing exports (`PHASES`, `openCore`).
2. Green, `shared`: `phases.ts` (`Phase`, `PhaseDef`, `PHASES`), `types.ts` (`Member`,
   `Card`, `CardDetail`, `CardRefs`, `Activity` + typed event union, size caps), re-exported
   from `index.ts`. No dependencies.
3. Green, `daemon`: `src/core/errors.ts` (`CoreError` with `code`), `src/core/db.ts` (open,
   pragmas, version check, ordered migrations under `PRAGMA user_version`), `src/core/core.ts`
   (`openCore`, the `Core` object; every mutation is one transaction that reads, validates,
   writes, appends activity, and emits after commit).
4. `bun run check`, then walk the criteria against the tests and the diff.

Files: `packages/shared/src/{phases,types,index}.ts`, `packages/shared/src/phases.test.ts`,
`packages/daemon/src/core/{errors,db,core}.ts`, `packages/daemon/src/core/{core,db}.test.ts`,
this file. `main.ts`, `packages/cli/`, both `package.json`s and `bun.lock` untouched.

## Decisions the spec left open

- **Seeding the owner records no event.** Criterion 2 says the log holds exactly one
  `member_joined` after two `ensureMember("crew-1", "agent")` calls, and "opening on
  `:memory:` gives a fresh, empty core". The owner is visible through `listMembers()`; its
  creation has no actor other than itself and is done by the core at open, not by a member.
- **`getCard` returns `Card & { activity }`** (`CardDetail` in `shared`), so a client that
  already renders a `Card` renders the detail unchanged.
- **Mutations return the resulting `Card`** (`comment` returns the recorded `Activity`,
  `ensureMember` the `Member`), so a caller sees the post-state without a second read.
- **`ensureMember(name, "human")`** returns the owner when the name matches and throws
  `conflict` otherwise — "there is never a second human".
- **A title must be non-empty after trimming** (`invalid`); the spec does not say, but an
  untitled card is unrenderable as a row.
- **The phase `CHECK` constraint in migration 1 is a literal list**, not generated from
  `PHASES`: a migration is a historical record and must not drift if the constant changes.
  A later phase change is a later migration.
- **`move_rejected` data is `{ from, to, reason }`** where `reason` is the forbidden error's
  message; `card_moved` is `{ from, to }`; `body_set` is `{ bytes }`; `refs_set` is
  `{ refs }` (the merged result); `card_created` is `{ title }`; `card_archived` is `{}`.
- **Same-phase move is checked before the gate**, so an agent "moving" an Idea card to Idea
  is a no-op, not a rejection. An archived card rejects the move first, even to its own phase.
- **The version check runs before `journal_mode=WAL`**: switching a file to WAL rewrites its
  header, and criterion 16 requires a refused file to be unmodified.
- **Ids use `AUTOINCREMENT`** so a card id or activity `seq` is never reused.

## Environment

Bun 1.3.14, macOS. `bun install` in the fresh worktree left `bun.lock` unchanged.

## Implementation run

Red: with the three test files written and no source, `bun test` reported 3 pass (001's
wiring tests) and 3 errors: `SyntaxError: Export named 'PHASES' not found in module
.../packages/shared/src/index.ts` and, twice, `error: Cannot find module './core' from
.../packages/daemon/src/core/{core,db}.test.ts`.

Green: after the six source files, 49 of 52 passed; the three failures were in the tests,
not the code — the `cardIn(phase)` helper moves the card there as the owner, which records a
`card_moved` the assertions had not counted. Fixed by asserting on `activitySince(seqBefore)`
taken after setup. `bun run fix` reformatted two of the new files (long lines); one typecheck
error in a test (narrowing the activity union for `data.reason`) was folded into
`toMatchObject` with `expect.any(String)`.

`bun run check`: exit 0 — `biome ci .` 24 files, typecheck clean in all three packages,
`bun test` 52 pass / 0 fail across 6 files (49 under `packages/daemon/src/core/` and
`packages/shared/src/phases.test.ts`; 001's three wiring tests still pass).

Mechanical checks: `git diff <base> -- packages/daemon/src/main.ts packages/cli
packages/*/package.json package.json bun.lock` is empty; `grep -rn node:sqlite packages`
finds nothing; the only SQLite imports are three `bun:sqlite` lines in `packages/daemon/src/core/`.

## Review round 1

Finding (Important): `title` and `commits` were uncapped, and both are copied into
`activity.data` (`card_created`, `refs_set`), so the spec's invariant — `body` and `data`
are the only large text columns and both are capped before SQLite — did not hold for those
two event types. The reviewer accepted judgement calls (a)–(d); (e), listener isolation, is
Minor and carried to the PR.

Numbers chosen (the spec gives none): `TITLE_MAX_BYTES = 256` and `COMMITS_MAX_COUNT = 256`,
exported from `shared` next to the body and comment caps so clients can validate first. A
256-entry list of 40-character shas serializes to about 11 KiB, well inside the 64 KiB body
cap; no real card title approaches 256 bytes, and a pasted file always does.

Red: the two boundary tests (`a title over TITLE_MAX_BYTES is invalid and files nothing`,
`a commit list over COMMITS_MAX_COUNT is invalid and changes nothing`) first failed on the
missing `shared` export; with the constants added and `core.ts` untouched they failed on the
behaviour — `expect(received).toBeInstanceOf(CoreError)` / `Received value: undefined`, the
oversize input being accepted. Green after the two checks in `createCard` and
`validateRefs`. `bun run check`: exit 0, 54 pass / 0 fail.

Reviewer's scenarios re-run against the fix: a 1 MiB title and a 200,000-entry commit list
are both rejected as `invalid`, with no card and no event written.

Addition (same round, on the point the implementer flagged): member `name` is copied into
`member_joined { name }`, so the same invariant applies. `MEMBER_NAME_MAX_BYTES = 256`
(same order as the title) exported from `shared`; `ensureMember` rejects a longer name as
`invalid` before the transaction, alongside the existing empty/whitespace rejection, which
gained a test of its own. Red: the boundary test failed with `Received value: undefined`
(the over-length name was accepted); green after the check. `bun run check`: exit 0,
56 pass / 0 fail. Note the owner seeded from the OS user name is not subject to the cap; it
is not a member mutation and records no event.

## Review round 2

Finding (Important): `prUrl` had no byte cap — a WHATWG URL's query can carry arbitrary
percent-encoded content, so `cards.refs` and the `refs_set` event could hold a file. Same
class as round 1. Fix: `PR_URL_MAX_BYTES = 256` exported from `shared`; `validateRefs`
rejects a longer URL as `invalid` before the merge. Boundary test: a 256-byte URL is
accepted, 257 rejected, and the reviewer's 1 MiB percent-encoded query is rejected, with the
card and activity unchanged.

Minor 1: `BRANCH_MAX_BYTES` moved from a private constant in `core.ts` to `shared`, beside
the other caps; a boundary test now pins it to the export (256 accepted, 257 rejected,
bytes not characters).

Minor 2: the seeded owner name bypassed `ensureMember`'s checks. One `memberName()` helper
now serves both: trim, non-empty, `MEMBER_NAME_MAX_BYTES`. `openCore` validates the owner
name (option or OS user) *before* opening the database, so `{ owner: "" }` and an over-long
owner throw `invalid` and touch nothing; `{ owner: " simon " }` seeds `simon`, and a later
`ensureMember(" simon ", "human")` returns that owner rather than throwing `conflict`.
Tests for all three cases.

Red: four tests failed for the intended reasons — `[" simon "]` received where `["simon"]`
was expected; `Received value: undefined` where a `CoreError` was expected for the empty
owner, the over-long owner, and the over-long `prUrl`. Green after the `core.ts` changes.
`bun run check`: exit 0, 61 pass / 0 fail.

### Every path that writes text into `cards` or `activity.data`, with its cap

| Column / event | Written by | Bound |
| --- | --- | --- |
| `members.name` | `openCore` (seed), `ensureMember` | `MEMBER_NAME_MAX_BYTES` (256 B), trimmed, non-empty |
| `cards.title` | `createCard` | `TITLE_MAX_BYTES` (256 B), non-empty |
| `cards.body` | `createCard`, `setBody` | `BODY_MAX_BYTES` (64 KiB) |
| `cards.phase` | `createCard` (`idea`), `moveCard` | closed set of five ids, `CHECK` in the schema |
| `cards.refs` | `setRefs` | JSON of `branch` (`BRANCH_MAX_BYTES`, 256 B) + `commits` (`COMMITS_MAX_COUNT` 256 × ≤40 hex chars ≈ 11 KiB) + `prUrl` (`PR_URL_MAX_BYTES`, 256 B); unknown keys rejected |
| `activity.type` | every mutation | closed union |
| `activity.data`: `member_joined { name, kind }` | `ensureMember` | name cap; kind is an enum |
| `activity.data`: `card_created { title }` | `createCard` | title cap |
| `activity.data`: `card_moved { from, to }` | `moveCard` | phase ids |
| `activity.data`: `move_rejected { from, to, reason }` | `moveCard` | phase ids; `reason` is a core-composed message containing only the phase id, the actor's (capped) name, the card id, and the target phase |
| `activity.data`: `body_set { bytes }` | `setBody` | a number |
| `activity.data`: `comment { text }` | `comment` | `COMMENT_MAX_BYTES` (16 KiB), non-empty |
| `activity.data`: `refs_set { refs }` | `setRefs` | the merged refs, bounded as `cards.refs` above |
| `activity.data`: `card_archived {}` | `archiveCard` | empty |

No other statement writes text. `activity.card_id`, `actor_id`, `seq`, and all timestamps
are integers. Every cap is checked in the core before the `INSERT`/`UPDATE`, inside the
mutation's transaction, and every cap constant is exported from `@skelcrew/shared`.

## Review outcomes (orchestrator)

- Round 1: CHANGES REQUESTED — title, commit list, and member name uncapped, breaking the
  storage invariant. Fixed (TITLE_MAX_BYTES, COMMITS_MAX_COUNT, MEMBER_NAME_MAX_BYTES).
- Round 2 (fresh reviewer): CHANGES REQUESTED — prUrl uncapped, same class. Fixed
  (PR_URL_MAX_BYTES; BRANCH_MAX_BYTES moved to shared; seeded owner validated like joiners).
- Round 3 (fresh reviewer): CHANGES REQUESTED — Important: `mutate` dispatches events to
  listeners synchronously with no re-entrancy guard; a listener that mutates makes later
  listeners receive events out of `seq` order (reproduced: A sees [3, 4], B sees [4, 3]).
  Minor: `move_rejected.reason` interpolates the caller-supplied id rather than `card.id`;
  sparse `commits` arrays pass `every`. Carried-forward Minors unchanged.
- Review budget (3 cycles) exhausted with an Important finding open. Run stopped and
  returned to the owner; branch `worktree-core-state`, implementation uncommitted in the
  worktree, `bun run check` green (61 pass).

## Review round 3

Finding (Important): `mutate` delivered events to listeners synchronously with no
re-entrancy guard, so a listener that mutated from inside its callback pushed the nested
events to every listener before the outer event had finished its round — a later listener
saw `seq` out of order. Fix: `dispatch()` in `core.ts` is a queue. Recorded events are
appended to `pending`; if a drain is already running the call returns and the outer drain
picks them up after the current event has reached every listener. Test: two subscribers,
the first commenting re-entrantly on a specific comment; both receive `[n, n+1]`, and the
outer mutation still returns its own committed event.

Listener isolation (the carried Minor) fell out of the queue: each listener call is wrapped,
so a throwing listener neither stops delivery to the remaining listeners nor wedges the
dispatcher (`dispatching` resets in `finally`). The first error is rethrown from the
mutation *after* the drain, so it is never silent — the trade is that the mutation's caller
sees a listener's error although the mutation committed and every listener received the
event. Test: a throwing subscriber plus a recording one; the mutation throws `boom`, the
comment is persisted, the second listener got it, and the next mutation still delivers.

Minor 1: `move_rejected.reason` now interpolates `card.id` from the row read, not the
caller's argument. Both `readCard` and `getMember` now `requireId()` — a number that
`Number.isInteger` accepts — and throw `invalid` otherwise, so `" 1"`, `"1.0"`, `"1e0"`,
`"1"`, `1.5`, `NaN`, `null`, and `undefined` never coerce to card 1 through SQLite's type
affinity. The member lookup got the same guard because it takes the same path (an actor id
is also a bind parameter); the finding named the card lookup only.

Minor 2: `commits` is validated with an index loop (`isShaList`) instead of
`Array.prototype.every`, which skips holes; `[, "abcdef0"]` and `new Array(3)` are `invalid`.

Red: 11 tests failed for the intended reasons — string ids coerced to card 1 (no error
thrown), non-string non-integers surfaced as `not_found` rather than `invalid`, the sparse
array was accepted, the second subscriber received `[n+1, n]`, and the throwing listener
stopped delivery. Green after the `core.ts` changes; one typecheck error in a new test
(narrowing the activity union) was fixed in the test. `bun run check`: exit 0, 73 pass /
0 fail.
- Round 4 (fresh reviewer, after the owner authorised one more fix round): APPROVED. Dispatch
  queue verified under nested mutations, unsubscribe/subscribe during dispatch, throwing
  listeners, and close() from a listener. New Minors carried to the PR: a listener
  unsubscribed by an earlier listener still receives the in-flight event; a listener's
  CoreError can replace the mutation's own CoreError to the caller (sharper form of the
  carried listener-error trade-off, for 003 to settle); prUrl accepts userinfo; a
  whitespace-only branch is accepted; non-string title/body/text/name throw TypeError rather
  than CoreError invalid.
