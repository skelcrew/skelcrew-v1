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
| 8 | 011 Which refs a run set; spec export bookmark | landed, PR #9 |
| 9 | 012 Spawn an agent, show what it does | landed, PR #10 |
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

Findings from reading two neighbouring harnesses end to end (2026-09-10): herdr, a terminal
runtime that owns agents' panes and has no work item at all, and orca, which is the closest
thing to a controlled experiment against skelcrew's design. Orca's model — Run → Task →
Dispatch in SQLite, an attempt carrying a spec, artefacts checked against git — is nearly
skelcrew's, with one substitution: **an agent orchestrates.** A coordinator agent decomposes the
work, dispatches the workers, answers their questions, and resolves the decision gates — the
`decision_gates` table has no human column and no UI to answer one; the human arrives at review.
Skelcrew puts the phase table where that agent sits, and the owner where its gate-resolve call
sits. Nearly everything below is downstream of that one difference: orca must make a plan held
in a context window survivable, and skelcrew's plan is rows. Both harnesses also arrived
independently at the CLI-as-agent-surface delivered as a skill, at worktree isolation, and at
durable identity over disposable runs — corroboration rather than news. What follows is what
they know that skelcrew's entries did not yet say:

- **An outcome is derived from evidence, never reported (014).** Orca never stores "this
  attempt succeeded". It appends observations on separate facets — is the process running, did
  files actually change under git, did the worker send a report, did the terminal exit — each
  stamped with which host observed it and when, and projects the outcome from all of them. The
  projection has a state 014 currently lacks a name for: *finished but unverified*, the run
  ended and no report was ever accepted. That is exactly the spike's failure — "branch ready for
  review" over zero commits — generalized past the one case 014 checks. 014's contracts are
  already the right predicates; the finding is that the phase's status should be *computed from*
  them at completion rather than written when an agent claims an ending, and that the unmet
  conditions are the reason attached to the attention request, not a separate bookkeeping flag.
- **Evidence goes stale, and not knowing is never permission to act (009).** Orca degrades a
  `live` observation older than its freshness window to `unverifiable`, and holds one rule over
  every recovery path: absence authorizes nothing — not stop, not retry, not release. Only a
  positive verdict does. 009 currently reads a lapsed lease as grounds to re-queue, which is the
  opposite reading: the lease lapsing means *the daemon stopped hearing*, which on a slept laptop
  or during a long non-heartbeating step is not death. The visible `run_interrupted` event is
  still right; what needs saying is what it asserts. Re-queuing on absence is defensible for a
  single-player local daemon — but only once the next finding is true, and it should be a stated
  decision rather than an unexamined default.
- **A lapsed claim must be fenced by the core, not by the run's own diligence (009/012).** 012
  has the run re-check its claim after every git call and 014 forbids writing to a card whose
  claim was lost — both rely on the run behaving. Orca fences from the other side: every
  re-point of an attempt bumps a generation counter, and the displaced worker learns it lost
  through a distinct error on its next call (`consumer_fenced`), which its playbook answers with
  stop, do not report, do not retry. One integer on the claim and one dedicated error code across
  every mutating verb make the re-check an optimization instead of the guarantee, which matters
  because the case that breaks discipline is exactly the run that stopped heartbeating.
- **A retried command must not act twice (004).** Every orca mutation takes a request id and
  the daemon remembers which ones it has completed, so a lost response replays to the original
  receipt instead of claiming twice or double-posting. Their guidance is explicit that a caller
  whose response vanished must ask what happened rather than replay blind. Agent members make
  this sharper than it is for humans: a person re-reads the card first, an agent just runs the
  command again.
- **The last thing a run does before finishing is read its card (012/013).** A comment does not
  interrupt a running agent, so mid-run feedback only lands if the agent looks. Orca's worker
  contract requires a check at natural checkpoints *and once more immediately before reporting
  done*, so a redirect arrives before the phase settles rather than after it. This is a line in
  a playbook, not machinery, and it is what makes 012's streamed card comments actually
  load-bearing for feedback rather than only for answering questions.
