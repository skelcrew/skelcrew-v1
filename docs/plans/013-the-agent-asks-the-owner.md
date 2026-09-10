# 013 — The agent asks the owner: run record

Spec: `docs/specs/013-the-agent-asks-the-owner.md`. Base `ac661d0`, branch
`worktree-agent-asks-the-owner`.

## The change, in four steps

1. **`allowlist.ts`** — the fixed list becomes the spec's list, verbatim and in its order; the
   model of the harness's matching gains the one shape the new list needs (a trailing `*` with
   no space, as in `Bash(gh repo view*)`); and the module gains the scan of the target
   repository's `AGENTS.md`/`CLAUDE.md`, with the rule that a scanned command may not widen a
   command the fixed list narrows.
2. **`run.ts`** — `canUseTool` raises an attention request to the owner and waits for the
   answer instead of denying. A queue of asks, one on the card at a time; the next raised from
   inside the `attention_resolved` handler; the answer read from the comment whose `seq` is
   `resolved.seq - 1` by the same actor, which is consumed rather than also forwarded to the
   agent.
3. **`runner.ts`** — the run is spawned with `allowlistFor(repoRoot)` rather than the fixed
   list alone, and the heartbeat interval becomes injectable so a wait can be tested against a
   clock rather than 30 seconds of real time.
4. **`playbooks/code.md`** — the section describing 012's blanket denial is replaced by what
   this list allows, what asking costs, and the two prohibitions the list cannot enforce
   (`--no-verify`, and any push other than the allowed form).

## Decisions the spec left open

- **The scan reads `repoRoot`, not the card's worktree.** The spec says "at the target
  repository root". It is also the safer of the two: a worktree is reused across runs of a
  card, so an agent that edited `AGENTS.md` in a previous run of the same card would be
  widening its own next run.
- **An answer is matched case-insensitively after trimming**, so `Allow`, `OK ` and `Yes`
  allow. Anything else — including a sentence containing the word — denies. Fails closed.
- **A scanned first token must look like a command word** (`[A-Za-z0-9._/-]+`). The spec does
  not say this; without it a fenced block whose first token is `*` yields `Bash(* *)`, which
  the harness compiles to `^.* .*$` — every command with a space in it. This narrows only, and
  is recorded here because it is beyond the spec's words.
- **An unterminated fence contributes nothing.** The spec names a malformed fence as a case
  but not its outcome; failing closed is the direction that cannot widen the boundary.
- **A run that ends while its own permission request is open leaves it open.** `ending.ts`'s
  rule — a run's ending never replaces a question on the card — is deliberately untouched, so
  the owner sees the unanswered question plus the run's ending comment beside it. Answering it
  re-dispatches the card.
- **The outcome of every answer is posted as a comment** (`allowed …` / `denied …: <reason>`),
  so what the owner's word did is visible on the card and not only in the agent's context.

## Files

`packages/daemon/src/runner/allowlist.ts`, `allowlist.test.ts`, `run.ts`, `run.test.ts`,
`runner.ts`, `playbooks.test.ts`, `packages/daemon/playbooks/code.md`, this file.

## The case next to criterion 5

Criterion 5 is the agent's question arriving *before* the run's. The case beside it is the
agent's question arriving *after* — the core lets it replace the run's request on the card —
and the ask must then go back in the queue and be re-raised once the agent's question is
answered, rather than being lost. Tested as its own case, and the test fails if the requeue
is removed.

## Verifying the matching rule against the harness

The spec requires the rule to be checked against the harness rather than taken from the spec.
`PW`, `ZRe`, `vi` and `Mkt` were read out of the shipped Claude Code binary
(`~/.local/share/claude/versions/2.1.267`, the one `@anthropic-ai/claude-agent-sdk@0.3.266`
spawns) and run verbatim against every entry of the list and every negative in criterion 8.
Findings are in the report; the load-bearing ones:

- `Bash(x *)` compiles to `^x( .*)?$` — the spec's rule 1 holds, and every negative in
  criterion 8 asks.
- `Bash(gh repo view*)`, with no space before the `*`, compiles to `^gh repo view.*$`
  instead: a prefix with no separator. Implemented verbatim as the spec names it, and reported.

## Spec review

The spec was amended after the six commits above, on two points, and the amendments are
implemented here.

**1. The scan grants the command line, not its first word.** Taking the first token meant a
repo showing `bun run check` produced `Bash(bun *)` — which matches `bun -e '<any code>'`, and
the same for `node -e`, `python -c`, `npm` and `make`. That is the wildcard-before-the-
subcommand shape the fixed list refuses for `git`, on the one entry a *target repository*
controls. `scanInstructions` now returns the line whole and `allowlistFor` grants
`Bash(bun run check *)`. Criterion 9's new clause — `bun -e '…'` still asks — is its own test,
and every scan test was re-checked against the line shape.

**2. `Bash(gh repo view *)`.** The missing space was a typo in the spec, now corrected there.
` *` compiles to `^gh repo view( .*)?$`; `view*` compiles to `^gh repo view.*$`, a prefix with
no separator that also covers `gh repo viewer`. The list test pins the corrected shape and a
negative case pins `gh repo viewer`. `entryAllows` still models the no-space shape although no
entry now has it: reading such an entry as an exact command would make the model *narrower*
than the harness, the one direction a "this is not allowed" assertion cannot afford.

