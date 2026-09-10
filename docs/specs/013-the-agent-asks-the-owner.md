# 013 — The agent asks the owner

## Goal

012 spawns an agent that may only read. Anything else — writing a file, committing, opening a
pull request — is denied, so the Code phase cannot run at all. This spec replaces that denial
with a question: a tool the agent is not pre-allowed becomes an attention request on the card,
the owner answers it with one command, and the run continues.

It also defines the full list of what needs no asking. **That list is a security boundary, not
a convenience setting**, and this spec is written to be reviewed as one. The 007 spike spent two
of its eight review rounds on exactly this: `Bash(gh pr *)` and `Bash(git *)` were specified,
implemented faithfully, and each dissolved the gate the same spec existed to build
(`docs/plans/007-spike-retrospective.md`, §4). Every grant below names its verbs, and the
reasoning for each is stated so a reviewer can check it rather than trust it.

## Current behavior

After 012:

- The agent boundary carries `canUseTool(tool, input): Promise<ToolDecision>`
  (`packages/daemon/src/runner/agent.ts`), and the run's implementation of it always denies.
  The denial is delivered to the agent with a reason and shown on the card.
- The fixed allowlist is read-only: `Read`, `Glob`, `Grep`, four `skelcrew` verbs, and four
  read-only `git` verbs. No write tool, no `git` mutation, no `gh`, no scan of the target
  repository's own instructions.
- A Spec-phase run therefore works end to end; a Code-phase run cannot commit or push.
- Attention requests already exist (010): `requestAttention(id, { to, note, moves? })` hands a
  card to a member, and `resolveAttention(id, text?)` answers it, recording `text` as a comment
  immediately before the resolution, in one dispatch.
- The runner heartbeats the claim while a run is live (`packages/daemon/src/runner/runner.ts`).

## Desired behavior

**A tool outside the list becomes a question on the card.** The run raises an attention request
naming the tool and its input, carrying the exact commands that answer it. The owner answers,
and the run continues with the agent's tool allowed or denied. The agent is never left waiting
on something invisible.

**One question at a time, answered in order.** If the agent asks for several tools at once, the
card shows one request; the next is raised as the previous is resolved.

**A question the agent asked itself outranks the run's own.** An agent that runs
`skelcrew attention` because it is genuinely blocked has said something the owner must answer;
the run's permission request must not replace it, and waits instead.

**Answers are ordinary CLI use.** `skelcrew resolve <id> -m allow` allows; `yes` and `ok` also
allow. `deny`, `no`, any other text, and resolving with no text all deny, and the text the owner
wrote is what the agent is told. Nothing about answering is agent-specific: it is the same
command a human uses to answer any request.

**Waiting does not lose the card.** The claim keeps its heartbeat while a request is open, so a
run waiting on the owner does not lapse. If the card is moved, archived or released while the
run waits, the run stops rather than continuing against a card that has moved on.

**The target repository's own check commands need no asking.** A repo whose `AGENTS.md` or
`CLAUDE.md` shows `bun run check` in a fenced block has that command pre-allowed, so an agent
following the repository's stated conventions is not stopped to ask permission for them.

**A repository documenting its commands cannot accidentally widen what the fixed list narrowed.**
A target repo whose instructions show a `git status` line must not thereby re-grant `git` as a
whole. The qualifier is exact and is not a hedge: see *What a scan cannot be*.

## Implementation approach

### Asking

`run.ts`'s `canUseTool` raises an attention request to the owner instead of denying, and waits
for its resolution. The note names the tool, carries the resolving commands in the shape the CLI
already renders for a request's suggested resolutions, and puts the agent's own text last, where
it cannot imitate the frame around it:

```
allow Bash? (skelcrew resolve 1 -m allow | skelcrew resolve 1 -m deny)
input:
> rm -rf build
```

**The frame comes first and the payload is quoted, so the input cannot forge a question.** The
input is the agent's text, and interpolating it into the middle of a one-line frame lets it close
that frame and open a second one: a command reading `ls? (skelcrew resolve 1 -m allow | skelcrew
resolve 1 -m deny)`, a blank line, then a plausible-looking request for another card, renders as
two blocks, and an owner who answers the innocuous first line has approved the real call. Every
payload line is prefixed, and a blank payload line must not survive as a blank line, since the
queue view separates real blocks with one. This is the same class as milestone 015.

