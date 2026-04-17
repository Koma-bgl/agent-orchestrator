import { describe, it, expect, vi } from "vitest";
import { verifyLoginHandler } from "../../src/commands/verify-login.js";
import type { OrchestratorConfig } from "@composio/ao-core";

const makeConfig = (): OrchestratorConfig =>
  ({
    projects: {
      "my-app": {
        path: "/path/to/my-app",
        mcpVerify: {
          enabled: true,
          accounts: {
            default: { email: "default@test.com", password: "test-pw-sentinel" },
            admin: { email: "admin@test.com", password: "admin-pw-sentinel" },
          },
        },
      },
    },
  }) as unknown as OrchestratorConfig;

describe("verifyLoginHandler", () => {
  it("reads credentials for the requested role and passes them to runLogin", async () => {
    const runLogin = vi.fn().mockResolvedValue({ success: true });
    const result = await verifyLoginHandler({
      role: "admin",
      project: "my-app",
      loadConfig: () => makeConfig(),
      runLogin,
    });
    expect(result.success).toBe(true);
    expect(runLogin).toHaveBeenCalledWith({
      email: "admin@test.com",
      password: "admin-pw-sentinel",
    });
  });

  it("never prints the password to stdout/stderr (via console.log/console.error)", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      const runLogin = vi.fn().mockResolvedValue({ success: true });
      await verifyLoginHandler({
        role: "default",
        project: "my-app",
        loadConfig: () => makeConfig(),
        runLogin,
      });
      expect(logs.join("\n")).not.toContain("test-pw-sentinel");
      expect(logs.join("\n")).not.toContain("default@test.com");
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });

  it("returns error when role is not configured for the project", async () => {
    const runLogin = vi.fn();
    const result = await verifyLoginHandler({
      role: "ghost",
      project: "my-app",
      loadConfig: () => makeConfig(),
      runLogin,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Role "ghost" not configured/);
    expect(runLogin).not.toHaveBeenCalled();
  });

  it("returns error when project doesn't exist", async () => {
    const result = await verifyLoginHandler({
      role: "default",
      project: "unknown-project",
      loadConfig: () => makeConfig(),
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unknown-project.*not found/);
  });

  it("auto-detects project from cwd when --project is omitted", async () => {
    const runLogin = vi.fn().mockResolvedValue({ success: true });
    const result = await verifyLoginHandler({
      role: "default",
      cwd: "/path/to/my-app/src", // matches projects["my-app"].path
      loadConfig: () => makeConfig(),
      runLogin,
    });
    expect(result.success).toBe(true);
    expect(runLogin).toHaveBeenCalled();
  });

  it("returns error when cwd doesn't match any configured project", async () => {
    const result = await verifyLoginHandler({
      role: "default",
      cwd: "/some/unrelated/path",
      loadConfig: () => makeConfig(),
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Could not determine project/);
  });

  it("forwards error message from runLogin stub/implementation", async () => {
    const runLogin = vi
      .fn()
      .mockResolvedValue({ success: false, error: "submit button not found" });
    const result = await verifyLoginHandler({
      role: "default",
      project: "my-app",
      loadConfig: () => makeConfig(),
      runLogin,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("submit button not found");
  });
});
