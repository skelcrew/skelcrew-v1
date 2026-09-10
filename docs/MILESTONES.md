# Milestones

The planned sequence of specs. Entries ahead of the current milestone are provisional —
`/spec <NNN>` turns one into a real specification, and what a spec's implementation teaches
gets recorded here against the milestones it affects. Never renumber; if the plan changes,
rewrite the entry, not the number. A number identifies an entry and never changes, even when
the build order does — so **entries below are in numeric order, and the build order is the
table**. A later-numbered entry can come earlier in the sequence when it was carved out of one.

## Sequence

| # | Spec | Status |
| --- | --- | --- |
| 1 | 001 Project scaffold | landed, PR #1 |
| 2 | 002 Core state | landed, PR #2 |
| 3 | 003 Client protocol | landed, PR #3 |
| 4 | 004 CLI | landed, PR #4 |
| 5 | 010 Attention requests | landed, PR #5 |
| 6 | 009 Claims as leases | landed, PR #6 |
| 7 | 006 Runner skeleton | landed, PR #7 |
| — | 007 Runner runs the phase playbooks | **spiked, not merged** — PR #8 closed, split into 011–014 |
| 8 | 011 Which refs a run set; spec export bookmark | in review, PR #9 |
| 9 | 012 Spawn an agent, show what it does | planned |
| 10 | 013 The agent asks the owner | planned |
| 11 | 014 A phase ends in a verified artefact | planned |
| 12 | 015 Control characters can't repaint the record | planned |
| 13 | 008 The full loop | planned, expect it to split too |
| | 005 | dropped |

## Background

A prototype spike (2026-09-07, preserved on the `prototype` branch) built the previous
architecture — separate board server, web UI, MCP endpoint, daemon — end to end and ran a
real spec stage and develop stage against a toy repo. The project has since been renamed
skelcrew and pivoted to the single-headless-daemon architecture (see AGENTS.md); the
milestone entries below are written for the new architecture, and the spike's findings —
recorded here in its own lane/board vocabulary — must be absorbed by the numbered specs:

- **Talk-to-the-agent is the core gap (012/013).** The spike spawns fire-and-forget `claude -p`;
  when the sandbox blocked `npm run check`, the agent asked for approval *on the card* and
  nobody could answer — it committed without running checks. 012 must drive the Agent SDK
  instead: `canUseTool` becomes an attention request with Approve/Deny that resumes the run,
  and streaming input lets card comments reach the running agent mid-run. Also: playbooks
  know the repo's check commands from `AGENTS.md`, so the daemon should pre-allow them.
- **The daemon must verify before handing off (014).** Twice the spike's develop stage
  ended with the agent blocked from committing — and the daemon still posted "branch ready
  for review" on a branch with zero commits, then force-removed the worktree, destroying the
  uncommitted implementation. A develop finish must confirm `git log base..branch` is
  non-empty and the worktree clean; anything else is a failed run → attention request with
  the reason. Never force-remove a dirty worktree — salvage (leave it and say where, or
  WIP-commit) instead. This is the verifier's "never claim a stage happened when it did not",
  mechanized.
- **Permission allowlists don't reach the sandbox (013).** Target-repo `permissions.allow`
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
- **The fork base is nondeterministic (006 — landed).** `git worktree add -b` branches from the
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
- **Specs ship with defects, and fixing one mid-run needs a rule (012/008).** Spec 001's
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
  without them (012). Title, phase, repo, and references stay structured data.
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
- **The data directory is `<repo root>/.skelcrew/`, and identity is per connection (003).**
  The daemon serves one repository and keeps its database and socket under that repo's
  `.skelcrew/` (already gitignored; `SKELCREW_DIR` overrides it), found by walking up to
  `.git` from wherever it is started, so a shell inside the repo needs no registry to find
  the socket. The socket file's mode is the access control. On the wire, a connection's first
  request is `hello` — `{ kind: "human" }` for the owner, `{ kind: "agent", name }` for an
  agent — and every later method acts as that member; nothing carries an `actorId`, so an
  agent's CLI invocation (004, `--as <name>`) is a connection that says hello as that agent.
  `ensureMember` reaches the wire only as `hello`; `getMember` only as `listMembers`.
- **`SKELCREW_AS` names the agent the CLI speaks as (004).** `skelcrew --as <name>` or the
  environment variable `SKELCREW_AS=<name>` binds the invocation to that agent member via
  `hello` (the flag wins); without either, it is the owner. The runner (006/012) sets
  `SKELCREW_AS` at spawn so a playbook's commands need no flag, and nothing about identity
  is stored client-side. Path discovery (`findRepoRoot`, `resolveDataDir`, `dataPaths`)
  lives in `@skelcrew/shared` so the CLI and the daemon find the same socket from the same
  walk; a dead socket is reported, never removed or auto-started, by a client.