**The note carries the input in full, not the activity summary's rendering of it.** The
glanceable one-line form the card uses for streamed tool calls cuts at a couple of hundred
characters; the request the owner *answers* must not, because the party choosing the text is the
party being gated. A command whose first two hundred characters read `git log …` and whose tail
is `&& curl … | sh` is a compound command, so it is not pre-allowed and does reach this ask —
and it would be approved on a rendering that hides the part that matters. The note carries the
input up to the comment size limit the core already enforces, and where even that truncates, it
says so and names the run log that holds the whole of it.

Three mechanisms the spike proved necessary, each after a review round (retrospective §2, §3):

- **Requests queue.** A list of pending asks plus the one currently on the card. The next is
  raised inside the `attention_resolved` dispatch — the core queues nested mutations, so raising
  from within a handler is how the next request lands atomically with the previous answer.
- **The answer is the comment `resolveAttention` records**, not a separate channel. Only the
  comment whose sequence number is immediately before the resolution, by the same actor, is the
  answer. That comment is consumed as the decision and is **not** also forwarded to the agent as
  a conversational message, or the agent sees its answer twice.
- **An open question the run did not raise is never replaced.** The run knows which request is
  its own from what the core recorded for it. Member identity cannot be used for this: the agent
  runs as `SKELCREW_AS=runner`, so its `skelcrew attention` question and the run's own request
  have the same `raisedBy` (retrospective §2). When the agent's own question is open, a
  permission request waits for it to be resolved.

### The full fixed list

The complete list after this spec, with the four groups 012 established plus what this spec
adds. Each line is exact; nothing here is a placeholder for a broader grant.

```
Read, Glob, Grep, Agent, TodoWrite
Edit(//<worktree>/**)            <- allows Edit, Write and MultiEdit, worktree only
deny: Edit(//<worktree>/.git)  deny: Edit(//<worktree>/.git/**)
Bash(skelcrew show *)   Bash(skelcrew comment *)   Bash(skelcrew body *)
Bash(skelcrew refs *)   Bash(skelcrew attention *)
Bash(git add *)     Bash(git commit *)
Bash(git push -u origin HEAD)   Bash(git push)
Bash(gh pr create *)  Bash(gh pr view *)  Bash(gh pr diff *)  Bash(gh pr comment *)
Bash(gh repo view *)
```

**A trailing wildcard is not a boundary; it is the command's entire flag surface.** `Bash(x *)`
grants every flag `x` has, present and future, including the ones that write files or run other
programs. Four review rounds found four escalations and every one was this: `gh pr *` reaching
`merge`, `git *` reaching `push` and `-c`, a bare `Write` reaching a ref file, and `git log *`
reaching `--output`. Before any entry is written as `x *`, its flag set must be enumerated and
the write-capable and exec-capable flags named. If they cannot be excluded — and a prefix pattern
cannot exclude a flag — the entry does not belong on the list in that form. Each surviving
wildcard entry below carries that check.

**The matching rule this list is written against.** `Bash(x *)` is wildcard matching: it matches
every command beginning with `x`, including options inserted after `x`. `Bash(x:*)` is the
legacy prefix form. An implementer must verify this against the harness actually in use rather
than taking it from this spec, because every rule below depends on it.

Why each group is shaped this way:

- **The CLI is allowed verb by verb, never `Bash(skelcrew *)`.** `mv`, `claim`, `release`,
  `archive` and `resolve` are absent deliberately: they would let the agent move its own card
  past the runner's artefact check, or answer its own question. They ask.
- **`git` is named verb by verb, with the wildcard after the subcommand.** `Bash(git *)` would
  pre-allow `git push origin HEAD:main` — landing work on the default branch with no gate — and,
  because a wildcard before the subcommand also matches inserted options, `git -c
  <anything> log`, which is arbitrary unprompted execution.
