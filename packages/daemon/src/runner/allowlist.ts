/**
 * What the agent may do without asking. This is a security boundary, so the list is fixed
 * and named exactly: the tools a phase needs, plus the CLI, `git` and `gh` verbs the
 * playbooks run. Everything else reaches the run's `canUseTool` and becomes a question to
 * the owner (013) — with three exceptions that are the harness's own and cannot be closed from
 * here: it self-approves a set of read-only Bash commands, it allows outright any tool that
 * defines no permission check of its own, and it reads a wildcard entry as covering
 * `xargs <that command>` as well. So this list is not the complete set of what runs
 * unprompted. `entryMatches` below records every divergence in full, and which class each is;
 * `selfApprovedReadOnlyGit` models the first of them for the git verbs this list stopped
 * naming, because that one is now load-bearing rather than merely recorded.
 *
 * **Everything below governs tool calls, and a subprocess is not a tool call.** Read *What a
 * subprocess reaches*, at the end of this comment, before reading any rule here as a boundary:
 * one entry on this list starts a process that can do anything the daemon's user can, and it is
 * there on purpose. Every rule that follows is worth having anyway — it decides what happens
 * *in the ordinary course*, visibly, on the card — and none of them is a wall.
 *
 * Eight rules shape it, each from a defect this project shipped or a review round that found
 * one:
 *
 * 1. **The wildcard goes after the subcommand, never before it.** `Bash(x *)` is wildcard
 *    matching — every command beginning with `x ` — so `Bash(git *)` would pre-allow `git
 *    push origin HEAD:main`, the owner's own gate, and `git -c <anything> log`, which is
 *    arbitrary execution. (Claude Code's own rule validator says as much: an allow rule with
 *    a wildcard before the rest of the command "also matches any options inserted at that
 *    position … For git, options such as -c and --exec-path can run arbitrary commands".)
 *    Each git verb is listed separately for that reason, and so is each `gh pr` verb:
 *    `Bash(gh pr *)` would pre-allow `gh pr merge` and `gh pr close`, and unlike a card move
 *    the daemon can neither detect nor undo a merge.
 * 2. **A trailing wildcard is not a boundary; it is the command's entire flag surface.**
 *    `Bash(x *)` grants every flag `x` has, present and future, the ones that write files and
 *    run other programs included. Four review rounds found four escalations and every one was
 *    this: `gh pr *` reaching `merge`, `git *` reaching `push` and `-c`, a bare `Write`
 *    reaching a ref file, and `git log *` reaching `--output`. So before an entry is written as
 *    `x *`, `x`'s flag set is enumerated and its write-capable and exec-capable flags named; if
 *    they cannot be excluded — and a prefix pattern cannot exclude a flag — the entry does not
 *    belong on the list in that form. The audit for each surviving entry is below.
 * 3. **The read-only git verbs are not listed at all, and that is the safer choice.**
 *    `git status`, `git log`, `git diff`, `git show`, `git merge-base` and `git rev-parse` were
 *    here as wildcards until `Bash(git log *)` proved an arbitrary-file-write primitive:
 *    `git log`, `git diff` and `git show` all take `--output=<any absolute path>`, so
 *    `git log -1 --format=%H --output=<common>/refs/remotes/origin/main` forges the very ref
 *    the scan reads, and the same flag rewrites `.git/config` so the pre-allowed bare
 *    `git push` lands on the default branch. Both were reproduced end to end against git
 *    2.48.1, and rule 2 says there was no narrower wildcard to write. What closes it is
 *    deleting the entries: the harness carries a per-subcommand safe-flag allowlist for exactly
 *    these six verbs and self-approves a call only when every flag is on it, and `--output` is
 *    on none of them — so an explicit `Bash(git log *)` rule *bypassed* that validator, having
 *    replaced a curated flag allowlist with "any flag at all". Unlisted, the safe forms still
 *    run unprompted and `--output` asks. Both halves were checked against the shipped binary:
 *    its allow-rule layer runs *before* its read-only self-approval, and its deny rules before
 *    both. See `SAFE_GIT_FLAGS`.
 * 4. **The CLI is allowed verb by verb.** `mv`, `claim`, `release`, `archive` and `resolve`
 *    are absent deliberately: they would let the agent move its own card past the runner's
 *    artefact check, or answer its own question. They ask.
 * 5. **`push` is allowed only in the exact form the playbook runs**, and its bare follow-up,
 *    so any other refspec — and any force push — asks.
 * 6. **The scan grants the command line it found, not its first word, and may not widen a
 *    command the fixed list narrows.** `bun run check` yields `Bash(bun run check *)`, never
 *    `Bash(bun *)` — which would match `bun -e '<any code>'`, and the same holds for `node -e`,
 *    `python -c`, `npm` and `make`. This entry is derived from a file the *target repository*
 *    controls, so the widest form of it is the widest thing a repository can grant itself.
 *    For the same reason a scanned line is a literal command and never a pattern: a fenced
 *    `bun *` would otherwise yield `Bash(bun * *)`, which the harness's own matcher expands
 *    back into `bun -e '<any code>'`. And it is one rule and never two: an entry has a syntax
 *    of its own, so a fenced `bun run) Bash(sh` would otherwise yield an entry the harness
 *    splits into `Bash(bun run)` **and** `Bash(sh *)`, which is arbitrary unprompted execution.
 *    See `PATTERN_CHARS`, `LINE_CHARS`, `splitEntries` and `allowlistFor` below.
 * 7. **No entry writes a ref the next run reads.** `git branch` is absent: branch refs live in
 *    `refs/heads/` and are *shared* by the main checkout and every linked worktree, so a run
 *    that can create, rename or repoint a branch changes the owner's repository rather than
 *    its own scratch copy — and can point the name its successor's base resolves from at a
 *    commit it wrote itself, instruction file included. No playbook runs `git branch`, and every
 *    form of it that writes a ref asks: `git branch -D`, `-m`, `-f` and `git branch <name>
 *    <base>` each fail the harness's read-only validator, checked against the extracted table.
 *    What does *not* ask is a read-only use — `git branch`, `--show-current`, `-a`, `-r`, `-v`,
 *    `--list` are on the harness's own read-only tier, which runs to twenty-four git verbs and
 *    not the six this list stopped naming. Absence from this list is not absence of the verb;
 *    it is only the security half that rule 7 is claiming. `allowlistFor` closes the same hole
 *    from the other side.
 * 8. **The file tools are anchored to the run's own worktree.** Choosing a ref the list cannot
 *    write is not enough while a file tool is on the list bare: a ref is a plain file, and
 *    `git rev-parse --git-common-dir` — unprompted — names the directory holding it, so a run
 *    could commit an instruction file and then write the sha into
 *    `refs/remotes/origin/<default>` itself. The same unqualified write reaches `.git/config`,
 *    where one `remote.origin.push` line turns the pre-allowed bare `git push` into a push to
 *    the default branch. So `Edit`, `Write` and `MultiEdit` are off the list, and a run gets
 *    `editsIn(<its worktree>)` instead, with `deniedTools(<its worktree>)` denying the `.git`
 *    file that says which git directory the worktree belongs to. See those two below.
 *
 * **The flag audit rule 2 requires, entry by entry**, against git 2.48.1 and gh 2.86.0. What
 * was looked for is the `--output` class: a flag whose *argument* names a file to write or a
 * program to run. None was found on any surviving entry.
 *
 * - `Bash(git add *)` — no flag writes a file it is given. `-e`, `-p` and `-i` open the diff in
 *   an editor and so run a program, but the program is `GIT_EDITOR`/`core.editor`, never named
 *   in the command; env and config are both out of reach (an env-prefixed command does not
 *   match the entry, `git config` is not listed, and the config file is outside the anchor).
 *   `--pathspec-from-file=<file>` reads a file — see the record below.
 * - `Bash(git commit *)` — same shape. `-e` and `-t <file>` reach the editor, `-S` reaches
 *   `gpg.program`; hooks run from `<common>/hooks` (checked: a linked worktree's
 *   `--git-path hooks` resolves into the *common* directory, outside the anchor) or
 *   `core.hooksPath`, which is config. `-F <file>` and `-t <file>` read a file. `--no-verify`
 *   is the recorded limitation below.
 * - `Bash(git push -u origin HEAD)` and `Bash(git push)` carry no wildcard at all.
 * - `Bash(gh pr create *)`, `Bash(gh pr view *)`, `Bash(gh pr diff *)`, `Bash(gh pr comment *)`,
 *   `Bash(gh repo view *)` — no flag writes a file. `--web` opens a browser and `-e/--editor`
 *   an editor, both named by `GH_BROWSER`/`GH_EDITOR` or gh's config, not by the command.
 *   `--jq` and `--template` are gojq and Go text/template over gh's own JSON: no file, no exec.
 *   `-F/--body-file`, `-T/--template <file>` and `--recover <file>` read a file. gh's config
 *   (`$GH_CONFIG_DIR`, else `~/.config/gh`) is outside the anchor, and its shell aliases cannot
 *   shadow a real command, so `gh pr …` cannot be redefined. `-R/--repo` is recorded below.
 * - `Bash(skelcrew show|comment|body|refs|attention *)` — this CLI. `body --file <path>` reads a
 *   file; nothing writes one or starts a program. `--as <member>` is recorded below.
 *
 * What the list deliberately does not close, recorded rather than discovered:
 *
 * - `Bash(git commit *)` permits `--no-verify`, which skips the target repository's hooks. The
 *   playbooks forbid it; a prefix pattern cannot.
 * - `Bash(git push)` is only as narrow as the config that governs it — under a repo-level
 *   `push.default = matching` it can push more than the card's branch, and `remote.origin.push`,
 *   which outranks `push.default`, could turn it into a push to the default branch. Both
 *   settings live in the git common directory, which rule 8's anchor puts out of reach; if that
 *   anchoring is ever removed, this entry stops being narrow.
 * - **Listed commands do read files the run names.** `git commit -F/-t`, `git add
 *   --pathspec-from-file`, `gh pr create -F/-T/--recover`, `gh pr comment -F` and
 *   `skelcrew body --file` all open a path the command chose, and the harness's Read rules do
 *   not reach a subprocess opening a file itself. So `git commit -F /etc/passwd` puts that file
 *   in a commit message unprompted. This spec's boundary is about writes; the read is recorded.
 * - **Flags that start a program named elsewhere.** `git add -e/-p/-i`, `git commit -e/-S` and
 *   every gh `--web`/`--editor` run an editor, browser or signing program. None takes the
 *   program from the command, and neither env nor config is reachable from this list, so no
 *   sequence here chooses what runs — but the flags are on the entries, so they are recorded.
 * - **`-R/--repo` on the gh entries** targets another repository: `gh pr create -R other/repo`
 *   opens a pull request outside the card's repo. Neither a write nor an exec, and the same
 *   class as the carried limitation that a run can write to another card.
 * - **`--as <member>` on the skelcrew entries** speaks as another member. `resolve` is off the
 *   list, so a run still cannot answer its own question; the same carried limitation.
 * - **The scanned entry starts a subprocess, and nothing above governs one.** See below; it is
 *   the largest of these by a wide margin, and the only one that makes the others moot.
 * - Nothing here sandboxes the agent: the list governs what runs **unprompted**, and everything
 *   else remains available by asking. This is a gate, not a jail — anchoring the file tools
 *   decides which writes ask, and denies only the one path whose whole purpose is to redirect
 *   the others.
 *
 * ## What a subprocess reaches
 *
 * Every rule above governs **tool calls**. A subprocess is not a tool call, and the playbooks
 * exist to start one: the repository's own check command, which rule 6's scan pre-allows
 * precisely so it need not ask. `bun run check` dispatches through `package.json` — a file
 * inside the anchor, so writable unprompted — and runs `bun test`, which executes any test file
 * the run wrote, every one of those also inside the anchor. Nothing in the permission layer sees
 * what that process then does.
 *
 * This is not a defect awaiting a patch. A coding agent's work is to write code and run it;
 * execution is the product, and a harness that could prevent it would be preventing the job.
 * What follows is that this list is a narrower thing than it reads as, and it says so rather
 * than claiming otherwise:
 *
 * - **The worktree anchor binds the file tools, not the machine.** A check subprocess writes
 *   anything the daemon's user can write, refs and `.git/config` included. Rule 8 makes those
 *   writes *ask when a tool makes them*; it does not make them impossible. The same goes for
 *   rule 7's ref and for `deniedTools`.
 * - **The verbs rule 4 withholds are obtained anyway.** The subprocess inherits `PATH` with the
 *   shim and `SKELCREW_AS=runner` (`agentEnvironment` in `./shim`), so `skelcrew mv`, `claim`,
 *   `release`, `archive` and `resolve` are all reachable — the run can move its own card past
 *   the artefact check and answer its own permission question. Withholding them from the list is
 *   worth doing (it keeps the agent from taking those actions *as itself*, visibly, in the
 *   ordinary course) and it is not a boundary.
 * - **Criteria 10b and 10c are true of tool calls and false of subprocesses**, which is how 013
 *   words them. `allowsTool` and `runsUnprompted` answer "does this tool call ask", and no
 *   assertion built on them says anything about what a process does once one has started.
 *
 * The rules that must survive this belong in the daemon, not in a list: the daemon knows which
 * member is asking and which run holds the claim, and can refuse a gate-crossing move on its own
 * authority whatever called it. That is **milestone 016**, and it is the reason this is recorded
 * here rather than papered over. Out of scope for it and for 013: OS-level sandboxing of the
 * subprocess, which is the only thing that would make the first bullet false.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Git } from "./git";

export const FIXED_ALLOWLIST: readonly string[] = [
  "Read",
  "Glob",
  "Grep",
  "Agent",
  "TodoWrite",
  "Bash(skelcrew show *)",
  "Bash(skelcrew comment *)",
  "Bash(skelcrew body *)",
  "Bash(skelcrew refs *)",
  "Bash(skelcrew attention *)",
  "Bash(git add *)",
  "Bash(git commit *)",
  "Bash(git push -u origin HEAD)",
  "Bash(git push)",
  "Bash(gh pr create *)",
  "Bash(gh pr view *)",
  "Bash(gh pr diff *)",
  "Bash(gh pr comment *)",
  "Bash(gh repo view *)",
];

/** `Tool` or `Tool(content)`; anything else is not an entry this module knows how to read. */
const ENTRY = /^([A-Za-z][\w-]*)(?:\((.*)\))?$/;