**What the no-widening rule means under the line form.** The rule now reads the *first word* of
the scanned line and drops the line whole if that word is one the fixed list narrows
(`git`, `gh`, `skelcrew`). Three consequences, all tested:

- `git status` in a repo's instructions still contributes nothing, so no `Bash(git *)` — the
  criterion 10 case, unchanged in outcome.
- Dropping the line whole is now doing more work than before, not less: under a line grant, a
  repo documenting `git push --force` would otherwise be handed back exactly the form the fixed
  list withholds, and `gh pr merge` likewise. The alternative — granting a narrowed command's
  line when the fixed list happens not to cover it — is a repository editing its own boundary,
  so the line is dropped and the agent asks.
- `git status && rm -rf /` needs no special handling: its first word is `git`, so it is dropped
  like every other `git` line. For a line whose first word is *not* narrowed
  (`bun run check && rm -rf /`), the harness's own decomposition covers it: read out of the
  shipped binary, a subshell or command group is asked about outright, and a list or pipeline
  is split into its parts and matched part by part — allowed only if every part is — while a
  whole compound command matches a rule only when the rule's content is that command exactly.
  A scanned entry containing `&&` therefore grants nothing its parts do not already grant. The
  module's model of the harness is looser here (a plain prefix comparison), and that is
  recorded in `allowlist.ts` as the model erring wide; no scan-time filter was added, because
  the spec asks for none and the harness's check is the one that governs.

**Three points raised in the report, answered.**

- **The seq-1 answer rule.** The implementation looks for the answering comment only in the
  current dispatch's held-comments buffer, which is narrower than the spec's literal words
  ("the comment whose sequence number is immediately before the resolution"). Confirmed as the
  intended reading and kept: it is not a divergence, and a reviewer should not read it as one.
- **A run that ends with its own permission request still open** leaves the request open. That
  belongs to 014 (artefact contracts and run endings), which needs to pick it up: the owner
  currently sees an unanswered question beside the run's ending comment, and answering it
  re-dispatches the card.
- **`Write`, `Edit` and `MultiEdit` are unbounded by path** — per the spec, which lists them
  bare, and sandboxing is out of scope. Recorded in `allowlist.ts`'s module doc rather than
  changed.

## Review round 1

Six findings, one commit each. The spec was amended again before this round — the scan section
gained the literal-command rule and the base-commit rule, and criterion 10a was added — so the
Critical and Important 1 below were defects in the spec as much as in the code; what follows
implements the amended spec. Two decisions recorded above are superseded by it: "the scan reads
`repoRoot`, not the card's worktree" (it reads the base commit now, from either) and "a run that
ends while its own permission request is open leaves it open".

### Critical — a scanned line's metacharacters became harness wildcards

The `COMMAND_WORD` guard validated the line's first word only; the rest went into
`Bash(${line} *)` raw. A fenced `bun *` in a target repo's `AGENTS.md` yielded
`Bash(bun * *)`.

Verified myself, against the harness rather than by reasoning: the shipped binary at
`~/.local/share/claude/versions/2.1.267` embeds its matcher, `PW(rule, command, caseInsensitive,
normalizeWhitespace)`, which compiles a rule by escaping regex metacharacters and then
`replaceAll("*", ".*")`. Extracted and run:

```
"bun * *"          | "bun -e 'console.log(1)'"    -> true
"make * *"         | "make -f /tmp/evil.mk all"   -> true
"bun run check *"  | "bun -e 'console.log(1)'"    -> false
"bun \* *"         | "bun -e 'x'"                 -> false   (\* is a literal star)
"bun ?? *"         | "bun -e"                     -> false   (? and [ are escaped, not compiled)
```

So `*` is the character that widens; `?` and `[` are literal to this harness. The spec names all
three, and the fix drops a line carrying any of them — including an escaped `\*`, which the
harness would honour as a literal. Escaping instead of rejecting would work against *this*
version's matcher, but rejecting is simpler to state, simpler to test, and cannot be wrong.

Red (`allowlist.test.ts`, criterion 10a):

```
- [ "Bash(bun run check *)" ]        expected
+ [ "Bash(bun * *)", "Bash(bun run check *)" ]   received
```

The assertion is on the entries, not on `allowsTool`: this module's model of the harness is a
literal prefix comparison, so it cannot see `Bash(bun * *)` matching `bun -e` — the bug lives
where the model is deliberately not a regex engine. Both are asserted, with that reason written
beside them.

### Important 1 — an agent could widen its own next run's allowlist

`allowlistFor` read the working tree, and `Write` is on the fixed list and not path-constrained.
One unprompted `Write` into `AGENTS.md` — on the card as `ran 1 tool: Write` inside a batched
30-second summary — pre-allowed a command line for every later run in that repository.

Red, at the unit that does the reading:

```
test("an instruction file that is only in the working tree contributes nothing")
- []                            expected
+ [ "Bash(bun run evil *)" ]    received
```

and at the run, with the implementation reverted to check that the case is real (`run.test.ts`,
two consecutive runs of the same repo, the first writing `AGENTS.md`):

```
   "Bash(gh repo view *)",
+  "Bash(bun run evil *)"    the second run's allowedTools
```

`git.ts` gains `showFile(repoRoot, ref, path)` — `git show <ref>:<path>`, undefined when the
path or the ref is not there, which git reports as the same exit. `allowlistFor(git, repoRoot,
base)` reads each instruction file through it and is now async.

