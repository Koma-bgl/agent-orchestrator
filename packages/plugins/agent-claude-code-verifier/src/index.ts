import type { Agent, PluginModule } from "@composio/ao-core";
import claudeCodePlugin from "@composio/ao-plugin-agent-claude-code";

export const manifest = {
  name: "claude-code-verifier",
  slot: "agent" as const,
  description: "Agent plugin: Claude Code configured as a UI verifier with MCP browser tools",
  version: "0.1.0",
};

export function create(): Agent {
  const base = claudeCodePlugin.create();
  return {
    ...base,
    name: "claude-code-verifier",
    // Phase 3 Task 3.3 will override setup() to bind MCP browser tools and
    // the ao_verify_login helper. For now we just rename the agent so the
    // runtime treats this as a distinct agent plugin.
  };
}

export default { manifest, create } satisfies PluginModule<Agent>;
