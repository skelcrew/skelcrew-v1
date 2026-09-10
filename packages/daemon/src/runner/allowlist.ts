/**
 * What the agent may do without asking. This is a security boundary, so the list is fixed
 * and named exactly: the tools a phase needs, plus the CLI, `git` and `gh` verbs the
 * playbooks run. Everything else reaches the run's `canUseTool` and becomes a question to
 * the owner (013) — with three exceptions that are the harness's own and cannot be closed from
 * here: it self-approves a set of read-only Bash commands, it allows outright any tool that
 * defines no permission check of its own, and it reads a wildcard entry as covering
 * `xargs <that command>` as well. So this list is not the complete set of what runs
 * unprompted. `entryMatches` below records every divergence in full, and which class each is.
 *
 * Six rules shape it, each from a defect this project shipped:
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
 * 2. **The CLI is allowed verb by verb.** `mv`, `claim`, `release`, `archive` and `resolve`
 *    are absent deliberately: they would let the agent move its own card past the runner's
 *    artefact check, or answer its own question. They ask.
 * 3. **`push` is allowed only in the exact form the playbook runs**, and its bare follow-up,
 *    so any other refspec — and any force push — asks.
 * 4. **The scan grants the command line it found, not its first word, and may not widen a
 *    command the fixed list narrows.** `bun run check` yields `Bash(bun run check *)`, never
 *    `Bash(bun *)` — which would match `bun -e '<any code>'`, and the same holds for `node -e`,
 *    `python -c`, `npm` and `make`. This entry is derived from a file the *target repository*
 *    controls, so the widest form of it is the widest thing a repository can grant itself.
 *    For the same reason a scanned line is a literal command and never a pattern: a fenced
 *    `bun *` would otherwise yield `Bash(bun * *)`, which the harness's own matcher expands
 *    back into `bun -e '<any code>'`. See `PATTERN_CHARS` and `allowlistFor` below.
 * 5. **No entry writes a ref the next run reads.** `git branch` is absent: branch refs live in
 *    `refs/heads/` and are *shared* by the main checkout and every linked worktree, so a run
 *    that can create, rename or repoint a branch changes the owner's repository rather than
 *    its own scratch copy — and can point the name its successor's base resolves from at a
 *    commit it wrote itself, instruction file included. No playbook runs `git branch`; a
 *    read-only use of it asks. `allowlistFor` closes the same hole from the other side.
 * 6. **The file tools are anchored to the run's own worktree.** Choosing a ref the list cannot
 *    write is not enough while a file tool is on the list bare: a ref is a plain file, and
 *    `git rev-parse --git-common-dir` — pre-allowed — names the directory holding it, so a run
 *    could commit an instruction file and then write the sha into
 *    `refs/remotes/origin/<default>` itself. The same unqualified write reaches `.git/config`,
 *    where one `remote.origin.push` line turns the pre-allowed bare `git push` into a push to
 *    the default branch. So `Edit`, `Write` and `MultiEdit` are off the list, and a run gets
 *    `editsIn(<its worktree>)` instead, with `deniedTools(<its worktree>)` denying the `.git`
 *    file that says which git directory the worktree belongs to. See those two below.
 *
 * What the list deliberately does not close, recorded rather than discovered:
 * `Bash(git commit *)` permits `--no-verify`, which skips the target repository's hooks (the
 * playbooks forbid it; a prefix pattern cannot); and `Bash(git push)` is only as narrow as the
 * config that governs it — under a repo-level `push.default = matching` it can push more than
 * the card's branch, and `remote.origin.push`, which outranks `push.default`, could turn it
 * into a push to the default branch. Both settings live in the git common directory, which
 * rule 6's anchor puts out of reach; if that anchoring is ever removed, this entry stops being
 * narrow. Nothing here sandboxes the agent: the list governs what runs **unprompted**, and
 * everything else remains available by asking. This is a gate, not a jail — anchoring the file
 * tools decides which writes ask, and denies only the one path whose whole purpose is to
 * redirect the others.
 */
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
  "Bash(git status *)",
  "Bash(git log *)",
  "Bash(git diff *)",
  "Bash(git show *)",
  "Bash(git merge-base *)",
  "Bash(git rev-parse *)",
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
 * redirections, but not to a subprocess that opens files itself; no entry on this list starts
 * one, and any command that would asks.
 */
export function deniedTools(worktreePath: string): string[] {
  return [`Edit(${anchor(worktreePath)}/.git)`, `Edit(${anchor(worktreePath)}/.git/**)`];
}

