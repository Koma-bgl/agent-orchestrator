import type { Issue, McpVerifyConfig } from "./types.js";

/**
 * Pure function — given config + issue, returns whether MCP verify should run.
 * No side effects. Safe to call from anywhere in the lifecycle.
 */
export function isEligibleForVerify(
  config: McpVerifyConfig | undefined,
  issue: Pick<Issue, "labels"> | undefined,
): boolean {
  if (!config?.enabled) return false;
  const labels = issue?.labels ?? [];
  return labels.includes(config.triggerLabel);
}
