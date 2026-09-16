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
| 16 | 019 Code is reviewed before the owner sees it (008b) | landed, PR #17 — three review rounds; the milestone's premise that the playbook already looped was wrong |
| 17 | 020 A conflicting pull request asks to go back to Code (008c) | landed, PR #18 — two review rounds; the daemon offers the move and does not make it |
| 18 | 021 The agent inherits what its login needs | landed, PR #19 — the first real card's finding: the runner stripped `USER`, and the Keychain login needs it |
| 19 | 022 A run explores without asking | landed, PR #20 — three review rounds, two on when a turn ends |
| 20 | 023 A question is announced | landed, PR #21 — three review rounds; `none` had no meaning until the first found it |
| 21 | 024 The board explains itself | landed, PR #23 — three review rounds on one rule: whose lapsed claim takes its question with it |
| 22 | 025 Several cards at once | landed, PR #22 — two review rounds, both in teardown; developed in parallel with 023 and 024 from three sessions |
| 23 | 026 The board on one screen | landed, PR #25 — the read-only half after the split; two review rounds; verification failed once on a spec sentence that was never true |
| 24 | 027 Acting from the screen | landed, PR #27 — three review rounds; the shell's directory came from agent-written text, and a pasted newline ran as keys |
| 25 | 028 The runner's name is reserved | landed, PR #26 — two review rounds; the spec's test setup could not work with the runner on, amended |
| 26 | 029 The daemon's wiring is tested | landed, PR #24 — two review rounds; the first found the test helper leaking the shell's settings |
| 27 | 030 The screen starts the daemon | specified |
| 28 | 031 The arrow keys move the cursor | specified |
| 29 | 032 The rest of a day on the screen | planned; after 030 and 031 |
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
  **Decided by 021**, and by accident after all: the first real card failed at `Not logged in`
  with an OAuth login, because the Keychain lookup needs `USER`. 021 passes through a fixed
  short list — `USER`, `LOGNAME`, the four login and endpoint variables, `CLAUDE_CONFIG_DIR` —
  and nothing else; proxy and CA-bundle variables are left out on purpose and recorded there.

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

## 019 — Code is reviewed before the owner sees it

008b, landed as PR #17. The milestone entry said the Code playbook "already instructs its own
review rounds"; it never did, in any version — that sentence came from the spike's playbook. So
the spec built the loop as well as the count. A Code run that meets its contract is followed,
under the same claim and in the same worktree, by a reviewer in a fresh subprocess with a
read-only list of its own (`REVIEW_ALLOWLIST`; `Edit`, `Write` and `NotebookEdit` denied
outright, measured against the pinned harness). The reviewer records a verdict with a new member
primitive, `skelcrew review <id> approved|changes-requested`, which the owner can use too. Changes
requested start a fix run whose brief is the card; approval hands the card on exactly as 014
did; the third changes-requested verdict hands it on anyway, saying what is open. The count is a
number the runner holds for the claim, because a count read off the card would be read from
events any member can write. A run whose ending cannot be recorded now parks the card on the
owner instead of re-entering the queue at once, which closes 015's re-claim loop.

Three review rounds. Round 1: the review playbook claimed a second verdict fails the run (the
contract takes the last). Round 2, both measured against the real harness: a reviewer that raised
its own question and requested changes started a fix run under that question, which could then
raise nothing and would block for an hour; and the playbook's double-quoted findings made the
harness ask on a backtick, so the findings are now single-quoted and the harness check carries a
backticked representative that fails if that ever changes. Round 3 approved with three Minors,
two fixed after the approval and confirmed by the verifier.

**Carried findings.**

- **A restart resets the review budget.** The count lives in the claim's frame; a daemon
  restart releases the claim and the next run begins a new loop. Chosen over a card-derived
  count on purpose; if it ever matters, the count could be written by the runner as its own
  event and read back with the actor check 018's ownership check uses.
- **A background process the Code run leaves alive can record a verdict during the review
  window.** The review contract counts `crew`'s verdicts inside the review run's window, and a
  subprocess the Code run started is `crew`. That is 016's open subprocess limit, not something
  the window closes; what it reaches is an untrue `approved`, which reaches the owner's own
  review of the pull request.
- **Whether the harness can end a session with a permission question outstanding is
  unverified.** The loop's guard excludes the run's own question on reasoning (an ending
  replaces it, and widening the guard would let a run that asked and then finished skip the
  review); nobody has produced the state.
- **"Never an apostrophe in the findings" is enforced by nothing.** A stray apostrophe makes
  the shell fail the `skelcrew review` call with an error the reviewer can see and retry, not a
  permission question, so it costs a tool call rather than the round. A `--file` or stdin path
  for `skelcrew review` would remove the class, but a review run cannot write a file; stdin
  through a heredoc is untested against the harness.
