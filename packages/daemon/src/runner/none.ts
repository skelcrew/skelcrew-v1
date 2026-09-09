/**
 * `SKELCREW_AGENT` picks the driver: unset or `claude` is the Agent SDK; `none` is no
 * driver at all, which leaves the runner with 006's behaviour — claim, worktree, and a
 * `no playbook` handoff to the owner. Anything else is a typo, and a typo must not decide
 * whether an agent gets spawned.
 */
export type AgentSelection = "claude" | "none";

export function selectAgent(env: Record<string, string | undefined>): AgentSelection {
  const value = env.SKELCREW_AGENT;
  if (value === undefined || value === "" || value === "claude") return "claude";
  if (value === "none") return "none";
  throw new Error(`SKELCREW_AGENT must be "claude" or "none", not "${value}"`);
}
