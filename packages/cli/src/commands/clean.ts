import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import {
  loadConfig,
  getProjectBaseDir,
  getSessionsDir,
  getWorktreesDir,
  getArchiveDir,
} from "@composio/ao-core";
import { getSessionManager } from "../lib/create-session-manager.js";

export function registerClean(program: Command): void {
  program
    .command("clean [project]")
    .description("Remove all sessions, worktrees, and metadata for a fresh start")
    .option("--dry-run", "Show what would be removed without doing it")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (projectArg?: string, opts?: { dryRun?: boolean; yes?: boolean }) => {
      try {
        const config = loadConfig();
        const projectIds = projectArg ? [projectArg] : Object.keys(config.projects);

        if (projectArg && !config.projects[projectArg]) {
          console.error(chalk.red(`Unknown project: ${projectArg}`));
          process.exit(1);
        }

        // Gather what will be cleaned
        const sm = await getSessionManager(config);
        const sessions = await sm.list(projectArg);

        console.log(chalk.bold("\nAgent Orchestrator — Clean\n"));

        if (sessions.length === 0) {
          console.log(chalk.dim("  No active sessions found."));
        } else {
          console.log(`  ${chalk.yellow(String(sessions.length))} active session(s) will be killed:`);
          for (const s of sessions) {
            console.log(chalk.dim(`    - ${s.id} [${s.status}]`));
          }
        }

        // Show directories that will be removed
        const dirsToClean: string[] = [];
        for (const projectId of projectIds) {
          const project = config.projects[projectId];
          if (!project) continue;
          const baseDir = getProjectBaseDir(config.configPath, project.path);
          if (existsSync(baseDir)) {
            dirsToClean.push(baseDir);
          }
        }

        if (dirsToClean.length > 0) {
          console.log(`\n  Directories to remove:`);
          for (const dir of dirsToClean) {
            console.log(chalk.dim(`    - ${dir}`));
          }
        }

        if (sessions.length === 0 && dirsToClean.length === 0) {
          console.log(chalk.dim("\n  Nothing to clean.\n"));
          return;
        }

        if (opts?.dryRun) {
          console.log(chalk.dim("\n  Dry run — no changes made.\n"));
          return;
        }

        // Confirmation prompt (unless --yes)
        if (!opts?.yes) {
          const readline = await import("node:readline");
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise<string>((resolve) => {
            rl.question(chalk.yellow("\n  This will destroy all sessions and data. Continue? [y/N] "), resolve);
          });
          rl.close();
          if (answer.toLowerCase() !== "y") {
            console.log(chalk.dim("  Aborted.\n"));
            return;
          }
        }

        // 1. Kill all active sessions (runtime + worktree cleanup via session manager)
        const spinner = ora();
        if (sessions.length > 0) {
          spinner.start("Killing active sessions");
          let killed = 0;
          const errors: string[] = [];
          for (const s of sessions) {
            try {
              await sm.kill(s.id);
              killed++;
            } catch (err) {
              errors.push(`${s.id}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          if (errors.length > 0) {
            spinner.warn(`Killed ${killed}/${sessions.length} sessions (${errors.length} errors)`);
            for (const e of errors) {
              console.error(chalk.red(`    ${e}`));
            }
          } else {
            spinner.succeed(`Killed ${killed} session(s)`);
          }
        }

        // 2. Remove remaining data directories (archived metadata, leftover worktrees, etc.)
        if (dirsToClean.length > 0) {
          spinner.start("Removing data directories");
          for (const dir of dirsToClean) {
            try {
              rmSync(dir, { recursive: true, force: true });
            } catch (err) {
              console.error(chalk.red(`  Failed to remove ${dir}: ${err}`));
            }
          }
          spinner.succeed("Removed data directories");
        }

        // 3. Prune stale git worktrees in each project repo
        spinner.start("Pruning stale git worktrees");
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        for (const projectId of projectIds) {
          const project = config.projects[projectId];
          if (!project?.path || !existsSync(project.path)) continue;
          try {
            await execFileAsync("git", ["worktree", "prune"], {
              cwd: project.path,
              timeout: 30_000,
            });
          } catch {
            // Best effort — repo might not use worktrees
          }
        }
        spinner.succeed("Pruned stale git worktrees");

        console.log(chalk.bold.green("\n✓ Clean complete — ready for a fresh start.\n"));
      } catch (err) {
        if (err instanceof Error) {
          console.error(chalk.red("\nError:"), err.message);
        } else {
          console.error(chalk.red("\nError:"), String(err));
        }
        process.exit(1);
      }
    });
}
