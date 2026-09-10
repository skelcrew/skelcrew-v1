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
`runner.ts`, `packages/daemon/playbooks/code.md`, this file.

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
