import type { Agent, PluginModule } from "@composio/ao-core";
import claudeCodePlugin from "@composio/ao-plugin-agent-claude-code";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// =============================================================================
// MCP server entries bound to the verifier agent
// =============================================================================

interface McpServerConfig {
  command: string;
  args: string[];
}

interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * Browser MCP server: `chrome-devtools-mcp` (Google).
 *
 * **Attaches to a running Chrome** via the Chrome DevTools Protocol. The operator
 * must launch Chrome with a debug port before the verifier session runs, e.g.:
 *
 *     "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *       --remote-debugging-port=9222
 *
 * This matches the "queue of 1" model — a single long-lived Chrome window,
 * multiple verifier sessions attach and detach. Document this prerequisite in
 * the Phase 7 docs (Task 7.3).
 *
 * Alternative considered: `@playwright/mcp` spawns its own browser per session
 * (cleaner isolation, but you can't watch it drive your real Chrome).
 */
const VERIFIER_MCP_SERVERS: Record<string, McpServerConfig> = {
  browser: {
    command: "npx",
    args: ["-y", "chrome-devtools-mcp"],
  },
  // Task 4.1 lands the `ao verify-login` CLI subcommand. This entry just
  // reserves the MCP server slot so Task 5.4 can spawn the verifier with the
  // login shim already registered.
  "ao-verify-login": {
    command: "ao",
    args: ["verify-login"],
  },
};

export const manifest = {
  name: "claude-code-verifier",
  slot: "agent" as const,
  description: "Agent plugin: Claude Code configured as a UI verifier with MCP browser tools",
  version: "0.1.0",
};

export function create(): Agent {
  const base = claudeCodePlugin.create();
  const basePreLaunchSetup = base.preLaunchSetup?.bind(base);

  return {
    ...base,
    name: "claude-code-verifier",
    async preLaunchSetup(workspacePath: string): Promise<void> {
      // Preserve the base plugin's setup (permissions allowlist, etc.) so the
      // verifier inherits claude-code's environment prep.
      if (basePreLaunchSetup) {
        await basePreLaunchSetup(workspacePath);
      }
      // Then write the verifier-specific MCP binding. The caller (Task 5.4
      // reaction handler) is responsible for passing the verify worktree path
      // as the session's workspace — this plugin writes wherever it's told.
      await writeVerifierMcpConfig(workspacePath);
    },
  };
}

/**
 * Write (or merge) the verifier's `.mcp.json` into the given workspace.
 *
 * If a `.mcp.json` already exists, pre-existing `mcpServers` entries are
 * preserved and the verifier entries are layered on top (verifier wins on
 * key collision — that's intentional, since the verifier is the one that
 * needs these exact bindings).
 */
async function writeVerifierMcpConfig(workspacePath: string): Promise<void> {
  const mcpPath = resolve(workspacePath, ".mcp.json");

  let existingServers: Record<string, McpServerConfig> = {};
  try {
    const raw = await readFile(mcpPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "mcpServers" in parsed &&
      typeof (parsed as { mcpServers: unknown }).mcpServers === "object" &&
      (parsed as { mcpServers: unknown }).mcpServers !== null
    ) {
      existingServers = (parsed as { mcpServers: Record<string, McpServerConfig> }).mcpServers;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // Corrupt JSON or other read error — don't crash the session. Fall back
      // to an empty existing-servers map and overwrite, which matches the
      // behavior of the base plugin's `.claude/settings.local.json` handling.
      existingServers = {};
    }
  }

  const merged: McpConfig = {
    mcpServers: { ...existingServers, ...VERIFIER_MCP_SERVERS },
  };
  await writeFile(mcpPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
}

export default { manifest, create } satisfies PluginModule<Agent>;
