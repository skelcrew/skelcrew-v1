/**
 * The phase track. Not a table: the closed set of phase ids is this constant, and the
 * daemon's schema constrains the card's phase column to it.
 *
 * `exit` is who may move a card out of the phase. The owner's gates are what gets worked on
 * (leaving Idea), what gets built (leaving Spec), and what ships (leaving PR); the crew's
 * only handoff is Code → PR, so `code` is the one phase any member may leave.
 */
export interface PhaseDef {
  readonly id: Phase;
  readonly name: string;
  /** One line: what must exist on the card or in the repo when the phase ends. */
  readonly artefact: string;
  readonly exit: "owner" | "any";
}

export type Phase = "idea" | "spec" | "code" | "pr" | "done";

export const PHASES: readonly PhaseDef[] = [
  { id: "idea", name: "Idea", artefact: "A card with a title and a rough idea", exit: "owner" },
  { id: "spec", name: "Spec", artefact: "An approved spec on the card", exit: "owner" },
  { id: "code", name: "Code", artefact: "A branch with commits and a pull request", exit: "any" },
  { id: "pr", name: "PR", artefact: "A merged pull request", exit: "owner" },
  { id: "done", name: "Done", artefact: "Nothing further; the card is finished", exit: "owner" },
];
