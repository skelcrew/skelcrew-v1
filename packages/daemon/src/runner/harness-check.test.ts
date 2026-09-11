/**
 * The parts of `bun run check:harness` that can be tested without it: the stub that plays the
 * model, the stub executables the commands land on, and the pass/fail logic. Nothing here
 * spawns the harness — the check itself is what does that, and `bun test` does not run it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTROL_COMMAND,
  type CommandOutcome,
  problemsIn,
  STUB_API_KEY,
  startStubModel,
  writeStubExecutables,
} from "./harness-check";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skr-hc-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** One SSE payload's events, in order, as `[event name, data]`. */
function events(body: string): Array<[string, Record<string, unknown>]> {
  const out: Array<[string, Record<string, unknown>]> = [];
  for (const block of body.split("\n\n")) {
    const name = /^event: (.*)$/m.exec(block)?.[1];
    const data = /^data: (.*)$/m.exec(block)?.[1];
    if (name !== undefined && data !== undefined) out.push([name, JSON.parse(data)]);
  }
  return out;
}

async function post(url: string, body: unknown): Promise<string> {
  const response = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "the-dummy-key" },
    body: JSON.stringify(body),
  });
  return await response.text();
}

const prompt = { model: "a-model", messages: [{ role: "user", content: "Run the command." }] };
const result = {
  model: "a-model",
  messages: [
    { role: "user", content: "Run the command." },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "" }] },
  ],
};

test("the stub answers a prompt with one Bash tool call carrying the command", async () => {
  const stub = startStubModel("git status");
  try {
    const emitted = events(await post(stub.url, prompt));
    const names = emitted.map(([name]) => name);
    expect(names).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const [, start] = emitted[1] as [string, Record<string, unknown>];
    expect(start.content_block).toMatchObject({ type: "tool_use", name: "Bash" });
    const [, delta] = emitted[2] as [string, Record<string, unknown>];
    const partial = (delta.delta as { partial_json: string }).partial_json;
    expect(JSON.parse(partial)).toMatchObject({ command: "git status" });
    const [, stop] = emitted[4] as [string, Record<string, unknown>];
    expect((stop.delta as { stop_reason: string }).stop_reason).toBe("tool_use");
  } finally {
    stub.stop();
  }
});

test("the stub ends the turn on a tool result, asking for nothing more", async () => {
  const stub = startStubModel("git status");
  try {
    const emitted = events(await post(stub.url, result));
    expect(emitted.map(([name]) => name)).not.toContain("content_block_start_tool_use");
    for (const [, data] of emitted) {
      expect(JSON.stringify(data)).not.toContain("tool_use");
    }
    const stop = emitted.find(([name]) => name === "message_delta")?.[1] ?? {};
    expect((stop.delta as { stop_reason: string } | undefined)?.stop_reason).toBe("end_turn");
  } finally {
    stub.stop();
  }
});

test("the stub records every request it saw, with the credential it was given", async () => {
  const stub = startStubModel("git status");
  try {
    expect(stub.requests).toEqual([]);
    await post(stub.url, prompt);
    await post(stub.url, result);
    expect(stub.requests).toEqual([
      { method: "POST", path: "/v1/messages", apiKey: "the-dummy-key" },
      { method: "POST", path: "/v1/messages", apiKey: "the-dummy-key" },
    ]);
  } finally {
    stub.stop();
  }
});

test("the stub listens on the loopback address only", () => {
  const stub = startStubModel("git status");
  try {
    expect(stub.url).toStartWith("http://127.0.0.1:");
  } finally {
    stub.stop();
  }
});

test("every command word gets an executable that exits 0 and writes nothing", () => {
  const words = writeStubExecutables(dir, [
    "git status",
    "git push -u origin HEAD",
    "gh pr view --json url --jq .url",
    "skelcrew show PLACEHOLDER",
    "bun run check",
  ]);
  expect(words.toSorted()).toEqual(["bun", "gh", "git", "skelcrew"]);
  for (const word of words) {
    const run = Bun.spawnSync([join(dir, word), "any", "argument"], { env: {} });
    expect([word, run.exitCode, run.stdout.toString(), run.stderr.toString()]).toEqual([
      word,
      0,
      "",
      "",
    ]);
  }
});

const clean = (command: string): CommandOutcome => ({
  command,
  executed: true,
  denials: [],
  requests: 2,
  canUseToolCalls: 0,
  credentials: [STUB_API_KEY],
});

const control: CommandOutcome = {
  command: CONTROL_COMMAND,
  executed: false,
  denials: [{ tool: "Bash", reason: "dontAsk mode" }],
  requests: 2,
  canUseToolCalls: 0,
  credentials: [STUB_API_KEY],
};

test("a run where every prescribed command executed and the control was denied passes", () => {
  expect(problemsIn([clean("git status"), clean("git add ."), control])).toEqual([]);
});

test("a prescribed command the harness denied fails the check, naming it and the reason", () => {
  const denied: CommandOutcome = {
    ...clean("skelcrew mv PLACEHOLDER"),
    executed: false,
    denials: [{ tool: "Bash", reason: "Permission to use Bash has been denied" }],
  };
  const problems = problemsIn([clean("git status"), denied, control]);
  expect(problems.length).toBe(1);
  expect(problems[0]).toContain("skelcrew mv PLACEHOLDER");
  expect(problems[0]).toContain("Permission to use Bash has been denied");
});

test("a control command the harness did not deny fails the check", () => {
  const allowed = { ...control, executed: true, denials: [] };
  const problems = problemsIn([clean("git status"), allowed]);
  expect(problems.length).toBe(1);
  expect(problems[0]).toContain(CONTROL_COMMAND);
});

test("a check that never ran the control command fails", () => {
  const problems = problemsIn([clean("git status")]);
  expect(problems.length).toBe(1);
  expect(problems[0]).toContain(CONTROL_COMMAND);
});

test("a command the stub saw no request for fails the check, however it ended", () => {
  const unreached = { ...clean("git status"), requests: 0 };
  const problems = problemsIn([unreached, control]);
  expect(problems.length).toBe(1);
  expect(problems[0]).toContain("no request");
});

test("a command that reached canUseTool fails the check", () => {
  const asked = { ...clean("git status"), canUseToolCalls: 1 };
  const problems = problemsIn([asked, control]);
  expect(problems.length).toBe(1);
  expect(problems[0]).toContain("canUseTool");
});

/**
 * Criterion 6. The stub is what the harness authenticates to, so the credential it presented is
 * evidence about the environment the harness ran in that nothing in this repository had to be
 * trusted for: a session that presented anything but the dummy key found a credential somewhere,
 * and the owner's is the only one there is.
 */
test("a session where the harness presented a credential other than the dummy fails the check", () => {
  const leaked = { ...clean("git status"), credentials: [STUB_API_KEY, "sk-ant-the-owners-key"] };
  const problems = problemsIn([leaked, control]);
  expect(problems.length).toBe(1);
  expect(problems[0]).toContain("credential");
  // The key itself is not printed: the check's output is not where a credential belongs.
  expect(problems[0]).not.toContain("sk-ant-the-owners-key");
});

test("a command that ended without executing and without a denial fails the check", () => {
  const nothing = { ...clean("git status"), executed: false };
  const problems = problemsIn([nothing, control]);
  expect(problems.length).toBe(1);
  expect(problems[0]).toContain("git status");
});
