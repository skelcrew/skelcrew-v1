/**
 * What the agent may do without asking. This is a security boundary, so the list is fixed
 * and named exactly: read-only tools, plus the CLI verbs the playbooks use for their own
 * bookkeeping. Everything else reaches the run's `canUseTool` and is denied there — with two
 * exceptions that are the harness's own and cannot be closed from here: it self-approves a
 * set of read-only Bash commands, and it allows outright any tool that defines no permission
 * check of its own. So this list is not the complete set of what runs unprompted.
 * `entryAllows` below records both divergences in full, and which class each is.
 *
 * Three rules shape it, each from a defect the 007 spike shipped:
 *
 * 1. **The wildcard goes after the subcommand, never before it.** `Bash(x *)` is wildcard
 *    matching — every command beginning with `x ` — so `Bash(git *)` would pre-allow `git
 *    push origin HEAD:main`, the owner's own gate, and `git -c <anything> log`, which is
 *    arbitrary execution. (Claude Code's own rule validator says as much: an allow rule with
 *    a wildcard before the rest of the command "also matches any options inserted at that
 *    position … For git, options such as -c and --exec-path can run arbitrary commands".)
 *    Each git verb is listed separately for that reason.
 * 2. **The CLI is allowed verb by verb.** `mv`, `claim`, `release`, `archive` and `resolve`
 *    are absent deliberately: they would let the agent move its own card past a gate. `body`
 *    is present because writing the spec onto the card is the Spec phase's whole output.
 * 3. **No write, network or history-editing tool is pre-allowed at all.** `Write`, `Edit`,
 *    `Bash(git commit …)`, `Bash(git push …)` and `gh` wait for 013, together with asking.
 *
 * The consequence is deliberate: a Spec-phase run works end to end under this list, and a
 * Code-phase run hits denials until 013 gives the agent a way to ask.
 */

export const FIXED_ALLOWLIST: readonly string[] = [
  "Read",
  "Glob",
  "Grep",
  "Bash(skelcrew show *)",
  "Bash(skelcrew comment *)",
  "Bash(skelcrew body *)",
  "Bash(skelcrew attention *)",
  "Bash(git log *)",
  "Bash(git status *)",
  "Bash(git diff *)",
  "Bash(git show *)",
];

/** `Tool` or `Tool(content)`; anything else is not an entry this module knows how to read. */
const ENTRY = /^([A-Za-z][\w-]*)(?:\((.*)\))?$/;

/**
 * How the harness reads one entry, spelled out here so the list above can be asserted as
 * behaviour rather than as a string array: a bare `Tool` covers every call of that tool; a
 * `Bash(<prefix> *)` entry covers `<prefix>` itself and every command beginning with
 * `<prefix> ` — the harness compiles a rule ending in a single ` *` to `^<prefix>( .*)?$`,
 * so the arguments are optional; any other content is the exact command. The harness
 * enforces the list — it never asks about a call the list covers — and this is the model of
 * that enforcement the boundary is reviewed against.
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
 *   `canUseTool` whatever the list says. The write path is not among them (`Write`, `Edit`
 *   and `Bash` all carry checks of their own, matched against the rules); bookkeeping and
 *   sub-agent tools are.
 *
 * Both of the last two are divergences rather than holes this spec opens (`Read` is itself
 * pre-allowed, so the agent can already read any file the owner can), and constraining them
 * belongs to 013, alongside asking, where deny rules and the harness's policy tier are
 * available. What matters here is that no assertion claims the list is the complete set.
 */
function entryAllows(entry: string, tool: string, input: Record<string, unknown>): boolean {
  const parsed = ENTRY.exec(entry);
  if (parsed === null) return false;
  const [, name, content] = parsed;
  if (name !== tool) return false;
  if (content === undefined) return true;
  if (tool !== "Bash") return false;
  const command = input.command;
  if (typeof command !== "string") return false;
  if (content.endsWith(" *")) {
    const prefix = content.slice(0, -2);
    return command === prefix || command.startsWith(`${prefix} `);
  }
  return command === content;
}

/** Whether the fixed list pre-allows this call, and so never asks the run about it. */
export function allowsTool(tool: string, input: Record<string, unknown>): boolean {
  return FIXED_ALLOWLIST.some((entry) => entryAllows(entry, tool, input));
}