/**
 * How the CLI cuts what it is given into rules, transcribed from `td` in the shipped binary
 * (`TRANSCRIBED_FROM.cli`; this is `td([argument])`). It walks the argument character by
 * character into the rule it is building: `(` sets a flag, `)` clears it, and a comma or a
 * space seen while that flag is clear ends the rule and starts the next. The flag is a
 * boolean and not a depth counter, exactly as the binary has it — a second `(` does not nest,
 * and the first `)` clears it.
 *
 * **An entry is therefore not one rule by construction**, which is the whole reason this is
 * here. Anything this module builds as one `Bash(…)` entry is re-read by the harness through
 * this function, so a `)` inside the entry ends that rule early and the rest of the entry
 * opens further ones. `ENTRY` above cannot see the question at all: it reads
 * `Bash(bun run) Bash(git *)` as a single malformed entry whose content matches nothing, which
 * is silence exactly where the harness is widest. The invariant criterion 10g asserts — every
 * entry the scan produces parses as exactly one rule — is asserted against this, not `ENTRY`.
 *
 * One thing this shows that round 4 recorded the other way round: a worktree path containing a
 * `)` does **not** survive as one entry, so a checkout under `…/my (old) repo/…` would leave
 * `editsIn` and `deniedTools` both unreadable. Fail-closed — no allow rule covers the worktree,
 * so every write asks — and out of 013's scope, which is why it is recorded rather than fixed.
 */
