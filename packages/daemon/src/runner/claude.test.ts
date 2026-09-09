import { expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentDriver, AgentEvent } from "./agent";
import { type claudeDriver, drive, toEvents } from "./claude";

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

/** The harness's message stream, as the driver consumes it. */
async function* stream(messages: SDKMessage[]): AsyncGenerator<SDKMessage> {
  yield* messages;
}

test("the transcript is every SDK message, once and in arrival order, whatever the card shows of it", async () => {
  const boot = sdk({ type: "system", subtype: "init", tools: ["Read"] });
  const asked = sdk({ type: "user", message: { content: [{ type: "text", text: "the card" }] } });
  const thought = sdk({
    type: "assistant",
    message: { content: [{ type: "thinking", thinking: "hmm" }] },
  });
  const worked = sdk({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Reading the card." },
        { type: "tool_use", name: "Bash", input: { command: "bun test" } },
      ],
    },
  });
  const done = sdk({ type: "result", subtype: "success", is_error: false, result: "all good" });
  const after = sdk({ type: "system", subtype: "compact_boundary" });

  const logged: unknown[] = [];
  const shown: AgentEvent[] = [];
  for await (const event of drive(stream([boot, asked, thought, worked, done, after]), (entry) =>
    logged.push(entry),
  )) {
    shown.push(event);
  }

  // The three that display nothing are in the record all the same, and the turn with two
  // blocks is there once, not once per block. Nothing past the result is read.
  expect(logged).toEqual([boot, asked, thought, worked, done]);
  // What the card shows is unchanged: the projection, not the record.
  expect(shown).toEqual([
    { type: "text", text: "Reading the card." },
    { type: "tool_use", name: "Bash", input: { command: "bun test" } },
    { type: "result", ok: true },
  ]);
});

test("every SDK message kind the card shows becomes its events; the rest display nothing", async () => {
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
        { type: "text", text: "Reading the card." },
        { type: "tool_use", name: "Bash", input: { command: "bun test" } },
        { type: "tool_use", name: "TodoWrite", input: {} },
      ],
    ],
    [output, [{ type: "tool_result", text: "3 pass", isError: false }]],
    [failure, [{ type: "tool_result", text: "1 fail", isError: true }]],
    [done, [{ type: "result", ok: true }]],
    [refused, [{ type: "result", ok: false, error: "no auth" }]],
    [gaveUp, [{ type: "result", ok: false, error: "error_max_turns: turn 40; gave up" }]],
    [crashed, [{ type: "result", ok: false, error: "error_during_execution" }]],
    [boot, []],
    [empty, []],
  ];

  expect(cases.map(([message]) => toEvents(message))).toEqual(cases.map(([, events]) => events));

  // Displaying nothing is not the same as being dropped: the two that project to no event
  // are still written to the transcript, whole.
  const logged: unknown[] = [];
  for await (const _ of drive(stream([boot, empty, done]), (entry) => logged.push(entry)));
  expect(logged).toEqual([boot, empty, done]);
});
