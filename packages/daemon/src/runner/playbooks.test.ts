import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXED_ALLOWLIST, runsUnprompted } from "./allowlist";
import { commandsNamed, instructedCommands, prescribed } from "./playbook-commands";
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
 * Criterion 11, and it asks about *asking*, not about the list: a playbook's `git log` runs
 * unprompted through the harness's own read-only check rather than through an entry, since the
 * six read-only git verbs came off the list once `--output` proved a trailing wildcard could
 * not exclude a write-capable flag. `runsUnprompted` is the list plus that check.
 */
test("every command the playbooks run goes unprompted, so none of them stops to ask", () => {
  const playbooks = loadPlaybooks();
  for (const phase of PLAYBOOK_PHASES) {
    const commands = instructedCommands(playbooks[phase]);
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
  const commands = instructedCommands(loadPlaybooks().code);
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

/**
 * 017 puts this same list through the harness itself, where every one of these is a run that
 * either executes or is denied — so what the list holds is now load-bearing twice over, and
 * each exclusion is named here rather than left to the harvester's prose. Every string below
 * was run through the pinned harness while 017 was built: each excluded one is denied, and
 * `skelcrew show <id> --json`, run as written, creates a file called `--json`.
 */
test("the instructed commands are the playbook's commands, not its nouns, prose or prohibitions", () => {
  const spec = instructedCommands(loadPlaybooks().spec);
  const code = instructedCommands(loadPlaybooks().code);
  // The heredoc's first line is the command; its body is the spec being written, not commands.
  expect(spec).toContain("skelcrew body PLACEHOLDER <<'SPEC'");
  expect(spec).not.toContain("# PLACEHOLDER");
  expect(spec).not.toContain("…");
  expect(spec).not.toContain("SPEC");
  // "every step lands there through the `skelcrew` CLI" is a noun, not a command.
  expect(code).not.toContain("skelcrew");
  // The five verbs the fixed list withholds are named to say they are *not* available, and the
  // harness denies all five. A playbook that starts instructing one must fail here first.
  for (const verb of ["mv", "claim", "release", "archive", "resolve"]) {
    expect(code).not.toContain(`skelcrew ${verb}`);
  }
  // A placeholder is a shell redirection, so the template is not the command the agent runs.
  expect(code).toContain("skelcrew show PLACEHOLDER --json");
  expect(code).not.toContain("skelcrew show <id> --json");
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

/**
 * One contiguous assertion, over the sentence 8c amended: relocating either half of it — the
 * overwrite rule or the prohibition on a new number — fails this, which two `toContain`s either
 * side of the inserted clause would not.
 */
test("the Code playbook reuses the recorded spec path on a card returning from PR", () => {
  expect(unwrapped(loadPlaybooks().code)).toContain(
    "If a `specPath` is recorded, that is this card's spec file: **overwrite that path** from the card's body, read with `skelcrew show <id> --json` and taken from `.body` — `skelcrew show` marks every line of the body so it cannot be mistaken for a line the CLI wrote, and the JSON is the body as stored. Do not allocate a new number",
  );
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
  //
  // This stays the fast path — it runs on every `bun run check` and catches the common case —
  // and `bun run check:harness` (017) is what catches the case it cannot, by asking the harness.
  for (const phase of PLAYBOOK_PHASES) {
    for (const command of commandsNamed(loadPlaybooks()[phase])) {
      expect(command).not.toMatch(/\$\(|`|&&|\|\||\||;/);
    }
  }
});
