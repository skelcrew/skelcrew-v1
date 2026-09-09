import { expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentDriver, AgentEvent } from "./agent";
import { type claudeDriver, toEvents } from "./claude";

/**
 * The SDK driver is never run here: no test spawns a coding agent. What is checked is that
 * it satisfies the driver interface the run is written against — a type-level check `tsc`
 * enforces, made a test so the file is not silently skipped — and the translation from the
 * SDK's messages to the run's events, which every excerpt, tool summary, and transcript
 * line of a real run goes through. `toEvents` is a pure function over message literals:
 * calling it starts nothing.
 */
type Conforms = typeof claudeDriver extends AgentDriver ? true : never;

test("claudeDriver satisfies AgentDriver at the type level", () => {
  const conforms: Conforms = true;
  expect(conforms).toBe(true);
});

/** A message as the SDK delivers it, carrying the fields the translation reads. */
function sdk(message: Record<string, unknown>): SDKMessage {
  return message as unknown as SDKMessage;
}

test("every SDK message kind the card shows becomes its events; the rest carry nothing", () => {
  const turn = sdk({
    type: "assistant",
    message: {
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "Reading the card." },
        { type: "text", text: "" },
        { type: "tool_use", name: "Bash", input: { command: "bun test" } },
        { type: "tool_use", name: "TodoWrite" },
      ],
    },
  });
  const output = sdk({
    type: "user",
    message: {
      content: [
        { type: "text", text: "ignored" },
        { type: "tool_result", content: "3 pass" },
      ],
    },
  });
  const failure = sdk({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          content: [
            { type: "text", text: "1 fail" },
            { type: "image" },
            { type: "text", text: "" },
          ],
          is_error: true,
        },
      ],
    },
  });
  const done = sdk({ type: "result", subtype: "success", is_error: false, result: "all good" });
  const refused = sdk({ type: "result", subtype: "success", is_error: true, result: "no auth" });
  const gaveUp = sdk({
    type: "result",
    subtype: "error_max_turns",
    errors: ["turn 40", "gave up"],
  });
  const crashed = sdk({ type: "result", subtype: "error_during_execution", errors: [] });
  const boot = sdk({ type: "system", subtype: "init" });
  const empty = sdk({ type: "assistant", message: { content: "not blocks" } });

  const cases: Array<[SDKMessage, AgentEvent[]]> = [
    [
      turn,
      [
        { type: "text", text: "Reading the card.", raw: turn },
        { type: "tool_use", name: "Bash", input: { command: "bun test" }, raw: turn },
        { type: "tool_use", name: "TodoWrite", input: {}, raw: turn },
      ],
    ],
    [output, [{ type: "tool_result", text: "3 pass", isError: false, raw: output }]],
    [failure, [{ type: "tool_result", text: "1 fail", isError: true, raw: failure }]],
    [done, [{ type: "result", ok: true, raw: done }]],
    [refused, [{ type: "result", ok: false, error: "no auth", raw: refused }]],
    [
      gaveUp,
      [{ type: "result", ok: false, error: "error_max_turns: turn 40; gave up", raw: gaveUp }],
    ],
    [crashed, [{ type: "result", ok: false, error: "error_during_execution", raw: crashed }]],
    [boot, []],
    [empty, []],
  ];

  expect(cases.map(([message]) => toEvents(message))).toEqual(cases.map(([, events]) => events));
});
