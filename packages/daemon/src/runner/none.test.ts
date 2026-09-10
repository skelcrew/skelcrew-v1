import { expect, test } from "bun:test";
import { selectAgent } from "./none";

test("unset or empty selects the claude driver", () => {
  expect(selectAgent({})).toBe("claude");
  expect(selectAgent({ SKELCREW_AGENT: "" })).toBe("claude");
  expect(selectAgent({ SKELCREW_AGENT: "claude" })).toBe("claude");
});

test("none selects no driver at all, which is 006's behaviour", () => {
  expect(selectAgent({ SKELCREW_AGENT: "none" })).toBe("none");
});

test("an unrecognised value is refused, naming the variable and the value", () => {
  expect(() => selectAgent({ SKELCREW_AGENT: "nope" })).toThrow(/SKELCREW_AGENT/);
  expect(() => selectAgent({ SKELCREW_AGENT: "nope" })).toThrow(/nope/);
  // Not a near miss either: a typo must not decide whether an agent gets spawned.
  expect(() => selectAgent({ SKELCREW_AGENT: "Claude" })).toThrow(/SKELCREW_AGENT/);
  expect(() => selectAgent({ SKELCREW_AGENT: "off" })).toThrow(/SKELCREW_AGENT/);
});
