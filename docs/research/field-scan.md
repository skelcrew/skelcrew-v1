# The field, scanned 2026-09-10

A community index of agent orchestrators lists on the order of four hundred projects. Every
primitive skelcrew uses — a worktree per task, a board over agents, claims, gates, artefact
checks, a phone client — has been built several times over. The landscape paragraph in
`AGENTS.md` carries the positioning; this file carries the findings that shape specs.

Four neighbours are worth tracking by name. **Fusion** (MIT; daemon, web UI and CLI) is closest
to skelcrew's thesis — a worktree per task and an explicit plan → review → execute → review
cycle with human approval required to merge — though a planner agent writes the spec, state is
Postgres across multiple nodes, and a Mission → Milestone → Slice → Feature → Task hierarchy
sits on top. **kandev** is closest on phases: a board whose multi-step workflows put a different
agent on each step behind human gates, self-hosted, any provider. **Cline** ships a kanban
board, a worktree per card, dependency chains that auto-start a successor, approval hooks on
tool calls and line comments that go back to the agent — free, inside the agent itself. And the
work-item end is being absorbed by the trackers: Linear's coding sessions (June 2026) delegate
an issue to Claude Code or Codex in a managed sandbox and draft the PR back onto the issue, and
GitHub's Agent HQ mission control assigns, steers and tracks a fleet across repos from web,
editor, mobile and CLI.

The category's business shape is demonstrably hostile: Vibe Kanban reached roughly 26k stars and
thousands of daily users, and the company behind it shut down in April 2026 for want of a model
worth pursuing, leaving the project community-run and its cloud half switched off a month later.

<!-- Findings carried into the specs they affect live in `docs/MILESTONES.md`, which points
back here. This file is the evidence; the entry is the decision. -->

## Findings

- **The artefact contract is the differentiation, not a hygiene detail (014).** A scan of the
  field (2026-09-10, recorded in AGENTS.md) found roughly four hundred orchestrators and no one
  claiming what 014 specifies: every neighbour's gate is a human pressing approve, and the
  quality gates that exist are checks run *for* the human rather than a condition the runner
  refuses to hand off without. "Zero commits past the base is a failed run, not a handoff" is
  the one sentence nobody else is saying. That raises 014's stakes: relaxing it into "post the
  attention request and let the owner judge" would leave a board over agents, which Cline gives
  away and four hundred projects already ship.
- **Don't grow a planner agent or a hierarchy (008, and Later).** The two closest neighbours
  each added exactly the two things this repo has refused — Fusion a planner agent that writes
  the spec plus a Mission → Milestone → Slice → Feature → Task tree, orca a coordinator agent
  that dispatches and resolves gates — and each paid for it in concept count and recovery
  machinery. When 008 makes skelcrew build skelcrew and a card wants to dispatch other cards,
  that is this exact fork, and the answer already given (grouping deferred until 008 shows what
  it must add) is the one the evidence supports.
