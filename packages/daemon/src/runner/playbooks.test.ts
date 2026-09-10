import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowsTool, FIXED_ALLOWLIST } from "./allowlist";
import { loadPlaybooks, PLAYBOOK_PHASES } from "./playbooks";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skr-pb-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("both shipped playbooks load and are not empty", () => {
  const playbooks = loadPlaybooks();
  for (const phase of PLAYBOOK_PHASES) {
    expect(playbooks[phase].trim().length).toBeGreaterThan(0);
  }
});

test("both playbooks send the agent to the target repository's own instructions first", () => {
  const playbooks = loadPlaybooks();
  for (const phase of PLAYBOOK_PHASES) {
    const text = playbooks[phase];
    expect(text).toContain("AGENTS.md");
    expect(text).toContain("CLAUDE.md");
    expect(text.toLowerCase()).toContain("first");
  }
});

test("both playbooks tell the agent to ask rather than guess, with skelcrew attention", () => {
  const playbooks = loadPlaybooks();
  for (const phase of PLAYBOOK_PHASES) {
    expect(playbooks[phase]).toContain("skelcrew attention");
    expect(playbooks[phase].toLowerCase()).toContain("guess");
  }
});

/**
 * Every `skelcrew`, `git` or `gh` command a playbook shows, in a fenced block or in an
 * inline code span. Not a shell parser: it is how the criterion "the playbook's own commands
 * run without asking" is checked command by command against the playbook's own text, so a
 * command added to a playbook later is checked the same way.
 */
function commandsIn(playbook: string): string[] {
  const spans = playbook.match(/`{1,3}[^`]+`{1,3}/g) ?? [];
  const out: string[] = [];
  for (const span of spans) {
    for (const line of span.replaceAll("`", "").split("\n")) {
      const command = line.trim();
      if (/^(skelcrew|git|gh) \S/.test(command)) out.push(command);
    }
  }
  return out;
}

test("every command the playbooks run is on the list, so none of them stops to ask", () => {
  const playbooks = loadPlaybooks();
  for (const phase of PLAYBOOK_PHASES) {
    const commands = commandsIn(playbooks[phase]);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect([phase, command, allowsTool("Bash", { command })]).toEqual([phase, command, true]);
    }
  }
});

/** The sentence in `code.md` that tells the agent what needs no asking. */
const PRE_ALLOWED = "Pre-allowed, so they run unprompted:";

/** Every inline code span of that sentence's paragraph: what the playbook advertises. */
function preAllowedIn(playbook: string): string[] {
  const at = playbook.indexOf(PRE_ALLOWED);
  expect(at).toBeGreaterThanOrEqual(0);
  const paragraph = playbook.slice(at).split("\n\n")[0] as string;
  return (paragraph.match(/`[^`]+`/g) ?? []).map((span) => span.replaceAll("`", ""));
}

/** An entry as a playbook names it: `Read`, `git status`, `git push -u origin HEAD`. */
function asAdvertised(entry: string): string {
  const bash = /^Bash\((.*)\)$/.exec(entry);
  return bash === null ? entry : (bash[1] as string).replace(/ \*$/, "");
}

/**
 * The playbook tells the agent what will not stop to ask, and an agent that believes a wrong
 * list either wastes the owner's time or plans around a stop that never comes. Asserted in
 * both directions against `FIXED_ALLOWLIST`: checking the list against the playbook's own
 * prose, as this file used to, only proves the list covers its own restatement — and passes
 * happily while the playbook advertises an entry that was removed.
 */
test("the Code playbook advertises exactly the fixed list, entry for entry", () => {
  const advertised = preAllowedIn(loadPlaybooks().code);
  expect(advertised.toSorted()).toEqual(FIXED_ALLOWLIST.map(asAdvertised).toSorted());
});

test("the Code playbook says what runs unprompted and what the owner is asked for", () => {
  const code = loadPlaybooks().code.toLowerCase();
  expect(code).toContain("asks the owner");
  expect(code).toContain("--no-verify");
  expect(code).toContain("git push -u origin head");
});

test("an empty playbook is refused at load, naming the file", () => {
  writeFileSync(join(dir, "spec.md"), "   \n");
  writeFileSync(join(dir, "code.md"), "# code\n");
  expect(() => loadPlaybooks(dir)).toThrow(join(dir, "spec.md"));
});