**Getting the base in.** The runner already resolves `base` (`git.defaultBranch(repoRoot)`) to
fork the branch from, so `base.sha` is passed straight down — no new resolution, no new option,
one more `await` in the same try, with `stillHeld()` after it like every other window there.
Reading the *default branch head* rather than the card branch's tip is deliberate and slightly
stricter than the spec's words: a commit the agent made on its own branch in an earlier run
grants nothing either, and only what the owner merged counts.

### Important 2 — a run's own permission request outlived the run

Ending with the question still open, `settleAll` denied the ask locally, `endRun` saw
`attention !== null` and posted its reason as a comment alone. The owner's queue showed
`allow Bash rm -rf build? (skelcrew resolve 1 -m allow | …)` — an action that allows nothing
once the run is gone — and `run aborted: time limit …` never reached the queue.

Red (`run.test.ts`):

```
expect(request?.note).toContain("time limit")
Expected to contain: "time limit"
Received: "allow Bash rm -rf build? (skelcrew resolve 1 -m allow | skelcrew resolve 1 -m deny)"
```

`endRun` takes `replaces?: (open: Attention) => boolean` and the run passes `isRaisedHere`,
which compares the card's open request by value against the record the core returned for the
run's own `requestAttention` call (`to`, `note`, `raisedBy`, `raisedAt`). That is how the two
are told apart: `raisedBy` cannot, because the agent's `skelcrew attention` runs as the same
`runner` member. A caller that passes nothing gets `ending.ts`'s rule unchanged, and the three
tests for an agent's own question surviving an ending — session end, time limit, throw — still
pass untouched. `raised` therefore has to outlive the ask it belongs to: it is cleared when the
request is answered or replaced, not when `settleAll` settles the ask.

`resolveAttention` was not used for this: the request is addressed to the owner, a human, and
the core refuses an agent resolving a request that is not its own. Replacing it is the path the
core allows.

### Minor 1 — the case-insensitivity claim

`LV`, the harness's comparator for a wildcard rule, is `PW(e, n, !1, !0)`: case-insensitive
`false`, whitespace-normalizing `true`. Exact rules are compared with `===` on the unlowered
command. Run against the extracted matcher: `"git log *" | "GIT LOG --oneline" -> false`.
`entryAllows` lowercases both sides, so it errs wide — recorded as the fourth divergence
instead of as an agreement. The whitespace flag is recorded beside it as the one place the
model is *narrower* than the harness; nothing is compensated for either way.

### Minor 2 — two assertions that could not fail

`toContain("no")` passes against "The owner did not allow Write, and said nothing about why."
Both sites now assert the message in full. Checked by mutation — with the reason reworded to
"The owner refused Write: deny" the loop fails, which it did not before.

### Minor 3 — a failed `requestAttention` stalled the run

Red: with a core whose `requestAttention` throws, the agent was told
`"The run ended before the owner answered, so Bash did not run."` a full second later, when the
run's limit fired; the card said nothing at all. The ask is now denied naming the failure, the
card gets `could not ask the owner about …`, and the next queued ask is raised.

### Files, this round

`packages/daemon/src/runner/allowlist.ts`, `allowlist.test.ts`, `run.ts`, `run.test.ts`,
`ending.ts`, `runner.ts`, `git.ts`, `git.test.ts`, this file.

### Checks

`bun run check` green: 403 tests, 0 fail.

## Review round 2

The plan, before any of it was written:

1. **Critical** — `Bash(git branch *)` off the fixed list (spec and `code.md` prose with it),
   and the scan's base moved from `refs/heads/<default>` — which every worktree shares — to
   the remote-tracking `refs/remotes/origin/<default>`, which nothing on the fixed list can
   write. Red first as criterion 10b: two consecutive runs, the first committing an
   instruction file and repointing `main` at it.
2. **Important** — the ending's "may this replace the open request?" predicate becomes a
   value both `run.ts` and `runner.ts` hold, required by `RunEnding`, so no ending path can
   omit it.
3. **Minor 1** — the harness's `xargs <pattern>` fallback recorded as a fifth divergence.
4. **Minor 2** — `code.md`'s pre-allowed paragraph asserted against `FIXED_ALLOWLIST` in both
   directions, instead of the list being checked against the playbook's own restatement.
5. **Minor 3** — `scanInstructions` tolerates CRLF.

Files expected: `packages/daemon/src/runner/allowlist.ts`, `allowlist.test.ts`, `run.ts`,
`run.test.ts`, `runner.ts`, `ending.ts`, `playbooks.test.ts`,
`packages/daemon/playbooks/code.md`, this file.

### Critical — a run could still widen its successor's allowlist

Round 1 moved the scan off the working tree and onto `git show <base>:…`, but `<base>` was
`git.defaultBranch`'s sha, resolved from `refs/heads/<name>` — a local, mutable ref shared by
the main checkout and every linked worktree — and `Bash(git branch *)` was pre-allowed. Write
`AGENTS.md`, `git add -A`, `git commit`, `git branch -m main trunk`, `git branch main HEAD`,
and the next run is spawned with whatever that file says.

Two fixes, neither sufficient alone.

**`Bash(git branch *)` left the fixed list.** The spec had already dropped it: branch refs are
shared, so `git branch` writes the owner's repository, not a scratch copy. No playbook runs it;
a read-only use asks. `code.md` advertised `branch` and no longer does.

