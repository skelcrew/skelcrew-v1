# Milestones

The planned sequence of specs. Entries ahead of the current milestone are provisional —
`/spec <NNN>` turns one into a real specification, and what a spec's implementation teaches
gets recorded here against the milestones it affects. Never renumber; if the plan changes,
rewrite the entry, not the number.

Status: nothing implemented yet through the spec workflow. An uncommitted prototype spike
(2026-09-07) built the whole loop end to end — board, web UI, MCP endpoint, daemon — and ran
a real spec stage and develop stage against a toy repo. Findings, which the numbered specs
must absorb:

- **Talk-to-the-agent is the core gap (007).** The spike spawns fire-and-forget `claude -p`;
  when the sandbox blocked `npm run check`, the agent asked for approval *on the card* and
  nobody could answer — it committed without running checks. 007 must drive the Agent SDK
  instead: `canUseTool` becomes an attention request with Approve/Deny that resumes the run,
  and streaming input lets card comments reach the running agent mid-run. Also: playbooks
  know the repo's check commands from `AGENTS.md`, so the daemon should pre-allow them.
- **The daemon must verify before handing off (007).** Twice the spike's develop stage
  ended with the agent blocked from committing — and the daemon still posted "branch ready
  for review" on a branch with zero commits, then force-removed the worktree, destroying the
  uncommitted implementation. A develop finish must confirm `git log base..branch` is
  non-empty and the worktree clean; anything else is a failed run → attention request with
  the reason. Never force-remove a dirty worktree — salvage (leave it and say where, or
  WIP-commit) instead. This is the verifier's "never claim a stage happened when it did not",
  mechanized.
- **Permission allowlists don't reach the sandbox (007).** Target-repo `permissions.allow`
  rules did not unblock the spawned agent's `npm run check`/`git commit` — the bash sandbox
  asks for out-of-sandbox approval that allow rules don't cover, and `-p` mode has no one to
  ask. Reinforces the Agent SDK/`canUseTool` design; until then, spike runs need
  `--permission-mode bypassPermissions` inside the isolated worktree.
- **Stage lanes should be claim-sources, not work-sites (008).** In the spike the human
  drags a card *into* Developing to dispatch it. Better: approval ends the human gesture
  (card → Ready), the daemon claims from Ready and itself moves the card into Developing
  when work starts — lane position then always reflects true state (queued vs in flight).
- **Attention requests should carry their actions (004).** "Waiting on you: spec ready for
  review" should offer Approve → next lane / Send back with feedback, not rely on the human
  knowing which drag resolves it.
- **The card spec view is a primary review surface (004).** Card-is-the-spec validated in
  practice — reviewing on the board beat a docs PR — but it needs rendered markdown and
  room, not a `<pre>`.
