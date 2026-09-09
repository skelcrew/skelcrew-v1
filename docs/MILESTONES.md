# Milestones

The planned sequence of specs. Entries ahead of the current milestone are provisional —
`/spec <NNN>` turns one into a real specification, and what a spec's implementation teaches
gets recorded here against the milestones it affects. Never renumber; if the plan changes,
rewrite the entry, not the number. A number identifies an entry and never changes, even when
the build order does: entries are listed below in intended build order, so a later-numbered
entry can precede an earlier one when it was carved out of it.

Status: 001 through 004, 010, 009, and 006 landed (PRs #1 through #7, 2026-09-08 and
2026-09-09); 007 is in progress. A
prototype spike (2026-09-07, preserved on the `prototype` branch) built the previous
architecture — separate board server, web UI, MCP endpoint, daemon — end to end and ran a
real spec stage and develop stage against a toy repo. The project has since been renamed
skelcrew and pivoted to the single-headless-daemon architecture (see AGENTS.md); the
milestone entries below are written for the new architecture, and the spike's findings —
recorded here in its own lane/board vocabulary — must be absorbed by the numbered specs:

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
  `hello` (the flag wins); without either, it is the owner. The runner (006/007) sets
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
  owner, and releases with reason `no playbook`; 007 replaces the request with the
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
  `SKELCREW_DIR`; 007's spawned agent may still get it set, belt and braces. The rule
  requires the gitdir's grandparent to be named `.git`, so a main repository initialised
  with `--separate-git-dir` does not resolve and its runner worktrees fall back to their
  own directory as the root.