- **A playbook is a short kernel plus pages fetched at named decision points (012).** Orca's
  orchestration instructions are a two-page kernel that always loads — role, authority, the
  safety floor, the loop — followed by a table mapping situations ("a failed or unknown attempt",
  "a remote host") to reference pages the agent pulls only when it is in that situation, served
  by the binary itself so guidance and CLI cannot drift. Their recovery page is a table of
  *proven state → safe action*, which is a far better artefact for an agent than prose. Two
  things to copy when the playbooks get extracted from `.claude/`: the kernel carries an explicit
  safe-failure default (preserve work, report unknown, act only on positive proof), and the
  daemon serves them so a playbook can never describe a CLI the daemon no longer has.
- **Nobody has a good answer for alive-but-stuck except watching it (012/013).** AGENTS.md
  names this as the one Gas Town part with no counterpart here, and both neighbours confirm it:
  each solved it by observation rather than trust. Herdr classifies every pane `working |
  blocked | idle | done | unknown` from ~21 hot-updatable manifests of regexes matched against
  a bottom-of-screen snapshot, and orca keeps process liveness and agent liveness as separate
  verdicts because a live terminal can hold a dead agent. Herdr needs that machinery only
  because it does not own the spawn; 013's `canUseTool` covers the same ground properly for
  everything the agent can report. The residual case is the one it cannot — the harness blocking
  below the agent — where owning the subprocess makes silence on a live process the cheap signal,
  and the permission posture 013 settles is the real fix.
- **What the coordinator agent costs (008).** Orca's orchestration is ~24k lines over a schema
  rebuilt 40 times: durable typed mail between workers, mailbox fencing, idempotent mutations,
  federation to remote hosts, takeover of adopted runs, a whole compatibility lane for attempts
  started under an older contract. Almost none of it is the price of orchestration — it is the
  price of a plan that lives in a context window and must stay reconstructable when that context
  dies or goes wrong. Rows do not need reconstructing, so the bill does not transfer: the
  findings above come to a few hundred lines between them. Worth remembering when 008 tempts a
  card into dispatching other cards.
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
- **A playbook that restates the allowlist can lie, and nothing catches it (012).** `code.md`
  spells out the fixed list in prose — the tools, the read-only git verbs, the four CLI verbs —
  so the agent knows what it may do unprompted. That is a second copy of `allowlist.ts`, and
  editing one silently falsifies the other; the failure surfaces as an unexplained denial
  mid-run. gstack (garrytan/gstack, a pure playbook library with no runtime, read 2026-09-10)
  hits the same problem across 23 skills and answers it by generating the docs from the source
  and failing CI when the committed file drifts. The cheap version here needs no generator: a
  test that reads every playbook, extracts each `skelcrew <verb>` and each tool named, and
  asserts the verb exists as a CLI command and the tool appears in `FIXED_ALLOWLIST`. It is
  free, model-free, milliseconds, and belongs in `bun run check`. Everything lines up today —
  the test is to keep it that way.
- **Playbook wording needs a test strategy, and tiering is how it coexists with the constraint
  (012, and the playbook extraction).** Nothing currently tells us whether an edit to a playbook
  made runs better or worse. gstack runs three tiers: free static validation on every test run,
  a real-agent end-to-end pass and an LLM-as-judge score on the prose, the latter two gated
  behind an env var, with results persisted per run so two runs can be diffed and flakes ranked.
  That shape keeps *tests never spawn real coding agents* true for `bun run check` — the default
  suite still fakes the driver — while giving playbook changes something better than taste. Tier
  one is the bullet above and is worth building now; the rest waits until there are enough
  playbooks for prose regressions to matter.