export function splitEntries(argument: string): string[] {
  const rules: string[] = [];
  let rule = "";
  let inParens = false;
  for (const character of argument) {
    switch (character) {
      case "(":
        inParens = true;
        rule += character;
        break;
      case ")":
        inParens = false;
        rule += character;
        break;
      case ",":
        if (inParens) rule += character;
        else {
          if (rule.trim()) rules.push(rule.trim());
          rule = "";
        }
        break;
      case " ":
        if (inParens) rule += character;
        else if (rule.trim()) {
          rules.push(rule.trim());
          rule = "";
        }
        break;
      default:
        rule += character;
    }
  }
  if (rule.trim()) rules.push(rule.trim());
  return rules;
}

/**
 * The tools an `Edit(path)` rule governs. The harness checks file permissions against
 * `Edit(path)` and `Read(path)` rules **only**: a path rule spelled for `Write`, `MultiEdit`,
 * `NotebookEdit` or `Glob` is accepted, never consulted, and warned about at startup — it
 * would read as a constraint and enforce nothing. One `Edit(…)` rule covers every built-in
 * tool that edits a file, which is why `Write` and `MultiEdit` are off the list rather than
 * carrying path rules of their own.
 */
const EDITING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** A rule's path, anchored at the filesystem root: `//` and then the absolute path. */
function anchor(path: string): string {
  return `/${resolve(path)}`;
}

/**
 * The one file-tool entry a run gets: its own worktree and nothing else. A leading `//`
 * anchors a rule at the filesystem root, and as an *allow* rule a `dir/**` pattern matches
 * only at its anchor rather than at any depth — which is what is wanted here. The git common
 * directory is not under the worktree (a linked worktree's real git directory lives beside the
 * main checkout), so this one anchor puts every ref, `packed-refs` and every `config` out of
 * reach in a single stroke. Everything outside stays available by asking.
 */
export function editsIn(worktreePath: string): string {
  return `Edit(${anchor(worktreePath)}/**)`;
}

/**
 * What no file tool may touch however the allow list reads; deny outranks allow. In a linked
 * worktree `.git` is a *file* holding `gitdir: <common>/worktrees/<name>`, so it sits inside
 * the anchor above, and rewriting it repoints the worktree at a git directory of the agent's
 * choosing. Both forms are named because both are what the spec names; each already covers
 * the other under the harness's gitignore matching, which is belt and braces rather than a
 * mistake.
 *
 * Two limits belong on the record rather than in a claim. A deny rule spelled `Edit` covers
 * every tool that edits a file and `NotebookEdit` besides, but it does not block *reading* the
 * path — reading a ref was never the problem, writing one was. And the harness applies these
 * rules to the file commands it recognises inside Bash and to the targets of shell
 * redirections, but **not to a subprocess that opens files itself — and the scan puts exactly
 * such an entry on the list, deliberately.** The repository's own check command is pre-allowed
 * precisely so it need not ask; `bun run check` dispatches through `package.json` and runs the
 * repository's tests, which are files the run wrote inside this anchor and so wrote unprompted.
 * Nothing in the permission layer sees what that process then does, and this deny rule does not
 * reach it. See *What a subprocess reaches* in the module doc above: it is the boundary of
 * everything these two functions claim.
 */
export function deniedTools(worktreePath: string): string[] {
  return [`Edit(${anchor(worktreePath)}/.git)`, `Edit(${anchor(worktreePath)}/.git/**)`];
}