- **The read-only git verbs are not listed at all, and that is the safer choice.** `git status`,
  `git log`, `git diff`, `git show`, `git merge-base` and `git rev-parse` were on this list as
  wildcards until a review round proved `Bash(git log *)` an arbitrary-file-write primitive:
  `git log`, `git diff` and `git show` all accept `--output=<any absolute path>`, so
  `git log -1 --format=%H --output=<common>/refs/remotes/origin/main` forges the very ref the
  scan reads, and the same flag rewrites `.git/config` so the pre-allowed bare `git push` lands
  on the default branch. Both were reproduced end to end. A trailing wildcard cannot exclude a
  flag, so there was no narrower wildcard to write.
  What closes it is deleting the entries. This harness carries a per-subcommand **safe-flag
  allowlist** for exactly these six verbs and self-approves a call only when every flag is on it;
  `--output` is on none of them. An explicit `Bash(git log *)` rule *bypasses* that validator —
  listing the verb replaced a curated flag allowlist with "any flag at all". Unlisted, the safe
  forms still run unprompted through the harness's own check, and `--output` asks. An implementer
  must verify both halves of that against the harness in use, because the ergonomics of every
  playbook depend on the first and the boundary depends on the second.
- **`push` is allowed only in the exact form the playbook runs** and its bare follow-up, so any
  other refspec, and any force push, asks.
- **`gh pr` is named verb by verb.** `Bash(gh pr *)` would pre-allow `gh pr merge` and
  `gh pr close`. Merging is the owner's alone, and unlike a card move the daemon can neither
  detect nor undo it.

**What this list deliberately does not close**, stated so it is reviewed rather than discovered:

- `Bash(git commit *)` permits `--no-verify`, which skips the target repo's hooks. The playbooks
  forbid it; a prefix pattern cannot. Accepted, and recorded.
- **`git branch` is not on the list**, and the reasoning matters more than the entry. It was
  admitted on the grounds that `git branch -D` only touches "local branches inside a disposable
  worktree" — which is false. Branch refs live in `refs/heads/` and are **shared** by the main
  checkout and every linked worktree, so an agent renaming or repointing a branch changes the
  owner's repository, not its own scratch copy. No playbook runs `git branch`. A read-only use of
  it does **not** ask, though: `git branch`, `--show-current`, `-a`, `-r`, `-v` and `--list` are
  all on the harness's own read-only tier, which is ~24 git verbs wide and validates each call
  flag by flag. Every mutating form — `-D`, `-m`, `-f`, and `git branch <name> <base>` — fails
  that validator and does ask, which is the property this entry's absence needs. Not listing it
  is what leaves that validator in charge; listing it would replace it with "any flag at all".
- `Bash(git push)` under a repo-level `push.default = matching` can push more than the card's
  branch. Accepted, and recorded. It is only as narrow as the config that governs it:
  `remote.origin.push` outranks `push.default` and can turn a bare push into
  `+HEAD:refs/heads/main`. Both live in the git common directory, which the file rules below
  place out of reach; if that anchoring is ever removed, this entry stops being narrow.
- **Listed commands read files the run names.** `git commit -F <path>` and `-t <path>`,
  `git add --pathspec-from-file`, `gh pr create -F/-T/--recover`, `gh pr comment -F` and
  `skelcrew body --file` all take a path and read it. `git commit -F /etc/passwd` puts that file
  into a commit message unprompted, and a commit message travels outward through the pre-allowed
  push. This grants nothing the agent does not already have — `Read` is on the list unqualified,
  so it can read the same file and paste it — but the list should not be described as
  write-anchored without saying that reads were never anchored at all.
- **Two entries can act outside the card's own subject.** `-R/--repo` on the `gh` entries targets
  another repository, and `--as <member>` on the `skelcrew` entries speaks as another member.
  Neither writes a file nor runs a program, and a prefix pattern cannot exclude either. They are
  the same class as the carried limitation that a run can write to another card, and they are
  recorded here for the same reason.
- Nothing here sandboxes the agent. The list governs what runs **unprompted**; everything else
  remains available by asking. This is a gate, not a jail, and the spec should not be read as
  claiming otherwise. Constraining the file tools to the worktree, below, is part of the gate
  and not a sandbox: it decides which writes ask, and denies only the one path whose whole
  purpose is to redirect the others.