/** The path a file tool's call is about, absolute, or undefined when it names none. */
function filePath(input: Record<string, unknown>): string | undefined {
  const path = input.file_path ?? input.notebook_path ?? input.path;
  return typeof path === "string" ? resolve(path) : undefined;
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
 * Five ways the model and the harness diverge, none compensated for here. The first two are
 * this module's own reading of a rule; the other three are the harness allowing what this
 * module's list does not name, and are why the list is *not* the complete set of what runs
 * unprompted:
 *
 * - **The model is looser about compound commands.** The harness parses a command into its
 *   compound structure: a subshell or command group is asked about outright ("this command
 *   uses shell operators that require approval for safety"), and a list or pipeline is split
 *   into its parts, each matched against the rules on its own — allowed only if every part
 *   is. A whole compound command matches a rule only when the rule's content is that command
 *   exactly. So `git status && <anything>` is not covered by `Bash(git status *)` there,
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
 * - **The harness reads a wildcard rule as covering `xargs <that command>` too** — a divergence
 *   in what a *listed entry* matches. Having failed to match a wildcard allow rule against the
 *   command, it retries the pattern with `xargs ` in front whenever the pattern ends in an
 *   unescaped `*` — `LV("xargs " + pattern, command)` in the shipped binary, guarded by a
 *   predicate that is exactly "ends in an unescaped star" — so `Bash(git status *)` also allows
 *   `xargs git status -s` there and asks here. Checked entry by entry, it grants nothing
 *   further under this list: the alias still runs the command the entry names, with words
 *   appended from stdin, and the entry's own trailing `*` already allows any arguments. The
 *   two entries where an alias would matter — `Bash(git push -u origin HEAD)` and
 *   `Bash(git push)` — carry no wildcard at all, and an exact rule gets no such retry.
 * - **The harness self-approves read-only Bash commands the list never names** — a divergence
 *   in what a *listed tool's arguments* may be. Rather than asking about a command in its own
 *   fixed read-only set — `ls`, `cat`, `head`, `wc`, `grep`, `find` without `-exec` and the
 *   like — it allows it, so those never reach `canUseTool` any more than a listed command
 *   does.
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
function entryMatches(entry: string, tool: string, input: Record<string, unknown>): boolean {
  const parsed = ENTRY.exec(entry);
  if (parsed === null) return false;
  const [, name, content] = parsed;
  if (name === "Edit" && content !== undefined) {
    if (!EDITING_TOOLS.has(tool)) return false;
    const path = filePath(input);
    return path !== undefined && coversPath(content, path);
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
  if (denied.some((entry) => entryMatches(entry, tool, input))) return false;
  return list.some((entry) => entryMatches(entry, tool, input));
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

/** The first word of a scanned line, which is what the no-widening rule is read against. */
function firstWord(line: string): string {
  return line.split(/\s+/)[0] ?? "";
}

/**
 * The commands the fixed list narrows: the first word of every `Bash(…)` entry. A scanned
 * line whose first word is one of these contributes nothing, because the fixed list decides
 * what `git`, `gh` and `skelcrew` may do and a scanned line may only ever add to that — any
 * repository documenting a `git status` line triggers this, and one documenting
 * `git push --force` would otherwise grant exactly the form rule 3 withholds. Reading the
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
 * a literal command, never a pattern), a line whose first word is not a command word is
 * skipped, and a fence that is never closed contributes nothing — the direction that cannot
 * widen the boundary.
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
 * **And the commit is named by a ref no pre-allowed tool can write**: `scanBase`, the
 * remote-tracking head of `defaultBranch`. A local branch name would not do, however carefully
 * the fixed list is drawn — `refs/heads/` is shared by the main checkout and every linked
 * worktree, so a run able to create or move a branch could point the name its successor reads
 * at a commit it authored. Two things keep `refs/remotes/origin/<default>` out of reach, and
 * both are needed:
 *
 * - **No listed command writes it.** Only `git fetch`, `git pull`, `git remote` and `git push`
 *   write those refs, of which only `push` is listed, and only as `git push -u origin HEAD` and
 *   a bare `git push`. The first pushes the worktree's HEAD — the card branch
 *   `skelcrew/<id>-…`, named by the runner — and so writes that branch's remote-tracking ref
 *   and no other. The second, under a repo-level `push.default = matching`, pushes every local
 *   branch with a counterpart on the remote, the default branch included; but it pushes each at
 *   the value it already holds, and no pre-allowed command can change that value: a run's
 *   commits land on its own HEAD, and `git branch` is off the list precisely so nothing else
 *   can move a `refs/heads/` entry.
 * - **No listed *tool* writes it either.** A ref is a plain file. While a file tool sat on the
 *   list bare, a run could author a commit, name the git common directory with the pre-allowed
 *   `git rev-parse --git-common-dir`, and write that sha straight into the ref — and a loose
 *   ref wins over `packed-refs`, so the forgery would stand for every later run. `editsIn`
 *   anchors the file tools at the worktree, and the common directory is not under it.
 *
 * So only a commit the owner has pushed to the default branch can grant anything. A ref or a
 * file that cannot be read contributes nothing rather than failing the run — the fixed list is
 * the floor, and the agent asks.
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
