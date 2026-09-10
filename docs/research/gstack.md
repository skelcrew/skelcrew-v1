# gstack

`garrytan/gstack` — read end to end 2026-09-10. A playbook library with no runtime: 23 Markdown
role skills (CEO, eng manager, designer, reviewer, QA, security officer, release engineer)
installed into ten different agent CLIs and invoked as slash commands. Everything is attended —
a human types the command and watches — so there is no work item, no queue and no unattended
tier.

That makes it the closest thing to skelcrew's own `.claude/` layer, productised, which is the
layer the daemon's phase playbooks get extracted from. For scale: its playbooks total roughly
39k lines, its review skill 976 and its spec skill 932, against 146 lines for both of
skelcrew's. The gap is itself the finding — phase quality is mostly playbook depth.

<!-- Findings carried into the specs they affect live in `docs/MILESTONES.md`, which points
back here. This file is the evidence; the entry is the decision. -->

## Findings

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
