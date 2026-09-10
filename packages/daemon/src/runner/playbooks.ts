/**
 * The built-in playbooks: one markdown file per claimable phase, shipped with the daemon,
 * read at startup and injected into the agent as its system prompt. Never written into the
 * target repository — the repository contributes its own conventions through its
 * `AGENTS.md`/`CLAUDE.md`, which both playbooks read first. Loading refuses an empty
 * playbook, so a broken install fails at boot rather than mid-run.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type PlaybookPhase = "spec" | "code";
export type Playbooks = Record<PlaybookPhase, string>;

export const PLAYBOOKS_DIR = fileURLToPath(new URL("../../playbooks/", import.meta.url));
export const PLAYBOOK_PHASES: readonly PlaybookPhase[] = ["spec", "code"];

export function loadPlaybooks(dir: string = PLAYBOOKS_DIR): Playbooks {
  const read = (phase: PlaybookPhase): string => {
    const path = join(dir, `${phase}.md`);
    const text = readFileSync(path, "utf8");
    if (text.trim().length === 0) throw new Error(`playbook ${path} is empty`);
    return text;
  };
  return { spec: read("spec"), code: read("code") };
}
