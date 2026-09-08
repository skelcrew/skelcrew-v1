# Milestones

The planned sequence of specs. Entries ahead of the current milestone are provisional —
`/spec <NNN>` turns one into a real specification, and what a spec's implementation teaches
gets recorded here against the milestones it affects. Never renumber; if the plan changes,
rewrite the entry, not the number. A number identifies an entry and never changes, even when
the build order does: entries are listed below in intended build order, so a later-numbered
entry can precede an earlier one when it was carved out of it.

Status: 001 landed (PR #1, 2026-09-08); 002 is next. A prototype spike (2026-09-07,
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

Findings and decisions from the spec workflow itself, newest last:

- **A green check needs at least one test (001).** `bun test` on Bun 1.3.14 exits non-zero
  when it finds no test files, so a "green with zero tests" scaffold is impossible. The
  scaffold therefore ships one wiring test per package — each proves the workspace resolves
  `@skelcrew/shared`'s version string — and nothing more.
- **Specs ship with defects, and fixing one mid-run needs a rule (007/008).** Spec 001's
  acceptance criteria 9 and 10 contradicted each other. The implementer built to 9, reported
  the conflict instead of editing the spec, and the owner approved a one-line rewording while
  the run was in flight. That is the shape the live pipeline needs: an agent never edits the
  card's spec to match its code; it raises an attention request naming the conflict, and the
  owner's resolution is a spec edit plus a comment the run continues from.
- **Worktrees inside the target repo leak into its tooling (006).** The repo's own
  `biome ci .` walked `.claude/worktrees/` and turned `bun run check` on `main` red with a
  sibling worktree's work in progress. The runner should create worktrees outside the target
  repo's tree (under the daemon's data directory), so no target-repo tooling ever sees them.
- **Five phases, named as states (settled with the owner 2026-09-08).** Idea → Spec →
  Code → PR → Done — exactly this repo's workflow: a milestones entry, `/spec`
  with the owner's approval inside it, `/develop` with implement, review, and verify inside
  it, the PR, the merge. The eight-phase track that split out Spec review, Ready, and Agent
  review is gone: whether a card is queued, running, or waiting on the owner is a status
  within its phase, derived from claims and attention requests, never a phase of its own.
  Review cycles are visible as activity, not as positions. "Spec'ing", "Developing", and
  "Ready" in the spike findings above are the old names.
- **The card body is markdown, not fields, and the core never inspects it (settled
  2026-09-08).** The spec is one markdown text, the same shape as `docs/specs/`, so the
  develop phase commits it verbatim. A gate-time check for Goal, Acceptance criteria, and Out
  of scope sections was considered and dropped to keep the model simple; the push toward
  those sections is the spec playbook's template and the develop playbook refusing a card
  without them (007). Title, phase, repo, and references stay structured data.
- **The repo is the only container, and milestones are cards (settled 2026-09-08).** No
  workspace, project, or milestone entity. A file like this one lives in the target repo as
  project knowledge; its entries become Idea cards by bulk filing (004, from stdin), in
  order; findings keep being written into the file by the develop playbook, as 001's was.
  Once a card exists it is authoritative and the file entry is history.
- **002 was too big and is split (settled 2026-09-08).** Core state stays 002; claims as
  leases become 009, built before 006; attention requests become 010, built after 004. Each
  is one review-sized diff with its own state machine and tests. Card archiving moves from
  008 into 002.
- **No MCP server; agents use the CLI (settled 2026-09-08).** Every agent skelcrew deals
  with has a shell, so a second surface would only have to be kept at parity with the first
  by discipline, and would bring the repo's first external dependency. 005 is dropped. The
  CLI identifies an agent member with `--as <name>` (or the environment variable the runner
  sets at spawn), and offers `--json` output so agents parse rather than scrape. "Agents are
  members" then holds by construction: there is one client.

## 001 — Project scaffold

Bun-workspaces monorepo: `packages/daemon` (state, protocol surfaces, runner — the product),
`packages/cli`, `packages/shared` (types shared across them). TypeScript strict,
`bun run check` wired to lint, format check, typecheck, and `bun test` — this is the
definition of done every later spec is verified against, so it must be real and green (with
zero tests) before anything else lands. No product code beyond what proves the wiring.

## 002 — Core state

