---
name: spec
description: Turn a rough idea — or the number of a spec already planned in docs/MILESTONES.md — into an implementation-ready specification in docs/specs/. Investigates the repository first, resolves design decisions from context, asks only about choices that materially change behavior or scope, and stops without implementing anything.
argument-hint: <NNN> | [the idea, in a sentence or two]
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Write, AskUserQuestion
---

# Write a specification

The argument: **$ARGUMENTS**

Your job is to produce one implementation-ready spec file. You are **not** implementing it.

## 0. Resolve the argument

The argument is either a rough idea in prose, or the number of a spec already planned in
`docs/MILESTONES.md`. Decide which before doing anything else.

| Given | Means |
| --- | --- |
| `005`, `5`, `spec 005` | the planned spec numbered `005` in `docs/MILESTONES.md` |
| anything else | a rough idea, described in prose |

If it is a number:

1. Zero-pad it to three digits and list `docs/specs/`. If a spec with that number already
   exists, stop and report its path — the user decides whether they meant to revise it. Never
   overwrite an existing spec and never renumber one.
2. Read `docs/MILESTONES.md` in full and find what that number is planned to be. **The
   milestone entry is the idea.** Take it with every caveat recorded around it — what was
   already tried and rejected, the structural catches, and any finding carried forward from
   an earlier spec that the milestone says comes due here. Those warnings are the most valuable
   input you have; a spec that re-proposes something the milestone already records as rejected
   is worse than no spec.
3. If `docs/MILESTONES.md` does not exist, or the number is not planned in it, stop and ask
   what it should be. Do not invent the subject of a numbered spec.

In this mode the number is given, so the next-in-sequence rule in step 4 does not apply. If the
number is not the next one in `docs/specs/`, say so before writing and leave the gap.

## 1. Ground yourself before designing

Do this before forming any opinion about the design:

1. Read `CLAUDE.md` in full, if it exists. The repository constraints there are correctness
   requirements — a spec that violates one is wrong, however elegant.
2. Read `docs/specs/README.md` for the required section structure and the rule on acceptance
   criteria.
3. Read any other design documents under `docs/` that the idea touches. Treat anything marked
   provisional as provisional — ask before building on it.
4. Investigate the actual code and data the idea touches. Read the real files. Check real
   data shapes, schemas, and fixtures yourself rather than assuming them. Look at how similar
   things are already done here.
5. Skim `docs/specs/` for existing specs that overlap, and `git log` for recent related work.
6. Read `docs/MILESTONES.md`, if it exists, for where this work sits in the sequence: what it
   is expected to move, what a later milestone will handle instead, and what has already been
   tried. If you read it in step 0, do not read it again.

If the idea turns out to already be implemented, or to conflict with an existing spec, say so
and stop. Do not write a spec for work that does not need doing.

## 2. Identify the decisions

List, for yourself, the product and architectural decisions this change forces. For each one,
try to resolve it from repository context first:

- Does `CLAUDE.md` or an existing spec already settle it?
- Does an existing pattern in the code settle it?
- Does the test suite settle it — is there an existing test that only passes under one of
  the options?

Resolve everything you can this way, and record the reasoning in the spec's *Implementation
approach* section so the choice is auditable.

## 3. Ask only about what matters

Use `AskUserQuestion` **only** for decisions where different answers produce materially
different behavior, scope, or architecture — and which repository context genuinely cannot
settle. Batch them into one round; do not drip-feed questions.

Do not ask about: naming, file placement that follows an obvious existing pattern, formatting,
or anything `CLAUDE.md` already answers. Make those calls yourself.

If nothing material is unresolved, ask nothing and go straight to writing.

## 4. Write the spec

Write to `docs/specs/<NNN>-<descriptive-name>.md`. Use exactly the sections in
`docs/specs/README.md`, in that order.

- `<NNN>` is a zero-padded three-digit sequence number. If the argument gave one, use exactly
  that. Otherwise **take the next one** — list `docs/specs/` and add one to the highest
  existing number. Never reuse or renumber; the sequence records the order work was specified,
  so it stays stable once assigned.
- `<descriptive-name>` is kebab-case and named for the behavior, not the mechanism:
  `007-card-due-reminders.md`, not `007-refactor-scheduler.md`.

What makes each section good here:

- **Goal** — the capability and the reason. One short paragraph. If you cannot say why it is
  worth doing, the spec is not ready.
- **Current behavior** — how it works today, citing real paths as `file.py:42`. Where the
  answer is "this does not exist yet", say that plainly and describe what stands in for it.
- **Desired behavior** — observable from outside. Describe what a caller, a test, or a user
  would see. No implementation verbs.
- **Implementation approach** — the architecture and the integration points, naming the files
  and functions that will be touched or created, plus the decisions you resolved in step 2 and
  why. Stop above the line where a competent implementer should choose for themselves. Do not
  write code here beyond a signature or a small data shape where it removes real ambiguity.
- **Acceptance criteria** — numbered. Each one independently verifiable by a fresh engineer
  with the repo and nothing else. Prefer criteria a command or a test can settle.
- **Tests** — the behavioral coverage required: what must be tested, and which existing tests
  already cover it. Do not specify test function names or file layout unless the repo already
  fixes them.
- **Out of scope** — the adjacent work you deliberately excluded, so `/develop` does not drift
  into it. Be specific; "future improvements" is not out-of-scope.

