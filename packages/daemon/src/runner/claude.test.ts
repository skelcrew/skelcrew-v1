/**
 * The SDK driver's translation and its logging, as pure functions over message literals.
 * Nothing here spawns an agent or calls a model: `query` is never reached.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentDriver, AgentRunOptions } from "./agent";
import { TRANSCRIBED_FROM } from "./allowlist";
import { buildSdkOptions, claudeDriver, drive, toEvents } from "./claude";

/** The fields this driver reads; the SDK's own literals carry a great deal more. */
function message(shape: unknown): SDKMessage {
  return shape as SDKMessage;
}

const assistant = (content: unknown[]): SDKMessage =>
  message({ type: "assistant", message: { role: "assistant", content } });

async function* stream(...messages: SDKMessage[]): AsyncGenerator<SDKMessage> {
  for (const m of messages) yield m;
}

async function collect(
  messages: AsyncGenerator<SDKMessage>,
): Promise<{ events: unknown[]; log: unknown[] }> {
  const log: unknown[] = [];
  const events: unknown[] = [];
  for await (const event of drive(messages, (entry) => log.push(entry))) events.push(event);
  return { events, log };
}

test("the driver conforms to the boundary", () => {
  const driver: AgentDriver = claudeDriver;
  expect(typeof driver.run).toBe("function");
});

/**
 * The check's module name, composed rather than written out. Both tests below scan every source
 * file including this one, and the second matches any *quoted* string naming the module — so a
 * literal `"…harness-check…"` anywhere in this file would match itself and report this file as an
 * importer of the check.
 */
const CHECK_MODULE = ["harness", "check"].join("-");
const CHECK_FILE = `packages/daemon/src/runner/${CHECK_MODULE}.ts`;

/**
 * One driver, and one check that spawns the harness deliberately. 017 added the second: it runs
 * the pinned binary against a local stub to find out whether a playbook's commands ask, which
 * needs `query` with a `permissionMode` the builder below hard-codes — so it cannot go through
 * the driver. Both lists stay exact, so a third importer is a decision someone makes on purpose
 * rather than a drift. The daemon's own run path is still `claude.ts` alone: `harness-check.ts`
 * is not imported by anything the daemon runs, and `bun run check` does not execute it.
 */
test("the harness SDK is named by exactly one source file, and imported by exactly two", async () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const sources = new Bun.Glob("packages/*/src/**/*.ts").scan({ cwd: root });
  const naming: string[] = [];
  const importing: string[] = [];
  for await (const file of sources) {
    const text = readFileSync(join(root, file), "utf8");
    if (!text.includes("@anthropic-ai/")) continue;
    naming.push(file);
    // A type-only import is erased: the files that pull the SDK in at runtime are these.
    if (!/^import type .* from "@anthropic-ai\//m.test(text)) importing.push(file);
  }
  expect(importing.sort()).toEqual(["packages/daemon/src/runner/claude.ts", CHECK_FILE]);
  expect(naming.sort()).toEqual([
    // This file, for the message literals its translation tests are written over.
    "packages/daemon/src/runner/claude.test.ts",
    "packages/daemon/src/runner/claude.ts",
    CHECK_FILE,
  ]);
});

/**
 * The daemon's own path to the harness is one file, and the check is not on it. **Any quoted
 * specifier** naming the check counts, with no `import`, `from` or `require` required in front of
 * it: round 1 matched the `./harness-check` spelling alone, so an import written
 * `../runner/harness-check` passed; round 2 required `from`, so `await import(…)` and a bare
 * side-effect import both passed. A module specifier is a quoted string ending in the module's
 * name, and that is the whole of the test.
 */
test("nothing the daemon runs imports the harness check", async () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const sources = new Bun.Glob("packages/*/src/**/*.ts").scan({ cwd: root });
  const specifier = new RegExp(`["'][^"']*${CHECK_MODULE}(\\.ts)?["']`);
  const importers: string[] = [];
  for await (const file of sources) {
    if (file.endsWith(`${CHECK_MODULE}.ts`)) continue;
    const text = readFileSync(join(root, file), "utf8");
    if (specifier.test(text)) importers.push(file);
  }
  expect(importers).toEqual([`packages/daemon/src/runner/${CHECK_MODULE}.test.ts`]);
});

/**
 * Containment does not age; enumeration does. `allowlist.ts` transcribes a private flag table
 * out of the `claude` binary this SDK ships and spawns, and audits git's and gh's flags by hand.
 * The SDK is pinned exactly in `bun.lock`, which is the real protection — but nothing tied the
 * transcription to that pin, so a bump could move the table underneath the list in silence. It
 * fails here instead, and becomes a decision someone makes on purpose. The assertion lives in
 * this file because this is the one *test* file that names the SDK: the test above pins the naming
 * list at three files — the driver, the harness check, and this one, for the literals its
 * translation tests are written over.
 */
test("the harness the allowlist's tables were transcribed from is the one installed", () => {
  const sdk = dirname(Bun.resolveSync("@anthropic-ai/claude-agent-sdk", import.meta.dir));
  const version = (name: string): string =>
    JSON.parse(readFileSync(join(sdk, name), "utf8")).version;
  expect([version("package.json"), version("manifest.json")]).toEqual([
    TRANSCRIBED_FROM.sdk,
    TRANSCRIBED_FROM.cli,
  ]);
});

