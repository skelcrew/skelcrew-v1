# Research

What other harnesses do, and what that means here. One file per subject. These are evidence:
the decisions they lead to live in `docs/MILESTONES.md`, in the entry for the spec each one
affects, which points back to the file that argued it.

Nothing in here is a commitment, and nothing in here is a plan. When a finding stops being
evidence and becomes a decision, it moves into an entry — or into `AGENTS.md`, if it settles a
constraint.

| File | Subject |
| --- | --- |
| [orca.md](orca.md) | `stablyai/orca` — the closest shipped neighbour, and the same design with an agent in the orchestrator seat |
| [gstack.md](gstack.md) | `garrytan/gstack` — playbooks as a product, with no runtime underneath |
| [hermes.md](hermes.md) | `NousResearch/hermes-agent` — the most developed self-improvement loop in the field |
| [herdr.md](herdr.md) | `herdrdev/herdr` — a terminal runtime with no work item, and the screen-reading answer to agent state |
| [field-scan.md](field-scan.md) | The wider market, and what survives its crowding |

## Open questions the research raised

Neither is specced, and neither belongs to a milestone yet.

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
