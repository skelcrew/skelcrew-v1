# skelcrew

A harness centred on tasks and phases rather than chat. You define your ideas as cards; a
crew of agents builds them through structured phases; you hold the gates. Cards are the unit
of work, agent runs are disposable workers, and every phase ends in an artefact — not in a
conversation. A headless daemon on the user's own machine holds the state, runs the crew in
git worktrees, and serves thin clients over one socket.

**The daemon coordinates and spawns. It never calls a model.**

## The workflow is the product

This repository is built with the workflow skelcrew generalizes: rough ideas become approved
specs (`/spec`), specs become gated pipeline runs that stop at a PR for a human (`/develop`),
and findings carry forward through `docs/MILESTONES.md`. Skelcrew is that same movement —
from prompting to spec'ing — made live and unattended. When designing any part of skelcrew,
the file workflow is the reference implementation:

- A card handed to an agent is a **spec, not a prompt** — the harness pushes work toward
  goal, acceptance criteria, and out-of-scope, structurally, not by convention.
- Phases are **stage gates with artefact contracts**, like `/develop`'s stages. A phase is
  complete when its artefact exists (a spec on the card, a branch with commits and a PR, a
  review verdict) — never merely because an agent said so. Some transitions belong only to
  the human owner: "done" is a human's call, the way merging is.
- A card's activity feed is the **run record**, the live form of `docs/plans/`.
- The backlog is **milestones with findings carried forward**, not a wishlist.

When a design choice has an analogue in this repo's own workflow, the analogue is evidence
for how it should work — and where the analogue is painful in practice, that pain is a
product insight worth recording here.

## Hard constraints

These are correctness requirements, not preferences. A change that violates one is wrong.

- **Skelcrew never stores repository contents.** Cards carry references — branch names,
  commit shas, PR URLs, file paths, log excerpts an agent chose to post — never a checkout.
  Code lives in the user's repositories and in the runner's worktrees.
- **The card is the source of truth; anything written into a repository is an export of it.**
  The spec is the card's body, in the daemon's SQLite. A spec file committed into a target
  repo, a pull request description, a rendered summary — each is a copy pushed outward for
  readers who cannot reach the database, and none of them is ever read back as authority. A
  run reads the card, refreshes whatever copies exist, and never reconciles one against
  another. Nothing skelcrew does may require an export to exist: a repository that publishes
  nothing must still be able to finish every phase.
- **Skelcrew never calls a model.** No LLM API keys, clients, or SDKs anywhere. All
  intelligence enters through members: the human over the CLI, agents over the same CLI as
  agent members, and the coding agents the runner spawns as subprocesses. Model auth is strictly between the user
  and their harness — skelcrew holds no credentials.
- **Cards drive the runner, not the other way round.** Work exists because a card entered a
  claimable phase; nothing runs that a card didn't ask for, and a run's only outputs are
  updates to its card and artefacts in the target repo.
- **Agents are members, not plugins.** An agent uses the same CLI and the same primitives a
  human does — see the cards, take one, advance it, comment — identified as an agent member.
  There is no agent-only surface (an MCP server was planned as 005 and dropped for this
  reason). If a capability is worth building, both kinds of member get it. No agent-to-agent
  channels at all: coordination happens on the card or it doesn't happen.
- **Conversation is never load-bearing.** No phase requires chat to advance. Talking is
  allowed — comments on a card are how feedback and mid-run answers travel — but every
  conversation has a card, and the pipeline moves on artefacts and gates alone.
- **Single-player first.** Built for one person: one human owner plus their crew. Local
  daemon, SQLite file, localhost-only surfaces. No auth, accounts, multi-human features, or
  multi-tenancy unless a milestone explicitly introduces them. When a design choice trades
  solo ergonomics against hypothetical team needs, solo wins.
- **Everything observable.** What an agent does must be visible on its card — claims, phase
  moves, comments, streamed activity. Silent mutations are defects.

## Positioning

