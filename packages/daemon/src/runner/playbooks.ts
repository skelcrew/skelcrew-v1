/**
 * The built-in playbooks: one markdown file per kind of run, shipped with the daemon, read at
 * startup and injected into the agent as its system prompt. Never written into the target
 * repository — the repository contributes its own conventions through its `AGENTS.md`/
 * `CLAUDE.md`, which every playbook reads first. Loading refuses an empty playbook, so a
 * broken install fails at boot rather than mid-run.
 *
 * **A kind is not a phase.** Two of the three are the claimable phases, and the third is the
 * review run the Code phase's loop starts between its own runs: review cycles happen inside a
 * phase and show as activity, never as phases of their own. So `PLAYBOOK_PHASES` is still what
 * a card can be claimed in, and `PLAYBOOK_KINDS` is what a run can be.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type PlaybookPhase = "spec" | "code";
/** A run kind: a claimable phase, or the review run inside Code. */
export type PlaybookKind = PlaybookPhase | "review";
export type Playbooks = Record<PlaybookKind, string>;

export const PLAYBOOKS_DIR = fileURLToPath(new URL("../../playbooks/", import.meta.url));
export const PLAYBOOK_PHASES: readonly PlaybookPhase[] = ["spec", "code"];
export const PLAYBOOK_KINDS: readonly PlaybookKind[] = ["spec", "code", "review"];

export function loadPlaybooks(dir: string = PLAYBOOKS_DIR): Playbooks {
  const read = (kind: PlaybookKind): string => {
    const path = join(dir, `${kind}.md`);
    const text = readFileSync(path, "utf8");
    if (text.trim().length === 0) throw new Error(`playbook ${path} is empty`);
    return text;
  };
  return { spec: read("spec"), code: read("code"), review: read("review") };
}