### The scan, and the rule that keeps it from widening

`allowlist.ts` reads `AGENTS.md` and `CLAUDE.md` at the target repository root and adds the
first line of each fenced block whose info string is empty or names a shell (`sh`, `bash`,
`shell`, `zsh`, `console`), stripping a leading `$ ` and trimming. A block in another language is
skipped whole. That is how `bun run check` becomes pre-allowed for this repository.

**The scan grants the command line it found, not its first word.** `bun run check` yields
`Bash(bun run check *)`, never `Bash(bun *)`. This is the same rule the fixed list follows and it
matters more here, not less: the entry is derived from a file **the target repository controls**,
so the widest form of it is the widest thing a repository can grant itself. `Bash(bun *)` would
match `bun -e '<any code>'` — arbitrary execution, unprompted — and the equivalent holds for
`node -e`, `python -c`, `npm`, and `make`. A first-word grant would make the one attacker-
influenced entry the loosest in the list, three paragraphs after the spec explains why
`Bash(git *)` is intolerable for exactly that reason.

**A scanned line is a literal command, never a pattern.** The harness compiles `*` in a rule to
`.*`, so any metacharacter surviving into the entry is a wildcard the repository chose. A line
containing an unescaped `*`, `?` or `[` anywhere therefore contributes nothing — or is escaped
before it becomes an entry. Checking only the line's first word is not enough: a fenced `bun *`
yields `Bash(bun * *)`, which matches `bun -e '<any code>'`, and `make *` yields
`Bash(make * *)`, which matches `make -f /tmp/evil.mk all`. Both run unprompted.

A scanned line must also look like a command: if its first word is not a plain command word
(letters, digits, `.`, `_`, `/`, `-`), the block contributes nothing.

**And a scanned line is one rule, never two.** Sanitising against the *pattern* compiler is not
enough, because the entry has a syntax of its own: entries are split on whitespace outside
parentheses, so a line carrying a `)` closes `Bash(` early and the rest of the line opens a
second rule whose closing `*)` this code supplies. A fenced

```
bun run) Bash(git
```

becomes the entry `Bash(bun run) Bash(git *)`, which the harness reads as `Bash(bun run)` **and**
`Bash(git *)` — the grant this spec refuses, obtained by a repository, with `git` placed in a
later word so a first-word check never sees it. `bun run) Bash(sh` yields `Bash(sh *)`: arbitrary
unprompted execution. The scan must therefore accept only a conservative character set for the
whole line, rejecting every character that carries meaning in rule syntax — parentheses first —
rather than blocklisting the ones an attack has already been written for. The invariant to assert
is the one that fails loudly whatever the character set misses: **each entry the scan produces
must parse as exactly one rule.**

**The scan reads the instruction files as of the run's base commit, not the working tree.**
An agent can write a fenced block into the repository's own `AGENTS.md` inside its worktree — a
single unprompted write, visible on the card only inside a batched tool summary — and thereby
pre-allow a command for every later run. That is a run widening its own successor's boundary,
which defeats the gate this spec exists to build. Reading the file from a base commit rather than
the working tree means only a change the owner has already merged can grant anything; a file that
is untracked, or modified relative to that commit, contributes nothing.

**That base must be a ref nothing on the fixed list can write.** A local branch name is not:
`refs/heads/` is shared by the main checkout and every worktree, so a run that can create or move
a branch can point the name its successor reads at a commit it authored itself — instruction file
included. Resolve the scan's base from something outside the agent's reach, such as the
remote-tracking default branch, and treat an absent or unreadable one as granting nothing. The
guarantee to hold is not "read a commit" but *the run cannot influence what its successor is
allowed to do*; an implementer should state which ref it chose and why the fixed list cannot
reach it.

