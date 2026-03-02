import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { buildPrompt, BASE_AGENT_PROMPT, AGENT_PERSONAS, loadPersona } from "../prompt-builder.js";
import type { ProjectConfig } from "../types.js";

let tmpDir: string;
let project: ProjectConfig;

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-prompt-test-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  project = {
    name: "Test App",
    repo: "org/test-app",
    path: tmpDir,
    defaultBranch: "main",
    sessionPrefix: "test",
  };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildPrompt", () => {
  it("returns null when no issue, no rules, no user prompt", () => {
    const result = buildPrompt({ project, projectId: "test-app" });
    expect(result).toBeNull();
  });

  it("includes base prompt when issue is provided", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(result).not.toBeNull();
    expect(result).toContain(BASE_AGENT_PROMPT);
  });

  it("includes project context", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(result).toContain("Test App");
    expect(result).toContain("org/test-app");
    expect(result).toContain("main");
  });

  it("includes issue ID in task section", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(result).toContain("Work on issue: INT-1343");
    expect(result).toContain("feat/INT-1343");
  });

  it("includes issue context when provided", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
      issueContext: "## Linear Issue INT-1343\nTitle: Layered Prompt System\nPriority: High",
    });
    expect(result).toContain("## Issue Details");
    expect(result).toContain("Layered Prompt System");
    expect(result).toContain("Priority: High");
  });

  it("includes inline agentRules", () => {
    project.agentRules = "Always run pnpm test before pushing.";
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(result).toContain("## Project Rules");
    expect(result).toContain("Always run pnpm test before pushing.");
  });

  it("reads agentRulesFile content", () => {
    const rulesPath = join(tmpDir, "agent-rules.md");
    writeFileSync(rulesPath, "Use conventional commits.\nNo force pushes.");
    project.agentRulesFile = "agent-rules.md";

    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(result).toContain("Use conventional commits.");
    expect(result).toContain("No force pushes.");
  });

  it("includes both agentRules and agentRulesFile", () => {
    project.agentRules = "Inline rule.";
    const rulesPath = join(tmpDir, "rules.txt");
    writeFileSync(rulesPath, "File rule.");
    project.agentRulesFile = "rules.txt";

    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(result).toContain("Inline rule.");
    expect(result).toContain("File rule.");
  });

  it("handles missing agentRulesFile gracefully", () => {
    project.agentRulesFile = "nonexistent-rules.md";

    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    // Should not throw, should still build prompt without rules
    expect(result).not.toBeNull();
    expect(result).not.toContain("## Project Rules");
  });

  it("appends userPrompt last", () => {
    project.agentRules = "Project rule.";
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
      userPrompt: "Focus on the API layer only.",
    });

    expect(result).not.toBeNull();
    const promptStr = result!;

    // User prompt should come after project rules
    const rulesIdx = promptStr.indexOf("Project rule.");
    const userIdx = promptStr.indexOf("Focus on the API layer only.");
    expect(rulesIdx).toBeLessThan(userIdx);
    expect(promptStr).toContain("## Additional Instructions");
  });

  it("builds prompt from rules alone (no issue)", () => {
    project.agentRules = "Always lint before committing.";
    const result = buildPrompt({
      project,
      projectId: "test-app",
    });
    expect(result).not.toBeNull();
    expect(result).toContain(BASE_AGENT_PROMPT);
    expect(result).toContain("Always lint before committing.");
  });

  it("builds prompt from userPrompt alone (no issue, no rules)", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      userPrompt: "Just explore the codebase.",
    });
    expect(result).not.toBeNull();
    expect(result).toContain("Just explore the codebase.");
  });

  it("includes tracker info in context", () => {
    project.tracker = { plugin: "linear" };
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-100",
    });
    expect(result).toContain("Tracker: linear");
  });

  it("uses project name in context", () => {
    const result = buildPrompt({
      project,
      projectId: "my-project",
      issueId: "INT-100",
    });
    expect(result).toContain("Project: Test App");
  });

  it("includes reaction hints for auto send-to-agent reactions", () => {
    project.reactions = {
      "ci-failed": { auto: true, action: "send-to-agent" },
      "approved-and-green": { auto: false, action: "notify" },
    };
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-100",
    });
    expect(result).toContain("ci-failed");
    expect(result).not.toContain("approved-and-green");
  });
});