**The scan's base is `refs/remotes/origin/<default branch>`.** Chosen because nothing on the
fixed list can write a ref under `refs/remotes/`: the four commands that write those refs are
`fetch`, `pull`, `remote` and `push`, and only `push` is listed — as `git push -u origin HEAD`,
which pushes the worktree's HEAD and so writes the card branch's remote-tracking ref alone, and
as a bare `git push`, which under `push.default = matching` does push the default branch but
only at the value that branch already holds. No pre-allowed command can change that value: a
run's commits land on its own HEAD, and `git branch` is gone. An absent or unreadable ref grants
nothing, as before, so a repository with no origin has its check commands ask.

Red first, as criterion 10b, driven through two consecutive runs against a repository whose
origin carries `AGENTS.md`:

```
expect(options.allowedTools).toEqual([...FIXED_ALLOWLIST, "Bash(bun run check *)"])
-   "Bash(bun run check *)",
+   "Bash(bun run evil *)",
```

The signature change — `allowlistFor(git, repoRoot, defaultBranch)` takes the branch name and
builds the ref itself — could not manufacture that green: the test drives the runner end to
end, and the assertion is that the *legitimate* grant survives beside the attacker's being
refused, so a scan that silently stopped working would fail it too.

### Important — the ending predicate, made impossible to forget

`runner.ts`'s failed-step ending called `endRun` without `replaces`, and that is where a throw
out of `runPlaybook` lands — including the driver iterator's `return()` throwing in the
`finally`, which had a test already. Red:

```
expect(request?.note).toContain("the harness died on cleanup")
Received: "allow Bash rm -rf build? (skelcrew resolve 1 -m allow | skelcrew resolve 1 -m deny)"
```

Rather than adding `replaces: isRaisedHere` to that one call, the rule stopped being something
a call site remembers. `ending.ts` exports `RunQuestion` — `raised(request)` / `isOpen(request)`
around the record the core made for the run's own `requestAttention` — and `RunEnding.question`
is **required**. The runner makes one per run, before anything can end, and hands the same value
to `runPlaybook` and to its own ending. A path added later has nothing to leave out: there is
one value in scope, and `tsc` asks for it.

The neighbour holds unchanged: an agent-raised `skelcrew attention` question survives the
session ending, the time limit and this same throw — three tests, none touched.

### Minor 1 — a fifth harness divergence

`Ode` in the shipped binary retries a wildcard allow rule as `LV("xargs " + pattern, command)`
whenever the pattern ends in an unescaped `*` (the guard is `Rur`, which is exactly that test),
so `Bash(git status *)` also allows `xargs git status -s` there. Recorded, with the reason it
adds no reachable power here: the alias runs the command the entry names with words appended
from stdin, which the entry's trailing `*` already allows, and the two entries where an alias
would matter — `Bash(git push -u origin HEAD)` and `Bash(git push)` — carry no wildcard, so they
get no retry.

### Minor 2 — the playbook restated the list, and the test was circular

`playbooks.test.ts` extracted `code.md`'s own prose and checked the list covered it. `code.md`
now names each entry as the list names it, and the test compares the two sets both ways. Red
before the playbook was rewritten:

```
- "git status", "git log", … "skelcrew body", "skelcrew refs",
+ "status", "log", … "body", "refs",
```

### Minor 3 — CRLF

The closing-fence pattern ended `[ \t]*$`, so a `\r` made every block look unterminated and a
CRLF repository granted nothing, silently. Lines are split with the `\r` dropped. Red:
`expect(await scanned()).toEqual(["Bash(bun run check *)"])` received `[]`.

### Files, round 2

`packages/daemon/src/runner/allowlist.ts`, `allowlist.test.ts`, `ending.ts`, `run.ts`,
`run.test.ts`, `runner.ts`, `playbooks.test.ts`, `packages/daemon/playbooks/code.md`, this file.

### Checks

`bun run check` green: 409 tests, 0 fail.

## Review round 3

The spec was amended again first (`git checkout main -- docs/specs/013-the-agent-asks-the-owner.md`,
from `331b98b`): the fixed list's file-tool entry is now anchored, criteria 10b/10c and 2 gained
clauses, and "Choosing the ref is not enough on its own" was added. What follows implements the
amended spec.

Five findings, one commit each.

1. **Critical 1 + Critical 2 — the file tools are anchored to the run's worktree.** `Edit`,
   `Write` and `MultiEdit` come off `FIXED_ALLOWLIST`; one per-run entry
   `Edit(//<abs worktree>/**)` replaces them, with `Edit(//<wt>/.git)` and
   `Edit(//<wt>/.git/**)` delivered as deny rules through the SDK's `disallowedTools`. Files
   touched: `allowlist.ts`, `runner.ts`, `run.ts`, `agent.ts`, `claude.ts`, `playbooks/code.md`.
2. **Important 3 — the permission question carries the input in full**, cut only at the note's
   own byte cap, marked, naming the run log. `INPUT_LINE_MAX` stays as it is for the activity
   summary. `run.ts`.
3. **Minor 4 — a test that the owner's answer is not also delivered to the agent**, and a line
   in the held-comments doc comment recording that `answerTo` depends on the splice. `run.ts`,
   `run.test.ts`.