- **`resolve` cannot take an offered move.** An attention request carries its moves, but
  `skelcrew resolve` only clears; the owner takes a move with `skelcrew mv`. Found writing 020;
  a `resolve --move` is a small CLI spec if the two-command dance grates.

## 020 — A conflicting pull request asks to go back to Code

008c, landed as PR #18. The merge poll from 018 also reads `gh`'s own mergeability answer on
every open pull request it polls. A conflict on the card's own pull request raises an attention
request to the owner with the move to Code attached and the fix spelled out: fetch the base,
merge `refs/remotes/origin/<base>` in, resolve, commit with `--no-edit`, push, record the pull
request again. The daemon offers the move and never makes it — this is the first spec to argue
against 018's precedent paragraph and decline the exception, because merging a different pull
request is not a gesture about this card. A Code run gets two exact grants for the two commands,
composed per run from the default branch's name and omitted when that name cannot be written
into a rule or begins with a dash (review round 2 built `git fetch origin --upload-pack=…` from a
flag-shaped name); a rebase is never granted, because it needs a force-push. The harness check
now keeps one list per run kind, so a Spec playbook line naming either command would be caught.

**Carried findings.**

- **Every run is measured against the stale local base.** The runner reads `refs/heads/<base>`
  and never fetches. After a fix run merges `refs/remotes/origin/<base>` in, the next review's
  `git diff refs/heads/<base>...refs/heads/<branch>` includes every commit the owner merged for
  the other card, and 014's commit range records those shas on the card. Reproduced in 020's
  review round 1 and recorded as a limit, with `code.md` §6 telling the fix run to name its merge
  commit on the card so the reviewer knows what is not this card's. The fix is to measure against
  commits reachable from the branch but from neither the local nor the remote-tracking base
  (`git log ^refs/heads/<base> ^refs/remotes/origin/<base> refs/heads/<branch>`), and to tell the
  review playbook the same. It changes 014's contract and 019's playbook together, so it is its
  own small spec, and it becomes due the first time a conflict fix goes through review.
- **A conflict that clears and returns is not said again.** The once-rule is keyed to the note
  since the card entered PR. The owner's queue is right; the feed's last line is stale.
- **The grant and the note can name different branches.** The grant uses the runner's default
  branch; the note uses the pull request's `baseRefName`. Same in every repository seen so far.
- **`git fetch origin <base>` now writes the ref the instruction scan reads**, to origin's own
  value only. No entry on the Code list can move a local branch head, so `push.default =
  matching` cannot push a local base that is ahead. Recorded in `allowlist.ts`; worth re-reading
  if the Code list ever gains a verb that moves `refs/heads/`.
- **`gh`'s conflicting answer was observed on another repository's pull request**, never on one
  of this repository's own, and never through the transition from `UNKNOWN` to `CONFLICTING`.

## 021 — The agent inherits what its login needs

The first real card through a real daemon, 2026-09-14, landed as PR #19. The run ended at
`run failed: Not logged in` before the agent said a word: the runner handed it `PATH`, `HOME`
and skelcrew's two variables, and on macOS the Keychain login the harness keeps needs `USER` to
be found. Measured by hand: the installed binary logs in with `PATH`, `HOME` and `USER`, and
not without `USER`. The agent now inherits a fixed short list from the daemon's environment —
`USER`, `LOGNAME`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
`ANTHROPIC_BASE_URL`, `CLAUDE_CONFIG_DIR` — verbatim, only when the daemon has them, and an
empty value counts as absent. Skelcrew still stores no credential. 012's criterion 13 (exactly
four variables) is superseded, and the 012 finding above is decided.

One review round, approved. Its useful catch: the credential rule went into the Code playbook
alone, but Spec and review runs get the same login, and a Spec run's card body is exported into
the repository by the Code run that follows. All three playbooks now carry the rule.

**Carried findings.**

- **A shell-only credential is now readable to the run that uses it.** A stored login always
  was (`Read` has no path anchor and `HOME` was passed). Every playbook says never to write a
  credential into the repository, the card or a pull request; that is prose, and the only
  mitigation.
- **Proxy and CA variables were left out on purpose.** `HTTPS_PROXY`, `NO_PROXY` and
  `NODE_EXTRA_CA_CERTS` are not on the list; `ANTHROPIC_BASE_URL` is. The next owner behind a
  proxy adds them to the same list in `shim.ts`, which is where the harness pin is recorded.
- **The SDK prints `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` with a stack trace on every run.** It
  reports the five bare tool names 013 pre-allows on purpose. Noise that buries a real error on
  the daemon's console, and it read as a crash the first time; silencing it is its own small
  change.
- **`USER` alone was verified on one machine.** Whether it suffices on every macOS version, and
  whether a subprocess can read the Keychain token without a prompt, are unverified. The
  owner's re-run of card 1 is criterion 7, performed after this landed.

## 022 — A run explores without asking

