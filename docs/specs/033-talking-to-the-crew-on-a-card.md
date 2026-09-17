# 033 — Talking to the crew on a card

Milestone 033 in `docs/MILESTONES.md`, the owner's word for the one that matters: entering a
card should feel like entering a harness — the card, the agent's output as a coding agent's own
terminal draws it, and an input for prompting. This spec grants nothing: every line typed is a
`comment` or a `resolve` the CLI already makes for the owner, and the daemon, the runner and the
core do not change.

## Goal

The owner talks to the agent working a card, on the card. Today that is `c` in the card view:
a key, one line, Enter, and the line reaches the live run as a message and lands on the card
as a comment; the agent's replies are its text turns, posted as comments and drawn in the feed.
The parts exist; the shape does not. After this spec `Enter` on a row opens a chat view: the
card's header at the top, the card's activity below it as a conversation — the owner's lines,
the agent's text, its tool summaries, the phase and claim events between them — and an input
line at the bottom that is open as long as the view is. `Tab` flips to 027's card view and
back. It is comments on the card rendered as a conversation, and nothing else: no chat channel,
no chat state in the daemon, no model call, no phase that needs it. Conversation stays
non-load-bearing (CLAUDE.md); this is the allowed kind, feedback and mid-run answers travelling
as comments.

## Current behavior

- `packages/cli/src/board/state.ts:20`: `View` is `board` | `card` | `help`; `Prompt` is
  `deny` | `back` | `comment` with a `cardId` and `text`, drawn on the bottom line while open
  (`frame.ts:135`, `bottomLine`). `Enter` on a row opens the card view (`keys.ts`, `pressBoard`).
- `frame.ts:219`, `cardFrame`: header, body, feed, each activity as one `activityLine`
  (`render.ts:334`): time, member, summary. A comment's summary is `commented: <text>` with
  continuation lines marked (`render.ts:301`, `continued`). Scrolled by `j`/`k`.
- `board.ts:299`, `:317`: the open card's `detail` (a `CardDetail`, the card with its
  `activity`) is fetched on open and refetched on every event for that card, so a chat view
  drawn from `detail` is live for free.
- `board.ts:161`, `keysOf`: decodes Esc, Ctrl-C, Enter, Backspace and printable characters; a
  Tab (`\t`, below `" "`) is dropped. 031 changes this function for the arrow keys.
- `packages/daemon/src/runner/run.ts:714`: a comment on the card by anyone but the runner and
  the crew is held and forwarded into the live agent session as a user message
  (`flushHeld`, `:503`). No run live, no forwarding: the comment stays on the card and the next
  run reads the card's activity as its playbook tells it to. `run.ts:806`: the agent's text
  turns are posted as comments by `runner`, excerpted with a pointer to the run log when long;
  `noteTool` (`:419`) batches tool calls into one comment per interval (`ran 5 tools: Read ×2,
  Bash \`bun test\`, …`, 012). `allowed …`/`denied …` are comments too (`:695`, `:704`).
- `keys.ts`, `act`: `a` resolves the open question with `allow`; `d` opens the deny prompt;
  `resolve` is `resolveAttention { id, text }`.
- `render.ts`, `status(card, …)` (024): `running since <time>` when the card has a live claim
  by a member the runner holds; that is the one fact that says a run is listening.
- 027's carried finding: a pasted chunk with a newline sends the prompt and drops the tail;
  with no prompt open, every pasted character runs as a key.

## Desired behavior

**`Enter` opens the chat.** On the board, `Enter` on a row opens the chat view of that card.
`Tab` flips to the card view (027's, unchanged) and `Tab` there flips back. `Esc` leaves either
view for the board. `Ctrl-C` quits, as everywhere.

**Three parts, top to bottom.** The card's header, as `show` prints it (id, title, phase, `now:`,
refs), fixed at the top. Then the conversation, filling the middle, newest at the bottom: every
activity event of the card in order, rendered as an exchange — a comment by the owner as the
owner's line, a comment by `runner` or `crew` as the agent's (its text turns whole, multi-line,
every line marked as `show` marks a body; its tool summaries and `allowed`/`denied` notes as
they are), and every other event (created, moved, claimed, released, interrupted, a request
raised or resolved, a review recorded) as one dim entry, as `activityLine` renders it — one
line for most, several for a request with a multi-line note or a review with findings. (The
approved text said "one dim line"; a request's `why:` line is a second line, and cutting it
would lose the reason. Corrected by the orchestrator after review round 1.) Then a line that
says who is listening, then the input.

