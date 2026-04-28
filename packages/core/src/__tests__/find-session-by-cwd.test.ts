import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { findSessionByCwd } from "../session-manager.js";
import { writeMetadata } from "../metadata.js";
import { getSessionsDir } from "../paths.js";
import type { OrchestratorConfig } from "../types.js";

let tmpDir: string;
let configPath: string;
let config: OrchestratorConfig;

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-find-session-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n");

  const projectAPath = join(tmpDir, "project-a");
  const projectBPath = join(tmpDir, "project-b");
  mkdirSync(projectAPath, { recursive: true });
  mkdirSync(projectBPath, { recursive: true });

  config = {
    configPath,
    port: 3000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    },
    projects: {
      "project-a": {
        name: "Project A",
        repo: "org/project-a",
        path: projectAPath,
        defaultBranch: "main",
        sessionPrefix: "a",
      },
      "project-b": {
        name: "Project B",
        repo: "org/project-b",
        path: projectBPath,
        defaultBranch: "main",
        sessionPrefix: "b",
      },
    },
    notifiers: {},
    notificationRouting: {
      urgent: ["desktop"],
      action: ["desktop"],
      warning: [],
      info: [],
    },
    reactions: {},
    readyThresholdMs: 300_000,
  };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("findSessionByCwd", () => {
  it("finds a session whose worktree matches cwd", () => {
    const sessionsDir = getSessionsDir(configPath, config.projects["project-a"].path);
    const wsPath = join(tmpDir, "worktrees", "a-1");
    writeMetadata(sessionsDir, "a-1", {
      worktree: wsPath,
      branch: "feat/A-1",
      status: "working",
      project: "project-a",
    });

    const result = findSessionByCwd(config, wsPath);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("a-1");
    expect(result!.projectId).toBe("project-a");
    expect(result!.workspacePath).toBe(wsPath);
  });

  it("returns null when cwd does not match any session worktree", () => {
    const sessionsDir = getSessionsDir(configPath, config.projects["project-a"].path);
    writeMetadata(sessionsDir, "a-1", {
      worktree: join(tmpDir, "worktrees", "a-1"),
      branch: "feat/A-1",
      status: "working",
      project: "project-a",
    });

    const result = findSessionByCwd(config, join(tmpDir, "not-a-worktree"));
    expect(result).toBeNull();
  });

  it("searches across multiple projects", () => {
    const sessionsDirA = getSessionsDir(configPath, config.projects["project-a"].path);
    const sessionsDirB = getSessionsDir(configPath, config.projects["project-b"].path);
    const wsA = join(tmpDir, "worktrees", "a-1");
    const wsB = join(tmpDir, "worktrees", "b-7");

    writeMetadata(sessionsDirA, "a-1", {
      worktree: wsA,
      branch: "feat/A-1",
      status: "working",
      project: "project-a",
    });
    writeMetadata(sessionsDirB, "b-7", {
      worktree: wsB,
      branch: "feat/B-7",
      status: "working",
      project: "project-b",
    });

    const result = findSessionByCwd(config, wsB);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("b-7");
    expect(result!.projectId).toBe("project-b");
  });

  it("returns scopeGlobs when present in metadata", () => {
    const sessionsDir = getSessionsDir(configPath, config.projects["project-a"].path);
    const wsPath = join(tmpDir, "worktrees", "a-2");
    writeMetadata(sessionsDir, "a-2", {
      worktree: wsPath,
      branch: "feat/A-2",
      status: "working",
      project: "project-a",
      scopeGlobs: "src/foo/**,!src/foo/secret/**",
    });

    const result = findSessionByCwd(config, wsPath);
    expect(result?.scopeGlobs).toBe("src/foo/**,!src/foo/secret/**");
  });

  it("returns no scopeGlobs when not present in metadata", () => {
    const sessionsDir = getSessionsDir(configPath, config.projects["project-a"].path);
    const wsPath = join(tmpDir, "worktrees", "a-3");
    writeMetadata(sessionsDir, "a-3", {
      worktree: wsPath,
      branch: "feat/A-3",
      status: "working",
      project: "project-a",
    });

    const result = findSessionByCwd(config, wsPath);
    expect(result?.scopeGlobs).toBeUndefined();
  });

  it("returns null when no projects have sessions directories", () => {
    const result = findSessionByCwd(config, "/tmp/nowhere");
    expect(result).toBeNull();
  });
});
