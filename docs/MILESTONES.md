# Milestones

The planned sequence of specs. Entries ahead of the current milestone are provisional —
`/spec <NNN>` turns one into a real specification, and what a spec's implementation teaches
gets recorded here against the milestones it affects — **inside that entry, never as a lane of
findings in front of the plan**; longer evidence lives in the files named under Background and
the entry points at it. Never renumber; if the plan changes,
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
| 8 | 011 Which refs a run set; spec export bookmark | landed, PR #9 |
| 9 | 012 Spawn an agent, show what it does | landed, PR #10 |
| 10 | 013 The agent asks the owner | landed, PR #11 — seven review rounds, every Critical a spec defect |
| 11 | 014 A phase ends in a verified artefact | landed, PR #12 |
| 12 | 016 The gate is the daemon's, not the allowlist's | landed, PR #13 |
| 13 | 015 Control characters can't repaint the record | landed, PR #14 — two Criticals were regressions the spec itself introduced |
| 14 | 017 A playbook's commands are checked against the harness that runs them | landed, PR #15 |
| 15 | 018 A merged pull request lands the card in Done (008a) | landed, PR #16 — three review rounds, every Important a claim nobody had run |
| 16 | 008b The review loop inside Code, with a budget the runner enforces | planned |
| 17 | 008c When the default branch moves | planned, deferred until needed |
| | 005 | dropped |

## Background

The plan below is the whole of this file. Three things that used to sit here have their own
homes, and each entry points at the ones that shaped it:

- `docs/prototype-findings.md` — the 2026-09-07 spike that built the previous architecture end
  to end, in its own lane/board vocabulary.
- `docs/workflow-findings.md` — what building skelcrew with `/spec` and `/develop` teaches
  about `/spec` and `/develop`.
- `docs/research/` — what other harnesses do, one file per subject, and what survives contact
  with this design.

## 001 — Project scaffold

Bun-workspaces monorepo: `packages/daemon` (state, protocol surfaces, runner — the product),
`packages/cli`, `packages/shared` (types shared across them). TypeScript strict,
`bun run check` wired to lint, format check, typecheck, and `bun test` — this is the
definition of done every later spec is verified against, so it must be real and green (with
zero tests) before anything else lands. No product code beyond what proves the wiring.

- **A green check needs at least one test (001).** `bun test` on Bun 1.3.14 exits non-zero
  when it finds no test files, so a "green with zero tests" scaffold is impossible. The
  scaffold therefore ships one wiring test per package — each proves the workspace resolves
  `@skelcrew/shared`'s version string — and nothing more.

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

## 003 — Client protocol

The daemon's front door: JSON-RPC over a local socket exposing the 002 interface — reads,
mutations, and a subscription stream so every connected client sees moves and comments as
they happen. This is the one protocol all clients (CLI, TUI, GUI) speak, so it must be
complete: anything a client will ever render or do goes through it. Local machine only;
remote access is a later milestone's problem, but the protocol should not assume same-host
beyond transport.

- **The data directory is `<repo root>/.skelcrew/`, and identity is per connection (003).**
  The daemon serves one repository and keeps its database and socket under that repo's
  `.skelcrew/` (already gitignored; `SKELCREW_DIR` overrides it), found by walking up to
  `.git` from wherever it is started, so a shell inside the repo needs no registry to find
  the socket. The socket file's mode is the access control. On the wire, a connection's first
  request is `hello` — `{ kind: "human" }` for the owner, `{ kind: "agent", name }` for an
  agent — and every later method acts as that member; nothing carries an `actorId`, so an
  agent's CLI invocation (004, `--as <name>`) is a connection that says hello as that agent.
  `ensureMember` reaches the wire only as `hello`; `getMember` only as `listMembers`.

## 004 — CLI