Landed as PR #20. Three runs on the first real evening asked five permission questions, every
one a read the agent could have done with `Read`, `Glob` or `Grep`. The playbooks now say so:
read with the tools, shell one command at a time, never joined or looped, and say in one
sentence why a command that will ask is needed. The runner keeps that sentence and puts it on
the question as a `why:` line, escaped and flattened, so the owner can answer from the queue
without reading shell.

Review round 1 found the sentence outliving its turn: it was cleared on an answer and at the
session's end, but not when a turn ended on a tool result, so a reason from an earlier turn
stood beside a later command. Fixed by clearing it at every turn boundary; the record's claim
that "the stream carries no turn marker" was false, and is the kind of sentence 013–021 keep
finding.

**Carried findings.**

- **Two questions raised in one turn share one sentence.** One text turn followed by two
  tool calls in parallel gives two questions, each carrying the same `why:`, and the rendering
  reads as if the sentence were about each command. Faithful to the spec, and disclosed; the
  honest rendering for a shared sentence is different from a per-command one. For whichever
  spec next touches the question note.
- **Whether a real Spec run now finishes with no question is the owner's to observe.** The
  claim rests on the playbook being read by a model; the next real card is the test.
- **The harness runs some read-only shell without asking the daemon at all.** Review round 2
  of 022 watched `sed -n 1,60p package.json` run under an empty allowlist without `canUseTool`
  being consulted, while `curl … | sh` did reach it. That is 013's recorded flag-by-flag
  recognition, wider than the daemon's list, and it means the card does not see every command a
  run executes. Not a defect of 022; a note for whichever spec next audits what the harness
  pre-approves, and for the harness check, which only asks whether a command *would* ask.
- **A turn's end is not a single event.** 022's runner found out twice: a sentence outlived its
  turn (round 1), then a sibling tool call's result ended the turn too early (round 2). The
  stream carries no turn marker; the runner counts the turn's tool calls and their results.
  If the driver ever changes what it emits for a denied call, that count is where to look.
- **Sub-agents share the parent's turn.** `Agent` is pre-allowed, and a sub-agent's text and
  tool calls arrive interleaved with the parent's in one stream and one counter, so with two
  sub-agents running at once one's sentence could become the `why:` for the other's question.
  Unverified (no nested-agent probe was built) and no playbook instructs sub-agents; recorded
  by review round 3 so it is not rediscovered as a mystery.

## 023 — A question is announced

Landed as PR #21. A daemon started in a terminal rings the bell and sends one desktop
notification when a request is raised to a human member; a request to an agent is not
announced; a headless daemon sends nothing, and `watch` stays the ping for that owner.
`SKELCREW_NOTIFY=none` turns it off. A notifier that cannot be spawned or exits non-zero warns
once per process. The notifier moved from the CLI into shared, because two readers now use it.

Two sentences in the spec were wrong about existing code, recorded not edited. "010 already
made `SKELCREW_NOTIFY` the notifier's switch" — it had made it a selector, and `none` meant a
command called `none`, so the first version silenced the daemon and made `watch` error once per
question. `none` now means off in the shared notifier, which makes the spec's "`watch` is
unchanged" false for that one value. Review round 2 found the `watch` test helper inheriting
`SKELCREW_NOTIFY` from the developer's shell, so a test could fire a real notification; that
predates 023, from 010, and is fixed.

**Carried findings.**

- **`"none"` is spelled in two packages** rather than exported once.
- **The pseudo-terminal tests use BSD `script`'s argument form** and would fail on a Linux
  checkout. There is no CI, so nothing says so yet.
- **`watch` and the daemon word the same request differently**: the daemon announces the
  note's first line, `watch` the whole escaped note. The spec dictates the daemon's.
- **`shutdown()` does not await an in-flight notification**, and nothing bounds a notifier that
  hangs. The request is on the card either way.
- **The announcer calls `getCard` to read two fields**, which loads the card's whole activity
  synchronously inside the listener. Harmless today.

## 024 — The board explains itself

Landed as PR #23. `skelcrew ls` says what each card is doing in words, in a column between
the phase and the title: `waiting on you: <first line of the note>`, `waiting on <name>`,
`running since <time>`, `interrupted`, `queued`, `archived`, or nothing. `show` leads with a
`now:` line carrying the same text. And a run interrupted by a lapsed lease takes its own
stale permission question with it, so the card returns to the queue by itself instead of
sitting on an answer nobody can give — which is what card 1 did on 2026-09-14 after the
laptop slept.

Three review rounds, all on one rule: whose lapsed claim takes its question with it. The spec
as approved said "raised by the lapsed holder". Round 1 showed that clearing the owner's own
note on a card the owner had claimed by hand, and handing the card to the runner; the
amendment keyed on member kind. Round 2 showed the same hole for an agent member claiming by
hand from a live session. The rule now keys on the runner's own identity — the only member
whose claims are runs — and a daemon with no runner withdraws nothing. Round 3 verified all
three cases live and found no behavioural defect, only that the startup line handing the
runner's id to the sweep had no test: delete it and every check stayed green. The last fix
round added two tests that spawn the real daemon; no fourth review ran, and the verifier
confirmed by mutation that the new test goes red. The lesson for `/spec`: a rule that says
*who* (raised by the holder, held by a human) is a grant in disguise, and deserves the
red-team step's composition check even though it grants no command.

