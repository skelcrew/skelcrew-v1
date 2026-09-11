/**
 * The artefact contracts: what must exist for a phase to end. A phase is complete when its
 * artefact exists, never merely because the agent said the session went well — so a run whose
 * session ended normally and whose claim is still its own is checked here before the card is
 * handed on.
 *
 * Every check is read-only. What it produces is the run's last word — either what landed, with
 * the move the owner is offered, or every condition that did not, named.
 *
 * **The spec file is deliberately not a condition.** The card body is the spec, in the
 * daemon's SQLite; a spec file in the target repository is an export of it, and nothing
 * skelcrew does may require an export to exist. A repository that publishes no spec file
 * finishes its phases exactly like one that does — its pull request description carries the
 * spec for the reviewer.
 */
import { type CardRefs, COMMITS_MAX_COUNT, type Phase } from "@skelcrew/shared";
import type { RunCore } from "./ending";
import type { Git } from "./git";
import type { PlaybookPhase } from "./playbooks";

export interface ContractOutcome {
  met: boolean;
  /** The run's last word: the comment, and the note on the request. */
  note: string;
  /** What the owner is offered when the artefact is there; empty when it is not. */
  moves: Phase[];
  /** What the run records on the card once the artefact is there. */
  refs?: CardRefs;
}

export interface ContractInput {
  core: RunCore;
  git: Git;
  repoRoot: string;
  /** The card's worktree, the branch it is on, and the base branch that forked from. */
  worktreePath: string;
  branch: string;
  /** Where the branch stood before the agent started; the runner read it, so this is no new call. */
  branchHead: string;
  base: string;
  cardId: number;
  /** The `runner` member: whose `body_set` and `refs_set` count as this run's. */
  memberId: number;
  /** The last sequence number before the run began: what "during this run" means. */
  sinceSeq: number;
}

/**
 * An unmet contract is read from the owner's queue, and the worktree it failed in is kept —
 * so the note ends where the work is. Every escalation says where to `cd`.
 */
function withExitRamp(note: string, worktreePath: string): string {
  return `${note}; the work is in ${worktreePath}`;
}

/**
 * Spec: a body written by this run, and a non-empty one now. What must be new is that this
 * run recorded it — a body the card already carried is a previous run's, or the owner's.
 */
function specContract(input: ContractInput): ContractOutcome {
  const card = input.core.getCard(input.cardId);
  const wrote = card.activity.some(
    (event) =>
      event.seq > input.sinceSeq && event.type === "body_set" && event.actorId === input.memberId,
  );
  if (wrote && card.body.trim().length > 0) {
    return { met: true, note: "spec ready", moves: ["code"] };
  }
  return {
    met: false,
    note: withExitRamp("run finished without a spec", input.worktreePath),
    moves: [],
  };
}

/**
 * Code: new commits past the base, a clean worktree, and a pull request recorded *by this run*.
 *
 * The recording must be new, not the value. A card sent back from PR for revision pushes to
 * the same branch and keeps the same pull request, so requiring a *different* URL would strand
 * every revision; requiring nothing lets an idle revision run hand the card on using the
 * previous run's commits. 011's recorded keys are what make "this run recorded it" exact — the
 * merged refs on the event cannot answer it, because a card that already carried a `prUrl`
 * satisfies any check that looks at the value.
 *
 * And so must the commits be new. Recording is not evidence of work: the playbook records the
 * pull request on *every* run as bookkeeping, so a revision run that does exactly that and
 * commits nothing would meet all three conditions on the previous run's commits and hand the
 * owner their own feedback back as "ready for review" — this spec's Goal, reproduced inside the
 * mechanism built to stop it. So the branch must also have moved: the head the runner resolved
 * before the agent started is not the head now. Both halves are one condition and name
 * themselves as one, because either way no new commits landed.
 */
async function codeContract(input: ContractInput): Promise<ContractOutcome> {
  const card = input.core.getCard(input.cardId);
  const commits = await input.git.commitsBetween(input.repoRoot, input.base, input.branch);
  const head = await input.git.revParse(input.repoRoot, `refs/heads/${input.branch}`);
  const changed = await input.git.status(input.worktreePath);
  const recorded = card.activity.some(
    (event) =>
      event.seq > input.sinceSeq &&
      event.type === "refs_set" &&
      event.actorId === input.memberId &&
      (event.data.set ?? []).includes("prUrl"),
  );
  const prUrl = card.refs.prUrl;

  // Every unmet condition is named, in this order, so two failures read the same way each time.
  const unmet: string[] = [];
  if (commits.length === 0 || head === undefined || head === input.branchHead) {
    unmet.push(`no new commits on ${input.branch} past ${input.base}`);
  }
  if (changed.length > 0) {
    // The path is not repeated here: every unmet note ends with where the worktree is.
    unmet.push("uncommitted changes in the worktree");
  }
  if (!recorded || prUrl === undefined) {
    unmet.push("no pull request recorded during this run");
  }
  if (unmet.length > 0 || prUrl === undefined) {
    return {
      met: false,
      note: withExitRamp(
        `run finished without the Code phase's artefact: ${unmet.join("; ")}`,
        input.worktreePath,
      ),
      moves: [],
    };
  }
  return {
    met: true,
    note: `ready for review: ${prUrl}`,
    moves: ["pr"],
    // Newest first, so a range longer than a card's refs may hold keeps the run's own work.
    refs: { commits: commits.slice(0, COMMITS_MAX_COUNT) },
  };
}

export function checkContract(
  phase: PlaybookPhase,
  input: ContractInput,
): Promise<ContractOutcome> {
  return phase === "spec" ? Promise.resolve(specContract(input)) : codeContract(input);
}
