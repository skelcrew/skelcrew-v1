# kanbot

A kanban board where humans and AI agents are teammates. Cards move through lanes. Agents
join the board as members over MCP. A small daemon on the user's own machine runs coding
agents in git worktrees and streams what they do back to the board.

**The board holds no code and calls no models. It coordinates.**

## The workflow is the product

This repository is built with the workflow kanbot generalizes: rough ideas become approved
specs (`/spec`), specs become gated pipeline runs that stop at a PR for a human (`/develop`),
and findings carry forward through `docs/MILESTONES.md`. Kanbot is that same movement — from
prompting to spec'ing — made live and multiplayer. When designing any part of the board, the
file workflow is the reference implementation:

- A card handed to an agent is a **spec, not a prompt** — the board should push work toward
  goal, acceptance criteria, and out-of-scope, structurally, not by convention.
- Lanes are **stage gates**, like `/develop`'s stages. Some transitions belong only to human
  members — "done" is a human's call, the way merging is.
- A card's activity feed is the **run record**, the live form of `docs/plans/`.
- The backlog is **milestones with findings carried forward**, not a wishlist.

When a design choice on the board has an analogue in this repo's own workflow, the analogue
is evidence for how it should work — and where the analogue is painful in practice, that pain
is a product insight worth recording here.

## Hard constraints

These are correctness requirements, not preferences. A change that violates one is wrong.

- **The board never stores repository contents.** Cards carry references — branch names,
  commit shas, PR URLs, file paths, log excerpts an agent chose to post — never a checkout.
  Code lives in the user's repositories and in the daemon's worktrees.
- **The board never calls a model.** No LLM API keys, clients, or SDKs anywhere in the board.
  All intelligence enters through members: humans in the browser, agents over MCP. The daemon
  spawns coding agents as subprocesses; it does not call model APIs itself either.
- **Agents are members, not plugins.** An agent joining over MCP uses the same primitives a
  human does — see the board, take cards, move them, comment. If a capability is worth
  building, both kinds of member get it. No agent-only side channels.
- **Single-player first.** Built for one person: one human member — the owner — plus their
  agents. Localhost server, SQLite file. No auth, accounts, multi-human features, or
  multi-tenancy unless a milestone explicitly introduces them. When a design choice trades
  solo ergonomics against hypothetical team needs, solo wins — teams come later, informed by
  what actually worked for one.
- **Everything observable.** What an agent does to the board must be visible on the board —
  card moves, comments, streamed activity. Silent mutations are defects.

## Positioning

Kanbot is additive, never a required replacement. The owner's existing setup (terminal +
Claude Code sessions) remains the tool for synchronous, attended, exploratory work; kanbot
owns the asynchronous tier — deferrable, well-defined work that agents advance unattended
while finished results queue for the owner's judgment. Three consequences bind design:
adding a card must cost less than opening a terminal tab (CLI, and cards filed from live
Claude Code sessions over MCP); every piece of kanbot work must have an exit ramp into the
terminal (it's all plain branches and worktrees — escalations say where to `cd`); and the
measure of success is net-new throughput in Done — work that wouldn't otherwise have
existed — not work relocated from the terminal with extra ceremony.

## Settled architecture

Decisions already made; specs build on these rather than reopening them.

- **Kanbot ships the workflow; the board doesn't interpret it.** The stage playbooks — how
  spec'ing, developing, and reviewing work — are part of the product, owned by the daemon
  and injected into the coding agent at spawn time. They are never committed to the target
  repository; the repo shows only what the agent legitimately produced (specs, plans, code).
  The repo contributes project knowledge — conventions, check commands, constraints — through
  its `AGENTS.md`/`CLAUDE.md`, which every playbook reads first. Lanes map to stages; the
  board holds no workflow logic and stays a coordinator. The daemon is a thin loop — watch,
  claim, worktree, run playbook, stream, hand off.
- **The card is the spec while it is drafted.** A spec'ing run writes its result to the card;
  the owner reviews and comments on the board. The spec is committed to `docs/specs/` when
  development begins. The board is the review surface for specs; GitHub for code.
- **Attention requests are first-class.** An agent finishing a stage hands the card to a
  member ("waiting on owner: approve spec"), recorded in the activity log. The UI's home
  screen is this queue — in this workflow the human is the bottleneck by design, so what
  needs the owner's attention is the most important thing the board can show.
- **Approval gates are human-only lane transitions** (e.g. Spec review → Ready,
  PR review → Done). Feedback is a comment plus a move back a lane, which re-dispatches the
  card with its history intact — revision loops need no extra machinery.
- **Claims are leases.** Claiming a card is atomic and heartbeat-renewed; a dead daemon's
  card returns to its lane instead of sticking in "claimed".

## Stack

TypeScript throughout, npm workspaces. Node for the board server, MCP server, and daemon; the
web UI's framework is settled by its spec. SQLite for persistence.

## Definition of done

```
npm run check
```

which runs lint, format check, typecheck (`tsc --noEmit`), and tests. Until the scaffold spec
lands and `package.json` exists, these checks are **not configured** — record them as such
rather than inventing substitutes.

- Tests assert observable behavior — what a member sees on the board — not private helpers.
- Tests never spawn real coding agents or call external services; the daemon's agent-running
  boundary is faked in tests.
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

The skills and agents under `.claude/` are how kanbot is built — and the reference
implementation for the daemon's built-in stage playbooks, which get extracted from them when
the daemon learns to run stages. Improvements discovered while building here should flow into
the playbooks, and vice versa.

## Repository layout

- `docs/specs/` — one spec per unit of work, numbered, durable
- `docs/plans/` — run records written by `/develop`, one per spec
- `docs/MILESTONES.md` — planned sequence
- `packages/` — npm workspaces (created by the scaffold spec)
