/**
 * The boundary between a run and the coding agent it spawns. The run sees a stream of
 * small events and answers permission questions; how the agent is started, what harness
 * drives it, and where its transcript comes from are the driver's business. Tests fake this
 * interface with a script; `claude.ts` is the one real driver.
 */

export type AgentEvent =
  /** One assistant text turn. */
  | { type: "text"; text: string; raw?: unknown }
  | { type: "tool_use"; name: string; input: Record<string, unknown>; raw?: unknown }
  | { type: "tool_result"; text: string; isError?: boolean; raw?: unknown }
  /** The session's end. `ok` is false for an error result; `error` says why. */
  | { type: "result"; ok: boolean; error?: string; raw?: unknown };

export type ToolDecision = { behavior: "allow" } | { behavior: "deny"; message: string };

export interface AgentRunOptions {
  /** The card's worktree. */
  cwd: string;
  env: Record<string, string>;
  /** The phase's playbook, appended to the harness's own system prompt. */
  systemPrompt: string;
  /** Tool patterns the agent may use without asking. Everything else calls `canUseTool`. */
  allowedTools: string[];
  canUseTool(tool: string, input: Record<string, unknown>): Promise<ToolDecision>;
  /**
   * The user messages, in order and as they arrive: the card first, then every card comment
   * by a member other than the runner while the run is live. The card is sent here and
   * nowhere else, so a driver never has two copies of it to reconcile.
   */
  input: AsyncIterable<string>;
  /** Fires when the run is over — time limit, claim lost, session ended — and the agent must stop. */
  signal: AbortSignal;
}

export interface AgentDriver {
  run(options: AgentRunOptions): AsyncIterable<AgentEvent>;
}