**Choosing the ref is not enough on its own: the file tools have to be anchored too.** A ref is a
plain file inside the git common directory, and `git rev-parse --git-common-dir` — pre-allowed —
names that directory. While the file tools are on the list unqualified, a run can author a commit
and then write the sha straight into `refs/remotes/origin/<default branch>`, and its successor
reads instructions the run wrote. The same unqualified write reaches `.git/config`, where one
`remote.origin.push` line turns the pre-allowed bare `git push` into a push to the default
branch. No choice of ref survives that; the grant itself has to be narrowed.

So the file tools are anchored to the run's own worktree:

- **The entry is spelled `Edit`, and it is the only file-tool entry.** This harness checks file
  permissions against `Edit(path)` and `Read(path)` rules **only**. A path rule written for
  `Write`, `MultiEdit`, `NotebookEdit` or `Glob` is accepted, never consulted, and warned about at
  startup — it would read as a constraint and enforce nothing. One `Edit(...)` rule governs every
  built-in tool that edits files, so `Write` and `MultiEdit` come off the list rather than gaining
  path rules of their own.
- **The path is the run's worktree, absolute.** A leading `//` anchors a rule at the filesystem
  root. As an *allow* rule a `dir/**` pattern matches only at its anchor and not at any depth,
  which is what is wanted here. The git common directory is not under the worktree — a linked
  worktree's real git directory lives beside the main checkout — so this one anchor puts every
  ref, `packed-refs`, and every `config` out of reach in a single stroke.
- **The worktree's own `.git` is denied.** In a linked worktree `.git` is a file holding
  `gitdir: <common>/worktrees/<name>`, so it sits *inside* the anchor and rewriting it repoints
  the worktree at a git directory of the agent's choosing. It is denied explicitly; deny outranks
  allow.
- **Everything outside stays available by asking.** An unmatched path is not a refusal, it is a
  question to the owner — the same gate this spec builds for every other unlisted call. A run
  that genuinely needs to write outside its worktree says so on the card.

Two limits belong on the record rather than in a claim. Read and Edit deny rules also cover the
file commands the harness recognises in Bash and the targets of shell redirections, but they do
not cover a subprocess that opens files itself — **and the scan puts exactly such an entry on the
list**, deliberately. See *What a subprocess reaches*, below, which is the boundary of everything
claimed here. And a `Read` deny rule blocks Edit and Write on the same path while an `Edit`
deny rule does not block reading — reading a ref was never the problem, writing one was.

### What a subprocess reaches

Everything above governs **tool calls**. A subprocess is not a tool call, and the playbooks exist
to start one: the repository's own check command, which the scan pre-allows precisely so it need
not ask. `bun run check` dispatches through `package.json` and runs `bun test`, which executes any
test file the run wrote in its worktree — every one of those files inside the anchor, and so
written unprompted. Nothing in the permission layer sees what that process then does.

This is not a defect awaiting a patch. A coding agent's work is to write code and run it;
execution is the product, and a harness that could prevent it would be preventing the job. What
follows is that the allowlist is a narrower thing than it reads as, and this spec says so rather
than claiming otherwise:

- **The worktree anchor binds the file tools, not the machine.** A check subprocess writes
  anything the daemon's user can write, refs and `.git/config` included. Rule 8 makes those
  writes *ask when a tool makes them*; it does not make them impossible.
- **The verbs withheld from the CLI group are obtained anyway.** The subprocess inherits `PATH`
  with the shim and `SKELCREW_AS=runner`, so `skelcrew mv`, `claim`, `release`, `archive` and
  `resolve` are all reachable — the run can move its own card past the artefact check and answer
  its own permission question. Withholding them from the list is worth doing (it keeps the agent
  from taking those actions *as itself*, visibly, in the ordinary course) and it is not a
  boundary.
- **Criteria 10b and 10c are true of tool calls and false of subprocesses**, and are worded that
  way above for that reason.

The rules that must survive this belong in the daemon, not in a list: the daemon knows which
member is asking and which run holds the claim, and can refuse a gate-crossing move on its own
authority whatever called it. That is milestone 016, and it is the reason this is recorded here
rather than papered over. Out of scope for it and for this spec: OS-level sandboxing of the
subprocess, which is the only thing that would make the first bullet false.