The one client, for the owner and for agents: file a card in one line (and many at once from
stdin, so a milestones file becomes cards in one command), list cards as rows with a phase
track, open a card to read its activity and comment, and move it — into Spec to start it,
approve into Code, send back with feedback, mark Done. Run with `--as <name>` (or the
runner's environment variable) it acts as that agent member, so an agent in a live session
files and advances cards with the same commands the owner uses; `--json` gives agents output
to parse. No attention queue yet; 010 adds it, with the ping. Talks only to 003.

- **`SKELCREW_AS` names the agent the CLI speaks as (004).** `skelcrew --as <name>` or the
  environment variable `SKELCREW_AS=<name>` binds the invocation to that agent member via
  `hello` (the flag wins); without either, it is the owner. The runner (006/012) sets
  `SKELCREW_AS` at spawn so a playbook's commands need no flag, and nothing about identity
  is stored client-side. Path discovery (`findRepoRoot`, `resolveDataDir`, `dataPaths`)
  lives in `@skelcrew/shared` so the CLI and the daemon find the same socket from the same
  walk; a dead socket is reported, never removed or auto-started, by a client.

**Carried findings.** A retried command must not act twice — `docs/research/orca.md`.

## 005 — Dropped

Was "Agents join over MCP". Dropped 2026-09-08: agents use the CLI (004) as agent members.
The number stays so earlier references resolve.

- **No MCP server; agents use the CLI (settled 2026-09-08).** Every agent skelcrew deals
  with has a shell, so a second surface would only have to be kept at parity with the first
  by discipline, and would bring the repo's first external dependency. 005 is dropped. The
  CLI identifies an agent member with `--as <name>` (or the environment variable the runner
  sets at spawn), and offers `--json` output so agents parse rather than scrape. "Agents are
  members" then holds by construction: there is one client.

## 006 — Runner skeleton

The execution half, behind the internal seam: watch claimable phases, claim a card on its
lease (009), and create a git worktree for it — branched from an explicit base (the repo's
default branch), never from wherever a checkout happens to be parked, and placed outside the
target repo's tree so its tooling never sees it. No coding agent yet — the
deliverable is the watch/claim/worktree lifecycle, its states visible on the card, and clean
teardown that never destroys work: a dirty worktree is salvaged (left in place and reported,
or WIP-committed), never force-removed. Process management and crash recovery are the
substance; a runner that leaks worktrees or strands claims fails the milestone.

- **Worktrees inside the target repo leak into its tooling (006).** The repo's own
  `biome ci .` walked `.claude/worktrees/` and turned `bun run check` on `main` red with a
  sibling worktree's work in progress. The runner should create worktrees outside the target
  repo's tree (under the daemon's data directory), so no target-repo tooling ever sees them.
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

**Carried findings.** Remove a worktree by renaming it into a trash sibling so salvage is the
default, and stamp provenance on it because a path is an assumption — `docs/research/orca.md`.

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

Close the loop the product exists for: Idea → Spec → Code → PR → Done. After 014, most of the
loop already turns: the owner moves an idea into Spec, the runner claims it, the Spec run's
finish carries the move into Code, approval queues it there, the Code run ends in a branch
and a pull request the runner has verified, and the finish carries the move into PR. Send-back
is a comment plus a move to Code, which re-dispatches with history intact. What is missing is
the last arc and the loop inside Code, and they are three separable things — the split 007
should have had, written down before this is specified rather than discovered in review.

**008a — Done.** The owner merges on the forge; the card should land in Done without a second
gesture. That is merge detection: the runner learns a PR-phase card's pull request has merged
and moves the card. The tension to settle first is with *cards drive the runner*: a poll that
acts on every PR card whenever the forge changes is the runner doing work no card asked for.
The honest shapes are either that entering PR *is* the card asking to be watched — one watch
per card, ended by the move to Done — or that the move is a member action (`skelcrew` on a
schedule, or the owner) and the runner never polls at all. Say which, and why. Cross-member
review — a different runner reviewing than the one that implemented — stays deferred until a
second runner exists.

**008b — The review loop inside Code, with a budget the runner enforces.** The Code playbook
already instructs its own review rounds in a fresh context before the owner sees the branch,
and findings land as card comments. 014 was explicit that an in-session *instruction* and a
runner-enforced *budget* are different things, and put the budget here. The runner counts
cycles, not the agent, because the agent's count is the agent's word: after the third
CHANGES REQUESTED the runner ends the run with what is unresolved and hands the card to the
owner, the way `/develop` stops after three. The contract that 014 built is what the loop
ends in; this milestone adds only the count and the stop. Note the same lesson 016 draws —
a rule the agent can route around is not a rule — applies to the budget exactly.

**008c — When the default branch moves.** Dry-run-merging each PR card's branch as the default
branch advances, bouncing a conflicted card back to Code with a rebase brief, and re-passing
the in-run review before its PR updates. Deferred deliberately: it is the most machinery for
the least-proven need, it has the same *cards drive the runner* tension as 008a in a sharper
form, and nothing in a single-owner repository forces it until two cards land close together.
Specify it when that has actually happened. One input from 018's review, for when it is:
`gh pr view --json mergeCommit` gives a sha git can verify in the local clone, so "this card's
own work merged" can be read off the default branch's ancestry rather than off the forge's word
about branch names. That is the strongest available form of 018's ownership check and the
natural companion to dry-run merging, since both read the default branch's history. 018 did
not take it (its check is branch-name based, by spec), and a squash merge still leaves no
ancestry, so it complements rather than replaces what 018 does.

