/**
 * The artefact contracts: what must exist for a run to end well. A phase is complete when its
 * artefact exists, never merely because the agent said the session went well — so a run whose
 * session ended normally and whose claim is still its own is checked here before the card is
 * handed on. There are three, chosen by run kind rather than by phase: the Code phase's loop
 * runs a review between its Code runs, and a review run's artefact is the verdict it recorded.
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
import { type CardRefs, COMMITS_MAX_COUNT, type Phase, type ReviewVerdict } from "@skelcrew/shared";
import type { RunCore } from "./ending";
import type { Git } from "./git";
import type { PlaybookKind } from "./playbooks";

export interface ContractOutcome {
  met: boolean;
  /** The run's last word: the comment, and the note on the request. */
  note: string;
  /** What the owner is offered when the artefact is there; empty when it is not. */
  moves: Phase[];
  /** What the run records on the card once the artefact is there. */
  refs?: CardRefs;
  /**
   * What a met review contract concluded: the last verdict the review run recorded. The loop
   * in `runner.ts` acts on this and on nothing else — an unmet contract carries none, so a
   * verdict recorded by a run that moved the branch or left the worktree dirty is ignored.
   */
  verdict?: ReviewVerdict;
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
  /**
   * The `crew` member the agent spoke as: whose `body_set` and `refs_set` count as this run's.
   * The artefact is the agent's to produce, so it is the agent's writes that are counted — the
   * runner's own `refs_set` records the branch and answers no condition here.
   */
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

/**
 * Review: a verdict recorded *by this run*, the branch left where it was found, and a clean
 * worktree. Every unmet condition is named, in that order.
 *
 * The verdict has to be the review run's own — `crew`'s, inside this run's sequence window —
 * because the loop's budget is the runner's and nothing the agent does may reach it: a verdict
 * the owner recorded, or one `crew` recorded during the *Code* run, is activity on the card and
 * nothing more. The last one the run recorded is what it concluded; a run that recorded two has
 * changed its mind, which is legible, and a run that recorded none has not reviewed anything.
 *
 * The other two conditions are what a review run must not have done. They are not a boundary —
 * a check command's subprocess can commit and push, and no rule in `allowlist.ts` reaches
 * inside one — but they are what catches it in the ordinary course, and they bite whatever the
 * verdict says, which is why the verdict is dropped when they do.
 */
async function reviewContract(input: ContractInput): Promise<ContractOutcome> {
  const card = input.core.getCard(input.cardId);
  const recorded = card.activity.filter(
    (event) =>
      event.seq > input.sinceSeq &&
      event.type === "review_recorded" &&
      event.actorId === input.memberId,
  );
  const last = recorded.at(-1);
  const head = await input.git.revParse(input.repoRoot, `refs/heads/${input.branch}`);
  const changed = await input.git.status(input.worktreePath);

  const unmet: string[] = [];
  if (last === undefined) unmet.push("review run ended without a verdict");
  if (head === undefined || head !== input.branchHead) {
    unmet.push("the branch moved during the review run");
  }
  if (changed.length > 0) unmet.push("uncommitted changes in the worktree");
  if (unmet.length > 0 || last?.type !== "review_recorded") {
    return { met: false, note: withExitRamp(unmet.join("; "), input.worktreePath), moves: [] };
  }
  // The note is the loop's to compose: what a met review means depends on the verdict and on
  // the round, which the contract knows nothing about.
  return { met: true, note: "", moves: [], verdict: last.data.verdict };
}

export function checkContract(kind: PlaybookKind, input: ContractInput): Promise<ContractOutcome> {
  switch (kind) {
    case "spec":
      return Promise.resolve(specContract(input));
    case "code":
      return codeContract(input);
    case "review":
      return reviewContract(input);
  }
}
