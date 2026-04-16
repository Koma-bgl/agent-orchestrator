import type { Issue, McpVerifyConfig } from "./types.js";

/**
 * Determines whether MCP verify should run for a given issue.
 *
 * Pure function that checks:
 * 1. If config is enabled
 * 2. If the issue has the configured trigger label
 *
 * @param issue - The issue to check
 * @param config - The MCP verify configuration (can be null or undefined)
 * @returns true if verify should run, false otherwise
 */
export function isEligibleForVerify(
  issue: Issue,
  config: McpVerifyConfig | null | undefined
): boolean {
  // If config is not provided or disabled, verify is not eligible
  if (!config?.enabled) {
    return false;
  }

  // Check if issue has the trigger label
  return issue.labels.includes(config.triggerLabel);
}