Two corrections to what this entry used to say, both from 014. The develop playbook does
**not** commit the spec to `docs/specs/` as it starts — the card body is the spec, a file is an
export written only where the repository already keeps specs, and the pull request
description carries the spec for the reviewer. And the finish contract is not this
milestone's to build: 014 built it, and it is stricter than "a branch with commits and a PR"
— the branch must have *moved during the run*, or a revision run that ignores the owner's
feedback hands the card back as ready for review.

When 008a lands, skelcrew can start building skelcrew.

**Carried findings.** What the coordinator agent costs, and why a planner agent and a work
hierarchy stay out — `docs/research/orca.md`, `docs/research/field-scan.md`. The activity feed
as a memory layer, and the rules a learning has to follow — `docs/research/README.md`,
`docs/research/hermes.md`. **A failed ending must park the card, not re-enter the queue** —
found in 015's review: `endRun` catches any refusal of its comment and attention request,
warns to stderr, and releases the claim; a free card in a claimable phase is then claimed again
at once, with no backoff and nothing on the card. 015 removed the one reachable trigger (a
control character in the note) and left the shape. The next refusal at that sink — a byte cap,
a core rule added later — costs 186 runs in three seconds and no record, which is exactly what
*everything observable* forbids. It belongs with 008b's runner-enforced machinery: the runner
counts, the runner stops, and a run that cannot say why it ended raises that fact rather than
retrying.

## 009 — Claims as leases

Carved out of 002; built before 006, its first consumer. A member claims a card in a
claimable phase atomically; the claim is a lease renewed by heartbeat; an expired lease
returns the card to its queue as a first-class "run interrupted" event, so sleep, crash, and
kill collapse into one visible path. Enforced in the core and exposed over 003 and the CLI
like everything else — an agent at the CLI claims exactly as the runner does.

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

**Carried findings.** Evidence goes stale and absence authorizes nothing, and a lapsed claim
wants fencing in the core rather than the run's own diligence — `docs/research/orca.md`.

## 010 — Attention requests

Carved out of 002; built after 004, whose agent invocations are the first real producers. An agent
finishing or blocking hands the card to a member with the resolving choices attached —
approve → next phase, send back with feedback, answer a question — recorded as activity.
Resolving one is an ordinary move or comment through the 002 interface, so nothing bypasses
the log. The CLI gains its home view: what's waiting on you, resolvable in place, plus the
ping — an attention request reaches the owner without polling (OS notification from a watch
mode; the spec decides the mechanism). An agent raises and sees them through the same CLI.

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

**Carried findings.** Attention is derived from facts and is a set rather than one record —
`docs/research/orca.md`. A question the agent raises needs a fixed shape with a recommendation,
and a proposed learning is an artefact for this same gate — `docs/research/gstack.md`,
`docs/research/hermes.md`.

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

- **Carried from 012: the spawned agent's environment is exactly four variables.** `PATH`,
  `HOME`, `SKELCREW_AS`, `SKELCREW_DIR` — and the harness SDK *replaces* the environment rather
  than merging, so a run loses `TMPDIR`, `LANG`, `SHELL`, `TERM`, and any proxy, CA-bundle or
  `ANTHROPIC_*` configuration the owner relies on. That is the right rule — a minimal
  environment is what "skelcrew holds no credentials" means in practice, and it is deliberately
  not being relaxed. But an owner whose harness login is an environment variable rather than an
  OAuth session, or who is behind a proxy, will have every run fail at authentication with a
  cause that is not discoverable from the card. Whichever spec first meets a non-OAuth login
  decides deliberately what to pass through, rather than discovering this by accident.

- **Carried from 012, for 013: `settingSources: []` does not close every settings channel.**
  It disables the user, project and local `.claude/settings.json` tiers, which is what stops a
  target repository granting itself permissions. Two things survive it. The SDK's `settings`
  option — the `--settings` flag layer — is separate, accepts a permissive `permissions.allow`,
  and is unaffected; skelcrew must never set it. And `managedSettings`, the restrictive policy
  tier, still applies and looks like the right home for deny rules — except that on a machine
  with an IT-managed tier it is dropped unless that admin opts into merging, so a deny there can
  silently not apply. If 013 uses deny rules, `canUseTool` has to stay authoritative rather than
  relying on them. Note also that the isolation cuts the owner's own harness configuration —
  a `model`, an `env` block, `apiKeyHelper` — so an owner who authenticates through
  `~/.claude/settings.json` rather than a stored login has runs that cannot start, with a cause
  no test here can see. Related to the four-variable environment finding above.