4. **Minor 5 — the run-start comment says what the scan added, or why it read nothing.**
   `allowlist.ts` returns that clause with the list; `runner.ts` puts it on the card.

### Decisions the spec left open

- **The rule is spelled `Edit(/<absolute path>/**)`.** The spec writes `Edit(//<worktree>/**)`;
  read literally with `<worktree>` an absolute path that is three slashes. `//` is the harness's
  "absolute from the filesystem root" prefix, so the rule for `/a/b` is `//a/b/**`, which is
  `"/" + path`. (Both forms in fact reach the same pattern — `uBe` slices one slash and `Vn`
  collapses the rest — but the two-slash form is the documented one.)
- **The deny rules travel as `disallowedTools`.** That is the only seam the SDK exposes for
  deny rules; the CLI turns them into `alwaysDenyRules.cliArg`, which is what the file check
  consults first.
- **`allowlistFor` returns `{ tools, denied, scanned }`** rather than an array, so the run's
  deny rules and the clause the card shows come from the one place that knows them.

### Verifying the new rules against the shipped binary

The spec's file-permission facts were given as verified, but the *resulting rules* were checked
against the harness the way earlier rounds checked the Bash matcher. The permission path was read
out of the `claude` binary `@anthropic-ai/claude-agent-sdk@0.3.266` spawns and run verbatim:
`Hi(path, ctx, "edit", behavior)` (the rule lookup), `PZe` (the allow check `uA` ends in), `Gr`,
`lh`, `Vke`/`uBe`, `Vn`, `Mi`, `zr`, `Ka`, and the binary's own bundled `ignore` module. What it
confirms, on the exact strings `editsIn`/`deniedTools` produce:

- a write anywhere under the worktree is allowed; `<wt>/.git` and `<wt>/.git/**` are denied; a
  ref, `packed-refs` and `config` under the git common directory, `~/.claude/settings.json`, and
  a sibling directory whose name merely starts with the worktree's path all reach `ask`;
- `Write(<path>)` as an allow rule leaves the edit check with nothing — only `Edit(path)` and
  `Read(path)` rules are consulted (`_He` warns exactly that, naming `Write`, `NotebookEdit`,
  `MultiEdit` → `Edit` and `Glob` → `Read`);
- as an *allow* rule a single-segment `dir/**` does not match at depth, while as a *deny* rule it
  does — the asymmetry is `Hi`'s `E.has(V + "/**") && (V.includes("/") || o !== "allow")`;
- `--disallowedTools` becomes `alwaysDenyRules.cliArg` in the CLI's own option handling, which is
  the list `uA` consults *before* any allow rule and before `canUseTool`;
- the entries survive the CLI's own `--allowedTools` splitter (`td`), which splits on commas and
  on spaces outside parentheses — so a worktree path containing either is still one entry.

The rule is written `Edit(//<abs>/**)`, two slashes: `//` is the harness's "absolute from the
filesystem root" prefix. The spec's `Edit(//<worktree>/**)` read literally would be three.

## Review round 4 — `Bash(git log *)` was an arbitrary-file-write primitive

The spec was amended again (`160580a`): a new paragraph on trailing wildcards, a new bullet
saying the read-only git verbs are not listed at all, a shortened fixed list, and criteria 10d
and 10e. What follows implements the amended spec.

### The finding

`git log`, `git diff` and `git show` all accept `--output=<any absolute path>`. A trailing
wildcard cannot exclude a flag, so `Bash(git log *)` pre-allowed
`git log -1 --format=%H --output=<common>/refs/remotes/origin/main` — the forgery round 3 closed
from the file-tool side — and `git log -1 --format=%B --output=<common>/config`, which re-opens
10c. Reproduced against git 2.48.1 in a scratch repository with a linked worktree.

### The change, in steps

1. **Delete the six read-only git verbs from `FIXED_ALLOWLIST`** (`git status`, `git log`,
   `git diff`, `git show`, `git merge-base`, `git rev-parse`). No narrower wildcard exists.
2. **Model the harness's own read-only self-approval** for exactly those six verbs
   (`selfApprovedReadOnlyGit`, `runsUnprompted`), so 10d and 10e can be asserted rather than
   asserted-about-the-list-only: the point of the deletion is that the decision moves from our
   list to the harness's per-subcommand safe-flag validator, and a test that only reads our list
   proves nothing about the boundary.
3. **Audit every surviving wildcard entry's flags** and record the findings beside the entry in
   the module doc; rewrite the "rules" preamble (now more than five) and the "what this list
   does not close" section.
4. **Playbooks**: the Code playbook's advertised list loses the six verbs and gains a sentence
   saying the read-only git verbs run through the harness's own check. `playbooks.test.ts`'s
   command-by-command check becomes "runs unprompted" rather than "is on the list", which is
   what criterion 11 says.
5. **Tests**: both escalation chains as their own cases in `run.test.ts` with the `--output` step
   asserted not pre-allowed for a path inside the worktree and out; the six safe forms asserted
   still unprompted; the literal-list assertion updated.

### Files

`packages/daemon/src/runner/allowlist.ts`, `allowlist.test.ts`, `run.test.ts`,
`playbooks.test.ts`, `packages/daemon/playbooks/code.md`.

### Decided here, left open by the spec

- **The read-only model lives in `allowlist.ts`, not in a test file**, because three test files
  need it and a test importing another test file would re-run its cases. It is not called by
  production code: `run.ts`'s `canUseTool` only sees what the harness did *not* self-approve.
