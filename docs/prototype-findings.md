# Prototype findings

A prototype spike (2026-09-07, preserved on the `prototype` branch) built the previous
architecture — separate board server, web UI, MCP endpoint, daemon — end to end and ran a
real spec stage and develop stage against a toy repo. The project has since been renamed
skelcrew and pivoted to the single-headless-daemon architecture (see AGENTS.md); the
milestone entries below are written for the new architecture, and the spike's findings —
recorded here in its own lane/board vocabulary — must be absorbed by the numbered specs: absorbed by the numbered specs.
The entries in `docs/MILESTONES.md` carry the decisions these led to; this file is the record
of where they came from.

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