**Carried findings.** A run reads its card one last time before finishing, and a playbook that
restates the allowlist can lie — `docs/research/orca.md`, `docs/research/gstack.md`. Playbook
shape, wording and test tiers, and what a card loses if the daemon dies mid-run —
`docs/research/gstack.md`, `docs/research/orca.md`.

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

**Carried findings.** A claimed limitation is a material claim and needs evidence; nobody has an
answer for alive-but-stuck except watching — `docs/research/gstack.md`,
`docs/research/herdr.md`.

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

**Carried findings.** An outcome is derived from evidence rather than reported, a run's ending
is one of a few named statuses, and this contract is the differentiation rather than hygiene —
`docs/research/orca.md`, `docs/research/gstack.md`, `docs/research/field-scan.md`.

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

**Carried findings.** Landed as two layers — refused at every write, escaped at the CLI's one
sink — and the review found two regressions the spec itself introduced, both by running the
thing rather than reading it: a comment with a newline forged an activity entry because the spec
assumed a layout the renderer never had, and a driver dying with an ANSI-coloured error put the
runner into an unbounded re-claim loop because the spec escaped three enumerated helpers and a
fourth path was the one that mattered. The cure for both was the same construction, applied at
the one place the text passes: a marker on every line of a multi-line field, and an escape on
the runner's posting sink rather than in its helpers. Three things it did not close, recorded
in the run record: the daemon's own stderr is unescaped, so a git error under `color.ui =
always` can colour the daemon operator's console (not the record); `postingCore` wraps the three
core methods the runner calls and its doc says "every text", which is true of the runner as
written and not of the promise; and the Code playbook now reads the body for export through
`--json`, reconstructing markdown from a JSON string, when the body is already verbatim in the
run's first user message — a raw-body output mode, or naming that message as the source, is
the cheaper fix.

## 016 — The gate is the daemon's, not the allowlist's

Found in review round 5 of 013, and it retires an assumption 013 was built on. The allowlist
governs **tool calls**. A subprocess is not a tool call, and the phase playbooks exist to run
one: the repository's own check command. `bun run check` dispatches through `package.json` and
runs `bun test`, which executes any test file the run wrote in its worktree — every one of those
files inside the `Edit(//<worktree>/**)` anchor, and therefore written unprompted. Nothing in the
permission layer sees what the subprocess then does.

That is not a defect to patch. A coding agent's job is to write code and run it; execution is the
product. What follows is that the allowlist was never the boundary it was read as, and three
things 013 protects by omission are not protected at all. The subprocess inherits `PATH` with the
shim and `SKELCREW_AS=runner` (`runner/shim.ts`), so it can run the very verbs rule 4 withholds —
`skelcrew mv`, `claim`, `release`, `archive`, `resolve` — moving its own card past the runner's
artefact check and answering its own permission question. It can also write anything on disk the
daemon's user can, the worktree anchor notwithstanding. 013 records all of this rather than
claiming otherwise; closing it is this milestone.

The fix is to move the rules that matter from a list the agent might evade into the daemon, which
it cannot. The daemon knows which member a request comes from and which run holds the claim, so
it can refuse on its own authority: a run's own member may not move its card into a phase behind
a human-only gate, may not resolve an attention request it raised, and may not release or archive
its own card mid-run. Enforced there, the rule survives arbitrary code execution, a rewritten
`PATH`, and a shim called directly — none of which the allowlist survives.

Two things to settle when specifying it. First, the identity the shim carries is currently an
environment variable the subprocess can rewrite, so the daemon must derive the deciding facts
from its own state (who holds the claim on this card) rather than from what the caller asserts.
Second, this overlaps 014's artefact contracts: 014 checks that the artefact exists before a
phase advances, and this checks that the mover is allowed to move it. They are the same gate seen
from two sides, and the spec should say which check runs first and what each one's failure looks
like on the card.

Out of scope for it, and worth saying so: OS-level sandboxing of the subprocess. That is the only
thing that would stop a check command writing outside the worktree, and it is a different
milestone with a different cost.

## 017 — A playbook's commands are checked against the harness that runs them

Found in review round 1 of 014. The Code playbook prescribed
`skelcrew refs <id> --pr "$(gh pr view --json url --jq .url)"`, and the harness asks outright
about a command carrying a substitution — so every Code run would have stopped on a permission
question to satisfy the one condition that decides whether the phase can complete. Overnight,
that is a time-out and a failed contract, in the unattended tier skelcrew exists for.

Nothing in the repository could have caught it, and that is the finding. `allowlist.ts` models
the harness's permission rules for tests, and records that the model is deliberately *looser*
than the harness about compound commands — safe for asserting "this is not pre-allowed",
unsafe for asserting "this runs unprompted". A playbook line is the second kind of claim, and
the model blessed it. The fix round added a test that walks every command both playbooks
prescribe and rejects shell operators, and then said plainly that it hard-codes the operator
set from the module's own prose: one more model of the thing the bug hid behind. The
maintenance contract above `TRANSCRIBED_FROM` in `allowlist.ts` names the four transcriptions
that age and what to do when one fires; it cannot make the transcriptions stop being
transcriptions.

What this milestone is: a check that runs each prescribed command through the harness's own
permission evaluation — the pinned binary, not a model of it — and fails when one would ask.
Whether the harness exposes that evaluation without running the command is the first thing the
spec has to find out; the review rounds did it by extracting the functions from the binary by
hand, which is a method, not a test. What it is not: a boundary. It guards the playbooks'
ergonomics, not the owner's gates — those are 016's. And it should stay small: the cheapest way
to have fewer commands to check is to prescribe fewer commands, which is containment over
enumeration one more time.

## 018 — A merged pull request lands the card in Done

008a, landed as PR #16. Entering PR is the card asking to be watched: the daemon polls `gh`
once a minute for every unarchived card in PR that carries a pull request URL, and none at all
otherwise. A merge of the card's own work moves the card to Done *as the owner*, with a runner
comment saying why immediately before the move — the one place the daemon records a member's
decision without that member typing it, and `merges.ts` says what a later spec has to argue
against before it may do that elsewhere. Anything else — merged but not this card's work,
closed without merging, `gh` unable to answer — leaves the card in PR and says so once.

Three review rounds, and every Important finding was a sentence asserting something nobody had
run: that a tick could act on the card it listed (the owner had moved it meanwhile); that the
branch on the card was the runner's (the agent can write it); that a member name is a
credential (`skelcrew --as runner` joins the runner member); that `gh` "treats the URL as a URL
or rejects it" (it sends a request to whatever host the URL names). The check that landed reads
the branch from the last `refs_set` by the runner member or the owner, compares the pull
request's host to the repository's own before `gh` is ever asked, and re-reads the card after
the forge answers. It is a gate: it binds a wrong, stale or copied URL and an agent that keeps
the identity it was given, and it does not bind a caller who asserts another name over the
socket, which is 016's recorded limit.

**Carried findings.**

- **`hello` reserves no member names.** `--as runner` joins `runner`; `--as crew` joins `crew`.
  `allowlist.ts` has recorded this as "names are not credentials" since 016, and 018's review
  showed the consequence live: a caller asserting `runner` writes the `refs_set` 018's
  ownership check reads. No authority is lost (the same caller can drop `--as` and be the
  owner), but every future check that treats "an event by `runner`" as something the agent
  cannot produce is wrong. If a real bind is ever wanted, `hello` refusing the reserved names is
  its own small spec, and it has to reckon with the deliberate `--as crew` join `allowlist.ts`
  documents (a live session speaking as `crew` shares the member every spawned run uses).
- **A subprocess handed a card-carried URL may dial it.** `gh pr view <url>` contacts the host
  in the URL, and a poll does so every interval for as long as the card sits there. 018 compares
  the host first. Any later spec that passes a ref from a card to a subprocess should ask the
  same question before the review round that would otherwise ask it.
- **Unverified `gh` behaviours 018 rests on**, recorded rather than accepted: `gh repo view
  --json url` in a fork or with several remotes may name the parent while pull requests target
  the fork, in which case every merge reads as "another repository" and no card lands; `gh pr
  view <url>` ignoring its working directory and `headRepository.nameWithOwner` coming back empty
  were each observed once (2.86.0) and not re-verified; `mergedAt` is assumed set on every merged
  pull request, and the code says "merged" without a time if it is not. `forge.ts` pins the
  version.
- **Killing a hanging `gh` leaves what it spawned.** SIGKILL on the direct child reparents its
  descendants to pid 1, so a `gh` that hangs every tick leaks one orphan per tick for the life
  of the daemon. Recorded in `forge.ts`; a process-group kill is the fix if it ever matters.

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

Many machines wants a shared daemon with distributed runners rather than synced daemons, and the activity feed is already the memory layer provided it is built from what an agent published — both argued in `docs/research/README.md`.
