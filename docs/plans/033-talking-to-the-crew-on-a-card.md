# 033 — Talking to the crew on a card

Run record. Worktree `.claude/worktrees/talking-to-the-crew-on-a-card`, branch
`worktree-talking-to-the-crew-on-a-card`, base `main` at `8ecaec8`.

Baseline before any change: `bun run check` green, **887 pass, 0 fail, 35 files**.

## The slices, planned before starting

Each is a commit that passes `bun run check` on its own; the failing test and the change that
makes it pass land together.

1. **`keysOf` decodes Tab.** `board.ts` + its decoding table in `board.test.ts`. Nothing yet
   uses the key: no view reads `tab`. (Criterion 9.)
2. **The chat frame.** `state.ts` gains the `chat` view kind; `render.ts` exposes the card
   header it already composes; `frame.ts` gains `conversationLines`, the listening line, the
   input line and the chat frame, plus the scroll clamp. Tested purely through `frame.ts`,
   with a state built by hand — no key opens the view yet. (Criteria 5, 6, 7.)
3. **The keys.** `Enter` on a row opens the chat, `Tab` flips both ways, the chat's input keys,
   the `allow`/`deny` reading of a line, the help screen's two lines. The existing tests that
   reached the card view by pressing `Enter` press `Enter` then `Tab`. (Criteria 2, 3, 4, 10.)
4. **The loop.** The open chat's detail is read on open and refetched on its events, a refused
   call writes the daemon's sentence to the listening line and puts the typed text back, and a
   pasted newline ends the chunk. (Criteria 6 and 8 end to end.)
5. **MILESTONES marks 033 landed.** (Criterion 11.)

## Decisions the spec left open

- **A comment is "the agent's" when its actor is not `me`.** Single-player: the owner is one
  member and everyone else on a card is the crew. The line carries the member's name, which is
  what tells the owner's lines from the runner's.
- **A comment renders as `<time>  <name>  > <line>`, every further line indented under it and
  marked.** `show` marks a body line by line (015); the criterion asks for a three-line comment
  to be three marked lines, so the attribution shares the first of them rather than taking a
  line of its own.
- **An event whose `activityLine` is several lines is several dim lines.** `activityLine` can
  return a marked note or review findings after the summary; the card view already draws those
  as the lines they are, and cutting to the first would drop text.
- **The middle pads at the bottom**, as the card view does: a short conversation sits under the
  header rather than floating above the listening line.
- **The input line carries no label.** The listening line above it says what a line does; the
  spec asks for "the input with the reverse-video cursor" and nothing more.
- **A chat open on a card that is archived closes to the board**, as a card view does (032).
  The spec does not name this; it is the same situation and `apply` already had the rule.

## Log

(filled in as the slices land)
