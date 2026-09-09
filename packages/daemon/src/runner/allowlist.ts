/**
 * What the agent may do without asking. A fixed list covers reading, editing, subagents,
 * the CLI verbs the playbooks use, git, and the PR; the target repo's `AGENTS.md` /
 * `CLAUDE.md` add their check commands — the first token of the first line of every fenced
 * shell block, which is how `bun run check` is pre-allowed for a repo whose instructions
 * show it that way. Anything the scan misses asks the owner once, through an attention
 * request.
 *
 * The CLI is allowed verb by verb, not as `skelcrew *`: `mv`, `release`, `claim`,
 * `archive`, and `resolve` would let the agent move its own card past the runner's
 * artefact check, so they ask — and the run treats them as a failure if they happen.
 *
 * `gh pr` is allowed verb by verb for the same reason, and a stronger one: a `Bash(x *)`
 * pattern matches every command that begins with `x`, so `Bash(gh pr *)` would pre-allow
 * `gh pr merge` and `gh pr close`. Merging is the owner's alone, and unlike a card move
 * the daemon can neither detect nor undo it — so the playbooks' verbs are named and
 * everything else asks.
 *
 * `git` is named verb by verb for the same reason again: `Bash(git *)` pre-allows
 * `git push origin HEAD:main` — landing the work on the default branch, the same
 * human-only transition — and, because the wildcard also stands in for options inserted
 * before the subcommand, `git -c core.pager=<anything> log`, which is arbitrary unprompted
 * execution (Claude Code's own rule validator says as much of `-c` and `--exec-path`). The
 * verbs the playbooks use are named; `push` is allowed only in the exact form `code.md`
 * prescribes and its bare follow-up, so any other refspec or a force push asks.
 */
import { existsSync, readFileSync } from "node:fs";
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

export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];

/**
 * Commands the fixed list narrows on purpose. A target repo whose instructions show `git
 * commit` or `skelcrew show` in a fenced block must not widen them back to `Bash(git *)`:
 * the scan is there for a repo's check commands, not for the verbs already decided here.
 */
const NARROWED = new Set(["skelcrew", "git", "gh"]);

/** Fence info strings that mean "a shell"; no info string counts too. */
const SHELL_TAGS = new Set(["", "sh", "bash", "shell", "zsh", "console", "shell-session"]);
const FENCE = /^\s*(`{3,}|~{3,})\s*(\S*)/;
const TOKEN = /^[\w./-]+$/;

/** The first token of the first line of every fenced shell block, in order, deduplicated. */
export function commandsInFences(markdown: string): string[] {
  const found: string[] = [];
  let fence: string | undefined;
  let first = true;
  for (const line of markdown.split("\n")) {
    if (fence === undefined) {
      const open = FENCE.exec(line);
      if (open === null) continue;
      const tag = (open[2] as string).toLowerCase();
      // A block in another language is skipped as a whole, including anything fence-like inside it.
      fence = open[1] as string;
      first = SHELL_TAGS.has(tag);
      continue;
    }
    if (line.trim().startsWith(fence)) {
      fence = undefined;
      continue;
    }
    if (!first) continue;
    first = false;
    const command = line.trim().replace(/^\$\s+/, "");
    const token = command.split(/\s+/)[0] ?? "";
    if (token.length > 0 && TOKEN.test(token) && !found.includes(token)) found.push(token);
  }
  return found;
}

/** The fixed list plus `Bash(<token> *)` for each command the repo's instructions show. */
export function allowlistFor(repoRoot: string): string[] {
  const entries = [...FIXED_ALLOWLIST];
  for (const name of INSTRUCTION_FILES) {
    const path = join(repoRoot, name);
    if (!existsSync(path)) continue;
    for (const token of commandsInFences(readFileSync(path, "utf8"))) {
      if (NARROWED.has(token)) continue;
      const entry = `Bash(${token} *)`;
      if (!entries.includes(entry)) entries.push(entry);
    }
  }
  return entries;
}
