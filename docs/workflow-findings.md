# Workflow findings

What building skelcrew with `/spec` and `/develop` teaches about `/spec` and `/develop` — as
opposed to about skelcrew, which belongs in `docs/MILESTONES.md`, or about other harnesses,
which belongs in `docs/research/`. AGENTS.md says improvements discovered while building here
should flow into the playbooks under `.claude/`; an entry stays here until it has, and says so.

- **Specs ship with defects, and fixing one mid-run needs a rule (012/008).** Spec 001's
  acceptance criteria 9 and 10 contradicted each other. The implementer built to 9, reported
  the conflict instead of editing the spec, and the owner approved a one-line rewording while
  the run was in flight. That is the shape the live pipeline needs: an agent never edits the
  card's spec to match its code; it raises an attention request naming the conflict, and the
  owner's resolution is a spec edit plus a comment the run continues from.

See also `docs/prototype-vs-specs.md`, which measures the same idea built twice — vibe-coded
on the `prototype` branch, and specced on `main` — and says what the difference bought.