- **"Waiting" is `Card.attention`, and `SKELCREW_NOTIFY` overrides the notifier (010).** A
  card is waiting on someone exactly when its `attention` is non-null: `{ to, note, moves,
  raisedBy, raisedAt }`, one per card, replaced on re-raise, stored as a JSON column and
  listed by `listAttention` in raise order. It resolves by a move to another phase, by
  archiving, or by `resolveAttention` (`skelcrew resolve`, the addressee's or the owner's
  answer) — never by a bare comment — each recorded as `attention_resolved { how }`. The
  CLI's no-command default is `queue`, and `skelcrew watch` tails the activity stream and
  pings the invoking member's requests through `osascript` on macOS or `notify-send` on
  PATH; `SKELCREW_NOTIFY=<command>` replaces that with a command receiving the title and text
  as arguments, which is how tests record pings without notifying anyone. 009's "queued" and
  "running" are the other two statuses of the same derived kind.
- **"Running" is a live `Card.claim`; heartbeats are not logged; the sweep runs every five
  seconds (009).** A card is running exactly when its `claim` — `{ by, claimedAt, expiresAt,
  ttlSeconds }`, one per card, a JSON column like `attention` — has `expiresAt` in the
  future, and queued when its phase is claimable (`PHASES[].claimable`: `spec` and `code`),
  it is unarchived, and it has no live claim. `claimCard` is atomic and records `claimed`;
  `heartbeat` extends `expiresAt` by the claim's TTL, a renewal through `claimCard` takes
  the TTL it is given (default 120 s), and neither records anything, so a running card's
  only trace of liveness is its `expiresAt`. A move to another phase or an archive releases
  a live claim (`released { reason: "moved" | "archived" }`), and an agent can neither move
  nor archive a card someone else holds live. The daemon calls `sweepClaims()` every five
  seconds; each lapsed claim becomes `run_interrupted { by, expiresAt }` attributed to the
  former holder and the card stays in its phase, which is what "returns to its queue"
  means. Between a lapse and its sweep the claim is still visible with a past `expiresAt`
  (`~` in `ls`), and whatever clears it first — a claim over it, a move, an archive —
  records that same interruption rather than a release, so a dead run is never written up
  as a handoff. TTL defaults to 120 s, bounded 10 to 3600. The CLI's `claim`,
  `heartbeat`, and `release` are what the runner (006) and a live-session agent both use;
  `SKELCREW_AS` identifies which.
- **The runner is the agent member `runner` inside the daemon; worktrees live under
  `<data dir>/worktrees/<id>`; branches are `skelcrew/<id>-<slug>` from the default
  branch's local head; a run without a playbook ends in an attention request (006).** The
  daemon joins the core as `runner` at startup (`SKELCREW_RUNNER=0` leaves it out) and
  drives the core through the same interface the socket does. A card is ready when its
  phase is claimable, it is unarchived, unclaimed, and has no open attention request; the
  runner takes ready cards one at a time in id order, claiming with a 120 s lease renewed
  every 30 s. Each run creates `skelcrew/<id>-<slug>` (the title lower-cased,
  non-alphanumerics collapsed to `-`, at most 40 characters, `skelcrew/<id>` when nothing
  is left) from the base branch — the local head of the branch `refs/remotes/origin/HEAD`
  names, else `main`, else `master`, never a fetch and never the owner's checkout — and
  adds a worktree at `<data dir>/worktrees/<id>` (inside the gitignored `.skelcrew/`, so
  no target-repo tooling walks it); both are reused by later runs of the same card.
  Without a playbook the run sets the `branch` ref, comments `worktree ready at <path> on
  <branch> (from <base>)`, raises `no playbook for <phase> yet; work in <path>` to the
  owner, and releases with reason `no playbook`; 012 replaces the request with the
  playbook run and keeps everything before it. A failed step is a comment
  `<step> failed: <error>`, the same text as an attention request, and a release with
  reason `failed`; nothing retries. Leaving the claimable phases or archiving tears the
  worktree down only when `git status --porcelain` is empty (`worktree removed`);
  otherwise it stays with `worktree kept at <path>: uncommitted changes` and the paths.
  Branches are never deleted. At startup the runner releases its own leftover claims
  (`daemon restarted`; when the daemon was down longer than the claim's TTL the core
  records `run_interrupted` instead, its rule for a lapsed claim) and reconciles
  `worktrees/` before taking any card. A run re-checks its claim after every git call,
  before posting anything: a claim lost to a move, an archive, a release, another member,
  or a lapse abandons the run with one comment (`run abandoned: <reason>`) and nothing
  else. The CLI and the daemon resolve a linked worktree — a `.git` file whose `gitdir`
  points into `<main>/.git/worktrees/` — to its main repository, so from inside
  `<repo>/.skelcrew/worktrees/<id>` every CLI verb reaches `<repo>/.skelcrew/` with no
  `SKELCREW_DIR`; 012's spawned agent may still get it set, belt and braces. The rule
  requires the gitdir's grandparent to be named `.git`, so a main repository initialised
  with `--separate-git-dir` does not resolve and its runner worktrees fall back to their
  own directory as the root.

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