**Carried findings.**

- **The runner's identity is a member name, and nothing reserves it.** `hello` is idempotent
  by name and kind, so a client that says `--as runner` *is* the daemon's runner member: it
  can release or renew the runner's real claims, and now its hand-made question would be
  withdrawn on a lapse. Predates 024; a reserved-name check at `hello` closes it.
- **The status column pads in UTF-16 units**, so a note with wide characters (`日本語`) pushes
  that row's title right. Documented beside the column width; 026 needs a display-width
  measure for the whole screen and this column should adopt it then.
- **The sweep learns the runner's id through a `let` in `main.ts`** assigned after the timer
  is created. Sound today because the block has no `await`; covered by a test rather than
  removed. Creating the timer where the runner is known would make it a `const`.
- **The `endRun` edge is reachable, by a failed release.** `endRun` is synchronous so a lapse
  cannot fall between its request and its release; but when the release itself fails (the
  path `ending.ts` already warns on), the claim outlives the ending and the next lapse
  withdraws the ending's request, including 019's parked note. The card re-runs, visibly.
- **Two tests wait on real clocks** (a 10-second lease plus the 5-second sweep), adding about
  27 seconds to the suite. One 5-second test timeout was seen once in a baseline run and not
  reproduced in five later runs.
- **`show`'s `now:` line cuts the note to 40 characters** even though the whole note is four
  lines below. The spec says "the same status text as `ls`"; if it should differ, the spec is
  the artefact to change.

## 025 — Several cards at once

Landed as PR #22. The runner holds up to `SKELCREW_RUNS` claims at once, default two, each
card in its own worktree with its own subprocess; the scan claims ready cards in id order up
to the free slots; setup (branch, worktree, allowlist read, run log) is serialised through one
mutex the runner owns, and the agent sessions run in parallel; `teardown` waits for a live run
before removing its worktree. Developed in parallel with 023 and 024 from three Claude Code
sessions, one worktree each, merging main before their pull requests: no conflicts, and the
last to land wrote these entries — the carried finding at the end of this entry, answered by
hand before the daemon could.

Two review rounds, both Important findings in `teardown`: it awaited the live run before
checking whether the card had already come back, so a scan that restarted the card held the
serial pump for that whole new run; and its worktree removal ran outside the setup mutex, so
a teardown and a starting run could contend for the repository lock the spec said they never
would. Two spec sentences were wrong about the code, recorded not edited: the release event
cannot trigger the refill scan through `onEvent`, because `released` is emitted synchronously
inside the run that still holds the slot (the settle handler scans instead); and
`SKELCREW_RUNS=1` is 006's *dispatch*, not the whole of 006, because the run is detached at
every slot count.

**Carried findings.**

- **`main.ts` passing `slots` to the runner has no test of its own** — the same gap 024's
  round 3 found for the sweep's runner id, in the same file. Two specs in a row found the
  daemon's wiring untested; `process.test.ts` can cover it, and the next change to `main.ts`
  should.
- **The pump-handle change (a boolean cleared inside the pump) has no test.** The old handle
  passes the whole suite because any later event recovers a dropped job; on a quiet daemon
  there is no later event. A deterministic test would have to pin microtask ordering.
- **The parser test for `SKELCREW_RUNS` was written after the function.** Its red was
  verified by stubbing. Every other behaviour was red first.
- **N runs warn into one stderr, interleaved.** The card is the record; this is the
  operator's console only.

The planning text that preceded landing follows, kept for the catches it recorded.

The goal, stated by the owner on 2026-09-16 after the first real cards: the feeling of a team
of developers working for you, not one contractor. Several cards move at the same time, each
in its own worktree, each with its own agent, and the owner's queue fills from all of them.

What stands in the way is one line of design from 006: the runner's job pump performs one job
at a time. It was right then — the point was to prove claim, worktree and hand-off with no
concurrency to confuse the evidence — and it has held through 019's review loop and 020's
conflict bounce without change. Everything else was built so it could go: a claim is per card,
a worktree is per card (`<data dir>/worktrees/<id>`), a branch is per card, a run log is per
run, the review loop's budget lives in one claim's frame, and every gate the core keeps is a
refusal about one card. Nothing shared between cards holds state in the runner except the pump.

The shape: the runner takes up to N claims, N small and configurable (`SKELCREW_RUNS`, default
to decide — two is a team, one is today), and runs each card's loop in its own worktree with its
own subprocess. The scan claims the oldest ready cards up to the free slots; a card whose run
ends frees its slot on the next scan. `stop()` tells every live run to stop and waits for all.

