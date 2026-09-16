# 022 — A run explores without asking

The first evening of real use: three runs, five permission questions, every one of them a read
the agent could have done without asking. This spec is that finding. One of three from that
evening (022, 023, 024), each its own small change.

## Goal

A run should reach its artefact without stopping for reads. The harness pre-allows the agent's
own file tools — `Read`, `Glob`, `Grep` — and recognises a few shell reads flag by flag, and
everything else asks the owner. Last night's agents explored the repository with shell instead:
`cat package.json && ls packages && for p in ...`, `sed -n 1,60p ... | head -60`,
`cd /tmp && script -q /dev/null bun -e '...'`. Each stopped the run until a person typed
`resolve -m allow`. The playbooks never said which way to read, and a model given a shell uses
it. After this spec the playbooks say it, and when a question is unavoidable the card says why
the agent needs it, in the agent's own words, so the owner can answer without reading shell.
Nothing about what is pre-allowed changes; this spec grants nothing.

## Current behavior

- `packages/daemon/playbooks/spec.md` §1 tells the agent to "read the real files" and gives no
  way to do it. `code.md` and `review.md` list the tools that run unprompted (`Read`, `Glob`,
  `Grep` among them) and say a compound command "is only ever as allowed as its least-allowed
  part", but say that under §4's one required call, not as the way to read.
- `packages/daemon/src/runner/run.ts:474-490`, `questionFor`: the question the card gets is
  `allow <tool>? (skelcrew resolve <id> -m allow | ... deny)`, then `input:` and the quoted
  input. Nothing says what the command is for. The agent's preceding text turn, which usually
  says exactly that, is posted as a separate comment (`post(excerpt(event.text, logPath))`,
  `run.ts:704`) and is not kept.
- `packages/cli/src/render.ts:269`, `queueView`, renders the note line by line, so the owner sees
  the shell and the two commands that answer, and nothing else.
- Observed 2026-09-14 and 2026-09-15 on cards 1 and 2 of this repository: a Spec run asked
  twice (a `for` loop over `cat`; `sed` piped to `head`) and a second asked once (`script` with
  `bun -e`, to test raw terminal mode for a TUI). All were reads or harmless probes. The owner
  could not tell that from the card.

## Desired behavior

**A run reads with its tools.** Every playbook says, in its section on what runs without
asking: read files with `Read`, find them with `Glob`, search with `Grep`. Use the shell only
for what those cannot do — running the repository's checks, git, the CLI — and then one command
at a time, never joined with `&&`, `;` or a pipe, and never a loop, because a joined command is
only as allowed as its least-allowed part and a loop is never recognised. A run that follows
this finishes a Spec phase on this repository with no permission question.

**When a question is unavoidable, the card says why.** The playbooks say: before a shell
command that is not on the pre-allowed list, say in one sentence what it is for. The runner
keeps the agent's last text turn and, when a question is raised, puts that sentence on the card
as part of the question, on its own labelled line between the frame and the input, cut to one
line. So the queue reads:

```
#2 build a tui  [Spec]
runner → simon, 20:33
> allow Bash? (skelcrew resolve 2 -m allow | skelcrew resolve 2 -m deny)
> why: checking whether Bun can put the terminal into raw mode, which a TUI needs
> input:
> > cd /tmp && script -q /dev/null bun -e '...'
```

When no text turn preceded the ask in the same assistant turn, the `why:` line is absent rather
than empty.

**Nothing else moves.** What is pre-allowed is 013's list and 019's, unchanged. The harness
check still covers every command the playbooks instruct.

## Implementation approach

Playbooks: one paragraph in each of `spec.md`, `code.md` and `review.md`, in the place each
already describes what runs unprompted (`spec.md` has no such section and gets one, short, at
the top of §1). It names the three tools as the way to read, the shell as the way to run, one
command at a time, and the one-sentence reason before a command that will ask. Written in prose
with no fenced or backticked command, so `instructedCommands` harvests nothing new and
`check:harness`'s command count is unchanged (spec 6, code 25, review 12 today).

