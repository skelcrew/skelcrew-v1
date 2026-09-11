/**
 * How a playbook's commands are read out of its text, in one place. Two readers ask this
 * question — `playbooks.test.ts`, which puts every command through `allowlist.ts`'s *model* of
 * the harness, and `harness-check.ts`, which puts them through the harness itself — and a
 * second harvester would let the two drift apart, which is the shape of the defect 017 exists
 * to catch. Nothing here runs in the daemon: it reads markdown, and both callers are checks.
 */

/** The verbs a playbook can put in front of an agent. An inline span starting with one is a
 * command; one starting with anything else — a ref name, a flag, a filename — is not. */
const COMMAND_WORDS = ["skelcrew", "git", "gh", "bun"];

/**
 * The lines inside a playbook's fenced blocks: what it sets out for the agent to run verbatim.
 * A heredoc body is in here too, and is prose rather than a command.
 */
export function prescribed(playbook: string): string[] {
  const lines: string[] = [];
  let inside = false;
  for (const line of playbook.split("\n")) {
    if (line.startsWith("```")) {
      inside = !inside;
      continue;
    }
    if (inside && line.trim().length > 0) lines.push(line);
  }
  return lines;
}

/**
 * Every command a playbook names, fenced or inline. A playbook puts commands in front of the
 * agent in running prose as often as in a block — `git push -u origin HEAD` is named inline as
 * "the form to use" — so a guard over fenced lines alone would miss half of them. An inline
 * span is only read as a command when it starts with a command word, which is what keeps the
 * ref names, flags and rule patterns that also sit in backticks out, and is why the counter-
 * example `--pr "$(gh pr view …)"` needs no exclusion: it starts with a flag.
 */
export function commandsNamed(playbook: string): string[] {
  const inline = [...playbook.matchAll(/`([^`\n]+)`/g)]
    .map((match) => match[1] as string)
    .filter((span) => COMMAND_WORDS.includes(span.split(/[\s(]/)[0] as string));
  return [...prescribed(playbook), ...inline];
}

/**
 * The paragraphs a playbook's *instructions* are not read from. Criterion 11 of 013 and the
 * whole of 017 are about the commands a playbook instructs, and these two paragraphs say
 * something else: the one advertising what needs no asking is pinned to `FIXED_ALLOWLIST`
 * entry for entry by `playbooks.test.ts`, so reading it as instruction would only prove the
 * list matches its own restatement; and the one recording what a subprocess reaches names the
 * five verbs the list withholds, which is the opposite of instructing them — the harness denies
 * all five, by design. The paragraph on the read-only git verbs stays in: it is checked against
 * the harness's own behaviour rather than against the list it came from.
 */
const NOT_INSTRUCTIONS = [
  "Pre-allowed, so they run unprompted:",
  "Those check commands are a subprocess",
];

/**
 * A prohibition, in the shape the playbook writes one: the bolded **Never …** run itself, and
 * nothing after it. `git commit --no-verify` sits inside such a run — the playbook exists to
 * rule it out, not to run it — so those spans come out before the commands are read.
 *
 * Excluded by its own shape rather than by dropping the paragraph it appears in, because the
 * prohibitions are one bullet list with an instruction among them: "never push another
 * refspec" and "`git push -u origin HEAD` is the form to use" share a bullet, so a
 * whole-paragraph exclusion silently dropped the one push form the playbook instructs. The
 * next instruction to share a paragraph with a prohibition would have gone the same way.
 */
const PROHIBITION = /\*\*Never [^*]*\*\*/g;

/** A command word followed by at least one argument: the shape an instruction takes. */
const INSTRUCTION = new RegExp(`^(?:${COMMAND_WORDS.join("|")}) \\S`);

/**
 * An excluded paragraph with its fence lines kept and everything else gone. Removing the
 * paragraph whole would hand `prescribed`'s fence counter a text with fence lines missing, and
 * one odd count inverts every later line's in-or-out state — so an instruction *below* an
 * excluded paragraph would silently stop being checked. Blanking keeps the count and drops the
 * content, which is the whole of what the exclusion is for.
 */
function emptied(paragraph: string): string {
  return paragraph
    .split("\n")
    .map((line) => (line.startsWith("```") ? line : ""))
    .join("\n");
}

/**
 * What the playbooks tell the agent to run, as the agent would run it — the list both the
 * model in `allowlist.ts` and the harness itself are checked against.
 *
 * It is `commandsNamed` over the paragraphs that instruct, and then two things that are the
 * difference between a string in a document and a command:
 *
 * - **Only a command word with an argument survives.** The rest of what `commandsNamed`
 *   harvests is not a command: a fenced heredoc's *body* (`# <NNN> — <title>`, `…`, `SPEC`),
 *   and the bare noun in "the `skelcrew` CLI, which is on your `PATH`". The harness denies
 *   every one of them, correctly — they are not commands it should run.
 * - **A placeholder is replaced with a word.** A playbook writes its arguments as
 *   `<id>`-style placeholders, and angle brackets are shell redirections: run verbatim,
 *   `skelcrew show <id>` is a redirection with no target, which the harness refuses outright,
 *   and `skelcrew show <id> --json` *writes a file called `--json`*. Neither is the command the
 *   agent would run. Substituting makes what is checked the command rather than the template.
 */
export function instructedCommands(playbook: string): string[] {
  const instructions = playbook
    .split("\n\n")
    .map((paragraph) =>
      NOT_INSTRUCTIONS.some((marker) => paragraph.includes(marker))
        ? emptied(paragraph)
        : paragraph.replaceAll(PROHIBITION, ""),
    )
    .join("\n\n");
  const commands: string[] = [];
  for (const named of commandsNamed(instructions)) {
    const command = named.trim().replaceAll(/<[^<>]*>/g, "PLACEHOLDER");
    if (INSTRUCTION.test(command)) commands.push(command);
  }
  return commands;
}
