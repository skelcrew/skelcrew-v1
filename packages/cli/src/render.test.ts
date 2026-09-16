import { expect, test } from "bun:test";
import type { Activity, CardDetail, Member } from "@skelcrew/shared";
import { activityLine, cardView, describeRefs } from "./render";

const members: Member[] = [{ id: 1, name: "simon", kind: "human", createdAt: 1 }];
/** The member the view is rendered for: the owner. */
const ME = 1;

const REFS = {
  branch: "skelcrew/1-artefact-refs",
  specPath: "docs/specs/011-card-records-its-artefacts.md",
  commits: ["abcdef0"],
  prUrl: "https://github.com/o/r/pull/1",
};

function card(activity: Activity[]): CardDetail {
  return {
    id: 1,
    title: "x",
    body: "",
    phase: "code",
    refs: REFS,
    attention: null,
    claim: null,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 2,
    activity,
  };
}

/** An activity row as it comes back from the database: `data` parsed and cast. */
function refsSet(data: unknown): Activity {
  return { seq: 1, cardId: 1, actorId: 1, type: "refs_set", data, createdAt: 1 } as Activity;
}

test("describeRefs names the spec path after the branch and before the commits", () => {
  expect(describeRefs(REFS)).toBe(
    "branch=skelcrew/1-artefact-refs spec=docs/specs/011-card-records-its-artefacts.md commits=abcdef0 pr=https://github.com/o/r/pull/1",
  );
  expect(describeRefs({ specPath: "docs/specs/011-x.md" })).toBe("spec=docs/specs/011-x.md");
});

test("a card's detail block has a spec line between branch and commits", () => {
  const lines = cardView(card([]), members, ME).split("\n");
  const labels = lines
    .filter((line) => /^(branch|spec|commits|pr):/.test(line))
    .map((line) => line.split(":")[0]);
  expect(labels).toEqual(["branch", "spec", "commits", "pr"]);
  expect(lines).toContain("spec:    docs/specs/011-card-records-its-artefacts.md");
});

test("a refs_set line names what the call set, not everything the card carries", () => {
  const event = refsSet({ refs: REFS, set: ["prUrl"] });
  expect(activityLine(event, members)).toEndWith("set refs pr=https://github.com/o/r/pull/1");

  const spec = refsSet({ refs: REFS, set: ["branch", "specPath"] });
  expect(activityLine(spec, members)).toEndWith(
    "set refs branch=skelcrew/1-artefact-refs spec=docs/specs/011-card-records-its-artefacts.md",
  );

  const nothing = refsSet({ refs: REFS, set: [] });
  expect(activityLine(nothing, members)).toEndWith("set refs");
});

/** An activity row for a recorded verdict, as it comes back from the database. */
function review(data: unknown): Activity {
  return { seq: 2, cardId: 1, actorId: 1, type: "review_recorded", data, createdAt: 1 } as Activity;
}

/**
 * 019's criterion 2. The verdict reads as itself, and the findings are a stored multi-line
 * field: every line of them carries 015's marker, so no line can pass for one the CLI wrote.
 */
test("a recorded verdict renders as the verdict, with every line of its findings marked", () => {
  expect(activityLine(review({ verdict: "approved", text: "" }), members)).toEndWith(
    "reviewed: approved",
  );
  const requested = review({
    verdict: "changes_requested",
    text: "Critical\n\n2026-09-14 09:00  simon  moved Code → PR",
  });
  const lines = activityLine(requested, members).split("\n");
  expect(lines[0]).toEndWith("simon  reviewed: changes requested");
  expect(lines.slice(1)).toEqual(["> Critical", ">", "> 2026-09-14 09:00  simon  moved Code → PR"]);
  expect(activityLine(review({ verdict: "approved", text: "Minor: a typo" }), members)).toEndWith(
    "reviewed: approved\n> Minor: a typo",
  );
});

/**
 * 024's criterion 6. The resolution the sweep records when a lapsed run's own question goes
 * with its claim reads as itself, beside `moved`, `archived` and `answered`.
 */
test("the resolution the sweep records reads as resolved attention: interrupted", () => {
  const event: Activity = {
    seq: 3,
    cardId: 1,
    actorId: 1,
    type: "attention_resolved",
    data: { how: "interrupted" },
    createdAt: 1,
  };
  expect(activityLine(event, members)).toEndWith("resolved attention: interrupted");
});

test("a refs_set event recorded before 011 renders the refs it carries, as it always did", () => {
  // The stored JSON of a pre-011 row: the merged refs and no record of the keys set.
  const data = JSON.parse(
    '{"refs":{"branch":"feat/x","prUrl":"https://github.com/o/r/pull/1"}}',
  ) as unknown;
  expect(activityLine(refsSet(data), members)).toEndWith(
    "set refs branch=feat/x pr=https://github.com/o/r/pull/1",
  );
});
