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
 * Criterion 8c (015). `skelcrew show` now marks every line of the body with `> `, so a spec
 * file exported from what `show` prints would carry the markers. The body as stored is what an
 * export copies, and `--json` is where that lives.
 */
test("the Code playbook reads the body for export through --json", () => {
  const code = loadPlaybooks().code;
  expect(code).toContain("`skelcrew show <id> --json`");
  expect(code).toContain("`.body`");
  expect(code).toMatch(/\*\*overwrite that path\*\* from the card's body[^.]*--json[^.]*\.body/);
});

/**
 * The paragraphs a playbook's commands are not read from. Criterion 11 is about the commands a
 * playbook *instructs*, and these two say something else: the paragraph advertising what needs
 * no asking is pinned to `FIXED_ALLOWLIST` entry for entry below, so reading it here would only
 * prove the list matches its own restatement; and the paragraph recording what a subprocess
 * reaches names the five verbs the list withholds, which is the opposite of instructing them.
 * The paragraph on the read-only git verbs stays in: it is checked against the harness's own
 * behaviour rather than against the list it came from, so there is nothing circular about it.
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
  for (const whole of playbook.split("\n\n")) {
    if (NOT_INSTRUCTIONS.some((marker) => whole.includes(marker))) continue;
    const paragraph = whole.replaceAll(PROHIBITION, "");
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
  // The prohibition and the instruction share a bullet: "never push another refspec" and
  // "`git push -u origin HEAD` is the form to use". Excluding the paragraph by its prose
  // marker dropped the instruction with it, so an instruction that shares a bullet with a
  // prohibition would stop being checked without anything failing.
  expect(commands).toContain("git push -u origin HEAD");
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
 * Criterion 10f of 013, and criterion 11 of 016. The pre-allowed check command is a subprocess,
 * and no rule in the allowlist reaches inside one — so the five verbs are reachable from one
 * whatever the list says. What stops them is the daemon: the card's claim is the runner's and
 * the agent speaks as `crew`, so the core refuses every one of them on its own facts. The
 * paragraph has to say exactly that and not that the list withholds them, because an agent told
 * the list is a boundary has been told something false. The assertion is the record and the list
 * agreeing rather than the record's prose alone: each verb the playbook names as reachable has
 * to be one the list really does leave off, so an entry added for one of them later fails here
 * instead of leaving the paragraph quietly wrong.
 */
test("the Code playbook says a subprocess reaches the five verbs and the daemon refuses them", () => {
  const code = loadPlaybooks().code;
  const at = code.indexOf("Those check commands are a subprocess");
  expect(at).toBeGreaterThanOrEqual(0);
  const paragraph = (code.slice(at).split("\n\n")[0] as string).replace(/\s+/g, " ");
  for (const verb of ["mv", "claim", "release", "archive", "resolve"]) {
    expect(paragraph).toContain(`skelcrew ${verb}`);
    expect(FIXED_ALLOWLIST).not.toContain(`Bash(skelcrew ${verb} *)`);
  }
  // The refusal is the daemon's, and it holds whatever process is calling.
  expect(paragraph).toContain("the daemon refuses");
  expect(paragraph).toContain("whatever called");
  // And the list is not claimed as what stops them.
  expect(paragraph).not.toContain("withheld");
  expect(paragraph).not.toContain("obtain");
});

test("an empty playbook is refused at load, naming the file", () => {
  writeFileSync(join(dir, "spec.md"), "   \n");
  writeFileSync(join(dir, "code.md"), "# code\n");
  expect(() => loadPlaybooks(dir)).toThrow(join(dir, "spec.md"));
});

// --- what the Code phase's contract requires of its playbook ---

/**
 * The playbook as one line. A rule is a sentence, and a sentence wraps; asserting on the
 * sentence rather than on a word it happens to contain is what makes deleting the rule fail
 * the test — `toContain("refs/heads/")` passes on §4's condition list with §1's rule gone.
 */
function unwrapped(playbook: string): string {
  return playbook.replace(/\s+/g, " ");
}

/** The verbs a playbook can put in front of an agent. An inline span starting with one is a
 * command; one starting with anything else — a ref name, a flag, a filename — is not. */
const COMMAND_WORDS = ["skelcrew", "git", "gh", "bun"];

/**
 * The lines inside a playbook's fenced blocks: what it sets out for the agent to run verbatim.
 * A heredoc body is in here too, and is prose rather than a command — no shape asserted
 * against these reaches it, so it needs no separating out.
 */
function prescribed(playbook: string): string[] {
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
function commandsNamed(playbook: string): string[] {
  const inline = [...playbook.matchAll(/`([^`\n]+)`/g)]
    .map((match) => match[1] as string)
    .filter((span) => COMMAND_WORDS.includes(span.split(/[\s(]/)[0] as string));
  return [...prescribed(playbook), ...inline];
}

test("the Code playbook records the pull request on every run, reading an existing one back", () => {
  const code = loadPlaybooks().code;
  // The contract checks that *this run* recorded it, so a revision on an existing PR still
  // has to record — which means reading the URL back off the branch.
  expect(unwrapped(code)).toContain(
    "**Record the pull request on every run**, not only the run that opens it.",
  );
  expect(unwrapped(code)).toContain(
    "Two calls, and **never one**: read the URL, then pass what it printed as a literal.",
  );
  // Both prescribed, so the agent copies them rather than composing one with a substitution.
  expect(prescribed(code)).toContain("gh pr view --json url --jq .url");
  expect(prescribed(code)).toContain("skelcrew refs <id> --pr <the URL that printed>");
});

test("the Code playbook makes qualifying both branch names a rule, not an example", () => {
  // A bare name resolves by precedence, and a tag outranks a branch head.
  expect(unwrapped(loadPlaybooks().code)).toContain(
    "**Name both branches in full wherever you compute a diff or a range**: `refs/heads/<base>` and `refs/heads/<branch>`, never the bare names.",
  );
});

test("the Code playbook exports a spec file only where the repository already keeps specs", () => {
  const code = loadPlaybooks().code;
  expect(unwrapped(code)).toContain(
    "Write a spec file **only** where the repository already keeps specs",
  );
  // The card's body is the spec, so a repository that publishes none finishes just the same.
  expect(unwrapped(code)).toContain("the contract in §4 never asks whether you wrote one");
  expect(prescribed(code)).toContain("skelcrew refs <id> --spec docs/specs/<NNN>-<name>.md");
});

test("the Code playbook reuses the recorded spec path on a card returning from PR", () => {
  const code = unwrapped(loadPlaybooks().code);
  expect(code).toContain(
    "If a `specPath` is recorded, that is this card's spec file: **overwrite that path** from the card's body",
  );
  expect(code).toContain("Do not allocate a new number");
});

test("no command either playbook names carries a shell operator", () => {
  // Two different reasons, and they are not the same strength.
  //
  // A command substitution or a subshell is asked about **outright** — the harness answers
  // "this command uses shell operators that require approval for safety" whatever the fixed
  // list holds. That is the one that would have stopped an unattended Code run on the single
  // condition deciding whether the phase can complete.
  //
  // A list or a pipeline is *not* always asked about: the harness splits it into its parts and
  // allows it when every part is allowed on its own. It is barred here anyway, as a rule about
  // what a playbook may set out rather than a claim about the harness — a joined command is
  // only ever as allowed as its least-allowed part, and every command these playbooks name is
  // a single command, so nothing is lost by writing them one at a time.
  //
  // A redirection is in neither class: the harness matches its rule against the command with
  // the redirections stripped, which is why the Spec playbook's heredoc is fine and why `<<`
  // is deliberately absent below.
  for (const phase of PLAYBOOK_PHASES) {
    for (const command of commandsNamed(loadPlaybooks()[phase])) {
      expect(command).not.toMatch(/\$\(|`|&&|\|\||\||;/);
    }
  }
});