describe("agentPersonas", () => {
  it("injects single persona from builtin fallback", () => {
    project.agentPersonas = ["security-auditor"];
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-100",
    });
    expect(result).toContain("Persona: Security Auditor");
    expect(result).toContain("vulnerabilities");
  });

  it("injects multiple personas", () => {
    project.agentPersonas = ["test-writer", "bug-fixer"];
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-100",
    });
    expect(result).toContain("Persona: Test Writer");
    expect(result).toContain("Persona: Bug Fixer");
  });

  it("builds prompt from personas alone (no issue, no rules)", () => {
    project.agentPersonas = ["refactorer"];
    const result = buildPrompt({
      project,
      projectId: "test-app",
    });
    expect(result).not.toBeNull();
    expect(result).toContain(BASE_AGENT_PROMPT);
    expect(result).toContain("Persona: Refactorer");
  });

  it("places personas between base prompt and config context", () => {
    project.agentPersonas = ["code-reviewer"];
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-100",
    });
    expect(result).not.toBeNull();
    const promptStr = result!;
    const baseIdx = promptStr.indexOf("Session Lifecycle");
    const personaIdx = promptStr.indexOf("Persona: Code Reviewer");
    const contextIdx = promptStr.indexOf("## Project Context");
    expect(baseIdx).toBeLessThan(personaIdx);
    expect(personaIdx).toBeLessThan(contextIdx);
  });

  it("combines personas with agentRules", () => {
    project.agentPersonas = ["test-writer"];
    project.agentRules = "Always use vitest.";
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-100",
    });
    expect(result).toContain("Persona: Test Writer");
    expect(result).toContain("Always use vitest.");
  });

  it("returns null with empty personas array and no other content", () => {
    project.agentPersonas = [];
    const result = buildPrompt({
      project,
      projectId: "test-app",
    });
    expect(result).toBeNull();
  });

  it("loads persona from personasDir when provided", () => {
    const personasDir = join(tmpDir, "my-personas");
    mkdirSync(personasDir, { recursive: true });
    writeFileSync(join(personasDir, "custom-agent.md"), "## Persona: Custom Agent\nDo custom things.");

    project.agentPersonas = ["custom-agent"];
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-100",
      personasDir,
    });
    expect(result).toContain("Persona: Custom Agent");
    expect(result).toContain("Do custom things.");
  });

  it("loads persona from default personas/ dir relative to configPath", () => {
    const configDir = join(tmpDir, "config-root");
    mkdirSync(join(configDir, "personas"), { recursive: true });
    writeFileSync(
      join(configDir, "personas", "my-persona.md"),
      "## Persona: My Persona\nSpecial instructions.",
    );

    project.agentPersonas = ["my-persona"];
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-100",
      configPath: join(configDir, "agent-orchestrator.yaml"),
    });
    expect(result).toContain("Persona: My Persona");
    expect(result).toContain("Special instructions.");
  });

  it("falls back to builtin when file not found", () => {
    project.agentPersonas = ["security-auditor"];
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-100",
      personasDir: join(tmpDir, "nonexistent-dir"),
    });
    // Should fall back to built-in
    expect(result).toContain("Persona: Security Auditor");
  });

  it("ignores unknown personas gracefully", () => {
    project.agentPersonas = ["nonexistent-persona"];
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-100",
    });
    // Should still build prompt (issue triggers it), just without persona
    expect(result).not.toBeNull();
    expect(result).not.toContain("Persona:");
  });

  it("personasDir takes priority over configPath default dir", () => {
    // Set up configPath default dir with one version
    const configDir = join(tmpDir, "config-root");
    mkdirSync(join(configDir, "personas"), { recursive: true });
    writeFileSync(join(configDir, "personas", "test-agent.md"), "## From configPath default");

    // Set up explicit personasDir with different version
    const personasDir = join(tmpDir, "explicit-personas");
    mkdirSync(personasDir, { recursive: true });
    writeFileSync(join(personasDir, "test-agent.md"), "## From explicit personasDir");

    project.agentPersonas = ["test-agent"];
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-100",
      personasDir,
      configPath: join(configDir, "agent-orchestrator.yaml"),
    });
    expect(result).toContain("From explicit personasDir");
    expect(result).not.toContain("From configPath default");
  });
});

describe("loadPersona", () => {
  it("loads from personasDir first", () => {
    const personasDir = join(tmpDir, "personas");
    mkdirSync(personasDir, { recursive: true });
    writeFileSync(join(personasDir, "custom.md"), "Custom content");

    const result = loadPersona("custom", personasDir);
    expect(result).toBe("Custom content");
  });

  it("loads from configPath default dir", () => {
    const configDir = join(tmpDir, "config");
    mkdirSync(join(configDir, "personas"), { recursive: true });
    writeFileSync(join(configDir, "personas", "my-agent.md"), "My agent content");

    const result = loadPersona("my-agent", undefined, join(configDir, "config.yaml"));
    expect(result).toBe("My agent content");
  });

  it("falls back to builtin", () => {
    const result = loadPersona("security-auditor");
    expect(result).toContain("Security Auditor");
  });

  it("returns null for unknown persona", () => {
    const result = loadPersona("totally-unknown");
    expect(result).toBeNull();
  });
});

describe("AGENT_PERSONAS", () => {
  it("has all 6 built-in personas defined", () => {
    const keys = Object.keys(AGENT_PERSONAS);
    expect(keys).toHaveLength(6);
    expect(keys).toContain("security-auditor");
    expect(keys).toContain("code-reviewer");
    expect(keys).toContain("test-writer");
    expect(keys).toContain("bug-fixer");
    expect(keys).toContain("refactorer");
    expect(keys).toContain("full-stack-dev");
  });

  it("all personas are non-empty strings", () => {
    for (const [key, value] of Object.entries(AGENT_PERSONAS)) {
      expect(typeof value).toBe("string");
      expect(value.length, `${key} should be non-empty`).toBeGreaterThan(50);
    }
  });
});

describe("BASE_AGENT_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof BASE_AGENT_PROMPT).toBe("string");
    expect(BASE_AGENT_PROMPT.length).toBeGreaterThan(100);
  });

  it("covers key topics", () => {
    expect(BASE_AGENT_PROMPT).toContain("Session Lifecycle");
    expect(BASE_AGENT_PROMPT).toContain("Git Workflow");
    expect(BASE_AGENT_PROMPT).toContain("PR Best Practices");
  });
});