- **The playbooks share an opening, and it should exist once (the playbook extraction).** Both
  files restate the same framing — one agent on the crew, everything visible on the card, every
  step through the CLI, nothing is a conversation. Fine at two files, drift at five. gstack
  factors this into one injected preamble and, more usefully, specifies its *degraded* behaviour:
  when the preamble's own runtime is missing, apply named safe defaults and carry on with the
  task rather than stopping. A skelcrew preamble needs the same clause for a daemon that does
  not answer. Its errors deserve the same treatment: gstack writes every error for the agent
  rather than the reader ("not found — run `snapshot -i` to see what is available") and orca
  hands back the literal next command, which is what makes 013's denials and 009's lost claims
  recoverable instead of merely reported.
- **A question the agent raises needs a fixed shape, not just a verb (010/013).** `spec.md` says
  to raise an undecidable decision with `skelcrew attention <id> "<the question, with the
  options>"` and leaves the rest to the agent, so the quality of what the owner reads varies run
  to run. gstack gives every skill one house format — context, the question, an explicit
  `RECOMMENDATION: choose X because …`, then lettered options — and it is the recommendation
  that does the work: it turns a question into a decision the owner can confirm at a glance
  instead of a prompt they have to reconstruct the reasoning behind. 010 already requires an
  attention request to carry its resolving choices; this says what the *body* should look like,
  and 013 is where the same shape has to cover a permission the agent is asking for. Worth
  specifying once, in the shared opening, rather than per playbook.
