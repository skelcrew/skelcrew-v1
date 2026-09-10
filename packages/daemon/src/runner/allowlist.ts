/**
 * What the agent may do without asking. This is a security boundary, so the list is fixed
 * and named exactly: the tools a phase needs, plus the CLI, `git` and `gh` verbs the
 * playbooks run. Everything else reaches the run's `canUseTool` and becomes a question to
 * the owner (013) — with two exceptions that are the harness's own and cannot be closed from
 * here: it self-approves a set of read-only Bash commands, and it allows outright any tool
 * that defines no permission check of its own. So this list is not the complete set of what
 * runs unprompted. `entryAllows` below records both divergences in full, and which class
 * each is.
 *
 * Four rules shape it, each from a defect the 007 spike shipped:
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
 * 4. **A scanned command may not widen a command the fixed list narrows.** See `scan` below.
 *
 * What the list deliberately does not close, recorded rather than discovered:
 * `Bash(git commit *)` permits `--no-verify`, which skips the target repository's hooks (the
 * playbooks forbid it; a prefix pattern cannot); `Bash(git branch *)` permits `git branch -D`
 * inside a disposable worktree; `Bash(git push)` under a repo-level `push.default = matching`
 * can push more than the card's branch; and `Write`, `Edit` and `MultiEdit` are pre-allowed
 * for any path the daemon's user can write, not only the worktree. Nothing here sandboxes the
 * agent: the list governs what runs **unprompted**, and everything else remains available by
 * asking. This is a gate, not a jail.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const FIXED_ALLOWLIST: readonly string[] = [
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "MultiEdit",
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
  "Bash(git branch *)",
  "Bash(git add *)",
  "Bash(git commit *)",
  "Bash(git push -u origin HEAD)",
  "Bash(git push)",
  "Bash(gh pr create *)",
  "Bash(gh pr view *)",
  "Bash(gh pr diff *)",
  "Bash(gh pr comment *)",
  "Bash(gh repo view*)",
];

/** `Tool` or `Tool(content)`; anything else is not an entry this module knows how to read. */
const ENTRY = /^([A-Za-z][\w-]*)(?:\((.*)\))?$/;

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
 *   prefix with no separator, so it also covers `<prefix>` run into a longer word.
 *   `Bash(gh repo view*)` is the one entry of this shape.
 * - Any other content is the exact command.
 * - Comparison is case-insensitive, as the harness's is.
 *
 * Three ways the model and the harness diverge, none compensated for here. The first is this
 * module erring wide; the other two are the harness allowing what this module's list does
 * not name, and are why the list is *not* the complete set of what runs unprompted:
 *
 * - **The model is looser about compound commands.** The harness parses a command into its
 *   compound structure and asks about anything using shell operators ("this command uses
 *   shell operators that require approval for safety"), so `git status && <anything>` is not
 *   covered by `Bash(git status *)` there, while a plain prefix comparison says it is. The
 *   model erring wide only makes the assertions above stricter about what the list may hold.
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
 * Constraining the last two needs deny rules or the harness's policy tier, and the policy
 * tier can be dropped on a machine with an IT-managed one — so `canUseTool` stays
 * authoritative and no assertion here claims the list is the complete set.
 */
function entryAllows(entry: string, tool: string, input: Record<string, unknown>): boolean {
  const parsed = ENTRY.exec(entry);
  if (parsed === null) return false;
  const [, name, content] = parsed;
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

/** Whether the list pre-allows this call, and so never asks the run about it. */
export function allowsTool(
  tool: string,
  input: Record<string, unknown>,
  list: readonly string[] = FIXED_ALLOWLIST,
): boolean {
  return list.some((entry) => entryAllows(entry, tool, input));
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
 * The commands the fixed list narrows: the first word of every `Bash(…)` entry. A scanned
 * command that is one of these contributes nothing, because `Bash(git *)` would undo the
 * narrowing above — and any repository documenting a `git status` line triggers it. Derived
 * from the list rather than written out, so a verb narrowed later is protected by the same
 * rule without anyone remembering to add it here.
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
 * The commands a repository's instruction file names for itself: the first token of the
 * first line of each fenced shell block, with a leading `$ ` stripped. A block in another
 * language is skipped whole, and a fence that is never closed contributes nothing — the
 * direction that cannot widen the boundary.
 */
export function scanInstructions(text: string): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
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
    const token = first
      .replace(/^\s*\$ /, "")
      .trim()
      .split(/\s+/)[0];
    if (token === undefined || !COMMAND_WORD.test(token)) continue;
    out.push(token);
  }
  return out;
}

/**
 * What a run in `repoRoot` may do without asking: the fixed list, plus `Bash(<command> *)`
 * for each command the repository's own `AGENTS.md`/`CLAUDE.md` shows in a fenced shell
 * block — so an agent following the repository's stated conventions is not stopped to ask
 * permission for its check commands. A repository with neither file gets the fixed list
 * exactly, and nothing scanned may widen a command the fixed list narrows.
 */
export function allowlistFor(repoRoot: string): string[] {
  const list = [...FIXED_ALLOWLIST];
  const narrowed = narrowedCommands();
  for (const name of INSTRUCTION_FILES) {
    let text: string;
    try {
      text = readFileSync(join(repoRoot, name), "utf8");
    } catch {
      continue;
    }
    for (const command of scanInstructions(text)) {
      if (narrowed.has(command)) continue;
      const entry = `Bash(${command} *)`;
      if (!list.includes(entry)) list.push(entry);
    }
  }
  return list;
}