Catches to settle in the spec, each found by reading the code rather than guessed:

- **Git is one repository.** `git worktree add` and `worktree prune` take the repository lock;
  two runs starting at once can collide. Serialise the *setup* steps (branch, worktree, allowlist
  scan) through one queue and run only the agent sessions in parallel, which is where the time
  goes.
- **The allowlist scan reads one ref** (`refs/remotes/origin/<base>`) and 020's fix run fetches
  it; a fetch during another run's scan is a read of a moving ref. Say whether that matters.
- **The daemon's own stderr is one stream.** N runs warn into it interleaved; the card is the
  record, so this is only the operator's console, but say so.
- **The merge poll and the sweep are already per card** and need nothing.
- **A single owner answering N questions** is exactly what 023 and 024 exist for; this
  milestone should land after them, and after 022 has cut the questions down.
- **The alive-but-stuck gap** (CLAUDE.md's Gas Town paragraph, herdr's three answers) gets N
  times wider with N runs and is still not this milestone's.

Out of scope for it: a second runner or a second machine (the internal seam, "Later");
scheduling by priority or dependency between cards (they order by readiness, oldest first, as
today); any change to gates, contracts or playbooks.

**Carried finding, from this session's own workflow.** One Claude Code session runs one
`/develop` at a time for the same reason the runner does: it sits in one worktree and its
subagents inherit that. Parallel development of the repository today means a second session.
The daemon is where the parallelism should live, which is this milestone.

## 026 — The board on one screen

The TUI, decided 2026-09-16 after the first evening of real use and a sketch of three shapes.
Rows, never columns: cards render as rows with a phase track, as the settled architecture says,
and the owner's own reason is the practical one — columns are awkward in a terminal, and moving
between them is work the row layout does not ask for. Of the three shapes sketched (an inbox
over the board; a board with a live pane for one card; a room with one pane per running agent),
the first is the one to build, with one element borrowed from the third.

**One screen, two halves, live.** The top half is the queue: what is waiting on the owner, one
row each, with the card, the note's first line (022's `why:` where there is one), and the
answers as single keys — `a` allows, `d` denies, `m` takes the offered move, `b` sends back,
`Enter` opens the card. The bottom half is the board: every card as a row with its phase track,
its status in words (024), and its title. Both halves redraw from the daemon's activity
subscription, which `watch` already consumes; the TUI is a renderer over the same stream and a
client of the same socket, holding no state of its own.

**A running card's row shows the agent's last line.** The most recent text turn or tool
summary the run posted, cut to the column, so the board moves while the crew works and a row
that has not changed in ten minutes is a run worth looking at. This is the one thing 024's `ls`
deliberately omits, because it needs the feed and `ls` does not fetch it; the TUI has the feed,
so it carries it. With 025 in place several rows move at once, which is the team feeling.

**The exit ramp is a key.** `o` opens the selected card's worktree in a terminal; every attention
note already names the path.

What it is not: a kanban, a place to write specs (the card's body is written by a run or by
`skelcrew body`), or a second way to do anything the CLI cannot. Every key maps to one CLI call,
so the two never disagree about what a gesture means.

Catches for the spec to settle: where status is derived (024 derives it in the CLI's renderer;
if the TUI recomputes it, the two can drift — move the derivation into the shared package, or
have the TUI import the CLI's); the terminal library, on Bun (card 2's Spec run was probing
raw-mode support on 2026-09-15, and its spec is the input here, not the plan — it was written
before 022–025 and by an agent that was itself stopping every few minutes); and the per-card
"last line", which the daemon does not keep and the TUI must build from the feed it subscribes
to, so a TUI started late replays from `--since`.

Order: after 022, 023, 024 and 025. A screen over a loop that stops silently is a nicer view
of the same problem; after those four it is the thing that makes the tool feel like watching a
team rather than debugging one.

**Design choices, decided by the owner on 2026-09-16, and a spec that breaks one is wrong:**

- **Opinionated defaults, almost no config.** One way to do things, chosen well. A settings
  screen with twenty toggles is a failure. If a config file is ever needed, it is tiny and
  human-readable; until then there is none, and the environment variables the daemon already
  reads are the whole of the configuration.
- **Keyboard only, vim-flavoured.** `j`/`k` to move, single-key actions, `?` shows the keys. No
  mouse affordances, no navigation that needs the arrow keys.
- **Fast and quiet.** Instant startup, no spinner theatre, no progress bars for things that take
  200 ms. The status view looks calm with five agents running: rows change, nothing flashes.
- **Fits the terminal it runs in.** It respects the terminal's theme rather than shipping its own
  colours, looks right in Alacritty or Ghostty at a normal font size, and keeps unicode box
  drawing restrained. The Omarchy aesthetic is the reference.
- **Legible.** The owner should be able to read the source in an evening and understand the
  loop. A small codebase, few dependencies, one language — which is also what the repository
  says about itself, and what pi got right.

