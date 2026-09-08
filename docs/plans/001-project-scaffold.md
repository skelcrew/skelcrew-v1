# 001 — Project scaffold: run record

## Plan

1. Red: run `bun run check` on the tree with no `package.json` and quote the failure. Write
   the three wiring tests (`packages/*/src/*.test.ts`) before any manifests or source exist
   and run `bun test` from the root to confirm they fail because the wiring does not exist.
2. Green: root `package.json` (workspaces, scripts, devDependencies), `tsconfig.base.json`,
   `biome.json`, three workspace packages each with `package.json`, `tsconfig.json`, and one
   source file. `bun install` produces `bun.lock`.
3. Edit `AGENTS.md` *Definition of done* (one sentence) and `docs/MILESTONES.md` status
   paragraph (one finding). Nothing else outside `packages/`.
4. Run `bun run check`, then verify criteria 4–7 by hand (introduce defect, run, revert).

Files: `package.json`, `bun.lock`, `tsconfig.base.json`, `biome.json`,
`packages/{shared,daemon,cli}/{package.json,tsconfig.json,src/*}`, `AGENTS.md`,
`docs/MILESTONES.md`.

## Decisions the spec left open

- Formatter style: Biome defaults except `lineWidth: 100` (matches the prose width used in
  `AGENTS.md` and the specs) and double quotes. One root config, applied to all packages.
- Biome major version: whichever `bun add -d @biomejs/biome` resolves to; `biome.json` is
  written against that version's schema (checked after install, not assumed).
- The `shared` wiring test compares against the root `package.json` version by importing the
  file (`../../../package.json`) rather than reading it from disk, so the test carries no
  filesystem code.

## Environment

Bun 1.3.14 (`bun --version`), macOS.

## Implementation run

Resolved versions (from `bun add -d`): typescript 7.0.2, @types/bun 1.4.2, @biomejs/biome
2.5.12. `biome.json` was written for the 2.x schema; Biome 2.5 deprecates
`linter.rules.recommended` in favour of `linter.rules.preset`, so `biome migrate --write` was
run once and the migrated file is what ships.

Red: `bun run check` before any manifest existed printed `error: Script not found "check"`
(exit 1). The three wiring tests, written before any package or source existed, failed under
`bun test` with `Cannot find module '../../../package.json'` (shared) and
`Cannot find module '@skelcrew/shared'` (daemon, cli) — 0 pass, 3 fail — which is the
intended reason: the wiring under test did not exist.

Green: `bun run check` exits 0; `biome ci .` checks 16 files, typecheck runs once per
package via `bun run --filter '@skelcrew/*' typecheck`, `bun test` reports 3 pass across 3
files. A checksum of every non-ignored file before and after `check` was identical.

Hand-verified (introduce, run `check`, restore) with a script kept outside the repo:
`debugger;` in each of the three sources (named by `lint/suspicious/noDebugger`), a
misformatted line in `daemon/src/main.ts` (named under `format`; `bun run fix` restored it
byte-for-byte), `const wrong: number = "…"` in each of the three sources (`error TS2322` with
file and line), and a wrong `toBe` in each test (`1 fail` naming the test). A second
`bun install` reported "no changes" and left `bun.lock` identical.

The typecheck script briefly used `--filter '@skelcrew/*'` on the assumption that `'*'`
would also match the root manifest (which has its own `typecheck` script) and recurse. A
throwaway workspace outside the repo showed `bun run --filter '*'` on Bun 1.3.14 runs only
workspace packages, never the root, so the script now uses the spec's `--filter '*'`.

Spec conflict to surface: criterion 10 ("no `package.json` … has a `dependencies` field with
entries") contradicts criterion 9 and the implementation approach (daemon and cli list
`@skelcrew/shared` as `workspace:*`, which the prototype pattern keeps under `dependencies`).
Implemented per 9; 10 holds for third-party dependencies.

## Review round 1

Finding (Important): `biome ci .` gated only by `vcs.useIgnoreFile` also checked
`.claude/settings.local.json` (written by Claude Code, ignored only by the owner's global
git ignore) and `.claude/worktrees/<name>/` (nested checkouts the tracked
`.claude/settings.json` configures), so `bun run check` on a clean tree could go red on
files `git status` never shows. Owner's call: `.gitignore` stays unchanged per the spec;
fix in `biome.json`.

Fix: `files.includes: ["**", "!!.claude/worktrees", "!.claude/settings.local.json"]`. `!!`
(Biome 2.1+) stops traversal of the worktrees directory entirely; `!` ignores the one file.
Biome 2.5.12 accepted the config with no diagnostic. Everything else Biome checked before
(root configs, `.claude/settings.json`, `packages/**`) is still checked: 16 files, as before.

Proof, in a scratchpad copy of the worktree (rsync minus `.git`/`node_modules`, fresh
`bun install`), with a `.claude/settings.local.json` in Claude Code's `JSON.stringify(..,
null, 2)` shape and a `.claude/worktrees/wt/packages/x/src/bad.ts` with one extra space:
- before the fix: `check` exit 1, naming both `.claude/settings.local.json format` and
  `.claude/worktrees/wt/packages/x/src/bad.ts format` (defect reproduced);
- after the fix, same planted files: `check` exit 0, `3 pass 0 fail`;
- after the fix, plus `packages/shared/src/bad.ts` with one extra space: `check` exit 1,
  naming `packages/shared/src/bad.ts format`;
- after the fix, `settings.local.json` alone (worktrees dir removed): `check` exit 0.

`bun run check` on the worktree itself: exit 0. Spec criterion 10 was reworded by the owner
(6b1ea38); the dependency layout is unchanged. TypeScript 7.0.2 stays.

## Review outcomes

- Round 1: CHANGES REQUESTED. One Important finding (Biome scope, above). Fixed in `biome.json`.
- Round 2 (fresh reviewer): APPROVED. Two Minor findings carried to the PR:
  1. The MILESTONES finding was appended to the list of spike findings; a lead-in or a
     sentence in the status prose would keep the framing accurate.
  2. The tracked `.claude/settings.json` is still format-checked; a `permissions.allow` array
     written by Claude Code in `JSON.stringify(.., null, 2)` shape fails `biome ci` until
     `bun run fix` runs. Owner's call whether to exclude it too.
