# 011 — The card records the artefacts it produced

## Goal

A card's `refs` should say where the spec it committed lives, and the activity log should say
which references a run actually set. Today neither is true, and both gaps have to be worked
around by guessing.

The 007 spike (`docs/plans/007-spike-retrospective.md`, §3) spent three review rounds failing
to guess the first one: a Code run that returns to a card must find the spec that card already
committed. Matching by number deadlocked revision runs; matching by content broke the moment
the owner approved revised text; matching by "number or content" shipped a stale spec in the
pull request. And because `refs_set` records only the merged result, "did *this run* record a
pull request?" cannot be answered: a run that writes any other reference while a `prUrl` sits
on the card satisfies the same check. 014's artefact contract needs both answers to be exact.

Identity is recorded when the artefact is made, not re-derived afterwards.

## Current behavior

- `CardRefs` (`packages/shared/src/types.ts:13`) is `branch?`, `commits?`, `prUrl?`. There is
  no reference to the spec a Code run commits into the target repository.
- `setRefs` (`packages/daemon/src/core/core.ts:603`) merges the patch over the card's existing
  refs and logs `refs_set` with the **merged** result:
  `log(id, actorId, { type: "refs_set", data: { refs: merged } })`. The keys the caller
  actually set are not recorded and cannot be recovered from the event.
- `validateRefs` (`packages/daemon/src/core/core.ts:203`) rejects unknown keys and validates
  each known one: `branch` non-empty within `BRANCH_MAX_BYTES`, `commits` a list of lowercase
  hex shas within `COMMITS_MAX_COUNT`, `prUrl` an absolute https URL within `PR_URL_MAX_BYTES`
  (`packages/shared/src/types.ts:79`, `:81`, `:83`).
- The CLI's `refs` command (`packages/cli/src/commands/refs.ts`) takes `--branch`, `--pr` and
  repeated `--commit`, and refuses a patch that would be empty.
- Rendering: `describeRefs` (`packages/cli/src/render.ts:86`) produces
  `branch=… commits=… pr=…`; the card detail lines above it produce `branch:`, `commits:` and
  `pr:`; and `refs_set` renders in activity as `set refs <describeRefs>`
  (`packages/cli/src/render.ts:145`).
- The database applies ordered migrations tracked by `PRAGMA user_version`
  (`packages/daemon/src/core/db.ts:5`); a migration is history and is never edited. Activity
  rows are stored as JSON and parsed with a cast (`packages/daemon/src/core/core.ts:151`), so
  rows written before a shape change do not carry fields added later.

## Desired behavior

**A card carries the path of the spec it committed.** A member can record it, read it back on
the card, and see it in the card's activity. The value is a path within the target repository —
`docs/specs/011-card-records-its-artefacts.md` — never a path outside it and never file
contents, so the "references, never contents" constraint holds.

**Setting references records which ones were set.** A reader of the activity log can tell
`skelcrew refs 1 --pr https://…` from `skelcrew refs 1 --commit abc1234` even when the card
already carried both, and can therefore answer "did this run record a pull request?" exactly
rather than approximately.

**History stays honest.** `refs_set` events recorded before this change did not capture which
keys were set, and that fact cannot be recovered — so they say so rather than claiming a set
that was inferred. A reader that needs precision treats an absent record as unknown, never as
"nothing was set".

Concretely, a member sees:

```
$ skelcrew refs 1 --spec docs/specs/011-card-records-its-artefacts.md
#1 branch=skelcrew/1-artefact-refs spec=docs/specs/011-card-records-its-artefacts.md
```

and in the card's activity, an entry naming what that call set rather than everything the card
now carries.

## Implementation approach

Four small changes across the three packages, following the shape each already has.

**`packages/shared/src/types.ts`** — `CardRefs` gains `specPath?: string`, and a
`SPEC_PATH_MAX_BYTES` constant beside the existing limits. The `refs_set` activity variant
(`:98`) gains the keys the call set. Both are exported from `packages/shared/src/index.ts`
alongside their neighbours.

The recorded keys are **optional on the type**, not required. A required field would be a lie
about every `refs_set` row already in a member's database: the merged-only event genuinely does
not say which keys a historical call set, and a migration cannot invent it without fabricating
history. Optional, documented as "absent on events recorded before 011", is the honest shape,
and it forces the consumers 014 will add to handle absence deliberately. No migration is
needed — the column holds JSON and old rows simply lack the field.

**`packages/daemon/src/core/core.ts`** — `validateRefs` gains a `specPath` case in the same
`switch`, and `setRefs` records the validated patch's keys alongside the merged refs.

