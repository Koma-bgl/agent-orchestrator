/**
 * `ao scope-check` — verify the current branch only changed files within the ticket's scope.
 *
 * Designed to be called by the agent INSIDE the worktree, BEFORE `gh pr create`.
 * Exits 0 if scope is satisfied or no scope is configured. Exits 1 with a clear
 * message listing offending files if violation is found.
 *
 * Usage:
 *   ao scope-check                 # auto-detect project from CWD, base from config
 *   ao scope-check --base develop  # explicit base branch
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { checkScope, loadConfig, type ScopeViolation } from "@composio/ao-core";

const execFileAsync = promisify(execFile);

export interface RunScopeCheckOpts {
  workspace: string;
  baseBranch?: string;
  projectId?: string;
}

export interface ScopeCheckResult {
  exitCode: 0 | 1;
  violation: ScopeViolation | null;
  message: string;
}

/** Testable core (no process.exit, no console output). */
export async function runScopeCheck(opts: RunScopeCheckOpts): Promise<ScopeCheckResult> {
  const scopeFilePath = join(opts.workspace, ".ao", "scope");
  if (!existsSync(scopeFilePath)) {
    return { exitCode: 0, violation: null, message: "No .ao/scope file — scope check skipped." };
  }

  const allowed = readFileSync(scopeFilePath, "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  if (allowed.length === 0) {
    return { exitCode: 0, violation: null, message: ".ao/scope file is empty — scope check skipped." };
  }

  // Resolve base branch: explicit > project config > "main"
  let baseBranch = opts.baseBranch;
  if (!baseBranch) {
    try {
      const config = loadConfig();
      const project = opts.projectId
        ? config.projects[opts.projectId]
        : Object.values(config.projects).find((p) => p.path === opts.workspace);
      baseBranch = project?.defaultBranch ?? "main";
    } catch {
      baseBranch = "main";
    }
  }

  // Compute changed files vs the merge-base with base branch.
  const { stdout: mergeBase } = await execFileAsync(
    "git",
    ["merge-base", "HEAD", baseBranch],
    { cwd: opts.workspace, timeout: 30_000 },
  );
  const { stdout: filesOut } = await execFileAsync(
    "git",
    ["diff", "--name-only", `${mergeBase.trim()}..HEAD`],
    { cwd: opts.workspace, timeout: 30_000 },
  );
  const changedFiles = filesOut.split("\n").map((s) => s.trim()).filter(Boolean);

  const violation = checkScope({ changedFiles, allowed });
  if (!violation) {
    return {
      exitCode: 0,
      violation: null,
      message: `Scope OK — ${changedFiles.length} changed file(s) all within ${allowed.length} allowed glob(s).`,
    };
  }

  const offendingList = violation.offending.slice(0, 20).join("\n  ");
  const more = violation.offending.length > 20 ? `\n  … (+${violation.offending.length - 20} more)` : "";
  const msg = [
    `Scope violation (${violation.reason}).`,
    ``,
    `Allowed globs:`,
    ...allowed.map((g) => `  ${g}`),
    ``,
    `Out-of-scope files:`,
    `  ${offendingList}${more}`,
    ``,
    `Revert these changes before opening a PR. If they are genuinely required to`,
    `satisfy the ticket, post a PR comment explaining why and ask the human to`,
    `expand the scope.`,
  ].join("\n");

  return { exitCode: 1, violation, message: msg };
}

export function registerScopeCheck(program: Command): void {
  program
    .command("scope-check")
    .description(
      "Verify the current branch only modifies files within the ticket's scope (run before `gh pr create`)",
    )
    .option("-p, --project <id>", "Project ID (auto-detected from CWD if omitted)")
    .option("--base <branch>", "Base branch to diff against (default: project.defaultBranch or 'main')")
    .action(async (opts: { project?: string; base?: string }) => {
      const result = await runScopeCheck({
        workspace: process.cwd(),
        baseBranch: opts.base,
        projectId: opts.project,
      });
      if (result.exitCode === 0) {
        console.log(chalk.green(result.message));
      } else {
        console.error(chalk.red(result.message));
      }
      process.exit(result.exitCode);
    });
}