Skelcrew is additive, never a required replacement. The owner's existing setup (terminal +
Claude Code sessions) remains the tool for synchronous, attended, exploratory work; skelcrew
owns the asynchronous tier — deferrable, well-defined work that the crew advances unattended
while finished results queue for the owner's judgment. Three consequences bind design:
adding a card must cost less than opening a terminal tab (one CLI, usable by the owner and
by an agent in a live session alike); every piece of skelcrew work must have an exit ramp into the terminal
(it's all plain branches and worktrees — escalations say where to `cd`); and the measure of
success is net-new throughput through the final gate — work that wouldn't otherwise have
existed — not work relocated from the terminal with extra ceremony.

Landscape: chat-first agents (OpenClaw, Hermes) make conversation load-bearing; parallel-run
orchestrators (Conductor, Superset) multiplex sessions; peer boards (Baton) share a surface
but not a pipeline; coordination layers (Korey, from the Shortcut team) sit over a team's
tracker and chat, chat-driven, and stop short of running the work; simulated orgs (Gas Town)
give a single human a staffed town — worker agents with durable identity, mail between them,
patrol agents watching their health, an AI coordinator that decomposes the work, and a
bors-style merge queue that lands it; orchestrator IDEs (Orca) put worktrees, diffs, terminals
and a task graph in one desktop window and hand dispatch to a coordinator agent; agent runtimes
(herdr, and tmux before it) own the terminals agents run in and model no work at all. The gap
skelcrew fills is the phase-driven, headless, no-chat harness.

Gas Town is the closest neighbour and the sharpest contrast, because it shares the plumbing —
one human, many agents, git worktrees for isolation, a durable structured work item instead of
a chat thread, and the same split of durable identity from disposable sessions — while
answering the design questions the other way on every constraint above: agents mail each other
and query their predecessors' sessions for context, a coordinator agent holds the plan, and the
merge queue merges. It organises around dispatch and liveness, keeping twenty or thirty agents
fed and recovering; skelcrew organises around artefact contracts and gates, where work advances
only by producing something verifiable and passing a human. Its concept count is the price of
that scale, and taking any of it piecemeal means taking that trade — the one part with no
counterpart here is a watcher for a run that is alive but stuck, which lease expiry does not
catch.

Orca is the closest shipped neighbour, and reading it is the cheapest available test of these
constraints, because it reaches nearly this shape by another route — Run → Task → Dispatch in
SQLite, an attempt carrying a spec with acceptance criteria, finished work checked against git
rather than believed, a worktree per attempt, agents driving all of it through the same CLI a
human uses — and then seats an agent where skelcrew seats the owner. A coordinator agent
decomposes the work, dispatches the workers, answers their questions and resolves the decision
gates; the gates table has no human column and no UI to answer one, and the human arrives at
review. The price of that seat is legible: roughly 24k lines of orchestration over a schema
rebuilt forty times, nearly all of it spent making a plan that lives in a context window survive
that context dying or being wrong — typed mail between workers, mailbox fencing, idempotent
mutations, federation to remote hosts. Rows need none of that, so the bill does not transfer;
the lessons that do are recorded in `docs/MILESTONES.md` against the specs they affect.

herdr sits underneath all of it rather than beside it — a terminal runtime that keeps agents'
panes alive across detach, restart and remote machines, with no work item anywhere in its API —
and is additive to skelcrew in the way the positioning above requires, not a competitor. It is
also one of three different answers to the alive-but-stuck gap, and the three do not agree.
Herdr reads the screen, classifying every pane working, blocked, idle or done from regex
manifests, because it does not own the spawn. Orca refuses that explicitly — status comes from
hooks installed into each agent CLI and normalised per vendor, "never inferred from terminal
titles" — and keeps process liveness separate from agent liveness, because a live terminal can
hold a dead agent. Skelcrew owns the spawn *and* the SDK stream, so it starts where orca ended
up; what neither reporting path covers is the harness blocking underneath the agent, which is
013's ground.

The field is crowded to the point of commodity. A community index of agent orchestrators now
lists on the order of four hundred projects, and every primitive here — a worktree per task, a
board over agents, claims, gates, artefact checks, a phone client — has been built several times
over. Four neighbours are worth tracking by name (scanned 2026-09-10). **Fusion** (MIT; daemon,
web UI and CLI) is the closest to this thesis: a worktree per task and an explicit plan → review
→ execute → review cycle with human approval required to merge — though a planner agent writes
the spec, state is Postgres across multiple nodes, and a Mission → Milestone → Slice → Feature →
Task hierarchy sits on top. **kandev** is closest on phases specifically: a board whose
multi-step workflows put a different agent on each step behind human gates, self-hosted, any
provider. **Cline** now ships a kanban board, a worktree per card, dependency chains that
auto-start a successor, approval hooks on tool calls and line comments that go back to the
agent — as a feature of the agent itself, free. And the work-item end is being absorbed by the
trackers: Linear's coding sessions (June 2026) delegate an issue to Claude Code or Codex in a
managed sandbox and draft the PR back onto the issue, and GitHub's Agent HQ mission control
assigns, steers and tracks a fleet across repos from web, editor, mobile and CLI.

Two things follow, and both sharpen the constraints above rather than softening them. The
surface is worth nothing on its own: assume a board, worktrees, parallel runs, a diff view and a
mobile client are available free from four directions, one of which is the agent vendor. What
the scan did not find anyone claiming as their headline is the whole of the differentiation — a
phase that ends in an artefact the *runner* verifies rather than a human pressing approve, no
coordinator agent anywhere, the daemon as the product with every client thin, and no chat. And
the business shape of this category is demonstrably hostile: Vibe Kanban reached roughly 26k
stars and thousands of daily users, and the company behind it shut down in April 2026 for want
of a model worth pursuing, leaving the project community-run and its cloud half switched off a
month later. Single-player first is therefore also a hedge — a tool worth building for one owner
does not need that answer.

## Settled architecture

Decisions already made; specs build on these rather than reopening them.

- **One headless daemon, thin clients.** The daemon is the product: it holds state (SQLite),
  serves members — the owner's clients and agents alike — and runs the crew. Clients (CLI
  first, TUI later, GUI maybe) speak one JSON-RPC socket protocol and hold no state, so the
  same daemon runs on a laptop or an always-on machine and is watched from anywhere. Cards
  render as rows with a phase track, not kanban columns.