`specPath` validation, stated exactly because a loose rule here becomes a path escape later:
a non-empty string, at most `SPEC_PATH_MAX_BYTES`, that is **relative to the target repository
root**. Reject an absolute path (a leading `/`), any path containing a `..` segment, a leading
`./`, a trailing `/`, and any NUL or newline. A Windows-style absolute path or drive letter is
out of scope for this repo's platforms and needs no special case beyond the rules above. The
value is stored verbatim after validation — not normalised, not resolved against a filesystem,
and never read. The core does not know whether the file exists; it holds a reference, and
whether the reference is good is the runner's business.

The recorded keys are the keys of the **validated patch**, in `CardRefs` declaration order, so
the record is stable and cannot contain a key the core rejected. A patch that sets nothing
records an empty list, which is the honest answer for a call that changed nothing.

**`packages/cli/src/commands/refs.ts`** — a `--spec <path>` option beside `--branch` and
`--pr`, folded into the same patch and the same "at least one of" usage error.

**`packages/cli/src/render.ts`** — `describeRefs` gains `spec=<path>`; the card detail block
gains a `spec:` line. Both place it after `branch` and before `commits`, matching the order the
references are produced in a run. The `refs_set` activity line (`:145`) reports what the call
set rather than the merged refs, falling back to today's rendering for an event that does not
carry the record — so an old row still renders, and renders no differently than it does now.

`packages/shared/src/protocol.ts:39` needs no change: `setRefs` already takes a `CardRefs`, so
the new key travels over the existing wire method.

## Acceptance criteria

1. `bun run check` passes: Biome, `tsc` for all three packages, and the full test suite.
2. `skelcrew refs <id> --spec docs/specs/011-x.md` succeeds and the path appears in the
   command's own output, in `skelcrew show <id>`, and in that card's activity.
3. `skelcrew refs <id>` with no option still fails with the existing usage error naming all
   four options.
4. A `setRefs` call rejects each of these with an `invalid` error, and writes nothing: an empty
   `specPath`; one over `SPEC_PATH_MAX_BYTES`; an absolute path (`/etc/passwd`); a path
   containing a `..` segment (`docs/../../etc/passwd`); a path with a leading `./`; a path with
   a trailing `/`; a path containing a newline or a NUL.
5. A `setRefs` call accepts a plain repo-relative path (`docs/specs/011-x.md`) and stores it
   byte-for-byte as given.
6. `setRefs` continues to merge: setting `specPath` on a card that already has `branch` and
   `prUrl` leaves both unchanged, and the resulting card carries all three.
7. The `refs_set` activity event records which keys the call set: setting only `prUrl` on a
   card that already carries `branch`, `commits` and `specPath` records exactly `["prUrl"]`,
   while the event's merged refs still carry all four.
8. The recorded keys are in `CardRefs` declaration order and contain no key the core rejected.
9. A `refs_set` event written before this change — one whose stored JSON has no record of which
   keys were set — is read back without error and renders in `skelcrew show` exactly as it does
   today. Opening such a database requires no migration.
10. Unknown ref keys are still rejected by name, as they are today.

## Tests

Behavioral coverage, asserting what a member sees on the card rather than internal helpers:

- **Core**: each rejection in criterion 4 as its own case, asserting the error and that the
  card's refs are unchanged; the acceptance and verbatim storage in criterion 5; the merge in
  criterion 6; the recorded keys in criteria 7 and 8, read from the card's activity.
- **Backward compatibility**: a `refs_set` row whose JSON lacks the record — written directly,
  the way `packages/daemon/src/core/db.test.ts` already writes fixture state — is read back and
  rendered without error (criterion 9).
- **CLI**: `--spec` reaching the daemon as part of the patch and its rendered output; the
  unchanged usage error when no option is given; `describeRefs` and the detail block including
  the spec path in the specified position.
- Existing `refs` coverage in the core and CLI suites must pass unchanged. A test that asserts
  today's `refs_set` rendering for a call that sets everything should still hold; if an
  existing assertion has to change, it is because the event's meaning changed, and the change
  belongs in the test that covers the new meaning rather than in a loosened old one.

## Out of scope

- **Any consumer of the new data.** The runner does not exist on `main`; 014 is what reads
  `specPath` and the recorded keys to enforce the Code contract. This spec only makes both
  recordable and readable.
- **The playbooks.** Telling an agent to record its spec path is 012's playbook text.
- **Validating that `specPath` points at a file that exists**, or that it is inside the card's
  branch, or that it looks like a spec. The core holds references and does not touch the target
  repository.
- **A general "artefact" entity, or references beyond this one key.** The card stays one object
  with a phase and a set of references; this adds a reference, not a model.
- **Backfilling the recorded keys for historical events.** It cannot be done truthfully, and
  criterion 9 requires that history says so rather than guessing.
- **Any change to `prUrl`, `branch` or `commits` semantics**, including the `commits` cap and
  the https-only rule for `prUrl`.
