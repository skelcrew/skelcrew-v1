import { expect, test } from "bun:test";
import { selectAgent } from "./none";

test("unset, empty, or `claude` selects the Agent SDK; `none` selects no driver", () => {
  expect(selectAgent({})).toBe("claude");
  expect(selectAgent({ SKELCREW_AGENT: "" })).toBe("claude");
  expect(selectAgent({ SKELCREW_AGENT: "claude" })).toBe("claude");
  expect(selectAgent({ SKELCREW_AGENT: "none" })).toBe("none");
});

test("anything else is an error naming the value, never a guess", () => {
  expect(() => selectAgent({ SKELCREW_AGENT: "nope" })).toThrow('"nope"');
  expect(() => selectAgent({ SKELCREW_AGENT: "Claude" })).toThrow();
});
