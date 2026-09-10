# 011 — The card records the artefacts it produced (run record)

Spec: `docs/specs/011-card-records-its-artefacts.md`. Branch `worktree-card-records-artefacts`
off `main` at `2f0798d`.

## Plan

1. **Red.** Tests first, in the suites that already cover this ground:
   - `packages/daemon/src/core/core.test.ts` — `specPath` accepted verbatim and merged; every
     rejection in criterion 4 as its own case (added to the existing `test.each` table, plus a
     byte-cap test shaped like the `branch` one); the keys a call set, read from the card's
     activity, including declaration order and a key the core skipped.
   - `packages/daemon/src/core/db.test.ts` — a `refs_set` row whose JSON has no record of the
     keys, written directly, reads back unchanged and needs no migration.
   - `packages/cli/src/render.test.ts` (new) — `describeRefs`, the detail block, the activity
     line for an event that carries the record, and the fallback for one that does not.
   - `packages/cli/src/cli.test.ts` — `refs --spec` end to end; the usage error naming all four.
2. **Green.** `packages/shared/src/types.ts`: `CardRefs.specPath`, `SPEC_PATH_MAX_BYTES`, the
   optional record on the `refs_set` variant; exported from `index.ts`.
   `packages/daemon/src/core/core.ts`: `specPath` in `validateRefs`, the set keys in `setRefs`.
   `packages/cli/src/commands/refs.ts`: `--spec`. `packages/cli/src/render.ts`: rendering.
3. `bun run check`.

## Decisions the spec left open

- **`SPEC_PATH_MAX_BYTES = 256`**, matching `BRANCH_MAX_BYTES` and `PR_URL_MAX_BYTES`; the spec
  names the constant but not its value.
- **The record is `data.set`**, an optional `(keyof CardRefs)[]` — "absent on events recorded
  before 011". `setRefs` fills it from `REF_KEYS`, which is `CardRefs` declaration order.
- **`specPath` is declared after `branch`**, so declaration order matches the render order the
  spec asks for (`branch`, `spec`, `commits`, `pr`).
- **A call that set nothing** renders as `set refs` with no trailing space, rather than
  `set refs ` — the same information, without trailing whitespace.
- Validation implements exactly the rejections the spec lists: empty, over the cap, leading
  `/`, a `..` segment, leading `./`, trailing `/`, NUL, newline. Nothing more (a bare `.` or a
  `docs/./x` is not on the list and stays accepted; the value is never resolved or read).