- **The model is the flag-name check only.** `nBe`'s value-type rules (a `"none"` flag may not
  carry `=`, a value flag consumes the next word) are not modelled; no assertion depends on
  them, and every negative asserted here is a flag that is absent from the harness's table
  altogether.

## Review round 5 — what a subprocess reaches, redirections, symlinks

The spec was amended again first (`git checkout main -- docs/specs/013-the-agent-asks-the-owner.md`,
from `b3c27cb` + `072808f`): a new section *What a subprocess reaches*, two recorded limitations,
criteria 10b/10c rescoped to **tool calls**, and a new criterion 10f. What follows implements the
amended spec.

### The plan

1. **10f — the record.** `allowlist.ts`'s rules preamble, its "what this list does not close"
   section and `deniedTools`'s doc comment stop claiming what a subprocess respects; `code.md`
   carries the same record in the playbook's register; milestone 016 is named as where the rules
   that must survive it move. Pinned by a test that cross-checks the verbs the playbook names
   against `FIXED_ALLOWLIST` rather than by matching prose.
2. **Shell redirection.** `>`/`>>` targets are checked against the `Edit` rules before the
   command is matched, the way `xce`/`jbo` do, and the command is matched with the redirection
   stripped. The 10b and 10c escalation chains gain their `>` forms.
3. **Symlinks.** The file-tool check resolves through links, because the harness does: verified
   against the shipped binary (below). A symlink out of the worktree is asserted not pre-allowed.
4. **Minors.** Rule 7's sentence about `git branch` (the harness's read-only tier is ~24 verbs,
   not six); a third known-wide place in `selfApprovedReadOnlyGit`; `commandsIn` in
   `playbooks.test.ts` stops scooping the advertisement and prohibition paragraphs; an assertion
   that the installed SDK matches the version the flag tables were transcribed from; the
   fail-closed polarity stated rather than implied.

### Verifying the symlink question against the shipped binary

`wr` (the path-set builder), `PZe` and `Hi` (the allow/deny lookup) were extracted verbatim from
the `claude` 2.1.266 the SDK spawns and run against a real worktree containing a real symlink out
of it. `wr` adds every symlink hop and the `realpathSync` of the path to the set it checks, and
`PZe` allows only when **every** path in that set matches an allow rule, so:

```
allow …/wt/src/x.ts                             paths: …/wt/src/x.ts
ask   …/wt/docs/vendor/config                   paths: …/wt/docs/vendor/config + …/repo.git/config
ask   …/wt/base                                 paths: …/wt/base + …/repo.git/refs/remotes/origin/main
```

The harness resolves. The anchor holds, and the model is made to agree rather than the divergence
being listed.

### What changed, per finding

- **Critical / 10f.** `allowlist.ts` gained a *What a subprocess reaches* section, a preamble
  pointing at it before any rule reads as a wall, an entry in "what this list does not close",
  and a rewritten `deniedTools` doc — which had claimed no entry on the list starts such a
  subprocess. Milestone 016 is named. `code.md` carries the same record in its own register, and
  `playbooks.test.ts` pins it by cross-checking the verbs the paragraph names against
  `FIXED_ALLOWLIST`, so the record and the list cannot drift apart. The module doc itself is not
  pinned by a test: a test that greps its own module's comment asserts prose, not behaviour.
- **Important 1.** The branch's spec is `git checkout main --`'d and byte-identical to main's.
  (True when written; main moved twice afterwards, and round 6 takes the spec again — a
  statement about a moving branch keeps only as long as the branch stands still.)
- **Important 2.** Modelled rather than listed as a divergence: `redirectionsIn` and
  `pastRedirections`. It sits beside `entryMatches` rather than inside it because a target is
  checked against every `Edit` rule, which one entry does not know.
- **Important 3.** The harness resolves; recorded, modelled in `filePaths`, asserted with a real
  symlink out of a real worktree, and `entryMatches` takes the allow/deny behaviour because the
  harness denies on one path and allows only on all of them.