- **The runner spawns one coding agent per run through the Agent SDK, behind a driver
  seam; the card shows excerpts and the transcript is a file; approvals are attention
  requests answered with words (007).** `SKELCREW_AGENT` picks the driver — unset or
  `claude` is `@anthropic-ai/claude-agent-sdk` (pinned, the daemon's only direct external
  dependency, confined to `runner/claude.ts`; its declared peers — `@anthropic-ai/sdk`,
  `@modelcontextprotocol/sdk`, `zod`, and their trees — are named in `bun.lock` because
  Bun records resolutions, but the root `bunfig.toml`'s `peer = false` keeps them off disk,
  and the SDK loads without them), `none` keeps 006's no-playbook handoff, and anything
  else stops the daemon. The agent runs in the card's worktree with the phase's playbook
  (`packages/daemon/playbooks/{spec,code}.md`, read at startup, appended to the harness's
  own system prompt, never written into the target repo) and the card — `Card <id>:
  <title>`, `Branch: <branch> (from <base>)`, a blank line, the body — as its first user
  message. Its environment is the daemon's plus `SKELCREW_AS=runner`, `SKELCREW_DIR=<data
  dir>`, and `<data dir>/bin` first on `PATH`, where a shim `skelcrew` (written once at
  startup, `exec '<the daemon's own bun, process.execPath>' '<this checkout's
  packages/cli/src/main.ts>' "$@"`, so a daemon under launchd with a minimal `PATH` still
  works) makes every playbook command land on this daemon attributed to `runner`. The
  allowlist is `Read`, `Glob`, `Grep`, `Edit`, `Write`, `MultiEdit`, `Agent`, `TodoWrite`,
  `Bash(skelcrew show *)`, `Bash(skelcrew comment *)`, `Bash(skelcrew body *)`,
  `Bash(skelcrew refs *)`, `Bash(skelcrew attention *)`, `Bash(git status *)`,
  `Bash(git log *)`, `Bash(git diff *)`, `Bash(git show *)`, `Bash(git merge-base *)`,
  `Bash(git rev-parse *)`, `Bash(git branch *)`, `Bash(git add *)`, `Bash(git commit *)`,
  `Bash(git push -u origin HEAD)`, `Bash(git push)`, `Bash(gh pr create *)`,
  `Bash(gh pr view *)`, `Bash(gh pr diff *)`, `Bash(gh pr comment *)`,
  `Bash(gh repo view*)`, plus `Bash(<first token> *)` for
  the first line of every fenced shell block (no language tag, or `sh`/`bash`/`shell`/
  `zsh`/`console`, a leading `$ ` stripped) in the repo root's `AGENTS.md` and `CLAUDE.md`
  — `bun run check` becomes `Bash(bun *)` here. The scan skips a token the fixed list
  narrows on purpose (`skelcrew`, `git`, `gh`), so a target repo whose instructions show
  `git status` in a fence cannot widen git back to `Bash(git *)`. Anything else is an
  attention request to the owner, `allow <tool> <one-line input>? (skelcrew resolve <id>
  -m allow | skelcrew resolve <id> -m deny)`, with the claim heartbeating while the run
  waits: `-m allow` (or `yes`, `ok`) allows, `deny`, `no`, any other text, or no text
  denies with the text (or `denied`) as the reason the agent sees, and resolving by a move
  aborts the run.
  Permission requests queue — one is open on the card at a time, the next is raised when
  it resolves — and none is raised over a question the agent itself put on the card with
  `skelcrew attention`, which the owner answers first; a failed run leaves such a question
  in place and posts only its comment and release, replacing nothing but the run's own
  request. Excerpts: each
  assistant text turn is a comment, cut at 2 KiB with a `… [truncated: N bytes; the full
  text is in the run log]` marker; tool calls are one comment per thirty seconds and at
  the end of the run (`ran 4 tools: Read ×2, Bash \`bun test\`, Edit`); every driver
  event is a JSON line in `<data dir>/runs/<id>-<started>.jsonl`, whose path is in the
  run's first comment (006's `worktree ready …` line, extended with `; run log at <path>`).
  A comment by any member other than `runner` while the run is live reaches the agent as
  a user message; the answer to an approval is not also forwarded. A run ends at the
  driver's first result, at the time limit (60 minutes, `SKELCREW_RUN_MINUTES`), when the
  daemon stops (`run aborted: daemon stopping`, a failed run like the time limit, so
  shutdown never waits out a run and the card is waiting on the owner after a restart), or
  when the claim is lost — every core event on the card re-checks the claim and aborts
  the agent, and the 006 rule holds: a lost claim posts `run abandoned: <reason>` and
  nothing else. An agent that ignores its abort signal is left behind after a five-second
  grace and the run proceeds without it. **The agent may never move, release, or archive
  its own card**: the phase ends in an artefact contract the runner verifies before any
  handoff, and `skelcrew mv <id> pr` by the claim holder would skip that gate — so the CLI
  is allowed verb by verb (`mv`, `release`, `claim`, `archive`, `resolve` ask the owner),
  and a `card_moved`, `released`, or `card_archived` by `runner` itself during a run is a
  failed run (`run failed: the agent moved its own card (to pr)` and the like, a comment
  and a request, no handoff), never an abandonment. An explicit release by anyone else
  (`skelcrew release`, the owner's 009 exit ramp) stops the run with `run stopped:
  released by <name>` as a comment and a request, so the card waits instead of being
  re-dispatched a moment later; only a lapse (`run_interrupted`) returns the card to its
  queue, as 009 intends. Then the contract: Spec needs a `body_set` by `runner` during the run and a
  non-empty body, giving `spec ready` with moves `["code"]` and release `finished`, else
  `run finished without a spec`; Code needs commits past the base (`git rev-list
  <base>..<branch>`, newest first, capped at 256, written to `commits` on success), a
  clean worktree, and a `prUrl` the run itself recorded — a `refs_set` by `runner` between
  the run's first and last events carrying one. The value may be the one already on the
  card, since a card sent back from PR is pushed to the same branch and keeps the same
  pull request, so requiring a *new* URL would strand every revision; what has to be new
  is the recording. That is what catches a run that did nothing: on a revision the commits
  of the run before are still on the branch and the URL is still on the card, so the
  commits alone would hand the card on as ready for review again. (The `refs_set` event
  records the merged refs, not the keys the call set, so a run that writes some other ref
  while a `prUrl` is on the card also satisfies it; separating the two needs the core to
  record which keys were set, which 007 did not ask for.) Then `ready for review: <url>`
  with moves `["pr"]`, else `run finished with <every unmet condition>`.
  An error result, a driver failure, or the time limit is `run failed: …` / `run aborted:
  …`. Every failure is a comment, the same text as an attention request with no moves,
  and a release with reason `failed`; a failed run never moves the card and a dirty
  worktree is left in place. Two things the spec assumed that the code did not bear out:
  `packages/daemon/package.json` also carries the `@skelcrew/shared` workspace link, so
  "exactly one dependency" reads as one external dependency; and the SDK's default
  executable is the Claude Code it bundles per platform (`pathToClaudeCodeExecutable`
  overrides), still under the owner's login, not a `claude` on `PATH`. Two entries of the
  spec's allowlist were narrowed, both because a `Bash(x *)` rule matches every command that
  begins with `x` (that is wildcard matching, `x` then anything; `Bash(x:*)` is the legacy
  prefix form). `Bash(gh pr *)` became the verbs the playbooks use (`create`, `view`,
  `diff`, `comment`): the wildcard pre-allowed `gh pr merge` and `gh pr close`, and
  merging is the owner's alone. `Bash(git *)` became the verbs above: it pre-allowed
  `git push origin HEAD:main`, which lands the work on the default branch without the
  merge gate, and `git -c <anything> log`, which runs arbitrary commands through git's own
  options (Claude Code's rule validator warns of `-c` and `--exec-path` for exactly this).
  Push is allowed only as the exact `git push -u origin HEAD` the playbook runs and the
  bare `git push`; any other refspec or a force push asks. What this closes is what the
  agent may do *unprompted*: every one of these is still available by asking the owner,
  which is the intended path, and nothing here sandboxes the agent — a bare `git push`
  under a repo-level `push.default = matching` could still push more than the card's
  branch.
- **Carried from 007: the runner's identity is not scoped to its card.** The agent gets
  `SKELCREW_AS=runner` and the whole CLI surface that member has, so a run on card 1 can
  comment on or rewrite card 7 and it lands attributed to `runner`; only the playbook's
  text keeps a run on its own card. 007 has no primitive for this and did not ask for one.
  The milestone that gives a run its own identity — a claim-bound credential the shim
  passes, with the daemon refusing writes to any other card — closes it; until then a
  stray write is visible on the wrong card's activity rather than prevented.
- **Carried from 007: the workflow itself, four review rounds deep.** 007 took four review
  cycles where `/develop` budgets three, and the budget never fired — nothing in the loop
  surfaces it, so it held only because the owner was steering each round by hand. A gate that
  depends on someone remembering to read it is not a gate, which is the same lesson the
  runner's artefact contracts encode; the playbooks the daemon ships should count their own
  rounds and stop. Two of the four rounds were spent on defects that were in the spec, not the
  implementation: `Bash(gh pr *)` and `Bash(git *)` were specified, implemented faithfully,
  and each dissolved the attention gate the same spec exists to build — a spec that grants an
  agent permissions is specifying a security boundary and has to be reviewed as one, against
  the matching semantics of whatever enforces it, before implementation starts. A third round
  went to a rule the spec had right all along: Code needs a `prUrl` *recorded during the run*,
  which round 2 tightened into "a different URL" (stranding every revision) and round 3 then
  loosened past the spec's own words (letting a do-nothing revision hand the card on as ready
  for review). A finding that proposes changing a rule the spec states should have to argue
  against the spec's wording, and a fix should relax exactly what the finding names — the
  neighbouring condition dropped "while in there" is what opened the round-4 hole. These belong in
  `.claude/skills/spec/SKILL.md`, `.claude/agents/reviewer.md` and
  `.claude/agents/implementer.md` — this repo's own playbooks, which 007 does not touch —
  and from there in the daemon's built-in playbooks when the runner learns to run review and
  verification phases.

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
