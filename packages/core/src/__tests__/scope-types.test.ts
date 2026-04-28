import { describe, it, expectTypeOf } from "vitest";
import type { ScopeConfig, ScopeViolation, ProjectConfig, Issue, SessionMetadata, EventType } from "../types.js";

describe("scope types", () => {
  it("ScopeConfig has expected shape", () => {
    const c: ScopeConfig = {
      defaultAllow: ["src/**"],
      alwaysDeny: ["**/.github/**"],
      onViolation: "ask-agent-to-revert",
      maxFiles: 50,
      maxLines: 2000,
    };
    expectTypeOf(c.onViolation).toEqualTypeOf<"block" | "warn" | "ask-agent-to-revert">();
  });

  it("ProjectConfig.scope is optional ScopeConfig", () => {
    expectTypeOf<ProjectConfig["scope"]>().toEqualTypeOf<ScopeConfig | undefined>();
  });

  it("Issue.scope is optional string array", () => {
    expectTypeOf<Issue["scope"]>().toEqualTypeOf<string[] | undefined>();
  });

  it("SessionMetadata has scopeGlobs and scopeCheckedSha", () => {
    expectTypeOf<SessionMetadata["scopeGlobs"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<SessionMetadata["scopeCheckedSha"]>().toEqualTypeOf<string | undefined>();
  });

  it("EventType includes pr.scope_violation", () => {
    // Verify "pr.scope_violation" is a valid EventType member (assignment is the type check)
    const _e: EventType = "pr.scope_violation";
    expectTypeOf<EventType>().toMatchTypeOf<string>();
  });

  it("ScopeViolation shape", () => {
    const v: ScopeViolation = {
      offending: ["src/a.ts"],
      allowed: ["src/sports/**"],
      reason: "out-of-scope-files",
    };
    expectTypeOf(v.reason).toEqualTypeOf<"out-of-scope-files" | "always-denied" | "too-many-files" | "too-many-lines">();
  });
});
