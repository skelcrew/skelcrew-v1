# 001 — Project scaffold

## Goal

Make `bun run check` real. Every later spec is verified against the definition of done in
`AGENTS.md` — lint, format check, typecheck, tests — and today none of it exists, so nothing
can be verified and the verifier can only report "not configured". This spec lays down the
Bun-workspaces monorepo the architecture calls for (`packages/daemon`, `packages/cli`,
`packages/shared`), wires the four checks into one green command, and proves the wiring with
the smallest possible code. No product behaviour; that starts at 002.

## Current behavior

There is no build, no package manifest, and no checks:

- The repository root holds `AGENTS.md` (with `CLAUDE.md` symlinked to it), `README.md`,
  `.gitignore`, `.claude/`, and `docs/`. No `package.json`, no `tsconfig`, no lockfile.
- `packages/` exists but contains only `packages/board/data/`, an untracked, gitignored
  SQLite file left behind by the prototype spike. There are no workspaces.
- A stale `node_modules/` from the prototype's npm install sits at the root (also
  gitignored). It contains `@kanbot/*` links and npm-era tooling; nothing references it.
- `AGENTS.md` under *Definition of done* names `bun run check` and then states: "Until the
  scaffold spec lands and `package.json` exists, these checks are **not configured**".
- `.claude/skills/develop/SKILL.md` and `.claude/agents/verifier.md` run "the checks the
  repository documents" and record each as PASS / FAIL / NOT CONFIGURED. Every run today
  ends in NOT CONFIGURED for all four.

The `prototype` branch is the only prior art. Its tooling is npm + `tsx` + per-package
`tsc --noEmit`, with root `tsconfig.base.json` targeting Node (`prototype:tsconfig.base.json`,
`prototype:package.json`, `prototype:packages/daemon/package.json`). It has no linter, no
formatter, and no tests. Its layout — root `tsconfig.base.json`, one `tsconfig.json` per
package extending it, packages named under one scope, `shared` exporting `./src/index.ts`
directly — is the pattern this spec keeps; the Node/npm/tsx parts are replaced by Bun.

## Desired behavior

After a fresh clone and `bun install`:

- `bun run check` exits 0 on a clean tree and does not modify any file. Its output shows all
  four checks ran: lint and format check across the repo, a typecheck for each of the three
  packages, and the test run with every test passing.
- `bun run check` exits non-zero when any one of the following is introduced anywhere under
  `packages/`: a lint violation, a formatting deviation, a type error, a failing test. The
  output names the offending file.
- Three workspace packages exist: `@skelcrew/shared`, `@skelcrew/daemon`, `@skelcrew/cli`.
  `daemon` and `cli` each depend on `shared`; `shared` depends on nothing.
- `bun packages/daemon/src/main.ts` prints one line identifying the daemon and its version and
  exits 0. `bun packages/cli/src/main.ts` does the same for the CLI. The version string both
  print comes from `@skelcrew/shared`, so a change there changes both outputs. These are the
  only executable entry points and they do nothing else.
- `bun test` runs from the root and discovers tests in every package without per-package
  configuration.
- `bun.lock` is committed. A second `bun install` on a clean checkout changes nothing.
- No package declares a runtime dependency. Development dependencies are TypeScript, Bun's
  type declarations, and the lint/format tool, all at the root.
- `AGENTS.md`'s *Definition of done* no longer says the checks are unconfigured; it describes
  what `bun run check` actually runs.

## Implementation approach

### Layout

```
package.json            root: workspaces, scripts, devDependencies
bun.lock
tsconfig.base.json      shared compiler options
biome.json              lint + format config, single root config
packages/shared/        package.json, tsconfig.json, src/index.ts, src/index.test.ts
packages/daemon/        package.json, tsconfig.json, src/main.ts, src/main.test.ts
packages/cli/           package.json, tsconfig.json, src/main.ts, src/main.test.ts
```

Package names are `@skelcrew/shared`, `@skelcrew/daemon`, `@skelcrew/cli` (the prototype's
`@kanbot/*` pattern, renamed). All are `private`, `"type": "module"`, version `0.0.1`.
`shared` exposes `./src/index.ts` through `exports` with no build step, as the prototype does;
`daemon` and `cli` depend on it as `"@skelcrew/shared": "workspace:*"`. Test files are
colocated with source as `*.test.ts`, which is Bun's default discovery pattern.