- **Minor 1.** Rule 7's sentence corrected: the read-only tier is twenty-four verbs, `git branch
  --show-current` among them; the security half stands. The spec carries the same wrong sentence
  and is reported rather than edited.
- **Minor 2.** Three known-wide places in `selfApprovedReadOnlyGit`, not two.
- **Minor 3.** `commandsIn` skips the advertisement paragraph, the prohibition paragraph and
  the new subprocess record, and substitutes `<id>`-style placeholders — angle brackets are
  redirections. The read-only-git paragraph stays in: it is checked against the harness's own
  behaviour, not against the list it was copied from, so it is not circular.
- **Minor 4.** `TRANSCRIBED_FROM` pins the SDK, CLI, git and gh versions; `claude.test.ts` (the
  one file allowed to name the SDK) checks two of them against what is installed.
- **Minor 5.** The fail-closed polarity is stated, with its one exception.

### Checks

`bun run check` green: 440 tests, 0 fail (434 before this round).

## Review round 6 — a scanned line could open a second rule, and the symlink record was wrong

The spec moved twice more on main (`08cb5a0`, `2d4de9d`) and was taken whole again with
`git checkout main -- docs/specs/013-the-agent-asks-the-owner.md`: a new paragraph *And a
scanned line is one rule, never two*, a new criterion 10g, and a corrected `git branch`
paragraph. Round 5's note that the branch's spec was "byte-identical to main's" was true when
it was written and stopped being true when main moved; it is corrected here.

### The plan

1. **Critical 1 — one rule, never two.** A scanned line is accepted only if every character of
   it is on a conservative allowlist, parentheses first; and the invariant that catches whatever
   that set misses — each entry the scan produces splits into exactly one rule — is asserted
   against a transcription of the harness's own `--allowedTools` splitter (`td`), not against
   this module's `ENTRY` regex.
2. **Important 3 — the symlink record and the allow/deny asymmetry.** `anchor` resolves the
   worktree path through `realpathSync`, so `editsIn`/`deniedTools` spell a rule the way the
   harness spells the path it checks; the runner resolves its worktrees directory once, so the
   agent's cwd is spelled the same way and a run under a symlinked data directory is not
   reduced to asking about every write. The record states the equivalence table and the
   allow-only fallback.
3. **Important 4 — `redirectionsIn`'s divergences**, enumerated beside it in the form
   `entryMatches` uses, each with the direction it errs in.
4. **Minor 5** — four known-wide places in `selfApprovedReadOnlyGit`, not three: `git log` and
   `git show` carry an `additionalCommandIsDangerousCallback` this model does not run.
   **Minor 6** — `code.md` names the harness's read-only tier rather than claiming everything
   else asks. **Minor 7** — the bullet title in `allowlistFor` is scoped to tool calls.
   **Minor 8** — the symlink test's positive case creates the file it names.

### Verifying the two harness facts against the shipped binary

Both were run against `claude` 2.1.266, the binary `@anthropic-ai/claude-agent-sdk@0.3.266`
spawns, with the relevant functions extracted verbatim.

**The splitter.** `td` — the CLI's own `--allowedTools` splitter — run on the entry
`allowlistFor` builds from a fenced line:

```
"bun run"             -> Bash(bun run *)            -> ["Bash(bun run *)"]
"bun run) Bash(git"   -> Bash(bun run) Bash(git *)  -> ["Bash(bun run)", "Bash(git *)"]
"bun run) Bash(sh"    -> Bash(bun run) Bash(sh *)   -> ["Bash(bun run)", "Bash(sh *)"]
```

`Bash(git *)` is the grant the whole spec refuses and `Bash(sh *)` is arbitrary unprompted
execution, both obtained by a file the target repository controls, with the second command in a
later word where `narrowedCommands()` never looks. `ENTRY` reads the same entry as one malformed
entry matching nothing, so no assertion in this repository could see it.

**The equivalence table.** `Ap()` builds `[["/private/tmp","/tmp"],["/private/var","/var"],
["/private/etc","/etc"],["/usr/bin","/bin"],["/usr/lib","/lib"],["/usr/sbin","/sbin"]]` and keeps
each pair whose alias really resolves to its real form; on this machine that is the first three.
`sTt` maps a path under a real prefix back to its alias. `PZe` retries every failed allow lookup
through `sTt`; `uA`'s deny loop does not. Round 5 stubbed `Ap` as an empty table, which is why it
recorded the harness as asking. With the real table, on a data directory spelled `/tmp/skel`:

```
worktree spelled /tmp/…            allow /tmp/…/1/src/x.ts      DENY  /tmp/…/1/.git
                                   allow /private/tmp/…/1/.git   <- the hole
worktree spelled /private/tmp/…    allow /private/tmp/…/1/src/x.ts
                                   DENY  /private/tmp/…/1/.git   DENY  /tmp/…/1/.git
```

So the record was wrong twice over: an existing file under a symlinked worktree is *allowed*,
not asked about, and the `.git` deny the whole anchoring exists for is missed in the
`/private/…` spelling. Spelling the rules the way `realpathSync` spells the path closes it, and
the third line of the second block is why the runner has to spell its cwd the same way: with
real rules and a lexical cwd the harness asks about every write in the worktree.

### What changed, per finding

- **Critical 1.** `LINE_CHARS` in `allowlist.ts`: a scanned line is kept only when every
  character of it is a letter, a digit, one of `. _ / @ + : = -`, or a single space between
  words. An allowlist, because the attack was not the one a blocklist had been written for; it
  sits beside `PATTERN_CHARS`, which sanitises against a different language. `splitEntries`
  transcribes the harness's `td`, and `allowlist.test.ts` asserts the invariant over
  `allowlistFor`'s whole output for a repository whose instructions carry both attack lines, a
  `)`, a `(`, a comma and quotes.
- **Important 2.** The spec is `git checkout main --`'d again; the round-5 note is corrected in
  place rather than deleted.
- **Important 3.** `anchor` resolves the worktree path, so `editsIn` and `deniedTools` spell a
  rule the way the harness spells the path; `startRunner` resolves its worktrees directory once,
  so the agent's cwd is spelled the same way (with real rules and a lexical cwd the harness asks
  about every write in the worktree, which would be fail-closed and unusable). `filePaths`'s
  record replaces the false "asks" sentence with the equivalence table and the allow-only
  fallback. The test builds a worktree under `tmpdir()`, whose prefix is a link on macOS.
- **Important 4.** Four divergences beside `redirectionsIn`, each narrow, in `entryMatches`'s
  form: here-documents, `\"` inside a double-quoted string, `#` comments (with `[[ ]]` and
  `(( ))` named as the same class), and a relative target resolved against the daemon's cwd
  rather than the agent's.