## 006 — Runner skeleton

The execution half, behind the internal seam: watch claimable phases, claim a card on its
lease (009), and create a git worktree for it — branched from an explicit base (the repo's
default branch), never from wherever a checkout happens to be parked, and placed outside the
target repo's tree so its tooling never sees it. No coding agent yet — the
deliverable is the watch/claim/worktree lifecycle, its states visible on the card, and clean
teardown that never destroys work: a dirty worktree is salvaged (left in place and reported,
or WIP-committed), never force-removed. Process management and crash recovery are the
substance; a runner that leaks worktrees or strands claims fails the milestone.

## 007 — Runner runs the phase playbooks — spiked, superseded by 011–014

**Built, reviewed eight times, and parked rather than merged.** The spec is
`docs/specs/007-runner-runs-playbooks.md`, left unchanged as the record of what was intended;
the work is branch `worktree-runner-playbooks` on `origin` (tip `3cb6d64`, 14 commits, green
at 359 tests with every finding landed). It is reference material, not a base to build on —
the same standing as the `prototype` branch.

It aimed at the whole of it at once: the agent boundary with the SDK behind it, the shim, the
permission allowlist, both playbooks, activity streaming, the transcript, permission routing,
both artefact contracts, and the entire claim lifecycle — 3,576 insertions across 25 files, and
the first spec where skelcrew touches subprocesses, the network, and actions that cannot be
undone. Four internal review rounds and four external ones (a different vendor's model, reading
the same spec) found about twenty-one real defects and no invented ones. They converged rather
than scattered, but a spec needing eight rounds is a spec that could not be reviewed in one.

**Read `docs/plans/007-spike-retrospective.md` before specifying any of 011–014.** It carries
what the spike bought: what it settled and should not reopen, the domain facts that each cost a
round (the core queues nested mutations; `moveCard` emits its own `released`; member identity
cannot tell the agent's `skelcrew attention` from the runner's own note; `refs/tags/<name>`
outranks `refs/heads/<name>`; the SDK stream is not the display projection), the invariants and
every place they were violated, and the two defects that were in the spec itself. The run
record and all three conformance reviews are in `docs/plans/` alongside it.

Three lessons already applied to `.claude/` (`/spec`, reviewer, implementer): a permission
grant is a security boundary; "spec defects, faithfully implemented" is a finding class; a fix
changes exactly what the finding names. Two not yet applied anywhere: a fix is done when the
cases *next to* the reported one have been looked at — five half-fixes survived multiple rounds
because "fixed" in a run record reads as settled — and each review round should be its own
commit, since a squashed history cannot evidence red-before-green.

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
deferred until a second runner exists. Depends on what 006 and 011–014 turn out to need —
expect this entry to be rewritten from their findings before it is specified, and to be split
the way 007 should have been: the in-run review loop with its cycle budget, and the
default-branch/rebase machinery, are separable from the loop itself. When this
lands, skelcrew can start building skelcrew.

## 009 — Claims as leases

Carved out of 002; built before 006, its first consumer. A member claims a card in a
claimable phase atomically; the claim is a lease renewed by heartbeat; an expired lease
returns the card to its queue as a first-class "run interrupted" event, so sleep, crash, and
kill collapse into one visible path. Enforced in the core and exposed over 003 and the CLI
like everything else — an agent at the CLI claims exactly as the runner does.

## 010 — Attention requests

Carved out of 002; built after 004, whose agent invocations are the first real producers. An agent
finishing or blocking hands the card to a member with the resolving choices attached —
approve → next phase, send back with feedback, answer a question — recorded as activity.
Resolving one is an ordinary move or comment through the 002 interface, so nothing bypasses
the log. The CLI gains its home view: what's waiting on you, resolvable in place, plus the
ping — an attention request reaches the owner without polling (OS notification from a watch
mode; the spec decides the mechanism). An agent raises and sees them through the same CLI.

## 011 — The card records which refs a run set, and where it exported the spec

Two changes, and they are not equally important.

**The load-bearing half: `refs_set` records which keys a call set**, not only the merged
result. Without it "did *this run* record a pull request?" cannot be answered — a run writing
any other reference while a `prUrl` sits on the card satisfies the same check, which is how the
daemon came to post "ready for review" on work a run had not done. 014's contract needs this in
every repository, and it is the reason this milestone comes first.

