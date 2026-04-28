import { describe, it, expect, vi } from "vitest";
import { runScopeSet } from "../../src/commands/scope-set.js";
import type { FoundSession } from "@composio/ao-core";

function makeSession(workspacePath: string): FoundSession {
  return {
    sessionId: "test-1",
    sessionsDir: "/tmp/sessions",
    projectId: "test-project",
    workspacePath,
  };
}

describe("runScopeSet", () => {
  it("writes the comma-joined globs to session metadata.scopeGlobs", async () => {
    const writeScope = vi.fn();
    const session = makeSession("/tmp/fake-workspace");
    const result = await runScopeSet({
      cwd: "/tmp/fake-workspace",
      globs: ["src/sports/**", "!src/sports/apis/**"],
      resolveSession: () => session,
      writeScope,
    });
    expect(result.exitCode).toBe(0);
    expect(writeScope).toHaveBeenCalledWith(session, "src/sports/**,!src/sports/apis/**");
  });

  it("trims whitespace and de-duplicates globs", async () => {
    const writeScope = vi.fn();
    const session = makeSession("/tmp/fake-workspace");
    const result = await runScopeSet({
      cwd: "/tmp/fake-workspace",
      globs: [" src/foo/** ", "src/foo/**", "src/bar/**"],
      resolveSession: () => session,
      writeScope,
    });
    expect(result.exitCode).toBe(0);
    expect(writeScope).toHaveBeenCalledWith(session, "src/foo/**,src/bar/**");
  });

  it("exits 1 with a clear message when cwd does not match any session", async () => {
    const writeScope = vi.fn();
    const result = await runScopeSet({
      cwd: "/tmp/not-a-session",
      globs: ["src/sports/**"],
      resolveSession: () => null,
      writeScope,
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/no.*session/i);
    expect(writeScope).not.toHaveBeenCalled();
  });

  it("exits 1 when globs is empty", async () => {
    const writeScope = vi.fn();
    const result = await runScopeSet({
      cwd: "/tmp/fake-workspace",
      globs: [],
      resolveSession: () => makeSession("/tmp/fake-workspace"),
      writeScope,
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/at least one glob/i);
    expect(writeScope).not.toHaveBeenCalled();
  });

  it("exits 1 when globs is non-empty but only whitespace", async () => {
    const writeScope = vi.fn();
    const result = await runScopeSet({
      cwd: "/tmp/fake-workspace",
      globs: ["  ", ""],
      resolveSession: () => makeSession("/tmp/fake-workspace"),
      writeScope,
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/at least one glob/i);
    expect(writeScope).not.toHaveBeenCalled();
  });

  it("includes a hint to run ao scope-check next on success", async () => {
    const writeScope = vi.fn();
    const session = makeSession("/tmp/fake-workspace");
    const result = await runScopeSet({
      cwd: "/tmp/fake-workspace",
      globs: ["src/foo/**"],
      resolveSession: () => session,
      writeScope,
    });
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/ao scope-check/);
  });
});