/**
 * Every path a file tool's call is about — the one it names, and where that lands once symlinks
 * are followed. `resolve` is *lexical*: it normalises `..` and absolutises, and never follows a
 * link, so a target repository carrying `docs/vendor -> /etc` would make
 * `<worktree>/docs/vendor/passwd` match the anchor on the text while the write landed in `/etc`.
 *
 * The harness does not decide it on the text. Its path-set builder adds every symlink hop and
 * the path's `realpathSync` to the set it checks, and its allow lookup allows only when *every*
 * path in that set matches a rule, while one deny match anywhere denies — so a link out of the
 * anchor asks. Both halves were run against the shipped binary with the rules `editsIn` and
 * `deniedTools` produce and a real link out of a real worktree.
 *
 * Two things this leaves narrower than the harness, neither of them a "runs unprompted" claim:
 * only the final `realpathSync` is added, where the harness also adds each intermediate hop; and
 * a path that does not exist yet cannot be resolved, so a new file is judged on its text alone —
 * which is what the harness does too, its canonicalisation being a `realpathSync` that throws on
 * a path with no file at the end of it.
 *
 * The consequence worth stating: under a worktree whose own path runs through a symlink, an
 * *existing* file inside it resolves to a path the rule does not spell, and asks. The rule is
 * written from the path the runner was given, so this is only reached when that path is itself
 * unresolved.
 */
function filePaths(input: Record<string, unknown>): string[] {
  const named = input.file_path ?? input.notebook_path ?? input.path;
  if (typeof named !== "string") return [];
  const lexical = resolve(named);
  try {
    const real = realpathSync(lexical);
    return real === lexical ? [lexical] : [lexical, real];
  } catch {
    return [lexical];
  }
}

/**
 * Whether an `Edit(//…)` rule's path covers `path`. Both shapes the entries above use — `//X`
 * and `//X/**` — cover `X` itself and everything under it, checked against the shipped
 * binary's own matcher as an allow rule and as a deny rule. No other shape is modelled: a
 * relative or `~`-rooted pattern, or a glob in the middle of a path, matches nothing here, so
 * the list assertions are what pin the entries to the shapes this does read.
 */
function coversPath(content: string, path: string): boolean {
  if (!content.startsWith("//")) return false;
  const at = content.slice(1).replace(/\/\*\*$/, "");
  return path === at || path.startsWith(`${at}/`);
}

/**
 * How the harness reads one entry, spelled out here so the list above can be asserted as
 * behaviour rather than as a string array. Read out of the shipped Claude Code binary the
 * SDK spawns and run against every entry and every negative before it was written down:
 *
 * - A bare `Tool` covers every call of that tool.
 * - `Bash(<prefix> *)` covers `<prefix>` itself and every command beginning with `<prefix> `
 *   — the harness compiles a rule ending in a single ` *` to `^<prefix>( .*)?$`, so the
 *   arguments are optional.
 * - `Bash(<prefix>*)`, with no space, is not that shape: it compiles to `^<prefix>.*$`, a
 *   prefix with no separator, so it also covers `<prefix>` run into a longer word —
 *   `Bash(gh repo view*)` would cover `gh repo viewer`. No entry has that shape; the case is
 *   modelled anyway, because reading such an entry as an exact command instead would make the
 *   model narrower than the harness, which is the direction a "this is not allowed" assertion
 *   cannot afford.
 * - Any other content is the exact command.
 * - Comparison is case-insensitive. The harness's is not — a divergence, recorded below.
 *
 * **A payload that will not parse is treated as not pre-allowed**, and goes to the owner. That
 * is the polarity of every `return false` below, and it is deliberate: the party choosing the
 * payload is the party being gated, so a boundary that fails open is not a boundary. A `Bash`
 * call whose `command` is not a string, a file tool's call naming no path, a redirection this
 * cannot read — each asks. The one payload that parses and names no file and is still allowed
 * is a call to a tool the list names bare (`Read`, `Grep`, `TodoWrite`), where there is no path
 * for it to have named.
 *
 * Six ways the model and the harness diverge, none compensated for here. The first three are
 * this module's own reading of a rule; the other three are the harness allowing what this
 * module's list does not name, and are why the list is *not* the complete set of what runs
 * unprompted:
 *
 * - **The model is looser about compound commands.** The harness parses a command into its
 *   compound structure: a subshell or command group is asked about outright ("this command
 *   uses shell operators that require approval for safety"), and a list or pipeline is split
 *   into its parts, each matched against the rules on its own — allowed only if every part
 *   is. A whole compound command matches a rule only when the rule's content is that command
 *   exactly. So `git add -A && <anything>` is not covered by `Bash(git add *)` there,
 *   while a plain prefix comparison says it is; and a scanned entry that happens to contain
 *   `&&` grants nothing its parts do not already grant. The model erring wide only makes the
 *   assertions above stricter about what the list may hold.
 * - **The model ignores case where the harness does not.** The harness's comparator for a
 *   wildcard rule passes its regex's case-insensitive flag as `false`, and an exact rule is
 *   compared to the command with `===`, unlowered; this module lowercases both sides, so it
 *   calls `GIT PUSH` allowed where the harness would ask. Wide again, and harmless for the
 *   same reason. (The same call normalizes runs of spaces and tabs on both sides, which this
 *   module does not: `git  log` with two spaces is allowed there and asks here. Narrow, and
 *   the one place a "this is allowed" assertion would be the imprecise one — there is no such
 *   assertion, and no entry or scanned line carries a double space.)
 * - **An allow decision here needs one entry to cover every path a call resolves to**, where the
 *   harness lets a different rule cover each of them (`PZe` looks each path up on its own and
 *   requires all of them to land somewhere). Narrow, and identical under this list, which has
 *   exactly one path entry. `filePaths` records the two places the path *set* is narrower.
 * - **The harness reads a wildcard rule as covering `xargs <that command>` too** — a divergence
 *   in what a *listed entry* matches. Having failed to match a wildcard allow rule against the
 *   command, it retries the pattern with `xargs ` in front whenever the pattern ends in an
 *   unescaped `*` — `LV("xargs " + pattern, command)` in the shipped binary, guarded by a
 *   predicate that is exactly "ends in an unescaped star" — so `Bash(git add *)` also allows
 *   `xargs git add` there and asks here. Checked entry by entry, it grants nothing
 *   further under this list: the alias still runs the command the entry names, with words
 *   appended from stdin, and the entry's own trailing `*` already allows any arguments. The
 *   two entries where an alias would matter — `Bash(git push -u origin HEAD)` and
 *   `Bash(git push)` — carry no wildcard at all, and an exact rule gets no such retry.
 * - **The harness self-approves read-only Bash commands the list never names** — a divergence
 *   in what a *listed tool's arguments* may be. Rather than asking about a command in its own
 *   fixed read-only set — `ls`, `cat`, `head`, `wc`, `grep`, `find` without `-exec` and the
 *   like — it allows it, so those never reach `canUseTool` any more than a listed command
 *   does. That set includes the six git verbs rule 3 took off this list, judged flag by flag
 *   against `SAFE_GIT_FLAGS`; `runsUnprompted` below is `allowsTool` plus that check, and it is
 *   what "runs without asking" means once rule 3 applies.
 * - **A tool that defines no permission check of its own is allowed outright** — a divergence
 *   in *which tools* run unprompted. The harness's tool builder falls back to a default
 *   descriptor whose check resolves `{behavior:"allow"}`, so such a tool never reaches
 *   `canUseTool` whatever the list says. `Write`, `Edit` and `Bash` all carry checks of their
 *   own, matched against the rules; bookkeeping and sub-agent tools do not.
 *
 * Constraining the last three needs deny rules or the harness's policy tier, and the policy
 * tier can be dropped on a machine with an IT-managed one — so `canUseTool` stays
 * authoritative and no assertion here claims the list is the complete set.
 */