### Decisions resolved from repository context

- **Bun replaces every Node-era tool.** `AGENTS.md` fixes the stack as TypeScript on Bun with
  Bun workspaces. Runtime is `bun` (no `tsx`), tests are `bun test`, installs are
  `bun install` with `bun.lock`. `@types/bun` replaces `@types/node`, and `tsconfig.base.json`
  uses Bun's own recommended options (`bun init`'s template: `module: Preserve`,
  `moduleResolution: bundler`, `types: ["bun"]`, `verbatimModuleSyntax`, `noEmit`,
  `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`) rather than the prototype's
  `NodeNext`. Verified on Bun 1.3.14: `workspace:*` imports resolve at runtime and under
  `tsc` with this configuration.
- **Biome for lint and format.** `AGENTS.md` requires both; Bun 1.3.14 ships neither (there
  is no `bun fmt` or `bun lint`). Biome is one dev dependency and one config file covering
  both, versus two tools and a plugin set for ESLint + Prettier; with agents writing most of
  the code, fewer moving parts is the reviewability argument `AGENTS.md` makes for the stack.
  Configuration: one root `biome.json` with the recommended rule set, formatter enabled,
  `vcs.useIgnoreFile` on so `node_modules` and gitignored paths are skipped, and
  `organizeImports` on. Formatter style (indent, quotes, line width) is the implementer's call
  and must simply be consistent across all three packages.
- **Typecheck is per package via `bun run --filter`.** Each package has a `typecheck` script
  running `tsc --noEmit -p .`; the root runs `bun run --filter '*' typecheck`. Verified: a
  type error in one package makes the filtered run exit 1 and print the file and diagnostic.
  This keeps each package's `tsconfig.json` self-contained (the prototype's pattern) and
  avoids project references.
- **`check` is sequential and composed of named scripts.** The root `check` script runs, in
  order, `biome ci .` (lint and format check in one pass, exits non-zero on either), the
  typecheck above, and `bun test`. Each is also its own root script (`lint`, `typecheck`,
  `test`) so the verifier can run and report them individually, and a `fix` script applies
  Biome's writes. `check` must never write files.
- **The scaffold ships three tests, not zero.** `docs/MILESTONES.md` asks for `check` to be
  "green (with zero tests)". Verified: `bun test` on Bun 1.3.14 exits 1 when it finds no test
  files, so a zero-test scaffold cannot be green. The milestone's other clause — "no product
  code beyond what proves the wiring" — decides it: each package gets exactly one test that
  proves the wiring (see *Tests*). Record this in `docs/MILESTONES.md`'s status paragraph as a
  finding: a green check requires at least one test, and the scaffold's are wiring tests.
- **Entry points prove runtime resolution, nothing more.** `shared` exports one constant, the
  version string. `daemon/src/main.ts` and `cli/src/main.ts` import it and print
  `skelcrew daemon <version>` / `skelcrew <version>`. Root scripts `daemon` and `skelcrew` run
  them. No argument parsing, no socket, no state — all of that is 002 onward.
- **No `bin`, no bundling, no `dist`.** Everything runs from source under Bun. Publishing and
  install-as-command are not this milestone's problem.

### Files touched outside `packages/`

- `AGENTS.md`: replace the "not configured" sentence in *Definition of done* with what
  `check` runs. Leave every other line alone.
- `docs/MILESTONES.md`: add the zero-tests finding to the status paragraph. Do not rewrite
  the 001 entry.
- `.gitignore`: unchanged. The stale `packages/board/data/` and `.kanbot/` entries are
  harmless and cleaning them is out of scope.

## Acceptance criteria

1. On a fresh clone, `bun install` succeeds, and `git status` afterwards shows no change to
   `bun.lock` or any tracked file.
2. `bun run check` exits 0 on the clean tree, and `git status` afterwards is clean.
3. The output of `bun run check` shows lint and format checks ran, a typecheck for each of
   `@skelcrew/shared`, `@skelcrew/daemon`, and `@skelcrew/cli`, and a test run with at least
   three passing tests across three files and zero failures.