**The listening line says the truth.** While the card's status is `running since <time>`, the
line says `crew is listening · running since <time>`. Otherwise it says `no run is live; the
next run reads what you write here`. While a question is open on the card, the line is the
question instead: its note's first line and 022's `why:` when there is one, and
`allow · deny · or write`.

**The input is open as long as the view is.** Printable characters and `Backspace` edit; `Enter`
sends; an empty `Enter` sends nothing. With a question open, a line that is exactly `allow`
sends `resolve <id> -m allow`, and a line that is `deny` or starts with `deny ` sends
`resolve <id> -m <the line>`; every other line, and every line with no question open, sends
`comment <id> <line>`. `Esc` with text in the line clears the line; `Esc` with an empty line
leaves for the board. The sent line stays visible where it lands: as the owner's comment in the
conversation when its event arrives, which is the same round trip `c` makes today.

**A refused call says so** on the listening line, in the daemon's words, and the typed text is
put back in the input so it is not lost (027's carried finding, closed for this view).

**Scrolling.** `Up`/`Down` (031) scroll the conversation by a line; typing anything returns it
to the newest. With 031 not yet landed, the view scrolls with nothing and shows the newest; the
spec that lands second wires the other's keys.

**The body is one `Tab` away.** The chat view does not draw the card's body: a spec does not
fit above a conversation on a 24-row terminal, and the card view has it whole. The header's
`now:` line and the listening line are what the owner needs while talking. `Tab` keeps the
typed line: flip to read the body, flip back, and the half-written reply is where it was.
(Added after review round 1, which found the flip dropping the text; the spec was silent and
nothing in it asked for the line to be discarded.)

**The board is unchanged.** `c` on the board still opens the one-line comment prompt; the card
view keeps every 027 key. The help view lists `Tab`, and that `Enter` opens the chat.

## Implementation approach

`state.ts`: `View` gains `{ kind: "chat"; cardId: number; scroll: number; text: string }` —
the input's text lives in the view, not in `Prompt`, because the prompt is a one-shot line
opened for a purpose and closed on send, and the chat's line is never closed; two shapes for
two lifetimes. `keys.ts`: `pressBoard`'s `Enter` opens `chat`; a `pressChat` handles `tab`,
`escape`, `enter`, `backspace`, `up`/`down` and printable characters, yielding the existing
`resolve` or `comment` actions and never a new kind; `pressCard` gains `tab`. The `allow`/`deny`
reading of a line is in the reducer, pure, keyed on `questionOf(state, cardId)`. `frame.ts`: a
`chatFrame` that draws the header from `detail` with the header half of `cardView`'s lines, the
conversation from `detail.activity` through a `conversationLines(detail, members, me)` that is
pure and tested on its own, the listening line from `status` and `questionOf`, and the input
with the reverse-video cursor `bottomLine` already draws. `board.ts`: `keysOf` decodes `\t` as
`tab`; `perform` is unchanged; a refused call in the chat view writes the message to the
listening line's slot (`state.message`, which the chat frame draws there) and restores the text
into `view.text`. The card view's `detail` fetch on open and refetch on events serves the chat
view as it is, since both key on the open card's id.

Decisions resolved from the repository: two views rather than a modal input, because `View` is
already the union the screen switches on and 027's card view stays as reviewed (the milestone
records the owner choosing this); the conversation is drawn from `detail.activity`, which is the
card's record, rather than from a separate feed, because the card is the source of truth and
the run's output is already comments on it; `allow`/`deny` are read from the line rather than
bound to keys, because in the chat view letters are text and the milestone asks that the common
answer never need the flip; `Enter` opens the chat rather than the card view, by the owner's
word; the listening fact comes from 024's `status`, one derivation in one place. The daemon
changes nothing: tool activity is already on the card as summaries (012), forwarding is already
by comment (012, 015).

