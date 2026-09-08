# Milestones

The planned sequence of specs. Entries ahead of the current milestone are provisional —
`/spec <NNN>` turns one into a real specification, and what a spec's implementation teaches
gets recorded here against the milestones it affects. Never renumber; if the plan changes,
rewrite the entry, not the number.

Status: nothing implemented yet through the spec workflow. A prototype spike (2026-09-07,
preserved on the `prototype` branch) built the previous architecture — separate board server,
web UI, MCP endpoint, daemon — end to end and ran a real spec stage and develop stage against
a toy repo. The project has since been renamed skelcrew and pivoted to the single-headless-
daemon architecture (see AGENTS.md); the milestone entries below are written for the new
architecture, and the spike's findings — recorded here in its own lane/board vocabulary —
must be absorbed by the numbered specs:

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
- **A green check needs at least one test (001).** `bun test` on Bun 1.3.14 exits non-zero
  when it finds no test files, so a "green with zero tests" scaffold is impossible. The
  scaffold therefore ships one wiring test per package — each proves the workspace resolves
  `@skelcrew/shared`'s version string — and nothing more.

## 001 — Project scaffold

Bun-workspaces monorepo: `packages/daemon` (state, protocol surfaces, runner — the product),
`packages/cli`, `packages/shared` (types shared across them). TypeScript strict,
`bun run check` wired to lint, format check, typecheck, and `bun test` — this is the
definition of done every later spec is verified against, so it must be real and green (with
zero tests) before anything else lands. No product code beyond what proves the wiring.

## 002 — Core state

The domain model and persistence, no network: cards, phases (each with its artefact
contract), members (the one human owner plus agents), an append-only activity log, claims as
leases (atomic, heartbeat-renewed, expiring back to the queue as a visible "run interrupted"
event), and attention requests that carry their resolving actions (approve → next phase /
send back with feedback). SQLite. Every mutation goes through one typed interface and
produces an activity entry — this is what "everything observable" hangs off, and every later
surface (JSON-RPC, MCP) is a client of this interface. Human-only phase transitions are
enforced here, in the core, not in any client. Card content is text and references only;
nothing here may ever hold file contents (see AGENTS.md).

## 003 — Client protocol

The daemon's front door: JSON-RPC over a local socket exposing the 002 interface — reads,
mutations, and a subscription stream so every connected client sees moves and comments as
they happen. This is the one protocol all clients (CLI, TUI, GUI) speak, so it must be
complete: anything a client will ever render or do goes through it. Local machine only;
remote access is a later milestone's problem, but the protocol should not assume same-host
beyond transport.

## 004 — CLI

The owner's first client: file a card in one line, list cards as rows with a phase track,
open a card to read its activity and comment, and — front and centre — the attention queue:
what's waiting on you, resolvable in place (approve / send back with feedback). Includes the
ping: an attention request should reach the owner without them polling (OS notification from
a watch mode; the spec decides the mechanism). Talks only to 003.

## 005 — Agents join over MCP

The MCP server, in the daemon: an agent connects, appears as a member, and gets the same
primitives a human has — see cards, take one, advance it, comment. Same 002 interface
underneath, so agent actions show up live in every connected client. The parity rule is the
acceptance bar: anything an agent can do must be visible and attributable on its card.

## 006 — Runner skeleton

The execution half, behind the internal seam: watch claimable phases, claim a card on its
lease, and create a git worktree for it — branched from an explicit base (the repo's default
branch), never from wherever a checkout happens to be parked. No coding agent yet — the
deliverable is the watch/claim/worktree lifecycle, its states visible on the card, and clean
teardown that never destroys work: a dirty worktree is salvaged (left in place and reported,
or WIP-committed), never force-removed. Process management and crash recovery are the
substance; a runner that leaks worktrees or strands claims fails the milestone.

## 007 — Runner runs the phase playbooks

The runner spawns a coding agent in the card's worktree, running the built-in playbook for
the card's phase with the card as input, and streams its activity back to the card as it
works. Driven through the Agent SDK, not fire-and-forget `-p`: `canUseTool` becomes an
attention request with Approve/Deny that resumes the run, and streaming input lets card
comments reach the running agent mid-run. Playbooks ship with skelcrew — extracted from this
repo's `.claude/` skills and agents — and are injected at spawn time, never committed to the
target repository; project specifics come from the target repo's own `AGENTS.md`, and the
runner pre-allows the check commands named there. The runner relays; it calls no model APIs.
A finish is verified against the phase's artefact contract before any handoff — a develop
finish with no commits on the branch is a failed run → attention request with the reason,
never a handoff. Output posted to the card is excerpts and status, never a code dump.

## 008 — The full loop

Close the loop the product exists for: Idea → Spec'ing → Spec review → Ready → Developing →
**Agent review** → PR review → Done. An idea card gets spec'd by an agent onto the card, the
owner approves (approval ends the human gesture: the card moves to a claimable queue, and
the runner itself moves it into the in-flight phase when work starts, so position always
reflects true state), an agent develops it (committing the spec to `docs/specs/` as it
starts), and an *independent* agent reviews the branch before the owner ever sees it — Agent
review is its own phase with a review playbook, claimed by a different member than the one
that implemented where a peer exists (runners deprioritize reviewing branches they produced,
falling back to fresh-context self-review only when alone). Findings land as card comments;
APPROVED advances the card with the review attached, CHANGES REQUESTED sends it back to
Developing — the same gesture as human feedback. Bounded cycle budget (3): after that the
card goes to the owner with what's unresolved instead of ping-ponging. What reaches PR
review has therefore survived independent review — the owner's queue only holds work worth
their time. The owner merges, the card lands in Done. When the default branch moves, the
runner dry-run-merges each in-flight card's branch; a conflicted card auto-bounces to
Developing with a rebase brief and re-passes Agent review before its PR updates. Includes
failure and abandonment paths (worktree salvaged, card returned with a reason, attention
request to the owner) and card deletion/archiving. Depends on what 006 and 007 turn out to
need — expect this entry to be rewritten from their findings before it is specified. When
this lands, skelcrew can start building skelcrew.

## Later, deliberately unplanned

TUI (the rows-and-phase-track view, live over 003) and GUI, maybe. Remote clients watching a
daemon on an always-on machine. Second runners and hosted runner tiers over the internal
seam. Teams — hosted multi-human mode (auth, tenancy, sync). Multiple repositories per
daemon, notification channels beyond the local ping (Slack, email, push), card attachments,
and per-repo override of the built-in phase playbooks (users supplying their own spec/develop
skills; skelcrew ships the workflow until real use demands customization). None of these may
be pulled forward into an earlier spec's scope: the product is optimized 100% for a single
owner until the solo loop proves itself.