Landed as PR #25, the read-only half after the split. Bare `skelcrew` in a terminal opens the
screen: the queue over the board, rows and a phase track, `j`/`k`/`g`/`G` for the cursor,
`Enter` for the card view, `?` for the keys, `q` to leave, redrawn as events arrive, with a
running card's row carrying the agent's last line. Piped, bare `skelcrew` is still the queue.
No colour escape, no configuration, no dependency: `packages/cli/src/board/` is a model, a pure
frame, a pure reducer and one terminal loop, about 800 lines with their tests beside them.

Two review rounds. Round 1 found a Critical, reopening a card showed a stale feed, and an
Important, wide characters wrapped the frame and scrolled the screen; both fixed and confirmed
against the real binary under a pseudo-terminal. Round 2 approved. Verification failed once on
criterion 2's wording alone: the spec said piped bare `skelcrew` "prints the usage and exits
2, as it does today", and it never did — 010 made it the queue and a test pins it. The
orchestrator corrected the sentence in the worktree and verification passed on the rerun.

**Workflow finding, the spec's.** That sentence was written from memory of the CLI's
no-command path instead of running it. `/spec`'s step 1 says to read the real files and check
real behaviour; a claim of the form "as it does today" is exactly the kind that costs nothing
to run and a verification round to get wrong. Two specs in a row (024's "in the same
synchronous mutation", 026's "prints the usage") made a present-tense claim about the code that
was false; both were caught late. For `/spec`: every "today" sentence names the command or test
that shows it.

**Carried findings.**

- **The status column pads in UTF-16 units and `cut` counts code points.** Carried from 024;
  026 pinned `row` and `status` unchanged, so it stays open. 027 touches the board's rendering
  and is where a display-width measure belongs.
- **The status line has no producer yet.** A failed card read ends the whole screen instead of
  saying so on the line. 027 gives the line a producer with the refusal messages.
- **Cards first seen through an event are stored with their whole feed.** Memory grows with a
  long session; harmless at this scale.
- **The queue half is re-sorted by `raisedAt`** while the daemon orders by event sequence; two
  requests in one millisecond could swap.
- **`skelcrew --json` with no command on a terminal stays `queue`.** The spec does not say
  either way.
- **015's tripwire now allows one more file to spell the escape character**, `board/ansi.ts`,
  and became stricter about that file. Two reviewers judged it necessary.

## 027 — Acting from the screen

The second half of 026, split out on 2026-09-16 a minute into 026's first development run,
before anything was built. 026 is the screen read-only: open, watch, move, open a card, leave.
027 puts the answers on the keys — `a`, `d`, `m`, `b`, `c` — with the one-line message prompt,
and `o`, the exit ramp into a shell in the card's worktree. Every key is one CLI call through
the same client the commands use.

Why split: one large diff reviews worse than two small ones. 024 took three review rounds on
one rule in a small diff; a screen's plumbing (raw mode, redraw, the subscription) and the keys
that change cards are separable, and the plumbing should be reviewed on its own first. 026's
tripwire that the board module makes no mutating call is removed by 027 and replaced by a table
of every action against the call it makes.

Landed as PR #27. On the selected row `a` allows, `d` denies after an optional message, `m`
takes the request's offered move, `b` sends the card back a phase with a message, `c` comments,
and `o` leaves the screen for a shell in the card's worktree and comes back. A one-line prompt
at the bottom is the screen's only text input. Every key is the call the CLI command makes,
and a refused call puts the daemon's message on the status line.

Three review rounds, the first two each finding one Important. Round 1: the shell's directory
for `o` came from a request note, which an agent writes, with no check that the path lay under
the runner's worktrees root; and a path that existed but was a file crashed the screen. Fixed
with a containment check and a nine-row table over crafted notes. Round 2: a pasted chunk with
a newline sent the prompt and then ran the rest of the chunk as board keys — `hi\nallow` posted
a comment, allowed the request and opened a shell. Fixed: a chunk ends where the prompt closes.
Round 3 approved by execution. Two spec sentences were not literally true and are recorded:
five 026 tests changed under new types, none loosened; and Ctrl-C is interpreted in the prompt.

**Carried findings.**

- **Pasting onto the board with no prompt open runs every character as a key.** The reviewer's
  paste moved and allowed a card. Bracketed paste mode is the fix and its own small spec.
- **The tail of a pasted chunk after the prompt's Enter is dropped silently.**
- **A note naming the worktrees root itself passes containment** and opens a shell there.
  Strictly-under would match the doc comment.
- **The three empty prompts behave differently**: empty `c` makes a round trip the daemon
  refuses, empty `b` moves with no comment, empty `d` denies.
- **A refused call loses the typed text**, because the prompt closes before the call; and a
  refused comment after a successful move shows the raw error where `mv` wraps it.
- **A daemon lost while the owner is in the `o` shell prints the error into the shell.**
- **The raw Backspace bytes have no loop-level test**; the verifier drove them by hand.
- **The status column still pads in UTF-16 units.** Carried from 024 and 026; 027 did not
  touch the row after all. Open for 032.

## 028 — The runner's name is reserved

024's round-3 finding: a client that says `hello` as an agent named `runner` is handed the
daemon's own runner member, because members are found by name and kind and created when
missing. It can then release or renew the real runner's leases, and after 024 its own lapsed
claim takes its question with it. The daemon refuses that `hello`; `crew` stays joinable,
because spawned agents join as it over the socket. A gate, not a boundary: the socket is local
and the owner's `hello` needs no credential. 024's two daemon-level tests, which impersonate the
runner to make a lapsing claim, are rewritten to pre-make the claim in the data directory
before the daemon starts — which is a restart after a sleep, the scenario 024 was for.

Landed as PR #26. `hello` as an agent named `runner` is refused with a message saying the
member is the daemon's own; the name is compared after the same trim the core applies, so
`" runner "` is refused and `"Runner"` is another member; the daemon reserves the name whether
or not the runner is on, and hands it to the server as a list so the server never imports
from the runner. 024's two daemon-level tests set the runner's state up through the core on
the data directory instead of impersonating it.

One spec sentence was wrong and is corrected inline: with the runner on, a claim pre-made
before the daemon starts is never swept, because the runner releases every claim of its own at
startup (006's rule). The runner-on test takes the claim through the core after the daemon is
listening, still never over the socket.

Two review rounds. Round 1's Important was procedural: the orchestrator's spec amendment was
uncommitted, so the branch's commit contradicted its own criterion; the repository's rule is
that an amendment lands with the change. Round 2 approved after mutating the trim, the
reservation and the runner-on condition, and reproducing the timeout that forced the
amendment. A test now observes the refusal with the runner on, which is the case the spec was
written for; the daemon-off case alone had let a `main.ts` that reserved only with the runner
off pass every check — 029's rule, one spec later.

**Carried findings.**

- **`bun:sqlite` opens with `busy_timeout` 0.** A second connection's write during another's
  transaction throws "database is locked" at once, with no retry. Measured by 028's reviewer:
  a write straight after the daemon's "listening" line collided in 1 of 25 runs; after the
  socket round trips, 0 of 50. The rewritten 024 test sits after the round trips and says so.
  A second writer on the daemon's file is now a supported test shape, so a `busy_timeout` in
  `openDb` is worth its one line; a production change, so not 028's.
- **The default of a gate is open.** `reserved` was optional on `startServer` and defaulted to
  nothing reserved; made required in fix round 1 so a second entry point must state its answer.
- **Two wall-clock sweep tests flaked once each under load** during 028's and 029's runs (the
  024 sweep test and the 006 sweep test, both budgeted lease plus 20 seconds against a 5-second
  sweep). Each passed on rerun and in every full check. With four such tests in one file now,
  a loaded machine will hit one; the budget or the lease is the knob.

## 029 — The daemon's wiring is tested

The finding 024 and 025 made on the same day: the startup file hands settings to parts, every
part is tested with fakes, and deleting a handoff leaves every check green. 024 covered its own
line; 025's `slots` is still uncovered. This spec observes `SKELCREW_RUNS=1` through the real
daemon — the second card is claimed only after the first is released, an ordering on the cards
— and writes the rule into `main.ts`: a setting that crosses the file is observed by a test that
starts the daemon, or the comment beside it says why it cannot be. The run limit cannot be,
under `none`; it is observed against the run instead, and a test-only driver is rejected.

Landed as PR #24. Two process tests start the real daemon and show `SKELCREW_RUNS=1` claims
the second card only after it has released the first, while the default claims both at once;
the startup file states the rule at its top and every handoff names its test verbatim, the
data directory and the announcer included. `main.ts` changed in comments only.

Two review rounds. Round 1 found the test helper leaking `SKELCREW_RUNS` from the developer's
shell: an exported `1` broke the control test and an exported `4` would have let it pass while
testing nothing. Both helpers in the process tests now strip all seven settings the daemon
reads unless the test sets them. Round 2 approved after mutating four of the five handoffs and
confirming each named test fails, and proving the startup file comments-only by transpiling
both versions and diffing.

**Carried findings.**

- **A pre-existing sweep test is load-sensitive.** "with `SKELCREW_RUNNER=0` a lapse withdraws
  nothing" (024) timed out once at 30 seconds under the reviewer's parallel runs and passed on
  every other run. Its budget is the lease plus 20 seconds against a 5-second sweep; a loaded
  machine is where it bites.
- **The comments quote test titles, and nothing enforces the link.** A renamed test silently
  stales a comment in `main.ts`. A tripwire that greps the titles is possible; not worth it
  until it goes stale once.
- **Test helpers that spawn the daemon must strip every setting the daemon reads.** Found by
  023 (`SKELCREW_NOTIFY`) and again here (`SKELCREW_RUNS`, `SKELCREW_RUN_MINUTES`); the rule is
  now in both helpers' doc comments. A new setting has three places to add itself: the
  parser, the startup file's comment, and the helpers.

## 030 — The screen starts the daemon

Found the first time the owner typed `skelcrew` after 026 landed: `no daemon is listening`.
The screen is meant to be the default experience, and it costs two terminals to open — one for
`bun run daemon`, one for the board — which is more than the positioning allows (adding a card
must cost less than opening a terminal tab). Decided by the owner on 2026-09-16: there is one
command. `skelcrew` in a terminal starts the daemon when none is listening and opens the screen
over it; `skelcrew --headless` is the daemon alone, in the foreground, for an always-on machine
or a second terminal; `bun run daemon` goes away.

The daemon stays the product and the client stays thin: the CLI starts the daemon as a child
process and never loads its code, so the SDK stays out of the CLI's process and the internal
seam is untouched. What the spec has to settle is the daemon's life. The rule chosen with the
owner: **a daemon the screen started stops itself when nothing needs it** — no client connected
and no run live — so `q` with nothing running takes the daemon with it, and `q` with runs in
flight leaves them to finish and says so on the way out. A `--headless` daemon never stops
itself. Three catches, read off the code: the daemon's stdout is no longer a terminal under the
screen, so 023's bell and desktop notification are off there (the screen shows the request;
`watch` stays the ping; a ping from the screen is its own small spec); 018's merge poll stops
with the daemon, so a merged pull request lands in Done the next time the screen opens rather
than within a minute; and the daemon must outlive the terminal it was started from while a run
is live, or closing a window becomes a `run_interrupted`.

Piped and scripted invocations — every command, `watch`, bare `skelcrew` without a terminal,
and therefore every agent — never start a daemon. Their error keeps saying what to run.

## 031 — The arrow keys move the cursor

Asked for by the owner on 2026-09-16, the first day of using the screen: `Up` and `Down` beside
`k` and `j`, the way they work in nvim. 026 put arrow-key navigation out of scope by decision,
and its design choice — no navigation that *needs* the arrow keys — still stands: `j`/`k` keep
working everywhere and nothing is reachable by arrows alone. The decoder in `board.ts` today
drops every escape sequence; 031 reads exactly the four byte sequences the two keys send and
maps them onto the moves the reducer already makes. In the prompt they do nothing and never
become text. `Left`, `Right`, `Page Up` and the rest stay uninterpreted.

## 032 — The rest of a day on the screen

What the owner still leaves the screen for after 026 and 027, listed on 2026-09-16 while 027
was being built. (Numbered 030, then 031, in this session's drafts while another session took
those numbers for the daemon start and the arrow keys; the sequence records the order specs
were written, so this one is 032.) Starting a card by hand (Idea into Spec, an approved Spec
into Code) and adding one come first here unless 027 or 030 turn out to carry them: starting a
card is the gesture the owner makes most, and 027's `m` takes only the move a request offers.

The rest, in the order they matter:

- **Edit a card.** The title, and the body, which is a spec, so this is "open it in `$EDITOR`"
  rather than typing in the screen: leave the screen, run the editor on the body, come back,
  send it with one `body` call. The same shape as 027's `o`.
- **Archive.** One key on a Done or dead card. Out of scope in 026 by decision; one call.
- **The live feed as a view.** `watch` inside the screen, every event scrolling, for when the
  owner wants to see the crew work rather than the board. The subscription is already there;
  this is a third view beside board and card.

Two things stay out until the board is bigger than a screen: filters (hide Done, show only what
waits on the owner) and search. A cost line per card needs the daemon to record cost first and
is its own milestone, from the Claude Tag notes.

Constraints carried from 026: every key is one CLI call; no colour, no mouse, no configuration;
the frame and the reducer stay pure and tested without a terminal. The display-width finding
(the status column pads in UTF-16 units) should be closed by 027 or here, whichever touches the
row first.

## Later, deliberately unplanned

GUI, maybe (the TUI is 026). Remote clients watching a daemon on an always-on machine. Second
runners and hosted runner tiers over the internal seam. Teams — hosted multi-human mode (auth,
tenancy, sync). Multiple repositories per daemon, notification channels beyond the local ping
(`watch`'s since 010 and the terminal daemon's since 023: Slack, email, push), card attachments,
and per-repo override of the built-in phase playbooks (users supplying their own spec/develop
skills; skelcrew ships the workflow until real use demands customization). Grouping cards
into milestones or projects: deferred until 008, when skelcrew builds skelcrew and this file
either becomes cards or shows what a grouping entity would have to add. None of these may
be pulled forward into an earlier spec's scope: the product is optimized 100% for a single
owner until the solo loop proves itself.

Many machines wants a shared daemon with distributed runners rather than synced daemons, and the activity feed is already the memory layer provided it is built from what an agent published — both argued in `docs/research/README.md`.
