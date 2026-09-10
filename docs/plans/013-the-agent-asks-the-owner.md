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