- **Self-review happens when one member serves all stages (008).** With two daemons live,
  the member that developed a branch claimed its review — fresh context, but not fresh
  identity. Daemons should deprioritize reviewing branches they produced (readable from the
  card's activity), so cross-review emerges whenever a peer exists, falling back to
  self-review-with-fresh-context only when alone.
- **Parallel branches fork stale (008) — design settled with the owner.** Two daemons
  developing overlapping cards each branch from the same base; a merge leaves the sibling
  branches conflicted. No "Conflicts" lane: a conflict is a regression to an earlier stage,
  not a stage. When the default branch moves, the daemon dry-run-merges each PR-review
  card's branch (`git merge-tree`, or `gh pr view --json mergeable`); a conflicted card
  auto-bounces to Developing with a rebase brief, continues its branch, and re-passes Agent
  review (conflict resolution deserves independent eyes) before the PR updates. The owner is
  informed via card activity, and only *asked* when the agent cannot resolve it. Later, the
  same trigger covers clean-but-stale branches whose tests fail against the merged base.
- **The fork base is nondeterministic (006/007).** `git worktree add -b` branches from the
  main checkout's current HEAD — so where the owner happens to be parked determines what a
  new branch contains. The daemon should branch from an explicit base (the repo's default
  branch) instead.
- **Cards need deletion/archiving (002).** A mis-pasted card currently lives forever; the
  spike has no way to remove a card at all.
- Working as designed and worth keeping: lease claims + sweeper, human-only gates enforced
  in core (403 over both HTTP and MCP), spec-stage worktree/branch cleanup, throttled 🛠
  activity streaming — and two daemons sharing one board coordinated by claims alone, no
  collisions.

## 001 — Project scaffold

npm-workspaces monorepo: `packages/board` (server + MCP surface later), `packages/web` (UI),
`packages/daemon`, `packages/shared` (types shared across them). TypeScript strict,
`npm run check` wired to lint, format check, `tsc --noEmit`, and vitest — this is the
definition of done every later spec is verified against, so it must be real and green (with
zero tests) before anything else lands. No product code beyond what proves the wiring.

## 002 — Board core

The domain model and persistence, no network: boards, lanes, cards, members (the one human
owner plus agents), an append-only activity log, claims as leases (atomic, heartbeat-renewed,
expiring back to the lane), and attention requests (a card handed to a member, feeding the
owner's queue). SQLite. Every mutation goes through one typed interface and produces an
activity entry — this is what "everything observable" hangs off, and every later surface
(HTTP, MCP) is a client of this interface. Human-only lane transitions are enforced here, in
the core, not in the UI. Card content is text and references only; nothing here may ever
hold file contents (see AGENTS.md).

## 003 — HTTP API and live updates

The board server: HTTP for reads and mutations over the 002 interface, plus a live event
stream (SSE is likely sufficient locally; the spec decides) so every connected member sees
moves and comments as they happen. Localhost only.

## 004 — Web UI

The owner's view: render the board, drag cards between lanes, open a card to read its
activity and comment. Home screen is the attention queue — what's waiting on you — with the
board behind it. Talks only to 003. Framework chosen in the spec.

## 005 — Agents join over MCP

The MCP server: an agent connects, appears as a member, and gets the same primitives a human
has — list lanes and cards, take a card, move it, comment. Same 002 interface underneath, so
agent actions show up live in the 004 UI. The parity rule is the acceptance bar: anything an
agent can do must be visible and attributable on the board.

## 006 — Daemon skeleton

The machine-local daemon: connects to the board as an agent member, watches the lanes mapped
to agent stages, claims a card on its lease, and creates a git worktree for it in a
configured repository. No coding agent yet — the deliverable is the watch/claim/worktree
lifecycle, its states visible on the card, and clean teardown. Process management and crash
recovery are the substance here; a daemon that leaks worktrees or strands claims fails the
milestone.

## 007 — Daemon runs the stage playbooks

The daemon spawns a coding agent (subprocess, e.g. `claude -p`) in the card's worktree,
running the built-in playbook for the card's stage with the card as input, and streams its
activity back to the card as it works. The playbooks ship with kanbot — extracted from this
repo's `.claude/` skills and agents — and are injected at spawn time, never committed to the
target repository; project specifics come from the target repo's own `AGENTS.md`. The daemon
relays; it calls no model APIs itself. Output posted to the card is excerpts and status,
never a code dump; a run's result is a card update (spec'ing writes the spec to the card) or
a branch/PR reference (developing).

## 008 — The full loop

Close the loop the product exists for: Ideas → Spec'ing → Spec review → Ready → Developing →
**Agent review** → PR review → Done. An idea card gets spec'd by an agent onto the card, the
owner approves on the board, an agent develops it (committing the spec to `docs/specs/` as
it starts), and an *independent* agent reviews the branch before the owner ever sees it —
Agent review is its own stage lane with a review playbook, claimed by a different member
than the one that implemented, so reviewer independence is enforced by lane mechanics
rather than by orchestrator promise. Findings land as card comments; APPROVED moves the
card to PR review with the review attached, CHANGES REQUESTED sends it back to Developing —
the same gesture as human feedback, so the revision loop needs no new machinery. Bounded
cycle budget (3): after that the card goes to the owner with what's unresolved instead of
ping-ponging. What reaches PR review has therefore survived independent review — the
owner's queue only holds work worth their time. The owner merges, the card lands in Done.
Includes failure and abandonment paths (worktree released, card returned with a reason,
attention request to the owner).
Depends on what 006 and 007 turn out to need — expect this entry to be rewritten from their
findings before it is specified. When this lands, kanbot can start building kanbot.

## Later, deliberately unplanned

Teams — hosted multi-human mode (auth, tenancy, sync) — plus multiple boards, multiple
daemons per board, agent-to-agent handoffs, card attachments, notification channels beyond
the board (Slack, email, push), and per-repo override of the built-in stage playbooks (users
supplying their own spec/develop skills; kanbot ships the workflow until real use demands
customization). None of these may be pulled forward into an earlier spec's scope: the
product is optimized 100% for a single owner until the solo loop proves itself.
