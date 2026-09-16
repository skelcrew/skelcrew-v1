# 027 — Acting from the screen (run record)

## The change, in steps

1. `packages/cli/src/board/keys.ts` — `Action` grows `resolve`, `move`, `comment` and
   `open-shell`; `a`, `d`, `m`, `b`, `c`, `o` on the board and in the card view; the prompt
   captures every key while it is open. A key that does not apply sets `state.message`.
2. `packages/cli/src/board/state.ts` — `State.prompt`: what the one-line input is for
   (`deny`, `back`, `comment`), the card it applies to, the phase `back` goes to, the text.
3. `packages/cli/src/board/frame.ts` — the bottom line is the prompt when one is open and the
   status message otherwise; the keys screen lists the new keys.
4. `packages/cli/src/board/ansi.ts` — the two bytes raw mode sends for Backspace, named.
   `packages/shared/src/text.test.ts`'s tripwire lists them beside the escape character and
   ctrl-c (it asserts the exact set that file spells).
5. `packages/cli/src/board/board.ts` — `perform(client, action)` makes the same calls
   `resolve.ts`, `mv.ts` and `comment.ts` make; a refusal's message goes on the status line.
   `o` leaves the terminal, awaits the injected `spawnShell`, re-enters it and reloads.
6. `packages/cli/src/commands/command.ts`, `packages/cli/src/main.ts` — `Context.dataDir`,
   which `main.ts` already resolves, so the board can find `worktreesDir(dataDir)/<id>`.