test("an assistant turn projects its text and its tool calls, in block order", () => {
  expect(
    toEvents(
      assistant([
        { type: "text", text: "Reading the constraints." },
        { type: "tool_use", name: "Read", input: { file_path: "/repo/AGENTS.md" } },
      ]),
    ),
  ).toEqual([
    { type: "text", text: "Reading the constraints." },
    { type: "tool_use", name: "Read", input: { file_path: "/repo/AGENTS.md" } },
  ]);
});

test("a thinking-only turn displays nothing", () => {
  expect(toEvents(assistant([{ type: "thinking", thinking: "…" }]))).toEqual([]);
  expect(toEvents(assistant([{ type: "text", text: "" }]))).toEqual([]);
});

test("a system message displays nothing", () => {
  expect(toEvents(message({ type: "system", subtype: "init", tools: ["Read"] }))).toEqual([]);
});

test("a tool result comes back as one event, text flattened, errors marked", () => {
  expect(
    toEvents(
      message({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: "ok\n" }] },
      }),
    ),
  ).toEqual([{ type: "tool_result", text: "ok\n", isError: false }]);
  expect(
    toEvents(
      message({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", content: [{ type: "text", text: "no" }], is_error: true },
          ],
        },
      }),
    ),
  ).toEqual([{ type: "tool_result", text: "no", isError: true }]);
});

test("a plain user message displays nothing", () => {
  expect(
    toEvents(message({ type: "user", message: { role: "user", content: "a comment" } })),
  ).toEqual([]);
});

test("a successful result ends the session, an error result carries why", () => {
  expect(toEvents(message({ type: "result", subtype: "success", is_error: false }))).toEqual([
    { type: "result", ok: true },
  ]);
  expect(
    toEvents(message({ type: "result", subtype: "success", is_error: true, result: "went wrong" })),
  ).toEqual([{ type: "result", ok: false, error: "went wrong" }]);
  expect(
    toEvents(
      message({ type: "result", subtype: "error_max_turns", errors: ["too many", "turns"] }),
    ),
  ).toEqual([{ type: "result", ok: false, error: "error_max_turns: too many; turns" }]);
});

// --- the transcript is the stream, not the projection ---

test("every message reaches the log once, in arrival order, including ones that display nothing", async () => {
  const messages: SDKMessage[] = [
    message({ type: "system", subtype: "init" }),
    message({ type: "user", message: { role: "user", content: "the card" } }),
    assistant([{ type: "thinking", thinking: "…" }]),
    assistant([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
      { type: "tool_use", name: "Grep", input: { pattern: "x" } },
    ]),
    message({ type: "result", subtype: "success", is_error: false }),
  ];
  const { events, log } = await collect(stream(...messages));

  // Once each, whole, in order — a message with three displayable blocks is one entry.
  expect(log).toEqual(messages);
  expect(events).toEqual([
    { type: "text", text: "one" },
    { type: "text", text: "two" },
    { type: "tool_use", name: "Grep", input: { pattern: "x" } },
    { type: "result", ok: true },
  ]);
});

test("the stream ends at the first result: a streaming session would otherwise wait for more input", async () => {
  const after = assistant([{ type: "text", text: "after the end" }]);
  const { events, log } = await collect(
    stream(message({ type: "result", subtype: "success", is_error: false }), after),
  );
  expect(events).toEqual([{ type: "result", ok: true }]);
  expect(log).toEqual([message({ type: "result", subtype: "success", is_error: false })]);
});

// --- what the harness is told about the run ---

/** The run's user messages: nothing is spawned here, so none are ever read. */
async function* noInput(): AsyncGenerator<string> {
  yield* [];
}

function runOptions(): AgentRunOptions {
  return {
    cwd: "/repo/worktree",
    env: { PATH: "/data/bin:/usr/bin", HOME: "/home/owner" },
    systemPrompt: "# Playbook: Spec",
    allowedTools: ["Read", "Bash(git log *)", "Edit(//repo/worktree/**)"],
    disallowedTools: ["Edit(//repo/worktree/.git)", "Edit(//repo/worktree/.git/**)"],
    canUseTool: () => Promise.resolve({ behavior: "deny", message: "no" }),
    input: noInput(),
    log: () => {},
    signal: new AbortController().signal,
  };
}

test("the run's permissions are the fixed list and canUseTool, and nothing a settings file says", () => {
  const { sdkOptions } = buildSdkOptions(runOptions());

  // Left unset, the harness loads `~/.claude/settings.json`, the target repository's
  // `.claude/settings.json` and its `settings.local.json`, and merges their
  // `permissions.allow` rules into the same rule set as `allowedTools` — matched *before*
  // `canUseTool` is consulted. A repository could then grant an unattended run `Write` or
  // `git push` by committing a file, with no denial and nothing on the card. `[]` is the
  // SDK's own "disable filesystem settings", which is what makes the list a list.
  expect(sdkOptions.settingSources).toEqual([]);
  expect(sdkOptions.allowedTools).toEqual(["Read", "Bash(git log *)", "Edit(//repo/worktree/**)"]);
  expect(sdkOptions.permissionMode).toBe("default");
});

/**
 * The run's deny rules have to reach the harness, not merely be computed. `canUseTool` is
 * never consulted for a call an allow entry matches, so a deny that the driver drops is no
 * deny at all — and the one path this denies, the worktree's own `.git` file, sits inside the
 * allow entry's anchor.
 */
test("the run's deny rules reach the harness alongside the list", () => {
  const { sdkOptions } = buildSdkOptions(runOptions());
  expect(sdkOptions.disallowedTools).toEqual([
    "Edit(//repo/worktree/.git)",
    "Edit(//repo/worktree/.git/**)",
  ]);
});
