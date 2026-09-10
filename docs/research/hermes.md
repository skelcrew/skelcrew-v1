# Hermes Agent

`NousResearch/hermes-agent` — read 2026-09-10.

<!-- Findings carried into the specs they affect live in `docs/MILESTONES.md`, which points
back here. This file is the evidence; the entry is the decision. -->

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