7. Tests: `keys.test.ts` (2, 3, 4), `frame.test.ts` (the prompt line), `board.test.ts` (5, 6,
   7; 026's tripwire removed as criterion 6 says).

## Decisions the spec left open

- **`prompt` is a field on `State`, not a `View`.** The prompt is one line at the bottom of
  whichever view is open — the board or a card stays drawn behind it — so it cannot be a third
  view without the frame having to remember what it covered.
- **"The open question" is the card's `attention`, whoever it is addressed to**, not only the
  requests addressed to me. The spec's own sentence about a refused call — "as it does for a
  request not addressed to the caller" — only happens if the key sends one.
- **`b`'s target phase is fixed when the prompt opens**, not when Enter is pressed, so the
  message and the move the owner saw named are the ones sent.
- **Ctrl-C still quits from inside the prompt.** 026 made it the one key every view answers
  the same way; Esc is the prompt's own cancel.
- **The message is cleared on a successful call** and set to the daemon's message on a refused
  one.
- **After `o`, the screen is redrawn from a fresh `load`** — the spec's words — which puts the
  cursor back on the first row.
- **The worktree must exist.** *(Written in round 1 as "`worktreesDir(dataDir)/<id>`, or the
  path the card's request note names, has to be a directory on disk, or the key says there is
  no worktree." That was wrong twice over: `existsSync` says yes to a regular file, and a path
  the note named was taken wherever it pointed. Corrected in fix round 1, below.)*
- **`b` with an empty message sends `mv <id> <phase>`** and posts no comment, rather than a
  comment the daemon would refuse. Only `d` has a default word, which the spec names.

## The 026 tests that changed

026's tests are unchanged except for these, each forced by the new behaviour:

- `keys.test.ts`'s "nothing else acts" listed `a d m b c o` among the keys that do nothing.
  Those six are the spec; the list keeps the keys that still do nothing.
- Every `State` fixture gains `prompt: null`, which the type now requires.
- `board.test.ts`'s `start`/`started` take the deps to override rather than a redraw interval,
  and its fake client takes the cards and records the calls. The tripwire test is removed, as
  criterion 6 says.
- `shared/src/text.test.ts` pins the exact control characters `board/ansi.ts` may spell; the
  two bytes raw mode sends for Backspace are added to that list. It is still an exact list.

## What was checked by hand

`bun run check` passes (845 tests). Beyond it, the screen was driven against a **real daemon**
started with `SKELCREW_RUNNER=0 SKELCREW_AGENT=none` on a scratch `SKELCREW_DIR`, through a
throwaway script that called `runBoard` with the real client and a faked terminal and shell:

- `m` on a request offering Code moved the card and resolved the request; the frame redrew from
  the daemon's own events, with the row now `Code queued` and the queue empty.
- `c looks good ⏎` posted the comment; `b needs a test ⏎` moved Code → Spec and posted it;
  `d not yet ⏎` posted `not yet` and resolved the request; `a` posted `allow` and resolved it.
- Backspace over the real key path: `c`, `a`, `b`, DEL, `c`, Enter posted `ac`.
- `o` on the queue row asked for `/bin/zsh` in the path the request note named, and the screen
  came back reloaded; that script's shell was recorded rather than started, so no process ran.
- The owner resolving a request addressed to `crew` is **allowed** by the daemon (only agents
  are restricted), so the refusal path cannot be reached as the owner; it is covered by the
  fake-client test the spec's criterion 5 asks for.

The scratch directory, the daemon and the throwaway script were removed afterwards.

## Review and verification

### Review cycle 1 — CHANGES REQUESTED

The reviewer ran `bun run check` (845 pass, 0 fail), read the whole diff, drove `runBoard`
with crafted request notes through a fake terminal and recording shell, and drove the real
daemon and CLI with the runner off to check who may write an attention note.

- **Important — the shell's directory comes from agent-written text with no containment
  check.** `worktreeOf` in `board.ts` passes the note's `the work is in <path>` straight to
  the spawn as `cwd`. `Bash(skelcrew attention *)` is on the runner's allowlist, so a spawned
  agent can put any path on the owner's queue; the reviewer did (`… the work is in
  /Users/simoncarstensen`) and `o` opened the owner's home directory. The spec's red-team
  sentence "a directory the daemon chose" is not true as implemented. Expected: accept the
  note's path only inside `worktreesDir(dataDir)`, else fall back or refuse.
- **Important — `existsSync` is not a directory check.** A note naming an existing file
  (`/etc/hosts`) makes `Bun.spawn` throw `ENOTDIR`, nothing catches it, and the screen exits.
  The run record's "has to be a directory on disk" was wrong. Expected: require an absolute
  directory, and answer "no worktree" otherwise.
- Minor: a note that says the phrase in prose (`the work is in the worktree`) disables the
  fallback to `worktreesDir/<id>`, and two occurrences capture from the first; the prompt cuts
  from the right so typing past the width is blind; empty `b` moves with no comment and empty
  `c` makes a round trip the daemon refuses; a refused comment after a successful move shows
  the raw error where `mv` wraps it; the spec's "026's tests unchanged" sentence is untrue
  (four changed, each forced, none loosened) and the run record's "cannot be reached as the
  owner" is untrue (an empty `c` reaches it); `b` on a card gone from the board reports "is in
  Idea".
- Checked and found correct: `questionOf` ignoring the addressee (the daemon fails closed for
  agents); every key maps to a pre-existing verb; no test spawns anything; criterion 6's table
  runs both the screen and the CLI command. The interactive behaviour of the real spawn is
  unverified without a tty.

### Fix round 1

The plan, in three steps:

1. `board.ts`'s `worktreeOf` decides where `o` may open a shell, under one rule: the path is a
   real directory under `worktreesDir(dataDir)`, whoever named it. The note's path is used only
   when it passes that; otherwise `worktreesDir(dataDir)/<id>` when that is a directory;
   otherwise there is no worktree and nothing is started (findings 1, 2, 3a). The note's phrase
   is read from its last occurrence, not its first (finding 3b). The code comment in `board`'s
   `spawnShell` says what the code now guarantees rather than repeating the spec's sentence.
2. `frame.ts`'s prompt line is cut from the left, so the end of what is being typed stays on
   the screen (finding 4).
3. Tests first, in `board.test.ts` (a note naming a path outside the worktrees root, a file, a
   relative path, prose, and two paths) and `frame.test.ts` (the prompt's tail).

What `o` opens, after the fix — this is the sentence the round-1 record got wrong:

> The directory is a real directory under `worktreesDir(dataDir)`, and nothing else. The path
> the card's request note names is used only when it is absolute and resolves to a directory
> under that root; otherwise the card's own `worktreesDir(dataDir)/<id>`, under the same rule;
> otherwise there is no worktree, the status line says so, and no shell is started.

Both sides are resolved with `realpath` before they are compared, because the CLI resolves
`SKELCREW_DIR` lexically while the runner writes its notes through `realpath` — on macOS the
same directory is then spelled `/var/…` and `/private/var/…`, and a lexical comparison would
reject every note the runner ever wrote.

The red, before the code changed, was one table of eight notes against what `o` did with each:
a path outside the root opened it (`…/outside`), a path naming a file was handed to the spawn
(`…/worktrees/notes.txt`, which is what makes `Bun.spawn` throw `ENOTDIR`), a relative `.`
opened the process's own directory, the phrase in prose and two occurrences both ended in no
worktree at all. The prompt test failed with `comment on #1: xxx…`, the end of the typed line
gone.

The other two changes:

- `frame.ts` gained `cutStart`, the mirror of `cut`: the prompt line keeps its end and drops
  its start, so the caret and the last characters typed stay on the screen (finding 4).
- The `spawnShell` comment in `board.ts` no longer repeats the spec's "the directory is a path
  the daemon chose"; it says what `worktreeOf` now guarantees — a note may name the directory,
  but it cannot choose one.

One test fixture moved rather than loosened: `board.test.ts`'s salvaged-worktree directory was
`<data dir>/salvaged`, outside the worktrees root, and is now `<data dir>/worktrees/1-salvaged`.
Every note the runner writes names a path under that root (`contracts.ts`, `run.ts`,
`runner.ts` all build it from `worktreesDir`), so the fixture now matches what the daemon
actually writes. Nothing else in 026's or 027's tests changed.

Findings 5–8 are untouched and carried into the PR.

### Review cycle 2 — CHANGES REQUESTED

A fresh reviewer ran `bun run check` (846 pass, 0 fail) and drove the real loop with its
own driver and nine crafted notes. Both cycle-1 Important findings confirmed fixed by
execution: an outside path, a file, a symlink out of the root and `<root>/1/../..` all open
the card's own worktree, and a data directory with no worktrees gives "no worktree" and no
spawn. Minors 3 and 4 confirmed fixed. Criterion 6's table confirmed to run both the loop and
the real command objects.

- **Important — a pasted chunk runs past the prompt.** `keysOf`/`onKey` in `board.ts` split
  one input chunk into keys and act on all of them. With the prompt open, delivering
  `"hi\nallow"` as one chunk posted the comment `hi`, then `a` allowed the open request,
  `l`/`l` moved, and `o` started the shell. Ordinary paste text does this. The spec says of
  the prompt "nothing else is interpreted". Expected: keys after a prompt-closing `Enter` in
  the same chunk are not executed as board commands (stop consuming the chunk, or keep a
  chunk containing a newline inside the prompt with the newlines dropped).
- Minor: the `worktreeOf` doc comment and the test comment say a salvaged run's note names
  "another directory under the same root"; every note-writing site uses
  `worktreePath(cardId)` = `<root>/<id>`, which is the fallback, so the note branch only
  matters when an agent names another card's worktree under the root; Ctrl-C quits from
  inside the prompt, which is the right behaviour and the spec sentence is what is wrong; a
  daemon lost while the owner is in the `o` shell prints the error into the shell's terminal.
- Unverified: the real `Bun.spawn` under a tty.

### Fix round 2

**The remedy chosen: stop consuming the chunk when a prompt closes.** The reviewer offered two,
and this is the first. One key that closes the prompt ends the chunk; whatever follows it in the
same chunk is dropped. The second — keep a chunk with a newline inside the prompt and drop the
newlines — was not taken because it turns two pasted lines into one message the owner never
typed, silently, and the prompt then still has to be sent by hand; this way the line the owner
ended with Enter is the line that is sent, which is what a one-line prompt promises. Dropping
the rest is visible: the comment appears on the card's feed and nothing else happens.

One line in `board.ts`'s `onKey` does it — `if (prompting && state.prompt === null) return;`
after the key has been acted on, where `prompting` is whether a prompt was open before the key.
Esc closes the prompt too, and the condition covers it, though `keysOf` only ever yields
`escape` for a chunk that is the escape character alone.

**The mirror case, with the prompt closed, is unchanged.** A multi-character chunk on the board
is still one key per character, which is 026's behaviour; the chosen remedy does not touch it,
and the finding was about the prompt. Pasting into the board with no prompt open therefore still
runs every character as a key.

The red, before `board.ts` changed, from the new test in `board.test.ts` ("a pasted chunk stops
at the prompt's Enter, rather than acting on the rest"): the prompt is opened with `c` and
`"hi\nallow"` is delivered as one chunk to the real loop.

```
expect(received).toEqual(expected)
    ],
+   [
+     "resolveAttention",
+     {
+       "id": 1,
+       "text": "allow",
+     },
+   ],
```

and, with the shell assertion put first to see how far it went:

```
- []
+ [
+   {
+     "cwd": "…/skc-board-6niQDU/worktrees/1",
+     "shell": "/bin/fish",
+   },
+ ]
```

So the comment posted, `a` allowed the open request and `o` started the shell — exactly what the
reviewer drove. After the change the test passes: one call, `["comment", { id: 1, text: "hi" }]`,
and no shell.

The Minor about the comments is fixed as three comment edits, with no fixture or assertion
touched: `worktreeOf`'s doc comment in `board.ts`, the fixture header in `board.test.ts`, and the
comment over the salvaged-note card. They now say what is true — a note may name any directory
under the runner's worktrees root and only that, and every note the daemon writes today names
`<root>/<id>`, which is also the fallback, because `teardownPath` keeps a dirty worktree where it
is. The local `const salvaged` in that test keeps its name, since the finding named the comments.

`bun run check`: 847 pass, 0 fail (846 before, plus the new test).

### Review cycle 3 — APPROVED

A fresh reviewer ran `bun run check` (847 pass, 0 fail) and drove the real loop with its own
driver. Cycle 2's Important confirmed fixed by execution: with the prompt open, the chunk
`"hi\nallow"` sends exactly one `comment` call and starts no shell. Also confirmed by running:
both Backspace bytes edit the prompt; `q`, `?` and `j` are text inside the prompt; five more
crafted notes for `o` (a symlink out of the root and `<root>/1/../../..` fall back, a trailing
space is trimmed); empty `b` sends only the move; a refusal leaves the rows as they were. The
corrected comments about salvaged worktrees were checked against `runner.ts` and are true.

Minor, carried to the PR: pasting onto the board with no prompt open still runs every
character as a key (`main` moved and allowed; bracketed paste would be a spec of its own); the
dropped tail of a pasted chunk is silent; a note naming the worktrees root itself passes
containment and opens a shell there (`real === root`; strictly-under would match the doc
comment); the raw Backspace bytes have no loop-level test; empty `b` has no table row; a
refused call loses the typed text because the prompt closes before the call.

### Verification — VERIFIED

`bun run check` green (Biome clean over 100 files, three packages typecheck, 847 pass, 0 fail).
No build step and no CI are configured; `check:harness` not applicable (no playbook or
allowlist changed). Every new test confirmed red against the base files (17 assertion
failures, no import errors) and load-bearing by eight mutations, each caught; criterion 6's
type-level guard confirmed by adding a seventh action kind and watching `tsc` fail. The
verifier's own loop-level driver sent both raw Backspace bytes through the real key path.
Criterion 8 (MILESTONES) deferred to landing by instruction. Two prose slips noted: the run
record under-counts the changed 026 tests by one (`frame.test.ts`'s colour case gained a prompt
state), and the spec's "nothing else is interpreted" is not literally true of Ctrl-C. The real
`Bun.spawn` of the shell under a tty stays unexercised by any test.
