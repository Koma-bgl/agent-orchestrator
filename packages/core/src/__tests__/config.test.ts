import { describe, it, expect } from "vitest";
import { McpVerifyConfigSchema } from "../config.js";

describe("McpVerifyConfigSchema", () => {
  it("accepts a minimal valid config with defaults filled in", () => {
    const parsed = McpVerifyConfigSchema.parse({
      enabled: true,
      baseUrl: "http://localhost:3100",
      verifyWorktreeDir: "~/ao-verify-worktrees",
      startCommand: "pnpm dev",
      readyProbe: { url: "http://localhost:3100", timeoutSec: 60 },
      accounts: {
        default: { email: "a@b.com", password: "pw" },
      },
    });
    expect(parsed.triggerLabel).toBe("ui-verify");
    expect(parsed.maxRetries).toBe(2);
    expect(parsed.timeoutSec).toBe(300);
    expect(parsed.uiVerifierPersona).toBe("ui-verifier");
  });

  it("resolves ${ENV_VAR} placeholders in account passwords", () => {
    process.env["VERIFY_TEST_PW"] = "test-sentinel-xyz";
    const parsed = McpVerifyConfigSchema.parse({
      enabled: true,
      baseUrl: "http://localhost:3100",
      verifyWorktreeDir: "~/ao",
      startCommand: "pnpm dev",
      readyProbe: { url: "http://localhost:3100", timeoutSec: 60 },
      accounts: {
        default: { email: "a@b.com", password: "${VERIFY_TEST_PW}" },
      },
    });
    expect(parsed.accounts["default"]?.password).toBe("test-sentinel-xyz");
    delete process.env["VERIFY_TEST_PW"];
  });

  it("rejects empty accounts map", () => {
    expect(() =>
      McpVerifyConfigSchema.parse({
        enabled: true,
        baseUrl: "http://localhost:3100",
        verifyWorktreeDir: "~/ao",
        startCommand: "pnpm dev",
        readyProbe: { url: "http://localhost:3100", timeoutSec: 60 },
        accounts: {},
      }),
    ).toThrow();
  });
});