## 5. Red-team the grants, before you hand the spec over

**Only if the spec grants a capability** — an allowlist, a scope, a credential, a role, a
permission rule, a token, a path a process may write, a command it may run. If it grants
nothing, skip this section entirely; most specs do.

Spec 013 took **seven** review rounds. Every Critical finding was a defect in this document, not
in the code, and all seven were findable by reading before a line was written. They were found
instead by shipping and being corrected, one round at a time. This step is that hour, moved to
the front.

Do all five. They are quick, and each one caught something real:

1. **Say whether this is a gate or a boundary, in the Goal.** A gate governs the ordinary
   course and is worth having; a boundary is meant to hold against something trying to get
   past it. Most mechanisms are gates. Write down which this is and what defeats it — one
   sentence. Two of 013's seven rounds went to discovering that its allowlist was a gate
   after the spec had spent pages claiming a boundary. That sentence was available on day one.
2. **Enumerate what each grant can reach**, not what it is for. A command's flags are part of
   the grant: `git log` looks read-only and `git log --output=<path>` writes any file on disk.
   Read the actual flag list. A wildcard grants every flag the command has, present and
   future, so a grant you cannot enumerate is one you cannot write as a wildcard.
3. **Compose every grant with every other grant on the same list.** This is the one that
   matters most: four of 013's five escalations were pairs of individually reasonable grants.
   "Write any file" plus "ask git where its directory is" is "rewrite your own permissions."
   Reasoning that examines each grant alone will pass all of them.
4. **Run the real enforcer on the actual strings.** Not the documentation, not your model of
   it — the thing that will decide at runtime. Every one of 013's rounds was settled this way,
   and four of them would not have happened had it been done while the list was being written.
   If the enforcer cannot be run, say so in *Implementation approach* and mark every claim that
   rests on unverified semantics.
5. **Ask what parses the string you are building.** If the spec composes a value into a
   syntax — a rule, a query, a path, a command line — that syntax can be closed early and a
   second one opened. Sanitising against the wrong language is the same as not sanitising.
   Prefer an allowlist of permitted characters, and specify an invariant that fails loudly
   whatever the allowlist misses.

Then record the result in the spec: what you checked, what you found, and **what remains open**.
A limitation written down is a decision; the same limitation discovered in review is a defect.

One more thing, which is not a check but a preference: **prefer containment to enumeration**
wherever the choice exists. A fence around a place ("this process writes only here") does not
expire. A list of the dangerous things ("not these flags, not these verbs") is a maintenance
obligation that goes stale the next time the thing it describes ships a release. Where a spec
must enumerate, say what it was enumerated against and what to do when that moves.

## Rules

- **Investigate before specifying.** A spec written from assumptions about this repo is worse
  than no spec.
- **Prefer existing repository patterns** over introducing new ones. If you propose a new
  pattern, justify it in *Implementation approach*.
- **Keep scope small.** If the idea is large, specify the smallest coherent first slice and
  put the rest in *Out of scope*. Say that you did this.
- **Never weaken the constraints in `CLAUDE.md`** to make a design simpler. If the idea
  requires it, stop and raise the conflict instead.
- **A permission grant is a security boundary, not a configuration detail.** If the spec gives
  a process, an agent, or a user anything — an allowlist, a scope, a credential, a capability —
  name the exact operations and check them against the matching semantics of whatever will
  enforce them, before you write the line. A wildcard that spans a subcommand (`Bash(git *)`,
  `Bash(gh pr *)`) grants every verb beneath it, including the ones the spec's own gates exist
  to catch. Specify the verbs, and say explicitly what must ask. An implementer will write what
  you wrote; a boundary specified loosely here is a hole that survives review.

  Two checks, both learned the expensive way — spec 013 took five review rounds and every
  Critical was a hole in the spec, not in the code:

  **A trailing wildcard is the command's entire flag surface, present and future.** `Bash(x *)`
  grants every flag `x` has, so before writing one, enumerate them and name the ones that write
  a file or run another program. `git log --output=<any path>` writes anywhere on disk, which
  made a verb everyone reads as read-only into an arbitrary-write primitive. A prefix pattern
  cannot exclude a flag, so if such a flag exists, the entry does not belong in that form.
  Check also whether the enforcer already validates that command flag by flag: naming it
  yourself may *replace* a curated check with "anything goes", in which case the safest entry
  is no entry at all.

  **Check each grant against every other grant on the same list, not only against itself.**
  Four of 013's five escalations were compositions of individually reasonable grants: a
  path-less `Write` beside `git rev-parse --git-common-dir` let a run forge the very ref its
  successor read. Reasoning that enumerates one class of grant carefully and forgets the class
  sitting next to it is the single most common way a boundary fails here. Ask what files each
  grant can reach, what it can execute, and what the others make of that.
- **Do not implement anything.** No source edits, no test files, no dependency changes. The
  only file you create is the spec.

## Finish

Stop after writing the spec. Report:

1. The spec path.
2. A three-line summary: goal, the approach in one sentence, and the number of acceptance
   criteria.
3. Any decision you resolved from repository context that the user might disagree with —
   this is the part worth their attention.
4. If step 5 applied: whether this is a gate or a boundary, what you ran the real enforcer
   against, and what you left open. If step 5 did not apply, say the spec grants nothing.
5. The exact next command: `/develop <NNN>`

Then hand control back. Do not begin implementation, and do not offer to.
