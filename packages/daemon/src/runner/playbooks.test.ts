import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowsTool } from "./allowlist";
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