function entryMatches(
  entry: string,
  tool: string,
  input: Record<string, unknown>,
  behavior: "allow" | "deny" = "allow",
): boolean {
  const parsed = ENTRY.exec(entry);
  if (parsed === null) return false;
  const [, name, content] = parsed;
  if (name === "Edit" && content !== undefined) {
    if (!EDITING_TOOLS.has(tool)) return false;
    const paths = filePaths(input);
    // Fail closed: a payload that names no file it can read is *not* pre-allowed. A boundary
    // that fails open is not a boundary, and the party choosing the payload is the party
    // being gated. The one call that is allowed on no path at all is a call to a tool the
    // list names bare, below — a payload that parses and names no file because the tool has
    // none to name.
    if (paths.length === 0) return false;
    // One deny match denies; an allow has to cover every path the call resolves to, the way
    // the harness's own lookup does.
    return behavior === "deny"
      ? paths.some((path) => coversPath(content, path))
      : paths.every((path) => coversPath(content, path));
  }
  if (name !== tool) return false;
  if (content === undefined) return true;
  if (tool !== "Bash") return false;
  if (typeof input.command !== "string") return false;
  const command = input.command.toLowerCase();
  const rule = content.toLowerCase();
  if (rule.endsWith(" *")) {
    const prefix = rule.slice(0, -2);
    return command === prefix || command.startsWith(`${prefix} `);
  }
  if (rule.endsWith("*")) return command.startsWith(rule.slice(0, -1));
  return command === rule;
}

/** What a command's redirections write, and what is left of the command once they are gone. */
interface Redirections {
  /** The command with its redirections stripped: what a rule is matched against. */
  command: string;
  /** Every file a redirection writes, `/dev/null` and file-descriptor duplicates aside. */
  targets: string[];
  /** False when a redirection is a shape this cannot read; such a call is not pre-allowed. */
  readable: boolean;
}

/**
 * A redirection target the harness refuses to reason about and asks about outright: a tilde or
 * variable expansion, a command substitution, a brace or glob, or a `..` segment that could
 * leave the anchor through a link. `iT` in the shipped binary names each of these as its own
 * refusal; here they collapse into "not pre-allowed", which is the same answer.
 */
