import { describe, it, expect } from "vitest";
import { runScopeCheck } from "../../src/commands/scope-check.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
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
  it("returns 0 when no .ao/scope file exists (no scope to enforce)", async () => {
    const { dir, base } = setupRepo();
    writeFileSync(join(dir, "src.ts"), "x\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "add"], { cwd: dir });

    const result = await runScopeCheck({ workspace: dir, baseBranch: base });
    expect(result.exitCode).toBe(0);
    expect(result.violation).toBeNull();
  });

  it("returns 0 when all changed files match scope", async () => {
    // Put .ao/scope on main so it is NOT part of the feature branch diff.
    const dir = mkdtempSync(join(tmpdir(), "ao-scope-check-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    writeFileSync(join(dir, "README.md"), "# x\n");
    mkdirSync(join(dir, ".ao"), { recursive: true });
    writeFileSync(join(dir, ".ao", "scope"), "src/**\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: dir });

    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "x.ts"), "x\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "add"], { cwd: dir });

    const result = await runScopeCheck({ workspace: dir, baseBranch: "main" });
    expect(result.exitCode).toBe(0);
  });

  it("returns 1 with violation when changed files are out of scope", async () => {
    const { dir, base } = setupRepo();
    mkdirSync(join(dir, ".ao"), { recursive: true });
    writeFileSync(join(dir, ".ao", "scope"), "src/**\n");
    writeFileSync(join(dir, "out-of-scope.ts"), "x\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "out"], { cwd: dir });

    const result = await runScopeCheck({ workspace: dir, baseBranch: base });
    expect(result.exitCode).toBe(1);
    expect(result.violation?.reason).toBe("out-of-scope-files");
    expect(result.violation?.offending).toContain("out-of-scope.ts");
  });

  it("returns 0 when scope file exists but is empty (no globs)", async () => {
    const { dir, base } = setupRepo();
    mkdirSync(join(dir, ".ao"), { recursive: true });
    writeFileSync(join(dir, ".ao", "scope"), ""); // empty
    writeFileSync(join(dir, "anything.ts"), "x\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "any"], { cwd: dir });

    const result = await runScopeCheck({ workspace: dir, baseBranch: base });
    expect(result.exitCode).toBe(0);
    expect(result.violation).toBeNull();
  });
});
