# The prototype and the specs, compared

Two implementations of the same idea by the same person, a few days apart, under different
processes. The `prototype` branch is the 2026-09-07 spike: vibe-coded, two commits, board server
plus web UI plus MCP endpoint plus daemon, and it ran a real spec stage and a real develop stage
against a toy repo. `main` is the same idea rebuilt through `/spec` → approve → `/develop`, one
numbered spec at a time, each implemented in a worktree and put through independent review and
verification before a pull request.

They are not the same product — the spike lived in a browser, skelcrew is a daemon and a CLI —
so this is not a feature comparison. It is a comparison of what the two processes produce.

Measured 2026-09-11, with `main` at 016 planned, 013 in review round 5 and 014 in review round 3.
Neither 013 nor 014 had landed, so the checks that close the spike's worst failure are specified
but not yet shipped.

## The numbers

|  | `prototype` | `main` |
| --- | --- | --- |
| Elapsed | 1–2 hours | 4 working days |
| Commits | 2 (one of them a one-line README) | 68 |
| Source files (`.ts`, excluding tests) | 12 | 44 |
| Source lines | 2,425 | 5,111 |
| Test files | 0 | 24 |
| Test lines | 0 | 7,730 |
| Test-to-source ratio | 0.00 | 1.51 |
| Comment lines | 138 (5% of source) | 738 (14% of source) |

Roughly twice the source for a *narrower* scope, and three times the total volume once tests
count. The spike's scope was wider: it carried a board server, a web UI and an MCP endpoint
that `main` deliberately does not have.

The timing is the part worth being precise about, because it is the cost side of the trade.

The repository begins as a one-line README at 2026-09-07 09:03:57. The entire spike — twelve
source files, a board server, a web UI, an MCP endpoint and a daemon that ran a real spec stage
and a real develop stage — arrives in **a single commit** at 2026-09-08 08:31:51. Git bounds
that at 23h28m across a night and cannot narrow it; the author's recollection is **one to two
hours** of actual work. The rebuild's first commit lands at 08:34:01, two minutes and ten
seconds after the spike: it was finished and the pivot began immediately.

Against that, `main`'s working windows are 08:34–21:00, 08:26–13:24, 09:36–20:07 and 08:32–08:46
across four days. Those windows contain meals and everything else, and most of the time inside
them is supervision rather than typing, since agents write the code — but there is no reading of
them that lands near two hours.

So the honest ratio is **an order of magnitude, at least**. A working end-to-end loop in an
afternoon is what vibe coding is for, and it is genuinely astonishing that it works. What the
extra time buys is listed below: three times the artefact, 7,730 lines of test where there were
none, and a written record of the defects — including two, 013's allowlist assumption and 016's
subprocess hole, that the spike shipped without noticing. Whether that trade is worth making
depends entirely on whether anyone has to walk away from the result and trust it.

To re-derive: `git ls-tree -r --name-only <branch>`, filter `.ts`, split on `.test.ts`, count
lines with `git show <branch>:<file>`.

## Three places the same idea came out differently

### 1. Which copy of the spec is the truth

The spike has the agent write `KANBOT_SPEC.md` into the worktree, and the daemon reads it back
(`daemon/src/main.ts`: `existsSync(specFile)`, then `readFile`). The file in the repository is
the artefact, and the board is downstream of it.

`main` inverts this. The spec is the card's body, written with `skelcrew body`; a file committed
into the target repository is an export, and nothing reads it back. That is now a hard
constraint in `AGENTS.md` — *the card is the source of truth; anything written into a repository
is an export of it* — with the consequence spelled out that a repository which publishes nothing
must still be able to finish every phase.

The spike had authority pointing the wrong way. Specifying the thing is what noticed.

### 2. How an outcome travels

The spike decides whether a review passed by reading the **last line** of `KANBOT_REVIEW.md` and
comparing it against the string `APPROVED` or `CHANGES REQUESTED` (`VERDICT_APPROVED` in
`daemon/src/playbooks.ts`). The agent declares the outcome; the daemon believes the declaration
and moves the card.

That is exactly the failure orca's model has a name for — `finished_unverified`, an attempt that
ended with no accepted report — and it is what 014 exists to replace with conditions the daemon
checks itself. See `docs/research/orca.md`.

### 3. Playbooks stopped being code

In the spike a playbook is a TypeScript template literal built by a function over a
`PlaybookInput` interface, with exported sentinel constants beside it. In `main` a playbook is a
markdown file on disk and a 26-line loader. The workflow moved out of the type system and into
content the daemon injects — which is what makes "skelcrew ships the playbooks; the state
doesn't interpret them" true rather than aspirational.

## What the spike already had right

This does not run one way.

It already verified artefacts. `daemon/src/main.ts` runs `git rev-list <base>..HEAD --count` and
throws when the count is zero, and rejects a spec file that is empty. So 014 is not inventing
artefact verification — it is making a check that already existed hold on the path where it
failed, which is the harder half.

And `daemon/src/run.ts` already carries the comment that the daemon spawns `claude` as a
subprocess and "never calls a model API itself". The load-bearing constraints were right on day
one. What the process changed is enforcement, not the ideas.

## What the difference actually is

Not the code, and not primarily the tests.

The spike produces working software. The spec process produces working software **and a written
record of what is wrong with it**. Milestone 016 exists because review round 5 of 013 noticed
that the allowlist was never the boundary the design was reading it as — a subprocess is not a
tool call, and the phase playbooks exist to run one. Nothing on the prototype branch found
anything, because nothing was looking.

That record is the part that matters for this product specifically. Unattended work is only
worth having if the failures are visible, and a process whose output includes its own defect
list is the only way that stays true as the thing grows.

The cost is legible too: an order of magnitude more time, 68 commits against 2, and three to
five review rounds on the specs that touch a security boundary. That is the price, and this file
exists so the price and what it bought can both be seen — and so the next person tempted to
conclude that the process is cheap has the numbers in front of them.