const UNREADABLE_TARGET = /[$`~*?[\]{}]|(?:^|\/)\.\.(?:\/|$)/;

/**
 * A command's output redirections, read the way the harness reads them. `>` writes a file with
 * no file tool anywhere in the call, so a rule matched against the command text alone would
 * have said `git commit -m x > <common>/refs/remotes/origin/main` was pre-allowed — round 4's
 * `--output` finding reached through a shell operator instead of a flag.
 *
 * The harness splits the two apart: it matches a rule against the command *without* its
 * redirections (`jm` walks a `redirected_statement` skipping its `_redirect` children), and
 * checks each target against the `Edit` rules on its own (`jbo`), where a deny rule denies and a
 * target no allow rule covers becomes a question no allow rule can override. This models that;
 * `>>`, `&>`, `>|` and a leading file descriptor are the same redirection, `2>&1` and `>&-`
 * duplicate a descriptor rather than naming a file, and `>(…)` is process substitution, which
 * the harness asks about whatever it is redirected into.
 */
function redirectionsIn(command: string): Redirections {
  const targets: string[] = [];
  let kept = "";
  let quote: string | undefined;
  let i = 0;
  while (i < command.length) {
    const c = command[i] as string;
    if (quote !== undefined) {
      kept += c;
      if (c === quote) quote = undefined;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      kept += c;
      i += 1;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      kept += c + command[i + 1];
      i += 2;
      continue;
    }
    if (c !== ">") {
      kept += c;
      i += 1;
      continue;
    }
    // The descriptor or `&` that belongs to this redirection went into `kept` a moment ago.
    kept = kept.replace(/(?:&|\d+)$/, "");
    i += 1;
    if (command[i] === ">") i += 1;
    if (command[i] === "|") i += 1;
    if (command[i] === "(") return { command, targets, readable: false };
    let duplicate = false;
    if (command[i] === "&") {
      duplicate = true;
      i += 1;
    }
    while (command[i] === " " || command[i] === "\t") i += 1;
    const from = i;
    while (i < command.length && !" \t\n;|&".includes(command[i] as string)) i += 1;
    const word = command.slice(from, i).replace(/^(['"])(.*)\1$/, "$2");
    if (duplicate && /^(?:\d+|-)$/.test(word)) continue;
    if (word === "") return { command, targets, readable: false };
    if (UNREADABLE_TARGET.test(word)) return { command, targets, readable: false };
    if (word !== "/dev/null") targets.push(word);
  }
  if (targets.length === 0 && kept === command) return { command, targets, readable: true };
  return { command: kept.replace(/[ \t]+/g, " ").trim(), targets, readable: true };
}

/** Whether a redirection may write this path without asking: the `Edit` rules, on the target. */
function redirectionAllowed(
  target: string,
  list: readonly string[],
  denied: readonly string[],
): boolean {
  const input = { file_path: target };
  if (denied.some((entry) => entryMatches(entry, "Edit", input, "deny"))) return false;
  return list.some((entry) => entryMatches(entry, "Edit", input, "allow"));
}

/**
 * The call a rule is matched against once its redirections are accounted for, or undefined when
 * a redirection alone means the call is not pre-allowed. This is a whole-list question rather
 * than a per-entry one — a target is checked against every `Edit` rule, not against the entry
 * the command happens to match — which is why it sits here and not in `entryMatches`.
 */
function pastRedirections(
  tool: string,
  input: Record<string, unknown>,
  list: readonly string[],
  denied: readonly string[],
): Record<string, unknown> | undefined {
  if (tool !== "Bash" || typeof input.command !== "string") return input;
  const found = redirectionsIn(input.command);
  if (!found.readable) return undefined;
  if (!found.targets.every((target) => redirectionAllowed(target, list, denied))) return undefined;
  return found.command === input.command ? input : { ...input, command: found.command };
}

/**
 * Whether the list pre-allows this call, and so never asks the run about it. A `denied` entry
 * outranks every allow entry, the way the harness's deny rules do.
 */
export function allowsTool(
  tool: string,
  input: Record<string, unknown>,
  list: readonly string[] = FIXED_ALLOWLIST,
  denied: readonly string[] = [],
): boolean {
  if (denied.some((entry) => entryMatches(entry, tool, input, "deny"))) return false;
  const call = pastRedirections(tool, input, list, denied);
  if (call === undefined) return false;
  return list.some((entry) => entryMatches(entry, tool, call));
}

/**
 * What every enumeration in this module was taken from. Containment does not age — the anchor
 * holds whatever a flag table says — but enumeration does: `SAFE_GIT_FLAGS` transcribes a
 * private table out of a binary this repository does not control, and the flag audit rule 2
 * requires was performed against one git and one gh. The SDK is pinned exactly in `bun.lock`,
 * which is the real protection; naming the version here ties the transcription to that pin, so a
 * bump fails a test rather than moving the table underneath the list in silence.
 */
export const TRANSCRIBED_FROM = {
  /** The agent SDK this package depends on; `claude.test.ts` checks it against what is installed. */
  sdk: "0.3.266",
  /** The `claude` binary that SDK ships and spawns, whose tables are transcribed below. */
  cli: "2.1.266",
  /** The git the flag audit was run against. */
  git: "2.48.1",
  /** The gh the flag audit was run against. */
  gh: "2.86.0",
} as const;

/**
 * The harness's own safe-flag allowlist for the six read-only git verbs this list does not
 * name, read out of the shipped Claude Code binary the SDK spawns (`SZe`, the version
 * `TRANSCRIBED_FROM.cli` names) and transcribed whole. The harness self-approves a git command
 * as read-only only when its verb is a key here and every flag it carries is in that key's set;
 * `--output` is in none of them, which is what makes deleting the six entries close the hole
 * rather than merely move it.
 *
 * The table has more in it than these six: the harness's read-only tier runs to some two dozen
 * git verbs. Only the six the fixed list stopped naming are transcribed, because only those are
 * load-bearing here — see `selfApprovedReadOnlyGit`.
 */
const SAFE_GIT_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  (
    [
      [
        "status",
        `--ahead-behind --branch --column --find-renames --ignore-submodules --ignored --long
         --no-ahead-behind --no-column --no-renames --porcelain --renames --short
         --untracked-files --verbose -M -b -s -u -v`,
      ],
      [
        "log",
        `--abbrev-commit --after --all --ancestry-path --author --author-date-order --before
         --boundary --branches --cherry-mark --cherry-pick --color --committer --date
         --date-order --decorate --dense --diff-filter --first-parent --follow --format
         --full-history --graph --grep --left-right --max-age --max-count --merges --min-age
         --name-only --name-status --no-color --no-decorate --no-ext-diff --no-max-parents
         --no-merges --no-min-parents --no-patch --no-walk --numstat --oneline --patch
         --pickaxe-all --pickaxe-regex --pretty --relative-date --remotes --reverse --shortstat
         --simplify-merges --since --skip --source --sparse --stat --tags --topo-order --until
         --walk-reflogs -G -S -n -p -s`,
      ],
      [
        "diff",
        `--abbrev --binary --break-rewrites --cached --check --color --color-words
         --diff-algorithm --diff-filter --dirstat --exit-code --find-copies --find-copies-harder
         --find-renames --full-index --function-context --histogram --ignore-all-space
         --ignore-blank-lines --ignore-space-at-eol --ignore-space-change --inter-hunk-context
         --irreversible-delete --minimal --name-only --name-status --no-color --no-ext-diff
         --no-index --no-renames --numstat --patch-with-stat --patience --pickaxe-all
         --pickaxe-regex --quiet --relative --shortstat --staged --stat --summary --word-diff
         --word-diff-regex --ws-error-highlight -B -C -D -G -M -O -R -S -l -p -s -u`,
      ],
      [
        "show",
        `--abbrev-commit --color --color-words --date --decorate --diff-filter --first-parent
         --format --graph --name-only --name-status --no-color --no-decorate --no-ext-diff
         --no-patch --numstat --oneline --patch --pretty --quiet --raw --relative-date
         --shortstat --stat --word-diff --word-diff-regex -m -p -s`,
      ],
      ["merge-base", "--all --fork-point --independent --is-ancestor --octopus"],
      [
        "rev-parse",
        `--abbrev-ref --absolute-git-dir --git-common-dir --git-dir --is-bare-repository
         --is-inside-git-dir --is-inside-work-tree --is-shallow-repository --is-shallow-update
         --path-prefix --short --show-cdup --show-prefix --show-superproject-working-tree
         --show-toplevel --symbolic --symbolic-full-name --verify`,
      ],
    ] as const
  ).map(([verb, flags]) => [verb, new Set(flags.trim().split(/\s+/))]),
);

/** A word the harness reads as a flag rather than as an argument (`Om` in the binary). */
const FLAG_WORD = /^-[A-Za-z0-9_-]/;

/**
 * Whether the harness self-approves this command as read-only with no rule saying so — the
 * divergence `entryMatches` records, modelled for the six git verbs the fixed list stopped
 * naming, because criteria 10d and 10e are about exactly that boundary.
 *
 * It diverges from the harness in three known places, and none reaches an assertion.
 * **Narrower**: a command carrying a shell operator is refused outright rather than split into
 * parts and judged part by part, so `git status && ls` is self-approved there and not here — as
 * is `git status > <file>`, which the harness reads as a redirection and judges on its target.
 * **Wider**, twice, and both are `nBe`'s value rules, which are not modelled. Its rules on a
 * flag's own value — a `"none"` flag may not carry `=`, a value-taking flag must have a value
 * and it may not itself look like a flag — so `git show --format` and `git status --short=x`
 * are refused there and allowed here. And its rule on a *bundle* of one-letter flags: the
 * harness requires each bundled letter's value type to be `"none"`, where the check below tests
 * only membership, so `git status -sM` (`-M` takes a value) is refused there and allowed here.
 *
 * The wide direction is the one a "this asks" assertion cannot afford, which is why every such
 * assertion here names `--output`, a flag absent from the harness's tables altogether; and every
 * "runs unprompted" assertion was run against the extracted validator itself before it was
 * written down. That table holds twenty-four git verbs, `git branch` among them; only the six
 * the fixed list stopped naming are modelled here, so this function saying "no" means "this list
 * does not decide it", not "the harness asks".
 */
function selfApprovedReadOnlyGit(command: string): boolean {
  if (/[&|;<>()`$\n]/.test(command)) return false;
  const words = command.trim().split(/\s+/);
  if (words[0] !== "git") return false;
  const flags = SAFE_GIT_FLAGS.get(words[1] ?? "");
  if (flags === undefined) return false;
  for (const word of words.slice(2)) {
    if (word === "--") break;
    if (!FLAG_WORD.test(word)) continue;
    // `git log -5`: the harness lets a bare `-<number>` through for git whatever the verb.
    if (/^-\d+$/.test(word)) continue;
    const name = word.includes("=") ? (word.split("=")[0] as string) : word;
    if (flags.has(name)) continue;
    // A bundle of one-letter flags is read letter by letter, as the harness reads it.
    const bundled = !name.startsWith("--") && name.length > 2;
    if (bundled && [...name.slice(1)].every((letter) => flags.has(`-${letter}`))) continue;
    return false;
  }
  return true;
}

