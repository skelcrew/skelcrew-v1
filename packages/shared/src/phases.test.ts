import { expect, test } from "bun:test";
import { PHASES } from "./index";

test("PHASES lists the five phases in track order with display names", () => {
  expect(PHASES.map((p) => p.id)).toEqual(["idea", "spec", "code", "pr", "done"]);
  expect(PHASES.map((p) => p.name)).toEqual(["Idea", "Spec", "Code", "PR", "Done"]);
});

test("every phase declares a one-line artefact", () => {
  for (const phase of PHASES) {
    expect(typeof phase.artefact).toBe("string");
    expect(phase.artefact.length).toBeGreaterThan(0);
    expect(phase.artefact).not.toContain("\n");
  }
});

test("only code may be left by any member; the rest are the owner's", () => {
  const exits = Object.fromEntries(PHASES.map((p) => [p.id, p.exit]));
  expect(exits).toEqual({ idea: "owner", spec: "owner", code: "any", pr: "owner", done: "owner" });
});

test("only spec and code are claimable: the phases where a run happens", () => {
  const claimable = Object.fromEntries(PHASES.map((p) => [p.id, p.claimable]));
  expect(claimable).toEqual({ idea: false, spec: true, code: true, pr: false, done: false });
});