**A scanned command may not widen a command the fixed list narrows.** `skelcrew`, `git` and `gh`
are narrowed above; a repo whose instructions show `git status` must not thereby produce
`Bash(git *)`. This is not hypothetical — it is a defect the spike shipped and had to fix, and
any repo documenting a git command triggers it. The check must read **every word** of the line,
not its first: a prefix word puts the narrowed verb in position two, where a first-word check
never looks, and `env git push origin HEAD:main`, `command gh pr merge 42` and
`env skelcrew resolve 1 -m allow` were each verified to run unprompted through that gap. Each is
an action the spec reserves to the owner.

### What a scan cannot be

Reading every word closes the gap above and does not make the scan a boundary, because nothing
can. A repository whose fenced block is the single word `sh` yields `Bash(sh *)`, which matches
`sh -c '<anything>'`. There is no narrowed verb to find and no character to reject: the line is a
plain command word, and running the command the repository documents is the whole point of the
scan.

This is the same fact as *What a subprocess reaches*, reached from the other side. A repository's
check command is arbitrary execution by construction — whether it arrives as `sh` in the entry or
as a test file the check command runs. So:

- The no-widening rule, and the *"cannot widen what the fixed list narrowed"* claim above, are
  true of the **fixed list** and of **good-faith documentation**, which is what they were written
  against: the defect they exist to catch is a repo that documents `git status` and accidentally
  re-grants `git`. Read that way they are worth having and are enforced.
- They are **not** true against an instruction file written to attack, and criteria 10b and 10c
  inherit the same limit: their "tool calls" qualifier bounds them against the fixed list, not
  against whatever a hostile repository pre-allows for itself.
- What follows is the same conclusion as before. The rules that must survive a repository the
  owner has not read belong in the daemon (milestone 016), and the pre-merge reading of a target
  repo's instruction files is the owner's, not the runner's. The scan reading only the **base
  commit** is what keeps that reading meaningful: what grants anything is what the owner merged.

`allowlist.ts` must say this where it currently claims the opposite.

## Acceptance criteria

1. `bun run check` passes. No test spawns a real coding agent or calls a model.
2. A tool outside the fixed list raises an attention request to the owner whose note names the
   tool and its input **in full** — an input longer than the activity summary's one-line cut
   reaches the owner uncut, up to the comment size limit — and contains both resolving commands. The run does not proceed until it is
   answered.
3. `skelcrew resolve <id> -m allow` lets the tool run; `yes` and `ok` do the same. `deny`, `no`,
   any other text, and a resolve with no text all deny, and the agent is told the owner's text as
   the reason.
4. Two tools requested before either is answered produce exactly one open request at a time on
   the card, and both are answered in the order they were asked.
5. While the agent's own `skelcrew attention` question is open, a permission request is not
   raised over it; it is raised once that question is resolved.
6. A claim whose run is waiting on an open request does not lapse: its expiry advances while the
   request is open.
7. A card moved, archived or released while a run waits on a request ends the run instead of
   continuing; the card is left as the move left it, and no answer is applied afterwards.
8. Every entry in the fixed list is matched by it, and each of these is **not**, each as its own
   case: `git push origin HEAD:main`, `git push --force`, `git -c core.pager=x log`,
   `gh pr merge 42 --squash`, `gh pr close 42`, `skelcrew mv 1 code`, `skelcrew release 1`,
   `skelcrew claim 1`, `skelcrew archive 1`, `skelcrew resolve 1 -m allow`.
9. A target repository whose `AGENTS.md` shows `bun run check` in a fenced block yields
   `Bash(bun run check *)` in addition to the fixed list — **not** `Bash(bun *)`, and a call to
   `bun -e '…'` therefore still asks. A repository with neither instruction file yields exactly
   the fixed list; a fenced block in another language, and one whose first word is not a plain
   command word, each contribute nothing.
10b. A run cannot widen its successor's allowlist by any sequence of pre-allowed **tool calls**
    — the qualifier is load-bearing; see *What a subprocess reaches*.
    Specifically: committing an instruction file and then creating, renaming or repointing a
    branch grants the next run nothing, and `git branch` is not pre-allowed at all; and no
    pre-allowed tool writes any file outside the run's own worktree — a write to a path under
    the git common directory (a ref, `packed-refs`, `config`) asks, as does a write to the
    worktree's own `.git`.