/**
 * Whether this call runs without reaching the run's `canUseTool` at all: the list, plus the
 * harness's own read-only self-approval for the git verbs the list deliberately does not name.
 */
export function runsUnprompted(
  tool: string,
  input: Record<string, unknown>,
  list: readonly string[] = FIXED_ALLOWLIST,
  denied: readonly string[] = [],
): boolean {
  if (denied.some((entry) => entryMatches(entry, tool, input, "deny"))) return false;
  const call = pastRedirections(tool, input, list, denied);
  if (call === undefined) return false;
  if (list.some((entry) => entryMatches(entry, tool, call))) return true;
  return tool === "Bash" && typeof input.command === "string"
    ? selfApprovedReadOnlyGit(input.command)
    : false;
}

/** The target repository's own instructions, in the order they are scanned. */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
/** A fenced block whose info string is one of these — or absent — is read as shell. */
const SHELL_INFO_STRINGS = new Set(["", "sh", "bash", "shell", "zsh", "console"]);
/** A fence opens a block; the info string may not contain a backtick. */
const FENCE_OPEN = /^ {0,3}(`{3,})[ \t]*([^`]*)$/;
/** A command word: anything else in the first position is not a command and is skipped. */
const COMMAND_WORD = /^[A-Za-z0-9._/-]+$/;
/**
 * A character that would make a scanned line a *pattern* rather than a command. Read out of
 * the shipped binary and run against it: the harness compiles `*` in a rule to `.*`, so
 * `Bash(bun * *)` matches `bun -e '<any code>'` and `Bash(make * *)` matches
 * `make -f /tmp/evil.mk all` — arbitrary unprompted execution granted by a file the target
 * repository controls. `?` and `[` are escaped rather than compiled there, and `\*` is
 * honoured as a literal star, but a line carrying any of them contributes nothing here all
 * the same: the spec names all three, and dropping the line is narrower than the harness in
 * the only direction this boundary can afford to be wrong.
 */
const PATTERN_CHARS = /[*?[]/;
/**
 * The whole of what a scanned line may be made of: words of letters, digits and
 * `. _ / @ + : = -`, one space between them. An allowlist and not a blocklist, because the
 * attack this closes was not the one anybody had written a blocklist for.
 *
 * `PATTERN_CHARS` above sanitises a line against the *pattern compiler*; this sanitises it
 * against the **entry syntax**, which is a separate language. An entry is not one rule by
 * construction — see `splitEntries` — so a line carrying `)` closes `Bash(` early and the rest
 * of the line opens a second rule whose closing `*)` `allowlistFor` supplies: a fenced
 * `bun run) Bash(git` becomes `Bash(bun run) Bash(git *)`, which the harness reads as
 * `Bash(bun run)` **and** `Bash(git *)`, and `bun run) Bash(sh` yields `Bash(sh *)` —
 * arbitrary unprompted execution granted by a file the target repository controls, with the
 * second command in a later word where `narrowedCommands()` never looks. Parentheses are the
 * pair that does it, the comma is the harness's other separator, and everything not needed to
 * write a check command is refused with them rather than reasoned about one character at a
 * time.
 */
const LINE_CHARS = /^[A-Za-z0-9._/@+:=-]+(?: [A-Za-z0-9._/@+:=-]+)*$/;

/** The first word of a scanned line, which is what the no-widening rule is read against. */
function firstWord(line: string): string {
  return line.split(/\s+/)[0] ?? "";
}

/**
 * The commands the fixed list narrows: the first word of every `Bash(…)` entry. A scanned
 * line whose first word is one of these contributes nothing, because the fixed list decides
 * what `git`, `gh` and `skelcrew` may do and a scanned line may only ever add to that — any
 * repository documenting a `git status` line triggers this, and one documenting
 * `git push --force` would otherwise grant exactly the form rule 5 withholds. Reading the
 * line's first word rather than the whole line is what keeps the rule working now that the
 * grant is of the line: `git status && rm -rf /` is dropped for its `git`, like every other
 * `git` line. Derived from the list rather than written out, so a verb narrowed later is
 * protected by the same rule without anyone remembering to add it here.
 */
function narrowedCommands(): Set<string> {
  const out = new Set<string>();
  for (const entry of FIXED_ALLOWLIST) {
    const parsed = ENTRY.exec(entry);
    if (parsed === null) continue;
    const [, name, content] = parsed;
    if (name !== "Bash" || content === undefined) continue;
    const first = content.trim().split(/\s+/)[0];
    if (first !== undefined && first.length > 0) out.add(first);
  }
  return out;
}

/**
 * The command lines a repository's instruction file names for itself: the first line of each
 * fenced shell block, whole, with a leading `$ ` stripped. Whole, because the grant is of the
 * line and not of its first word — `bun run check`, not `bun`. A block in another language is
 * skipped, a line carrying a pattern character is skipped (`PATTERN_CHARS`: a scanned line is
 * a literal command, never a pattern), a line carrying anything outside `LINE_CHARS` is
 * skipped (a scanned line is one rule, never two), a line whose first word is not a command
 * word is skipped, and a fence that is never closed contributes nothing — the direction that
 * cannot widen the boundary.
 */
export function scanInstructions(text: string): string[] {
  const out: string[] = [];
  // CRLF is a repository's business, not the scan's: a `\r` left on a fence line would close
  // no block, so every block would read as unterminated and the repository would grant
  // nothing — fail-closed, but silently, and for no reason the owner could see.
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  for (let i = 0; i < lines.length; i += 1) {
    const open = FENCE_OPEN.exec(lines[i] as string);
    if (open === null) continue;
    const [, fence, info] = open as unknown as [string, string, string];
    const closing = new RegExp(`^ {0,3}\`{${fence.length},}[ \\t]*$`);
    let end = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (closing.test(lines[j] as string)) {
        end = j;
        break;
      }
    }
    // Unterminated: not a block this can read, and nothing after it is a block either.
    if (end === -1) return out;
    const first = end === i + 1 ? undefined : lines[i + 1];
    i = end;
    if (first === undefined) continue;
    if (!SHELL_INFO_STRINGS.has(info.trim().split(/\s+/)[0]?.toLowerCase() ?? "")) continue;
    const line = first.replace(/^\s*\$ /, "").trim();
    if (PATTERN_CHARS.test(line)) continue;
    if (!LINE_CHARS.test(line)) continue;
    if (!COMMAND_WORD.test(firstWord(line))) continue;
    out.push(line);
  }
  return out;
}