**The optional half: `refs` gains `specPath`.** The card body *is* the spec, in SQLite; a spec
file committed into a target repo is an export of it, for readers who cannot reach the database.
`specPath` is a bookmark to that copy, so a later run of the same card replaces it instead of
duplicating it. It matters only where a repository publishes specs into its own tree — this one
does — and the 007 spike spent three review rounds proving that finding the copy by guessing
does not work: by number a run treats its own previous file as a collision and stops, by content
it breaks the moment the owner revises the text, by either it ships a stale spec in the pull
request.

Nothing requires the export to exist. A repository that publishes nothing sets no `specPath` and
finishes its phases exactly the same way — the pull request description carries the spec for its
reviewer, and a description needs no bookmark because its identity is the `prUrl` already on the
card. Whether a committed file is worth its cost at all is deliberately left open: deriving the
path from the card (`<id>-<slug>`) would make it a pure function and need no record, and that
choice should be made when dogfooding produces evidence rather than now.

## 012 — The runner spawns an agent and the card shows what it does

The agent boundary as one interface with the SDK behind a single file, `SKELCREW_AGENT`
selecting `claude` or `none`, and `bunfig.toml`'s `peer = false` keeping the SDK's peer
packages — an actual model client among them — off disk. The generated shim on the agent's
`PATH`, speaking as the `runner` member, `exec`ing this daemon's own Bun so it survives a
minimal launchd environment. Playbooks loaded and injected at spawn. The agent's turns and tool
activity streamed onto the card as excerpts and summaries, never a code dump, with the full SDK
message stream written to a run log at the driver boundary — not projected from what the card
displays, which silently drops whole message kinds.

Ends when: an agent runs in the card's worktree and everything it did is visible on the card.
A tool that is not pre-allowed is denied, visibly; asking is 013. No artefact contract yet —
the run hands back the way 006 does.

## 013 — The agent asks the owner

`canUseTool` becomes an attention request carrying the resolving choices, answered by the
owner's `resolve -m`, and the run continues. Requests queue: one on the card at a time, and a
question the agent raised itself outranks them. Plus the allowlist — the fixed list of what
needs no asking, and the scan that adds the check commands a target repo names in its own
instructions.

**This is a security spec and must be reviewed as one.** 007 specified `Bash(gh pr *)` and
`Bash(git *)`; both were implemented faithfully and each dissolved the gate the same spec
existed to build, because `Bash(x *)` matches every command beginning with `x` — including
`gh pr merge`, `git push origin HEAD:main`, and arbitrary execution through `git -c`. Name the
verbs against the real matching semantics, say what must ask, and forbid the repo scan from
widening anything the fixed list narrowed.

## 014 — A phase ends in a verified artefact

The contracts and the endings. Spec: a body written by this run, and a non-empty one. Code:
commits past the base — with **both** ends of the range qualified as `refs/heads/…`, since a
tag sharing the base branch's name silently replaces it — a clean worktree, and the PR recorded
*by this run* (011's recorded keys, not the value sitting on the card). Meeting it is an
attention request carrying the move; failing it names every unmet condition, keeps the worktree,
and asks. The spec is deliberately **not** a condition: the card body is the spec and a file in
the repo is an export, so a repository that publishes nothing must finish its phases the same
way.

And the endings, which is where most of the spike's pain lived: what happens when the card moves,
is archived, is released, is claimed by someone else, or the agent acts on its own card. The rule
that finally worked is **derive the ending from the card's state at completion**, consulting the
recorded events only for the *reason* — never for the *decision*. Flags maintained by an event
switch were half-implemented five times over, each round finding the next unhandled case. A run
must never write to a card whose claim it has lost, and a question the agent raised must never be
replaced by the run's own note.

## 015 — Control characters can't repaint the record

Found reviewing 011. `specPath` rejects `\0` and `\n`, but not `\r` or ESC — so
`skelcrew refs 1 --spec "spec\r  RESOLVED: approved"` renders an activity line whose tail
paints over the timestamp and the actor in a terminal. An agent member can make its own
`set refs` entry read as something it is not, which is squarely against *everything
observable: silent mutations are defects*.

It is not new and it is not confined to 011: `branch` has the same property, and so does any
member-set string that reaches a rendered line — title, comment text, attention notes, release
reasons, member names. That is why it is its own spec rather than a patch inside 011 or 014: the
rule is one predicate and it belongs in one place, applied to every such field at once, with the
tests that prove each field enforces it.

The rule needs one distinction rather than a blanket ban. Single-line fields reject every C0
control character. Fields that are legitimately multi-line — the card body is markdown, and a
comment may carry an excerpt — must keep `\n` and `\t` while rejecting the rest, `\r` and ESC
included. A blanket rule would break the body; a blanket exemption is the hole. Consider also
whether rendering should defend itself regardless of what validation accepts, since the terminal
is where the damage lands and old rows already in a database were never validated.

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