10d. No entry on the fixed list writes a file through a flag. Specifically:
    `git log --output=<path>`, `git diff --output=<path>` and `git show --output=<path>` are not
    pre-allowed for any path, inside the worktree or out; the six read-only git verbs are absent
    from the list; and each surviving wildcard entry has had its write-capable and exec-capable
    flags enumerated, with the finding recorded beside it.
10e. Removing those six verbs does not make the playbooks ask. A plain `git status`, `git log
    --oneline`, `git diff`, `git show <sha>`, `git merge-base` and `git rev-parse` each still run
    unprompted, through the harness's own read-only check rather than through this list.
10c. No pre-allowed sequence of **tool calls** lands a commit on the default branch.
    Specifically: rewriting `remote.origin.push` and then running the pre-allowed bare
    `git push` is not available, because the write to `.git/config` asks. A subprocess is not a
    tool call; see *What a subprocess reaches*.
10f. The record says what a subprocess reaches. `allowlist.ts` and the Code playbook both carry
    it, naming the `skelcrew` verbs it obtains, and no artefact in this spec claims a boundary
    a subprocess does not respect.
10h. The no-widening check reads every word of the scanned line. Specifically, fenced
    `env git push origin HEAD:main`, `command gh pr merge 42`, `nice git push` and
    `env skelcrew resolve 1 -m allow` each contribute nothing, and no artefact claims the scan
    is a boundary against an instruction file written to attack.
10g. A scanned line that would produce more than one rule contributes nothing. Specifically, a
    fenced ``bun run) Bash(git`` and a fenced ``bun run) Bash(sh`` each yield no entry, and every
    entry the scan produces parses as exactly one rule — asserted against the harness's own
    splitting, not against this repository's model of an entry.
10a. A fenced block whose line contains an unescaped `*`, `?` or `[` contributes nothing: a repo
    containing `bun *` does not pre-allow `bun -e '…'`. A fenced block written into the working
    tree during a run, or present only as an uncommitted change, contributes nothing to that run
    or to the next one — only the base commit's instruction files are read.
10. A target repository whose instructions show `git status`, `gh pr view` or a `skelcrew`
    command in a fenced block does **not** cause `Bash(git *)`, `Bash(gh *)` or
    `Bash(skelcrew *)` to appear in the resulting list.
11. The Code playbook's own commands all run without asking under this list, checked command by
    command against the playbook's text.

## Tests

- Permission flow end to end against the scripted driver: the request's exact note, each
  answering word, the deny reason reaching the agent, and the run continuing (2, 3).
- Two concurrent requests, asserting one open request at a time and both answered in order (4).
- A pre-existing agent question, asserting the permission request waits and then lands (5).
- Heartbeat during a wait, using an injected clock rather than real time (6).
- Move, archive and release during a wait, each as its own case (7).
- The fixed list asserted as a list **and** as matching behaviour, with every negative in
  criterion 8 as its own case. The matching helper used by tests is a model of the harness's
  rule, not the harness itself; the test must therefore also assert the list's literal contents,
  so that re-adding a wildcard entry fails even if the model is imperfect (8).
- The scan: both instruction files, an absent file, a non-shell block, a malformed fence, and
  the no-widening rule for each of the three narrowed commands (9, 10).

## Out of scope

- **Artefact contracts and run endings.** 014.
- **Sandboxing the agent** at the OS level, or any mechanism beyond the allowlist and the ask.
  Anchoring the file-tool entry to the worktree is inside that boundary, not outside it: it is
  one allowlist entry and one deny, and every path it does not cover asks rather than fails.
- **Scoping the runner's identity to its card.** A run can still write to another card; this is
  recorded as a carried limitation and is not addressed here.
- **Per-repository configurable allowlists**, remembering an answer across runs, or a policy for
  auto-allowing a repeated question. Every unlisted tool asks, every time, in this spec.
- **Changing what 012 established** about streaming, the transcript, the shim or driver
  selection.