/** Where the scan reads from: the remote-tracking head of the repository's default branch. */
function scanBase(defaultBranch: string): string {
  return `refs/remotes/origin/${defaultBranch}`;
}

/** What one run may do without asking, what it may not touch, and what the card is told. */
export interface RunAllowlist {
  /** The entries the run is spawned with: the fixed list, its worktree, and the scan's. */
  tools: string[];
  /** Deny rules, which outrank every entry in `tools`. */
  denied: string[];
  /**
   * What the scan did, as one clause for the run-start comment. A repository that documents
   * nothing and a repository whose base the scan could not read leave the same list, and the
   * owner cannot tell them apart from the card otherwise — while under the second the agent
   * asks for the repository's own check command on every run, with nothing saying why.
   */
  scanned: string;
}

/**
 * What a run in `repoRoot`, working in `worktreePath`, may do without asking: the fixed list,
 * plus one file-tool entry anchored at that worktree, plus `Bash(<line> *)` for each command
 * line the repository's own `AGENTS.md`/`CLAUDE.md` shows in a fenced shell block — so an
 * agent following the repository's stated conventions is not stopped to ask permission for its
 * check commands. A repository with neither file gets the fixed list and the anchor exactly,
 * and nothing scanned may widen a command the fixed list narrows.
 *
 * **The files are read from a commit, never from the working tree.** A run may write its own
 * worktree freely — that is the work — so it can put a fenced block into `AGENTS.md` there in
 * one unprompted call, visible on the card only inside a batched tool summary, and every later
 * run in that repository would then pre-allow the command line it chose. That is a run
 * widening its successor's boundary, so a file that is untracked, or modified relative to that
 * commit, contributes nothing.
 *
 * **And the commit is named by a ref nothing that runs unprompted can write**: `scanBase`, the
 * remote-tracking head of `defaultBranch`. A local branch name would not do, however carefully
 * the fixed list is drawn — `refs/heads/` is shared by the main checkout and every linked
 * worktree, so a run able to create or move a branch could point the name its successor reads
 * at a commit it authored. Two things keep `refs/remotes/origin/<default>` out of reach, and
 * both are needed:
 *
 * - **No unprompted command writes it.** Only `git fetch`, `git pull`, `git remote` and
 *   `git push` write those refs, of which only `push` is listed, and only as
 *   `git push -u origin HEAD` and a bare `git push`. The first pushes the worktree's HEAD — the
 *   card branch `skelcrew/<id>-…`, named by the runner — and so writes that branch's
 *   remote-tracking ref and no other. The second, under a repo-level `push.default = matching`,
 *   pushes every local branch with a counterpart on the remote, the default branch included;
 *   but it pushes each at the value it already holds, and nothing unprompted can change that
 *   value: a run's commits land on its own HEAD, and `git branch` is off the list precisely so
 *   nothing else can move a `refs/heads/` entry.
 * - **No unprompted *tool* writes it either.** A ref is a plain file. While a file tool sat on
 *   the list bare, a run could author a commit, name the git common directory with
 *   `git rev-parse --git-common-dir`, and write that sha straight into the ref — and a loose
 *   ref wins over `packed-refs`, so the forgery would stand for every later run. `editsIn`
 *   anchors the file tools at the worktree, and the common directory is not under it.
 * - **And no unprompted command writes it through a flag.** `git log`, `git diff` and
 *   `git show` take `--output=<any path>`, which walked around that anchor entirely while they
 *   were listed as wildcards; rule 3 deleted the entries, and the harness's own read-only check
 *   refuses the flag. That is the third leg, and all three are needed.
 *
 * So no *tool call* on this list can make the scan read a commit the owner has not pushed to the
 * default branch. Three legs hold that up and a subprocess steps over all three: the check
 * command this function itself pre-allows can write the ref directly, and *What a subprocess
 * reaches* above is where that is recorded. A ref or a file that cannot be read contributes
 * nothing rather than failing the run — the fixed list is the floor, and the agent asks.
 */
export async function allowlistFor(
  git: Pick<Git, "showFile" | "revParse">,
  repoRoot: string,
  defaultBranch: string,
  worktreePath: string,
): Promise<RunAllowlist> {
  const tools = [...FIXED_ALLOWLIST, editsIn(worktreePath)];
  const denied = deniedTools(worktreePath);
  const narrowed = narrowedCommands();
  const base = scanBase(defaultBranch);
  let reachable = false;
  try {
    reachable = (await git.revParse(repoRoot, base)) !== undefined;
  } catch {
    // A git that cannot run at all: the scan contributes nothing and the run goes on.
  }
  if (!reachable) {
    return { tools, denied, scanned: `no ${base}: the repository's own commands will ask` };
  }
  const lines: string[] = [];
  for (const name of INSTRUCTION_FILES) {
    let text: string | undefined;
    try {
      text = await git.showFile(repoRoot, base, name);
    } catch {
      continue;
    }
    if (text === undefined) continue;
    for (const line of scanInstructions(text)) {
      if (narrowed.has(firstWord(line))) continue;
      const entry = `Bash(${line} *)`;
      if (tools.includes(entry)) continue;
      tools.push(entry);
      lines.push(line);
    }
  }
  return {
    tools,
    denied,
    scanned:
      lines.length === 0
        ? "the repository's instructions name no commands: they will ask"
        : `pre-allowed from the repository's instructions: ${lines.join(", ")}`,
  };
}