Runner: `run.ts` keeps the text of the last `text` event of the current assistant turn. **A turn
ends** when the last tool call the agent made in it has its result, when the owner answers this
run's question, or when a member's comment reaches the agent as a new message; the kept text is
cleared at each. A tool result that answers one of *several* calls the agent made in the same
turn does not end it: the agent routinely reads with a pre-allowed `Read` and asks for a shell
command in the same turn, and the `Read`'s result comes back before the shell command's
question is raised, so clearing on any result would lose the sentence in exactly the workflow
this spec asks for. (Review round 1 found the text surviving a turn boundary; round 2 found a
sibling's result ending the turn early; the orchestrator wrote this paragraph after round 2.
The first version said "reset when a `result` arrives or a new turn begins", which named the
boundary without defining it.) So a sentence from an earlier turn is not attached
to a later ask. `questionFor` takes it and, when present, adds `why: <text>` after the frame,
as one line: `oneLine`'d and cut to a small fixed budget (200 bytes, in the shape of
`INPUT_LINE_MAX`), inside the existing byte cap arithmetic so a long reason cannot push the input
past the cap. The `why:` line is the agent's text, so it is escaped the way every relayed text is
(`relayed`) and flattened to one line, for 015's reason: a line of it must not read as a line
the runner wrote, and a single line with no newline in it cannot become one. It is *not*
`quoted` the way the input is: the example above shows it with the CLI's one marker, and that is
the binding form. (The spec as approved said "the same `relayed`/`quoted` treatment the input
does", which contradicted the example; the orchestrator settled it on the example during
development.) `describeCall` and the `allowed`/`denied` comments are unchanged.

Decisions resolved from the repository: the reason comes from the agent's text turn rather than
from a new CLI verb, because the playbooks already have the agent narrate and 012 already posts
the turn; a new verb would be a second way to say the same thing. One line, because the queue is
a list and 010 made every note line marked for that reason.

## Acceptance criteria

1. `bun run check` passes; no test spawns a real coding agent or calls a model. `bun run
   check:harness` passes with the same number of commands under test as before this change,
   and `instructedCommands` for each playbook is unchanged in content.
2. Each of the three playbooks says, in one contiguous paragraph pinned by `playbooks.test.ts`:
   read with `Read`, find with `Glob`, search with `Grep`; shell one command at a time; never
   `&&`, `;`, a pipe or a loop; and say in one sentence what a command that will ask is for.
3. A scripted agent that emits a `text` event and then a tool call the list does not pre-allow
   produces a question on the card whose note has, in order: the `allow ... ?` frame line, a
   `why:` line carrying that text on one line, `input:`, and the quoted input. Asserted on the
   card's `attention.note` and on `skelcrew queue`'s output through the real CLI.
4. A scripted agent that emits the tool call with no preceding text in that turn produces the
   same note with no `why:` line. A text event in an earlier turn (before a `result`, or before a
   previous ask was answered) is not attached.
5. A `why` text longer than the budget is cut to one line within it and marked as cut; a `why`
   text containing newlines is rendered as one line; the whole note stays within
   `COMMENT_MAX_BYTES` with the input's existing truncation rule still applying.
6. 013's existing question tests pass unchanged except where they assert the exact note, which
   gain the `why:` line only when their scripts emit text first (say which, in the run record).

## Tests

- Criterion 2 in `playbooks.test.ts`, the way the other playbook rules are pinned.
- Criteria 3–5 in `run.test.ts` beside 013's question cases, with the scripted driver; one
  case through the real CLI's `queue` for the rendered form.
- Criterion 1's command-count claim in `playbooks.test.ts` (per-playbook `instructedCommands`
  equal to a recorded list) or by the harness check's own output, recorded.

## Out of scope

- **Widening what is pre-allowed.** No entry is added for `sed`, `cat`, loops or `script`. 013's
  reasoning stands; the fix is to use the tools that exist.
- **A `skelcrew ask` verb** for the agent to state a reason explicitly. The text turn already
  carries it.
- **Auto-allowing questions whose reason the owner has accepted before.** A later finding if the
  same question recurs.
- **The notification and the board's wording** — 023 and 024.
