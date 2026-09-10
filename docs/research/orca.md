# Orca

`stablyai/orca` — read end to end 2026-09-10. An Electron development environment for running
many coding agents at once, with a mobile companion, SSH worktrees and a relay. Its
orchestration layer is the closest shipped thing to skelcrew's design, which is why it was read
first and twice.

<!-- Findings carried into the specs they affect live in `docs/MILESTONES.md`, which points
back here. This file is the evidence; the entry is the decision. -->

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

## Findings

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
- **What the coordinator agent costs (008).** Orca's orchestration is ~24k lines over a schema
  rebuilt 40 times: durable typed mail between workers, mailbox fencing, idempotent mutations,
  federation to remote hosts, takeover of adopted runs, a whole compatibility lane for attempts
  started under an older contract. Almost none of it is the price of orchestration — it is the
  price of a plan that lives in a context window and must stay reconstructable when that context
  dies or goes wrong. Rows do not need reconstructing, so the bill does not transfer: the
  findings above come to a few hundred lines between them. Worth remembering when 008 tempts a
  card into dispatching other cards.

## From a second pass

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
