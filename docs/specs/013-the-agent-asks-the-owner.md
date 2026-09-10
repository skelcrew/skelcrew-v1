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

**The repository cannot widen what the fixed list narrowed.** A target repo whose instructions
show a `git status` line must not thereby re-grant `git` as a whole.

## Implementation approach

### Asking

`run.ts`'s `canUseTool` raises an attention request to the owner instead of denying, and waits
for its resolution. The note names the tool and its input and carries the resolving commands, in
the shape the CLI already renders for a request's suggested resolutions:

```
allow Bash rm -rf build ls? (skelcrew resolve 1 -m allow | skelcrew resolve 1 -m deny)
```

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
Read, Glob, Grep, Edit, Write, MultiEdit, Agent, TodoWrite
Bash(skelcrew show *)   Bash(skelcrew comment *)   Bash(skelcrew body *)
Bash(skelcrew refs *)   Bash(skelcrew attention *)
Bash(git status *)  Bash(git log *)     Bash(git diff *)    Bash(git show *)
Bash(git merge-base *)  Bash(git rev-parse *)  Bash(git branch *)
Bash(git add *)     Bash(git commit *)
Bash(git push -u origin HEAD)   Bash(git push)
Bash(gh pr create *)  Bash(gh pr view *)  Bash(gh pr diff *)  Bash(gh pr comment *)
Bash(gh repo view *)
```

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
- **`push` is allowed only in the exact form the playbook runs** and its bare follow-up, so any
  other refspec, and any force push, asks.
- **`gh pr` is named verb by verb.** `Bash(gh pr *)` would pre-allow `gh pr merge` and
  `gh pr close`. Merging is the owner's alone, and unlike a card move the daemon can neither
  detect nor undo it.

**What this list deliberately does not close**, stated so it is reviewed rather than discovered:

- `Bash(git commit *)` permits `--no-verify`, which skips the target repo's hooks. The playbooks
  forbid it; a prefix pattern cannot. Accepted, and recorded.
- `Bash(git branch *)` permits `git branch -D` on local branches inside a disposable worktree.
  Accepted as recoverable.
- `Bash(git push)` under a repo-level `push.default = matching` can push more than the card's
  branch. Accepted, and recorded.
- Nothing here sandboxes the agent. The list governs what runs **unprompted**; everything else
  remains available by asking. This is a gate, not a jail, and the spec should not be read as
  claiming otherwise.

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

**The scan reads the instruction files as of the run's base commit, not the working tree.**
`Write` and `Edit` are on the fixed list and are not path-constrained, so an agent can write a
fenced block into the repository's own `AGENTS.md` — a single unprompted `Write`, visible on the
card only inside a batched tool summary — and thereby pre-allow a command for every later run.
That is a run widening its own successor's boundary, which defeats the gate this spec exists to
build. Reading the file from the base commit (`git show <base>:AGENTS.md`) means only a change
the owner has already merged can grant anything; a file that is untracked, or modified relative
to the base, contributes nothing.

**A scanned command may not widen a command the fixed list narrows.** `skelcrew`, `git` and `gh`
are narrowed above; a repo whose instructions show `git status` must not thereby produce
`Bash(git *)`. This is not hypothetical — it is a defect the spike shipped and had to fix, and
any repo documenting a git command triggers it.

## Acceptance criteria

1. `bun run check` passes. No test spawns a real coding agent or calls a model.
2. A tool outside the fixed list raises an attention request to the owner whose note names the
   tool and its input and contains both resolving commands. The run does not proceed until it is
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
- **Sandboxing the agent**, restricting its filesystem access, or any mechanism beyond the
  allowlist and the ask.
- **Scoping the runner's identity to its card.** A run can still write to another card; this is
  recorded as a carried limitation and is not addressed here.
- **Per-repository configurable allowlists**, remembering an answer across runs, or a policy for
  auto-allowing a repeated question. Every unlisted tool asks, every time, in this spec.
- **Changing what 012 established** about streaming, the transcript, the shim or driver
  selection.