The smallest model that lets a card be filed, moved, commented on, and seen — no network,
no runner. A card is a title, a markdown body (the spec, as one text the core never
inspects), a repo reference, its phase, its references (branch, commit shas, PR URL), and
its order within the repo. Ids are short integers, typeable at a CLI. The phase track is a typed constant in
`shared`, not a table: Idea, Spec, Code, PR, Done — each declaring its
artefact contract (a spec on the card; a branch with commits and a PR; a merge) and who may
move a card out of it. Spec → Code and PR → Done are the owner's alone; a
card's queued / running / waiting-on-you status inside a phase is derived (from 009 and
010 later), not stored. Members are the one owner, seeded
on first run, plus agents by name; every mutation carries an actor. An append-only activity
log holds each mutation as a typed event — created, moved, commented, references set,
archived — and comments are events, not a table; a rejected gate move is logged too. One
typed interface fronts all of it and is the only way to write — this is what "everything
observable" hangs off, and every later surface (003, 004) is a client of it. SQLite through
Bun's driver, one file under the daemon's data directory, migrations from day one. Card
archiving is here (the spike's mis-pasted card). Text and references only: no column can
hold a file, and a comment has a size cap so a log excerpt stays an excerpt (see AGENTS.md).
Claims and attention requests are deliberately absent — they are 009 and 010.

## 003 — Client protocol

The daemon's front door: JSON-RPC over a local socket exposing the 002 interface — reads,
mutations, and a subscription stream so every connected client sees moves and comments as
they happen. This is the one protocol all clients (CLI, TUI, GUI) speak, so it must be
complete: anything a client will ever render or do goes through it. Local machine only;
remote access is a later milestone's problem, but the protocol should not assume same-host
beyond transport.

## 004 — CLI

The one client, for the owner and for agents: file a card in one line (and many at once from
stdin, so a milestones file becomes cards in one command), list cards as rows with a phase
track, open a card to read its activity and comment, and move it — into Spec to start it,
approve into Code, send back with feedback, mark Done. Run with `--as <name>` (or the
runner's environment variable) it acts as that agent member, so an agent in a live session
files and advances cards with the same commands the owner uses; `--json` gives agents output
to parse. No attention queue yet; 010 adds it, with the ping. Talks only to 003.

## 005 — Dropped

Was "Agents join over MCP". Dropped 2026-09-08: agents use the CLI (004) as agent members.
The number stays so earlier references resolve.

## 010 — Attention requests

Carved out of 002; built after 004, whose agent invocations are the first real producers. An agent
finishing or blocking hands the card to a member with the resolving choices attached —
approve → next phase, send back with feedback, answer a question — recorded as activity.
Resolving one is an ordinary move or comment through the 002 interface, so nothing bypasses
the log. The CLI gains its home view: what's waiting on you, resolvable in place, plus the
ping — an attention request reaches the owner without polling (OS notification from a watch
mode; the spec decides the mechanism). An agent raises and sees them through the same CLI.

## 009 — Claims as leases

Carved out of 002; built before 006, its first consumer. A member claims a card in a
claimable phase atomically; the claim is a lease renewed by heartbeat; an expired lease
returns the card to its queue as a first-class "run interrupted" event, so sleep, crash, and
kill collapse into one visible path. Enforced in the core and exposed over 003 and the CLI
like everything else — an agent at the CLI claims exactly as the runner does.

## 006 — Runner skeleton

The execution half, behind the internal seam: watch claimable phases, claim a card on its
lease (009), and create a git worktree for it — branched from an explicit base (the repo's
default branch), never from wherever a checkout happens to be parked, and placed outside the
target repo's tree so its tooling never sees it. No coding agent yet — the
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

Close the loop the product exists for: Idea → Spec → Code → PR → Done. The
owner moves an idea into Spec; the runner claims it and an agent writes the spec onto the
card; the finish is an attention request, and approving it is the owner's move into
Code (approval ends the human gesture: the card is queued there, the runner claims
it and its status shows running, so position and status always reflect true state). The
develop playbook is this repo's `/develop` made live: it commits the spec to `docs/specs/`
as it starts, implements, then reviews the branch in a *fresh* context before the owner
ever sees it, and verifies — review findings land as card comments, CHANGES REQUESTED loops
back to the implementer within the run, and a bounded cycle budget (3) sends the card to
the owner with what's unresolved instead of ping-ponging. The finish contract is a branch
with commits and a PR; meeting it moves the card to PR, where the owner's queue only
holds work that has survived independent review. The owner merges; the card lands in Done.
Send back from PR is a comment plus a move to Code, which re-dispatches with
history intact. When the default branch moves, the runner dry-run-merges each PR
card's branch; a conflicted card auto-bounces to Code with a rebase brief and
re-passes the in-run review before its PR updates. Includes failure and abandonment paths
(worktree salvaged, card returned with a reason, attention request to the owner).
Cross-member review — a different runner reviewing than the one that implemented — is
deferred until a second runner exists. Depends on what 006 and 007 turn out to need —
expect this entry to be rewritten from their findings before it is specified. When this
lands, skelcrew can start building skelcrew.

## Later, deliberately unplanned

TUI (the rows-and-phase-track view, live over 003) and GUI, maybe. Remote clients watching a
daemon on an always-on machine. Second runners and hosted runner tiers over the internal
seam. Teams — hosted multi-human mode (auth, tenancy, sync). Multiple repositories per
daemon, notification channels beyond the local ping (Slack, email, push), card attachments,
and per-repo override of the built-in phase playbooks (users supplying their own spec/develop
skills; skelcrew ships the workflow until real use demands customization). Grouping cards
into milestones or projects: deferred until 008, when skelcrew builds skelcrew and this file
either becomes cards or shows what a grouping entity would have to add. None of these may
be pulled forward into an earlier spec's scope: the product is optimized 100% for a single
owner until the solo loop proves itself.
