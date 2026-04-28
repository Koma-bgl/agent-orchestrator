import { describe, it, expect } from "vitest";
import { runScopeCheck } from "../../src/commands/scope-check.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

function setupRepo(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "ao-scope-check-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# x\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: dir });
  return { dir, base: "main" };
}

describe("ao scope-check", () => {
  it("returns 0 when no session matches cwd (no scope to enforce)", async () => {
    const { dir, base } = setupRepo();
    writeFileSync(join(dir, "src.ts"), "x\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "add"], { cwd: dir });

    const result = await runScopeCheck({
      workspace: dir,
      baseBranch: base,
      resolveScope: () => null,
    });
    expect(result.exitCode).toBe(0);
    expect(result.violation).toBeNull();
    expect(result.message).toMatch(/scope check skipped/i);
  });

  it("returns 0 when all changed files match scope", async () => {
    const { dir, base } = setupRepo();
    execFileSync("git", ["checkout", "-q", "main"], { cwd: dir });
    execFileSync("git", ["checkout", "-q", "feature"], { cwd: dir });

    execFileSync("mkdir", ["-p", join(dir, "src")]);
    writeFileSync(join(dir, "src", "x.ts"), "x\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "add"], { cwd: dir });

    const result = await runScopeCheck({
      workspace: dir,
      baseBranch: base,
      resolveScope: () => ["src/**"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.violation).toBeNull();
  });

  it("returns 1 with violation when changed files are out of scope", async () => {
    const { dir, base } = setupRepo();
    writeFileSync(join(dir, "out-of-scope.ts"), "x\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "out"], { cwd: dir });

    const result = await runScopeCheck({
      workspace: dir,
      baseBranch: base,
      resolveScope: () => ["src/**"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.violation?.reason).toBe("out-of-scope-files");
    expect(result.violation?.offending).toContain("out-of-scope.ts");
  });

  it("returns 0 when session exists but scope is empty (no globs)", async () => {
    const { dir, base } = setupRepo();
    writeFileSync(join(dir, "anything.ts"), "x\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "any"], { cwd: dir });

    const result = await runScopeCheck({
      workspace: dir,
      baseBranch: base,
      resolveScope: () => [],
    });
    expect(result.exitCode).toBe(0);
    expect(result.violation).toBeNull();
    expect(result.message).toMatch(/no scope set/i);
  });
});