- **The playbooks are all procedure and almost no judgment (the playbook extraction).** Both
  files are read this, run that, post here — correct, and thin where it matters. The one line of
  judgment in either of them is the most valuable sentence in both ("a truthful partial run is a
  good outcome; a fabricated complete one is the worst thing you can produce"), and there is
  room for more of that kind. gstack keeps this separate and shared: an `ETHOS.md` of principles
  — how to weigh completeness, search before building rather than inventing, what to do when
  first principles contradict the convention — injected into every skill ahead of its own steps.
  Splitting skelcrew's playbooks the same way gives three layers rather than two: the repository
  contributes its constraints through `AGENTS.md`, skelcrew contributes how the crew works and
  what good work looks like here, and the phase file contributes only its own steps. That split
  is what stops the shared half being copy-pasted per phase, and it is the natural first move
  when the playbooks come out of `.claude/`.
- **A run's ending should be one of a few named statuses, not prose (012/014).** Every gstack
  skill closes with `DONE`, `DONE_WITH_CONCERNS`, `BLOCKED` or `NEEDS_CONTEXT`, in a fixed shape
  — status, reason, what was attempted, recommendation — plus a stated escalation trigger: after
  three failed attempts, for anything security-sensitive, or for scope the agent cannot verify.
  `spec.md` currently asks for a comment carrying goal, approach and criteria count, which is
  prose the daemon cannot act on. This is orca's typed outcome reached from the playbook side,
  and it is what lets 014 read an ending rather than parse one; `DONE_WITH_CONCERNS` in
  particular has no equivalent here, and it is exactly the run the owner most needs flagged.
- **A claimed limitation is a material claim and needs evidence (012/013).** gstack's rule: an
  agent saying "the API can't do this", "that needs a credential", "permission denied" must hold
  the verbatim error, the documented statement, or a live probe — pattern-matching a failure to
  a familiar story is not evidence — and when a cheap probe would settle it, the probe runs
  *before* the agent declares itself blocked or asks the owner. This is aimed precisely at the
  spike's worst outcome, an agent that hit a wall, stopped, and reported something not quite
  true. It belongs in the shared opening, and it makes 013's denials legible: a denial the agent
  quotes is a fact the owner can act on, a denial it paraphrases is a story.
- **A review finding must quote the line that caused it, or be demoted (the review phase).** The
  strongest single idea in gstack, and it is for the phase skelcrew has not written yet. Before
  a finding reaches the report the agent must quote the specific code that motivated it — file,
  line, verbatim text; "field X is missing from model Y" requires quoting the class body where
  it would live. A finding whose motivating line cannot be quoted is forced to low confidence
  and dropped from the main report, kept only in an appendix so calibration can be audited.
  Findings carry a confidence score with explicit display rules (high shown plainly, medium
  shown with a caveat, low suppressed), and the mirror rule covers the other direction: claiming
  something is safe requires citing the line that proves it, and "likely handled" or "probably
  tested" is never an acceptable phrase. gstack ships the list of false-positive classes this
  kills, measured on a real project. A reviewer whose findings are unfalsifiable is worse than
  no reviewer, because the owner has to check each one by hand.
- **Conditional wording in a playbook reads as optional — make the step unconditional and require
  an explicit empty result (the playbook extraction).** gstack measured this: 43 of 44 durable
  learnings came from users invoking the command explicitly, because "if you discovered
  something" read as skippable. The fix was to make the step always run and to require the
  agent to state "none this session" when there is nothing — an explicit empty result rather
  than a silent skip. Both skelcrew playbooks are built on conditionals ("if either exists", "if
  you cannot finish"), and the same reading applies to every one of them. This is a rule about
  *writing* playbooks, with evidence behind it, which is rare enough to record.
- **Every finding gets an action, and the questions arrive as one batch (the review phase, 013).**
  gstack's review classifies each finding auto-fix or ask, applies the auto-fixes immediately,
  then puts every remaining ask into a single question — numbered items, a recommended fix each,
  one overall recommendation — rather than returning a list for the owner to triage. Two places
  this lands here: a review cycle inside a phase should end in changes plus one decision, not a
  report; and 013's asking should batch what it can, because a run that stops the owner five
  times is worse than one that stops them once with five things.
- **Read the code before asking anything, and connect the two (012).** gstack's spec skill makes
  it a precondition: before any technical question the agent must have read real evidence and
  cited `path:line`, and it must not ask what the code already answers. It also fixes the shape
  of interrogation — three to five questions per round, numbered, always last in the message, and
  assumptions called out explicitly. `spec.md` says to investigate in section 1 and to raise
  undecidable questions in section 2, but never joins them, so nothing stops a question the
  repository could have answered.
- **Depth arrives as sections loaded at their step, never as a longer file (the playbook
  extraction).** For scale: gstack's playbooks total roughly 39k lines — its review skill is 976
  and its spec skill 932 — against 146 lines for both of skelcrew's. The gap is the point: phase
  quality is mostly playbook depth, and the current two are a sketch. But the depth is
  structured. Long skills are a skeleton plus a section index — "read this section in full
  before doing its step; do not work from memory" — with literal STOP markers before the steps
  that matter, and the spec skill carries fourteen numbered quality standards for the artefact
  (verified current state, testable acceptance criteria, file reference table, root cause
  analysis, rollback strategy) where `spec.md` has five bullets. That is the same conclusion orca
  reached from the other side, and it is how these files should grow.
- **Attention is derived from facts, and it is a set (010/014).** Orca stores no "needs
  attention" flag. It projects one from the attempt's facts every time it is read, as eight
  named categories — guidance, input, approval, failure, interruption, stale, unverifiable,
  root_completion — of which only some make `requiresAction` true; `stale` and a root's
  completion are informational and demand nothing. A row can carry several at once. Skelcrew
  keeps one attention record per card and queues the rest, which is the right call for one
  owner, but the *derivation* is the transferable half: whether a card is waiting on its owner
  follows from facts the daemon already holds — the claim lapsed, an artefact condition is
  unmet, the agent asked, the run failed — and computing it beats writing it wherever someone
  noticed. Two rules are commented in that function as scar tissue, and both are cheaper to
  copy than to rediscover: a dispatch that settled with no worker row reads unverifiable but is
  "a statement about supervision that never existed, not work owed"; and a proven exit must
  suppress unverifiable, because showing both told readers to keep waiting on a worker already
  known to be gone — a proven exit is evidence, not absence.
- **Remove a worktree by renaming it into a trash sibling, then deleting in the background
  (006).** `git worktree remove` deletes the whole checkout inside the call — usually a
  multi-gigabyte `node_modules` — which cost orca an 8-35 second freeze, so it renames the
  directory into a hidden sibling trash root instead (metadata only, guaranteed same volume,
  a nonce in the name so concurrent removals of same-named worktrees cannot collide) and sweeps
  it later. The speed is the smaller half here. Skelcrew's rule is that a dirty worktree is
  salvaged and never force-removed; a rename step makes salvage the default for *every* path,
  because the checkout still exists until the sweep runs, so a wrong call about cleanliness
  stops being destructive.
- **A worktree should carry provenance, because a path is an assumption (006/012).** Orca
  stamps creation time, a creation source (desktop, runtime, cli, ssh) and creator provenance
  into each worktree's metadata, so removal can ask whether it created this checkout before
  touching it, and it has a separate module that *proves* an orphaned git directory rather than
  inferring one from a path. 012's runner identifies its own worktrees by the
  `<repo>/.skelcrew/worktrees/<id>` convention and reconciles them at startup — which is a
  convention anyone can land in, by hand or by a stale copy, and a startup sweep that deletes on
  a path match is one collision away from removing something it did not make.
- **What is lost from a card if the daemon dies mid-run (012).** Orca's agent hooks post status
  to the daemon over HTTP and, when that endpoint is unreachable, append the event to a spool
  file on disk — pane key, worktree id, launch token, hook version, source, timestamp, payload —
  to be replayed later, with a guard that drops any record too unattributable to place. Skelcrew
  streams the agent's events straight into the daemon and writes the transcript to a file the
  run owns, so the transcript survives; the card's activity for the window between the last
  write and the crash does not. Worth deciding deliberately rather than discovering: either the
  transcript is authoritative enough to rebuild the card's activity from, or a run's events need
  somewhere to land when the daemon is not there to receive them.
- **Many machines wants a shared daemon, not synced daemons (Later — teams).** Teams are the
  intended destination, and the instinct when a team appears is a backend that keeps each
  member's harness in sync. Split what would be synced first. Comments, activity and run records
  are append-only and sync cleanly. Phase, claim and attention are mutable and contended — and
  claims are leases, which need a single authority: two laptops that both believe card 7 is
  unclaimed produce two agents implementing it in two worktrees, which is not a conflict anyone
  resolves later. The cheaper shape is the one already designed: one daemon holds the state,
  clients stay thin over 003, and runners connect to a daemon they do not live inside — which is
  what the internal coordination/execution seam was for. The split lands well, too: cards go to
  the shared daemon, execution stays on each member's own machine, so their agent auth and their
  checkouts never leave it and *skelcrew never calls a model* survives the move. **Never storing
  repository contents** is what makes a shared daemon acceptable to a company at all — cards
  carry branch names, shas, PR links and excerpts, not code — so a constraint written for other
  reasons is what clears the security review. The trap to refuse is a card with two homes: a
  personal daemon and a team daemon that exchange work is federation, which is a large share of
  what orca's concept count bought. One card, one home; someone who wants both runs two boards.
  Sync is the right answer only if working offline is a requirement, and that wants evidence
  before it wants a design.
- **The activity feed is already the memory layer, and the boundary is publication (008, Later).**
  Making the record queryable — asking what was decided, whether something was tried, why it was
  done this way — is a natural extension of *the card's activity feed is the run record*, and
  skelcrew would be building it from a better substrate than anyone else: entries that passed a
  gate or produced a verified artefact, rather than chat transcripts. But it can quietly undo
  *a phase handoff is a context boundary*, which is the constraint that separates this from Gas
  Town, where agents query their predecessors' sessions. The line that keeps both: **build it
  from what an agent published, never from what a run thought.** The card's comments, decisions,
  spec and refs are already public and already meant to be read — 012's playbook opens by reading
  them. A run's transcript is not, and mining transcripts is inheriting context under another
  name. Order, cheapest first: decisions as their own typed entry (the spec playbook already asks
  for reasoning in *Implementation approach*, where it is prose buried in a card body and answers
  the one question git cannot); then learnings, captured unconditionally with an explicit "none
  this session" rather than a conditional step nobody runs; then per-repo knowledge feeding the
  next run, which is where it starts compounding and starts shaping behaviour rather than
  recording it. Playbooks that rewrite themselves come last and not before the eval tiers exist,
  because a self-modifying prompt with no measurement degrades slowly and invisibly. The failure
  mode to watch is a second source of truth: the memory *is* the card record, and the work is
  making it queryable — the moment it becomes a store with its own lifecycle, a hard constraint
  is gone.

Findings from Hermes Agent (NousResearch/hermes-agent, read 2026-09-10), the most developed
self-improvement loop in the field and the one neighbour built around agents that learn. Its
defaults are the opposite of skelcrew's — it writes freely and offers a gate — which is what
makes it useful to read:

- **A learning entry is a lesson, not a log (008, Later).** Hermes' rule for what an
  agent-written skill may contain: a generalisable rule plus one clause of *why* — the mechanism
  — attached to the step it affects, stated once. Incident narration, PR and issue numbers,
  dates and quoted chat are explicitly not skill content, because "the rule has to stand without
  the story behind it". It also refuses to restate anything already loaded every turn (the
  repo's own instructions, tool schemas). An advisory linter enforces the shape with two rules
  named after the failures that produced them — `incident-log-shape` for a body dense in issue
  numbers, `references-sprawl` past sixty reference files — and both warn rather than block.
  Worth holding against this file: a milestone finding *should* carry spec numbers and dates,
  because it is a project record. A learning is a different artefact and must not look like one,
  or it decays into a diary nothing reads.
- **Memory is capped, and a write over the cap fails rather than compacts (008, Later).** Hermes
  bounds its always-in-context memory hard — roughly 2,200 characters of agent notes and 1,375
  of user profile — and, when a write would exceed it, the tool returns an error instead of
  summarising or dropping the oldest entry. The agent must consolidate or delete in the same
  turn before retrying, and the prompt header shows how full the store is so it can see the
  ceiling coming. This is the answer to the obvious failure of any memory layer here, which is
  unbounded growth: a cap that errors forces curation, a cap that compacts only hides the
  growth. It also splits the stores by job — small durable facts that must always be in context,
  against longer procedures that load only when relevant — which is the rule for deciding what
  a learning is versus what belongs in a playbook.
- **A proposed learning is an artefact for a gate, and that is already built (010/013).** Hermes
  can stage every agent-written skill change instead of committing it: a pending list, a full
  diff, approve or reject, surviving restarts, for "small models that misjudge what they
  learned, secure environments, or just wanting eyes on the self-improvement loop". It is off by
  default there. Here it is not a setting but the thesis — a playbook or learning change is a
  machine-produced artefact, and artefacts reaching a human gate is what skelcrew is — so the
  loop needs no review surface of its own: it is an attention request carrying approve and
  reject, which 010 already defines and 013 already answers. That is also the differentiator
  worth naming, because everyone else is building a loop where the agent decides what it
  learned, and this one would have the agent *propose* what it learned.
- **Two writers to one memory corrupt it, and skelcrew runs concurrently by design (008).**
  Hermes warns not to point two agent processes at one memory home, because "two writers sharing
  one home will compound each other's entries into state neither of them (nor you) authored",
  and scopes memory per profile to prevent it. Concurrent runs are normal here, so any learning
  an agent writes goes through the daemon, which serialises and records it, and never straight
  to a file two runs might hold open. The same rule the cards already follow, for the same
  reason.
- **Repo-owned, harness-owned and agent-owned must be enforced, not just documented (the
  playbook extraction).** Hermes keeps a project's own skill directories read-only to its
  curator and lands every agent-created skill in the agent's own directory, so an agent can
  improve what it knows and cannot edit what the project committed. That is the three-layer
  split already recorded here, with the boundary made real: the target repository's `AGENTS.md`
  is never agent-writable, skelcrew's playbooks are daemon-owned and injected, and per-repo
  learnings are the only layer a run may write. An agent that can edit the instructions it is
  judged against has no gate at all.

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
