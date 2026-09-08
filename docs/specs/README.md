# Specifications

One file per unit of work: `docs/specs/<NNN>-<descriptive-name>.md`.

`<NNN>` is a zero-padded sequence number, taken by adding one to the highest already present.
Numbers are never reused or renumbered — the sequence records the order work was specified, so
a later reader can see what was known when. The name after it describes the behavior, not the
mechanism.

The run record for a spec takes the same filename under `docs/plans/`, so the two line up.

A spec is written by `/spec`, reviewed and approved by a human, then implemented by
`/develop docs/specs/<name>.md`. Specs are durable — they stay in the repo after the work
ships and describe what was intended, not what happened.

Every spec has these sections, in this order:

| Section | Contains |
| --- | --- |
| **Goal** | What becomes possible, and why it is worth doing. |
| **Current behavior** | How the relevant part of the system works today, with file references. |
| **Desired behavior** | Observable behavior after the change. |
| **Implementation approach** | Intended architecture and integration points. Not line-level prescriptions. |
| **Acceptance criteria** | Numbered, independently verifiable, observable. |
| **Tests** | Behavioral coverage the change must have. |
| **Out of scope** | Adjacent work explicitly excluded. |

## Rules

- **Acceptance criteria must be checkable by someone who did not write the code.** "Handles
  errors correctly" is not a criterion. "A request naming a board that does not exist returns
  an error message that includes the board name, and no card is created" is.
- **Keep scope small.** One spec should be one coherent change. Split rather than broaden.
- **The spec is the contract.** `/develop` implements exactly what is written here. If the
  spec is wrong, fix the spec and re-run — agents must never silently edit it to match code.

## State

`docs/plans/<spec-name>.md` is the run record for a spec: the implementer's plan, the checks
that ran, and the review and verification outcomes. It is written by `/develop`, not by hand.