- **Minor 5.** Four known-wide places in `selfApprovedReadOnlyGit`, not three; the fourth is
  `SZe`'s `additionalCommandIsDangerousCallback`, on `git log` and `git show` only, checked
  against the binary verb by verb.
- **Minor 6.** `code.md` names the harness's read-only tier instead of claiming everything else
  asks.
- **Minor 7.** The two bullet titles in `allowlistFor` that read as walls are scoped to tool
  calls, the way the paragraph below them already was.
- **Minor 8.** The symlink test creates the file its positive case names, and takes its root
  through `realpathSync` so the only link in play is the one inside the worktree.

## Round 7

Spec re-taken from `main` (`06bf9d8`): the qualified *"A repository documenting its commands
cannot accidentally widen…"* line, the every-word requirement, the new *What a scan cannot be*
section, and criterion 10h.

Plan, in three steps:

1. **Critical — the no-widening check reads only the first word.** `allowlist.ts`: drop a
   scanned line when *any* of its words is a narrowed command, not just its first, so a
   launcher prefix (`env`, `command`, `nice`, `/usr/bin/env`) cannot put `git`, `gh` or
   `skelcrew` in position two. Then correct the claim above `narrowedCommands` to what the
   amended spec says — reading every word closes the launcher gap and does **not** make the
   scan a boundary, because a fenced `sh` yields `Bash(sh *)` and nothing can — and sweep
   `allowlistFor`'s tail, `runner.ts`'s run-start comment and `code.md` for sentences that now
   overclaim (criterion 10f, 10h).
2. **Important — the permission note's frame can be forged.** `run.ts`'s `questionFor`: the two
   resolving commands move to the frame's first line, the agent-chosen input goes last, and
   every payload line is quoted with `> ` so no input text can imitate the frame or manufacture
   the `\n\n` block separator `queueView` splits real requests on. Same class as milestone 015;
   named in a comment, not implemented here.
3. **Minor — criterion 11's harvester excludes an instruction.** `playbooks.test.ts`: exclude
   prohibitions by their own shape — strip the `**Never …**` bold run from a paragraph and
   harvest the code spans that remain — so `git push -u origin HEAD`, the one push form the
   playbook instructs, is checked instead of dropped with the prohibition it shares a bullet
   with.

Files: `packages/daemon/src/runner/allowlist.ts`, `allowlist.test.ts`, `run.ts`, `run.test.ts`,
`runner.ts`, `playbooks.test.ts`, `packages/daemon/playbooks/code.md`.

Left open by the spec, decided here: the every-word check compares words literally, so a
path-qualified `/usr/bin/git push` is not caught. That is inside the limit *What a scan cannot
be* states — a hostile instruction file has `sh` — and normalising basenames would be a claim
the spec does not make.

### Checks

`bun run check` green after each of rounds 6 and 7: Biome clean, `tsc` clean in all three
packages, 445 then 448 tests passing.

## Round 8 — final verification

Scoped to verification rather than a hunt, by the owner's decision. Seven rounds had each
proved an escalation, and rounds 5 and 7 turned out to be the same fact from two sides — a
repository that pre-allows its own commands can pre-allow anything — which is not closable at
this layer and is milestone 016. Continuing to hunt was hardening the layer already proved
unable to hold.

**Verdict: VERIFICATION FAILED on one item, everything else passing.** Every acceptance
criterion met, 448 tests green, no unrelated changes, and the prose sweep found the round 6-7
scoping holding up. The failure was the spec copy: stale for the **third** time, one commit
behind `main`'s `b82c803`, which landed after this round took it. The implementation already
matched what that commit describes — only the export was behind.

That is worth recording as a process finding rather than a one-off. A spec amended on `main`
while a branch is mid-round goes stale by default, and it went stale three times in seven
rounds. Each time the code was right and the exported copy was wrong, which is the direction
CLAUDE.md's *the card is the source of truth* predicts: the copy is not authority, and nothing
notices when it drifts. Under skelcrew the same amendment would be a card body edit with no
copy to re-take.

Fixed in this round, off the back of verification:

1. **The spec re-taken from `main`**, and `git diff main -- docs/specs/013-…` asserted empty.
2. **`code.md`'s one remaining absolute.** "Everything the harness does not recognise as
   read-only asks the owner" is false quoted alone — `git commit -m x` is not recognised as
   read-only and does not ask, and a tool defining no permission check is allowed outright.
   Now "Past the list above and that recognition, a call asks the owner."
3. **`words()`'s literal comparison recorded where a reader of the module will find it.** The
   `/usr/bin/git push` gap lived only in this record; `narrowedCommands` is otherwise exhaustive
   about its own limits, down to naming `sh`. Verification judged the decision sound and the
   documentation gap real.
4. **The maintenance contract** for everything transcribed from the harness, added above
   `TRANSCRIBED_FROM`: what ages (four models), what does not (everything with a production
   caller — containment, not enumeration), that a stale model yields a wrong test and never a
   boundary that opens quietly, and the three legitimate responses to a failure, none of which
   is adjusting a model until its test passes again.

Verification also settled the two calls left open in round 7: the literal comparison is sound
for the reason above, and the truncation test is not flaky — its four pads sweep all four
residues mod 4, so exactly one lands the cut on a line boundary at every log-path length tried,
and the guard it exercises genuinely regresses without the fix.
