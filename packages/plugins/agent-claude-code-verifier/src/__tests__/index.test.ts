import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@composio/ao-core";
import claudeCodePlugin from "@composio/ao-plugin-agent-claude-code";
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

describe("agent-claude-code-verifier .mcp.json binding", () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), "ao-verifier-mcp-"));
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  it("writes .mcp.json to the workspace path with browser + ao-verify-login entries", async () => {
    const agent = plugin.create();
    await agent.preLaunchSetup?.(workspacePath);

    const mcpPath = join(workspacePath, ".mcp.json");
    expect(existsSync(mcpPath)).toBe(true);

    const raw = await readFile(mcpPath, "utf-8");
    const parsed = JSON.parse(raw) as { mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers["browser"]).toEqual({
      command: "npx",
      args: expect.arrayContaining(["-y"]),
    });
    expect(parsed.mcpServers["ao-verify-login"]).toEqual({
      command: "ao",
      args: ["verify-login"],
    });
  });

  it("creates .mcp.json when none exists (no ENOENT error)", async () => {
    const mcpPath = join(workspacePath, ".mcp.json");
    expect(existsSync(mcpPath)).toBe(false);

    const agent = plugin.create();
    await expect(agent.preLaunchSetup?.(workspacePath)).resolves.not.toThrow();

    expect(existsSync(mcpPath)).toBe(true);
  });

  it("merges with an existing .mcp.json rather than overwriting it", async () => {
    const mcpPath = join(workspacePath, ".mcp.json");
    const existing = {
      mcpServers: {
        "preexisting-server": {
          command: "node",
          args: ["server.js"],
        },
      },
    };
    await writeFile(mcpPath, JSON.stringify(existing, null, 2), "utf-8");

    const agent = plugin.create();
    await agent.preLaunchSetup?.(workspacePath);

    const raw = await readFile(mcpPath, "utf-8");
    const parsed = JSON.parse(raw) as { mcpServers: Record<string, unknown> };

    // Pre-existing server is preserved
    expect(parsed.mcpServers["preexisting-server"]).toEqual({
      command: "node",
      args: ["server.js"],
    });
    // Verifier servers are added
    expect(parsed.mcpServers["browser"]).toBeDefined();
    expect(parsed.mcpServers["ao-verify-login"]).toEqual({
      command: "ao",
      args: ["verify-login"],
    });
  });

  it("invokes the base plugin's preLaunchSetup before writing .mcp.json", async () => {
    // Spy on the real base plugin's create() to intercept its preLaunchSetup.
    const baseSetupSpy = vi.fn().mockResolvedValue(undefined);
    const originalCreate = claudeCodePlugin.create;
    const createSpy = vi.spyOn(claudeCodePlugin, "create").mockImplementation(() => {
      const real = originalCreate.call(claudeCodePlugin) as Agent;
      return { ...real, preLaunchSetup: baseSetupSpy };
    });

    try {
      const agent = plugin.create();
      await agent.preLaunchSetup?.(workspacePath);

      expect(baseSetupSpy).toHaveBeenCalledWith(workspacePath);
      expect(baseSetupSpy).toHaveBeenCalledTimes(1);
      // .mcp.json still written after base ran.
      expect(existsSync(join(workspacePath, ".mcp.json"))).toBe(true);
    } finally {
      createSpy.mockRestore();
    }
  });

  it("preserves behavior when the base plugin has no preLaunchSetup method", async () => {
    // Simulate a base that lacks preLaunchSetup (defensive — base might drop it).
    const originalCreate = claudeCodePlugin.create;
    const createSpy = vi.spyOn(claudeCodePlugin, "create").mockImplementation(() => {
      const real = originalCreate.call(claudeCodePlugin) as Agent;
      // Copy all props except preLaunchSetup — do not touch the original.
      const { preLaunchSetup: _omit, ...rest } = real;
      return rest as Agent;
    });

    try {
      const agent = plugin.create();
      await expect(agent.preLaunchSetup?.(workspacePath)).resolves.not.toThrow();
      expect(existsSync(join(workspacePath, ".mcp.json"))).toBe(true);
    } finally {
      createSpy.mockRestore();
    }
  });
});
