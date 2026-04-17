import { describe, it, expect } from "vitest";
import plugin from "../index.js";

describe("agent-claude-code-verifier plugin", () => {
  it("exports a manifest with slot=agent and the verifier name", () => {
    expect(plugin.manifest.slot).toBe("agent");
    expect(plugin.manifest.name).toBe("claude-code-verifier");
  });

  it("create() returns an Agent with name claude-code-verifier", () => {
    const agent = plugin.create();
    expect(agent.name).toBe("claude-code-verifier");
  });
});