- **One binary, two halves.** Inside the daemon, coordination (cards, phases, claims,
  activity, attention) and execution (worktrees, spawned agents) stay behind an internal
  protocol seam: the runner consumes claims/leases/playbooks the same way a remote runner
  someday would. The seam is what keeps future tiers — second machines, hosted runners —
  additions rather than rewrites.
- **Skelcrew ships the playbooks; the state doesn't interpret them.** How spec'ing,
  developing, and reviewing work is product, owned by the daemon and injected into the
  coding agent at spawn time — never committed to the target repository. The target repo
  contributes project knowledge (conventions, check commands, constraints) through its own
  `AGENTS.md`/`CLAUDE.md`, which every playbook reads first.
- **Runs are disposable; identity is durable.** Crew members exist as named members with
  history and attributable actions; each run is a fresh subprocess in a fresh worktree that
  streams to the card and exits. A phase handoff is a context boundary — the reviewer never
  inherits the implementer's context.
- **Phases end in artefact contracts, enforced by the runner.** The runner verifies the
  artefact exists before handing off — a develop finish with no commits is a failed run and
  an attention request, never a handoff. A dirty worktree is salvaged, never force-removed.
- **Five phases: Idea, Spec, Code, PR, Done.** The repo's own workflow, made
  live: a milestones entry, `/spec`, `/develop`, the PR, the merge. Review cycles happen
  inside a phase and show as activity, never as phases of their own. Whether a card is
  queued, running, or waiting on the owner is a status within its phase, derived from claims
  and attention requests.
- **Approval gates are human-only transitions.** Approval moves a card into the next phase
  as queued; the runner claims it and the card shows as running, so position and status
  always reflect true state. Feedback is a comment plus a move back a phase, which
  re-dispatches with history intact — revision loops need no machinery.
- **Attention requests are first-class and carry their actions.** An agent finishing or
  blocking hands the card to a member with the resolving choices attached ("approve spec" /
  "send back with feedback"). The owner's home view is this queue — the human is the
  bottleneck by design, so what's waiting on them is the most important thing to show.
- **Claims are leases.** Atomic, heartbeat-renewed; an expired lease returns the card to
  its queue visibly, as a first-class "run interrupted" event. Sleep, crash, and kill all
  collapse into that one path.

## Stack

TypeScript on Bun throughout; Bun workspaces. SQLite (via Bun's built-in driver) for
persistence. Chosen because it's the owner's home stack — reviewability matters more than
usual when agents write most of the code.

## Definition of done

```
bun run check
```

which runs, in order: Biome's lint and format check (`bun run lint`, i.e. `biome ci .`),
`tsc` per package (`bun run typecheck`), and `bun test` (`bun run test`). `check` never
writes files; `bun run fix` applies Biome's formatting and safe fixes.

- Red, then green. Write the failing test first, run it, and confirm it fails for the
  intended reason — an import error or fixture error is a broken test, not red. Then write
  the smallest implementation that passes, and refactor with the test still green. Never
  write the implementation first and backfill a test: a test written against existing code
  asserts what the code does, not what it should do.
- Tests assert observable behavior — what a member sees on the cards — not private helpers.
- Tests never spawn real coding agents or call external services; the runner's
  agent-spawning boundary is faked in tests.
- Never weaken a test, fixture, or assertion to get green.

## Workflow

Work is specified before it is implemented:

1. `/spec <idea or milestone number>` writes `docs/specs/<NNN>-<name>.md` (structure:
   `docs/specs/README.md`).
2. A human approves the spec.
3. `/develop <NNN>` implements it in an isolated worktree — implementer, independent review,
   independent verification — and stops at a pull request. The human merges.

`docs/MILESTONES.md` holds the planned sequence and the findings carried between specs. It is
provisional ahead of the current milestone; treat later entries as intent, not commitment.

The skills and agents under `.claude/` are how skelcrew is built — and the reference
implementation for the daemon's built-in phase playbooks, which get extracted from them when
the runner learns to run phases. Improvements discovered while building here should flow into
the playbooks, and vice versa.

The `prototype` branch preserves the 2026-09-07 spike that built the previous architecture
(separate board server + web UI + daemon) end to end and ran real stages. Its findings live
in `docs/MILESTONES.md`; its code is reference material, not a base to build on.

## Repository layout

- `docs/specs/` — one spec per unit of work, numbered, durable
- `docs/plans/` — run records written by `/develop`, one per spec
- `docs/MILESTONES.md` — the planned sequence, and nothing else: each entry carries the
  findings that shape it and points at the evidence
- `docs/research/` — what other harnesses do, one file per subject; evidence, never a plan
- `docs/prototype-findings.md` — the 2026-09-07 spike's record, in its own vocabulary
- `docs/prototype-vs-specs.md` — the same idea built twice, vibe-coded and specced, measured
- `docs/workflow-findings.md` — what building here teaches about `/spec` and `/develop`
- `packages/` — Bun workspaces (created by the scaffold spec)
