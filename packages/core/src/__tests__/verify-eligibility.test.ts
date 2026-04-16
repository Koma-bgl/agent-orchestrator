import { describe, it, expect } from "vitest";
import { isEligibleForVerify } from "../verify-eligibility.js";
import type { Issue } from "../types.js";
import type { McpVerifyConfig } from "../types.js";

describe("isEligibleForVerify", () => {
  const baseIssue: Issue = {
    id: "issue-123",
    title: "Test Issue",
    description: "A test issue",
    url: "https://example.com/issues/123",
    state: "open",
    labels: [],
  };

  const baseConfig: McpVerifyConfig = {
    enabled: true,
    triggerLabel: "verify",
    baseUrl: "http://localhost:3000",
    verifyWorktreeDir: "/tmp/verify",
    startCommand: "npm start",
    readyProbe: { url: "http://localhost:3000/", timeoutSec: 30 },
    accounts: {},
    maxRetries: 3,
    timeoutSec: 30,
    uiVerifierPersona: "default",
  };

  describe("when config is disabled", () => {
    it("should return false if config.enabled is false", () => {
      const config: McpVerifyConfig = { ...baseConfig, enabled: false };
      const result = isEligibleForVerify(config, baseIssue);
      expect(result).toBe(false);
    });

    it("should return false if config is undefined", () => {
      const result = isEligibleForVerify(undefined, baseIssue);
      expect(result).toBe(false);
    });
  });

  describe("when config is enabled", () => {
    it("should return true if issue has the trigger label", () => {
      const issue: Issue = {
        ...baseIssue,
        labels: ["verify", "bug"],
      };
      const result = isEligibleForVerify(baseConfig, issue);
      expect(result).toBe(true);
    });

    it("should return false if issue does not have the trigger label", () => {
      const issue: Issue = {
        ...baseIssue,
        labels: ["bug", "feature"],
      };
      const result = isEligibleForVerify(baseConfig, issue);
      expect(result).toBe(false);
    });

    it("should return false if issue has empty labels array", () => {
      const issue: Issue = {
        ...baseIssue,
        labels: [],
      };
      const result = isEligibleForVerify(baseConfig, issue);
      expect(result).toBe(false);
    });

    it("should be case-sensitive when matching trigger label", () => {
      const issue: Issue = {
        ...baseIssue,
        labels: ["Verify", "bug"],
      };
      const result = isEligibleForVerify(baseConfig, issue);
      expect(result).toBe(false);
    });

    it("should handle multiple labels correctly", () => {
      const issue: Issue = {
        ...baseIssue,
        labels: ["label1", "verify", "label2", "label3"],
      };
      const result = isEligibleForVerify(baseConfig, issue);
      expect(result).toBe(true);
    });

    it("should return true if trigger label is the only label", () => {
      const issue: Issue = {
        ...baseIssue,
        labels: ["verify"],
      };
      const result = isEligibleForVerify(baseConfig, issue);
      expect(result).toBe(true);
    });

    it("should work with different trigger labels in config", () => {
      const issue: Issue = {
        ...baseIssue,
        labels: ["ui-test", "bug"],
      };
      const customConfig: McpVerifyConfig = {
        ...baseConfig,
        triggerLabel: "ui-test",
      };
      const result = isEligibleForVerify(customConfig, issue);
      expect(result).toBe(true);
    });

    it("should return false if config triggerLabel does not match any issue label", () => {
      const issue: Issue = {
        ...baseIssue,
        labels: ["verify"],
      };
      const customConfig: McpVerifyConfig = {
        ...baseConfig,
        triggerLabel: "needs-verify",
      };
      const result = isEligibleForVerify(customConfig, issue);
      expect(result).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should handle issues with special characters in labels", () => {
      const issue: Issue = {
        ...baseIssue,
        labels: ["verify-ui", "test-123"],
      };
      const customConfig: McpVerifyConfig = {
        ...baseConfig,
        triggerLabel: "verify-ui",
      };
      const result = isEligibleForVerify(customConfig, issue);
      expect(result).toBe(true);
    });

    it("should not match partial label names", () => {
      const issue: Issue = {
        ...baseIssue,
        labels: ["verification"],
      };
      const result = isEligibleForVerify(baseConfig, issue);
      expect(result).toBe(false);
    });

    it("returns false when issue is undefined", () => {
      expect(isEligibleForVerify(baseConfig, undefined)).toBe(false);
    });

    it("returns false when config is undefined", () => {
      const issue = { labels: ["verify"] };
      expect(isEligibleForVerify(undefined, issue)).toBe(false);
    });
  });
});