4. Adding a `debugger;` statement to any file under `packages/*/src/` makes `bun run check`
   exit non-zero with output naming that file. Removing it restores exit 0.
5. Reformatting one line in any file under `packages/*/src/` so it no longer matches the
   formatter's output (for example, collapsing a multi-line statement or adding extra spaces)
   makes `bun run check` exit non-zero with output naming that file. `bun run fix` restores
   the file and exit 0.
6. Assigning a string to a variable typed `number` in `packages/cli/src/main.ts` makes
   `bun run check` exit non-zero with a `tsc` diagnostic naming that file and line. The same
   holds in `packages/daemon/src/main.ts` and `packages/shared/src/index.ts`.
7. Changing any one of the three wiring tests to assert a wrong value makes `bun run check`
   exit non-zero and the test runner report one failure naming the test.
8. `bun packages/daemon/src/main.ts` prints exactly one line to stdout containing
   `skelcrew daemon` followed by the version string exported from `@skelcrew/shared`, and
   exits 0. `bun packages/cli/src/main.ts` prints one line containing `skelcrew` followed by
   the same version string, and exits 0. Root scripts `bun run daemon` and `bun run skelcrew`
   produce the same output.
9. The root `package.json` declares `workspaces: ["packages/*"]`, and exactly three
   directories under `packages/` contain a `package.json`, named `@skelcrew/shared`,
   `@skelcrew/daemon`, and `@skelcrew/cli`. `@skelcrew/daemon` and `@skelcrew/cli` each list
   `@skelcrew/shared` as `workspace:*`; `@skelcrew/shared` lists no dependencies.
10. No `package.json` in the repository has a `dependencies` field with entries. The root's
    `devDependencies` contains `typescript`, `@types/bun`, and `@biomejs/biome`, and nothing
    else.
11. `bun.lock` is tracked in git. `node_modules/` is not.
12. `AGENTS.md`'s *Definition of done* section no longer contains the words "not configured"
    and states that `bun run check` runs Biome's lint and format check, `tsc` per package,
    and `bun test`. No other section of `AGENTS.md` differs from the base branch.
13. `docs/MILESTONES.md`'s status paragraph records that `bun test` exits non-zero with zero
    test files and that the scaffold therefore ships one wiring test per package.
14. `bun run check` and `bun test` run from the repository root with no `bunfig.toml` and no
    per-package test configuration.

## Tests

Exactly three tests, one per package, each proving one edge of the wiring under `bun test`
from the root:

- `shared`: the exported version string is a non-empty string matching the root
  `package.json` version.
- `daemon`: importing from `@skelcrew/shared` (the package name, not a relative path) yields
  that same version string.
- `cli`: the same, from the `cli` package.

These are the tests behind criteria 3 and 7. Criteria 4, 5, and 6 are verified by hand
(introduce the defect, run `check`, revert); they are not to be encoded as tests, since a test
that mutates source files would be worse than the manual check.

Red for this spec is `bun run check` failing before the root `package.json` exists. Green is
criterion 2.

No existing tests cover any of this; the repository has none.

## Out of scope

- Any domain code: cards, phases, members, activity, claims, SQLite — all 002.
- Any protocol surface: JSON-RPC socket (003), MCP server (005), CLI commands and arguments
  (004). The `cli` and `daemon` entry points print one line and exit; nothing more.
- A GitHub Actions (or any CI) workflow running `bun run check` on pull requests. The
  verifier runs the check locally before a PR opens; CI is a separate, later decision.
- Pinning the Bun version (`packageManager`, `.bun-version`, `engines`). Bun 1.3.14 is what
  the checks were verified on; recording that is `docs/plans/`' job for this run.
- Building, bundling, `bin` entries, `bun link`, or any way to install `skelcrew` as a
  command. Everything runs from source with `bun`.
- Cleaning `.gitignore` of the prototype's `packages/board/data/` and `.kanbot/` entries, and
  deleting the untracked `packages/board/` and stale root `node_modules/` on the owner's
  machine. `bun install` replaces `node_modules/` on its own; the rest is the owner's.
- Editor integration (`.editorconfig`, VS Code settings, Biome extension recommendations).
- Coverage thresholds, test reporters, or `bunfig.toml` of any kind.
- Choosing formatter style beyond "one style, applied everywhere". The implementer picks.
