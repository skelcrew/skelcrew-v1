/**
 * The Agent SDK driver: the only file in this repository that imports
 * `@anthropic-ai/claude-agent-sdk`. The SDK is a harness driver, not a model client — it
 * spawns Claude Code under the owner's own login, and skelcrew passes it no key and reaches
 * no model API. What the run needs from it is exactly the two things `claude -p` could not
 * give: `canUseTool` as a decision the run makes, and streaming input so comments reach the
 * agent mid-run.
 */
import {
  type CanUseTool,
  type Options,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentDriver, AgentEvent, AgentRunOptions } from "./agent";

/** The content blocks this driver reads; the SDK types them through its peer packages. */
type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; content: unknown; is_error?: boolean }
  | { type: string };

function blocks(message: unknown): Block[] {
  const content = (message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as Block[]) : [];
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (typeof block?.text === "string" ? (block.text as string) : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * What the card shows of one SDK message: most system messages, plain user messages and
 * thinking carry nothing it displays, and produce no event. The transcript is written
 * separately, in `drive`, so displaying nothing loses nothing.
 */
export function toEvents(message: SDKMessage): AgentEvent[] {
  switch (message.type) {
    case "assistant": {
      const events: AgentEvent[] = [];
      for (const block of blocks(message.message)) {
        if (block.type === "text" && "text" in block && block.text.length > 0) {
          events.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use" && "name" in block) {
          events.push({ type: "tool_use", name: block.name, input: block.input ?? {} });
        }
      }
      return events;
    }
    case "user": {
      const events: AgentEvent[] = [];
      for (const block of blocks(message.message)) {
        if (block.type === "tool_result" && "content" in block) {
          events.push({
            type: "tool_result",
            text: resultText(block.content),
            isError: block.is_error === true,
          });
        }
      }
      return events;
    }
    case "result": {
      if (message.subtype === "success") {
        return [
          message.is_error
            ? { type: "result", ok: false, error: message.result }
            : { type: "result", ok: true },
        ];
      }
      const detail = message.errors.length > 0 ? `: ${message.errors.join("; ")}` : "";
      return [{ type: "result", ok: false, error: `${message.subtype}${detail}` }];
    }
    default:
      return [];
  }
}

/**
 * The driver's stream: the transcript and the card's events out of one pass over the
 * harness's messages. One result ends the session — with streaming input it would otherwise
 * idle waiting for more, and a playbook's session is one task.
 */
export async function* drive(
  messages: AsyncIterable<SDKMessage>,
  log: (entry: unknown) => void,
): AsyncGenerator<AgentEvent> {
  for await (const message of messages) {
    // The record first and whole: a system message, a plain user message and a turn that
    // only thought project to no event at all, and a turn with several blocks projects to
    // several — neither is the transcript's business.
    log(message);
    for (const event of toEvents(message)) yield event;
    if (message.type === "result") return;
  }
}

async function* userMessages(input: AsyncIterable<string>): AsyncGenerator<SDKUserMessage> {
  for await (const text of input) {
    yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
  }
}

/**
 * Everything the harness is told about a run, and the controller that ends it. Separate from
 * `run` because it is the whole of what this driver decides and the one part of it testable
 * without spawning anything — and what it decides is a security boundary.
 */
export function buildSdkOptions(options: AgentRunOptions): {
  sdkOptions: Options;
  abortController: AbortController;
} {
  const abortController = new AbortController();
  const canUseTool: CanUseTool = async (toolName, input) => {
    const decision = await options.canUseTool(toolName, input);
    return decision.behavior === "allow"
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: decision.message };
  };
  const sdkOptions: Options = {
    cwd: options.cwd,
    env: options.env,
    allowedTools: options.allowedTools,
    canUseTool,
    abortController,
    permissionMode: "default",
    // The run inherits no permission from anywhere else. Left unset, the SDK loads all
    // filesystem settings the way the CLI does — `~/.claude/settings.json`, the target
    // repository's `.claude/settings.json`, its `settings.local.json` — and merges their
    // `permissions.allow` rules into the same rule set as `allowedTools`, matched *before*
    // `canUseTool` is consulted: a repository could grant an unattended run `Write` or `git
    // push` by committing a file, and the denial would never happen or show on the card.
    // `[]` is the SDK's own "disable filesystem settings", so what the run may do without
    // asking is exactly `allowedTools`, and everything else reaches `canUseTool`. This also
    // stops `CLAUDE.md` being loaded automatically, which the playbooks do not rely on: each
    // instructs the agent to read the repository's `AGENTS.md`/`CLAUDE.md` itself, first.
    // The rest of what those files configure goes inert for skelcrew runs too — a chosen
    // `model`, an `env` block, `apiKeyHelper`, hooks, project skills and MCP servers — so an
    // owner who authenticates through `apiKeyHelper` rather than a stored login gets runs
    // that die at spawn with a raw harness error and nothing explaining it.
    settingSources: [],
    systemPrompt: { type: "preset", preset: "claude_code", append: options.systemPrompt },
  };
  return { sdkOptions, abortController };
}

export const claudeDriver: AgentDriver = {
  async *run(options: AgentRunOptions) {
    if (options.signal.aborted) return;
    const { sdkOptions, abortController } = buildSdkOptions(options);
    const session = query({ prompt: userMessages(options.input), options: sdkOptions });
    // On abort the subprocess is closed here directly, not only through the iterator's
    // `finally`: a session that never yields again must not leave Claude Code running in
    // the worktree, still able to act as the runner.
    const onAbort = (): void => {
      abortController.abort();
      session.close();
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    try {
      yield* drive(session, options.log);
    } finally {
      options.signal.removeEventListener("abort", onAbort);
      session.close();
    }
  },
};
