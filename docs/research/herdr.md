# Herdr

`herdrdev/herdr` — read end to end 2026-09-10. A terminal runtime in Rust: a background server
owning PTYs, a mouse-first TUI client, saved SSH machines, and a socket API agents drive through
the same CLI a human uses. It has no work item anywhere in its API — panes, tabs and workspaces
are the whole model — so it sits underneath skelcrew rather than beside it, and is additive
rather than competing.

What it contributes is the state question. Herdr classifies every pane `working | blocked |
idle | done | unknown` from ~21 hot-updatable TOML manifests of priority-ordered regexes matched
against a bottom-of-screen snapshot, fetched from a URL and versioned independently of the
binary. It reads the screen because it does not own the spawn. Orca refuses that approach and
takes status from hooks instead; skelcrew owns the spawn and the SDK stream, so it starts where
orca ended up. The one finding that outlives the difference:

<!-- Findings carried into the specs they affect live in `docs/MILESTONES.md`, which points
back here. This file is the evidence; the entry is the decision. -->

- **Nobody has a good answer for alive-but-stuck except watching it (012/013).** AGENTS.md
  names this as the one Gas Town part with no counterpart here, and both neighbours confirm it:
  each solved it by observation rather than trust. Herdr classifies every pane `working |
  blocked | idle | done | unknown` from ~21 hot-updatable manifests of regexes matched against
  a bottom-of-screen snapshot, and orca keeps process liveness and agent liveness as separate
  verdicts because a live terminal can hold a dead agent. Herdr needs that machinery only
  because it does not own the spawn; 013's `canUseTool` covers the same ground properly for
  everything the agent can report. The residual case is the one it cannot — the harness blocking
  below the agent — where owning the subprocess makes silence on a live process the cheap signal,
  and the permission posture 013 settles is the real fix.
