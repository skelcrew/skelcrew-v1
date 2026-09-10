import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXED_ALLOWLIST, runsUnprompted } from "./allowlist";
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
 * The paragraphs a playbook's commands are not read from. Criterion 11 is about the commands a
 * playbook *instructs*, and these three say something else: the paragraph advertising what needs
 * no asking is pinned to `FIXED_ALLOWLIST` entry for entry below, so reading it here would only
 * prove the list matches its own restatement; the paragraph forbidding commands names
 * `git commit --no-verify`, which the playbook exists to rule out, not to run; and the paragraph
 * recording what a subprocess reaches names the five verbs the list withholds, which is the
 * opposite of instructing them. The paragraph on the read-only git verbs stays in: it is checked
 * against the harness's own behaviour rather than against the list it came from, so there is
 * nothing circular about it.
 */
const NOT_INSTRUCTIONS = [
  "Pre-allowed, so they run unprompted:",
  "Those check commands are a subprocess",
  "**Never ",
];

/**
 * Every `skelcrew`, `git` or `gh` command a playbook shows, in a fenced block or in an
 * inline code span. Not a shell parser: it is how the criterion "the playbook's own commands
 * run without asking" is checked command by command against the playbook's own text, so a
 * command added to a playbook later is checked the same way.
 *
 * A playbook writes its arguments as `<id>`-style placeholders, which are not commands — the
 * angle brackets are shell redirections. Each is replaced with a word, so what the criterion is
 * checked against is the command the agent would run rather than the template it reads.
 */
function commandsIn(playbook: string): string[] {
  const out: string[] = [];
  for (const paragraph of playbook.split("\n\n")) {
    if (NOT_INSTRUCTIONS.some((marker) => paragraph.includes(marker))) continue;
    for (const span of paragraph.match(/`{1,3}[^`]+`{1,3}/g) ?? []) {
      for (const line of span.replaceAll("`", "").split("\n")) {
        const command = line.trim().replaceAll(/<[^<>]*>/g, "PLACEHOLDER");
        if (/^(skelcrew|git|gh) \S/.test(command)) out.push(command);
      }
    }
  }
  return out;
}

/**
 * Criterion 11, and it asks about *asking*, not about the list: a playbook's `git log` runs
 * unprompted through the harness's own read-only check rather than through an entry, since the
 * six read-only git verbs came off the list once `--output` proved a trailing wildcard could
 * not exclude a write-capable flag. `runsUnprompted` is the list plus that check.
 */
test("every command the playbooks run goes unprompted, so none of them stops to ask", () => {
  const playbooks = loadPlaybooks();
  for (const phase of PLAYBOOK_PHASES) {
    const commands = commandsIn(playbooks[phase]);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect([phase, command, runsUnprompted("Bash", { command })]).toEqual([phase, command, true]);
    }
  }
});

/**
 * What the criterion is checked against has to be the commands the playbook *instructs*. Two
 * paragraphs are not that: the one advertising what needs no asking is pinned to
 * `FIXED_ALLOWLIST` by the test below, so checking it here proves the list matches itself; and
 * the one listing what the agent must never do put `git commit --no-verify` — which the playbook
 * **forbids** — among the commands asserted to run without asking.
 */
test("the criterion-11 check reads the playbook's instructions, not its advertisement", () => {
  const commands = commandsIn(loadPlaybooks().code);
  expect(commands).not.toContain("git commit --no-verify");
  expect(commands).toContain("skelcrew show PLACEHOLDER");
  expect(commands).toContain("git status");
  expect(commands).toContain('skelcrew comment PLACEHOLDER "PLACEHOLDER"');
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

/**
 * The six read-only git verbs are not advertised entries and still do not ask, so the playbook
 * has to say both — an agent told only "not on the list" plans around a stop that never comes,
 * and one told nothing may reach for `--output` and be stopped without knowing why.
 */
test("the Code playbook says the read-only git verbs go through the harness's own check", () => {
  const code = loadPlaybooks().code;
  const at = code.indexOf("Reading the repository with git");
  expect(at).toBeGreaterThanOrEqual(0);
  const paragraph = code.slice(at).split("\n\n")[0] as string;
  for (const verb of ["status", "log", "diff", "show", "merge-base", "rev-parse"]) {
    expect(paragraph).toContain(`\`git ${verb}\``);
  }
  expect(paragraph).toContain("--output");
});

/**
 * Criterion 10f. The pre-allowed check command is a subprocess, and no rule in the allowlist
 * reaches inside one — so the verbs the CLI group withholds are reachable anyway, and an agent
 * told the list is a boundary has been told something false. The assertion is the record and the
 * list agreeing rather than the record's prose: each verb the playbook names as reachable has to
 * be one the list really does withhold, so an entry added for one of them later fails here
 * instead of leaving the paragraph quietly wrong.
 */
test("the Code playbook records what a subprocess reaches, naming the withheld verbs", () => {
  const code = loadPlaybooks().code;
  const at = code.indexOf("Those check commands are a subprocess");
  expect(at).toBeGreaterThanOrEqual(0);
  const paragraph = (code.slice(at).split("\n\n")[0] as string).replace(/\s+/g, " ");
  for (const verb of ["mv", "claim", "release", "archive", "resolve"]) {
    expect(paragraph).toContain(`skelcrew ${verb}`);
    expect(FIXED_ALLOWLIST).not.toContain(`Bash(skelcrew ${verb} *)`);
  }
});

test("an empty playbook is refused at load, naming the file", () => {
  writeFileSync(join(dir, "spec.md"), "   \n");
  writeFileSync(join(dir, "code.md"), "# code\n");
  expect(() => loadPlaybooks(dir)).toThrow(join(dir, "spec.md"));
});