One thing checked against the code and recorded: the agent hears a line only through
`flushHeld`, and only comments by members other than `runner` and `crew` are held. The owner's
lines qualify; nothing typed can reach the agent by any other path, and nothing typed starts a
run (cards drive the runner).

## Acceptance criteria

1. `bun run check` passes. No test opens a real terminal, spawns a real coding agent or calls a
   model.
2. `press` on `Enter` on a board row yields the `chat` view for that card with empty text;
   `Tab` in the chat view yields the `card` view for the same card, and `Tab` in the card view
   yields the `chat` view; `Esc` in the chat view with empty text yields the board, and with
   text yields the chat view with empty text.
3. In the chat view, printable keys append, `Backspace` removes one character, `Enter` with
   text yields `{ kind: "comment", id, text }` and empties the line, `Enter` with empty text
   yields no action; a letter that is a key in the card view (`a`, `d`, `s`, `x`, `q`, `o`) is
   text here.
4. With a question open on the card: `allow` + `Enter` yields `{ kind: "resolve", id, text:
   "allow" }`; `deny` and `deny <text>` yield `resolve` with that line; `allow please` yields a
   `comment`. With no question open, `allow` + `Enter` yields a `comment`.
5. `conversationLines` for a fixture activity renders: the owner's comment as the owner's line;
   a `runner` comment with three lines as three marked lines attributed to the agent; a tool
   summary comment as it is; `card_moved`, `claimed`, `attention_requested` and
   `attention_resolved` as dim entries, each as `activityLine` renders it (a request with a
   two-line note is two dim lines; the rest one); and the order is the activity's order.
   (Amended with the Desired-behavior paragraph, after review round 2 found the criterion
   still saying "single lines".) No colour
   escape anywhere in the frame (026's rule).
6. The chat frame at 100×24 shows the header at the top, the newest conversation lines at the
   bottom of the middle, the listening line, and the input line with the reverse-video cursor;
   with more lines than fit, the oldest are the ones not shown.
7. The listening line reads `crew is listening · running since <time>` for a card with a live
   claim, `no run is live; the next run reads what you write here` otherwise, and the
   question's first line with `allow · deny · or write` while a question is open.
8. Through the loop with a fake client: `Enter` on a row, typing a line, `Enter` calls `comment`
   with that line and the input is empty afterwards; `allow` with a question open calls
   `resolveAttention`; a refused `comment` puts the daemon's message on the listening line and
   the typed text back in the input.
9. `keysOf` decodes `\t` as `tab` and nothing else new; no 026 or 027 test is weakened or
   removed; the tests that pinned `Enter` opening the card view now open the chat and flip
   with `Tab` (say which, in the run record). (The approved text said "except the two that
   pin `Enter`"; thirteen tests reach the card view through `Enter`, ten in `keys.test.ts`
   and three in `board.test.ts`. A count guessed, not run — corrected by the orchestrator
   during development.)
10. The help view lists `Tab` and says `Enter` opens the chat.
11. `docs/MILESTONES.md` marks 033 landed at landing.

## Tests

- Criteria 2–5, 7 and 10 in `keys.test.ts` and `frame.test.ts`, pure, extending 027's.
- Criteria 6 and 8 in `board.test.ts` with the injected streams and fake client.
- Criterion 9 in `board.test.ts` beside 027's key-decoding cases.
- Red first: criteria 2–5 fail on today's code because there is no chat view.

## Out of scope

- **Any change to the daemon, the runner or the playbooks.** The card's record already carries
  what the view draws; if the conversation later needs a clearer split between the agent's
  text and its tool summaries, that is a data change for its own spec.
- **Waking an agent to answer when no run is live.** A run kind of its own, if ever; cards
  drive the runner.
- **A chat outside any card.** No card, no conversation.
- **A model on the owner's side answering free text.** A member, later.
- **Bracketed paste.** 027's finding stands for the board; inside the chat view a paste is
  text, and a newline in it sends and drops the tail as 027 does.
- **Drawing the body in the chat view.** `Tab`.
- **Editing sent lines, history, or a multi-line input.** One line, as the screen's prompt is.
