# 023 — A question is announced

The second of three specs from the first evening of real use (022, 023, 024).

## Goal

When a card starts waiting on the owner, the owner should hear about it without polling. Last
night a run stopped on a question at 20:09 and nobody knew; by 20:13 the laptop had slept and
the run was lost. 010 built the ping — a desktop notification when a request addresses you —
but only inside `skelcrew watch`, and the owner was not running `watch`. The daemon knew the
moment the request was raised and said nothing. After this spec a daemon that the owner started
in a terminal announces every request addressed to a human, the same way `watch` does, and rings
that terminal's bell. `watch` keeps doing what it does, for the owner watching from elsewhere.
This spec grants nothing; the daemon spawns the same notifier command the CLI already spawns.

## Current behavior

- `packages/cli/src/notify.ts`: `selectNotifier(env, platform)` picks `SKELCREW_NOTIFY` (a
  command given title and text as arguments), else `osascript` on macOS, else `notify-send` on
  `PATH`, else a printed line. `notify(notifier, title, text, print)` spawns it and waits.
- `packages/cli/src/commands/watch.ts:36-70`: on an `attention_requested` event addressed to the
  invoking member, `watch` reads the card back, confirms the request is still the open one, and
  pings with `#<id> <title>: <note>` on one line. 010's spec chose "OS notification from a watch
  mode; the spec decides the mechanism" and recorded that the daemon does not notify.
- `packages/daemon/src/main.ts`: the daemon subscribes nothing to attention events. Its own
  output is one `listening on` line and warnings on stderr.
- `docs/MILESTONES.md`'s "Later" list names "notification channels beyond the local ping"; the
  local ping is the `watch` one.
- Observed: on 2026-09-14 the owner learned of a question by running `ls` and seeing `!`, after
  the run had already been lost to sleep.

## Desired behavior

**A daemon in a terminal announces.** When the daemon's standard output is a terminal and a
request is raised to a human member, the daemon rings the bell on that terminal and sends one
notification through the same notifier `watch` uses: title `skelcrew`, text
`#<id> <title>: <first line of the note>`. A request raised to an agent member is not
announced. A request that replaces an earlier open one is announced again, because it is a new
thing to answer.

**A headless daemon does not.** Started by launchd or with output redirected, the daemon sends
nothing; `watch` remains the way a remote or headless owner is pinged. `SKELCREW_NOTIFY=none`
turns the daemon's announcement off in a terminal too, and `SKELCREW_NOTIFY=<command>` routes it
through that command, as it does for `watch`.

**A failing notifier is a warning, not a failure.** If the notifier command cannot be spawned
or exits non-zero, the daemon warns once per process and goes on; the request is on the card
either way.

**`watch` is unchanged**, and an owner running both a terminal daemon and `watch` on the same
machine gets two notifications for one request. Recorded as the cost of not coupling the two.

## Implementation approach

Move `notify.ts` from `packages/cli/src/` to `packages/shared/src/notify.ts` and export it from
the shared index; `watch.ts` imports it from there. It has no CLI dependency. The `osascript`
argument form is unchanged; it is a double-quoted AppleScript literal with `\` and `"` escaped,
which 010 wrote and tested, and the text is one line by construction (`oneLine`), so a control
character cannot reach it (015).

In `main.ts`, beside the sweep and the merge poll: when `process.stdout.isTTY` and
`SKELCREW_NOTIFY !== "none"`, subscribe to the core's activity and, on `attention_requested`
whose `to` is a human member, write `\x07` to stdout and call `notify` with the same text
`watch` builds. Announcing is not a member action and records nothing on the card. The
subscription is torn down on shutdown with the other timers.

Decisions resolved from the repository: the daemon announces only when attached to a terminal,
because a daemon on an always-on machine has no owner beside it and `watch` is the client where
the owner is; the two-notification overlap is accepted rather than adding a handshake between
client and daemon. `SKELCREW_NOTIFY=none` rather than a new variable, because 010 already made
that variable the notifier's switch.

## Acceptance criteria

1. `bun run check` passes; no test fires a real notification — tests point `SKELCREW_NOTIFY` at
   a recording script, as 010's do.
2. `packages/shared/src/notify.ts` exists with 010's behaviour; `watch`'s existing tests pass
   unchanged.
3. A daemon started with stdout attached to a pseudo-terminal and `SKELCREW_NOTIFY` pointing at
   a recording script, on a request raised to the owner: the script is invoked exactly once with
   title `skelcrew` and a text containing `#<id>`, the title and the note's first line; and a
   `\x07` byte appears on the daemon's stdout. (A pseudo-terminal in tests via `script`, the way
   the shell stub tests do, or by a driver option that makes the TTY check injectable; say which
   in the run record.)
4. The same daemon, on a request raised to an agent member: the script is not invoked.
5. A daemon started with stdout redirected to a file: the script is not invoked, whatever is
   raised.
6. A daemon in a terminal with `SKELCREW_NOTIFY=none`: no invocation and no bell.
7. A daemon whose notifier command does not exist: one warning on stderr naming it, the request
   still on the card, and no second warning on the next request.
8. `main.ts` records why a headless daemon does not announce and that `watch` is the ping for
   that case; MILESTONES's "local ping" wording is updated at landing.

## Tests

- Criteria 3–7 in `process.test.ts`, which already drives the real daemon with shims on `PATH`
  and environment overrides.
- Criterion 2 by the moved file's existing unit tests and `watch`'s.

## Out of scope

- **Channels beyond the local machine** (Slack, email, push). MILESTONES's "Later".
- **Reminders or repeats** for a request that stays open. 010 deferred these; the first evening
  suggests one might be wanted, so it is a finding, not this spec.
- **Announcing anything but a request**: a finished run, a merged card. Those show in `ls`
  (024) and are not questions.
- **Coupling `watch` and the daemon** so only one of them pings.
