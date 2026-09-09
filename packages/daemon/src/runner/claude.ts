/**
 * The Agent SDK driver: the only file that imports `@anthropic-ai/claude-agent-sdk`. The
 * SDK is a harness driver, not a model client — it spawns Claude Code under the owner's
 * own login, and skelcrew passes it no key and reads no model API. What the run needs from
 * it is exactly the two things `claude -p` could not give: `canUseTool` as a question the
 * card can answer, and streaming input so comments reach the agent mid-run.
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

/** The run's events for one SDK message; most system messages carry nothing the card shows. */
export function toEvents(message: SDKMessage): AgentEvent[] {
  const raw = message;
  switch (message.type) {
    case "assistant": {
      const events: AgentEvent[] = [];
      for (const block of blocks(message.message)) {
        if (block.type === "text" && "text" in block && block.text.length > 0) {
          events.push({ type: "text", text: block.text, raw });
        } else if (block.type === "tool_use" && "name" in block) {
          events.push({ type: "tool_use", name: block.name, input: block.input ?? {}, raw });
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
            raw,
          });
        }
      }
      return events;
    }
    case "result": {
      if (message.subtype === "success") {
        return [
          message.is_error
            ? { type: "result", ok: false, error: message.result, raw }
            : { type: "result", ok: true, raw },
        ];
      }
      const detail = message.errors.length > 0 ? `: ${message.errors.join("; ")}` : "";
      return [{ type: "result", ok: false, error: `${message.subtype}${detail}`, raw }];
    }
    default:
      return [];
  }
}

async function* userMessages(input: AsyncIterable<string>): AsyncGenerator<SDKUserMessage> {
  for await (const text of input) {
    yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
  }
}

export const claudeDriver: AgentDriver = {
  async *run(options: AgentRunOptions) {
    if (options.signal.aborted) return;
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
      systemPrompt: { type: "preset", preset: "claude_code", append: options.systemPrompt },
    };
    const session = query({ prompt: userMessages(options.input), options: sdkOptions });
    // On abort the subprocess is closed here directly, not only through the iterator's
    // `finally`: a session that never yields again must not leave Claude Code running in
    // the worktree, still able to act as `runner`.
    const onAbort = (): void => {
      abortController.abort();
      session.close();
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    try {
      for await (const message of session) {
        for (const event of toEvents(message)) yield event;
        // One result is the session's end: with streaming input it would otherwise idle.
        if (message.type === "result") return;
      }
    } finally {
      options.signal.removeEventListener("abort", onAbort);
      session.close();
    }
  },
};
