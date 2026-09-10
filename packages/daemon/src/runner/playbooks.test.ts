import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("the Code playbook says what this run may not do without asking", () => {
  // The fixed list pre-allows nothing that writes, so a Code run hits denials until 013.
  expect(loadPlaybooks().code.toLowerCase()).toContain("denied");
});

test("an empty playbook is refused at load, naming the file", () => {
  writeFileSync(join(dir, "spec.md"), "   \n");
  writeFileSync(join(dir, "code.md"), "# code\n");
  expect(() => loadPlaybooks(dir)).toThrow(join(dir, "spec.md"));
});

// --- what the Code phase's contract requires of its playbook ---

test("the Code playbook records the pull request on every run, reading an existing one back", () => {
  const code = loadPlaybooks().code;
  // The contract checks that *this run* recorded it, so a revision on an existing PR still
  // has to record — which means reading the URL back off the branch.
  expect(code).toContain("gh pr view --json url");
  expect(code).toContain("skelcrew refs <id> --pr");
  expect(code).toContain("every run");
});

test("the Code playbook qualifies the base branch wherever it computes a diff", () => {
  // A bare name resolves by precedence, and a tag outranks a branch head.
  expect(loadPlaybooks().code).toContain("refs/heads/");
});

test("the Code playbook exports a spec file only where the repository already keeps specs", () => {
  const code = loadPlaybooks().code;
  expect(code).toContain("docs/specs");
  expect(code).toContain("skelcrew refs <id> --spec");
  // The card's body is the spec; a file in the repository is a copy pushed outward.
  expect(code).toContain("export");
  expect(code).toContain("pull request description");
});

test("the Code playbook reuses the recorded spec path on a card returning from PR", () => {
  const code = loadPlaybooks().code;
  expect(code).toContain("specPath");
  expect(code).toContain("overwrite");
});
